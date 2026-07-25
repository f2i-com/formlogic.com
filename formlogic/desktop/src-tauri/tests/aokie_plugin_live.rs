//! Flow-driven Aokie receptionist — REAL end-to-end verification (no hardware).
//!
//! Spawns the ACTUAL `aokie-plugin.exe` (built from the separate aokie.com repo,
//! `cargo build -p aokie-plugin`) as a real child process under the REAL
//! `PluginHost`/plugin-runner supervisor (the exact same code path production
//! Desktop uses), in `FORMLOGIC_DEV_MODE=1` (no Bluetooth hardware required —
//! the plugin's dev/mock call lifecycle stands in for a live call).
//!
//! Goal: prove the FLOW-DRIVEN signal path is real and correctly wired:
//!   real `aokie.call.turn.final` event (emitted by the real plugin process)
//!   -> real FlowRuntime event loop -> real binding condition/match
//!   -> real Rust flow executor (`flows::runner::execute_flow`)
//!   -> real `aokie_speak` node -> real `connectors::dispatch`
//!   -> the SAME real external aokie-plugin.exe's `call.operatorSpeak` handler.
//!
//! What this CANNOT prove (documented, not faked): the plugin's real Bluetooth
//! radio (`radio.rs`) only exists with actual hardware attached; its
//! `aiReceptionist`-gated "ignore operatorSpeak" branch lives entirely inside
//! that hardware-only code path (verified by reading `radio.rs::run_loop`) and
//! is unreachable from `cargo test` (no mock `BluetoothManager` exists in the
//! aokie-dongle crate). Instead, the plugin's dev-mode `MockState` machine
//! (`connector.rs`) is exercised, which is what all these tests interact with.
//! Its `call.operatorSpeak` handler accepts/rejects purely on `MockCallState`
//! (Incoming/Active/Ended), independent of `aiReceptionist` — a separate, real
//! finding reported alongside these tests, not something they can change.
//!
//! Skips (with a clear message) if the aokie-plugin binary isn't available —
//! set `AOKIE_PLUGIN_EXE` to override the default dev-machine path.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, State},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use formlogic_desktop_lib::connectors::{self, ConnectorRequestBody};
use formlogic_desktop_lib::events::EventBus;
use formlogic_desktop_lib::flows::runner::{execute_flow, RunDeps, RunOptions, DEFAULT_TIMEOUT_MS};
use formlogic_desktop_lib::flows::FlowRuntime;
use formlogic_desktop_lib::formlogic_client::FormLogicConfig;
use formlogic_desktop_lib::plugins::registry::{PluginHost, PluginHostHandle, PluginSnapshot, PluginState};

