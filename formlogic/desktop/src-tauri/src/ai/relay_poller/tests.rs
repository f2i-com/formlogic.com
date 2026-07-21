//! Tests for the Site-AI E2E relay poller: fail-closed provider/model
//! validation, the single-in-flight claim invariant (mocked server), and the
//! full claim → open → dispatch → frames → complete pipeline against stub
//! backend + provider servers.

use super::*;
use crate::ai::e2e::{
    open_detached_envelope, seal_detached_envelope, DIR_BROWSER_TO_DESKTOP, DIR_DESKTOP_TO_BROWSER,
};
use crate::ai::providers::ProviderRegistry;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json as AxumJson;
use axum::routing::{get, post};
use axum::Router;
use base64::Engine as _;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "formlogic-ai-tunnel-{tag}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn identity(seed: u8) -> E2eIdentity {
    E2eIdentity::from_secret_bytes([seed; 32])
}

fn browser_keypair(seed: u8) -> ([u8; 32], [u8; 32]) {
    let secret = [seed; 32];
    let public = crypto_box::SecretKey::from(secret).public_key().to_bytes();
    (secret, public)
}

fn registry_with_provider(data_dir: &std::path::Path, base_url: &str) -> ProviderRegistryHandle {
    let handle: ProviderRegistryHandle = Arc::new(Mutex::new(ProviderRegistry::load(data_dir)));
    let profile = ProviderProfile {
        id: "prov-a".into(),
        name: "Provider A".into(),
        category: None,
        tags: vec![],
        protocol: crate::ai::providers::Protocol::OpenAi,
        base_url: base_url.into(),
        model: Some("model-a".into()),
        capabilities: vec![Capability::Chat],
        headers: vec![],
        secret_ref: None,
        specs: Default::default(),
        allow_local: true,
        enabled: true,
    };
    handle.lock().unwrap().upsert(profile).unwrap();
    handle
}

fn tunnel_for(
    providers: ProviderRegistryHandle,
    data_dir: PathBuf,
    identity: E2eIdentity,
) -> Arc<AiTunnel> {
    tunnel_with_services(providers, data_dir, identity, None)
}

fn tunnel_with_services(
    providers: ProviderRegistryHandle,
    data_dir: PathBuf,
    identity: E2eIdentity,
    services: Option<Arc<dyn TunnelServiceDirectory>>,
) -> Arc<AiTunnel> {
    Arc::new(AiTunnel {
        providers,
        codex: crate::ai::codex::CodexAgent::new(data_dir.join("codex")),
        identity,
        sessions: E2eSessions::new(),
        models_cache: Mutex::new(HashMap::new()),
        published_marker: data_dir.join("desktop-e2e-published.json"),
        publish_note: Mutex::new(None),
        tools_cache: Mutex::new(None),
        confirm_timing: crate::ai::chat_agent::ConfirmTiming::default(),
        services,
        codex_threads: Mutex::new(CodexThreadMap::default()),
    })
}

// ── fake local-services directory (the TunnelServiceDirectory test seam) ───

struct FakeService {
    id: &'static str,
    name: &'static str,
    chat: bool,
    running: bool,
    port: u16,
}

struct FakeServices(Vec<FakeService>);

impl TunnelServiceDirectory for FakeServices {
    fn chat_services(&self) -> Vec<(String, String)> {
        self.0
            .iter()
            .filter(|s| s.chat)
            .map(|s| (s.id.to_string(), s.name.to_string()))
            .collect()
    }

    fn resolve_chat_service(&self, id: &str) -> Result<ResolvedService, ServiceResolveDenied> {
        let Some(s) = self.0.iter().find(|s| s.id == id) else {
            return Err(ServiceResolveDenied::Unknown);
        };
        if !s.chat {
            return Err(ServiceResolveDenied::NotChatCapable {
                name: s.name.to_string(),
            });
        }
        if !s.running {
            return Err(ServiceResolveDenied::NotRunning {
                name: s.name.to_string(),
            });
        }
        Ok(ResolvedService {
            name: s.name.to_string(),
            port: s.port,
        })
    }
}

