// FormLogic Native Runtime (Tauri v2).
//
// A generic desktop/mobile shell that loads a FormLogic app and exposes a small,
// approved set of native capabilities over `window.FormLogicNative` (spec §38/§39):
// a connector registry (device/vehicle data) and an offline sync queue. QuickJS app
// logic and SDK screens ask the connector for abstract commands (e.g. vehicle
// "status.read") and never touch the transport — here the transport is a mock,
// later it can be Bluetooth/USB/local-HTTP without the app changing.
//
// Trust boundary (spec §25): the bridge is injected into every page, but connector /
// sync access is granted ONLY to an origin whose SIGNED client manifest we have fetched
// and Ed25519-verified (see `verify` module). An unverified origin can still render, but
// its bridge is display-only — connector/sync calls reject with typed errors and the JS
// shim marks `available=false` so the web runtime falls back to browser mock connectors.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

// ---------------------------------------------------------------------------
// Typed connector errors (spec §41 hardening / review #14).
//
// `connector_request` / `connector_status` reject with a JSON STRING
// `{"code":"<code>","message":"<text>"}`. The web client (parseConnectorError in
// connectorTypes.ts) reads that code and only falls back to a browser mock for the
// FALLBACKABLE codes (connector_missing / ipc_unavailable) — never masking a capability
// denial or a real per-request failure with mock data.
// ---------------------------------------------------------------------------
const CODE_ORIGIN_DENIED: &str = "origin_denied";
const CODE_CAPABILITY_DENIED: &str = "capability_denied";
const CODE_CONNECTOR_MISSING: &str = "connector_missing";
const CODE_COMMAND_FAILED: &str = "command_failed";
// Reserved for a real connector that is present but currently offline (the mock is always up).
#[allow(dead_code)]
const CODE_CONNECTOR_UNAVAILABLE: &str = "connector_unavailable";
// `ipc_unavailable` is surfaced by the JS shim (window.__TAURI__ missing), never from Rust.
#[allow(dead_code)]
const CODE_IPC_UNAVAILABLE: &str = "ipc_unavailable";

