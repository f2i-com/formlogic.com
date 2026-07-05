// FormLogic Native Runtime (Tauri v2).
//
// A generic desktop/mobile shell that loads a FormLogic app and exposes a small,
// approved set of native capabilities over `window.FormLogicNative` (spec §38/§39):
// a connector registry (device/vehicle data) and an offline sync queue. QuickJS app
// logic and SDK screens ask the connector for abstract commands (e.g. vehicle
// "status.read") and never touch the transport — here the transport is a mock,
// later it can be Bluetooth/USB/local-HTTP without the app changing.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{window::Color, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

// Coordinates deep-link navigation across the shell's initial load. On a COLD start the
// launch intent arrives (via the plugin) before the shell's index.html has loaded, so a
// direct navigate is overwritten by that load. We stash the target and open it once the
// shell's first page load finishes; while the app is already running (WARM) we navigate
// immediately.
#[derive(Default)]
struct DeepLinkNav {
    pending: Mutex<Option<String>>,
    shell_ready: AtomicBool,
}

#[derive(Serialize)]
struct RuntimeInfo {
    name: String,
    version: String,
    platform: String,
}

#[derive(Serialize)]
struct ConnectorSummary {
    id: String,
    kind: String,
    label: String,
    commands: Vec<String>,
}

#[derive(Serialize)]
struct ConnectorStatus {
    id: String,
    kind: String,
    available: bool,
    source: String,
    label: String,
    detail: String,
}

