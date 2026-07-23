//! The desktop side of the Site-AI E2E tunnel (Phase 1 of
//! docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.1/§5.2/§7).
//!
//! One long-poll lane, started beside the connector-command relay in
//! `flows/dispatcher.rs`:
//!
//! ```text
//! GET /api/v1/desktop-ai/pending?instanceId=…&wait=25000   (idle → long-poll)
//!   → POST …/{id}/claim            (atomic single-flight; 409 = not ours)
//!   → open the sealed request envelope (ai/e2e.rs)
//!   → validate provider_id + model FAIL-CLOSED against the provider registry
//!   → dispatch the chat completion IN-PROCESS through ai/gateway.rs — the
//!     same code path /api/ai/providers/:id/v1/chat/completions uses, with
//!     credentials attached desktop-side exactly as today
//!   → seal token deltas as frames  (POST …/{id}/frames; the server assigns
//!     the monotonic seq) — the SEALED FINAL BODY rides the last frame too,
//!     because completion purges frames server-side
//!   → POST …/{id}/complete         ({status:'done'|'failed'}; terminal
//!     content already delivered as the final sealed frame)
//! ```
//!
//! Single-flight holds by construction on both sides: the server claim is
//! atomic per lane, and this loop processes strictly one request at a time.
//! `429 codex_busy` from the managed Codex lane gets the same bounded backoff
//! as the flow runner's llm_chat (runner.rs): only the typed code enters the
//! lane, [250,500,750,1000,1250,1500] ms, 7 attempts max.
//!
//! Phase 6 (plan §5.4): a sealed chat body carrying a non-empty `toolGrant`
//! dispatches to the tool loop in `ai/chat_agent.rs` for every provider kind
//! (OpenAI-dialect providers get native function calling; the managed Codex
//! lane and translated protocols get the prompt-level harness). A request
//! WITHOUT a grant — or one whose tool catalog is empty/unfetchable — takes
//! this module's original path unchanged (the compatibility invariant).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

use crate::ai::codex::{CodexAgentHandle, CodexChatRequest};
use crate::ai::e2e::{E2eIdentity, E2eSessions};
use crate::ai::gateway;
use crate::ai::providers::{Capability, ProviderProfile, ProviderRegistryHandle};
use crate::formlogic_client::{FlError, FormLogicClient};

/// Plan §5.5: the provider model catalog is cached for 5 minutes.
const MODELS_CACHE_TTL: Duration = Duration::from_secs(300);
/// The request long-poll blocks up to 25 s server-side (same as the command relay).
const POLL_WAIT_MS: u32 = 25_000;
/// Re-poll floor after an idle long-poll (guards a server that ignores `wait`).
const IDLE_REPOLL: Duration = Duration::from_secs(1);
/// Backoffs mirror the connector relay: transient 5 s, auth/lane-missing 60 s.
const TRANSIENT_BACKOFF: Duration = Duration::from_secs(5);
const HARD_BACKOFF: Duration = Duration::from_secs(60);
/// Bound a single request's frame count (a runaway stream cannot fill the lane forever).
const MAX_STREAM_FRAMES: u64 = 4_096;

/// The flow runner's typed-`codex_busy` lane (runner.rs): only the exact typed
/// code retries, on this fixed bounded schedule.
const CODEX_BUSY_MAX_ATTEMPTS: usize = 7;
const CODEX_BUSY_BACKOFF_MS: [u64; CODEX_BUSY_MAX_ATTEMPTS - 1] =
    [250, 500, 750, 1_000, 1_250, 1_500];

/// Typed failure surfaced to the requester as the complete-call error code.
/// Codes are the plan's §5.8 taxonomy (`sealed_envelope_invalid`,
/// `provider_unavailable`, `model_unavailable`, …) plus the generic
/// `invalid_request` / `upstream_error` for shapes the plan leaves open.
#[derive(Debug, Clone)]
pub struct TunnelError {
    code: &'static str,
    message: String,
}

impl TunnelError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// What one poll cycle did, so the owning loop can note errors + sleep.
pub struct PollCycleOutcome {
    pub backoff: Duration,
    pub error: Option<String>,
}

/// Which backend a tunneled request resolves to. Registry providers go through
/// `ai/gateway.rs`; the managed Codex account goes through `ai/codex.rs`
/// (its single-flight turn gate is where typed `codex_busy` comes from).
/// `pub(super)` so the Phase-6 tool loop (`ai/chat_agent.rs`) picks its tool
/// transport (native function calling vs the prompt harness) per kind.
/// A chat-capable LOCAL SERVICE (`service:<id>`) resolves to `Registry` too —
/// a synthetic OpenAI-protocol loopback profile, so streaming, model
/// validation and the Native tool transport all apply unchanged.
#[derive(Debug)]
pub(super) enum ResolvedProvider {
    Registry(ProviderProfile),
    CodexAsync,
}

/// The local-services surface the tunnel consumes for `service:<id>` provider
/// ids — a seam: production wraps the services registry (`RegistryServices`);
/// tests inject a fake. Sync by design: the registry snapshot is
/// revision-cached and sub-millisecond (SRV-001), so no lock is ever held
/// across an await.
pub trait TunnelServiceDirectory: Send + Sync {
    /// `(service id, display name)` of every CHAT-capable service, regardless
    /// of run state — a stopped one is still offered in the catalog and fails
    /// typed (and actionable) at USE time instead, never auto-started.
    fn chat_services(&self) -> Vec<(String, String)>;
    /// Resolve one service id for the chat lane (fail closed).
    fn resolve_chat_service(&self, id: &str) -> Result<ResolvedService, ServiceResolveDenied>;
}