/// The plugin's real, shipped manifest (crates/aokie-plugin/manifest.json in the
/// aokie.com repo), copied verbatim so this test drives the SAME declared
/// capability/command surface production does.
const AOKIE_MANIFEST: &str = r#"
{
  "schemaVersion": 2,
  "id": "aokie",
  "name": "Aokie Phone Bridge",
  "version": "0.1.0",
  "publisher": "Aokie",
  "description": "Bluetooth dongle / phone bridge (WinUSB, HFP/SCO, MAP SMS, PBAP contacts) packaged as a FormLogic Desktop plugin. Emits aokie.* call/SMS/dongle events and serves the aokie connector command surface.",
  "pluginApiVersion": 1,
  "minDesktopVersion": "0.1.0",
  "entry": {
    "kind": "process",
    "command": "aokie-plugin.exe",
    "args": ["--stdio"]
  },
  "capabilities": [
    "flow.run",
    "companion.admission",
    "connector.aokie.dongle.list",
    "connector.aokie.dongle.getPreferred",
    "connector.aokie.dongle.setPreferred",
    "connector.aokie.dongle.installDriver",
    "connector.aokie.dongle.restoreDriver",
    "connector.aokie.dongle.removeCerts",
    "connector.aokie.dongle.diagnostics",
    "connector.aokie.phone.status",
    "connector.aokie.phone.startPairing",
    "connector.aokie.phone.stopPairing",
    "connector.aokie.phone.confirmPairing",
    "connector.aokie.phone.listPaired",
    "connector.aokie.phone.removePaired",
    "connector.aokie.phone.disconnect",
    "connector.aokie.phone.connect",
    "connector.aokie.call.current",
    "connector.aokie.call.switchboard",
    "connector.aokie.call.activate",
    "connector.aokie.call.answer",
    "connector.aokie.call.reject",
    "connector.aokie.call.hangup",
    "connector.aokie.call.operatorSpeak",
    "connector.aokie.call.configureAgent",
    "connector.aokie.call.dial",
    "connector.aokie.sms.threads",
    "connector.aokie.sms.thread",
    "connector.aokie.sms.send",
    "connector.aokie.settings.get",
    "connector.aokie.settings.set",
    "connector.aokie.outbox.redrive",
    "connector.aokie.consent.get",
    "connector.aokie.consent.set",
    "connector.aokie.consent.revoke"
  ],
  "connectors": [
    {
      "id": "aokie",
      "name": "Aokie Phone Bridge",
      "commands": [
        "dongle.list",
        "dongle.getPreferred",
        "dongle.setPreferred",
        "dongle.installDriver",
        "dongle.restoreDriver",
        "dongle.removeCerts",
        "dongle.diagnostics",
        "phone.status",
        "phone.startPairing",
        "phone.stopPairing",
        "phone.confirmPairing",
        "phone.listPaired",
        "phone.removePaired",
        "phone.disconnect",
        "phone.connect",
        "call.current",
        "call.switchboard",
        "call.activate",
        "call.answer",
        "call.reject",
        "call.hangup",
        "call.operatorSpeak",
        "call.configureAgent",
        "call.dial",
        "sms.threads",
        "sms.thread",
        "sms.send",
        "settings.get",
        "settings.set",
        "outbox.redrive",
        "consent.get",
        "consent.set",
        "consent.revoke"
      ]
    }
  ],
  "events": [
    "aokie.dongle.detected",
    "aokie.dongle.driver_required",
    "aokie.dongle.ready",
    "aokie.dongle.error",
    "aokie.phone.pairing_started",
    "aokie.phone.pairing_confirm_required",
    "aokie.phone.paired",
    "aokie.phone.connected",
    "aokie.phone.disconnected",
    "aokie.call.incoming",
    "aokie.call.ringing",
    "aokie.call.answered",
    "aokie.call.caller_id",
    "aokie.call.rejected",
    "aokie.call.audio.connected",
    "aokie.call.audio.disconnected",
    "aokie.call.turn.partial",
    "aokie.call.turn.final",
    "aokie.call.turn.corrected",
    "aokie.call.transcript.settled",
    "aokie.call.ended",
    "aokie.call.assistance.requested",
    "aokie.call.assistance.resolved",
    "aokie.call.waiting",
    "aokie.call.outbound.dialing",
    "aokie.appointment.requested",
    "aokie.sms.received",
    "aokie.sms.sent",
    "aokie.sms.failed",
    "aokie.manager.action",
    "aokie.hardware.error"
  ],
  "ui": {
    "nav": [
      {
        "id": "receptionist",
        "label": "AI Receptionist",
        "icon": "phone",
        "badge": "New",
        "screen": "receptionist-home"
      }
    ],
    "screens": [
      {
        "id": "receptionist-home",
        "title": "AI Receptionist",
        "entry": "ui/receptionist/index.html",
        "files": [
          "ui/receptionist/index.html",
          "ui/receptionist/styles.css",
          "ui/receptionist/app.js",
          "ui/receptionist/tabs/settings.js",
          "ui/receptionist/tabs/phone.js",
          "ui/receptionist/tabs/companion.js",
          "ui/receptionist/tabs/consent.js",
          "ui/receptionist/tabs/dongle.js"
        ]
      }
    ],
    "overview": [
      {
        "id": "aokie-hero",
        "kind": "hero",
        "title": "Aokie receptionist",
        "icon": "phone",
        "bind": {
          "headline": "$health.status",
          "body": "$health.detail",
          "cta": { "label": "Open AI Receptionist", "nav": "receptionist" }
        }
      }
    ],
    "statusCards": [
      {
        "id": "phone-bridge",
        "title": "Phone bridge",
        "poll": { "command": "phone.status", "intervalMs": 5000 },
        "fields": [
          { "label": "Phone", "path": "device.name" },
          { "label": "Connected", "path": "connected" },
          { "label": "Paired", "path": "paired" },
          { "label": "In call", "path": "callActive" }
        ]
      },
      {
        "id": "data-delivery",
        "title": "Data delivery",
        "poll": { "command": "dongle.diagnostics", "intervalMs": 10000 },
        "fields": [
          { "label": "Radio connected", "path": "radio.connected" },
          { "label": "Outbox pending", "path": "outbox.pending" },
          { "label": "Outbox failed", "path": "outbox.failed" },
          { "label": "Dead letters", "path": "outbox.dead" }
        ]
      }
    ]
  },
  "commands": {
    "journalled": [
      "phone.startPairing",
      "phone.stopPairing",
      "phone.removePaired",
      "phone.disconnect",
      "phone.connect",
      "phone.confirmPairing",
      "call.activate",
      "call.answer",
      "call.reject",
      "call.hangup",
      "call.operatorSpeak",
      "call.configureAgent",
      "call.dial",
      "sms.send"
    ]
  },
  "data": {
    "externalInventory": [
      {
        "path": "%APPDATA%/com.aokie.app",
        "label": "Aokie radio data (phone pairing keys, models, call database, logs)"
      },
      {
        "credential": "Aokie/*",
        "label": "Sealed keys in Windows Credential Manager (endpoint identity, manager PIN)"
      },
      {
        "path": "%ProgramData%/Aokie/driver-transactions.jsonl",
        "label": "WinUSB driver transaction journal"
      }
    ]
  }
}
"#;