fn vehicle_commands() -> Vec<String> {
    [
        "identity.read",
        "status.read",
        "engineHours.read",
        "faults.read",
        "gps.read",
        "production.read",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        name: "FormLogic Native Runtime".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn connector_list() -> Vec<ConnectorSummary> {
    vec![ConnectorSummary {
        id: "vehicle".into(),
        kind: "mock_vehicle".into(),
        label: "Vehicle (native mock)".into(),
        commands: vehicle_commands(),
    }]
}

#[tauri::command]
fn connector_status(connector_id: String) -> ConnectorStatus {
    let available = connector_id == "vehicle";
    ConnectorStatus {
        kind: if available { "mock_vehicle".into() } else { "unknown".into() },
        available,
        source: "native".into(),
        label: if available {
            "Vehicle (native mock)".into()
        } else {
            connector_id.clone()
        },
        detail: if available {
            "Simulated telemetry from the native runtime.".into()
        } else {
            "No such connector.".into()
        },
        id: connector_id,
    }
}

// Deterministic-ish jitter (by clock minute) so repeated reads feel live. Shape matches the
// browser mock connector exactly, so QuickJS onConnectorEvent maps it identically.
fn vehicle_telemetry() -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let minutes = (now / 60) as i64;
    let engine_hours = 4120.7 + ((minutes % 600) as f64) / 10.0;
    let fuel = 45 + (minutes % 40);
    let low = fuel < 50;
    json!({
        "vehicleId": "TRUCK-044",
        "fleetNumber": "F044",
        "operatorId": "OP-918",
        "engineHours": (engine_hours * 10.0).round() / 10.0,
        "odometer": 87221 + (minutes % 300),
        "fuelPercent": fuel,
        "faultCodes": if low { json!(["P0123"]) } else { json!([]) },
        "status": if low { "warning" } else { "ready" },
        "location": { "lat": -20.123, "lng": 148.456 }
    })
}

#[tauri::command]
fn connector_request(
    connector_id: String,
    command: String,
    _payload: Option<Value>,
) -> Result<Value, String> {
    if connector_id != "vehicle" {
        return Err(format!("Connector \"{}\" is not available.", connector_id));
    }
    let t = vehicle_telemetry();
    let out = match command.as_str() {
        "identity.read" => {
            json!({ "vehicleId": t["vehicleId"], "fleetNumber": t["fleetNumber"], "operatorId": t["operatorId"] })
        }
        "status.read" => t,
        "engineHours.read" => json!({ "engineHours": t["engineHours"], "odometer": t["odometer"] }),
        "faults.read" => json!({ "faultCodes": t["faultCodes"], "status": t["status"] }),
        "gps.read" => json!({ "location": t["location"] }),
        "production.read" => json!({ "payloadCount": 12, "tonnes": 1043.5, "cycleCount": 12 }),
        other => return Err(format!("Unknown vehicle command: {}", other)),
    };
    Ok(out)
}

// --- Offline sync queue (native side; in-memory demo). The real runtime flushes to
// POST /api/app/{slug}/sync/batch — the same idempotent endpoint the browser uses.
#[derive(Default)]
struct SyncQueue(Mutex<Vec<Value>>);

#[tauri::command]
fn sync_enqueue(state: tauri::State<SyncQueue>, item: Value) -> Value {
    let mut q = state.0.lock().unwrap();
    q.push(item);
    json!({ "queued": q.len() })
}

#[tauri::command]
fn sync_get_queue(state: tauri::State<SyncQueue>) -> Vec<Value> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn sync_flush(state: tauri::State<SyncQueue>) -> Value {
    let mut q = state.0.lock().unwrap();
    let n = q.len();
    q.clear();
    json!({ "flushed": n })
}

// The deep-link target the runtime was cold-started with (consumed once), so the shell
// can open the app directly and never render the console UI while it loads.
#[tauri::command]
fn pending_deep_link(state: tauri::State<Arc<DeepLinkNav>>) -> Option<String> {
    state.pending.lock().unwrap().take()
}

// (Last-opened app persistence lives in the shell's localStorage — see native-runtime
// src/main.ts. The shell origin is stable across launches, so no Rust store is needed.)

// Injected into EVERY page in the runtime window (the bundled shell AND any FormLogic
// app it navigates to), so the web runtime feature-detects window.FormLogicNative and
// routes connector requests here. Methods reference __TAURI__ lazily so init order is moot.
const BRIDGE_SCRIPT: &str = r#"
;(function () {
  if (window.FormLogicNative) return;
  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (!t || !t.core) return Promise.reject(new Error('native bridge unavailable'));
    return t.core.invoke(cmd, args || {});
  }
  window.FormLogicNative = {
    available: true,
    runtime: {
      getInfo: function () { return invoke('runtime_info'); },
      openExternal: function (url) {
        try { return invoke('plugin:opener|open_url', { url: url }); }
        catch (e) { window.open(url, '_blank'); return Promise.resolve(); }
      },
      // Target of the deep link that launched the runtime (cold start), or null.
      // The shell reads this so it can open straight into the app without ever
      // flashing the console UI. Consumed once.
      pendingDeepLink: function () { return invoke('pending_deep_link'); }
    },
    connectors: {
      list: function () { return invoke('connector_list'); },
      status: function (id) { return invoke('connector_status', { connectorId: id }); },
      request: function (id, command, payload) {
        return invoke('connector_request', { connectorId: id, command: command, payload: payload || null });
      },
      subscribe: function () { return function () {}; }
    },
    sync: {
      enqueueSubmission: function (item) { return invoke('sync_enqueue', { item: item }); },
      flush: function () { return invoke('sync_flush'); },
      getQueue: function () { return invoke('sync_get_queue'); }
    }
  };
})();