/// A chat-capable service that is RUNNING right now.
pub struct ResolvedService {
    pub name: String,
    pub port: u16,
}

/// Why a `service:<id>` provider id cannot serve the chat lane.
pub enum ServiceResolveDenied {
    /// No such service — the existing unknown-provider refusal applies.
    Unknown,
    /// The service exists but does not serve chat (fail closed).
    NotChatCapable { name: String },
    /// The service serves chat but is not running. NEVER auto-started from
    /// this lane — the user starts it from the Desktop Connection panel.
    NotRunning { name: String },
}

/// Production [`TunnelServiceDirectory`]: the services registry, using the
/// SAME capability mapping the `/api/ai/sources` union uses
/// (`http::service_source_capabilities`) — one decision, never a second one.
pub struct RegistryServices(pub crate::services::registry::RegistryHandle);

impl TunnelServiceDirectory for RegistryServices {
    fn chat_services(&self) -> Vec<(String, String)> {
        let Ok(reg) = self.0.lock() else {
            return Vec::new();
        };
        reg.snapshot()
            .services
            .iter()
            .filter(|s| {
                crate::http::service_source_capabilities(&s.capabilities, &s.category)
                    .contains(&"chat")
            })
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect()
    }

    fn resolve_chat_service(&self, id: &str) -> Result<ResolvedService, ServiceResolveDenied> {
        let Ok(reg) = self.0.lock() else {
            return Err(ServiceResolveDenied::Unknown);
        };
        let snap = reg.snapshot();
        let Some(s) = snap.services.iter().find(|s| s.id == id) else {
            return Err(ServiceResolveDenied::Unknown);
        };
        if !crate::http::service_source_capabilities(&s.capabilities, &s.category)
            .contains(&"chat")
        {
            return Err(ServiceResolveDenied::NotChatCapable {
                name: s.name.clone(),
            });
        }
        if s.status != crate::services::registry::ServiceStatus::Running {
            return Err(ServiceResolveDenied::NotRunning {
                name: s.name.clone(),
            });
        }
        Ok(ResolvedService {
            name: s.name.clone(),
            port: s.port,
        })
    }
}

/// The tunnel's shared state: identity, per-request sessions, provider
/// registry, codex agent and the short-lived model-catalog cache. Fields are
/// `pub(super)` so the Phase-6 tool loop (`ai/chat_agent.rs`) extends this
/// type without duplicating its plumbing; nothing outside `crate::ai` sees
/// them.
pub struct AiTunnel {
    pub(super) providers: ProviderRegistryHandle,
    pub(super) codex: CodexAgentHandle,
    pub(super) identity: E2eIdentity,
    pub(super) sessions: E2eSessions,
    pub(super) models_cache: Mutex<HashMap<String, (Instant, Arc<Vec<String>>)>>,
    /// Marker recording which pubkey was last accepted by the backend, so the
    /// publish only fires on boot-when-absent / after rotation (plan §5.1).
    pub(super) published_marker: PathBuf,
    /// Log-once latch for publish failures (the poll loop retries each cycle).
    pub(super) publish_note: Mutex<Option<String>>,
    /// Phase 6: the chat-tools catalog, cached ~5 min (mirrors `models_cache`).
    pub(super) tools_cache: Mutex<Option<(Instant, Arc<Vec<Value>>)>>,
    /// Phase 6: confirm-mode approval deadline + poll cadence (test seam —
    /// production keeps the 120 s / 1.5 s defaults).
    pub(super) confirm_timing: crate::ai::chat_agent::ConfirmTiming,
    /// Chat-capable LOCAL SERVICES (`service:<id>` provider ids) — the
    /// llama-cpp/ollama surface of the Settings dropdown. `None` on runtimes
    /// without a services registry: those refuse `service:` requests typed.
    pub(super) services: Option<Arc<dyn TunnelServiceDirectory>>,
    /// browser-thread-id → codex-thread-id mapping (in-process only). The
    /// browser mints its OWN thread ids and sends the FULL conversation every
    /// turn, so this mapping is purely a resume optimization: absent (fresh
    /// process) or dead (codex lost the rollout) simply means a fresh codex
    /// thread gets the rendered conversation. A browser id is NEVER sent to
    /// codex as a rollout/thread id.
    pub(super) codex_threads: Mutex<CodexThreadMap>,
}

/// Bounded FIFO browser-thread → codex-thread map (see the field docs).
#[derive(Default)]
pub(super) struct CodexThreadMap {
    map: HashMap<String, String>,
    order: VecDeque<String>,
}

/// Bound on remembered browser→codex thread mappings (an optimization cache —
/// eviction only costs a fresh codex thread with re-rendered history).
const MAX_CODEX_THREAD_MAPPINGS: usize = 256;

/// The error CLASS that means "this codex thread/rollout no longer exists"
/// (the Codex app-server persists threads as rollout files; an agent/desktop
/// restart can lose them). Matched on the passed-through server message
/// because the RPC layer wraps every rejection as `codex_request_failed` —
/// the code alone cannot distinguish a dead rollout from a real refusal.
pub(super) fn is_dead_codex_thread_message(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("no rollout")
        || m.contains("rollout not found")
        || m.contains("unknown thread")
        || (m.contains("thread") && m.contains("not found"))
}

/// The prompt for a FRESH codex thread on the plain chat path: a single
/// message stays bare (the pre-existing shape); a multi-message conversation
/// is rendered in full — the browser sends complete history every turn, so
/// codex-side continuity is an optimization, never a correctness requirement.
fn codex_plain_prompt(messages: &[Value]) -> String {
    if messages.len() <= 1 {
        return last_user_text(messages);
    }
    crate::ai::chat_agent::render_convo_text(messages)
}