/// Locate the real aokie-plugin.exe built from the sibling aokie.com repo.
/// `AOKIE_PLUGIN_EXE` overrides; otherwise the default dev-machine checkout
/// path. Returns `None` (test skips) if it isn't there.
fn find_aokie_plugin_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AOKIE_PLUGIN_EXE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let default = PathBuf::from(r"C:\Users\User\Documents\repos\aokie.com\target\debug\aokie-plugin.exe");
    default.is_file().then_some(default)
}

fn temp_data_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fl-aokie-live-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Copy the real aokie-plugin.exe + its real manifest into `<data>/plugins/aokie/`.
/// A voice-featured plugin build imports sherpa/onnxruntime DLLs at LOAD time
/// (the deployed plugin dir ships them beside the exe) — copy any DLL sitting
/// beside the source exe too, or the loader dies with STATUS_DLL_NOT_FOUND
/// before the process can even speak (init reads as "connection closed").
fn install_real_aokie_plugin(data_dir: &std::path::Path, exe: &std::path::Path) {
    let plugin_dir = data_dir.join("plugins").join("aokie");
    std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
    std::fs::copy(exe, plugin_dir.join("aokie-plugin.exe")).expect("copy aokie-plugin.exe");
    if let Some(src_dir) = exe.parent() {
        for entry in std::fs::read_dir(src_dir).expect("read exe dir").flatten() {
            let path = entry.path();
            let is_dll = path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"));
            if is_dll {
                let name = entry.file_name();
                let _ = std::fs::copy(&path, plugin_dir.join(name));
            }
        }
    }
    std::fs::write(plugin_dir.join("manifest.json"), AOKIE_MANIFEST).expect("write manifest");
}