// Loading overlay: on a hosted app page (i.e. NOT the runtime shell), show a branded
// FormLogic spinner from the first byte until the app actually paints, so opening an
// app via a link or the shell never shows a blank/white flash.
;(function () {
  try {
    if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') return;
    var doc = document, ID = '__fl_loading', start = Date.now();
    if (doc.getElementById(ID)) return;

    var style = doc.createElement('style');
    style.textContent =
      '#__fl_loading{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;background:#080b16;transition:opacity .3s ease;' +
      'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      '#__fl_loading .flw{position:relative;width:76px;height:76px;display:grid;place-items:center}' +
      '#__fl_loading .flr{position:absolute;inset:0;border-radius:50%;border:3px solid rgba(245,158,11,.16);' +
      'border-top-color:#f59e0b;border-right-color:#fbbf24;animation:__flspin .9s cubic-bezier(.5,.15,.4,.85) infinite}' +
      '#__fl_loading .flm{width:50px;height:50px;border-radius:14px;display:grid;place-items:center;font-weight:800;' +
      'font-size:18px;color:#1a1200;background:linear-gradient(150deg,#fbbf24,#f59e0b);box-shadow:0 8px 22px -8px rgba(245,158,11,.6)}' +
      '#__fl_loading .flt{color:#8a97ba;font-size:13px;letter-spacing:.02em}' +
      '@keyframes __flspin{to{transform:rotate(360deg)}}' +
      '@media (prefers-reduced-motion:reduce){#__fl_loading .flr{animation:none}}';
    (doc.head || doc.documentElement).appendChild(style);

    var ov = doc.createElement('div');
    ov.id = ID;
    ov.setAttribute('role', 'status');
    ov.innerHTML = '<div class="flw"><div class="flr"></div><div class="flm">FL</div></div><div class="flt">Loading app…</div>';
    (doc.body || doc.documentElement).appendChild(ov);

    var done = false, obs = null, iv = 0;
    function hide() {
      if (done) return; done = true;
      if (obs) obs.disconnect();
      clearInterval(iv);
      var el = doc.getElementById(ID);
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }
    function painted() {
      var root = doc.getElementById('root') || doc.querySelector('[data-reactroot],#app,main');
      if (!root || root.childElementCount === 0) return false;
      // A heavy app (dashboard) hides as soon as it renders real UI (>16 elements),
      // covering the app's own light loading spinner. A LIGHTER app that has had content
      // for >4s is also done — hide it rather than covering interactive UI for 15s.
      return root.getElementsByTagName('*').length > 16 || Date.now() - start > 4000;
    }
    function maybeHide() { if (Date.now() - start >= 300 && painted()) hide(); }
    try { obs = new MutationObserver(maybeHide); obs.observe(doc.documentElement, { childList: true, subtree: true }); } catch (e) {}
    iv = setInterval(maybeHide, 150);
    setTimeout(hide, 10000); // hard safety cap
  } catch (e) { /* never block the app on the overlay */ }
})();
"#;

// Resolve an incoming deep link to the app URL the runtime should open, so tapping a
// link launches straight into an app instead of the user typing a URL (spec §26):
//   - `http(s)://…`  → the URL itself (verified https App Links: the link IS the app).
//   - `formlogic://open?url=<url-encoded app url>` → the decoded `url` param
//     (custom scheme; works with no domain verification, ideal for local/self-hosted).
// Anything else is ignored (returns None) so a stray link can't navigate the shell.
/// `formlogic://home` sentinel — returns the runtime to its placeholder (escape hatch if a
/// remembered app URL is broken). Distinct from any openable app URL.
const DEEP_LINK_HOME: &str = "\0home";