/// The loopback port of a spawned stub base URL (`http://127.0.0.1:PORT`).
fn stub_port(base: &str) -> u16 {
    base.rsplit(':').next().unwrap().parse().unwrap()
}

// ── stub backend (the desktop-ai relay routes) ─────────────────────────────

#[derive(Clone, Default)]
struct StubBackend {
    pending: Arc<Mutex<Vec<Value>>>,
    claimed: Arc<Mutex<Vec<String>>>,
    frames: Arc<Mutex<Vec<Value>>>,
    completions: Arc<Mutex<Vec<Value>>>,
    pubkeys: Arc<Mutex<Vec<Value>>>,
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
    st.pending
        .lock()
        .unwrap()
        .retain(|r| r.get("id").and_then(Value::as_str) != Some(id.as_str()));
    AxumJson(json!({ "status": "ok" }))
}

async fn stub_pubkey(
    State(st): State<StubBackend>,
    AxumJson(body): AxumJson<Value>,
) -> AxumJson<Value> {
    st.pubkeys.lock().unwrap().push(body);
    AxumJson(json!({ "status": "ok" }))
}

async fn spawn_backend(st: StubBackend) -> String {
    let app = Router::new()
        .route("/api/v1/desktop-ai/pending", get(stub_pending))
        .route("/api/v1/desktop-ai/:id/claim", post(stub_claim))
        .route("/api/v1/desktop-ai/:id/frames", post(stub_frame))
        .route("/api/v1/desktop-ai/:id/complete", post(stub_complete))
        .route("/api/v1/desktop-ai/pubkey", post(stub_pubkey))
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

// ── stub provider (OpenAI-shaped /v1) ──────────────────────────────────────

#[derive(Clone, Default)]
struct StubProvider {
    stream: bool,
}

async fn provider_models() -> AxumJson<Value> {
    AxumJson(json!({
        "object": "list",
        "data": [{ "id": "model-a", "object": "model" }],
    }))
}

async fn provider_chat(
    State(st): State<StubProvider>,
    AxumJson(body): AxumJson<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if body.get("stream").and_then(Value::as_bool) == Some(true) && st.stream {
        let sse = concat!(
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}\n\n",
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        return (
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            sse,
        )
            .into_response();
    }
    AxumJson(json!({
        "id": "chatcmpl-stub",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "stub answer" },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
    }))
    .into_response()
}

