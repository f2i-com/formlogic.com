//! Tests for the Phase-6 E2E chat tool loop: the pinned frame shapes, the
//! 6-round bound, confirm-mode approve/deny/timeout, terminal grant failures,
//! and the compatibility invariant (a grant-less request takes the legacy
//! streaming path frame-for-frame). Mocking style mirrors
//! `relay_poller/tests.rs`: axum stubs for the backend relay + chat-tools
//! routes and an OpenAI-shaped provider that answers with tool calls.

use super::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::ai::e2e::{
    open_detached_envelope, seal_detached_envelope, E2eIdentity, E2eSessions,
    DIR_BROWSER_TO_DESKTOP,
};
use crate::ai::providers::{Capability, ProviderRegistry, ProviderRegistryHandle};
use crate::formlogic_client::{FormLogicClient, FormLogicConfig};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::Json as AxumJson;
use axum::routing::{get, post};
use axum::Router;
use base64::Engine as _;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "formlogic-chat-agent-{tag}-{}",
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
        protocol: Protocol::OpenAi,
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

/// A `Protocol::Custom` provider (path-only chat spec — OpenAI-shaped wire at
/// a custom path, responses text-extracted by the gateway). NOT tool-capable
/// natively, so a grant routes it onto the Prompted transport.
fn registry_with_custom_provider(
    data_dir: &std::path::Path,
    base_url: &str,
) -> ProviderRegistryHandle {
    let handle: ProviderRegistryHandle = Arc::new(Mutex::new(ProviderRegistry::load(data_dir)));
    let mut specs = HashMap::new();
    specs.insert(
        "chat".to_string(),
        crate::ai::providers::CapabilitySpec {
            path: Some("/v1/chat/completions".into()),
            ..Default::default()
        },
    );
    let profile = ProviderProfile {
        id: "prov-custom".into(),
        name: "Custom provider".into(),
        category: None,
        tags: vec![],
        protocol: Protocol::Custom,
        base_url: base_url.into(),
        model: Some("model-c".into()),
        capabilities: vec![Capability::Chat],
        headers: vec![],
        secret_ref: None,
        specs,
        allow_local: true,
        enabled: true,
    };
    handle.lock().unwrap().upsert(profile).unwrap();
    handle
}

fn tunnel_with_timing(
    providers: ProviderRegistryHandle,
    data_dir: PathBuf,
    identity: E2eIdentity,
    timing: ConfirmTiming,
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
        confirm_timing: timing,
        services: None,
        codex_threads: Mutex::new(crate::ai::relay_poller::CodexThreadMap::default()),
    })
}