impl AiTunnel {
    /// Load (or mint) the E2E identity beside the plugin data and assemble the
    /// tunnel. `data_dir` backs the identity key-file fallback + the publish
    /// marker. `services` is the local-services surface for `service:<id>`
    /// provider ids (pass `Some(RegistryServices(registry))` where a services
    /// registry exists; `None` refuses those requests typed).
    pub fn new(
        providers: ProviderRegistryHandle,
        codex: CodexAgentHandle,
        data_dir: PathBuf,
        services: Option<Arc<dyn TunnelServiceDirectory>>,
    ) -> Result<Arc<Self>, String> {
        let identity = E2eIdentity::load_or_create(&data_dir)?;
        Ok(Arc::new(Self {
            providers,
            codex,
            identity,
            sessions: E2eSessions::new(),
            models_cache: Mutex::new(HashMap::new()),
            published_marker: data_dir.join("desktop-e2e-published.json"),
            publish_note: Mutex::new(None),
            tools_cache: Mutex::new(None),
            confirm_timing: crate::ai::chat_agent::ConfirmTiming::default(),
            services,
            codex_threads: Mutex::new(CodexThreadMap::default()),
        }))
    }

    /// The codex thread to RESUME for a browser thread — ONLY an in-process
    /// mapping ever qualifies. The browser's own id never goes to codex
    /// (`None` here means: start fresh + render the full conversation).
    pub(super) fn codex_thread_for(&self, browser_thread: &str) -> Option<String> {
        let g = self.codex_threads.lock().unwrap_or_else(|e| e.into_inner());
        g.map.get(browser_thread).cloned()
    }

    /// Record a browser-thread → codex-thread mapping (bounded FIFO).
    pub(super) fn remember_codex_thread(&self, browser_thread: &str, codex_thread: &str) {
        let mut g = self.codex_threads.lock().unwrap_or_else(|e| e.into_inner());
        if g.map
            .insert(browser_thread.to_string(), codex_thread.to_string())
            .is_none()
        {
            g.order.push_back(browser_thread.to_string());
        }
        while g.order.len() > MAX_CODEX_THREAD_MAPPINGS {
            if let Some(old) = g.order.pop_front() {
                g.map.remove(&old);
            }
        }
    }

    /// Drop a mapping whose codex thread turned out to be dead.
    pub(super) fn forget_codex_thread(&self, browser_thread: &str) {
        let mut g = self.codex_threads.lock().unwrap_or_else(|e| e.into_inner());
        if g.map.remove(browser_thread).is_some() {
            if let Some(pos) = g.order.iter().position(|k| k == browser_thread) {
                g.order.remove(pos);
            }
        }
    }

    pub fn public_key_b64(&self) -> String {
        self.identity.public_key_b64()
    }

    /// Publish the identity public key when the backend doesn't have THIS key
    /// yet (first boot, or after a rotation). Best-effort and non-fatal: an
    /// older backend without the lane (404) or a transient failure just means
    /// the next poll cycle tries again. The marker file is only written after
    /// the server accepts the key.
    async fn publish_pubkey_if_needed(&self, client: &FormLogicClient, instance_id: &str) {
        let pubkey = self.identity.public_key_b64();
        if let Ok(text) = std::fs::read_to_string(&self.published_marker) {
            let matches = serde_json::from_str::<Value>(&text)
                .ok()
                .map(|v| {
                    v.get("instanceId").and_then(Value::as_str) == Some(instance_id)
                        && v.get("publicKey").and_then(Value::as_str) == Some(pubkey.as_str())
                })
                .unwrap_or(false);
            if matches {
                return;
            }
        }
        match client.publish_e2e_pubkey(instance_id, &pubkey).await {
            Ok(()) => {
                let body = json!({
                    "instanceId": instance_id,
                    "publicKey": pubkey,
                    "publishedAt": chrono::Utc::now().to_rfc3339(),
                });
                let tmp = self.published_marker.with_extension("tmp");
                if let Err(e) = std::fs::write(&tmp, body.to_string().as_bytes())
                    .and_then(|()| std::fs::rename(&tmp, &self.published_marker))
                {
                    eprintln!("[ai-tunnel] pubkey publish marker write failed: {e}");
                }
                self.note_publish(None);
            }
            Err(FlError::Http { status: 404, .. }) => {
                // Older backend without the desktop-ai lane — expected during rollout.
                self.note_publish(Some(
                    "backend has no desktop-ai lane yet (404) — will retry".to_string(),
                ));
            }
            Err(e) => {
                self.note_publish(Some(format!("pubkey publish failed: {e}")));
            }
        }
    }

    /// Log publish state changes once (success clears a prior failure note).
    fn note_publish(&self, note: Option<String>) {
        let mut g = self.publish_note.lock().unwrap_or_else(|e| e.into_inner());
        if *g != note {
            match &note {
                Some(msg) => eprintln!("[ai-tunnel] {msg}"),
                None => {
                    if g.is_some() {
                        eprintln!("[ai-tunnel] e2e pubkey published");
                    }
                }
            }
            *g = note;
        }
    }

