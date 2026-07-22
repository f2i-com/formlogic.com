//! Tests for the desktop flow-run E2E relay lane (Phase 5, plan §5.7):
//! claim → open → run a tiny in-process flow through the REAL runner → sealed
//! progress frames → sealed terminal result riding the complete call, plus
//! the typed-failure paths and the single-in-flight claim invariant.

use super::*;
use crate::ai::e2e::{
    DIR_BROWSER_TO_DESKTOP, DIR_DESKTOP_TO_BROWSER, open_detached_envelope, seal_detached_envelope,
};
use crate::flows::runner::{FlowError, FlowErrorCode, RunDeps, RunOptions};
use axum::Router;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json as AxumJson;
use axum::routing::{get, post};
use std::collections::HashMap;
use std::sync::Mutex;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

fn identity(seed: u8) -> E2eIdentity {
    E2eIdentity::from_secret_bytes([seed; 32])
}

fn browser_keypair(seed: u8) -> ([u8; 32], [u8; 32]) {
    let secret = [seed; 32];
    let public = crypto_box::SecretKey::from(secret).public_key().to_bytes();
    (secret, public)
}

/// The lane's executor seam, backed by the REAL runner for the two named
/// flows and canned outcomes for the edge fixtures (the lane only ever sees
/// the runner's `FlowOutcome`, so canned outcomes are legitimate here).
fn test_executor() -> FlowExecutor {
    Arc::new(|job: FlowRunJob| {
        Box::pin(async move {
            let flow_json = match job.flow_id.as_str() {
                "flow-echo" => json!({
                    "nodes": [
                        { "id": "in", "type": "input" },
                        { "id": "t", "type": "template", "data": { "template": "hi {{inputs.who}}" } },
                        { "id": "out", "type": "output", "data": { "value": "$upstream" } }
                    ],
                    "edges": [ { "source": "in", "target": "t" }, { "source": "t", "target": "out" } ]
                }),
                "flow-broken" => json!({
                    "nodes": [ { "id": "a", "type": "input" }, { "id": "b", "type": "quantum_flux" } ],
                    "edges": [ { "source": "a", "target": "b" } ]
                }),
                "flow-huge" => {
                    return FlowOutcome {
                        status: "done",
                        result: Some(json!("x".repeat(1024 * 1024 + 100))),
                        error: None,
                        nodes_executed: 1,
                    };
                }
                other => {
                    return FlowOutcome {
                        status: "error",
                        result: None,
                        error: Some(FlowError {
                            code: FlowErrorCode::InvalidFlow,
                            message: format!("Unknown flow '{other}'"),
                            node_id: None,
                        }),
                        nodes_executed: 0,
                    };
                }
            };
            let deps = RunDeps {
                client: None,
                host: None,
                app_id: None,
                http: reqwest::Client::new(),
                llm_endpoint: None,
                base_url: "http://formlogic.local".into(),
                registry: None,
                service_bases: HashMap::new(),
                default_ai_prefs: None,
                invoke_child_flow: None,
            };
            let opts = RunOptions {
                inputs: job.inputs,
                event: None,
                app: None,
                timeout_ms: runner::DEFAULT_TIMEOUT_MS,
                capabilities: vec![],
                flow_slug: job.flow_id.clone(),
                request_id_seed: job.seed.clone(),
                progress: job.progress,
                call_stack: vec![],
                run_id: None,
            };
            runner::execute_flow(&flow_json, &deps, &opts).await
        })
    })
}

fn relay_for(identity: E2eIdentity) -> Arc<FlowRelay> {
    Arc::new(FlowRelay {
        identity,
        sessions: E2eSessions::new(),
        executor: test_executor(),
    })
}

// ── stub backend (the desktop-flows relay routes) ──────────────────────────

#[derive(Clone, Default)]
struct StubBackend {
    pending: Arc<Mutex<Vec<Value>>>,
    claimed: Arc<Mutex<Vec<String>>>,
    frames: Arc<Mutex<Vec<Value>>>,
    completions: Arc<Mutex<Vec<Value>>>,
}

async fn stub_pending(State(st): State<StubBackend>) -> AxumJson<Value> {
    let rows = st.pending.lock().unwrap().clone();
    AxumJson(json!({ "requests": rows }))
}