fn client_for(base: &str) -> FormLogicClient {
    FormLogicClient::new(&FormLogicConfig {
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
        crate::ai::e2e::DIR_DESKTOP_TO_BROWSER,
        envelope,
    )
    .unwrap();
    serde_json::from_slice(&opened).unwrap()
}

// ── stub backend: desktop-ai relay + input channel + chat-tools routes ─────

#[derive(Clone, Default)]
struct ToolBackend {
    pending: Arc<Mutex<Vec<Value>>>,
    claimed: Arc<Mutex<Vec<String>>>,
    frames: Arc<Mutex<Vec<Value>>>,
    completions: Arc<Mutex<Vec<Value>>>,
    catalog_hits: Arc<Mutex<usize>>,
    catalog_body: Arc<Mutex<Value>>,
    executes: Arc<Mutex<Vec<Value>>>,
    execute_status: Arc<Mutex<u16>>,
    execute_body: Arc<Mutex<Value>>,
    /// Sealed IN rows `{seq, envelope}` served by the input route.
    input_rows: Arc<Mutex<Vec<Value>>>,
}

/// A backend with a one-tool catalog and a successful execute by default.
fn tool_backend() -> ToolBackend {
    let st = ToolBackend::default();
    *st.catalog_body.lock().unwrap() = json!({
        "tools": [{
            "name": "create_form",
            "description": "Create a form",
            "inputSchema": {
                "type": "object",
                "properties": { "title": { "type": "string" } }
            }
        }]
    });
    *st.execute_status.lock().unwrap() = 200;
    *st.execute_body.lock().unwrap() = json!({ "data": { "formId": "f-123", "title": "Contact" } });
    st
}

async fn tb_pending(State(st): State<ToolBackend>) -> AxumJson<Value> {
    let rows = st.pending.lock().unwrap().clone();
    AxumJson(json!({ "requests": rows }))
}

async fn tb_claim(
    State(st): State<ToolBackend>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, AxumJson<Value>) {
    let mut claimed = st.claimed.lock().unwrap();
    if claimed.iter().any(|c| c == &id) {
        return (
            StatusCode::CONFLICT,
            AxumJson(json!({ "message": "already claimed" })),
        );
    }
    claimed.push(id);
    (StatusCode::OK, AxumJson(json!({ "status": "claimed" })))
}

async fn tb_frame(
    State(st): State<ToolBackend>,
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

async fn tb_complete(
    State(st): State<ToolBackend>,
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

async fn tb_pubkey(
    State(_st): State<ToolBackend>,
    AxumJson(_body): AxumJson<Value>,
) -> AxumJson<Value> {
    AxumJson(json!({ "status": "ok" }))
}

async fn tb_input(
    State(st): State<ToolBackend>,
    AxumPath(_id): AxumPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> AxumJson<Value> {
    let since: u64 = q
        .get("since")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let rows: Vec<Value> = st
        .input_rows
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.get("seq").and_then(Value::as_u64).unwrap_or(0) > since)
        .cloned()
        .collect();
    AxumJson(json!({ "frames": rows, "status": "claimed" }))
}

async fn tb_catalog(State(st): State<ToolBackend>) -> AxumJson<Value> {
    *st.catalog_hits.lock().unwrap() += 1;
    AxumJson(st.catalog_body.lock().unwrap().clone())
}

async fn tb_execute(
    State(st): State<ToolBackend>,
    AxumJson(body): AxumJson<Value>,
) -> (StatusCode, AxumJson<Value>) {
    st.executes.lock().unwrap().push(body);
    let status = StatusCode::from_u16(*st.execute_status.lock().unwrap())
        .unwrap_or(StatusCode::OK);
    (status, AxumJson(st.execute_body.lock().unwrap().clone()))
}

async fn spawn_tool_backend(st: ToolBackend) -> String {
    let app = Router::new()
        .route("/api/v1/desktop-ai/pending", get(tb_pending))
        .route("/api/v1/desktop-ai/:id/claim", post(tb_claim))
        .route("/api/v1/desktop-ai/:id/frames", post(tb_frame))
        .route("/api/v1/desktop-ai/:id/complete", post(tb_complete))
        .route("/api/v1/desktop-ai/:id/input", get(tb_input))
        .route("/api/v1/desktop-ai/pubkey", post(tb_pubkey))
        .route("/api/ai/chat-tools/catalog", get(tb_catalog))
        .route("/api/ai/chat-tools/execute", post(tb_execute))
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

// ── stub provider (OpenAI /v1 dialect; native function calling AND the
// Prompted fenced-block convention) ────────────────────────────────────────

/// The exact fenced reply a Prompted model emits to call `create_form`.
const FENCED_CALL: &str =
    "```tool_call\n{\"tool\":\"create_form\",\"input\":{\"title\":\"Contact\"}}\n```";

#[derive(Clone)]
struct ToolProvider {
    chats: Arc<Mutex<Vec<Value>>>,
    /// `true`: answer with a tool call WHENEVER tools are offered (native
    /// `tools` attached, or the Prompted preamble present) — the rounds-cap
    /// shape. `false`: request one tool call, then answer text once a tool
    /// reply/result is in the conversation.
    always_call: bool,
    /// When set, ALWAYS reply with exactly this text (malformed/unknown-block
    /// scenarios).
    reply_override: Arc<Mutex<Option<String>>>,
}

fn tool_provider(always_call: bool) -> ToolProvider {
    ToolProvider {
        chats: Arc::new(Mutex::new(Vec::new())),
        always_call,
        reply_override: Arc::new(Mutex::new(None)),
    }
}

async fn tp_models() -> AxumJson<Value> {
    AxumJson(json!({
        "object": "list",
        "data": [{ "id": "model-a", "object": "model" }],
    }))
}

async fn tp_chat(
    State(st): State<ToolProvider>,
    AxumJson(body): AxumJson<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let n = {
        let mut chats = st.chats.lock().unwrap();
        chats.push(body.clone());
        chats.len()
    };
    // The legacy no-grant path streams; the tool loop never sets `stream`.
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
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
    let text_reply = |content: &str| {
        AxumJson(json!({
            "id": format!("chatcmpl-{n}"),
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": content },
                "finish_reason": "stop"
            }]
        }))
        .into_response()
    };
    if let Some(text) = st.reply_override.lock().unwrap().clone() {
        return text_reply(&text);
    }
    // Native transport: the request attaches OpenAI function-calling `tools`.
    let has_tools = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    let has_tool_reply = body
        .get("messages")
        .and_then(Value::as_array)
        .map(|ms| ms.iter().any(|m| m.get("role") == Some(&json!("tool"))))
        .unwrap_or(false);
    if has_tools && (st.always_call || !has_tool_reply) {
        return AxumJson(json!({
            "id": format!("chatcmpl-{n}"),
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": Value::Null,
                    "tool_calls": [{
                        "id": format!("call-{n}"),
                        "type": "function",
                        "function": {
                            "name": "create_form",
                            "arguments": "{\"title\":\"Contact\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }))
        .into_response();
    }
    // Prompted transport: the request leads with the harness preamble (system
    // message teaching the ```tool_call convention) and results come back as
    // "tool_result …" text messages.
    let has_preamble = body.pointer("/messages/0/role").and_then(Value::as_str) == Some("system")
        && body
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .is_some_and(|c| c.contains("```tool_call"));
    let has_tool_result = body
        .get("messages")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter().any(|m| {
                m.get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.starts_with("tool_result"))
            })
        })
        .unwrap_or(false);
    if has_preamble && (st.always_call || !has_tool_result) {
        return text_reply(FENCED_CALL);
    }
    text_reply("All done.")
}

async fn spawn_tool_provider(p: ToolProvider) -> String {
    let app = Router::new()
        .route("/v1/models", get(tp_models))
        .route("/v1/chat/completions", post(tp_chat))
        .with_state(p);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

/// Short confirm timing so tests never sleep real minutes.
fn fast_timing() -> ConfirmTiming {
    ConfirmTiming {
        deadline: Duration::from_secs(5),
        poll_interval: Duration::from_millis(50),
    }
}

fn seed_request(
    backend: &ToolBackend,
    id: &str,
    browser_secret: &[u8; 32],
    desktop_public: &[u8; 32],
    body: &Value,
    browser_public: &[u8; 32],
) {
    backend.pending.lock().unwrap().push(json!({
        "id": id,
        "kind": "chat",
        "providerId": "prov-a",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(browser_secret, desktop_public, body),
    }));
}

// ── auto mode: execute + pinned frame shapes + conversation feed-back ──────

#[tokio::test]
async fn tool_loop_executes_seals_activity_and_completes() {
    let dir = temp_dir("auto");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE1);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB5);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolMode": "auto",
        "toolGrant": "grant-abc",
    });
    seed_request(&backend, "req-auto", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["status"], "done");
    assert_eq!(*backend.catalog_hits.lock().unwrap(), 1);

    // Exactly one execute, carrying the grant + parsed arguments.
    let executes = backend.executes.lock().unwrap().clone();
    assert_eq!(executes.len(), 1);
    assert_eq!(executes[0]["grantToken"], "grant-abc");
    assert_eq!(executes[0]["tool"], "create_form");
    assert_eq!(executes[0]["input"], json!({ "title": "Contact" }));

    // Frames: running → done result → final, with the PINNED shapes.
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 3);
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    assert_eq!(
        opened[0],
        json!({ "type": "tool_call", "id": "call-1", "name": "create_form", "status": "running" })
    );
    assert_eq!(
        opened[1],
        json!({
            "type": "tool_result",
            "id": "call-1",
            "name": "create_form",
            "status": "done",
            "result": { "formId": "f-123", "title": "Contact" }
        })
    );
    assert_eq!(opened[2]["kind"], "final");
    assert_eq!(
        opened[2]["completion"]["choices"][0]["message"]["content"],
        "All done."
    );

    // Round 2 carried the assistant tool_calls turn + its role:"tool" reply,
    // and re-attached the tools (the grant is still live).
    let chats = provider.chats.lock().unwrap().clone();
    assert_eq!(chats.len(), 2);
    assert_eq!(chats[0]["tools"].as_array().map(Vec::len), Some(1));
    assert_eq!(chats[0]["tools"][0]["function"]["name"], "create_form");
    assert!(chats[1].get("tools").is_some());
    let msgs = chats[1]["messages"].as_array().unwrap().clone();
    assert_eq!(msgs[msgs.len() - 2]["tool_calls"][0]["id"], "call-1");
    assert_eq!(msgs[msgs.len() - 1]["role"], "tool");
    assert_eq!(msgs[msgs.len() - 1]["tool_call_id"], "call-1");
    assert!(msgs[msgs.len() - 1]["content"]
        .as_str()
        .unwrap()
        .contains("f-123"));

    assert_eq!(tunnel.sessions.thread_count(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

// ── the ≤ 6 round bound ────────────────────────────────────────────────────

#[tokio::test]
async fn rounds_cap_is_enforced_at_six() {
    let dir = temp_dir("rounds");
    let provider = tool_provider(true); // never stops asking for tools
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE2);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB6);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "loop forever" }],
        "toolGrant": "grant-abc",
    });
    seed_request(&backend, "req-rounds", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // Exactly 6 provider rounds; rounds 1–5 attach tools, the final round
    // never does (forcing the text answer that closes the turn).
    let chats = provider.chats.lock().unwrap().clone();
    assert_eq!(chats.len(), MAX_TOOL_ROUNDS);
    for chat in &chats[..MAX_TOOL_ROUNDS - 1] {
        assert!(chat.get("tools").is_some(), "tool rounds attach the catalog");
    }
    assert!(
        chats[MAX_TOOL_ROUNDS - 1].get("tools").is_none(),
        "the final round must not attach tools"
    );
    assert_eq!(backend.executes.lock().unwrap().len(), MAX_TOOL_ROUNDS - 1);

    let completions = backend.completions.lock().unwrap().clone();
    assert_eq!(completions[0]["status"], "done");
    let frames = backend.frames.lock().unwrap().clone();
    // (running + result) per executed round, then the final body.
    assert_eq!(frames.len(), (MAX_TOOL_ROUNDS - 1) * 2 + 1);
    let last = open_frame(
        &browser_secret,
        &desktop_public,
        frames.last().unwrap()["envelope"].as_str().unwrap(),
    );
    assert_eq!(last["kind"], "final");
    assert_eq!(
        last["completion"]["choices"][0]["message"]["content"],
        "All done."
    );
    let _ = std::fs::remove_dir_all(dir);
}

