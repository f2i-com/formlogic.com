//! Which pages reach the runtime's commands at all.
//!
//! The commands `run()` registers are called here through Tauri's own IPC entry point on its
//! mock runtime, under this crate's capability and permission files, so a call is judged the
//! way the real window judges it: first Tauri's allowlist for the calling page, then the
//! command's own check of that page's signed manifest. A Tauri release that changes the first
//! half shows up here, which the unit tests in src/ cannot see.

use native_runtime_lib::test_support;
use serde_json::{json, Value};
use tauri::test::MockRuntime;

const PLATFORM_APP: &str = "https://formlogic.com/app/demo";
const SUBDOMAIN_APP: &str = "https://eu.formlogic.com/app/demo";
const UNLISTED_APP: &str = "https://apps.example.org/app/demo";
const SHELL_PAGE: &str = if cfg!(any(windows, target_os = "android")) {
    "http://tauri.localhost/index.html"
} else {
    "tauri://localhost/index.html"
};

const EVERY_COMMAND: [&str; 11] = [
    "runtime_info",
    "runtime_ready",
    "connector_list",
    "connector_status",
    "connector_request",
    "sync_enqueue",
    "sync_get_queue",
    "sync_flush",
    "sync_ack",
    "sync_fail",
    "pending_deep_link",
];

struct Runtime {
    app: tauri::App<MockRuntime>,
    window: tauri::WebviewWindow<MockRuntime>,
    dir: std::path::PathBuf,
}

impl Runtime {
    fn open(tag: &str) -> Self {
        let app = tauri::test::mock_builder()
            .invoke_handler(test_support::commands())
            .build(tauri::generate_context!())
            .expect("the runtime builds on the mock runtime");
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fl-bridge-ipc-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        test_support::manage_state(&app, &dir);
        // The label `run()` gives its window, which is what capabilities/ names.
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("the main window");
        Runtime { app, window, dir }
    }

