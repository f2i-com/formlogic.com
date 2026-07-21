//! The desktop side of the flow-run E2E relay lane (Phase 5 of
//! docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7) — the second, INDEPENDENT
//! single-flight lane from plan §5.2 (`ai` vs `flow`: a long flow run never
//! blocks chat). Structure mirrors `ai/relay_poller.rs`:
//!
//! ```text
//! GET /api/v1/desktop-flows/pending?instanceId=…&wait=25000   (idle → long-poll)
//!   → POST …/{id}/claim            (atomic single-flight; 409 = not ours)
//!   → open the sealed request envelope (ai/e2e.rs — the SAME desktop identity
//!     the AI lane publishes; this lane never publishes, one publisher only)
//!   → run the flow through the EXISTING flows/runner.rs (the dispatcher owns
//!     resolution + deps via the FlowExecutor seam)
//!   → seal node-boundary progress frames  (POST …/{id}/frames;
//!     {v:1,type:'flow_progress',nodeId?,status?,message?}, capped at
//!     MAX_PROGRESS_FRAMES per run)
//!   → POST …/{id}/complete         ({status:'done'|'failed', result?}) — the
//!     terminal SEALED result envelope rides the complete call's `result`
//!     field (≤ 1 MiB plaintext; the server keeps it until read once),
//!     UNLIKE the AI lane where completion purges frames and terminal content
//!     must ride the last frame
//! ```
//!
//! Terminal body (sealed): `{v:1, type:'flow_result', status:'done', result}`
//! or `{v:1, type:'flow_result', status:'failed', error:{code,message}}`. The
//! error code is a §5.8 / flow-run-result typed code (`node_failed`,
//! `invalid_flow`, `timeout`, `sealed_envelope_invalid`, …). A run whose
//! serialized result exceeds the 1 MiB relay cap completes `failed` with the
//! typed `result_too_large` code — a truncated JSON body is never delivered.
//!
//! Single-flight holds by construction on both sides: the server claim is
//! atomic per lane, and this loop processes strictly one request at a time.
//! No `codex_busy` backoff here (unlike the AI lane): the flow runner handles
//! its own LLM retry lanes internally.

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

use crate::ai::e2e::{E2eIdentity, E2eSessions, MAX_FLOW_RESULT_PLAINTEXT_BYTES};
use crate::ai::relay_poller::{PollCycleOutcome, TunnelError};
use crate::flows::runner::{self, FlowOutcome, NodeProgress, NodeProgressSink};
use crate::formlogic_client::{FlError, FormLogicClient};

/// The request long-poll blocks up to 25 s server-side (same as the AI lane).
const POLL_WAIT_MS: u32 = 25_000;
/// Re-poll floor after an idle long-poll (guards a server that ignores `wait`).
const IDLE_REPOLL: Duration = Duration::from_secs(1);
/// Backoffs mirror the AI lane: transient 5 s, auth/lane-missing 60 s.
const TRANSIENT_BACKOFF: Duration = Duration::from_secs(5);
const HARD_BACKOFF: Duration = Duration::from_secs(60);
/// Plan §5.7/scope: sealed progress frames are bounded per run (the runner's
/// own node budget is far smaller; this is the runaway guard).
const MAX_PROGRESS_FRAMES: u32 = 200;

/// One claimed relay run handed to the executor (the dispatcher's flow
/// resolution + standard run pipeline).
pub struct FlowRunJob {
    /// The flow to run — the request row's routing `flowId` (the sealed body's
    /// `flowId` is only a fallback when the row lacks one).
    pub flow_id: String,
    /// The sealed run inputs (the `{inputs}` scope the flow sees).
    pub inputs: Value,
    /// Run wall-clock bound (the runner's standard default).
    pub timeout_ms: u64,
    /// Stable per-run seed for connector request ids — the relay request id,
    /// so a re-driven run replays connector effects safely.
    pub seed: String,
    /// The lane's authenticated client (snapshot refresh + run deps).
    pub client: Arc<FormLogicClient>,
    /// Node-boundary observer wired to the lane's progress-frame channel.
    pub progress: Option<NodeProgressSink>,
}

/// The executor seam: the dispatcher resolves the flow and drives
/// `flows/runner.rs`; the lane stays transport-only (mirrors how the AI lane
/// delegates to the gateway).
pub type FlowExecutor = Arc<
    dyn Fn(FlowRunJob) -> Pin<Box<dyn std::future::Future<Output = FlowOutcome> + Send>>
        + Send
        + Sync,
>;

/// The flow lane's shared state: identity + per-request sessions + the
/// executor. Deliberately NO pubkey-publish machinery — the AI lane owns the
/// single publisher for the one desktop identity both lanes share.
pub struct FlowRelay {
    identity: E2eIdentity,
    sessions: E2eSessions,
    executor: FlowExecutor,
}

