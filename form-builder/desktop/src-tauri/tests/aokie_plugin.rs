//! Aokie plugin integration — the built-in template + the REAL plugin binary.
//!
//! Covers Phase 4 end-to-end (AOKIE_PLUGIN_CONTRACT.md on top of the SDK
//! contract):
//!   - install the bundled Aokie TEMPLATE → `<data>/plugins/aokie/manifest.json`;
//!   - missing `aokie-plugin.exe` surfaces the distinct "binary … not
//!     installed" reason (never `crashed`), and `start` refuses with it;
//!   - version-compat problems in a (doctored) real manifest surface as
//!     `disabled` + reason — what the panel renders verbatim;
//!   - with the REAL `aokie-plugin` binary (izuc/aokie →
//!     `crates/aokie-plugin`): start → init → health ok → `phone.status` /
//!     `dongle.list` round-trips → dev `dongle.diagnostics {simulate:"call"}`
//!     → the scripted event lifecycle observed on the bus with the exact
//!     envelope + `aokie:<corr>:<step>:v1` idempotency keys → graceful stop.
//!
//! The real binary is located via `AOKIE_PLUGIN_EXE`, then the conventional
//! sibling checkout (`../../call_app/aokie/crates/target/debug/`), then a
//! best-effort `cargo build -p aokie-plugin` against that workspace. When
//! none of those produce it (e.g. CI without the aokie repo), the
//! binary-dependent test SKIPS with a printed note — the template/compat
//! tests above still run everywhere.

use std::path::{Path, PathBuf};
use std::time::Duration;

use f2i_companion_lib::connectors::{self, ConnectorRequestBody};
use f2i_companion_lib::events::EventBus;
use f2i_companion_lib::plugins::builtin::BUILTIN_PLUGIN_TEMPLATES;
use f2i_companion_lib::plugins::registry::{
    PluginHost, PluginHostHandle, PluginSnapshot, PluginState,
};

fn aokie_manifest_json() -> &'static str {
    BUILTIN_PLUGIN_TEMPLATES
        .iter()
        .find(|t| t.id == "aokie")
        .expect("aokie template bundled")
        .manifest_json
}

fn temp_data_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fl-aokie-it-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
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
        "connectorId": "aokie",
        "command": command,
        "payload": payload,
        "requestId": request_id,
        "timeoutMs": 10000
    }))
    .expect("request body")
}

/// Install template → missing-binary reason → start refused → binary file
/// appears → reason clears. No plugin process involved.
#[tokio::test(flavor = "multi_thread")]
async fn aokie_template_installs_and_flags_missing_binary() {
    let data = temp_data_dir("template");
    let host = PluginHost::new(&data, true, EventBus::new());

    // Offered as a built-in, not yet installed, compatible with this build.
    let builtins = host.builtin_plugins();
    let aokie = builtins.iter().find(|b| b.id == "aokie").expect("offered");
    assert!(!aokie.installed);
    assert_eq!(aokie.incompatible, None);

    // "Install Aokie plugin" → the bundled manifest materialises.
    host.install_builtin("aokie").expect("install template");
    let manifest_path = data.join("plugins").join("aokie").join("manifest.json");
    assert_eq!(
        std::fs::read_to_string(&manifest_path).expect("materialised"),
        aokie_manifest_json()
    );

    // Distinct state/reason: installed + "binary … not installed", NOT crashed.
    let snap = host.get("aokie").expect("registered");
    assert_eq!(snap.state, PluginState::Installed);
    let reason = snap.reason.as_deref().expect("missing-binary reason");
    assert!(reason.contains("not installed"), "{reason}");
    assert!(reason.contains("aokie-plugin.exe"), "{reason}");

    // start() refuses with the same actionable message (no crash loop).
    let err = host.start("aokie").expect_err("start must refuse");
    assert!(err.contains("not installed"), "{err}");
    assert_eq!(host.get("aokie").unwrap().state, PluginState::Installed);

    // The connector is declared but unavailable — the gateway says so.
    let cons = connectors::list(&host);
    let aokie_con = cons.iter().find(|c| c.id == "aokie").expect("declared");
    assert!(!aokie_con.available);
    let err = connectors::dispatch(&host, "aokie", &request("phone.status", serde_json::json!(null), "r1"))
        .await
        .expect_err("unavailable");
    assert_eq!(err.code, "connector_unavailable");

    // Once the executable exists the hint clears on the next scan.
    std::fs::write(
        data.join("plugins").join("aokie").join("aokie-plugin.exe"),
        b"",
    )
    .unwrap();
    let list = host.list();
    let snap = list.iter().find(|p| p.id == "aokie").unwrap();
    assert_eq!(snap.state, PluginState::Installed);
    assert_eq!(snap.reason, None);

    let _ = std::fs::remove_dir_all(&data);
}