/// An app target is safe to open ONLY if it is http/https — never javascript:/file:/data:,
/// which would otherwise execute in the privileged shell origin.
fn is_openable(target: &str) -> bool {
    Url::parse(target)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn deep_link_target(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(raw.to_string()),
        "formlogic" => {
            if parsed.host_str() == Some("home") {
                return Some(DEEP_LINK_HOME.to_string());
            }
            // Only accept a url= param that itself resolves to an http/https target.
            parsed
                .query_pairs()
                .find(|(k, _)| k == "url")
                .map(|(_, v)| v.into_owned())
                .filter(|t| is_openable(t))
        }
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(SyncQueue::default())
        .setup(|app| {
            let nav_state = Arc::new(DeepLinkNav::default());
            app.manage(nav_state.clone()); // read by the `pending_deep_link` command

            // The shell loads at index.html on a dark background (no white flash during
            // the WebView cold-start), and boots straight into its loader. It reveals the
            // console only after confirming no deep link is pending; a `shell_ready` latch
            // lets warm deep links (below) navigate immediately.
            let state_load = nav_state.clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("FormLogic Native Runtime")
            .inner_size(1040.0, 780.0)
            .background_color(Color(8, 11, 22, 255))
            .initialization_script(BRIDGE_SCRIPT)
            .on_page_load(move |_webview, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    state_load.shell_ready.store(true, Ordering::SeqCst);
                }
            })
            .build()?;

            // Deep link handler: if the shell is already up (warm start / Android
            // onNewIntent) navigate now; otherwise (cold start) stash the target so the
            // booting shell picks it up via `pending_deep_link` and shows only the loader.
            let handle = app.handle().clone();
            let state_dl = nav_state.clone();
            app.deep_link().on_open_url(move |event| {
                for raw in event.urls() {
                    eprintln!("[formlogic] deep link received: {raw}");
                    let Some(target) = deep_link_target(raw.as_str()) else {
                        eprintln!("[formlogic] no target resolved from {raw}");
                        continue;
                    };
                    if state_dl.shell_ready.load(Ordering::SeqCst) {
                        // Warm: navigate only to an openable http/https app. The home
                        // sentinel (and anything else) is handled by the shell on boot.
                        if is_openable(&target) {
                            if let (Some(win), Ok(url)) =
                                (handle.get_webview_window("main"), Url::parse(&target))
                            {
                                let _ = win.navigate(url);
                            }
                        }
                    } else {
                        eprintln!("[formlogic] stashing {target} for the booting shell");
                        *state_dl.pending.lock().unwrap() = Some(target);
                    }
                    break;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            connector_list,
            connector_status,
            connector_request,
            sync_enqueue,
            sync_get_queue,
            sync_flush,
            pending_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_shape_matches_browser_mock() {
        let t = vehicle_telemetry();
        assert_eq!(t["vehicleId"], "TRUCK-044");
        assert_eq!(t["fleetNumber"], "F044");
        assert_eq!(t["operatorId"], "OP-918");
        let fuel = t["fuelPercent"].as_i64().unwrap();
        assert!((45..=84).contains(&fuel), "fuel {} out of range", fuel);
        assert!(t["engineHours"].as_f64().unwrap() >= 4120.7);
    }

    #[test]
    fn connector_request_routes_commands() {
        // status.read returns full telemetry
        let status = connector_request("vehicle".into(), "status.read".into(), None).unwrap();
        assert_eq!(status["vehicleId"], "TRUCK-044");
        // identity.read is a narrowed view
        let id = connector_request("vehicle".into(), "identity.read".into(), None).unwrap();
        assert_eq!(id["fleetNumber"], "F044");
        assert!(id.get("fuelPercent").is_none());
        // unknown connector / command error out
        assert!(connector_request("printer".into(), "status.read".into(), None).is_err());
        assert!(connector_request("vehicle".into(), "explode".into(), None).is_err());
    }

    #[test]
    fn deep_link_resolves_targets() {
        // Custom scheme: the url-encoded `url` param is the target.
        assert_eq!(
            deep_link_target("formlogic://open?url=http%3A%2F%2Flocalhost%3A8090%2Fapp%2Fdemo"),
            Some("http://localhost:8090/app/demo".to_string())
        );
        // https App Link: the link itself is the app URL.
        assert_eq!(
            deep_link_target("https://formlogic.com/open/app/event-hub"),
            Some("https://formlogic.com/open/app/event-hub".to_string())
        );
        // Home sentinel routes back to the placeholder.
        assert_eq!(deep_link_target("formlogic://home"), Some(DEEP_LINK_HOME.to_string()));
        // Custom scheme without a url param, or an unknown scheme, resolves to nothing.
        assert_eq!(deep_link_target("formlogic://open"), None);
        assert_eq!(deep_link_target("javascript://alert(1)"), None);
        assert_eq!(deep_link_target("file:///etc/passwd"), None);
        // SECURITY: a url= param that is NOT http/https must be rejected (never navigate
        // the privileged shell origin to javascript:/file:/data:).
        assert_eq!(
            deep_link_target("formlogic://open?url=javascript%3Aalert(1)"),
            None
        );
        assert_eq!(
            deep_link_target("formlogic://open?url=file%3A%2F%2F%2Fetc%2Fpasswd"),
            None
        );
        assert!(is_openable("https://formlogic.com/app/x"));
        assert!(!is_openable("javascript:alert(1)"));
    }
}
