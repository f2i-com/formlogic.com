//! Plugin-host integration tests — a REAL plugin process end-to-end.
//!
//! Installs the `mock-plugin` binary (built by cargo for this crate; located
//! via `CARGO_BIN_EXE_mock-plugin`) into a temp `<data>/plugins/mock/` dir,
//! then exercises the whole SDK contract surface: scan → start → init
//! handshake → health probe → connector request round-trip → event on the
//! bus → capability_denied for an undeclared command → crash + auto-restart
//! → graceful stop.

use std::path::{Path, PathBuf};
use std::time::Duration;

use formlogic_desktop_lib::connectors::{self, ConnectorRequestBody};
use formlogic_desktop_lib::events::EventBus;
use formlogic_desktop_lib::plugins::registry::{
    PluginHost, PluginHostHandle, PluginSnapshot, PluginState,
};

/// The manifest under test: echo.ping + echo.exit declared AND covered by
/// capabilities; mock.tick declared as its event. echo.nope is deliberately
/// NOT declared (capability_denied path).
const MOCK_MANIFEST: &str = r#"{
  "schemaVersion": 1,
  "id": "mock",
  "name": "Mock plugin",
  "version": "0.1.0",
  "pluginApiVersion": 1,
  "entry": { "kind": "process", "command": "COMMAND" },
  "capabilities": ["connector.mock.echo.*"],
  "connectors": [
    { "id": "mock", "name": "Mock connector", "commands": ["echo.ping", "echo.exit"] }
  ],
  "events": ["mock.tick"]
}"#;

fn temp_data_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fl-plugin-it-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Copy the built mock-plugin binary into `<data>/plugins/mock/` and write
/// the manifest with the binary's real file name as entry.command.
fn install_mock_plugin(data_dir: &Path) {
    let built = PathBuf::from(env!("CARGO_BIN_EXE_mock-plugin"));
    let exe_name = built
        .file_name()
        .and_then(|n| n.to_str())
        .expect("mock-plugin exe name")
        .to_string();
    let plugin_dir = data_dir.join("plugins").join("mock");
    std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
    std::fs::copy(&built, plugin_dir.join(&exe_name)).expect("copy mock-plugin");
    std::fs::write(
        plugin_dir.join("manifest.json"),
        MOCK_MANIFEST.replace("COMMAND", &exe_name),
    )
    .expect("write manifest");
}