/// Build the typed error JSON the web side parses out of a rejected bridge call.
fn conn_err(code: &str, message: impl Into<String>) -> String {
    json!({ "code": code, "message": message.into() }).to_string()
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
fn connector_list(webview: tauri::Webview, verified: tauri::State<VerifiedOrigins>) -> Vec<ConnectorSummary> {
    // Only a verified origin discovers native connectors; an unverified page is display-only
    // (the web runtime then sees no native connectors and uses its browser registry).
    let Some(origin) = caller_origin(&webview) else { return vec![] };
    let Some(caps) = verified.get(&origin) else { return vec![] };
    if caps.grants_any("vehicle") {
        vec![ConnectorSummary {
            id: "vehicle".into(),
            kind: "mock_vehicle".into(),
            label: "Vehicle (native mock)".into(),
            commands: vehicle_commands(),
        }]
    } else {
        vec![]
    }
}

#[tauri::command]
fn connector_status(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    connector_id: String,
) -> Result<ConnectorStatus, String> {
    let caps = require_caps(&webview, &verified)?;
    if connector_id != "vehicle" {
        return Err(conn_err(
            CODE_CONNECTOR_MISSING,
            format!("Connector \"{connector_id}\" is not provided by the native runtime."),
        ));
    }
    if !caps.grants_any(&connector_id) {
        return Err(conn_err(
            CODE_CAPABILITY_DENIED,
            format!("The app's signed manifest does not grant the \"{connector_id}\" connector."),
        ));
    }
    Ok(ConnectorStatus {
        id: "vehicle".into(),
        kind: "mock_vehicle".into(),
        available: true,
        source: "native".into(),
        label: "Vehicle (native mock)".into(),
        detail: "Simulated telemetry from the native runtime.".into(),
    })
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

/// Pure command routing for the mock vehicle connector (testable without a webview).
/// Returns the typed `command_failed` error JSON for an unknown command.
fn vehicle_request(command: &str) -> Result<Value, String> {
    let t = vehicle_telemetry();
    let out = match command {
        "identity.read" => {
            json!({ "vehicleId": t["vehicleId"], "fleetNumber": t["fleetNumber"], "operatorId": t["operatorId"] })
        }
        "status.read" => t,
        "engineHours.read" => json!({ "engineHours": t["engineHours"], "odometer": t["odometer"] }),
        "faults.read" => json!({ "faultCodes": t["faultCodes"], "status": t["status"] }),
        "gps.read" => json!({ "location": t["location"] }),
        "production.read" => json!({ "payloadCount": 12, "tonnes": 1043.5, "cycleCount": 12 }),
        other => {
            return Err(conn_err(
                CODE_COMMAND_FAILED,
                format!("Unknown vehicle command: {other}"),
            ))
        }
    };
    Ok(out)
}

#[tauri::command]
fn connector_request(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    connector_id: String,
    command: String,
    _payload: Option<Value>,
) -> Result<Value, String> {
    let caps = require_caps(&webview, &verified)?;
    // unknown connector → connector_missing (the web side may fall back to a browser mock).
    if connector_id != "vehicle" {
        return Err(conn_err(
            CODE_CONNECTOR_MISSING,
            format!("Connector \"{connector_id}\" is not provided by the native runtime."),
        ));
    }
    // the manifest must grant this exact connector.command, else capability_denied (never masked).
    if !caps.grants(&connector_id, &command) {
        return Err(conn_err(
            CODE_CAPABILITY_DENIED,
            format!("The app's signed manifest does not grant \"{connector_id}.{command}\"."),
        ));
    }
    // A real connector that is offline would return CODE_CONNECTOR_UNAVAILABLE here; the mock is
    // always available. unknown command → command_failed (handled in vehicle_request).
    vehicle_request(&command)
}

// ---------------------------------------------------------------------------
// Offline sync queue (review #15) — PERSISTED so queued submissions survive a process
// restart. Backed by a JSON file in the app data dir (std::fs; no external store crate,
// so it is directly unit-testable and adds no dependency/offline-resolve risk).
//
// The native side does NOT POST to the server: the WebView holds the session cookie, so
// `sync_flush` RETURNS pending items grouped by appSlug to the caller, which POSTs them to
// `/api/app/{slug}/sync/batch`, then calls `sync_ack(ids)` for the ones the server accepted
// (removing them) and `sync_fail(ids, error)` for the rest (kept, with attempts + lastError).
// ---------------------------------------------------------------------------
const MAX_SYNC_ATTEMPTS: u32 = 5;
static QUEUE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SyncItem {
    id: String,
    app_slug: String,
    form_id: String,
    idempotency_key: String,
    answers: Value,
    /// "pending" (retryable) | "completed" (removed by ack) | "failed" (max attempts hit).
    status: String,
    attempts: u32,
    last_error: Option<String>,
    created_at: String,
}

impl SyncItem {
    /// Normalize an item enqueued from the web into a full queue record, filling in an id,
    /// status, and createdAt when the caller did not supply them.
    fn from_incoming(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let id = s("id").filter(|x| !x.is_empty()).unwrap_or_else(gen_id);
        let idempotency_key = s("idempotencyKey").filter(|x| !x.is_empty()).unwrap_or_else(|| id.clone());
        SyncItem {
            app_slug: s("appSlug").unwrap_or_default(),
            form_id: s("formId").unwrap_or_default(),
            idempotency_key,
            answers: v.get("answers").cloned().unwrap_or(Value::Null),
            status: "pending".into(),
            attempts: v.get("attempts").and_then(Value::as_u64).unwrap_or(0) as u32,
            last_error: s("lastError"),
            created_at: s("createdAt").filter(|x| !x.is_empty()).unwrap_or_else(now_iso),
            id,
        }
    }
}

struct PersistentSyncQueue {
    path: PathBuf,
    items: Mutex<Vec<SyncItem>>,
}

impl PersistentSyncQueue {
    /// Load an existing queue file (surviving a restart), or start empty.
    fn load(path: PathBuf) -> Self {
        let items = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<SyncItem>>(&s).ok())
            .unwrap_or_default();
        PersistentSyncQueue { path, items: Mutex::new(items) }
    }

    fn persist(&self, items: &[SyncItem]) {
        let Ok(text) = serde_json::to_string(items) else { return };
        // Write to a sibling temp file then rename, so a crash mid-write can't corrupt the queue.
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, &text).is_ok() && std::fs::rename(&tmp, &self.path).is_ok() {
            return;
        }
        let _ = std::fs::write(&self.path, &text);
    }

    /// Append an item and persist; returns the (possibly generated) item id.
    fn enqueue(&self, incoming: &Value) -> String {
        let mut items = self.items.lock().unwrap();
        let item = SyncItem::from_incoming(incoming);
        let id = item.id.clone();
        items.push(item);
        self.persist(&items);
        id
    }

    fn get_queue(&self) -> Vec<SyncItem> {
        self.items.lock().unwrap().clone()
    }

    /// Return pending items grouped by appSlug for the caller to POST. Increments each
    /// returned item's `attempts` (a delivery attempt) — items are NOT removed here, so a
    /// failed POST never silently drops data; `sync_ack` removes the accepted ones.
    fn flush(&self) -> Value {
        let mut items = self.items.lock().unwrap();
        for it in items.iter_mut().filter(|i| i.status == "pending") {
            it.attempts += 1;
        }
        let mut by_slug: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for it in items.iter().filter(|i| i.status == "pending") {
            by_slug
                .entry(it.app_slug.clone())
                .or_default()
                .push(serde_json::to_value(it).unwrap_or(Value::Null));
        }
        self.persist(&items);
        let pending: Vec<Value> = by_slug
            .into_iter()
            .map(|(slug, group)| json!({ "appSlug": slug, "items": group }))
            .collect();
        json!({ "pending": pending })
    }

    /// Mark the given ids completed and remove them (called after a successful POST).
    fn ack(&self, ids: &[String]) -> Value {
        let mut items = self.items.lock().unwrap();
        let set: HashSet<&String> = ids.iter().collect();
        let before = items.len();
        items.retain(|i| !set.contains(&i.id));
        let removed = before - items.len();
        self.persist(&items);
        json!({ "acked": removed, "remaining": items.len() })
    }

    /// Record a failure for the given ids: keep them (retryable) with `lastError` set, and
    /// promote to terminal "failed" once they exceed MAX_SYNC_ATTEMPTS so a poison item stops
    /// being retried. `attempts` was already bumped by `flush`.
    fn fail(&self, ids: &[String], error: &str) -> Value {
        let mut items = self.items.lock().unwrap();
        let set: HashSet<&String> = ids.iter().collect();
        let mut n = 0;
        for it in items.iter_mut().filter(|i| set.contains(&i.id)) {
            it.last_error = Some(error.to_string());
            if it.attempts >= MAX_SYNC_ATTEMPTS {
                it.status = "failed".into();
            }
            n += 1;
        }
        self.persist(&items);
        json!({ "failed": n })
    }
}