// ── confirm mode: approve executes ─────────────────────────────────────────

#[tokio::test]
async fn confirm_mode_approval_executes_the_tool() {
    let dir = temp_dir("confirm-approve");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE3);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB7);

    // Pre-seed the approval on the sealed IN channel: counter 1 continues
    // after the request envelope's counter 0 (the e2e replay rule).
    let approval = json!({ "v": 1, "type": "tool_approval", "callId": "call-1", "approved": true });
    backend.input_rows.lock().unwrap().push(json!({
        "seq": 1,
        "envelope": seal_detached_envelope(
            &browser_secret,
            &desktop_public,
            DIR_BROWSER_TO_DESKTOP,
            1,
            approval.to_string().as_bytes(),
        )
        .unwrap(),
    }));

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolMode": "confirm",
        "toolGrant": "grant-abc",
    });
    seed_request(&backend, "req-confirm", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, fast_timing());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    assert_eq!(backend.executes.lock().unwrap().len(), 1);
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 4);
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    // The PINNED proposal shape (requestId = the relay request id).
    assert_eq!(
        opened[0],
        json!({
            "type": "tool_proposal",
            "callId": "call-1",
            "requestId": "req-confirm",
            "tool": "create_form",
            "input": { "title": "Contact" }
        })
    );
    assert_eq!(
        opened[1],
        json!({ "type": "tool_call", "id": "call-1", "name": "create_form", "status": "running" })
    );
    assert_eq!(opened[2]["type"], "tool_result");
    assert_eq!(opened[2]["status"], "done");
    assert_eq!(opened[3]["kind"], "final");
    assert_eq!(
        backend.completions.lock().unwrap()[0]["status"],
        "done"
    );
    let _ = std::fs::remove_dir_all(dir);
}

