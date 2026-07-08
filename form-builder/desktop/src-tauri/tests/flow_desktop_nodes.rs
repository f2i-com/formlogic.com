//! Desktop-service node integration tests — the Rust runner driving the four
//! service-backed nodes (browser_action / image_gen / stt_transcribe / tts_speak)
//! end-to-end against an axum STUB that mimics the local service HTTP APIs
//! (the Playwright browser server + a krea2 / OpenAI-compatible endpoint).
//!
//! We point `RunDeps.service_bases` at the stub (the same seam production fills
//! from the services registry), then assert:
//!   - browser_action drives session → goto → action → structured result;
//!   - image_gen round-trips both the krea2 {imageUrl} and OpenAI data[] shapes;
//!   - stt/tts round-trip a configured endpoint (bytes → data URL for tts);
//!   - with NO service reachable the run resolves to a typed `node_failed` whose
//!     message is ACTIONABLE ("install & start … in FormLogic Desktop") and never
//!     says "coming soon" — and the runner never panics.

use std::collections::HashMap;
use std::net::SocketAddr;

use axum::{
    extract::Path,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use formlogic_desktop_lib::flows::runner::{execute_flow, FlowErrorCode, RunDeps, RunOptions, DEFAULT_TIMEOUT_MS};

// ── stub service (Playwright browser + krea2 + OpenAI-compatible stt/tts) ──────

async fn stub_new_session() -> Json<Value> {
    Json(json!({ "sessionId": "s1" }))
}
async fn stub_goto(Path(_id): Path<String>) -> Json<Value> {
    Json(json!({ "url": "https://example.com/", "title": "Example", "status": 200 }))
}
async fn stub_evaluate(Path(_id): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "result": "Extracted text" }))
}
async fn stub_action(Path(_id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    // Echo the action back so a test can assert click/type were dispatched.
    Json(json!({ "ok": true, "action": body.get("action").cloned().unwrap_or(Value::Null) }))
}
async fn stub_wait(Path(_id): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": true }))
}
async fn stub_html(Path(_id): Path<String>) -> Json<Value> {
    Json(json!({ "html": "<html><body>hi</body></html>" }))
}
async fn stub_screenshot(Path(_id): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "dataUrl": "data:image/png;base64,AAA" }))
}

/// Stands in for a llama.cpp / Ollama / custom-script service targeted by `http_request`'s
/// `service` field.
async fn stub_predict() -> Json<Value> {
    Json(json!({ "predicted": true }))
}

async fn stub_krea2_generate(Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": true, "imageUrl": "http://service/file?path=out.png" }))
}
async fn stub_openai_images(Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "data": [ { "url": "http://service/img/1.png" } ] }))
}
async fn stub_stt(Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "text": "hello world" }))
}
/// OpenAI /v1/audio/speech returns raw audio BYTES (here "ABC" → base64 "QUJD").
async fn stub_tts() -> Response {
    Response::builder()
        .status(200)
        .header("content-type", "audio/mpeg")
        .body(axum::body::Body::from(b"ABC".to_vec()))
        .unwrap()
}

async fn spawn_stub() -> SocketAddr {
    let app = Router::new()
        .route("/session", post(stub_new_session))
        .route("/session/:id/goto", post(stub_goto))
        .route("/session/:id/evaluate", post(stub_evaluate))
        .route("/session/:id/action", post(stub_action))
        .route("/session/:id/wait", post(stub_wait))
        .route("/session/:id/html", get(stub_html))
        .route("/session/:id/screenshot", post(stub_screenshot))
        .route("/predict", get(stub_predict))
        .route("/generate", post(stub_krea2_generate))
        .route("/v1/images/generations", post(stub_openai_images))
        .route("/v1/audio/transcriptions", post(stub_stt))
        .route("/v1/audio/speech", post(stub_tts));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// RunDeps whose `service_bases` point the given ids at `base` (the stub).
fn deps_with_services(base: &str, ids: &[&str]) -> RunDeps {
    let mut service_bases = HashMap::new();
    for id in ids {
        service_bases.insert((*id).to_string(), base.to_string());
    }
    RunDeps {
        client: None,
        host: None,
        app_id: None,
        http: reqwest::Client::new(),
        llm_endpoint: None,
        base_url: "http://formlogic.local".into(),
        registry: None,
        service_bases,
    }
}

fn empty_deps() -> RunDeps {
    deps_with_services("", &[])
}

fn opts() -> RunOptions {
    RunOptions {
        inputs: json!({}),
        event: None,
        app: None,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        capabilities: vec![],
        flow_slug: "t".into(),
    }
}

/// A single-node flow (no edges) — execute_flow returns that node's output as the result.
fn single_node_flow(node_type: &str, data: Value) -> Value {
    json!({ "nodes": [ { "id": "n", "type": node_type, "data": data } ], "edges": [] })
}

// ── browser_action ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn browser_action_drives_session_goto_extract_end_to_end() {
    let addr = spawn_stub().await;
    let base = format!("http://{addr}");
    let deps = deps_with_services(&base, &["playwright-browser"]);
    let flow = single_node_flow("browser_action", json!({ "action": "extract_text", "url": "https://example.com", "selector": "h1" }));

    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done", "browser_action should complete: {:?}", out.error);
    let r = out.result.unwrap();
    assert_eq!(r["sessionId"], json!("s1"));
    assert_eq!(r["url"], json!("https://example.com/"));
    assert_eq!(r["title"], json!("Example"));
    assert_eq!(r["status"], json!(200));
    assert_eq!(r["text"], json!("Extracted text"));
}