#[tauri::command]
fn sync_enqueue(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PersistentSyncQueue>,
    item: Value,
) -> Result<Value, String> {
    require_verified_origin(&webview, &verified)?;
    Ok(json!({ "id": state.enqueue(&item) }))
}

#[tauri::command]
fn sync_get_queue(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PersistentSyncQueue>,
) -> Result<Vec<SyncItem>, String> {
    require_verified_origin(&webview, &verified)?;
    Ok(state.get_queue())
}

#[tauri::command]
fn sync_flush(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PersistentSyncQueue>,
) -> Result<Value, String> {
    require_verified_origin(&webview, &verified)?;
    Ok(state.flush())
}

#[tauri::command]
fn sync_ack(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PersistentSyncQueue>,
    ids: Vec<String>,
) -> Result<Value, String> {
    require_verified_origin(&webview, &verified)?;
    Ok(state.ack(&ids))
}

#[tauri::command]
fn sync_fail(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PersistentSyncQueue>,
    ids: Vec<String>,
    error: String,
) -> Result<Value, String> {
    require_verified_origin(&webview, &verified)?;
    Ok(state.fail(&ids, &error))
}

fn gen_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = QUEUE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("q_{millis}_{seq}")
}

/// Current UTC time as an RFC3339 string, dependency-free (Howard Hinnant's civil-from-days).
fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

// ---------------------------------------------------------------------------
// Signed client-manifest verification (spec §25 / review #12).
//
// On each top-level navigation to a hosted app we fetch the app's signed client manifest
// and the server's Ed25519 public key, and verify the DETACHED signature over the CANONICAL
// JSON of `manifest.payload`. Only on success do we record the app's granted native
// capabilities for that origin; connector/sync commands reject otherwise (origin_denied /
// capability_denied). The message that was signed is reproduced byte-for-byte from
// PHP's SigningService::canonical (json_encode of the assoc round-trip, with
// JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE).
// ---------------------------------------------------------------------------

/// Native capabilities granted to a verified origin (flattened "connector.command" keys).
#[derive(Clone, Default)]
struct VerifiedCaps {
    #[allow(dead_code)]
    slug: String,
    capabilities: HashSet<String>,
}

impl VerifiedCaps {
    fn grants(&self, connector: &str, command: &str) -> bool {
        self.capabilities.contains(&format!("{connector}.{command}"))
    }
    fn grants_any(&self, connector: &str) -> bool {
        let prefix = format!("{connector}.");
        self.capabilities.iter().any(|k| k.starts_with(&prefix))
    }
}