    /// One long-poll cycle: publish (if needed) → pending → claim → process,
    /// strictly sequentially (single-flight per the AI lane).
    pub async fn poll_cycle(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
    ) -> PollCycleOutcome {
        self.publish_pubkey_if_needed(client, instance_id).await;
        match client
            .poll_pending_ai_requests(instance_id, POLL_WAIT_MS)
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
                        eprintln!("[ai-tunnel] pending row without an id — skipped");
                        continue;
                    };
                    match client.claim_ai_request(&id, instance_id).await {
                        Ok(true) => {
                            self.process_claimed(client, instance_id, &id, request)
                                .await
                        }
                        Ok(false) => {} // another runtime won / expired — not ours
                        Err(e) => {
                            return PollCycleOutcome {
                                backoff: TRANSIENT_BACKOFF,
                                error: Some(format!("ai request {id} claim: {e}")),
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
                error: Some(format!("ai relay poll: {e}")),
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
                error: Some(format!("ai relay poll: {e}")),
            },
        }
    }

    /// Full pipeline for ONE claimed request. The terminal content always
    /// rides the LAST sealed frame (completion purges frames server-side, so
    /// the complete call itself carries only the status): success seals the
    /// final body; failure seals a typed `error` frame when a peer key is
    /// available to seal to. Always reports a terminal status and always drops
    /// the request's E2E session afterwards. Never panics.
    async fn process_claimed(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        request: &Value,
    ) {
        let outcome = self.run_request(client, instance_id, id, request).await;
        let (status, final_frame) = match outcome {
            Ok(final_plaintext) => match self.sessions.seal_outbound(id, &final_plaintext) {
                Ok(envelope) => ("done", Some(envelope)),
                Err(e) => (
                    "failed",
                    self.seal_error_frame(id, request, e.code(), e.message()),
                ),
            },
            Err(e) => (
                "failed",
                self.seal_error_frame(id, request, e.code(), e.message()),
            ),
        };
        // The final/error frame goes BEFORE the status flip: complete purges
        // the lane's frames, so anything after it would never be readable. A
        // frame post failure still completes (the row must end somewhere) —
        // the reader sees the honest failed status / a truncated stream.
        if let Some(envelope) = final_frame {
            if let Err(e) = client.append_ai_frame(id, instance_id, &envelope).await {
                eprintln!("[ai-tunnel] request {id} final frame post failed: {e}");
            }
        }
        let payload = json!({ "status": status });
        if let Err(e) = client.complete_ai_request(id, &payload, instance_id).await {
            eprintln!("[ai-tunnel] request {id} complete failed: {e}");
        }
        self.sessions.drop_thread(id);
    }

    /// Seal a typed terminal error as one last frame for the requester. When
    /// the request envelope never opened (no session), seal DETACHED to the
    /// row's ephemeral key at outbound counter 0 — the browser can still read
    /// WHY it failed (rotation/tamper cases degrade to the bare failed status).
    fn seal_error_frame(
        &self,
        id: &str,
        request: &Value,
        code: &str,
        message: &str,
    ) -> Option<String> {
        let frame = json!({
            "v": 1,
            "kind": "error",
            "code": code,
            "message": message,
        });
        let plaintext = frame.to_string();
        if let Ok(envelope) = self.sessions.seal_outbound(id, plaintext.as_bytes()) {
            return Some(envelope);
        }
        let eph_pub = str_field(request, &["ephPub", "eph_pub"])?;
        let eph: [u8; 32] = B64.decode(eph_pub).ok()?.try_into().ok()?;
        crate::ai::e2e::seal_detached_envelope(
            &self.identity.secret_key_bytes(),
            &eph,
            crate::ai::e2e::DIR_DESKTOP_TO_BROWSER,
            0,
            plaintext.as_bytes(),
        )
        .ok()
    }

    /// open → validate → dispatch. Returns the FINAL plaintext body to seal
    /// into the completion envelope.
    async fn run_request(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        request: &Value,
    ) -> Result<Vec<u8>, TunnelError> {
        let kind = str_field(request, &["kind"]).unwrap_or("chat").to_string();
        let provider_id = str_field(request, &["providerId", "provider_id"])
            .ok_or_else(|| TunnelError::new("invalid_request", "request row has no provider id"))?;
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
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(m) = model.as_deref() {
            validate_model_shape(m)?;
        }
        // `kind=providers` enumerates the WHOLE gateway (the Settings dropdown
        // on browsers with no loopback desktop). Its provider id is the pinned
        // placeholder 'all' — the enqueue requires a token there — so it is
        // deliberately NEVER resolved/validated as a real provider.
        if kind == "providers" {
            return self.run_providers().await;
        }
        let resolved = self
            .resolve_and_validate(provider_id, model.as_deref())
            .await?;

        match kind.as_str() {
            "chat" => {
                self.run_chat(
                    client,
                    instance_id,
                    id,
                    eph_pub,
                    &resolved,
                    &body,
                    model.as_deref(),
                )
                .await
            }
            "models" => self.run_models(&resolved).await,
            other => Err(TunnelError::new(
                "invalid_request",
                format!("unknown request kind {other:?}"),
            )),
        }
    }

