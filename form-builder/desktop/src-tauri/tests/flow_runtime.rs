//! FlowRuntime integration test — a plugin event driving the HEADLESS runner
//! end-to-end, without any browser.
//!
//! A tiny axum stub stands in for FormLogic Cloud `/api/v1`. We publish an
//! `aokie.call.incoming` event on the REAL desktop event bus; the FlowRuntime
//! (linked to the stub) must (a) apply the app's `onConnectorEvent` script
//! headless → POST a Calls response, and (b) fire the matching flow binding →
//! reserve + complete a run. We assert the stub recorded the submit + reserve +
//! complete — the mission's core claim ("the receptionist runs within the
//! Desktop app").

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use f2i_companion_lib::events::EventBus;
use f2i_companion_lib::flows::FlowRuntime;
use f2i_companion_lib::formlogic_client::FormLogicConfig;
use f2i_companion_lib::plugins::manifest::parse_manifest;
use f2i_companion_lib::plugins::registry::PluginHost;
use f2i_companion_lib::plugins::rpc::LogRing;

#[derive(Clone, Default)]
struct Counters {
    submits: Arc<AtomicU64>,
    reserves: Arc<AtomicU64>,
    completes: Arc<AtomicU64>,
}

/// The aokie onConnectorEvent script (compact): logs a Calls row on incoming.
const LOGIC_CALL_INCOMING: &str = r#"function run(ctx){
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.call.incoming') return {};
  var k = 'seen-' + String(ev.idempotencyKey || '');
  if (ctx.storage && ctx.storage[k]) return {};
  var d = ev.data || {};
  return { effects: [
    { type: 'storage.set', key: k, value: 1 },
    { type: 'formlogic.submitResponse', formKey: 'Calls', answers: {
        call_id: String(d.callId || ''), caller_phone: String(d.from || ''), status: 'incoming' } }
  ] };
}"#;

async fn stub_flows() -> Json<Value> {
    Json(json!({ "flows": [ {
        "id": "flow-1", "slug": "log-call", "enabled": true, "appId": null,
        "nodeCapabilities": null,
        "flowJson": { "nodes": [ { "id": "in", "type": "input" }, { "id": "out", "type": "output" } ],
                      "edges": [ { "source": "in", "target": "out" } ] }
    } ] }))
}

async fn stub_bindings() -> Json<Value> {
    Json(json!({ "bindings": [ {
        "id": "bind-1", "event": "aokie.call.incoming", "connectorId": "aokie",
        "flow": "log-call", "flowDefinitionId": "flow-1", "mode": "async",
        "condition": null, "inputMap": { "callId": "$event.data.callId" },
        "outputActions": [], "timeoutMs": 5000, "retryPolicy": null, "appId": null
    } ] }))
}

async fn stub_app_logic() -> Json<Value> {
    Json(json!({ "apps": [ {
        "app": { "id": "app-1", "slug": "reception", "name": "Reception" },
        "customLogic": { "version": 1, "runtime": "quickjs", "scripts": [
            { "id": "s1", "hook": "onConnectorEvent", "runtime": "quickjs", "source": LOGIC_CALL_INCOMING }
        ] },
        "forms": [ { "id": "form-calls", "name": "Calls", "displayName": "Calls" } ]
    } ] }))
}

async fn stub_reserve(State(c): State<Counters>, Json(_body): Json<Value>) -> Json<Value> {
    c.reserves.fetch_add(1, Ordering::SeqCst);
    Json(json!({ "run": { "runId": "run-1" }, "created": true }))
}

async fn stub_submit(State(c): State<Counters>, Path(_form): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    c.submits.fetch_add(1, Ordering::SeqCst);
    Json(json!({ "response": { "id": "resp-1" } }))
}

async fn stub_complete(State(c): State<Counters>, Path(_id): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    c.completes.fetch_add(1, Ordering::SeqCst);
    Json(json!({ "run": { "runId": "run-1" } }))
}

async fn stub_queued() -> Json<Value> {
    Json(json!({ "runs": [] }))
}