/// Per-origin verified capabilities. Shared (Arc) between the page-load verifier and the
/// bridge command handlers.
#[derive(Clone, Default)]
struct VerifiedOrigins(Arc<Mutex<HashMap<String, VerifiedCaps>>>);

impl VerifiedOrigins {
    fn get(&self, origin: &str) -> Option<VerifiedCaps> {
        self.0.lock().unwrap().get(origin).cloned()
    }
    fn contains(&self, origin: &str) -> bool {
        self.0.lock().unwrap().contains_key(origin)
    }
    fn insert(&self, origin: String, caps: VerifiedCaps) {
        self.0.lock().unwrap().insert(origin, caps);
    }
}

/// The http/https origin of the calling webview, or None for the shell / a non-web origin.
fn caller_origin(webview: &tauri::Webview) -> Option<String> {
    webview.url().ok().and_then(|u| hosted_app_origin(&u))
}

/// A verified origin's caps, or the origin_denied typed error.
fn require_caps(webview: &tauri::Webview, verified: &VerifiedOrigins) -> Result<VerifiedCaps, String> {
    let origin = caller_origin(webview)
        .ok_or_else(|| conn_err(CODE_ORIGIN_DENIED, "This origin has no verified FormLogic manifest."))?;
    verified.get(&origin).ok_or_else(|| {
        conn_err(
            CODE_ORIGIN_DENIED,
            format!("Origin {origin} has not passed signed-manifest verification."),
        )
    })
}

/// Gate for sync commands (origin must be verified; no per-command capability).
fn require_verified_origin(webview: &tauri::Webview, verified: &VerifiedOrigins) -> Result<String, String> {
    let origin = caller_origin(webview)
        .ok_or_else(|| conn_err(CODE_ORIGIN_DENIED, "This origin has no verified FormLogic manifest."))?;
    if !verified.contains(&origin) {
        return Err(conn_err(
            CODE_ORIGIN_DENIED,
            format!("Origin {origin} has not passed signed-manifest verification."),
        ));
    }
    Ok(origin)
}

/// The tuple origin (scheme://host[:port]) for an http/https app URL, excluding the runtime
/// shell (tauri.localhost) and non-web schemes.
fn hosted_app_origin(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if url.host_str() == Some("tauri.localhost") {
        return None; // the runtime's own shell, not a hosted app
    }
    Some(url.origin().ascii_serialization())
}

/// The app slug from a hosted app URL — the path segment after `/app/` (also matches the
/// deep-link `/open/app/<slug>` form). None if the app is not served under `/app/<slug>`.
fn slug_of(url: &Url) -> Option<String> {
    let segments: Vec<&str> = url.path_segments()?.collect();
    for (i, seg) in segments.iter().enumerate() {
        if *seg == "app" {
            if let Some(next) = segments.get(i + 1) {
                if !next.is_empty() {
                    return Some((*next).to_string());
                }
            }
        }
    }
    None
}

/// Reproduce PHP `SigningService::canonical`:
///   json_encode(json_decode(json_encode($payload), true), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
/// The assoc round-trip's only structural effect on the manifests we sign is collapsing an
/// empty object {} to an empty array [] (PHP empty assoc arrays encode as []). serde_json
/// (with `preserve_order`) already matches the flags: it preserves key insertion order,
/// never escapes '/', and emits UTF-8 unescaped.
fn php_canonical(value: &Value) -> String {
    serde_json::to_string(&normalize_php_assoc(value)).unwrap_or_default()
}

fn normalize_php_assoc(v: &Value) -> Value {
    match v {
        // json_decode($json, true) turns {} into [] (empty assoc array), which re-encodes as [].
        Value::Object(map) if map.is_empty() => Value::Array(Vec::new()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, val) in map {
                out.insert(k.clone(), normalize_php_assoc(val));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(normalize_php_assoc).collect()),
        other => other.clone(),
    }
}

/// Verify a detached Ed25519 signature over the canonical JSON of `payload`.
/// `sig_b64url` is base64url (`-_`, no padding, per SigningService::b64url); `pubkey_b64` is
/// standard base64 (per SigningService::publicKeyInfo → base64_encode).
fn verify_ed25519(payload: &Value, sig_b64url: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::Engine as _;
    let message = php_canonical(payload);
    let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sig_b64url.trim().trim_end_matches('='))
        .map_err(|e| format!("bad signature base64url: {e}"))?;
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("bad public key base64: {e}"))?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("signature is {} bytes, expected 64", sig_bytes.len()))?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("public key is {} bytes, expected 32", pk_bytes.len()))?;
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| format!("invalid public key: {e}"))?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);
    verifying_key
        .verify_strict(message.as_bytes(), &signature)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Flatten `payload.native.capabilities` into a set of "connector.command" grant keys.