    /// Fail-closed provider + model validation (plan §5.5/§7): the provider id
    /// must resolve to an ENABLED chat-capable entry (registry), a RUNNING
    /// chat-capable local service (`service:<id>`), or the managed Codex
    /// account, and an explicitly requested model must be in that provider's
    /// catalog — never substituted.
    async fn resolve_and_validate(
        &self,
        provider_id: &str,
        model: Option<&str>,
    ) -> Result<ResolvedProvider, TunnelError> {
        if let Some(service_id) = provider_id.strip_prefix("service:") {
            let profile = self.resolve_service_profile(service_id)?;
            if let Some(model) = model {
                let catalog = self.registry_model_catalog(&profile).await?;
                if !catalog.iter().any(|m| m == model) {
                    return Err(TunnelError::new(
                        "model_unavailable",
                        format!("model {model:?} is not available on provider {provider_id:?}"),
                    ));
                }
            }
            return Ok(ResolvedProvider::Registry(profile));
        }
        if crate::ai::codex::is_virtual_provider_id(provider_id) {
            // Managed Codex account: only the async alias fits a queued lane
            // (the live-call variants are realtime-only by design).
            if provider_id != crate::ai::codex::ASYNC_PROVIDER_ID {
                return Err(TunnelError::new(
                    "provider_unavailable",
                    format!(
                        "provider {provider_id:?} is realtime-only and cannot serve queued chat"
                    ),
                ));
            }
            if let Some(model) = model {
                let catalog = self.codex_model_catalog().await?;
                if !catalog.iter().any(|m| m == model) {
                    return Err(TunnelError::new(
                        "model_unavailable",
                        format!("model {model:?} is not available on provider {provider_id:?}"),
                    ));
                }
            }
            return Ok(ResolvedProvider::CodexAsync);
        }
        let provider =
            gateway::resolve_provider(&self.providers, Some(provider_id), None, Capability::Chat)
                .map_err(|e| TunnelError::new("provider_unavailable", e.message()))?
                .ok_or_else(|| {
                    TunnelError::new(
                        "provider_unavailable",
                        format!("provider {provider_id:?} is not configured for chat"),
                    )
                })?;
        if let Some(model) = model {
            let catalog = self.registry_model_catalog(&provider).await?;
            if !catalog.iter().any(|m| m == model) {
                return Err(TunnelError::new(
                    "model_unavailable",
                    format!("model {model:?} is not available on provider {provider_id:?}"),
                ));
            }
        }
        Ok(ResolvedProvider::Registry(provider))
    }

    /// Resolve `service:<id>` to a synthetic OpenAI-protocol loopback profile
    /// (llama-cpp and ollama both serve `/v1/chat/completions` + `/v1/models`).
    /// Fail closed with typed, ACTIONABLE refusals; a stopped service is never
    /// auto-started from this lane.
    fn resolve_service_profile(&self, service_id: &str) -> Result<ProviderProfile, TunnelError> {
        let Some(services) = &self.services else {
            return Err(TunnelError::new(
                "provider_unavailable",
                "local services are not available on this desktop runtime",
            ));
        };
        let resolved = match services.resolve_chat_service(service_id) {
            Ok(resolved) => resolved,
            Err(ServiceResolveDenied::Unknown) => {
                return Err(TunnelError::new(
                    "provider_unavailable",
                    format!("unknown provider \"service:{service_id}\""),
                ));
            }
            Err(ServiceResolveDenied::NotChatCapable { name }) => {
                return Err(TunnelError::new(
                    "provider_unavailable",
                    format!("the {name} service does not serve chat"),
                ));
            }
            Err(ServiceResolveDenied::NotRunning { name }) => {
                return Err(TunnelError::new(
                    "provider_unavailable",
                    format!(
                        "the {name} service is not running — start it from the Desktop Connection panel, then try again"
                    ),
                ));
            }
        };
        Ok(ProviderProfile {
            id: format!("service:{service_id}"),
            name: resolved.name,
            category: None,
            tags: vec![],
            protocol: crate::ai::providers::Protocol::OpenAi,
            base_url: format!("http://127.0.0.1:{}", resolved.port),
            model: None,
            capabilities: vec![Capability::Chat],
            headers: vec![],
            secret_ref: None,
            specs: Default::default(),
            allow_local: true,
            enabled: true,
        })
    }