impl FlowRelay {
    /// Load the SAME desktop E2E identity the AI tunnel uses (one pinned key
    /// per install — a second key would read as a rotation to browsers) and
    /// assemble the lane. `data_dir` backs the identity key-file fallback.
    pub fn new(executor: FlowExecutor, data_dir: PathBuf) -> Result<Arc<Self>, String> {
        let identity = E2eIdentity::load_or_create(&data_dir)?;
        Ok(Arc::new(Self {
            identity,
            sessions: E2eSessions::new(),
            executor,
        }))
    }

    /// One long-poll cycle: pending → claim → process, strictly sequentially
    /// (single-flight per the flow lane). Mirrors `AiTunnel::poll_cycle`
    /// except the pubkey publish (owned by the AI lane).
    pub async fn poll_cycle(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
    ) -> PollCycleOutcome {
        match client
            .poll_pending_flow_runs(instance_id, POLL_WAIT_MS)
            .await
        {
            Ok(requests) => {
                if requests.is_empty() {
                    return PollCycleOutcome {
                        backoff: IDLE_REPOLL,
                        error: None,
                    };
                }
                for request in &requests {
                    let Some(id) = request_id(request) else {
                        eprintln!("[flow-relay] pending row without an id — skipped");
                        continue;
                    };
                    match client.claim_flow_run(&id, instance_id).await {
                        Ok(true) => {
                            self.process_claimed(client, instance_id, &id, request)
                                .await
                        }
                        Ok(false) => {} // another runtime won / expired — not ours
                        Err(e) => {
                            return PollCycleOutcome {
                                backoff: TRANSIENT_BACKOFF,
                                error: Some(format!("flow run {id} claim: {e}")),
                            };
                        }
                    }
                }
                PollCycleOutcome {
                    backoff: Duration::ZERO,
                    error: None,
                }
            }
            Err(FlError::Unauthorized(e)) => PollCycleOutcome {
                backoff: HARD_BACKOFF,
                error: Some(format!("flow relay poll: {e}")),
            },
            Err(FlError::Http { status: 404, .. }) => {
                // Backend predates the lane; don't spam, don't hammer.
                PollCycleOutcome {
                    backoff: HARD_BACKOFF,
                    error: None,
                }
            }
            Err(e) => PollCycleOutcome {
                backoff: TRANSIENT_BACKOFF,
                error: Some(format!("flow relay poll: {e}")),
            },
        }
    }

    /// Full pipeline for ONE claimed request. The terminal result envelope
    /// rides the complete call's `result` field (kept server-side until read
    /// once) — see the module header for the shape. Always reports a terminal
    /// status and always drops the request's E2E session afterwards. Never
    /// panics.
    async fn process_claimed(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        request: &Value,
    ) {
        let (status, body) = match self.run_request(client, instance_id, id, request).await {
            Ok(result) => (
                "done",
                json!({ "v": 1, "type": "flow_result", "status": "done", "result": result }),
            ),
            Err(e) => (
                "failed",
                json!({
                    "v": 1,
                    "type": "flow_result",
                    "status": "failed",
                    "error": { "code": e.code(), "message": e.message() },
                }),
            ),
        };
        let (status, body) = self.apply_result_cap(status, body);
        let envelope = self.seal_terminal(id, request, body.to_string().as_bytes());
        let mut payload = json!({ "status": status });
        if let Some(envelope) = envelope {
            payload["result"] = json!(envelope);
        }
        if let Err(e) = client.complete_flow_run(id, &payload, instance_id).await {
            eprintln!("[flow-relay] request {id} complete failed: {e}");
        }
        self.sessions.drop_thread(id);
    }

    /// The 1 MiB terminal-result cap (plan §5.2): an oversized successful
    /// result degrades to the typed `result_too_large` failure — a truncated
    /// JSON body is never delivered.
    fn apply_result_cap(&self, status: &'static str, body: Value) -> (&'static str, Value) {
        if status == "done" && body.to_string().len() > MAX_FLOW_RESULT_PLAINTEXT_BYTES {
            return (
                "failed",
                json!({
                    "v": 1,
                    "type": "flow_result",
                    "status": "failed",
                    "error": {
                        "code": "result_too_large",
                        "message": format!(
                            "flow result exceeded the {MAX_FLOW_RESULT_PLAINTEXT_BYTES}-byte relay result cap"
                        ),
                    },
                }),
            );
        }
        (status, body)
    }