async fn stub_claim(
    State(st): State<StubBackend>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, AxumJson<Value>) {
    let mut claimed = st.claimed.lock().unwrap();
    if claimed.iter().any(|c| c == &id) {
        // The single-in-flight invariant, server-side: one claimant per row.
        return (
            StatusCode::CONFLICT,
            AxumJson(json!({ "message": "already claimed" })),
        );
    }
    claimed.push(id);
    (StatusCode::OK, AxumJson(json!({ "status": "claimed" })))
}

async fn stub_frame(
    State(st): State<StubBackend>,
    AxumPath(id): AxumPath<String>,
    AxumJson(body): AxumJson<Value>,
) -> AxumJson<Value> {
    let envelope = body
        .get("envelope")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut frames = st.frames.lock().unwrap();
    let seq = frames.iter().filter(|f| f["requestId"] == id).count() as u64 + 1;
    frames.push(json!({ "requestId": id, "seq": seq, "envelope": envelope }));
    AxumJson(json!({ "seq": seq, "status": "streaming" }))
}

async fn stub_complete(
    State(st): State<StubBackend>,
    AxumPath(id): AxumPath<String>,
    AxumJson(body): AxumJson<Value>,
) -> AxumJson<Value> {
    let mut body = body;
    body["requestId"] = json!(id);
    st.completions.lock().unwrap().push(body);
    AxumJson(json!({ "status": "ok" }))
}

async fn spawn_backend(st: StubBackend) -> String {
    let app = Router::new()
        .route("/api/v1/desktop-flows/pending", get(stub_pending))
        .route("/api/v1/desktop-flows/:id/claim", post(stub_claim))
        .route("/api/v1/desktop-flows/:id/frames", post(stub_frame))
        .route("/api/v1/desktop-flows/:id/complete", post(stub_complete))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

fn client_for(base: &str) -> FormLogicClient {
    FormLogicClient::new(&crate::formlogic_client::FormLogicConfig {
        base_url: base.into(),
        api_key: "flk_test".into(),
    })
    .unwrap()
}

fn seal_request(browser_secret: &[u8; 32], desktop_public: &[u8; 32], body: &Value) -> String {
    seal_detached_envelope(
        browser_secret,
        desktop_public,
        DIR_BROWSER_TO_DESKTOP,
        0,
        body.to_string().as_bytes(),
    )
    .unwrap()
}

fn open_frame(browser_secret: &[u8; 32], desktop_public: &[u8; 32], envelope: &str) -> Value {
    let opened = open_detached_envelope(
        browser_secret,
        desktop_public,
        DIR_DESKTOP_TO_BROWSER,
        envelope,
    )
    .unwrap();
    serde_json::from_slice(&opened).unwrap()
}

fn pending_row(id: &str, flow_id: &str, browser_public: &[u8; 32], envelope: String) -> Value {
    json!({
        "requestId": id,
        "flowId": flow_id,
        "ephPub": B64.encode(browser_public),
        "envelope": envelope,
    })
}

// ── single in-flight (server-side claim gate, mocked) ──────────────────────

#[tokio::test]
async fn claimed_request_blocks_a_second_claim() {
    let backend = StubBackend::default();
    let base = spawn_backend(backend.clone()).await;
    let client = client_for(&base);

    assert!(client.claim_flow_run("fr-1", "desktop-test").await.unwrap());
    // Second claim (same row, any instance) → 409 → Ok(false).
    assert!(!client.claim_flow_run("fr-1", "desktop-test").await.unwrap());
    assert!(
        !client
            .claim_flow_run("fr-1", "desktop-other")
            .await
            .unwrap()
    );
    assert_eq!(backend.claimed.lock().unwrap().len(), 1);
}

// ── happy path: claim → execute → sealed progress → sealed result ──────────

#[tokio::test]
async fn poll_cycle_executes_and_completes_done_with_sealed_result() {
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xE1);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xC1);

    let run_body = json!({
        "v": 1,
        "inputs": { "who": "ada" },
        "clientSeq": 1,
    });
    backend.pending.lock().unwrap().push(pending_row(
        "fr-1",
        "flow-echo",
        &browser_public,
        seal_request(&browser_secret, &desktop_public, &run_body),
    ));

    let relay = relay_for(desktop);
    let client = client_for(&backend_base);
    let outcome = relay.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // Completed done, claimant-bound, with the SEALED result envelope kept in
    // the complete call's `result` field (the flow-lane contract).
    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "done");
    assert_eq!(completions[0]["instanceId"], "desktop-test");
    let result_envelope = completions[0]["result"]
        .as_str()
        .expect("the sealed result envelope rides complete.result");
    let result_body = open_frame(&browser_secret, &desktop_public, result_envelope);
    assert_eq!(result_body["v"], 1);
    assert_eq!(result_body["type"], "flow_result");
    assert_eq!(result_body["status"], "done");
    assert_eq!(result_body["result"], "hi ada");

    // Sealed progress frames at every node boundary, monotonic server seqs.
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 3, "one progress frame per node");
    let expected_nodes = ["in", "t", "out"];
    for (i, frame) in frames.iter().enumerate() {
        assert_eq!(
            frame["seq"].as_u64().unwrap(),
            (i + 1) as u64,
            "seq monotonic"
        );
        let progress = open_frame(
            &browser_secret,
            &desktop_public,
            frame["envelope"].as_str().unwrap(),
        );
        assert_eq!(progress["v"], 1);
        assert_eq!(progress["type"], "flow_progress");
        assert_eq!(progress["nodeId"], expected_nodes[i]);
        assert_eq!(progress["status"], "done");
    }

    // Session dropped at completion.
    assert_eq!(relay.sessions.thread_count(), 0);
}