    /// Dispatch a tunneled chat turn. Streaming providers forward every OpenAI
    /// chunk as a sealed delta frame; translated protocols (and the managed
    /// Codex lane) answer with one sealed final completion.
    ///
    /// Phase 6 (plan §5.4): a body carrying a non-empty `toolGrant` takes the
    /// chat_agent tool loop for EVERY provider kind — natively for
    /// OpenAI-dialect registry providers, via the prompt-level harness for
    /// providers whose wire cannot carry tool schemas (the managed Codex lane,
    /// Anthropic-translated and Custom-mapped providers). The only fallbacks
    /// to the plain path below are an empty/unfetchable tool catalog (the
    /// model honestly has no tools) and grant-less requests, which stay
    /// byte-identical to the pre-Phase-6 path.
    async fn run_chat(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        eph_pub: &str,
        resolved: &ResolvedProvider,
        body: &Value,
        model: Option<&str>,
    ) -> Result<Vec<u8>, TunnelError> {
        let messages = body
            .get("messages")
            .and_then(Value::as_array)
            .filter(|m| !m.is_empty())
            .cloned()
            .ok_or_else(|| {
                TunnelError::new("invalid_request", "sealed chat body has no messages")
            })?;
        let tool_grant = body
            .get("toolGrant")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(grant) = tool_grant {
            let tools = self.chat_tools_openai(client).await;
            if !tools.is_empty() {
                return self
                    .run_chat_with_tools(
                        client,
                        instance_id,
                        id,
                        eph_pub,
                        resolved,
                        &messages,
                        body,
                        model,
                        grant,
                        tools,
                    )
                    .await;
            }
        }

        match resolved {
            ResolvedProvider::CodexAsync => {
                if last_user_text(&messages).is_empty() {
                    return Err(TunnelError::new(
                        "invalid_request",
                        "sealed chat body has no user message",
                    ));
                }
                // The browser's threadId is ITS OWN thread key — never a codex
                // rollout id. A same-process mapping resumes the codex thread
                // with just the new user turn (an optimization); otherwise —
                // and automatically when the mapped rollout turns out DEAD
                // (codex/desktop restarted since) — a FRESH codex thread gets
                // the full rendered conversation: the browser sends complete
                // history every turn, so the user always gets an answer.
                let browser_thread = body
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // Per-turn reasoning effort from the sealed body (browser chat
                // selector / Settings default). Codex validates the value —
                // an invalid effort comes back as a typed invalid_request.
                let reasoning = body
                    .get("reasoning")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let fresh = CodexChatRequest {
                    prompt: codex_plain_prompt(&messages),
                    thread_id: None,
                    model: model.map(str::to_string),
                    reasoning_effort: reasoning.clone(),
                    service_tier: None,
                    // A fresh thread re-renders the whole conversation, so it
                    // re-attaches the conversation's images (newest-capped).
                    images: crate::ai::chat_agent::collect_user_image_urls(&messages, false),
                };
                let mapped = browser_thread
                    .as_deref()
                    .and_then(|t| self.codex_thread_for(t));
                let response = match mapped {
                    Some(codex_thread) => {
                        let resume = CodexChatRequest {
                            prompt: last_user_text(&messages),
                            thread_id: Some(codex_thread),
                            model: model.map(str::to_string),
                            reasoning_effort: reasoning.clone(),
                            service_tier: None,
                            // The resumed thread already saw earlier images —
                            // only the NEW user turn's ride this request.
                            images: crate::ai::chat_agent::collect_user_image_urls(&messages, true),
                        };
                        match self.codex_chat_with_busy_backoff(resume).await {
                            Ok(response) => response,
                            Err(e) if is_dead_codex_thread_message(e.message()) => {
                                if let Some(bt) = browser_thread.as_deref() {
                                    self.forget_codex_thread(bt);
                                }
                                self.codex_chat_with_busy_backoff(fresh).await?
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    None => self.codex_chat_with_busy_backoff(fresh).await?,
                };
                if let Some(bt) = browser_thread.as_deref() {
                    self.remember_codex_thread(bt, &response.thread_id);
                }
                // Same OpenAI-shaped projection the HTTP gateway emits.
                let completion = json!({
                    "id": format!("chatcmpl-formlogic-codex-{}", response.turn_id),
                    "object": "chat.completion",
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "message": { "role": "assistant", "content": response.text },
                        "finish_reason": "stop"
                    }]
                });
                Ok(final_body(completion))
            }
            ResolvedProvider::Registry(provider) => {
                let mut chat_body = json!({ "messages": messages });
                if let Some(m) = model {
                    chat_body["model"] = json!(m);
                }
                if gateway::protocol_streamable(provider) {
                    chat_body["stream"] = json!(true);
                    self.stream_registry_chat(client, instance_id, id, provider, chat_body)
                        .await
                } else {
                    let completion =
                        gateway::chat_completions(&self.providers, provider, chat_body)
                            .await
                            .map_err(gateway_tunnel_error)?;
                    Ok(final_body(completion))
                }
            }
        }
    }

    /// `kind=models` (plan §5.5): the remote model catalog, sealed. The
    /// Wave-1 web client (`desktopTunnel.ts fetchModelCatalog`) reads
    /// `frame.models` as a plain ARRAY of `{id, …}` objects, so both the
    /// OpenAI `{object:'list', data:[…]}` and the managed Codex `{models:[…]}`
    /// shapes are normalized down to `[{id, name?}]` here (Wave-2 fix — the
    /// raw bodies were sealed verbatim before, which never satisfied
    /// `Array.isArray(frame.models)` and left the catalog empty remotely).
    async fn run_models(&self, resolved: &ResolvedProvider) -> Result<Vec<u8>, TunnelError> {
        let raw = match resolved {
            ResolvedProvider::CodexAsync => {
                let response = self.codex.models().await.map_err(|e| {
                    TunnelError::new("provider_unavailable", format!("codex models: {e}"))
                })?;
                json!(response)
            }
            ResolvedProvider::Registry(provider) => gateway::list_models(&self.providers, provider)
                .await
                .map_err(gateway_tunnel_error)?,
        };
        let body = json!({
            "v": 1,
            "type": "models",
            "models": normalize_models_catalog(&raw),
        });
        Ok(serde_json::to_vec(&body).unwrap_or_default())
    }

    /// `kind=providers`: enumerate the chat-servable provider set, sealed —
    /// the same rows the loopback `GET /api/ai/sources` union exposes:
    /// chat-capable LOCAL SERVICES (`service:<id>` — llama-cpp/ollama; listed
    /// regardless of run state, a stopped one fails typed + actionable at
    /// use), registry profiles incl. disabled ones (the web filters via
    /// `enabled`), plus the managed Codex account when it is connected. The
    /// realtime-only Codex live-call variants are deliberately EXCLUDED: this
    /// catalog feeds the queued chat lane's provider dropdown, and
    /// `resolve_and_validate` refuses those ids there by design — offering
    /// them would be offering guaranteed failures.
    ///
    /// Row shape (pinned by the web's `providerListingFromTunnel` mapper):
    /// `{id, label, capabilities?: string[], enabled?: bool, model?: string}`
    /// — an empty/missing capability list means unrestricted, the same
    /// convention as the sources union.
    async fn run_providers(&self) -> Result<Vec<u8>, TunnelError> {
        let mut providers: Vec<Value> = Vec::new();
        // Local services first, mirroring the sources union's ordering.
        if let Some(services) = &self.services {
            for (id, name) in services.chat_services() {
                providers.push(json!({
                    "id": format!("service:{id}"),
                    "label": name,
                    "capabilities": ["chat"],
                    "enabled": true,
                }));
            }
        }
        {
            let reg = self.providers.lock().unwrap_or_else(|e| e.into_inner());
            for view in reg.list() {
                let capabilities: Vec<&'static str> = view
                    .profile
                    .capabilities
                    .iter()
                    .map(|c| crate::ai::providers::capability_key(*c))
                    .collect();
                let mut row = json!({
                    "id": view.profile.id,
                    "label": view.profile.name,
                    "capabilities": capabilities,
                    "enabled": view.profile.enabled,
                });
                if let Some(model) = view.profile.model.as_deref().filter(|m| !m.is_empty()) {
                    row["model"] = json!(model);
                }
                providers.push(row);
            }
        }
        // The managed Codex account, exactly like the sources union: present
        // only when connected (the catalog probe doubles as the auth check;
        // it rides this tunnel's 5-minute codex catalog cache).
        if self.codex_model_catalog().await.is_ok() {
            providers.push(json!({
                "id": crate::ai::codex::ASYNC_PROVIDER_ID,
                "label": "ChatGPT via Codex (background tasks)",
                "capabilities": ["chat"],
                "enabled": true,
                "model": crate::ai::codex::LUNA_LIVE_CALL_MODEL,
            }));
        }
        let body = json!({
            "v": 1,
            "type": "providers",
            "providers": providers,
        });
        Ok(serde_json::to_vec(&body).unwrap_or_default())
    }

    /// Stream one registry chat completion, sealing every upstream OpenAI chunk
    /// as a monotonic `seq` frame. A frame that fails to POST is logged and the
    /// stream continues — the browser detects gaps from the seq numbers rather
    /// than being shown silently fabricated output.
    ///
    /// A provider that IGNORES `stream: true` and answers with a plain JSON
    /// completion (Content-Type not `text/event-stream`) is not an error: the
    /// body is treated exactly like the buffered path instead of failing the
    /// request on a missing [DONE] marker.
    async fn stream_registry_chat(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        provider: &ProviderProfile,
        chat_body: Value,
    ) -> Result<Vec<u8>, TunnelError> {
        let upstream = gateway::chat_completions_stream(&self.providers, provider, chat_body)
            .await
            .map_err(gateway_tunnel_error)?;
        let is_sse = upstream
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.to_ascii_lowercase().starts_with("text/event-stream"))
            .unwrap_or(false);
        if !is_sse {
            let bytes = read_body_capped(upstream).await?;
            let completion: Value = serde_json::from_slice(&bytes).map_err(|_| {
                TunnelError::new(
                    "upstream_error",
                    "provider returned a non-SSE, non-JSON chat response",
                )
            })?;
            return Ok(final_body(completion));
        }
        let mut stream = upstream.bytes_stream();
        let mut sse_buf: Vec<u8> = Vec::new();
        let mut seq: u64 = 0;
        let mut saw_done = false;
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                TunnelError::new(
                    "upstream_error",
                    format!("provider stream read failed: {e}"),
                )
            })?;
            sse_buf.extend_from_slice(&chunk);
            // SSE events are separated by a blank line; parse complete events.
            while let Some(end) = find_sse_event_end(&sse_buf) {
                let event: Vec<u8> = sse_buf.drain(..end).collect();
                for line in event.split(|b| *b == b'\n') {
                    let line = trim_ascii(line);
                    let Some(data) = line.strip_prefix(b"data:") else {
                        continue;
                    };
                    let data = trim_ascii(data);
                    if data == b"[DONE]" {
                        saw_done = true;
                        continue;
                    }
                    let Ok(delta) = serde_json::from_slice::<Value>(data) else {
                        continue;
                    };
                    seq += 1;
                    if seq > MAX_STREAM_FRAMES {
                        return Err(TunnelError::new(
                            "upstream_error",
                            "provider stream exceeded the frame cap",
                        ));
                    }
                    let frame = json!({ "v": 1, "kind": "delta", "delta": delta });
                    let envelope = self
                        .sessions
                        .seal_outbound(id, frame.to_string().as_bytes())
                        .map_err(|e| TunnelError::new(e.code(), e.message()))?;
                    if let Err(e) = client.append_ai_frame(id, instance_id, &envelope).await {
                        eprintln!("[ai-tunnel] request {id} frame {seq} post failed: {e}");
                    }
                }
            }
        }
        if !saw_done && sse_buf.iter().any(|b| !b.is_ascii_whitespace()) {
            return Err(TunnelError::new(
                "upstream_error",
                "provider stream ended without a [DONE] marker",
            ));
        }
        // Deltas carried the content; the final body closes the turn.
        Ok(br#"{"v":1,"kind":"final"}"#.to_vec())
    }

    /// The managed Codex chat with the runner's typed `codex_busy` lane: only
    /// the exact code retries, on the bounded schedule (7 attempts max).
    /// `pub(super)` so the Phase-6 prompt-harness rounds ride the same lane.
    pub(super) async fn codex_chat_with_busy_backoff(
        &self,
        request: CodexChatRequest,
    ) -> Result<crate::ai::codex::CodexChatResponse, TunnelError> {
        let mut attempt = 0usize;
        loop {
            match self.codex.assistant_chat(request.clone()).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    if e.code() == "codex_busy" && attempt + 1 < CODEX_BUSY_MAX_ATTEMPTS {
                        tokio::time::sleep(Duration::from_millis(CODEX_BUSY_BACKOFF_MS[attempt]))
                            .await;
                        attempt += 1;
                        continue;
                    }
                    return Err(TunnelError::new(
                        if e.code() == "codex_busy" {
                            "provider_unavailable"
                        } else {
                            e.code()
                        },
                        e.message(),
                    ));
                }
            }
        }
    }

    /// 5-minute catalog cache (plan §5.5) for a registry provider.
    async fn registry_model_catalog(
        &self,
        provider: &ProviderProfile,
    ) -> Result<Arc<Vec<String>>, TunnelError> {
        let key = format!("registry:{}", provider.id);
        if let Some(hit) = self.cached_models(&key) {
            return Ok(hit);
        }
        let value = gateway::list_models(&self.providers, provider)
            .await
            .map_err(gateway_tunnel_error)?;
        let ids = catalog_ids(&value).ok_or_else(|| {
            TunnelError::new(
                "provider_unavailable",
                format!(
                    "provider {:?} returned a malformed model catalog",
                    provider.id
                ),
            )
        })?;
        Ok(self.cache_models(key, ids))
    }

    /// 5-minute catalog cache for the managed Codex account.
    async fn codex_model_catalog(&self) -> Result<Arc<Vec<String>>, TunnelError> {
        let key = "codex".to_string();
        if let Some(hit) = self.cached_models(&key) {
            return Ok(hit);
        }
        let response =
            self.codex.models().await.map_err(|e| {
                TunnelError::new("provider_unavailable", format!("codex models: {e}"))
            })?;
        let ids: Vec<String> = response.models.into_iter().map(|m| m.id).collect();
        Ok(self.cache_models(key, ids))
    }

    fn cached_models(&self, key: &str) -> Option<Arc<Vec<String>>> {
        let cache = self.models_cache.lock().unwrap_or_else(|e| e.into_inner());
        cache
            .get(key)
            .filter(|(at, _)| at.elapsed() < MODELS_CACHE_TTL)
            .map(|(_, ids)| ids.clone())
    }

    fn cache_models(&self, key: String, ids: Vec<String>) -> Arc<Vec<String>> {
        let ids = Arc::new(ids);
        let mut cache = self.models_cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(key, (Instant::now(), ids.clone()));
        ids
    }
}

