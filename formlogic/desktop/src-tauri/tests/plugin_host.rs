//! Plugin-host integration tests — a REAL plugin process end-to-end.
//!
//! Installs the `mock-plugin` binary (built by cargo for this crate; located
//! via `CARGO_BIN_EXE_mock-plugin`) into a temp `<data>/plugins/mock/` dir,
//! then exercises the whole SDK contract surface: scan → start → init
//! handshake → health probe → connector request round-trip → event on the
//! bus → capability_denied for an undeclared command → crash + auto-restart
//! → graceful stop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use formlogic_desktop_lib::connectors::{self, ConnectorRequestBody};
use formlogic_desktop_lib::events::EventBus;
use formlogic_desktop_lib::flows::runner::{
    execute_flow, RunDeps, RunOptions, DEFAULT_TIMEOUT_MS,
};
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

const SPEAKING_MOCK_MANIFEST: &str = r#"{
  "schemaVersion": 1,
  "id": "mock",
  "name": "Speaking mock plugin",
  "version": "0.1.0",
  "pluginApiVersion": 1,
  "entry": { "kind": "process", "command": "COMMAND" },
  "capabilities": ["connector.aokie.call.operatorSpeak"],
  "connectors": [
    { "id": "aokie", "name": "Aokie test connector", "commands": ["call.operatorSpeak"] }
  ],
  "events": []
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