async fn wait_running(host: &PluginHostHandle, timeout: Duration) -> PluginSnapshot {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(snap) = host.get("aokie") {
            if snap.state == PluginState::Running {
                return snap;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("aokie-plugin never reached Running: state={:?} reason={:?}", snap.state, snap.reason);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn body(command: &str, payload: Value) -> ConnectorRequestBody {
    serde_json::from_value(json!({ "connectorId": "aokie", "command": command, "payload": payload }))
        .expect("body")
}

fn physical_body(command: &str, payload: Value, request_id: &str) -> ConnectorRequestBody {
    serde_json::from_value(json!({
        "connectorId": "aokie",
        "command": command,
        "payload": payload,
        "requestId": request_id,
    }))
    .expect("physical command body")
}

/// Test 1: the real desktop connector gateway <-> the real external aokie-plugin.exe,
/// AND the real Rust flow executor's `aokie_speak` node reaching that same real
/// process. Proves the non-hardware half of the signal path end-to-end.
#[tokio::test(flavor = "multi_thread")]
async fn aokie_speak_node_reaches_the_real_plugin_process() {
    let Some(exe) = find_aokie_plugin_exe() else {
        eprintln!("SKIP: aokie-plugin.exe not found — build it first: \
            cd aokie.com && cargo build -p aokie-plugin (set AOKIE_PLUGIN_EXE to override)");
        return;
    };
    let data = temp_data_dir("speak");
    install_real_aokie_plugin(&data, &exe);
    let host = PluginHost::new(&data, true /* dev_mode: FORMLOGIC_DEV_MODE=1, no hardware */, EventBus::new());

    let mut events = host.events().subscribe();
    host.start("aokie").expect("start aokie-plugin");
    let snap = wait_running(&host, Duration::from_secs(15)).await;
    assert!(snap.pid.is_some(), "real aokie-plugin.exe process is running");
    println!("[ok] real aokie-plugin.exe spawned under PluginHost, pid={:?}", snap.pid);

    // Sanity round-trip on an arbitrary command (proves the JSON-RPC bridge works
    // against the REAL binary, not just the `mock-plugin` test fixture).
    let ok = connectors::dispatch(&host, "aokie", &body("settings.get", Value::Null)).await.expect("settings.get");
    assert_eq!(ok["ok"], true);
    println!("[ok] settings.get round-trip: {ok}");

    // With no active call, operatorSpeak is typed-rejected (not faked success).
    let err = connectors::dispatch(
        &host,
        "aokie",
        &physical_body("call.operatorSpeak", json!({ "text": "hi" }), "live-no-call-speak"),
    )
        .await
        .expect_err("no active call yet");
    assert_eq!(err.code, "command_failed");
    assert!(err.message.contains("no active call"), "got: {}", err.message);
    println!("[ok] call.operatorSpeak with no call: {}", err.message);

    // Drive the plugin's dev-mode scripted call lifecycle (the mock stand-in for a
    // live call) and confirm the REAL events land on the REAL desktop event bus —
    // exactly the events a live call's `aokie.call.turn.final` binding fires on.
    let sim = connectors::dispatch(&host, "aokie", &body("dongle.diagnostics", json!({ "simulate": "call" })))
        .await
        .expect("simulated call");
    assert_eq!(sim["ok"], true);
    let mut seen_names = Vec::new();
    let mut turn_texts = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while seen_names.len() < 8 && tokio::time::Instant::now() < deadline {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_secs(2), events.recv()).await {
            let envelope: Value = serde_json::from_str(&ev.json).expect("envelope json");
            assert_eq!(envelope["connectorId"], json!("aokie"), "real events carry connectorId");
            if ev.name == "aokie.call.turn.final" {
                turn_texts.push((envelope["data"]["speaker"].as_str().unwrap_or("").to_string(),
                                  envelope["data"]["text"].as_str().unwrap_or("").to_string()));
            }
            seen_names.push(ev.name);
        }
    }
    println!("[ok] real events observed on the desktop bus: {seen_names:?}");
    assert!(seen_names.contains(&"aokie.call.incoming".to_string()));
    assert!(seen_names.contains(&"aokie.call.answered".to_string()));
    assert!(seen_names.contains(&"aokie.call.ended".to_string()));
    assert_eq!(turn_texts.len(), 2, "one caller turn + one bot turn: {turn_texts:?}");
    assert_eq!(turn_texts[0].0, "caller");
    assert_eq!(turn_texts[1].0, "bot");
    println!("[ok] turn.final events: {turn_texts:?}");

    // ── The core claim: the REAL Rust flow executor's `aokie_speak` node, exactly
    // as shipped in the pack's "live-reply" flow (`{ id:'say', type:'aokie_speak',
    // data:{ textFrom: '$nodes.reply.content' } }`), reaches the SAME real external
    // plugin process via `connector_request` / `call.operatorSpeak`.
    let flow_json = json!({
        "nodes": [
            { "id": "in", "type": "input" },
            { "id": "reply", "type": "logic_block", "data": { "expr": "({ content: inputs.text })" } },
            { "id": "say", "type": "aokie_speak", "data": { "textFrom": "$nodes.reply.content" } },
        ],
        "edges": [ { "source": "in", "target": "reply" }, { "source": "reply", "target": "say" } ],
    });
    let deps = RunDeps {
        instance_id: "test-desktop".into(),
        client: None,
        host: Some(host.clone()),
        app_id: None,
        http: reqwest::Client::new(),
        llm_endpoint: None,
        base_url: String::new(),
        registry: None,
        service_bases: HashMap::new(),
        default_ai_prefs: None,
        invoke_child_flow: None,
    };
    let opts = RunOptions {
        inputs: json!({ "text": "Thanks for calling, how can I help?" }),
        event: None,
        app: None,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        capabilities: vec!["connector.aokie.call.operatorSpeak".to_string()],
        flow_slug: "live-reply-test".to_string(),
        request_id_seed: "aokie-plugin-live".to_string(),
        progress: None,
        call_stack: vec!["test-root-flow".into()],
        run_id: None,
    };
    let outcome = execute_flow(&flow_json, &deps, &opts).await;
    // The mock call already ran to completion (Ended) above — so the REAL plugin
    // correctly typed-rejects the reply, exactly as it would once a real call has
    // hung up. This is not a mock/stub answering — it's the actual external
    // aokie-plugin.exe's real `require_call` state-machine check, reached through
    // the full real chain: execute_flow -> aokie_speak -> connector_request ->
    // connectors::dispatch -> the real process's `call.operatorSpeak` handler.
    assert_eq!(outcome.status, "error", "outcome: {outcome:?}");
    let e = outcome.error.expect("typed error");
    assert_eq!(e.code.as_str(), "node_failed");
    assert!(e.message.contains("ended") || e.message.contains("no active call"), "got: {}", e.message);
    assert_eq!(e.node_id.as_deref(), Some("say"));
    println!("[ok] real flow executor's aokie_speak reached the real plugin: {}", e.message);

    // Positive control: without the capability declared, the SAME flow fails
    // EARLIER and DIFFERENTLY (capability_denied, never reaching the plugin at
    // all) — proving the assertion above is exercising the real gate, not an
    // early bail-out that would pass regardless of what the plugin does.
    let opts_no_cap = RunOptions {
        inputs: json!({ "text": "x" }),
        event: None,
        app: None,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        capabilities: vec![],
        flow_slug: "live-reply-test".to_string(),
        request_id_seed: "aokie-plugin-live-no-cap".to_string(),
        progress: None,
        call_stack: vec!["test-root-flow".into()],
        run_id: None,
    };
    let outcome2 = execute_flow(&flow_json, &deps, &opts_no_cap).await;
    assert_eq!(outcome2.status, "error");
    assert_eq!(outcome2.error.unwrap().code.as_str(), "capability_denied");
    println!("[ok] positive control: missing capability -> capability_denied (never reached the plugin)");

    host.stop("aokie").await.expect("stop");
    let _ = std::fs::remove_dir_all(&data);
}

// ── Test 2: the FULL loop — a real plugin-emitted event drives the real ────────
// FlowRuntime, which matches the real "live-reply" binding shape (condition +
// inputMap, byte-for-byte the pack's), executes the real flow graph, and its
// aokie_speak node reaches the same real plugin process. A tiny axum stub
// stands in for FormLogic Cloud (flows/bindings/app-logic/run reserve+complete),
// exactly like `tests/flow_runtime.rs`'s established pattern.

#[derive(Clone, Default)]
struct Counters {
    reserves: Arc<AtomicU64>,
    completes: Arc<Mutex<Vec<Value>>>,
}

async fn stub_flows() -> Json<Value> {
    Json(json!({ "flows": [ {
        "id": "flow-live-reply", "slug": "live-reply", "enabled": true, "appId": null,
        "nodeCapabilities": ["connector.aokie.call.operatorSpeak"],
        "flowJson": {
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "say", "type": "aokie_speak", "data": { "textFrom": "$inputs.text" } },
                { "id": "out", "type": "output" },
            ],
            "edges": [ { "source": "in", "target": "say" }, { "source": "say", "target": "out" } ],
        },
    } ] }))
}