/// Read a non-SSE upstream body with the gateway's size cap (the provider
/// ignored `stream: true` and answered with a buffered JSON completion).
async fn read_body_capped(resp: reqwest::Response) -> Result<Vec<u8>, TunnelError> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            TunnelError::new(
                "upstream_error",
                format!("provider response read failed: {e}"),
            )
        })?;
        if out.len() as u64 + chunk.len() as u64 > gateway::MAX_RESPONSE_BYTES {
            return Err(TunnelError::new(
                "upstream_error",
                "provider response exceeded the size cap",
            ));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// The sealed final body for a buffered completion. `pub(super)` so the
/// Phase-6 tool loop closes its turn with the exact same terminal shape.
pub(super) fn final_body(completion: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "v": 1, "kind": "final", "completion": completion }))
        .unwrap_or_default()
}

/// Map a gateway failure onto the tunnel's §5.8 codes: unknown/disabled
/// providers stay `provider_unavailable`; everything else is an upstream fault.
pub(super) fn gateway_tunnel_error(e: gateway::GatewayError) -> TunnelError {
    match e {
        gateway::GatewayError::NoProvider(m) => TunnelError::new("provider_unavailable", m),
        other => TunnelError::new("upstream_error", other.message()),
    }
}

/// The request row's id, tolerant of the two casings the API uses elsewhere.
fn request_id(request: &Value) -> Option<String> {
    str_field(request, &["id", "requestId", "request_id"]).map(str::to_string)
}