/// Version-compat surfaced with the REAL manifest: the pristine bundle is
/// compatible; doctored pluginApiVersion / minDesktopVersion variants read
/// as `disabled` + the human reason the PluginsPanel shows verbatim.
#[tokio::test(flavor = "multi_thread")]
async fn real_aokie_manifest_version_compat_is_surfaced() {
    let data = temp_data_dir("compat");
    let host = PluginHost::new(&data, false, EventBus::new());
    host.install_builtin("aokie").expect("install");
    let manifest_path = data.join("plugins").join("aokie").join("manifest.json");

    // Pristine real manifest: NOT disabled (the missing-binary hint is the
    // only reason, and the state stays installed).
    let snap = host.get("aokie").unwrap();
    assert_eq!(snap.state, PluginState::Installed);
    assert_eq!(snap.plugin_api_version, Some(1));
    assert_eq!(snap.min_desktop_version.as_deref(), Some("0.1.0"));

    let mut doctored: serde_json::Value =
        serde_json::from_str(aokie_manifest_json()).expect("bundled parses");

    // A future protocol version → disabled + pluginApiVersion reason.
    doctored["pluginApiVersion"] = serde_json::json!(99);
    std::fs::write(&manifest_path, doctored.to_string()).unwrap();
    let list = host.list();
    let snap = list.iter().find(|p| p.id == "aokie").unwrap();
    assert_eq!(snap.state, PluginState::Disabled);
    assert!(
        snap.reason.as_deref().unwrap().contains("pluginApiVersion"),
        "{:?}",
        snap.reason
    );
    // A disabled plugin refuses to start, naming the reason.
    let err = host.start("aokie").expect_err("disabled");
    assert!(err.contains("pluginApiVersion"), "{err}");

    // A newer-desktop requirement → disabled + "requires FormLogic Desktop".
    doctored["pluginApiVersion"] = serde_json::json!(1);
    doctored["minDesktopVersion"] = serde_json::json!("999.0.0");
    std::fs::write(&manifest_path, doctored.to_string()).unwrap();
    let list = host.list();
    let snap = list.iter().find(|p| p.id == "aokie").unwrap();
    assert_eq!(snap.state, PluginState::Disabled);
    assert!(
        snap.reason
            .as_deref()
            .unwrap()
            .contains("requires FormLogic Desktop"),
        "{:?}",
        snap.reason
    );

    // Re-installing the built-in repairs the manifest → compatible again.
    host.install_builtin("aokie").expect("repair");
    let snap = host.get("aokie").unwrap();
    assert_eq!(snap.state, PluginState::Installed);

    let _ = std::fs::remove_dir_all(&data);
}

// ---------------------------------------------------------------------------
// Real-binary end-to-end
// ---------------------------------------------------------------------------

/// Locate (or quickly build) the real aokie-plugin binary. None ⇒ skip.
fn locate_real_aokie_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("AOKIE_PLUGIN_EXE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
        eprintln!("AOKIE_PLUGIN_EXE set but not a file: {}", p.display());
    }
    // Conventional checkouts of izuc/aokie relative to this crate
    // (formlogic-app/form-builder/desktop/src-tauri):
    //  - <parent-of-formlogic-app>/aokie
    //  - <parent-of-formlogic-app>/call_app/aokie (repos layout)
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_parent = manifest.join("..").join("..").join("..").join("..");
    let candidates = [
        repo_parent.join("aokie").join("crates"),
        repo_parent.join("call_app").join("aokie").join("crates"),
    ];
    let exe = if cfg!(windows) {
        "aokie-plugin.exe"
    } else {
        "aokie-plugin"
    };
    for crates in candidates {
        let built = crates.join("target").join("debug").join(exe);
        if built.is_file() {
            return Some(built);
        }
        let workspace = crates.join("Cargo.toml");
        if workspace.is_file() {
            eprintln!("building aokie-plugin from {} …", workspace.display());
            let ok = std::process::Command::new("cargo")
                .args(["build", "-p", "aokie-plugin", "--manifest-path"])
                .arg(&workspace)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok && built.is_file() {
                return Some(built);
            }
        }
    }
    None
}