// ── a failed node completes failed with the typed code ─────────────────────

#[tokio::test]
async fn typed_failure_completes_failed_with_sealed_error() {
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xE2);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xC2);

    let run_body = json!({ "v": 1, "inputs": {} });
    backend.pending.lock().unwrap().push(pending_row(
        "fr-bad",
        "flow-broken",
        &browser_public,
        seal_request(&browser_secret, &desktop_public, &run_body),
    ));

    let relay = relay_for(desktop);
    let client = client_for(&backend_base);
    let outcome = relay.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none());

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "failed");
    let result_body = open_frame(
        &browser_secret,
        &desktop_public,
        completions[0]["result"].as_str().unwrap(),
    );
    assert_eq!(result_body["type"], "flow_result");
    assert_eq!(result_body["status"], "failed");
    assert_eq!(result_body["error"]["code"], "invalid_flow");

    // The failing node emitted its own failed progress frame after the first
    // node's done frame.
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 2);
    let last = open_frame(
        &browser_secret,
        &desktop_public,
        frames[1]["envelope"].as_str().unwrap(),
    );
    assert_eq!(last["type"], "flow_progress");
    assert_eq!(last["nodeId"], "b");
    assert_eq!(last["status"], "failed");
    assert!(last["message"].as_str().unwrap().contains("quantum_flux"));
    assert_eq!(relay.sessions.thread_count(), 0);
}

// ── an oversized result degrades to the typed result_too_large failure ─────

#[tokio::test]
async fn oversized_result_completes_failed_result_too_large() {
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xE3);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xC3);

    let run_body = json!({ "v": 1, "inputs": {} });
    backend.pending.lock().unwrap().push(pending_row(
        "fr-huge",
        "flow-huge",
        &browser_public,
        seal_request(&browser_secret, &desktop_public, &run_body),
    ));

    let relay = relay_for(desktop);
    let client = client_for(&backend_base);
    let outcome = relay.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none());

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "failed");
    let result_body = open_frame(
        &browser_secret,
        &desktop_public,
        completions[0]["result"].as_str().unwrap(),
    );
    assert_eq!(result_body["status"], "failed");
    assert_eq!(result_body["error"]["code"], "result_too_large");
    assert_eq!(relay.sessions.thread_count(), 0);
}

// ── a tampered envelope fails closed, still readably ───────────────────────

#[tokio::test]
async fn tampered_envelope_completes_failed_with_typed_code() {
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xE4);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xC4);

    // Sealed to a DIFFERENT desktop key: never opens on this install.
    let other_desktop_pub = identity(0x99).public_key_bytes();
    let run_body = json!({ "v": 1, "inputs": {} });
    backend.pending.lock().unwrap().push(pending_row(
        "fr-tampered",
        "flow-echo",
        &browser_public,
        seal_request(&browser_secret, &other_desktop_pub, &run_body),
    ));

    let relay = relay_for(desktop);
    let client = client_for(&backend_base);
    let outcome = relay.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none());

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "failed");
    // The failure body is sealed DETACHED (no session existed) — the browser
    // still reads WHY it failed.
    let result_body = open_frame(
        &browser_secret,
        &desktop_public,
        completions[0]["result"].as_str().unwrap(),
    );
    assert_eq!(result_body["type"], "flow_result");
    assert_eq!(result_body["status"], "failed");
    assert_eq!(result_body["error"]["code"], "sealed_envelope_invalid");
    assert_eq!(relay.sessions.thread_count(), 0);
}