// ── confirm mode: deny feeds an honest refusal, request still succeeds ─────

#[tokio::test]
async fn confirm_mode_denial_feeds_refusal_and_model_continues() {
    let dir = temp_dir("confirm-deny");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE4);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB8);

    let denial = json!({ "v": 1, "type": "tool_approval", "callId": "call-1", "approved": false });
    backend.input_rows.lock().unwrap().push(json!({
        "seq": 1,
        "envelope": seal_detached_envelope(
            &browser_secret,
            &desktop_public,
            DIR_BROWSER_TO_DESKTOP,
            1,
            denial.to_string().as_bytes(),
        )
        .unwrap(),
    }));

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolMode": "confirm",
        "toolGrant": "grant-abc",
    });
    seed_request(&backend, "req-deny", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, fast_timing());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // Denied → never executed; the request itself still completes done.
    assert!(backend.executes.lock().unwrap().is_empty());
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");

    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 3);
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    assert_eq!(opened[0]["type"], "tool_proposal");
    assert_eq!(
        opened[1],
        json!({
            "type": "tool_result",
            "id": "call-1",
            "name": "create_form",
            "status": "failed",
            "error": "denied by user"
        })
    );
    assert_eq!(opened[2]["kind"], "final");

    // The model saw the honest refusal and produced the final answer.
    let chats = provider.chats.lock().unwrap().clone();
    assert_eq!(chats.len(), 2);
    let msgs = chats[1]["messages"].as_array().unwrap().clone();
    let tool_msg = &msgs[msgs.len() - 1];
    assert_eq!(tool_msg["role"], "tool");
    assert!(tool_msg["content"].as_str().unwrap().contains("denied by user"));
    let _ = std::fs::remove_dir_all(dir);
}

// ── confirm mode: no answer → auto-deny at the (injected) deadline ─────────

#[tokio::test]
async fn confirm_mode_times_out_into_auto_deny() {
    let dir = temp_dir("confirm-timeout");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend(); // no input rows: nobody ever answers
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE5);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xB9);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolMode": "confirm",
        "toolGrant": "grant-abc",
    });
    seed_request(&backend, "req-timeout", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let timing = ConfirmTiming {
        deadline: Duration::from_millis(200),
        poll_interval: Duration::from_millis(50),
    };
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, timing);
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    assert!(backend.executes.lock().unwrap().is_empty());
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let frames = backend.frames.lock().unwrap().clone();
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    assert_eq!(opened[0]["type"], "tool_proposal");
    assert_eq!(
        opened[1],
        json!({
            "type": "tool_result",
            "id": "call-1",
            "name": "create_form",
            "status": "failed",
            "error": "approval timed out"
        })
    );
    assert_eq!(opened.last().unwrap()["kind"], "final");
    let _ = std::fs::remove_dir_all(dir);
}

// ── terminal grant failure: no retry, no loop, honest final answer ─────────