/// First non-empty string among `keys` (camelCase/snake_case tolerance).
fn str_field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
}

/// Model ids out of an OpenAI-shaped `/v1/models` body (`data[].id`).
fn catalog_ids(value: &Value) -> Option<Vec<String>> {
    let data = value.get("data")?.as_array()?;
    Some(
        data.iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
            .collect(),
    )
}

/// Normalize a provider's model catalog into the plain `[{id, name?}]` array
/// the Wave-1 web client renders (`fetchModelCatalog` keeps object entries
/// only). Accepts the OpenAI `{object:'list', data:[…]}` shape, the managed
/// Codex `{models:[…]}` shape, or a bare array; entries without an `id` are
/// skipped and a human name is carried from `displayName`/`display_name`/`name`
/// when present.
fn normalize_models_catalog(value: &Value) -> Vec<Value> {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())?;
            let mut out = json!({ "id": id });
            if let Some(name) = entry
                .get("displayName")
                .and_then(Value::as_str)
                .or_else(|| entry.get("display_name").and_then(Value::as_str))
                .or_else(|| entry.get("name").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
            {
                out["name"] = json!(name);
            }
            Some(out)
        })
        .collect()
}

/// Cheap model-string hygiene before any catalog work (bounded, no controls).
fn validate_model_shape(model: &str) -> Result<(), TunnelError> {
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err(TunnelError::new(
            "model_unavailable",
            "requested model name is malformed",
        ));
    }
    Ok(())
}

/// The last user message's text — the prompt shape the Codex lane takes
/// (mirrors gateway.rs's `last_user_text`).
fn last_user_text(messages: &[Value]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|m| m.get("content"))
        // Parts-aware: text parts join; image parts render an honest marker,
        // which also keeps an image-only turn's prompt non-empty (the codex
        // request refuses empty prompts — the image itself rides `images`).
        .map(crate::ai::chat_agent::message_text)
        .unwrap_or_default()
}

/// End of a complete SSE event (a blank line), if one is buffered.
fn find_sse_event_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2)
        .position(|w| w == b"\n\n")
        .map(|i| i + 2)
        .or_else(|| buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4))
}

fn trim_ascii(mut s: &[u8]) -> &[u8] {
    while matches!(s.first(), Some(b' ' | b'\t' | b'\r')) {
        s = &s[1..];
    }
    while matches!(s.last(), Some(b' ' | b'\t' | b'\r')) {
        s = &s[..s.len() - 1];
    }
    s
}

#[cfg(test)]
mod tests;