fn install_speaking_mock_plugin(data_dir: &Path) {
    let built = PathBuf::from(env!("CARGO_BIN_EXE_mock-plugin"));
    let exe_name = built
        .file_name()
        .and_then(|name| name.to_str())
        .expect("mock-plugin exe name")
        .to_string();
    let plugin_dir = data_dir.join("plugins").join("mock");
    std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
    std::fs::copy(&built, plugin_dir.join(&exe_name)).expect("copy mock-plugin");
    std::fs::write(
        plugin_dir.join("manifest.json"),
        SPEAKING_MOCK_MANIFEST.replace("COMMAND", &exe_name),
    )
    .expect("write speaking manifest");
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

#[tokio::test(flavor = "multi_thread")]
async fn restart_if_active_cycles_only_an_active_plugin() {
    let data = temp_data_dir("restart-if-active");
    install_mock_plugin(&data);
    let host = PluginHost::new(&data, false, EventBus::new());

    assert!(!host
        .restart_if_active("not-installed")
        .await
        .expect("unknown plugin is inactive"));
    assert!(!host
        .restart_if_active("mock")
        .await
        .expect("inactive check"));
    assert_eq!(
        host.get("mock").expect("known plugin").state,
        PluginState::Installed,
        "a roster refresh must not start an inactive plugin"
    );

    host.start("mock").expect("start");
    let first = wait_for(&host, "mock", "running", Duration::from_secs(15), |s| {
        s.state == PluginState::Running
    })
    .await;
    let first_pid = first.pid.expect("first pid");

    assert!(host
        .restart_if_active("mock")
        .await
        .expect("active restart"));
    let second = wait_for(
        &host,
        "mock",
        "running after conditional restart",
        Duration::from_secs(15),
        |s| s.state == PluginState::Running && s.pid != Some(first_pid),
    )
    .await;
    assert_ne!(second.pid, Some(first_pid));

    host.stop("mock").await.expect("stop");
    assert!(!host.restart_if_active("mock").await.expect("stopped check"));
    assert_eq!(
        host.get("mock").expect("known plugin").state,
        PluginState::Stopped,
        "conditional refresh must preserve an explicit stop"
    );

    let _ = std::fs::remove_dir_all(&data);
}

/// PLG-102/105/107/108 — the full UI-driven lifecycle against the SAMPLE echo
/// plugin (the mock-plugin binary), never live Aokie: install FROM A FOLDER
/// (staging + validation + collision + atomic commit), start, disable
/// (durable, survives rescan), enable, then uninstall WITH data purge.
#[tokio::test(flavor = "multi_thread")]
async fn install_from_folder_then_disable_enable_and_purge() {
    let data = temp_data_dir("install-lifecycle");
    // A SOURCE folder outside the plugins root — the shape a user picks.
    let built = PathBuf::from(env!("CARGO_BIN_EXE_mock-plugin"));
    let exe_name = built.file_name().and_then(|n| n.to_str()).unwrap().to_string();
    let src = data.join("mock-src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::copy(&built, src.join(&exe_name)).unwrap();
    std::fs::write(
        src.join("manifest.json"),
        MOCK_MANIFEST.replace("COMMAND", &exe_name),
    )
    .unwrap();

    let host = PluginHost::new(&data, true, EventBus::new());
    assert!(host.list().is_empty(), "nothing installed yet");

    // Install from the folder (sync host method the HTTP handler calls).
    let id = host
        .install_from_source(&formlogic_desktop_lib::plugins::install::InstallSource::Folder(
            src.clone(),
        ))
        .expect("install from folder");
    assert_eq!(id, "mock");
    let snap = host.get("mock").expect("installed");
    assert_eq!(snap.state, PluginState::Installed);
    assert!(host.plugins_root().join("mock").join(&exe_name).is_file());

    // A second install of the SAME id is an UPDATE — allowed while stopped.
    host.install_from_source(&formlogic_desktop_lib::plugins::install::InstallSource::Folder(
        src.clone(),
    ))
    .expect("reinstall (update) allowed while stopped");

    // Start the real process, then seed some plugin data.
    host.start("mock").expect("start");
    wait_for(&host, "mock", "running", Duration::from_secs(15), |s| {
        s.state == PluginState::Running
    })
    .await;
    let data_dir = data.join("plugin-data").join("mock");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(data_dir.join("state.json"), "{}").unwrap();

    // An UPDATE is refused while running (files would be locked).
    assert!(
        host.install_from_source(
            &formlogic_desktop_lib::plugins::install::InstallSource::Folder(src.clone())
        )
        .is_err(),
        "update refused while the plugin is running"
    );

    // Disable → stops the process + persists the opt-out across a rescan.
    host.set_enabled("mock", false).await.expect("disable");
    assert_eq!(host.get("mock").unwrap().state, PluginState::Disabled);
    host.scan();
    assert_eq!(
        host.get("mock").unwrap().state,
        PluginState::Disabled,
        "disable survives a rescan"
    );

    // Enable → back to installed (a fresh host also reads it enabled).
    host.set_enabled("mock", true).await.expect("enable");
    assert_ne!(host.get("mock").unwrap().state, PluginState::Disabled);

    // Uninstall WITH purge removes both the code AND the data dir.
    host.uninstall("mock", true).await.expect("uninstall+purge");
    assert!(host.get("mock").is_none(), "slot forgotten");
    assert!(!host.plugins_root().join("mock").exists(), "code removed");
    assert!(!data_dir.exists(), "purge removed the data dir");

    let _ = std::fs::remove_dir_all(&data);
}

/// Phase 2 exit gate (PLG-201/203/205/206) — a v2 plugin dynamically
/// contributes UI, owns a service, binds to a test app, and disappears cleanly
/// when disabled. Exercised through the real install pipeline with the SAMPLE
/// echo plugin (never live Aokie).
#[tokio::test(flavor = "multi_thread")]
async fn v2_plugin_contributes_ui_owns_service_binds_and_disables_cleanly() {
    use formlogic_desktop_lib::services::registry::{Registry, RegistryHandle};
    use std::sync::{Arc, Mutex};

    let data = temp_data_dir("v2-contrib");
    let built = PathBuf::from(env!("CARGO_BIN_EXE_mock-plugin"));
    let exe_name = built.file_name().and_then(|n| n.to_str()).unwrap().to_string();

    // Build a source folder: mock exe + a v2 manifest with ui + an owned
    // service template file.
    let src = data.join("src");
    std::fs::create_dir_all(src.join("services")).unwrap();
    std::fs::copy(&built, src.join(&exe_name)).unwrap();
    std::fs::write(
        src.join("services").join("mock-svc.json"),
        r#"{"id":"mock-svc","name":"Mock Service","description":"","category":"Speech",
            "defaultPort":19191,"run":{"command":"nonexistent.exe","args":[]}}"#,
    )
    .unwrap();
    let manifest = format!(
        r#"{{
          "schemaVersion": 2, "id": "mock", "name": "Mock", "version": "1.0.0",
          "entry": {{ "kind": "process", "command": "{exe_name}" }},
          "capabilities": ["connector.mock.echo.*"],
          "connectors": [{{ "id": "mock", "name": "Mock", "commands": ["echo.ping"] }}],
          "events": ["mock.tick"],
          "ui": {{
            "nav": [{{ "id": "home", "label": "Mock", "icon": "phone" }}],
            "overview": [{{ "id": "hero", "kind": "hero", "title": "Mock",
              "bind": {{ "headline": "$health.status", "cta": {{ "label": "Open", "nav": "home" }} }} }}],
            "statusCards": [{{ "id": "st", "title": "Echo",
              "poll": {{ "command": "echo.ping" }}, "fields": [{{ "label": "H", "path": "echo.hello" }}] }}]
          }},
          "services": [{{ "templateFile": "services/mock-svc.json" }}],
          "commands": {{ "journalled": ["echo.ping"] }},
          "data": {{ "externalInventory": [{{ "path": "%APPDATA%/mock", "label": "Mock data" }}] }}
        }}"#
    );
    std::fs::write(src.join("manifest.json"), manifest).unwrap();

    // Wire a real services registry (Registry::init seeds templates/scripts
    // dirs) so owned templates install.
    let services: RegistryHandle = Arc::new(Mutex::new(
        Registry::init(data.clone(), data.join("models"), vec![]).unwrap(),
    ));

    let host = PluginHost::new(&data, false, EventBus::new());
    host.set_services_registry(services.clone());

    // Install from the folder.
    let id = host
        .install_from_source(&formlogic_desktop_lib::plugins::install::InstallSource::Folder(
            src.clone(),
        ))
        .expect("install v2");
    assert_eq!(id, "mock");

    // PLG-203: the snapshot carries the UI contributions.
    let snap = host.get("mock").expect("installed");
    assert_eq!(snap.schema_version, 2);
    let ui = snap.ui.expect("ui contributions");
    assert_eq!(ui.nav.len(), 1);
    assert_eq!(ui.nav[0].id, "home");
    assert_eq!(ui.overview[0].kind, "hero");
    assert_eq!(snap.external_data.len(), 1, "external-data inventory surfaced");

    // PLG-206: the owned service is installed + stamped.
    {
        let reg = services.lock().unwrap();
        let s = reg.snapshot().services.into_iter().find(|s| s.id == "mock-svc");
        let s = s.expect("owned service installed");
        assert_eq!(s.owner.as_deref(), Some("mock"));
    }

    // PLG-205: bind the connector to a test app; check_dispatch enforces it.
    let bindings = host.bindings();
    {
        let mut b = bindings.lock().unwrap();
        let binding = b.bind("mock", "mock", "test-app", None, None, "t0");
        assert_eq!(binding.epoch, 1);
        // Matching app allowed; a different app is refused.
        assert!(b.check_dispatch("mock", "mock", Some(("test-app", Some(1)))).is_ok());
        assert!(b.check_dispatch("mock", "mock", Some(("other-app", None))).is_err());
        // No app context (legacy relay) → always allowed.
        assert!(b.check_dispatch("mock", "mock", None).is_ok());
    }

    // PLG-205/206: DISABLE removes UI contributions + stops owned services.
    host.set_enabled("mock", false).await.expect("disable");
    let snap = host.get("mock").expect("still known");
    assert_eq!(snap.state, PluginState::Disabled);
    {
        // The owned service is still installed but not running (disable stops it).
        let reg = services.lock().unwrap();
        let s = reg.snapshot().services.into_iter().find(|s| s.id == "mock-svc").unwrap();
        assert_ne!(s.status, formlogic_desktop_lib::services::registry::ServiceStatus::Running);
    }

    // Re-enable, then uninstall — owned service + binding are removed.
    host.set_enabled("mock", true).await.expect("enable");
    host.uninstall("mock", false).await.expect("uninstall");
    assert!(host.get("mock").is_none());
    {
        let reg = services.lock().unwrap();
        assert!(reg.snapshot().services.iter().all(|s| s.id != "mock-svc"), "owned service removed");
    }
    assert!(bindings.lock().unwrap().list().is_empty(), "bindings forgotten");

    let _ = std::fs::remove_dir_all(&data);
}