#[tokio::test]
async fn grant_expiry_is_terminal_for_tool_use() {
    let dir = temp_dir("grant-expired");
    let provider = tool_provider(true); // would loop forever if allowed
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    *backend.execute_status.lock().unwrap() = 403;
    *backend.execute_body.lock().unwrap() =
        json!({ "code": "grant_expired", "message": "the tool grant has expired" });
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE6);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xBA);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolGrant": "grant-stale",
    });
    seed_request(&backend, "req-grant", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // ONE execute — the refusal is never retried; the very next round runs
    // without tools and the model answers in text.
    assert_eq!(backend.executes.lock().unwrap().len(), 1);
    let chats = provider.chats.lock().unwrap().clone();
    assert_eq!(chats.len(), 2);
    assert!(chats[0].get("tools").is_some());
    assert!(
        chats[1].get("tools").is_none(),
        "a dead grant must stop attaching tools"
    );
    let msgs = chats[1]["messages"].as_array().unwrap().clone();
    assert!(msgs[msgs.len() - 1]["content"]
        .as_str()
        .unwrap()
        .contains("grant_expired"));

    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 3);
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    assert_eq!(opened[0]["type"], "tool_call");
    assert_eq!(opened[1]["type"], "tool_result");
    assert_eq!(opened[1]["status"], "failed");
    assert!(opened[1]["error"]
        .as_str()
        .unwrap()
        .starts_with("grant_expired"));
    assert_eq!(opened[2]["kind"], "final");
    let _ = std::fs::remove_dir_all(dir);
}

// ── compatibility invariant: no grant → the legacy path, frame-for-frame ───

#[tokio::test]
async fn without_a_grant_the_legacy_streaming_path_is_untouched() {
    let dir = temp_dir("legacy");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE7);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xBB);

    // toolMode alone (no toolGrant) must change NOTHING.
    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "stream please" }],
        "toolMode": "confirm",
    });
    seed_request(&backend, "req-legacy", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // The tool machinery never woke up.
    assert_eq!(*backend.catalog_hits.lock().unwrap(), 0);
    assert!(backend.executes.lock().unwrap().is_empty());

    // Frame-for-frame the Wave-1 streaming shape: 3 sealed deltas + final.
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 4);
    let mut text = String::new();
    for (i, frame) in frames.iter().enumerate() {
        assert_eq!(frame["seq"].as_u64().unwrap(), (i + 1) as u64);
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
            assert_eq!(value, json!({ "v": 1, "kind": "final" }));
        }
    }
    assert_eq!(text, "Hello");
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let _ = std::fs::remove_dir_all(dir);
}

// ── Prompted transport: harness round-trip over a non-tool-capable provider ─

#[tokio::test]
async fn prompted_round_trip_executes_and_finishes() {
    let dir = temp_dir("prompted-auto");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE8);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xBC);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolMode": "auto",
        "toolGrant": "grant-abc",
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-prompted",
        "kind": "chat",
        "providerId": "prov-custom",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    let registry = registry_with_custom_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");

    // The harness executed the fenced call exactly once, with the grant.
    let executes = backend.executes.lock().unwrap().clone();
    assert_eq!(executes.len(), 1);
    assert_eq!(executes[0]["grantToken"], "grant-abc");
    assert_eq!(executes[0]["tool"], "create_form");
    assert_eq!(executes[0]["input"], json!({ "title": "Contact" }));

    // The frames are byte-identical in SHAPE to the native transport — the
    // browser cannot tell which transport produced the call.
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 3);
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    assert_eq!(
        opened[0],
        json!({ "type": "tool_call", "id": "call-1", "name": "create_form", "status": "running" })
    );
    assert_eq!(
        opened[1],
        json!({
            "type": "tool_result",
            "id": "call-1",
            "name": "create_form",
            "status": "done",
            "result": { "formId": "f-123", "title": "Contact" }
        })
    );
    assert_eq!(opened[2]["kind"], "final");
    assert_eq!(
        opened[2]["completion"]["choices"][0]["message"]["content"],
        "All done."
    );

    // Round 1 carried the preamble (catalog + fence convention) as a system
    // message and NO native tools array; round 2 fed the result back as a
    // plain-text tool_result message after the assistant's fenced turn.
    let chats = provider.chats.lock().unwrap().clone();
    assert_eq!(chats.len(), 2);
    assert!(chats[0].get("tools").is_none(), "Prompted never attaches native tools");
    assert_eq!(chats[0]["messages"][0]["role"], "system");
    let preamble = chats[0]["messages"][0]["content"].as_str().unwrap();
    assert!(preamble.contains("```tool_call"));
    assert!(preamble.contains("- create_form: Create a form"));
    assert!(preamble.contains("input schema"));
    let msgs = chats[1]["messages"].as_array().unwrap().clone();
    assert_eq!(msgs[msgs.len() - 2]["role"], "assistant");
    assert_eq!(msgs[msgs.len() - 2]["content"], FENCED_CALL);
    assert_eq!(msgs[msgs.len() - 1]["role"], "user");
    assert!(msgs[msgs.len() - 1]["content"]
        .as_str()
        .unwrap()
        .starts_with("tool_result create_form: "));
    assert!(msgs[msgs.len() - 1]["content"]
        .as_str()
        .unwrap()
        .contains("f-123"));
    let _ = std::fs::remove_dir_all(dir);
}