#[tokio::test]
async fn browser_action_screenshot_returns_data_url() {
    let addr = spawn_stub().await;
    let deps = deps_with_services(&format!("http://{addr}"), &["playwright-browser"]);
    let flow = single_node_flow("browser_action", json!({ "action": "screenshot" }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done");
    assert_eq!(out.result.unwrap()["dataUrl"], json!("data:image/png;base64,AAA"));
}

#[tokio::test]
async fn browser_action_extract_html() {
    let addr = spawn_stub().await;
    let deps = deps_with_services(&format!("http://{addr}"), &["playwright-browser"]);
    let flow = single_node_flow("browser_action", json!({ "action": "extract_html", "url": "https://example.com" }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done");
    assert_eq!(out.result.unwrap()["html"], json!("<html><body>hi</body></html>"));
}

#[tokio::test]
async fn browser_action_no_service_is_actionable_node_failed_never_coming_soon() {
    // No service_bases + no registry + no endpoint override → unavailable.
    let flow = single_node_flow("browser_action", json!({ "action": "goto", "url": "https://example.com" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    assert_eq!(out.status, "error");
    let e = out.error.unwrap();
    assert_eq!(e.code, FlowErrorCode::NodeFailed);
    assert!(e.message.contains("Install and start the Playwright Browser"), "message: {}", e.message);
    assert!(e.message.contains("FormLogic Desktop"));
    assert!(!e.message.to_lowercase().contains("coming soon"), "must never say coming soon: {}", e.message);
}

#[tokio::test]
async fn browser_action_resolved_but_unreachable_is_actionable() {
    // A base that resolves (loopback) but nothing is listening → transport failure → actionable.
    let deps = deps_with_services("http://127.0.0.1:1", &["playwright-browser"]);
    let flow = single_node_flow("browser_action", json!({ "action": "goto", "url": "https://example.com" }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "error");
    let e = out.error.unwrap();
    assert_eq!(e.code, FlowErrorCode::NodeFailed);
    assert!(e.message.contains("Install and start the Playwright Browser"), "message: {}", e.message);
}

// ── image_gen ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn image_gen_krea2_native_shape_round_trip() {
    let addr = spawn_stub().await;
    let deps = deps_with_services(&format!("http://{addr}"), &["krea2"]);
    let flow = single_node_flow("image_gen", json!({ "prompt": "a fox", "width": 512, "height": 512 }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done", "{:?}", out.error);
    assert_eq!(out.result.unwrap()["imageUrl"], json!("http://service/file?path=out.png"));
}

#[tokio::test]
async fn image_gen_openai_images_shape_via_endpoint_override() {
    let addr = spawn_stub().await;
    let endpoint = format!("http://{addr}/v1/images/generations");
    let deps = empty_deps(); // endpoint override → no registry needed
    let flow = single_node_flow("image_gen", json!({ "prompt": "a fox", "endpoint": endpoint }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done", "{:?}", out.error);
    assert_eq!(out.result.unwrap()["imageUrl"], json!("http://service/img/1.png"));
}

#[tokio::test]
async fn image_gen_no_service_is_actionable() {
    let flow = single_node_flow("image_gen", json!({ "prompt": "a fox" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    let e = out.error.unwrap();
    assert_eq!(e.code, FlowErrorCode::NodeFailed);
    assert!(e.message.contains("Krea-2"), "message: {}", e.message);
    assert!(!e.message.to_lowercase().contains("coming soon"));
}

// ── stt / tts (configured endpoint) ──────────────────────────────────────────────

#[tokio::test]
async fn stt_transcribe_configured_endpoint_returns_text() {
    let addr = spawn_stub().await;
    let endpoint = format!("http://{addr}/v1/audio/transcriptions");
    let flow = single_node_flow("stt_transcribe", json!({ "endpoint": endpoint, "model": "whisper-1", "audio": "data:audio/wav;base64,AA" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    assert_eq!(out.status, "done", "{:?}", out.error);
    assert_eq!(out.result.unwrap()["text"], json!("hello world"));
}

#[tokio::test]
async fn tts_speak_bytes_become_a_data_url() {
    let addr = spawn_stub().await;
    let endpoint = format!("http://{addr}/v1/audio/speech");
    let flow = single_node_flow("tts_speak", json!({ "endpoint": endpoint, "voice": "alloy", "text": "hi" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    assert_eq!(out.status, "done", "{:?}", out.error);
    let r = out.result.unwrap();
    // "ABC" → base64 "QUJD".
    assert_eq!(r["audioUrl"], json!("data:audio/mpeg;base64,QUJD"));
    assert_eq!(r["dataUrl"], json!("data:audio/mpeg;base64,QUJD"));
}

#[tokio::test]
async fn tts_speak_no_endpoint_is_actionable_never_coming_soon() {
    let flow = single_node_flow("tts_speak", json!({ "text": "hi" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    let e = out.error.unwrap();
    assert_eq!(e.code, FlowErrorCode::NodeFailed);
    assert!(e.message.contains("text-to-speech"), "message: {}", e.message);
    assert!(!e.message.to_lowercase().contains("coming soon"));
}

#[tokio::test]
async fn stt_rejects_non_allowlisted_endpoint() {
    let flow = single_node_flow("stt_transcribe", json!({ "endpoint": "https://evil.example/v1/audio/transcriptions", "audio": "x" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
}

// ── http_request + `service` (target a named Desktop service instead of an absolute URL) ──────
// Mirrors ui/src/client-runtime/flows/nodes.test.ts's `http_request` describe block.

#[tokio::test]
async fn http_request_service_path_with_leading_slash_hits_the_resolved_service() {
    let addr = spawn_stub().await;
    let deps = deps_with_services(&format!("http://{addr}"), &["llama-cpp"]);
    let flow = single_node_flow("http_request", json!({ "service": "llama-cpp", "url": "/predict" }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done", "{:?}", out.error);
    let r = out.result.unwrap();
    assert_eq!(r["ok"], json!(true));
    assert_eq!(r["body"]["predicted"], json!(true));
}

#[tokio::test]
async fn http_request_service_path_without_leading_slash_hits_the_same_url() {
    let addr = spawn_stub().await;
    let deps = deps_with_services(&format!("http://{addr}"), &["llama-cpp"]);
    let flow = single_node_flow("http_request", json!({ "service": "llama-cpp", "url": "predict" }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    assert_eq!(out.status, "done", "{:?}", out.error);
    assert_eq!(out.result.unwrap()["body"]["predicted"], json!(true));
}

#[tokio::test]
async fn http_request_service_unavailable_is_actionable_never_coming_soon() {
    // No service_bases + no registry + no endpoint override → unavailable, same actionable
    // failure shape as browser_action/image_gen/stt/tts.
    let flow = single_node_flow("http_request", json!({ "service": "llama-cpp", "url": "/predict" }));
    let out = execute_flow(&flow, &empty_deps(), &opts()).await;
    assert_eq!(out.status, "error");
    let e = out.error.unwrap();
    assert_eq!(e.code, FlowErrorCode::NodeFailed);
    assert!(e.message.contains("llama-cpp"), "message: {}", e.message);
    assert!(!e.message.to_lowercase().contains("coming soon"));
}

#[tokio::test]
async fn http_request_service_ignores_the_url_allowlist_but_never_leaves_the_resolved_host() {
    // Without `service`, an absolute non-allow-listed URL is capability_denied (see
    // runner.rs::http_request_rejects_non_allowlisted_url). With `service` set, the
    // (author-fixed, never-templated) service resolution IS the trust boundary: the same
    // shape of value in `url` is treated as a PATH and can never redirect the request to a
    // different host — it always lands on the resolved loopback service.
    let addr = spawn_stub().await;
    let deps = deps_with_services(&format!("http://{addr}"), &["llama-cpp"]);
    let flow = single_node_flow("http_request", json!({ "service": "llama-cpp", "url": "https://evil.example/predict" }));
    let out = execute_flow(&flow, &deps, &opts()).await;
    // The request reached OUR stub (no route for that literal path → 404), proving it never
    // attempted to leave the resolved loopback host, let alone reach evil.example.
    assert_eq!(out.status, "done", "{:?}", out.error);
    assert_eq!(out.result.unwrap()["status"], json!(404));
}