fn extract_caps(payload: &Value) -> VerifiedCaps {
    let mut capabilities = HashSet::new();
    if let Some(list) = payload.pointer("/native/capabilities").and_then(Value::as_array) {
        for cap in list {
            let Some(connector) = cap.get("connector").and_then(Value::as_str) else { continue };
            if connector.is_empty() {
                continue;
            }
            if let Some(cmds) = cap.get("commands").and_then(Value::as_array) {
                for c in cmds {
                    if let Some(cmd) = c.as_str() {
                        capabilities.insert(format!("{connector}.{cmd}"));
                    }
                }
            }
        }
    }
    let slug = payload.get("appSlug").and_then(Value::as_str).unwrap_or("").to_string();
    VerifiedCaps { slug, capabilities }
}

fn http_get(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().map_err(|e| format!("GET {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url} returned HTTP {}", resp.status().as_u16()));
    }
    resp.text().map_err(|e| format!("reading {url} failed: {e}"))
}

/// Fetch `{origin}/api/app/{slug}/client-manifest` + `{origin}/api/public/signing-key` and
/// verify the manifest's detached Ed25519 signature. On success returns the granted caps.
fn fetch_and_verify(origin: &str, slug: &str) -> Result<VerifiedCaps, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let envelope: Value = serde_json::from_str(&http_get(
        &client,
        &format!("{origin}/api/app/{slug}/client-manifest"),
    )?)
    .map_err(|e| format!("manifest is not JSON: {e}"))?;

    let payload = envelope.get("payload").ok_or("manifest has no payload")?;
    let signature = envelope
        .get("signature")
        .and_then(Value::as_str)
        .ok_or("manifest has no signature")?;
    let alg = envelope.get("alg").and_then(Value::as_str).unwrap_or("");
    if alg != "Ed25519" {
        return Err(format!("manifest alg is \"{alg}\", not publicly verifiable"));
    }

    let key: Value = serde_json::from_str(&http_get(&client, &format!("{origin}/api/public/signing-key"))?)
        .map_err(|e| format!("signing-key is not JSON: {e}"))?;
    let public_key = key
        .get("publicKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("server exposes no Ed25519 public key")?;

    verify_ed25519(payload, signature, public_key)?;

    // Optional consistency check: the signed manifest must be for the slug we navigated to.
    if let Some(manifest_slug) = payload.get("appSlug").and_then(Value::as_str) {
        if manifest_slug != slug {
            return Err(format!(
                "manifest appSlug \"{manifest_slug}\" does not match navigated slug \"{slug}\""
            ));
        }
    }
    Ok(extract_caps(payload))
}

/// The deep-link target the runtime was cold-started with (consumed once), so the shell
/// can open the app directly and never render the console UI while it loads.
#[tauri::command]
fn pending_deep_link(state: tauri::State<Arc<DeepLinkNav>>) -> Option<String> {
    state.pending.lock().unwrap().take()
}

// (Last-opened app persistence lives in the shell's localStorage — see native-runtime
// src/main.ts. The shell origin is stable across launches, so no Rust store is needed.)