    /// One call from the page at `page`, which is also what the window is showing.
    fn call(&self, page: &str, command: &str, args: Value) -> Result<Value, String> {
        let url: tauri::Url = page.parse().unwrap();
        self.window.navigate(url.clone()).unwrap();
        tauri::test::get_ipc_response(
            &self.window,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url,
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
        .map_err(|error| error.as_str().map(str::to_string).unwrap_or_else(|| error.to_string()))
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The `code` of a command's own typed refusal.
fn code(error: &str) -> String {
    let parsed: Value = serde_json::from_str(error).unwrap_or_else(|_| panic!("not a typed error: {error}"));
    parsed["code"].as_str().expect("a typed error has a code").to_string()
}

/// Tauri's refusal, as against a command that ran and answered with a typed error.
fn refused_by_the_allowlist(result: &Result<Value, String>) -> bool {
    matches!(result, Err(message) if !message.starts_with('{') && message.contains("not allowed"))
}

#[test]
fn a_hosted_app_on_an_approved_origin_reaches_the_bridge() {
    let runtime = Runtime::open("approved");
    let info = runtime.call(PLATFORM_APP, "runtime_info", json!({})).expect("runtime_info");
    assert_eq!(info["name"], "FormLogic Native Runtime");

    // Before its manifest is verified the commands run, and refuse in their own words.
    let request = json!({ "connectorId": "vehicle", "command": "status.read" });
    let early = runtime.call(PLATFORM_APP, "connector_request", request.clone()).unwrap_err();
    assert_eq!(code(&early), "origin_denied");
    let early = runtime.call(PLATFORM_APP, "sync_get_queue", json!({})).unwrap_err();
    assert_eq!(code(&early), "origin_denied");
    assert_eq!(runtime.call(PLATFORM_APP, "connector_list", json!({})).unwrap(), json!([]));

    test_support::mark_verified(&runtime.app, "https://formlogic.com", "demo", "app-demo", &["vehicle.status.read"]);
    assert_eq!(runtime.call(PLATFORM_APP, "runtime_ready", json!({})).unwrap(), json!({ "verified": true }));
    let listed = runtime.call(PLATFORM_APP, "connector_list", json!({})).unwrap();
    assert_eq!(listed[0]["id"], "vehicle");
    let status = runtime
        .call(PLATFORM_APP, "connector_status", json!({ "connectorId": "vehicle" }))
        .unwrap();
    assert_eq!(status["available"], true);
    let telemetry = runtime.call(PLATFORM_APP, "connector_request", request).unwrap();
    assert_eq!(telemetry["vehicleId"], "TRUCK-044");
    // A command the signed manifest does not grant is still refused, by the command.
    let ungranted = runtime
        .call(PLATFORM_APP, "connector_request", json!({ "connectorId": "vehicle", "command": "gps.read" }))
        .unwrap_err();
    assert_eq!(code(&ungranted), "capability_denied");

    let item = json!({ "item": { "formId": "f1", "answers": { "a": 1 } } });
    let queued = runtime.call(PLATFORM_APP, "sync_enqueue", item).unwrap();
    let id = queued["id"].as_str().unwrap().to_string();
    let queue = runtime.call(PLATFORM_APP, "sync_get_queue", json!({})).unwrap();
    assert_eq!(queue.as_array().unwrap().len(), 1);
    let flushed = runtime.call(PLATFORM_APP, "sync_flush", json!({})).unwrap();
    assert_eq!(flushed["pending"][0]["appSlug"], "demo");
    let failed = runtime
        .call(PLATFORM_APP, "sync_fail", json!({ "ids": [id], "error": "offline" }))
        .unwrap();
    assert_eq!(failed["failed"], 1);
    let acked = runtime.call(PLATFORM_APP, "sync_ack", json!({ "ids": [id] })).unwrap();
    assert_eq!(acked["acked"], 1);
}

#[test]
fn an_approved_subdomain_reaches_the_bridge_too() {
    let runtime = Runtime::open("subdomain");
    let info = runtime.call(SUBDOMAIN_APP, "runtime_info", json!({})).expect("runtime_info");
    assert_eq!(info["platform"], std::env::consts::OS);
}

#[test]
fn a_page_on_an_unlisted_origin_reaches_no_command() {
    let runtime = Runtime::open("unlisted");
    // Even for an app this session has verified: the allowlist is judged first.
    test_support::mark_verified(&runtime.app, "https://apps.example.org", "demo", "app-demo", &["vehicle.status.read"]);
    for command in EVERY_COMMAND {
        let result = runtime.call(UNLISTED_APP, command, json!({}));
        assert!(refused_by_the_allowlist(&result), "{command} from an unlisted origin: {result:?}");
    }
}

#[test]
fn the_shell_page_reads_runtime_info_and_takes_the_pending_deep_link() {
    let runtime = Runtime::open("shell");
    let info = runtime.call(SHELL_PAGE, "runtime_info", json!({})).expect("runtime_info");
    assert_eq!(info["name"], "FormLogic Native Runtime");

    test_support::stash_deep_link(&runtime.app, PLATFORM_APP);
    // A hosted page cannot take the link the shell is about to open.
    let hosted = runtime.call(PLATFORM_APP, "pending_deep_link", json!({}));
    assert!(refused_by_the_allowlist(&hosted), "{hosted:?}");
    assert_eq!(runtime.call(SHELL_PAGE, "pending_deep_link", json!({})).unwrap(), json!(PLATFORM_APP));
    assert_eq!(runtime.call(SHELL_PAGE, "pending_deep_link", json!({})).unwrap(), Value::Null);

    // The shell is no hosted app, so the connector and queue commands refuse it themselves.
    let shell = runtime.call(SHELL_PAGE, "sync_flush", json!({})).unwrap_err();
    assert_eq!(code(&shell), "origin_denied");
}