/// Full pipeline against the REAL aokie-plugin process: install template →
/// drop the binary in → start → health → connector round-trips → simulated
/// call lifecycle on the event bus (envelope + idempotency-key contract) →
/// stop.
#[tokio::test(flavor = "multi_thread")]
async fn real_aokie_plugin_end_to_end() {
    let Some(binary) = locate_real_aokie_binary() else {
        eprintln!(
            "SKIP real_aokie_plugin_end_to_end: aokie-plugin binary not found — \
             set AOKIE_PLUGIN_EXE or check out izuc/aokie as a sibling repo"
        );
        return;
    };

    let data = temp_data_dir("e2e");
    // dev_mode=true → the plugin gets FORMLOGIC_DEV_MODE=1 (simulate works).
    let host = PluginHost::new(&data, true, EventBus::new());

    // Install the template, then the binary under the manifest's entry name.
    host.install_builtin("aokie").expect("install template");
    let manifest: serde_json::Value = serde_json::from_str(aokie_manifest_json()).unwrap();
    let entry_command = manifest["entry"]["command"].as_str().unwrap();
    let plugin_dir = data.join("plugins").join("aokie");
    std::fs::copy(&binary, plugin_dir.join(entry_command)).expect("copy real binary");

    // The missing-binary hint is gone now that the executable exists.
    let list = host.list();
    let snap = list.iter().find(|p| p.id == "aokie").unwrap();
    assert_eq!(snap.state, PluginState::Installed);
    assert_eq!(snap.reason, None);

    // Subscribe BEFORE anything can emit so no event is missed.
    let mut events = host.events().subscribe();

    host.start("aokie").expect("start");
    let snap = wait_for(&host, "aokie", "running", Duration::from_secs(20), |s| {
        s.state == PluginState::Running
    })
    .await;
    assert!(snap.pid.is_some());

    // Health probe → ok, recorded.
    let health = host.probe_health("aokie").await.expect("health");
    assert_eq!(health["status"], "ok");
    assert!(host.last_health("aokie").unwrap().unwrap().ok);

    // phone.status round-trip (fresh config ⇒ unpaired), requestId echoed.
    let ok = connectors::dispatch(&host, "aokie", &request("phone.status", serde_json::json!(null), "req-1"))
        .await
        .expect("phone.status");
    assert_eq!(ok["ok"], true);
    assert_eq!(ok["data"]["paired"], false);
    assert_eq!(ok["requestId"], "req-1");

    // dongle.list serves the static compatibility catalog.
    let ok = connectors::dispatch(&host, "aokie", &request("dongle.list", serde_json::json!(null), "req-2"))
        .await
        .expect("dongle.list");
    let dongles = ok["data"]["dongles"].as_array().expect("dongles array");
    assert!(!dongles.is_empty(), "catalog is non-empty");

    // A command outside the declared surface never reaches the plugin.
    let err = connectors::dispatch(&host, "aokie", &request("retention.get", serde_json::json!(null), "req-3"))
        .await
        .expect_err("undeclared command");
    assert_eq!(err.code, "capability_denied");

    // Dev simulate: the scripted lifecycle (contract §4).
    let ok = connectors::dispatch(
        &host,
        "aokie",
        &request("dongle.diagnostics", serde_json::json!({"simulate": "call"}), "req-4"),
    )
    .await
    .expect("simulate");
    assert_eq!(ok["data"]["simulated"], "call");
    let corr = ok["data"]["correlationId"].as_str().expect("correlationId");
    assert!(corr.starts_with("call_"), "{corr}");
    assert_eq!(ok["data"]["outbox"]["dead"], 0);

    // The full scripted sequence lands on the bus, in order, with the exact
    // envelope + `aokie:<corr>:<step>:v1` idempotency keys (call.* events
    // drop the `call.` prefix; turn events carry the turn index).
    let expected: Vec<(&str, String)> = vec![
        ("aokie.dongle.detected", format!("aokie:{corr}:dongle.detected:v1")),
        ("aokie.dongle.ready", format!("aokie:{corr}:dongle.ready:v1")),
        ("aokie.call.incoming", format!("aokie:{corr}:incoming:v1")),
        ("aokie.call.answered", format!("aokie:{corr}:answered:v1")),
        ("aokie.call.turn.final", format!("aokie:{corr}:turn.1.final:v1")),
        ("aokie.call.turn.final", format!("aokie:{corr}:turn.2.final:v1")),
        ("aokie.call.ended", format!("aokie:{corr}:ended:v1")),
        ("aokie.sms.received", format!("aokie:{corr}:sms.received:v1")),
    ];
    for (name, key) in &expected {
        let ev = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {name}"))
            .expect("bus open");
        assert_eq!(ev.name, *name);
        assert_eq!(ev.idempotency_key, *key);
        let envelope: serde_json::Value = serde_json::from_str(&ev.json).expect("envelope json");
        assert_eq!(envelope["schemaVersion"], 1);
        assert_eq!(envelope["source"], "aokie");
        assert_eq!(envelope["pluginId"], "aokie");
        assert_eq!(envelope["correlationId"], *corr);
        assert_eq!(envelope["idempotencyKey"], *key);
        let at = envelope["occurredAt"].as_str().expect("occurredAt");
        assert!(at.ends_with('Z') && at.contains('T'), "ISO-8601 UTC: {at}");
    }
    // Spot-check payloads carried the transcript / caller data.
    // (The last event was sms.received; its body is the mock confirmation.)

    // The simulated call is queryable afterwards (ended, 2 turns).
    let ok = connectors::dispatch(&host, "aokie", &request("call.current", serde_json::json!(null), "req-5"))
        .await
        .expect("call.current");
    assert_eq!(ok["data"]["call"]["state"], "ended");
    assert_eq!(ok["data"]["call"]["turns"], 2);
    assert_eq!(ok["data"]["call"]["correlationId"], corr);

    // Graceful stop: plugin.shutdown honored, slot lands stopped.
    host.stop("aokie").await.expect("stop");
    let snap = host.get("aokie").expect("known");
    assert_eq!(snap.state, PluginState::Stopped);
    assert!(snap.pid.is_none());

    let _ = std::fs::remove_dir_all(&data);
}