async fn wait_for(
    host: &PluginHostHandle,
    id: &str,
    what: &str,
    timeout: Duration,
    pred: impl Fn(&PluginSnapshot) -> bool,
) -> PluginSnapshot {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(snap) = host.get(id) {
            if pred(&snap) {
                return snap;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!(
                    "timed out waiting for {what}: state={:?} reason={:?} attempts={}",
                    snap.state, snap.reason, snap.restart_attempts
                );
            }
        } else if tokio::time::Instant::now() >= deadline {
            panic!("timed out waiting for {what}: plugin {id:?} unknown");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn request(command: &str, payload: serde_json::Value, request_id: &str) -> ConnectorRequestBody {
    serde_json::from_value(serde_json::json!({
        "connectorId": "mock",
        "command": command,
        "payload": payload,
        "requestId": request_id,
        "timeoutMs": 5000
    }))
    .expect("request body")
}

#[tokio::test(flavor = "multi_thread")]
async fn mock_plugin_full_lifecycle() {
    let data = temp_data_dir("lifecycle");
    install_mock_plugin(&data);
    // dev_mode=true so the mock emits its periodic mock.tick events.
    let host = PluginHost::new(&data, true, EventBus::new());

    // Discovered as installed, surface intact.
    let list = host.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "mock");
    assert_eq!(list[0].state, PluginState::Installed);
    assert_eq!(list[0].connectors.len(), 1);

    // Subscribe BEFORE start so the first tick can't be missed.
    let mut events = host.events().subscribe();

    host.start("mock").expect("start");
    let snap = wait_for(&host, "mock", "running", Duration::from_secs(15), |s| {
        s.state == PluginState::Running
    })
    .await;
    assert!(snap.pid.is_some());
    assert!(snap.started_at.is_some());

    // Double-start is refused while running.
    assert!(host.start("mock").is_err());

    // On-demand health probe → ok, and recorded as the last report.
    let health = host.probe_health("mock").await.expect("health");
    assert_eq!(health["status"], "ok");
    let last = host.last_health("mock").expect("known").expect("recorded");
    assert!(last.ok);
    assert_eq!(last.status, "ok");

    // Connector listing: mock is available while running.
    let cons = connectors::list(&host);
    assert_eq!(cons.len(), 1);
    assert_eq!(cons[0].id, "mock");
    assert!(cons[0].available);
    let status = connectors::status(&host, "mock").expect("status");
    assert!(status.available);
    assert_eq!(status.plugin_id, "mock");

    // Round-trip: echo.ping returns the payload, requestId echoed.
    let body = request("echo.ping", serde_json::json!({ "hello": "world" }), "req-1");
    let ok = connectors::dispatch(&host, "mock", &body).await.expect("echo");
    assert_eq!(ok["ok"], true);
    assert_eq!(ok["data"]["echo"]["hello"], "world");
    assert_eq!(ok["requestId"], "req-1");

    // Undeclared command → capability_denied BEFORE reaching the plugin.
    let body = request("echo.nope", serde_json::json!(null), "req-2");
    let err = connectors::dispatch(&host, "mock", &body).await.unwrap_err();
    assert_eq!(err.code, "capability_denied");

    // Unknown connector → connector_missing.
    let body = request("echo.ping", serde_json::json!(null), "req-3");
    let err = connectors::dispatch(&host, "nope", &serde_json::from_value(
        serde_json::json!({ "command": "echo.ping" })).unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.code, "connector_missing");
    drop(body);

    // A mock.tick event arrives on the bus (dev mode, ~200ms first tick).
    let ev = tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("event within 10s")
        .expect("bus open");
    assert_eq!(ev.name, "mock.tick");
    let envelope: serde_json::Value = serde_json::from_str(&ev.json).expect("envelope json");
    assert_eq!(envelope["source"], "mock");
    assert_eq!(envelope["schemaVersion"], 1);
    assert!(!ev.idempotency_key.is_empty());

    // The plugin's log.emit landed in the ring buffer.
    let logs = host.logs("mock", None).expect("logs");
    assert!(
        logs.iter().any(|l| l.text.contains("mock plugin initialized")),
        "log.emit line missing from ring"
    );

    // Crash path: echo.exit kills the process mid-request. The in-flight
    // request surfaces as a typed failure, the plugin goes crashed, and the
    // supervisor auto-restarts it (attempt 1) back to running.
    let body = request("echo.exit", serde_json::json!(null), "req-4");
    let err = connectors::dispatch(&host, "mock", &body).await.unwrap_err();
    assert!(
        err.code == "connector_unavailable" || err.code == "command_failed",
        "crash mid-request surfaces as a transport failure, got {}",
        err.code
    );
    let snap = wait_for(
        &host,
        "mock",
        "auto-restart back to running",
        Duration::from_secs(20),
        |s| s.state == PluginState::Running && s.restart_attempts >= 1,
    )
    .await;
    assert!(snap.restart_attempts >= 1, "restart was counted");

    // Graceful stop: plugin.shutdown honored, final state stopped.
    host.stop("mock").await.expect("stop");
    let snap = host.get("mock").expect("known");
    assert_eq!(snap.state, PluginState::Stopped);
    assert!(snap.pid.is_none());

    // Stopped connector now reads unavailable.
    let body = request("echo.ping", serde_json::json!(null), "req-5");
    let err = connectors::dispatch(&host, "mock", &body).await.unwrap_err();
    assert_eq!(err.code, "connector_unavailable");

    // stop is idempotent.
    host.stop("mock").await.expect("stop again");

    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_cycles_the_process() {
    let data = temp_data_dir("restart");
    install_mock_plugin(&data);
    let host = PluginHost::new(&data, false, EventBus::new());

    host.start("mock").expect("start");
    let first = wait_for(&host, "mock", "running", Duration::from_secs(15), |s| {
        s.state == PluginState::Running
    })
    .await;
    let first_pid = first.pid.expect("pid");

    host.restart("mock").await.expect("restart");
    let second = wait_for(
        &host,
        "mock",
        "running again after restart",
        Duration::from_secs(15),
        |s| s.state == PluginState::Running && s.pid != Some(first_pid),
    )
    .await;
    assert_ne!(second.pid, Some(first_pid), "a NEW process was spawned");

    host.stop("mock").await.expect("stop");
    let _ = std::fs::remove_dir_all(&data);
}