    /// Seal the terminal body for the requester. When the request envelope
    /// never opened (no session), seal DETACHED to the row's ephemeral key at
    /// outbound counter 0 — the browser can still read WHY it failed (the AI
    /// lane's `seal_error_frame` pattern).
    fn seal_terminal(&self, id: &str, request: &Value, plaintext: &[u8]) -> Option<String> {
        if let Ok(envelope) =
            self.sessions
                .seal_outbound_with_cap(id, plaintext, MAX_FLOW_RESULT_PLAINTEXT_BYTES)
        {
            return Some(envelope);
        }
        let eph_pub = str_field(request, &["ephPub", "eph_pub"])?;
        let eph: [u8; 32] = B64.decode(eph_pub).ok()?.try_into().ok()?;
        crate::ai::e2e::seal_detached_envelope(
            &self.identity.secret_key_bytes(),
            &eph,
            crate::ai::e2e::DIR_DESKTOP_TO_BROWSER,
            0,
            plaintext,
        )
        .ok()
    }

    /// open → execute, streaming sealed progress frames at node boundaries.
    /// Returns the flow's result value on success or the typed failure.
    async fn run_request(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        request: &Value,
    ) -> Result<Value, TunnelError> {
        let row_flow_id = str_field(request, &["flowId", "flow_id"]).map(str::to_string);
        let eph_pub = str_field(request, &["ephPub", "eph_pub"]).ok_or_else(|| {
            TunnelError::new("invalid_request", "request row has no ephemeral key")
        })?;
        // The wire envelope is ONE string: base64(nonce(24) || ciphertext).
        let envelope = str_field(request, &["envelope"])
            .ok_or_else(|| TunnelError::new("invalid_request", "request row has no envelope"))?;

        let plaintext = self
            .sessions
            .open_inbound(&self.identity, id, eph_pub, envelope)
            .map_err(|e| TunnelError::new(e.code(), e.message()))?;
        let body: Value = serde_json::from_slice(&plaintext)
            .map_err(|_| TunnelError::new("sealed_envelope_invalid", "sealed body is not JSON"))?;
        if body.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(TunnelError::new(
                "sealed_envelope_invalid",
                "sealed body has no v:1 marker",
            ));
        }
        // The routing row's flowId wins; the sealed body's is only a fallback.
        let flow_id = row_flow_id
            .or_else(|| {
                body.get("flowId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|s| !s.is_empty())
            .ok_or_else(|| TunnelError::new("invalid_request", "flow run request has no flowId"))?;
        let inputs = body.get("inputs").cloned().unwrap_or_else(|| json!({}));

        // Progress channel: the runner's node-boundary observer feeds it; the
        // forwarding half seals + posts each event as a flow_progress frame.
        // `tokio::join!` drops the executor future the moment it completes
        // (MaybeDone), so the sender closes and the forwarder drains out.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<NodeProgress>();
        let progress: NodeProgressSink = Arc::new(move |event: NodeProgress| {
            let _ = tx.send(event);
        });
        let job = FlowRunJob {
            flow_id,
            inputs,
            timeout_ms: runner::DEFAULT_TIMEOUT_MS,
            seed: id.to_string(),
            client: Arc::new(client.clone()),
            progress: Some(progress),
        };
        let run = (self.executor)(job);
        let forward = async {
            let mut frames: u32 = 0;
            while let Some(event) = rx.recv().await {
                frames += 1;
                if frames > MAX_PROGRESS_FRAMES {
                    if frames == MAX_PROGRESS_FRAMES + 1 {
                        eprintln!(
                            "[flow-relay] request {id} progress frame cap reached — further frames dropped"
                        );
                    }
                    continue;
                }
                let mut frame = json!({
                    "v": 1,
                    "type": "flow_progress",
                    "nodeId": event.node_id,
                    "status": event.status,
                });
                if let Some(message) = event.message {
                    frame["message"] = json!(message);
                }
                let envelope = match self
                    .sessions
                    .seal_outbound(id, frame.to_string().as_bytes())
                {
                    Ok(envelope) => envelope,
                    Err(e) => {
                        eprintln!("[flow-relay] request {id} progress seal failed: {e}");
                        continue;
                    }
                };
                if let Err(e) = client.append_flow_frame(id, instance_id, &envelope).await {
                    // Logged and the run continues — the browser detects gaps
                    // from the server-assigned seq numbers (AI-lane behavior).
                    eprintln!("[flow-relay] request {id} progress frame post failed: {e}");
                }
            }
        };
        let (outcome, ()) = tokio::join!(run, forward);
        if outcome.status == "done" {
            Ok(outcome.result.unwrap_or(Value::Null))
        } else {
            let error = outcome.error.ok_or_else(|| {
                TunnelError::new("node_failed", "flow run failed without a typed error")
            })?;
            Err(TunnelError::new(error.code.as_str(), error.message))
        }
    }
}

/// The request row's id, tolerant of the casings the API uses elsewhere
/// (mirrors the AI lane's helper).
fn request_id(request: &Value) -> Option<String> {
    str_field(request, &["id", "requestId", "request_id"]).map(str::to_string)
}

/// First non-empty string among `keys` (camelCase/snake_case tolerance).
fn str_field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests;