async fn spawn_stub() -> (SocketAddr, Counters) {
    let counters = Counters::default();
    let app = Router::new()
        .route("/api/v1/flows", get(stub_flows))
        .route("/api/v1/flow-bindings", get(stub_bindings))
        .route("/api/v1/app-logic", get(stub_app_logic))
        .route("/api/v1/flow-runs", post(stub_reserve))
        .route("/api/v1/flow-runs/queued", get(stub_queued))
        .route("/api/v1/flow-runs/:id", patch(stub_complete))
        .route("/api/v1/forms/:form/responses", post(stub_submit))
        .with_state(counters.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, counters)
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("flrt-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&d);
    d
}

async fn wait_for(pred: impl Fn() -> bool, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    pred()
}

#[tokio::test]
async fn plugin_event_drives_headless_record_writes_and_flow_run() {
    let (addr, counters) = spawn_stub().await;
    let base_url = format!("http://{addr}");

    let events = EventBus::new();
    let host = PluginHost::new(&temp_dir("host"), false, events);
    let config = FormLogicConfig { base_url, api_key: "flk_test".into() };
    let runtime = FlowRuntime::new(host.clone(), None, config);
    runtime.start(); // subscribes to the bus synchronously before returning
    assert!(runtime.status().linked, "runtime should be linked to the stub");

    // Publish an aokie.call.incoming event on the REAL bus (as a plugin would).
    let manifest = parse_manifest(
        r#"{ "schemaVersion": 1, "id": "aokie", "name": "Aokie", "version": "0.1.0",
             "entry": { "kind": "process", "command": "aokie" },
             "events": ["aokie.call.incoming"] }"#,
    )
    .expect("manifest");
    let envelope = json!({
        "schemaVersion": 1,
        "source": "aokie",
        "name": "aokie.call.incoming",
        "correlationId": "call-1",
        "idempotencyKey": "aokie:call-1:incoming:v1",
        "occurredAt": "2026-07-07T00:00:00Z",
        "connectorId": "aokie",
        "data": { "callId": "call-1", "from": "+15551212", "callerName": "Ada" }
    });
    let logs = LogRing::new();
    host.events().publish_from_plugin("aokie", &manifest, envelope, &logs);

    // App-logic wrote the Calls row, and the binding reserved + completed a run.
    let submitted = wait_for(|| counters.submits.load(Ordering::SeqCst) >= 1, Duration::from_secs(10)).await;
    let reserved = wait_for(|| counters.reserves.load(Ordering::SeqCst) >= 1, Duration::from_secs(10)).await;
    let completed = wait_for(|| counters.completes.load(Ordering::SeqCst) >= 1, Duration::from_secs(10)).await;

    assert!(submitted, "app-logic onConnectorEvent should POST a Calls response");
    assert!(reserved, "the matching flow binding should reserve a run");
    assert!(completed, "the flow run should complete");
}

#[tokio::test]
async fn duplicate_event_dedupes_to_one_dispatch() {
    let (addr, counters) = spawn_stub().await;
    let events = EventBus::new();
    let host = PluginHost::new(&temp_dir("dedupe"), false, events);
    let config = FormLogicConfig { base_url: format!("http://{addr}"), api_key: "flk_test".into() };
    let runtime = FlowRuntime::new(host.clone(), None, config);
    runtime.start();

    let manifest = parse_manifest(
        r#"{ "schemaVersion": 1, "id": "aokie", "name": "Aokie", "version": "0.1.0",
             "entry": { "kind": "process", "command": "aokie" }, "events": ["aokie.call.incoming"] }"#,
    )
    .unwrap();
    let make = || json!({
        "schemaVersion": 1, "source": "aokie", "name": "aokie.call.incoming",
        "correlationId": "call-9", "idempotencyKey": "aokie:call-9:incoming:v1",
        "occurredAt": "2026-07-07T00:00:00Z", "connectorId": "aokie",
        "data": { "callId": "call-9", "from": "+1", "callerName": "Z" }
    });
    let logs = LogRing::new();
    // Same idempotencyKey twice: the in-process dedupe must collapse to one submit.
    host.events().publish_from_plugin("aokie", &manifest, make(), &logs);
    host.events().publish_from_plugin("aokie", &manifest, make(), &logs);

    wait_for(|| counters.submits.load(Ordering::SeqCst) >= 1, Duration::from_secs(10)).await;
    // Give any (erroneous) second dispatch time to also land.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(counters.submits.load(Ordering::SeqCst), 1, "one envelope → one app-logic submit");
}