// Injected into EVERY page in the runtime window (the bundled shell AND any FormLogic
// app it navigates to), so the web runtime feature-detects window.FormLogicNative and
// routes connector requests here. Methods reference __TAURI__ lazily so init order is moot.
//
// available=true is set optimistically; a hosted app whose signed manifest FAILS verification
// has this flipped to false (and connectors/sync deleted) by the Rust page-load verifier, so
// the web runtime treats it as no-bridge and falls back to browser mocks. Even before that,
// connector/sync calls from an unverified origin reject with the typed origin_denied error.
const BRIDGE_SCRIPT: &str = r#"
;(function () {
  if (window.FormLogicNative) return;
  // Bare invoke: rejects with the typed ipc_unavailable error when the native IPC is absent
  // (non-approved origin / __TAURI__ not injected), which the web client treats as fallbackable.
  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (!t || !t.core) {
      return Promise.reject(new Error(JSON.stringify({ code: 'ipc_unavailable', message: 'Native IPC is unavailable on this origin.' })));
    }
    return t.core.invoke(cmd, args || {});
  }
  // Normalize any rejection to an Error whose .message is the typed {code,message} JSON string,
  // which is exactly what the web side reads (parseConnectorError → error.message).
  function toError(e) {
    if (e instanceof Error) return e;
    return new Error(typeof e === 'string' ? e : JSON.stringify(e));
  }
  function call(cmd, args) {
    return invoke(cmd, args).catch(function (e) { throw toError(e); });
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
      list: function () { return call('connector_list'); },
      status: function (id) { return call('connector_status', { connectorId: id }); },
      request: function (id, command, payload) {
        return call('connector_request', { connectorId: id, command: command, payload: payload || null });
      },
      subscribe: function () { return function () {}; }
    },
    // Offline sync (persisted, spec §15). enqueueSubmission/getQueue/flush are the contract;
    // ack/fail complete the loop after the WebView POSTs a flushed batch to /sync/batch.
    sync: {
      enqueueSubmission: function (item) { return call('sync_enqueue', { item: item }); },
      getQueue: function () { return call('sync_get_queue'); },
      flush: function () { return call('sync_flush'); },
      ack: function (ids) { return call('sync_ack', { ids: ids || [] }); },
      fail: function (ids, error) { return call('sync_fail', { ids: ids || [], error: String(error == null ? '' : error) }); }
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
        .setup(|app| {
            let nav_state = Arc::new(DeepLinkNav::default());
            app.manage(nav_state.clone()); // read by the `pending_deep_link` command

            // Per-origin verified capabilities, shared with the bridge command handlers.
            let verified = VerifiedOrigins::default();
            app.manage(verified.clone());

            // Persisted offline sync queue (survives restart) in the app data dir.
            let queue_path = app
                .path()
                .app_data_dir()
                .map(|dir| {
                    let _ = std::fs::create_dir_all(&dir);
                    dir.join("sync-queue.json")
                })
                .unwrap_or_else(|_| std::env::temp_dir().join("formlogic-sync-queue.json"));
            app.manage(PersistentSyncQueue::load(queue_path));

            // The shell loads at index.html on a dark background (no white flash during
            // the WebView cold-start), and boots straight into its loader. It reveals the
            // console only after confirming no deep link is pending; a `shell_ready` latch
            // lets warm deep links (below) navigate immediately.
            let state_load = nav_state.clone();
            let verified_pl = verified.clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("FormLogic Native Runtime")
            .inner_size(1040.0, 780.0)
            .background_color(Color(8, 11, 22, 255))
            .initialization_script(BRIDGE_SCRIPT)
            .on_page_load(move |webview, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    state_load.shell_ready.store(true, Ordering::SeqCst);
                    // On a top-level navigation to a hosted app, verify its signed client
                    // manifest off-thread; grant native caps only on success, else make the
                    // bridge display-only. Skip if this origin is already verified.
                    let url = payload.url().clone();
                    if let (Some(origin), Some(slug)) = (hosted_app_origin(&url), slug_of(&url)) {
                        if !verified_pl.contains(&origin) {
                            let wv = webview.clone();
                            let vmap = verified_pl.clone();
                            std::thread::spawn(move || match fetch_and_verify(&origin, &slug) {
                                Ok(caps) => {
                                    eprintln!("[formlogic] manifest verified for {origin} ({slug})");
                                    vmap.insert(origin, caps);
                                }
                                Err(e) => {
                                    eprintln!("[formlogic] manifest verification FAILED for {origin} ({slug}): {e}");
                                    let _ = wv.eval(
                                        "try{if(window.FormLogicNative){window.FormLogicNative.available=false;delete window.FormLogicNative.connectors;delete window.FormLogicNative.sync;}}catch(_){}"
                                    );
                                }
                            });
                        }
                    }
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
            sync_ack,
            sync_fail,
            pending_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_code(err: &str) -> String {
        let v: Value = serde_json::from_str(err).expect("connector error must be JSON");
        v["code"].as_str().expect("error has a code").to_string()
    }

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
        let status = vehicle_request("status.read").unwrap();
        assert_eq!(status["vehicleId"], "TRUCK-044");
        // identity.read is a narrowed view
        let id = vehicle_request("identity.read").unwrap();
        assert_eq!(id["fleetNumber"], "F044");
        assert!(id.get("fuelPercent").is_none());
        // unknown command errors out with a typed command_failed JSON error (#14).
        let err = vehicle_request("explode").unwrap_err();
        assert_eq!(parse_code(&err), "command_failed");
    }

    #[test]
    fn typed_connector_error_vocabulary() {
        // Every documented code round-trips as a {code,message} JSON string (#14 contract).
        for code in [
            CODE_ORIGIN_DENIED,
            CODE_CAPABILITY_DENIED,
            CODE_CONNECTOR_MISSING,
            CODE_CONNECTOR_UNAVAILABLE,
            CODE_COMMAND_FAILED,
            CODE_IPC_UNAVAILABLE,
        ] {
            let err = conn_err(code, "context");
            assert_eq!(parse_code(&err), code);
            let v: Value = serde_json::from_str(&err).unwrap();
            assert_eq!(v["message"], "context");
        }
    }

    #[test]
    fn caps_grant_matching() {
        let mut capabilities = HashSet::new();
        capabilities.insert("vehicle.status.read".to_string());
        let caps = VerifiedCaps { slug: "demo".into(), capabilities };
        assert!(caps.grants("vehicle", "status.read"));
        assert!(!caps.grants("vehicle", "gps.read"));
        assert!(caps.grants_any("vehicle"));
        assert!(!caps.grants_any("printer"));
    }

    #[test]
    fn extract_caps_flattens_manifest() {
        let payload = json!({
            "appSlug": "fleet",
            "native": { "capabilities": [
                { "connector": "vehicle", "commands": ["status.read", "gps.read"] }
            ]}
        });
        let caps = extract_caps(&payload);
        assert_eq!(caps.slug, "fleet");
        assert!(caps.grants("vehicle", "status.read"));
        assert!(caps.grants("vehicle", "gps.read"));
        assert!(!caps.grants("vehicle", "faults.read"));
    }

    #[test]
    fn origin_and_slug_derivation() {
        let u = Url::parse("http://localhost:8090/app/demo/form/abc").unwrap();
        assert_eq!(hosted_app_origin(&u).as_deref(), Some("http://localhost:8090"));
        assert_eq!(slug_of(&u).as_deref(), Some("demo"));

        let deep = Url::parse("https://formlogic.com/open/app/event-hub").unwrap();
        assert_eq!(slug_of(&deep).as_deref(), Some("event-hub"));

        // The runtime's own shell is never treated as a hosted app.
        let shell = Url::parse("http://tauri.localhost/index.html").unwrap();
        assert_eq!(hosted_app_origin(&shell), None);
        // Non-web schemes are excluded.
        assert_eq!(hosted_app_origin(&Url::parse("tauri://localhost/").unwrap()), None);
    }

    // ---- #15: persistent offline sync queue ----

    fn temp_queue_path(tag: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("fl-sync-test-{tag}-{n}.json"))
    }

    #[test]
    fn sync_queue_enqueue_persist_reload_ack() {
        let path = temp_queue_path("main");
        let _ = std::fs::remove_file(&path);

        let queue = PersistentSyncQueue::load(path.clone());
        let id1 = queue.enqueue(&json!({ "appSlug": "demo", "formId": "f1", "answers": { "a": 1 } }));
        let id2 = queue.enqueue(&json!({ "appSlug": "demo", "formId": "f2", "idempotencyKey": "k2", "answers": {} }));
        assert!(!id1.is_empty() && !id2.is_empty());
        assert_eq!(queue.get_queue().len(), 2);

        // flush groups pending items by appSlug and increments attempts, without removing them.
        let flushed = queue.flush();
        let pending = flushed["pending"].as_array().unwrap();
        assert_eq!(pending.len(), 1, "one appSlug group");
        assert_eq!(pending[0]["appSlug"], "demo");
        assert_eq!(pending[0]["items"].as_array().unwrap().len(), 2);
        assert_eq!(pending[0]["items"][0]["attempts"], 1);
        assert_eq!(pending[0]["items"][0]["status"], "pending");

        // Survives a process restart: a fresh queue reloads the same 2 items from disk.
        let reloaded = PersistentSyncQueue::load(path.clone());
        assert_eq!(reloaded.get_queue().len(), 2);

        // ack the first (accepted by the server) → removed; the other remains.
        let acked = reloaded.ack(&[id1.clone()]);
        assert_eq!(acked["acked"], 1);
        assert_eq!(acked["remaining"], 1);

        // Reload again → the ack persisted (1 item left), and it is id2.
        let after = PersistentSyncQueue::load(path.clone());
        let items = after.get_queue();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id2);

        // fail records lastError and keeps the item (still retryable under the attempt cap).
        let failed = after.fail(&[id2.clone()], "network down");
        assert_eq!(failed["failed"], 1);
        let final_items = PersistentSyncQueue::load(path.clone()).get_queue();
        assert_eq!(final_items.len(), 1);
        assert_eq!(final_items[0].last_error.as_deref(), Some("network down"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sync_queue_fail_promotes_after_max_attempts() {
        let path = temp_queue_path("poison");
        let _ = std::fs::remove_file(&path);
        let queue = PersistentSyncQueue::load(path.clone());
        let id = queue.enqueue(&json!({ "appSlug": "demo", "formId": "f", "answers": {} }));
        // Flush repeatedly (each flush bumps attempts) then fail past the cap → terminal "failed".
        for _ in 0..(MAX_SYNC_ATTEMPTS + 1) {
            queue.flush();
        }
        queue.fail(&[id], "boom");
        let items = queue.get_queue();
        assert_eq!(items[0].status, "failed");
        // A terminal item is no longer returned by flush().
        let pending = queue.flush();
        assert_eq!(pending["pending"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_file(&path);
    }

    // ---- #12: canonical JSON reproduction + Ed25519 verification ----

    #[test]
    fn php_canonical_matches_signing_service() {
        // Mirrors SigningService::canonical (JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE):
        // key insertion order preserved, forward slashes NOT escaped, UTF-8 NOT escaped.
        let payload = json!({
            "version": 1,
            "source": { "url": "http://formlogic.local/app/demo" },
            "arr": [],
            "name": "Café — déjà vu"
        });
        let expected =
            "{\"version\":1,\"source\":{\"url\":\"http://formlogic.local/app/demo\"},\"arr\":[],\"name\":\"Café — déjà vu\"}";
        assert_eq!(php_canonical(&payload), expected);

        // The assoc round-trip collapses an empty object {} to [] (PHP json_decode assoc).
        assert_eq!(php_canonical(&json!({ "settings": {} })), "{\"settings\":[]}");
    }

    #[test]
    fn ed25519_verify_against_generated_vector() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        // Deterministic keypair from a fixed seed (no RNG feature needed).
        let seed: [u8; 32] = [7u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();

        let payload = json!({
            "version": 1,
            "appSlug": "demo",
            "native": { "capabilities": [ { "connector": "vehicle", "commands": ["status.read"] } ] }
        });

        // Sign the canonical bytes exactly as the server would, then encode like SigningService:
        // signature as base64url (no padding), public key as standard base64.
        let message = php_canonical(&payload);
        let signature = signing_key.sign(message.as_bytes());
        let sig_b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(verifying_key.to_bytes());

        // A valid signature over the untampered payload verifies.
        assert!(verify_ed25519(&payload, &sig_b64url, &pubkey_b64).is_ok());

        // Tampering the payload (adding a capability the server never signed) must fail.
        let tampered = json!({
            "version": 1,
            "appSlug": "demo",
            "native": { "capabilities": [ { "connector": "vehicle", "commands": ["status.read", "gps.read"] } ] }
        });
        assert!(verify_ed25519(&tampered, &sig_b64url, &pubkey_b64).is_err());

        // A padded base64url signature (should not occur, but be lenient) still verifies.
        let padded = base64::engine::general_purpose::URL_SAFE.encode(signature.to_bytes());
        assert!(verify_ed25519(&payload, &padded, &pubkey_b64).is_ok());
    }

    #[test]
    fn ed25519_verify_php_libsodium_vector() {
        // Cross-language vector: signature + public key produced by the ACTUAL server crypto
        // (PHP 8.4 libsodium sodium_crypto_sign_detached over SigningService::canonical, seed
        // = 0x07*32), proving the native runtime verifies real server manifests — not just
        // dalek-vs-dalek. Ed25519 is deterministic, so this is stable.
        let payload = json!({
            "version": 1,
            "appSlug": "demo",
            "native": { "capabilities": [ { "connector": "vehicle", "commands": ["status.read"] } ] }
        });
        let sig_b64url = "-Q_F70p5VMPGLCRuz82N1umZ5q36iCxCgEY5bg8ruigXxrIOqT2GERsFrpE9-j8zMaYIZFCYaKXHEBiXg10FCg";
        let pubkey_b64 = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
        assert!(
            verify_ed25519(&payload, sig_b64url, pubkey_b64).is_ok(),
            "must verify a signature produced by PHP libsodium over the canonical manifest"
        );
        // Tampering the payload invalidates the libsodium signature.
        let tampered = json!({ "version": 2, "appSlug": "demo", "native": {} });
        assert!(verify_ed25519(&tampered, sig_b64url, pubkey_b64).is_err());
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