// ── Prompted: an unknown-tool block is TEXT, never a guessed call ──────────

#[tokio::test]
async fn prompted_unknown_tool_block_passes_through_as_text() {
    let dir = temp_dir("prompted-unknown");
    let provider = tool_provider(false);
    *provider.reply_override.lock().unwrap() =
        Some("```tool_call\n{\"tool\":\"not_a_tool\",\"input\":{}}\n```".to_string());
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xE9);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xBD);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolGrant": "grant-abc",
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-unknown",
        "kind": "chat",
        "providerId": "prov-custom",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    let registry = registry_with_custom_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // Zero executes, zero activity frames — the block names no cataloged tool
    // so it is honestly the final text answer.
    assert!(backend.executes.lock().unwrap().is_empty());
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1, "only the final frame");
    let final_frame = open_frame(
        &browser_secret,
        &desktop_public,
        frames[0]["envelope"].as_str().unwrap(),
    );
    assert_eq!(final_frame["kind"], "final");
    assert_eq!(
        final_frame["completion"]["choices"][0]["message"]["content"],
        "```tool_call\n{\"tool\":\"not_a_tool\",\"input\":{}}\n```"
    );
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let _ = std::fs::remove_dir_all(dir);
}

// ── Prompted: the final allowed round swaps the preamble for the plain
// instruction (guaranteed termination) ─────────────────────────────────────

#[tokio::test]
async fn prompted_final_round_omits_preamble() {
    let dir = temp_dir("prompted-rounds");
    let provider = tool_provider(true); // fenced call whenever the preamble is offered
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xEA);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xBE);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "loop forever" }],
        "toolGrant": "grant-abc",
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-prompted-rounds",
        "kind": "chat",
        "providerId": "prov-custom",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    let registry = registry_with_custom_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    let chats = provider.chats.lock().unwrap().clone();
    assert_eq!(chats.len(), MAX_TOOL_ROUNDS);
    for chat in &chats[..MAX_TOOL_ROUNDS - 1] {
        let system = chat["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("```tool_call"), "tool rounds carry the preamble");
    }
    let last_system = chats[MAX_TOOL_ROUNDS - 1]["messages"][0]["content"]
        .as_str()
        .unwrap();
    assert!(
        !last_system.contains("```tool_call"),
        "the final round must not offer the fence convention"
    );
    assert!(last_system.contains("Tool calling is not available"));
    assert_eq!(backend.executes.lock().unwrap().len(), MAX_TOOL_ROUNDS - 1);
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), (MAX_TOOL_ROUNDS - 1) * 2 + 1);
    let last = open_frame(
        &browser_secret,
        &desktop_public,
        frames.last().unwrap()["envelope"].as_str().unwrap(),
    );
    assert_eq!(last["kind"], "final");
    assert_eq!(
        last["completion"]["choices"][0]["message"]["content"],
        "All done."
    );
    let _ = std::fs::remove_dir_all(dir);
}

// ── Prompted + confirm mode: identical proposal/approval machinery ─────────

#[tokio::test]
async fn prompted_confirm_mode_matches_native_frames() {
    let dir = temp_dir("prompted-confirm");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xEB);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xBF);

    let approval = json!({ "v": 1, "type": "tool_approval", "callId": "call-1", "approved": true });
    backend.input_rows.lock().unwrap().push(json!({
        "seq": 1,
        "envelope": seal_detached_envelope(
            &browser_secret,
            &desktop_public,
            DIR_BROWSER_TO_DESKTOP,
            1,
            approval.to_string().as_bytes(),
        )
        .unwrap(),
    }));

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "make me a contact form" }],
        "toolMode": "confirm",
        "toolGrant": "grant-abc",
    });
    backend.pending.lock().unwrap().push(json!({
        "id": "req-prompted-confirm",
        "kind": "chat",
        "providerId": "prov-custom",
        "ephPub": B64.encode(browser_public),
        "envelope": seal_request(&browser_secret, &desktop_public, &chat_body),
    }));

    let registry = registry_with_custom_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, fast_timing());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    assert_eq!(backend.executes.lock().unwrap().len(), 1);
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 4);
    let opened: Vec<Value> = frames
        .iter()
        .map(|f| open_frame(&browser_secret, &desktop_public, f["envelope"].as_str().unwrap()))
        .collect();
    assert_eq!(
        opened[0],
        json!({
            "type": "tool_proposal",
            "callId": "call-1",
            "requestId": "req-prompted-confirm",
            "tool": "create_form",
            "input": { "title": "Contact" }
        })
    );
    assert_eq!(
        opened[1],
        json!({ "type": "tool_call", "id": "call-1", "name": "create_form", "status": "running" })
    );
    assert_eq!(opened[2]["type"], "tool_result");
    assert_eq!(opened[2]["status"], "done");
    assert_eq!(opened[3]["kind"], "final");
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let _ = std::fs::remove_dir_all(dir);
}