/// PLG-104 — install refuses a plugin whose connector id collides with an
/// already-installed plugin (deterministic first-match routing would otherwise
/// be ambiguous). Exercised through the real install pipeline.
#[tokio::test(flavor = "multi_thread")]
async fn install_refuses_connector_collision() {
    let data = temp_data_dir("install-collision");
    install_mock_plugin(&data); // owns connector "mock"
    let host = PluginHost::new(&data, false, EventBus::new());
    assert_eq!(host.get("mock").unwrap().state, PluginState::Installed);

    // A DIFFERENT plugin folder that also declares connector id "mock".
    let built = PathBuf::from(env!("CARGO_BIN_EXE_mock-plugin"));
    let exe_name = built.file_name().and_then(|n| n.to_str()).unwrap().to_string();
    let src = data.join("clash-src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::copy(&built, src.join(&exe_name)).unwrap();
    let clash_manifest = format!(
        "{{\"schemaVersion\":1,\"id\":\"clash\",\"name\":\"Clash\",\"version\":\"1.0.0\",\
         \"entry\":{{\"kind\":\"process\",\"command\":\"{exe_name}\"}},\
         \"connectors\":[{{\"id\":\"mock\",\"name\":\"Mock\",\"commands\":[\"echo.ping\"]}}]}}"
    );
    std::fs::write(src.join("manifest.json"), clash_manifest).unwrap();

    let err = host
        .install_from_source(&formlogic_desktop_lib::plugins::install::InstallSource::Folder(src))
        .expect_err("collision must refuse");
    assert!(err.contains("connector id"), "reason names the collision: {err}");
    assert!(host.get("clash").is_none(), "the colliding plugin was not installed");

    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn operator_speak_request_id_is_stable_across_retry_and_text_is_unchanged() {
    let data = temp_data_dir("speak-idempotency");
    install_speaking_mock_plugin(&data);
    let host = PluginHost::new(&data, false, EventBus::new());
    host.start("mock").expect("start");
    wait_for(&host, "mock", "running", Duration::from_secs(15), |snapshot| {
        snapshot.state == PluginState::Running
    })
    .await;

    let caller_text = "Keep punctuation: \"yes\" & no — caller's text.\nSecond line";
    let flow = serde_json::json!({
        "nodes": [{
            "id": "say",
            "type": "aokie_speak",
            "data": { "textFrom": "$inputs.callerText" }
        }],
        "edges": []
    });
    let deps = RunDeps {
        client: None,
        host: Some(host.clone()),
        app_id: None,
        http: reqwest::Client::new(),
        llm_endpoint: None,
        base_url: String::new(),
        registry: None,
        service_bases: HashMap::new(),
    };
    let mut opts = RunOptions {
        inputs: serde_json::json!({ "callerText": caller_text }),
        event: None,
        app: None,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        capabilities: vec!["connector.aokie.call.operatorSpeak".into()],
        flow_slug: "retry-speech".into(),
        request_id_seed: "logical-run-42".into(),
    };

    // Re-running with the same RunOptions is exactly what retryPolicy does.
    // Both attempts must reach the real stdio plugin with one request id and
    // the caller's text byte-for-byte unchanged.
    let first = execute_flow(&flow, &deps, &opts).await;
    let retry = execute_flow(&flow, &deps, &opts).await;
    assert_eq!(first.status, "done", "first attempt: {first:?}");
    assert_eq!(retry.status, "done", "retry attempt: {retry:?}");
    let first = first.result.expect("first result");
    let retry = retry.result.expect("retry result");
    assert_eq!(first["requestId"], retry["requestId"]);
    assert_eq!(first["data"]["text"], caller_text);
    assert_eq!(retry["data"]["payload"]["text"], caller_text);

    // A separate logical execution must not be deduped as the old speech.
    opts.request_id_seed = "logical-run-43".into();
    let next = execute_flow(&flow, &deps, &opts)
        .await
        .result
        .expect("next result");
    assert_ne!(first["requestId"], next["requestId"]);

    host.stop("mock").await.expect("stop");
    let _ = std::fs::remove_dir_all(&data);
}