async fn stub_bindings() -> Json<Value> {
    // Byte-for-byte the shipped "live-reply" binding (aokieReceptionistPack.ts),
    // minus the settings/turns/llm_chat nodes (generic, not aokie-specific;
    // covered by other flow-node tests) — same event, connectorId, mode,
    // condition, and inputMap.
    Json(json!({ "bindings": [ {
        "id": "bind-live-reply", "event": "aokie.call.turn.final", "connectorId": "aokie",
        "flow": "live-reply", "flowDefinitionId": "flow-live-reply", "mode": "async",
        "condition": { "type": "expression",
            "expr": "event && event.data ? String(event.data.speaker || 'caller') === 'caller' : false" },
        "inputMap": { "callId": "$event.data.callId", "text": "$event.data.text" },
        "outputActions": [], "timeoutMs": 15000, "retryPolicy": null, "appId": null
    } ] }))
}

async fn stub_app_logic() -> Json<Value> {
    Json(json!({ "apps": [] }))
}

async fn stub_reserve(State(c): State<Counters>, Json(_body): Json<Value>) -> Json<Value> {
    let n = c.reserves.fetch_add(1, Ordering::SeqCst);
    Json(json!({ "run": { "runId": format!("run-{n}") }, "created": true }))
}

async fn stub_complete(State(c): State<Counters>, Path(_id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    c.completes.lock().unwrap().push(body);
    Json(json!({ "run": { "runId": "run-x" } }))
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
        .with_state(counters.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move { let _ = axum::serve(listener, app).await; });
    (addr, counters)
}

async fn wait_for(pred: impl Fn() -> bool, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if pred() { return true; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    pred()
}

#[tokio::test(flavor = "multi_thread")]
async fn real_plugin_event_drives_the_live_reply_flow_end_to_end() {
    let Some(exe) = find_aokie_plugin_exe() else {
        eprintln!("SKIP: aokie-plugin.exe not found — build it first: \
            cd aokie.com && cargo build -p aokie-plugin (set AOKIE_PLUGIN_EXE to override)");
        return;
    };
    let data = temp_data_dir("e2e");
    install_real_aokie_plugin(&data, &exe);
    let host = PluginHost::new(&data, true, EventBus::new());
    host.start("aokie").expect("start aokie-plugin");
    wait_running(&host, Duration::from_secs(15)).await;

    let (addr, counters) = spawn_stub().await;
    let config = FormLogicConfig { base_url: format!("http://{addr}"), api_key: "flk_test".into() };
    let runtime = FlowRuntime::new(host.clone(), None, config);
    runtime.start();
    assert!(runtime.status().linked);

    // Fire the REAL plugin's dev-mode scripted call — it emits real
    // `aokie.call.turn.final` events (caller then bot) on the real event bus,
    // exactly as a live call would. No manual envelope construction here.
    let sim = connectors::dispatch(&host, "aokie", &body("dongle.diagnostics", json!({ "simulate": "call" })))
        .await
        .expect("simulated call");
    assert_eq!(sim["ok"], true);

    // Exactly ONE reserve: the condition gates out the bot's own turn.final so
    // Aokie never replies to itself (mirrors the pack's documented intent).
    let reserved_once = wait_for(|| counters.reserves.load(Ordering::SeqCst) == 1, Duration::from_secs(10)).await;
    // Give a would-be second (erroneous) dispatch time to also land before asserting.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(counters.reserves.load(Ordering::SeqCst), 1,
        "condition must gate out the bot's own turn.final (reserved_once={reserved_once})");

    let completed = wait_for(|| !counters.completes.lock().unwrap().is_empty(), Duration::from_secs(10)).await;
    assert!(completed, "the live-reply run should complete (even if the plugin then typed-rejects the speak)");
    let bodies = counters.completes.lock().unwrap().clone();
    assert_eq!(bodies.len(), 1);
    let payload = &bodies[0];
    println!("[ok] flow-runs complete payload from the REAL end-to-end run: {payload}");
    // The flow DID reach the real plugin's call.operatorSpeak (the mock call from
    // the scripted lifecycle above has already ended by the time this async
    // binding executes) — status/error prove the whole chain fired for real,
    // landing on the exact same typed rejection as test 1.
    assert_eq!(payload["status"], json!("error"));
    let msg = payload["error"]["message"].as_str().unwrap_or_default();
    assert!(msg.contains("ended") || msg.contains("no active call"), "got: {msg}");
    assert_eq!(payload["error"]["nodeId"], json!("say"));

    host.stop("aokie").await.expect("stop");
    let _ = std::fs::remove_dir_all(&data);
}