// ── empty catalog + grant: honest degradation to the plain (streaming) path ─

#[tokio::test]
async fn empty_catalog_with_grant_degrades_to_plain_path() {
    let dir = temp_dir("empty-catalog");
    let provider = tool_provider(false);
    let provider_base = spawn_tool_provider(provider.clone()).await;
    let backend = tool_backend();
    *backend.catalog_body.lock().unwrap() = json!({ "tools": [] });
    let backend_base = spawn_tool_backend(backend.clone()).await;
    let desktop = identity(0xEC);
    let desktop_public = desktop.public_key_bytes();
    let (browser_secret, browser_public) = browser_keypair(0xC0);

    let chat_body = json!({
        "v": 1,
        "messages": [{ "role": "user", "content": "stream please" }],
        "toolGrant": "grant-abc",
    });
    seed_request(&backend, "req-empty-cat", &browser_secret, &desktop_public, &chat_body, &browser_public);

    let registry = registry_with_provider(&dir, &provider_base);
    let tunnel = tunnel_with_timing(registry, dir.clone(), desktop, ConfirmTiming::default());
    let client = client_for(&backend_base);
    let outcome = tunnel.poll_cycle(&client, "desktop-test").await;
    assert!(outcome.error.is_none(), "poll error: {:?}", outcome.error);

    // The catalog WAS consulted (once), but with nothing in it the request
    // rode the exact legacy streaming path.
    assert_eq!(*backend.catalog_hits.lock().unwrap(), 1);
    assert!(backend.executes.lock().unwrap().is_empty());
    let frames = backend.frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 4);
    let mut text = String::new();
    for (i, frame) in frames.iter().enumerate() {
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
            assert_eq!(value, json!({ "v": 1, "kind": "final" }));
        }
    }
    assert_eq!(text, "Hello");
    assert_eq!(backend.completions.lock().unwrap()[0]["status"], "done");
    let _ = std::fs::remove_dir_all(dir);
}

// ── pure helpers ───────────────────────────────────────────────────────────

#[test]
fn catalog_normalizes_top_level_and_data_tools() {
    let top = json!({ "tools": [
        {
            "name": "list_apps",
            "description": "List apps",
            "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } }
        },
        { "description": "no name — skipped" },
        { "name": "bare" }
    ]});
    let tools = catalog_to_openai_tools(&top);
    assert_eq!(tools.len(), 2);
    assert_eq!(
        tools[0],
        json!({
            "type": "function",
            "function": {
                "name": "list_apps",
                "description": "List apps",
                "parameters": { "type": "object", "properties": { "q": { "type": "string" } } }
            }
        })
    );
    assert_eq!(
        tools[1],
        json!({
            "type": "function",
            "function": {
                "name": "bare",
                "parameters": { "type": "object", "properties": {} }
            }
        })
    );
    // The {data:{tools:[…]}} envelope is tolerated as the fallback.
    let wrapped = json!({ "data": { "tools": [{ "name": "x" }] } });
    assert_eq!(catalog_to_openai_tools(&wrapped).len(), 1);
    assert!(catalog_to_openai_tools(&json!({})).is_empty());
    assert!(catalog_to_openai_tools(&json!({ "tools": "not-an-array" })).is_empty());
}