async fn spawn_provider(stream: bool) -> String {
    let app = Router::new()
        .route("/v1/models", get(provider_models))
        .route("/v1/chat/completions", post(provider_chat))
        .with_state(StubProvider { stream });
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

// ── validation (fail-closed) ───────────────────────────────────────────────

#[tokio::test]
async fn provider_and_model_validation_is_fail_closed() {
    let dir = temp_dir("validate");
    let provider_base = spawn_provider(false).await;
    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_for(registry, dir.clone(), identity(0xD0));

    // Unknown provider id → provider_unavailable.
    let err = tunnel
        .resolve_and_validate("no-such-provider", None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unavailable");

    // Disabled provider → provider_unavailable.
    {
        let mut disabled = tunnel.providers.lock().unwrap().get("prov-a").unwrap();
        disabled.enabled = false;
        tunnel.providers.lock().unwrap().upsert(disabled).unwrap();
    }
    let err = tunnel
        .resolve_and_validate("prov-a", None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unavailable");
    {
        let mut enabled = tunnel.providers.lock().unwrap().get("prov-a").unwrap();
        enabled.enabled = true;
        tunnel.providers.lock().unwrap().upsert(enabled).unwrap();
    }

    // Unknown model → model_unavailable (never substituted).
    let err = tunnel
        .resolve_and_validate("prov-a", Some("model-zzz"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "model_unavailable");

    // Catalog model + provider default both pass (the second call rides the
    // 5-minute catalog cache — no provider round-trip needed to stay green).
    assert!(tunnel
        .resolve_and_validate("prov-a", Some("model-a"))
        .await
        .is_ok());
    assert!(tunnel.resolve_and_validate("prov-a", None).await.is_ok());
    assert!(tunnel
        .resolve_and_validate("prov-a", Some("model-a"))
        .await
        .is_ok());

    // The realtime-only Codex aliases cannot serve a queued lane.
    let err = tunnel
        .resolve_and_validate("openai-codex-agent-low", None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unavailable");

    // Malformed model strings are refused before any catalog work.
    let err = tunnel
        .resolve_and_validate("prov-a", Some(&"x".repeat(300)))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "model_unavailable");

    let _ = std::fs::remove_dir_all(dir);
}

// ── single in-flight (server-side claim gate, mocked) ──────────────────────

#[tokio::test]
async fn claimed_request_blocks_a_second_claim() {
    let backend = StubBackend::default();
    let base = spawn_backend(backend.clone()).await;
    let client = client_for(&base);

    assert!(client
        .claim_ai_request("req-1", "desktop-test")
        .await
        .unwrap());
    // Second claim (same row, any instance) → 409 → Ok(false).
    assert!(!client
        .claim_ai_request("req-1", "desktop-test")
        .await
        .unwrap());
    assert!(!client
        .claim_ai_request("req-1", "desktop-other")
        .await
        .unwrap());
    assert_eq!(backend.claimed.lock().unwrap().len(), 1);
}

// ── full pipeline, buffered provider ───────────────────────────────────────

#[tokio::test]
async fn poll_cycle_opens_dispatches_and_completes_done() {
    let dir = temp_dir("e2e-buffered");
    let provider_base = spawn_provider(false).await;
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD1);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB1);

    let chat_body = json!({
        "v": 1,
        "model": "model-a",
        "messages": [{ "role": "user", "content": "hello?" }],
        "clientSeq": 1,
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-1",
        "kind": "chat",
        "providerId": "prov-a",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_for(registry, dir.clone(), desktop);
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // Pubkey published once (marker written), request completed done.
    assert_eq!(backend.pubkeys.lock().unwrap().len(), 1);
    assert!(tunnel.published_marker.exists());
    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(
        completions[0]["status"], "done",
        "completion: {}",
        completions[0]
    );

    // The final body rides exactly one frame (buffered provider, no deltas).
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1);
    let final_body = open_frame(
        &browser_secret,
        &desktop_public,
        frames[0]["envelope"].as_str().unwrap(),
    );
    assert_eq!(final_body["kind"], "final");
    assert_eq!(
        final_body["completion"]["choices"][0]["message"]["content"],
        "stub answer"
    );
    // Session dropped at completion.
    assert_eq!(tunnel.sessions.thread_count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

// ── full pipeline, streaming provider ──────────────────────────────────────

#[tokio::test]
async fn poll_cycle_streams_sealed_delta_frames_in_order() {
    let dir = temp_dir("e2e-stream");
    let provider_base = spawn_provider(true).await;
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD2);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB2);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "stream please" }],
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-stream",
        "kind": "chat",
        "providerId": "prov-a",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_for(registry, dir.clone(), desktop);
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    let frames = backend.frames.lock().unwrap().clone();
    // 3 delta frames (one per upstream chunk) + the closing final frame.
    assert_eq!(frames.len(), 4, "one frame per upstream chunk + final");
    let mut text = String::new();
    for (i, frame) in frames.iter().enumerate() {
        assert_eq!(
            frame["seq"].as_u64().unwrap(),
            (i + 1) as u64,
            "seq monotonic"
        );
        let value = open_frame(
            &browser_secret,
            &desktop_public,
            frame["envelope"].as_str().unwrap(),
        );
        if i < 3 {
            assert_eq!(value["kind"], "delta");
            if let Some(content) = value["delta"]["choices"][0]["delta"]["content"].as_str() {
                text.push_str(content);
            }
        } else {
            assert_eq!(value["kind"], "final");
        }
    }
    assert_eq!(text, "Hello");

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "done");
    assert_eq!(tunnel.sessions.thread_count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

// ── failure paths complete with typed codes ────────────────────────────────

#[tokio::test]
async fn invalid_envelope_and_unknown_model_fail_closed() {
    let dir = temp_dir("e2e-failures");
    let provider_base = spawn_provider(false).await;
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD3);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB3);

    // 1. A tampered envelope (sealed to a DIFFERENT desktop key).
    let other_desktop_pub = identity(0x99).public_key_bytes();
    let chat_body = json!({ "v": 1, "messages": [{ "role": "user", "content": "hi" }] });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-bad-env",
        "kind": "chat",
        "providerId": "prov-a",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &other_desktop_pub, &chat_body),
    }));
    // 2. An unknown model (fail-closed, never substituted).
    let bad_model = json!({
        "v": 1,
        "model": "model-zzz",
        "messages": [{ "role": "user", "content": "hi" }]
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-bad-model",
        "kind": "chat",
        "providerId": "prov-a",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &bad_model),
    }));

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_for(registry, dir.clone(), desktop);
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none());

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 2);
    let status_of = |id: &str| {
        completions
            .iter()
            .find(|c| c["requestId"] == id)
            .map(|c| c["status"].as_str().unwrap().to_string())
            .unwrap()
    };
    assert_eq!(status_of("req-bad-env"), "failed");
    assert_eq!(status_of("req-bad-model"), "failed");

    // Each failure left ONE sealed error frame the browser can open.
    let frames = backend.frames.lock().unwrap().clone();
    let error_for = |id: &str| {
        let frame = frames
            .iter()
            .find(|f| f["requestId"] == id)
            .unwrap_or_else(|| panic!("no error frame for {id}"));
        open_frame(
            &browser_secret,
            &desktop_public,
            frame["envelope"].as_str().unwrap(),
        )
    };
    let bad_env = error_for("req-bad-env");
    assert_eq!(bad_env["kind"], "error");
    assert_eq!(bad_env["code"], "sealed_envelope_invalid");
    let bad_model = error_for("req-bad-model");
    assert_eq!(bad_model["kind"], "error");
    assert_eq!(bad_model["code"], "model_unavailable");
    assert_eq!(tunnel.sessions.thread_count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

// ── misc pure helpers ──────────────────────────────────────────────────────

#[test]
fn sse_event_boundaries_and_trimming() {
    assert_eq!(find_sse_event_end(b"a\n\nrest"), Some(3));
    assert_eq!(find_sse_event_end(b"a\r\n\r\nrest"), Some(5));
    assert_eq!(find_sse_event_end(b"partial\n"), None);
    assert_eq!(trim_ascii(b"  data: x\r"), b"data: x");
}

#[test]
fn catalog_ids_from_openai_shape() {
    let v = json!({ "data": [{ "id": "a" }, { "id": "b" }, { "noId": true }] });
    assert_eq!(catalog_ids(&v).unwrap(), vec!["a", "b"]);
    assert!(catalog_ids(&json!({})).is_none());
}

// ── Wave-2 fix: kind=models seals a normalized ARRAY of {id, name?} ────────

#[tokio::test]
async fn models_frame_is_a_normalized_array_for_openai_list() {
    let dir = temp_dir("models-openai");
    let provider_base = spawn_provider(false).await;
    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_for(registry, dir.clone(), identity(0xD4));

    let profile = tunnel.providers.lock().unwrap().get("prov-a").unwrap();
    let body = tunnel
        .run_models(&ResolvedProvider::Registry(profile))
        .await
        .unwrap();
    let frame: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(frame["v"], 1);
    assert_eq!(frame["type"], "models");
    // The web client's fetchModelCatalog requires Array.isArray(frame.models)
    // with OBJECT entries — the raw {object:'list', data:[…]} body never fit.
    let models = frame["models"].as_array().expect("models must be an array");
    assert_eq!(models, &vec![json!({ "id": "model-a" })]);

    let _ = std::fs::remove_dir_all(dir);
}

// ── codex thread mapping + dead-rollout fallback (the "no rollout found"
// live bug: the browser's chat-thread id must NEVER reach codex as a
// rollout/thread id, and a dead rollout must fall back to a fresh thread) ──

#[tokio::test]
async fn browser_thread_ids_never_resolve_to_codex_threads() {
    let dir = temp_dir("codex-threads");
    let registry: ProviderRegistryHandle = Arc::new(Mutex::new(ProviderRegistry::load(&dir)));
    let tunnel = tunnel_for(registry, dir.clone(), identity(0xD9));

    // The live bug's exact shape: a chatStore-minted browser thread id. With
    // no in-process mapping the lookup is None — run_chat then starts a FRESH
    // codex thread; the browser id itself is never sent as a rollout id.
    let browser_id = "075a87be-9c5d-49f4-8c93-4464bfc29b28";
    assert_eq!(tunnel.codex_thread_for(browser_id), None);

    // Only a remembered codex-side id ever comes back — never an echo of the
    // browser key.
    tunnel.remember_codex_thread(browser_id, "codex-thread-1");
    assert_eq!(
        tunnel.codex_thread_for(browser_id),
        Some("codex-thread-1".to_string())
    );
    // A dead rollout's mapping is dropped, after which the lane is back on
    // the fresh-thread path.
    tunnel.forget_codex_thread(browser_id);
    assert_eq!(tunnel.codex_thread_for(browser_id), None);

    // The mapping is bounded FIFO — old entries evict, recent ones survive
    // (eviction only costs a fresh thread with re-rendered history).
    for i in 0..300 {
        tunnel.remember_codex_thread(&format!("browser-{i}"), &format!("codex-{i}"));
    }
    assert_eq!(tunnel.codex_thread_for("browser-0"), None);
    assert_eq!(
        tunnel.codex_thread_for("browser-299"),
        Some("codex-299".to_string())
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn dead_rollout_error_class_is_narrow() {
    // The fallback fires ONLY for the dead-thread/rollout class…
    assert!(is_dead_codex_thread_message(
        "no rollout found for thread id 075a87be-9c5d-49f4-8c93-4464bfc29b28"
    ));
    assert!(is_dead_codex_thread_message("Rollout not found"));
    assert!(is_dead_codex_thread_message("unknown thread"));
    assert!(is_dead_codex_thread_message("thread abc123 not found"));
    // …and never blanket-retries real failures.
    assert!(!is_dead_codex_thread_message(
        "Another Codex turn is already running. Wait for it to finish and try again."
    ));
    assert!(!is_dead_codex_thread_message("Codex rejected the request."));
    assert!(!is_dead_codex_thread_message(
        "Codex App Server did not respond in time."
    ));
    assert!(!is_dead_codex_thread_message("network error: connection refused"));
}

#[test]
fn fresh_codex_prompt_carries_history_only_when_present() {
    // A single-message turn keeps the bare pre-existing prompt shape.
    let single = vec![json!({ "role": "user", "content": "hi" })];
    assert_eq!(codex_plain_prompt(&single), "hi");
    // A multi-turn conversation is rendered in full — the fresh thread gets
    // the complete history the browser sent (continuity without the rollout).
    let multi = vec![
        json!({ "role": "user", "content": "first question" }),
        json!({ "role": "assistant", "content": "first answer" }),
        json!({ "role": "user", "content": "follow-up" }),
    ];
    let prompt = codex_plain_prompt(&multi);
    assert!(prompt.contains("user: first question"));
    assert!(prompt.contains("assistant: first answer"));
    assert!(prompt.contains("user: follow-up"));
}

// ── kind=providers: the Settings dropdown catalog (providerId pinned 'all') ─

#[tokio::test]
async fn providers_request_seals_the_gateway_catalog() {
    let dir = temp_dir("providers");
    let provider_base = spawn_provider(false).await;
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD5);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB4);

    let registry = registry_with_provider(&dir, &provider_base);
    // A second, disabled provider without a model: enumerated with
    // enabled:false (the web filters), model omitted, [] = unrestricted.
    {
        let profile = ProviderProfile {
            id: "prov-b".into(),
            name: "Provider B".into(),
            category: None,
            tags: vec![],
            protocol: crate::ai::providers::Protocol::OpenAi,
            base_url: provider_base.clone(),
            model: None,
            capabilities: vec![],
            headers: vec![],
            secret_ref: None,
            specs: Default::default(),
            allow_local: true,
            enabled: false,
        };
        registry.lock().unwrap().upsert(profile).unwrap();
    }

    // providerId is the pinned placeholder 'all' — never resolved as a real
    // provider for this kind (a real resolve would refuse it as unknown).
    let body = json!({ "v": 1, "clientSeq": 1 });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-providers",
        "kind": "providers",
        "providerId": "all",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &body),
    }));

    // Chat-capable services are listed FIRST (regardless of run state — the
    // stopped one still appears); non-chat services never appear.
    let services: Arc<dyn TunnelServiceDirectory> = Arc::new(FakeServices(vec![
        FakeService { id: "llama-cpp", name: "Llama.cpp Server", chat: true, running: true, port: 8080 },
        FakeService { id: "ollama", name: "Ollama", chat: true, running: false, port: 11434 },
        FakeService { id: "aokie-tts", name: "Aokie TTS", chat: false, running: true, port: 17922 },
    ]));
    let tunnel = tunnel_with_services(registry, dir.clone(), desktop, Some(services));
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "done");

    // One sealed final frame carrying the pinned row shape. The test agent's
    // Codex account is not connected, so no managed Codex row appears.
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1);
    let frame = open_frame(
        &browser_secret,
        &desktop_public,
        frames[0]["envelope"].as_str().unwrap(),
    );
    assert_eq!(
        frame,
        json!({
            "v": 1,
            "type": "providers",
            "providers": [
                {
                    "id": "service:llama-cpp",
                    "label": "Llama.cpp Server",
                    "capabilities": ["chat"],
                    "enabled": true
                },
                {
                    "id": "service:ollama",
                    "label": "Ollama",
                    "capabilities": ["chat"],
                    "enabled": true
                },
                {
                    "id": "prov-a",
                    "label": "Provider A",
                    "capabilities": ["chat"],
                    "enabled": true,
                    "model": "model-a"
                },
                {
                    "id": "prov-b",
                    "label": "Provider B",
                    "capabilities": [],
                    "enabled": false
                }
            ]
        })
    );
    assert_eq!(tunnel.sessions.thread_count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

// ── service:<id> chat + models resolution (the local-service lane) ─────────

#[tokio::test]
async fn service_chat_round_trips_via_loopback() {
    let dir = temp_dir("service-chat");
    let provider_base = spawn_provider(false).await;
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD6);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB5);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "hello?" }],
        "clientSeq": 1,
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-svc-chat",
        "kind": "chat",
        "providerId": "service:llama-cpp",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    // An empty provider registry: the request rides ONLY the service surface.
    let registry: ProviderRegistryHandle =
        Arc::new(Mutex::new(ProviderRegistry::load(&dir)));
    let services: Arc<dyn TunnelServiceDirectory> = Arc::new(FakeServices(vec![FakeService {
        id: "llama-cpp",
        name: "Llama.cpp Server",
        chat: true,
        running: true,
        port: stub_port(&provider_base),
    }]));
    let tunnel = tunnel_with_services(registry, dir.clone(), desktop, Some(services));
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "done");
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1);
    let final_body = open_frame(
        &browser_secret,
        &desktop_public,
        frames[0]["envelope"].as_str().unwrap(),
    );
    assert_eq!(final_body["kind"], "final");
    assert_eq!(
        final_body["completion"]["choices"][0]["message"]["content"],
        "stub answer"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn service_models_kind_lists_the_service_catalog() {
    let dir = temp_dir("service-models");
    let provider_base = spawn_provider(false).await;
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD7);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB6);

    let body = json!({ "v": 1, "clientSeq": 1 });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-svc-models",
        "kind": "models",
        "providerId": "service:llama-cpp",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &body),
    }));

    let registry: ProviderRegistryHandle =
        Arc::new(Mutex::new(ProviderRegistry::load(&dir)));
    let services: Arc<dyn TunnelServiceDirectory> = Arc::new(FakeServices(vec![FakeService {
        id: "llama-cpp",
        name: "Llama.cpp Server",
        chat: true,
        running: true,
        port: stub_port(&provider_base),
    }]));
    let tunnel = tunnel_with_services(registry, dir.clone(), desktop, Some(services));
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1);
    let frame = open_frame(
        &browser_secret,
        &desktop_public,
        frames[0]["envelope"].as_str().unwrap(),
    );
    assert_eq!(
        frame,
        json!({ "v": 1, "type": "models", "models": [{ "id": "model-a" }] })
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn stopped_unknown_and_non_chat_services_refuse_typed() {
    let dir = temp_dir("service-refusals");
    let backend = StubBackend::default();
    let backend_base = spawn_backend(backend.clone()).await;
    let desktop = identity(0xD8);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB7);

    let chat_body = json!({ "v": 1, "messages": [{ "role": "user", "content": "hi" }] });
    for (req_id, provider_id) in [
        ("req-svc-stopped", "service:llama-cpp"),
        ("req-svc-unknown", "service:no-such-service"),
        ("req-svc-nochat", "service:aokie-tts"),
    ] {
        backend.pending.lock().unwrap().push(json!({
            "id": req_id,
            "kind": "chat",
            "providerId": provider_id,
            "ephPub": B64.encode(browser_public),
            "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
        }));
    }

    let registry: ProviderRegistryHandle =
        Arc::new(Mutex::new(ProviderRegistry::load(&dir)));
    let services: Arc<dyn TunnelServiceDirectory> = Arc::new(FakeServices(vec![
        FakeService { id: "llama-cpp", name: "Llama.cpp Server", chat: true, running: false, port: 8080 },
        FakeService { id: "aokie-tts", name: "Aokie TTS", chat: false, running: true, port: 17922 },
    ]));
    let tunnel = tunnel_with_services(registry, dir.clone(), desktop, Some(services));
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 3);
    for completion in &completions {
        assert_eq!(completion["status"], "failed", "completion: {completion}");
    }
    let frames = backend.frames.lock().unwrap().clone();
    let error_for = |id: &str| {
        let frame = frames
            .iter()
            .find(|f| f["requestId"] == id)
            .unwrap_or_else(|| panic!("no error frame for {id}"));
        open_frame(
            &browser_secret,
            &desktop_public,
            frame["envelope"].as_str().unwrap(),
        )
    };
    // Stopped: typed + actionable — names the service and where to start it,
    // and it is NEVER auto-started from this lane.
    let stopped = error_for("req-svc-stopped");
    assert_eq!(stopped["code"], "provider_unavailable");
    let message = stopped["message"].as_str().unwrap();
    assert!(message.contains("Llama.cpp Server"), "{message}");
    assert!(message.contains("Desktop Connection"), "{message}");
    // Unknown: the existing unknown-provider refusal.
    let unknown = error_for("req-svc-unknown");
    assert_eq!(unknown["code"], "provider_unavailable");
    assert!(unknown["message"]
        .as_str()
        .unwrap()
        .contains("unknown provider"));
    // Non-chat-capable: fail closed.
    let nochat = error_for("req-svc-nochat");
    assert_eq!(nochat["code"], "provider_unavailable");
    assert!(nochat["message"].as_str().unwrap().contains("does not serve chat"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn normalize_models_catalog_handles_openai_and_codex_shapes() {
    // OpenAI list shape.
    let openai = json!({
        "object": "list",
        "data": [
            { "id": "a", "object": "model" },
            { "id": "b", "object": "model", "name": "B model" },
            { "noId": true }
        ]
    });
    assert_eq!(
        normalize_models_catalog(&openai),
        vec![json!({ "id": "a" }), json!({ "id": "b", "name": "B model" })]
    );
    // Managed Codex shape ({models:[{id, model, displayName, …}]}).
    let codex = json!({
        "models": [
            { "id": "gpt-x", "model": "gpt-x", "displayName": "GPT X", "isDefault": true },
            { "id": "gpt-y", "model": "gpt-y", "display_name": "snake also ok" }
        ]
    });
    assert_eq!(
        normalize_models_catalog(&codex),
        vec![
            json!({ "id": "gpt-x", "name": "GPT X" }),
            json!({ "id": "gpt-y", "name": "snake also ok" })
        ]
    );
    // A bare array works too; non-catalog shapes normalize to empty.
    assert_eq!(
        normalize_models_catalog(&json!([{ "id": "c" }])),
        vec![json!({ "id": "c" })]
    );
    assert!(normalize_models_catalog(&json!({})).is_empty());
    assert!(normalize_models_catalog(&json!({ "data": { "not": "array" } })).is_empty());
}