#[test]
fn tool_results_are_bounded_for_frame_and_model() {
    // Small results pass through untouched.
    let (frame, feed) = bound_result(json!({ "id": "x" }));
    assert_eq!(frame, json!({ "id": "x" }));
    assert_eq!(feed, r#"{"id":"x"}"#);
    // Oversized results become an honest truncation note in the frame and a
    // clipped feed with an explicit marker.
    let big = json!({ "blob": "y".repeat(MAX_RESULT_FRAME_BYTES + 1024) });
    let (frame, feed) = bound_result(big);
    assert_eq!(frame["truncated"], true);
    assert!(feed.len() < MAX_RESULT_MODEL_BYTES + 64);
    assert!(feed.ends_with("[truncated]"));
}

#[test]
fn prompted_parse_is_well_formed_or_text() {
    let tools = catalog_to_openai_tools(&json!({
        "tools": [{ "name": "create_form", "description": "Create a form" }]
    }));

    // A valid single fenced block naming a cataloged tool is a call.
    assert_eq!(
        parse_prompted_tool_call(FENCED_CALL, &tools),
        Some(("create_form".to_string(), json!({ "title": "Contact" })))
    );
    // Surrounding whitespace is tolerated; a missing input defaults to {}.
    assert_eq!(
        parse_prompted_tool_call(
            "\n  ```tool_call\n{\"tool\":\"create_form\"}\n```  \n",
            &tools
        ),
        Some(("create_form".to_string(), json!({})))
    );

    // Everything else is TEXT — never a guessed call.
    for text in [
        // plain prose
        "Sure, I created the form for you.",
        // prose before the fence
        "Here you go:\n```tool_call\n{\"tool\":\"create_form\",\"input\":{}}\n```",
        // prose after the fence
        "```tool_call\n{\"tool\":\"create_form\",\"input\":{}}\n```\nDone!",
        // malformed JSON
        "```tool_call\n{\"tool\": create_form}\n```",
        // unknown tool name
        "```tool_call\n{\"tool\":\"not_a_tool\",\"input\":{}}\n```",
        // non-object input
        "```tool_call\n{\"tool\":\"create_form\",\"input\":\"title\"}\n```",
        // missing tool name
        "```tool_call\n{\"input\":{}}\n```",
        // a different fence language
        "```json\n{\"tool\":\"create_form\",\"input\":{}}\n```",
        // unterminated fence
        "```tool_call\n{\"tool\":\"create_form\",\"input\":{}}",
    ] {
        assert_eq!(parse_prompted_tool_call(text, &tools), None, "{text:?}");
    }
}

#[test]
fn codex_prompts_carry_the_harness_and_thread_feedback() {
    let tools = catalog_to_openai_tools(&json!({
        "tools": [{ "name": "create_form", "description": "Create a form" }]
    }));
    let convo = vec![
        json!({ "role": "system", "content": "Be brief." }),
        json!({ "role": "user", "content": "make me a contact form" }),
    ];

    // Round 1 with tools: preamble + the rendered conversation.
    let first = codex_first_prompt(true, &tools, &convo);
    assert!(first.contains("```tool_call"));
    assert!(first.contains("- create_form: Create a form"));
    assert!(first.contains("system: Be brief."));
    assert!(first.contains("user: make me a contact form"));

    // Round 1 without tools (empty-attach edge): the plain instruction leads.
    let first_plain = codex_first_prompt(false, &tools, &convo);
    assert!(first_plain.starts_with("Tool calling is not available"));
    assert!(!first_plain.contains("```tool_call"));

    // Follow-up rounds send only the NEW feedback into the thread…
    let followup = codex_followup_prompt(
        &["tool_result create_form: {\"formId\":\"f-1\"}".to_string()],
        true,
    );
    assert_eq!(followup, "tool_result create_form: {\"formId\":\"f-1\"}");
    // …and append the plain-answer instruction once tools are withdrawn.
    let final_round = codex_followup_prompt(
        &["tool_result create_form: {\"formId\":\"f-1\"}".to_string()],
        false,
    );
    assert!(final_round.starts_with("tool_result create_form:"));
    assert!(final_round.ends_with("do not emit a tool_call block."));
}

// ── Chat image attachments on the Codex lane ────────────────────────────────

#[test]
fn message_text_joins_parts_and_marks_images() {
    assert_eq!(message_text(&json!("plain string")), "plain string");
    assert_eq!(
        message_text(&json!([
            { "type": "text", "text": "look at this" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
        ])),
        "look at this\n[image attached]"
    );
    // Image-only content still renders a non-empty marker (the codex request
    // refuses empty prompts; the image itself rides the `images` field).
    assert_eq!(
        message_text(&json!([
            { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,BBBB" } },
        ])),
        "[image attached]"
    );
    assert_eq!(message_text(&json!(null)), "");
}

#[test]
fn render_convo_text_is_parts_aware() {
    let convo = vec![
        json!({ "role": "user", "content": [
            { "type": "text", "text": "what is this?" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
        ]}),
        json!({ "role": "assistant", "content": "a cat" }),
    ];
    assert_eq!(
        render_convo_text(&convo),
        "user: what is this?\n[image attached]\n\nassistant: a cat"
    );
}

#[test]
fn collect_user_image_urls_orders_filters_and_caps() {
    let uri = |n: usize| format!("data:image/png;base64,IMG{n}");
    let msg = |role: &str, urls: &[String]| {
        let mut parts = vec![json!({ "type": "text", "text": "t" })];
        parts.extend(urls.iter().map(|u| json!({ "type": "image_url", "image_url": { "url": u } })));
        json!({ "role": role, "content": parts })
    };
    let convo = vec![
        msg("user", &[uri(1), uri(2)]),
        // Assistant image parts never ride (backend admits parts on USER only).
        msg("assistant", &[uri(90)]),
        msg("user", &[uri(3)]),
    ];
    assert_eq!(
        collect_user_image_urls(&convo, false),
        vec![uri(1), uri(2), uri(3)]
    );
    assert_eq!(collect_user_image_urls(&convo, true), vec![uri(3)]);
    // String-content messages contribute nothing.
    assert!(collect_user_image_urls(&[json!({ "role": "user", "content": "hi" })], false).is_empty());
    // Over the cap: the NEWEST survive.
    let many: Vec<String> = (0..10).map(uri).collect();
    let capped = collect_user_image_urls(&[msg("user", &many)], false);
    assert_eq!(capped.len(), 8);
    assert_eq!(capped[0], uri(2));
    assert_eq!(capped[7], uri(9));
}
