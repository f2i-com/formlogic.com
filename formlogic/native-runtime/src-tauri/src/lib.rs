// FormLogic Native Runtime (Tauri v2).
//
// A generic desktop/mobile shell that loads a FormLogic app and exposes a small,
// approved set of native capabilities over `window.FormLogicNative` (spec §38/§39):
// a connector registry (device/vehicle data) and an offline sync queue. QuickJS app
// logic and SDK screens ask the connector for abstract commands (e.g. vehicle
// "status.read") and never touch the transport — here the transport is a mock,
// later it can be Bluetooth/USB/local-HTTP without the app changing.
//
// Trust boundary (spec §25 + NATIVE-SEC-001): the bridge is injected into every page, but
// connector / sync access is granted ONLY to an APP — keyed (origin, slug), never origin
// alone — whose SIGNED client manifest we have fetched and Ed25519-verified, AND whose
// origin's signing key the user explicitly trusts (TOFU pinning in `trust`; first use and
// key changes require a native consent dialog). An unverified page can still render, but
// its bridge is display-only — connector/sync calls reject with typed errors and the JS
// shim marks `available=false` so the web runtime falls back to browser mock connectors.
// The offline sync queue is partitioned by the verified app's signed identity and sealed
// at rest (`sync_queue`); every queue operation binds to the calling page's partition.
//
// Custom domains: the Tauri capability allowlist (capabilities/default.json) is the
// authoritative IPC boundary — only the origins listed there ever get `window.__TAURI__`.
// An app served from a custom domain therefore runs DISPLAY-ONLY in this runtime today
// (its bridge reports ipc_unavailable and the web runtime falls back), even though signed
// custom-domain manifests exist; enabling one requires shipping a build whose allowlist
// names that origin, at which point the TOFU pin + partition machinery covers it.

mod sync_queue;
mod trust;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use sync_queue::{Partition, PartitionedSyncQueue, QueueError, SyncItem};
use tauri::{window::Color, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;
use trust::PinnedKeys;

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

// Hard backstop for how long `runtime.ready()` parks awaiting a terminal verification. The web
// caller (nativeConnectorClient) applies its own ~3s timeout and proceeds best-effort, so this
// only bounds the blocking thread if verification never resolves (e.g. server unreachable).
const READY_WAIT_SECS: u64 = 10;

/// Contract (1): resolve the CURRENT page origin's signed-manifest verification state, awaiting
/// completion. Returns `{ verified: true }` once the Ed25519 client manifest verified and its
/// native capabilities loaded, or `{ verified: false }` once verification definitively failed
/// (or the page is not a hosted app under `/app/<slug>`, so there is nothing to verify).
///
/// The web runtime awaits this before the FIRST native connector request so an early
/// `onScreenEnter` read no longer races the async verifier into a non-fallbackable
/// `origin_denied`. Runs `async` + `spawn_blocking` so the condvar park never blocks the main
/// (UI) thread. Borrows `State`, so it must return a `Result` (Tauri async-command rule).
#[tauri::command]
async fn runtime_ready(
    webview: tauri::Webview,
    verified: tauri::State<'_, VerifiedOrigins>,
) -> Result<Value, String> {
    // Only a hosted app page under `/app/<slug>` triggers manifest verification; the shell and
    // any other page have no manifest, so they are never "verified". State is keyed per
    // (origin, slug): waiting on app B never resolves from app A's verification.
    let url = webview.url().ok();
    let origin = url.as_ref().and_then(hosted_app_origin);
    let slug = url.as_ref().and_then(slug_of);
    let (Some(origin), Some(slug)) = (origin, slug) else {
        return Ok(json!({ "verified": false }));
    };
    let key = app_key(&origin, &slug);
    let origins = verified.inner().clone();
    let flag = tauri::async_runtime::spawn_blocking(move || {
        origins.await_terminal(&key, Duration::from_secs(READY_WAIT_SECS))
    })
    .await
    .unwrap_or(false); // a join failure (verifier panic) is treated as "not verified".
    Ok(json!({ "verified": flag }))
}

#[tauri::command]
fn connector_list(webview: tauri::Webview, verified: tauri::State<VerifiedOrigins>) -> Vec<ConnectorSummary> {
    // Only a verified APP discovers native connectors; an unverified page is display-only
    // (the web runtime then sees no native connectors and uses its browser registry).
    let Some((origin, slug)) = caller_identity(&webview) else { return vec![] };
    let Some(caps) = verified.get(&app_key(&origin, &slug)) else { return vec![] };
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
// Offline sync queue — persisted, ENCRYPTED, and PARTITIONED by the caller's
// verified app identity (NATIVE-SEC-001; implementation in sync_queue.rs).
//
// The native side does NOT POST to the server: the WebView holds the session cookie, so
// `sync_flush` RETURNS pending items grouped by appSlug to the caller (read-only — it never
// mutates attempts), which POSTs them to `/api/app/{slug}/sync/batch`, then calls
// `sync_ack(ids)` for the ones the server accepted (removing them) and `sync_fail(ids, error)`
// for the rest. Every one of those operations is bound to the trust partition of the PAGE
// making the call — an app can only ever see/deliver/ack/fail its own items.
//
// Mutations are fail-closed: a persistence failure rejects with the typed
// `queue_persist_failed` error (the web layer falls back to its browser
// IndexedDB queue) instead of reporting success for a row the disk doesn't
// hold. A partition at quota rejects with `queue_full`.
// ---------------------------------------------------------------------------
const CODE_QUEUE_PERSIST_FAILED: &str = "queue_persist_failed";
const CODE_QUEUE_FULL: &str = "queue_full";

fn queue_err(e: QueueError) -> String {
    match e {
        QueueError::Full(msg) => conn_err(CODE_QUEUE_FULL, msg),
        QueueError::Persist(msg) => conn_err(CODE_QUEUE_PERSIST_FAILED, msg),
    }
}

#[tauri::command]
fn sync_enqueue(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PartitionedSyncQueue>,
    item: Value,
) -> Result<Value, String> {
    let partition = require_verified_partition(&webview, &verified)?;
    let id = state.enqueue(&partition, &item).map_err(queue_err)?;
    Ok(json!({ "id": id }))
}

#[tauri::command]
fn sync_get_queue(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PartitionedSyncQueue>,
) -> Result<Vec<SyncItem>, String> {
    let partition = require_verified_partition(&webview, &verified)?;
    Ok(state.get_queue(&partition))
}

#[tauri::command]
fn sync_flush(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PartitionedSyncQueue>,
) -> Result<Value, String> {
    let partition = require_verified_partition(&webview, &verified)?;
    Ok(state.flush(&partition))
}

#[tauri::command]
fn sync_ack(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PartitionedSyncQueue>,
    ids: Vec<String>,
) -> Result<Value, String> {
    let partition = require_verified_partition(&webview, &verified)?;
    state.ack(&partition, &ids).map_err(queue_err)
}

#[tauri::command]
fn sync_fail(
    webview: tauri::Webview,
    verified: tauri::State<VerifiedOrigins>,
    state: tauri::State<PartitionedSyncQueue>,
    ids: Vec<String>,
    error: String,
    terminal: Option<bool>,
) -> Result<Value, String> {
    let partition = require_verified_partition(&webview, &verified)?;
    // `terminal` is an optional third argument so callers built against the older
    // two-argument shape keep the retryable (attempt-counting) behavior.
    state
        .fail(&partition, &ids, &error, terminal.unwrap_or(false))
        .map_err(queue_err)
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

/// Native capabilities granted to one verified APP (flattened
/// "connector.command" keys), plus the signed identity used to partition
/// the offline queue (NATIVE-SEC-001): appId/accountId/manifestVersion all
/// come from the Ed25519-verified manifest payload, never from the page.
#[derive(Clone, Default)]
struct VerifiedCaps {
    slug: String,
    capabilities: HashSet<String>,
    /// Signed `appId` (empty on servers that predate NATIVE-SEC-001).
    app_id: String,
    /// Signed opaque `accountId` (empty on older servers).
    account_id: String,
    /// Signed `manifestVersion` (empty on older servers).
    manifest_version: String,
}

impl VerifiedCaps {
    fn grants(&self, connector: &str, command: &str) -> bool {
        self.capabilities.contains(&format!("{connector}.{command}"))
    }
    fn grants_any(&self, connector: &str) -> bool {
        let prefix = format!("{connector}.");
        self.capabilities.iter().any(|k| k.starts_with(&prefix))
    }

    /// The trust partition queue operations bind to. Older servers without
    /// signed appId fall back to the verified slug — still app-scoped,
    /// because check_manifest_identity pinned the slug to the manifest.
    fn partition(&self, origin: &str) -> Partition {
        Partition {
            origin: origin.to_string(),
            account_id: self.account_id.clone(),
            app_id: if self.app_id.is_empty() {
                self.slug.clone()
            } else {
                self.app_id.clone()
            },
            app_slug: self.slug.clone(),
            manifest_version: self.manifest_version.clone(),
        }
    }
}

/// Verification-state key: one entry per (origin, app slug) — NEVER per
/// origin alone. Two apps on the same origin (the platform host serves
/// every /app/<slug>) verify independently, so navigating app A → app B
/// can't carry A's capabilities across (NATIVE-SEC-001).
fn app_key(origin: &str, slug: &str) -> String {
    format!("{origin}|{slug}")
}

/// The verification state of one APP (key = `app_key(origin, slug)`). The bridge injects
/// `available=true` optimistically and verifies the signed manifest asynchronously, so an app
/// passes through `Pending` (verifier thread running) before reaching a terminal
/// `Verified`/`Failed`. `runtime.ready()` awaits that terminal transition so an early
/// connector read never races the verifier.
#[derive(Clone)]
enum OriginVerification {
    /// Signed-manifest verification is in flight (thread spawned, not yet terminal).
    Pending,
    /// Verified: the Ed25519 client manifest checked out; these native caps are granted.
    Verified(VerifiedCaps),
    /// Verification definitively failed (missing/invalid signature, fetch error, slug mismatch…).
    Failed,
}

/// Per-APP verification state, keyed `origin|slug` (NATIVE-SEC-001). Shared (Arc) between the
/// page-load verifier and the bridge command handlers. The `Condvar` lets `runtime.ready()`
/// park until an app becomes terminal (Verified/Failed) instead of racing the async verifier
/// or busy-polling.
#[derive(Clone)]
struct VerifiedOrigins(Arc<(Mutex<HashMap<String, OriginVerification>>, Condvar)>);

impl Default for VerifiedOrigins {
    fn default() -> Self {
        VerifiedOrigins(Arc::new((Mutex::new(HashMap::new()), Condvar::new())))
    }
}

impl VerifiedOrigins {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, OriginVerification>> {
        let (lock, _) = &*self.0;
        lock.lock().unwrap()
    }

    /// The granted caps for a Verified origin; None while Pending, on Failure, or when absent.
    fn get(&self, origin: &str) -> Option<VerifiedCaps> {
        match self.lock().get(origin) {
            Some(OriginVerification::Verified(caps)) => Some(caps.clone()),
            _ => None,
        }
    }

    /// True only once the key has reached the terminal `Verified` state. Production paths
    /// read caps via `get`; this remains for the state-transition tests.
    #[cfg_attr(not(test), allow(dead_code))]
    fn contains(&self, origin: &str) -> bool {
        matches!(self.lock().get(origin), Some(OriginVerification::Verified(_)))
    }

    /// Atomically claim verification for an origin: mark it `Pending` and return true iff the
    /// caller should start the verifier thread. Returns false when the origin is already
    /// `Verified` or already `Pending` (a verification is in flight) to avoid duplicate work; a
    /// previously `Failed` origin is retried (re-marked `Pending`) on a fresh navigation.
    fn begin_verification(&self, origin: &str) -> bool {
        let mut map = self.lock();
        let in_flight = matches!(
            map.get(origin),
            Some(OriginVerification::Verified(_)) | Some(OriginVerification::Pending)
        );
        if !in_flight {
            map.insert(origin.to_string(), OriginVerification::Pending);
        }
        !in_flight
    }

    /// Record a successful verification and wake any `ready()` waiters.
    fn insert_verified(&self, origin: String, caps: VerifiedCaps) {
        let (lock, cvar) = &*self.0;
        lock.lock().unwrap().insert(origin, OriginVerification::Verified(caps));
        cvar.notify_all();
    }

    /// Record a definitive verification failure and wake any `ready()` waiters.
    fn mark_failed(&self, origin: String) {
        let (lock, cvar) = &*self.0;
        lock.lock().unwrap().insert(origin, OriginVerification::Failed);
        cvar.notify_all();
    }

    /// Park until the origin's verification is terminal (`Verified`/`Failed`) or `timeout`
    /// elapses. Returns true iff it ended `Verified`. An origin still `Pending`/absent at the
    /// deadline yields false so `ready()` resolves `{verified:false}` best-effort (the TS caller
    /// applies its own shorter timeout; this is only the hard backstop for the blocking thread).
    fn await_terminal(&self, origin: &str, timeout: Duration) -> bool {
        let (lock, cvar) = &*self.0;
        let deadline = Instant::now() + timeout;
        let mut map = lock.lock().unwrap();
        loop {
            match map.get(origin) {
                Some(OriginVerification::Verified(_)) => return true,
                Some(OriginVerification::Failed) => return false,
                _ => {} // Pending or absent (verifier not yet registered): keep waiting.
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (guard, res) = cvar.wait_timeout(map, deadline - now).unwrap();
            map = guard;
            if res.timed_out() {
                // Final check after the timeout, then give up.
                return matches!(map.get(origin), Some(OriginVerification::Verified(_)));
            }
        }
    }
}

/// The (origin, slug) identity of the calling webview's CURRENT page, or
/// None for the shell / a non-web origin / a page outside /app/<slug>.
/// Re-derived on every command, so a navigation to another app immediately
/// changes which verification (if any) the caller is bound to.
fn caller_identity(webview: &tauri::Webview) -> Option<(String, String)> {
    let url = webview.url().ok()?;
    let origin = hosted_app_origin(&url)?;
    let slug = slug_of(&url)?;
    Some((origin, slug))
}

/// The calling APP's verified caps, or the origin_denied typed error.
fn require_caps(webview: &tauri::Webview, verified: &VerifiedOrigins) -> Result<VerifiedCaps, String> {
    let (origin, slug) = caller_identity(webview)
        .ok_or_else(|| conn_err(CODE_ORIGIN_DENIED, "This page has no verified FormLogic manifest."))?;
    verified.get(&app_key(&origin, &slug)).ok_or_else(|| {
        conn_err(
            CODE_ORIGIN_DENIED,
            format!("App \"{slug}\" on {origin} has not passed signed-manifest verification."),
        )
    })
}

/// Gate for sync commands: the caller must be a VERIFIED app, and every
/// queue operation binds to that app's trust partition (NATIVE-SEC-001).
fn require_verified_partition(
    webview: &tauri::Webview,
    verified: &VerifiedOrigins,
) -> Result<Partition, String> {
    let (origin, slug) = caller_identity(webview)
        .ok_or_else(|| conn_err(CODE_ORIGIN_DENIED, "This page has no verified FormLogic manifest."))?;
    let caps = verified.get(&app_key(&origin, &slug)).ok_or_else(|| {
        conn_err(
            CODE_ORIGIN_DENIED,
            format!("App \"{slug}\" on {origin} has not passed signed-manifest verification."),
        )
    })?;
    Ok(caps.partition(&origin))
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

/// Flatten `payload.native.capabilities` into a set of "connector.command" grant keys,
/// and lift the signed identity fields the queue partition is built from.
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
    let field = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    VerifiedCaps {
        slug: field("appSlug"),
        capabilities,
        app_id: field("appId"),
        account_id: field("accountId"),
        manifest_version: field("manifestVersion"),
    }
}

fn http_get(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().map_err(|e| format!("GET {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url} returned HTTP {}", resp.status().as_u16()));
    }
    resp.text().map_err(|e| format!("reading {url} failed: {e}"))
}

/// The lowercased host of an http/https origin string (`scheme://host[:port]`), without the port.
/// Used to pin a same-origin custom-domain manifest's top-level `domain` field to the origin that
/// actually served it. Matches PHP AppDomainService::normalizeDomain (lowercase host, no port).
fn origin_host(origin: &str) -> Option<String> {
    Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

/// Parse a signed-manifest envelope from raw response text. Returns None when the text is not
/// JSON or lacks the signed-envelope shape (a `payload` + `signature`) — e.g. a `{error:true}`
/// 404 body. The well-known probe uses this None as the signal to fall back to the API manifest.
fn parse_manifest_envelope(text: &str) -> Option<Value> {
    let envelope: Value = serde_json::from_str(text).ok()?;
    if envelope.get("payload").is_some() && envelope.get("signature").is_some() {
        Some(envelope)
    } else {
        None
    }
}

/// Choose the signed manifest envelope, PREFERRING the same-origin custom-domain manifest at
/// `{origin}/.well-known/formlogic-app.json`. When that probe fails (404 / unreachable) or does
/// not parse as a signed envelope, FALL BACK to `{origin}/api/app/{slug}/client-manifest`.
/// `fetch` is the transport (injected so the selection logic is unit-testable without HTTP); it is
/// called lazily, so the API fallback is only fetched when the well-known source is unusable.
fn choose_manifest_envelope<F>(origin: &str, slug: &str, mut fetch: F) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    let well_known_url = format!("{origin}/.well-known/formlogic-app.json");
    if let Ok(text) = fetch(&well_known_url) {
        if let Some(envelope) = parse_manifest_envelope(&text) {
            return Ok(envelope);
        }
    }
    let api_url = format!("{origin}/api/app/{slug}/client-manifest");
    let text = fetch(&api_url)?;
    serde_json::from_str(&text).map_err(|e| format!("client manifest is not JSON: {e}"))
}

/// After the Ed25519 signature checks out, enforce that the signed manifest actually describes the
/// app+origin we navigated to (spec §25 hardening): a payload `appSlug` (if present) must match the
/// URL slug, and a top-level `domain` MUST be present and match the current origin host. A mismatch —
/// or a MISSING domain — is a HARD verification failure: the caller keeps the webview display-only
/// rather than granting native capabilities from a manifest bound elsewhere. The server binds `domain`
/// on every route (the custom-domain host, or the platform host for the slug route), so a domain-less
/// manifest is a replay attempt — a validly-signed manifest served from a foreign origin — and is refused.
fn check_manifest_identity(payload: &Value, slug: &str, origin_host: Option<&str>) -> Result<(), String> {
    if let Some(manifest_slug) = payload.get("appSlug").and_then(Value::as_str) {
        if manifest_slug != slug {
            return Err(format!(
                "manifest appSlug \"{manifest_slug}\" does not match navigated slug \"{slug}\""
            ));
        }
    }
    let domain = payload
        .get("domain")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| "manifest is missing a signed `domain` origin binding".to_string())?;
    let host = origin_host.unwrap_or("");
    if !domain.eq_ignore_ascii_case(host) {
        return Err(format!(
            "manifest domain \"{domain}\" does not match current origin host \"{host}\""
        ));
    }
    Ok(())
}

/// Verify a signed manifest envelope (`payload` + `signature` + `alg`) against the server's public
/// key, then enforce the appSlug/domain identity match. On success returns the granted native caps.
fn verify_manifest_envelope(
    envelope: &Value,
    public_key: &str,
    slug: &str,
    origin_host: Option<&str>,
) -> Result<VerifiedCaps, String> {
    let payload = envelope.get("payload").ok_or("manifest has no payload")?;
    let signature = envelope
        .get("signature")
        .and_then(Value::as_str)
        .ok_or("manifest has no signature")?;
    let alg = envelope.get("alg").and_then(Value::as_str).unwrap_or("");
    if alg != "Ed25519" {
        return Err(format!("manifest alg is \"{alg}\", not publicly verifiable"));
    }
    verify_ed25519(payload, signature, public_key)?;
    check_manifest_identity(payload, slug, origin_host)?;
    Ok(extract_caps(payload))
}

/// Fetch the app's signed client manifest (preferring the same-origin custom-domain manifest at
/// `/.well-known/formlogic-app.json`, else the slug-addressed `/api/app/{slug}/client-manifest`)
/// plus `{origin}/api/public/signing-key`, verify the manifest's detached Ed25519 signature, and
/// enforce that its appSlug/domain match the navigated slug + origin host.
///
/// NATIVE-SEC-001: the manifest AND the key come from the SAME navigated origin, so the
/// signature alone only proves internal consistency — a malicious origin could serve its own
/// manifest signed by its own key. The TOFU pin store (`trust.rs`) breaks that self-assertion:
/// a first-seen key needs the user's explicit confirmation (fingerprint shown) before ANY
/// native capability is granted, and a CHANGED key is a hard stop until explicitly re-trusted.
fn fetch_and_verify(
    origin: &str,
    slug: &str,
    pins: &PinnedKeys,
    confirm: &dyn Fn(&trust::TrustPrompt) -> bool,
) -> Result<VerifiedCaps, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let envelope = choose_manifest_envelope(origin, slug, |url| http_get(&client, url))?;

    let key: Value = serde_json::from_str(&http_get(&client, &format!("{origin}/api/public/signing-key"))?)
        .map_err(|e| format!("signing-key is not JSON: {e}"))?;
    let public_key = key
        .get("publicKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("server exposes no Ed25519 public key")?;

    // Signature + identity first (never prompt the user about a key that can't even
    // produce a valid manifest), then the origin-trust decision.
    let caps = verify_manifest_envelope(&envelope, public_key, slug, origin_host(origin).as_deref())?;
    trust::evaluate_trust(pins, origin, slug, public_key, sync_queue::now_iso(), confirm)?;
    Ok(caps)
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
      pendingDeepLink: function () { return invoke('pending_deep_link'); },
      // Contract (1): resolves once THIS origin's signed-manifest verification has completed —
      // { verified:true } when the Ed25519 manifest verified + caps loaded, { verified:false }
      // when it definitively failed (or this page has no manifest). The web runtime awaits this
      // before its first native connector request so an early read never races the verifier.
      // Always resolves to the {verified:boolean} shape (never rejects).
      ready: function () {
        return invoke('runtime_ready').then(
          function (r) { return { verified: !!(r && r.verified === true) }; },
          function () { return { verified: false }; }
        );
      }
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
    // fail() records a retryable failure (one attempt; terminal at the native cap);
    // failTerminal() marks 'failed' immediately for errors that can never succeed on retry
    // (e.g. an idempotency conflict). Callers feature-detect failTerminal (older runtimes lack it).
    sync: {
      enqueueSubmission: function (item) { return call('sync_enqueue', { item: item }); },
      getQueue: function () { return call('sync_get_queue'); },
      flush: function () { return call('sync_flush'); },
      ack: function (ids) { return call('sync_ack', { ids: ids || [] }); },
      fail: function (ids, error) { return call('sync_fail', { ids: ids || [], error: String(error == null ? '' : error) }); },
      failTerminal: function (ids, error) { return call('sync_fail', { ids: ids || [], error: String(error == null ? '' : error), terminal: true }); }
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let nav_state = Arc::new(DeepLinkNav::default());
            app.manage(nav_state.clone()); // read by the `pending_deep_link` command

            // Per-APP verified capabilities (keyed origin|slug), shared with the bridge
            // command handlers.
            let verified = VerifiedOrigins::default();
            app.manage(verified.clone());

            // App data dir hosts the queue, its encryption key, and the TOFU pin store.
            let data_dir = app
                .path()
                .app_data_dir()
                .inspect(|dir| {
                    let _ = std::fs::create_dir_all(dir);
                })
                .unwrap_or_else(|_| std::env::temp_dir());

            // TOFU signing-key pins (NATIVE-SEC-001) — read by the page-load verifier.
            app.manage(PinnedKeys::load(data_dir.join("pinned-keys.json")));

            // Persisted offline sync queue: partitioned by verified app identity,
            // sealed at rest, fail-closed on persistence errors.
            app.manage(PartitionedSyncQueue::load(
                data_dir.join("sync-queue.json"),
                &data_dir,
            ));

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
                    // bridge display-only. Verification is keyed per (origin, slug) — app B
                    // on the same origin NEVER inherits app A's verification — and gated by
                    // the TOFU signing-key pin (explicit user consent on first use / change).
                    let url = payload.url().clone();
                    if let (Some(origin), Some(slug)) = (hosted_app_origin(&url), slug_of(&url)) {
                        let key = app_key(&origin, &slug);
                        // Claim verification: mark the app Pending (so runtime.ready() can await
                        // it) and only spawn when no verification is already done/in-flight.
                        if verified_pl.begin_verification(&key) {
                            let wv = webview.clone();
                            let vmap = verified_pl.clone();
                            std::thread::spawn(move || {
                                let app = wv.app_handle();
                                let pins = app.state::<PinnedKeys>();
                                // Explicit-consent hook: a NATIVE dialog (not page content, which
                                // an untrusted origin controls). blocking_show is safe here — this
                                // is a spawned thread, never the main/UI thread.
                                let dialog_app = app.clone();
                                let confirm = move |p: &trust::TrustPrompt| -> bool {
                                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                                    let (title, body) = trust::prompt_text(p);
                                    dialog_app
                                        .dialog()
                                        .message(body)
                                        .title(title)
                                        .kind(match p {
                                            trust::TrustPrompt::FirstUse { .. } => MessageDialogKind::Warning,
                                            trust::TrustPrompt::Rotation { .. } => MessageDialogKind::Error,
                                        })
                                        .buttons(MessageDialogButtons::OkCancelCustom(
                                            "Trust this server".into(),
                                            "Keep display-only".into(),
                                        ))
                                        .blocking_show()
                                };
                                match fetch_and_verify(&origin, &slug, &pins, &confirm) {
                                    Ok(caps) => {
                                        eprintln!("[formlogic] manifest verified for {origin} ({slug})");
                                        vmap.insert_verified(key, caps);
                                    }
                                    Err(e) => {
                                        eprintln!("[formlogic] manifest verification FAILED for {origin} ({slug}): {e}");
                                        // Record the terminal failure (unblocks ready() with verified=false)
                                        // and flip the bridge to display-only so the web runtime falls back.
                                        vmap.mark_failed(key);
                                        let _ = wv.eval(
                                            "try{if(window.FormLogicNative){window.FormLogicNative.available=false;delete window.FormLogicNative.connectors;delete window.FormLogicNative.sync;}}catch(_){}"
                                        );
                                    }
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
            runtime_ready,
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
        let caps = VerifiedCaps { slug: "demo".into(), capabilities, ..Default::default() };
        assert!(caps.grants("vehicle", "status.read"));
        assert!(!caps.grants("vehicle", "gps.read"));
        assert!(caps.grants_any("vehicle"));
        assert!(!caps.grants_any("printer"));
    }

    // ---- contract (1): runtime.ready() awaits the per-origin verification transition ----

    #[test]
    fn ready_state_transitions_pending_to_verified() {
        use std::thread;
        let origins = VerifiedOrigins::default();
        let origin = "http://localhost:8090".to_string();

        // First navigation claims verification (marks Pending); a concurrent second claim is a
        // no-op so we never spawn a duplicate verifier thread.
        assert!(origins.begin_verification(&origin), "first claim marks Pending");
        assert!(!origins.begin_verification(&origin), "in-flight claim is a no-op");
        // While Pending the origin is not yet trusted: no caps, not "contained".
        assert!(!origins.contains(&origin), "Pending origin is not yet verified");
        assert!(origins.get(&origin).is_none(), "no caps while Pending");

        // A background verifier flips Pending -> Verified; ready() (await_terminal) must observe it.
        let bg = origins.clone();
        let org = origin.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(40));
            let mut caps = HashSet::new();
            caps.insert("vehicle.status.read".to_string());
            bg.insert_verified(
                org,
                VerifiedCaps { slug: "demo".into(), capabilities: caps, ..Default::default() },
            );
        });
        assert!(
            origins.await_terminal(&origin, Duration::from_secs(5)),
            "await_terminal resolves true once the manifest verifies"
        );
        assert!(origins.contains(&origin));
        assert!(origins.get(&origin).is_some(), "caps are available after verification");
    }

    #[test]
    fn ready_state_transitions_pending_to_failed_and_retries() {
        use std::thread;
        let origins = VerifiedOrigins::default();
        let origin = "https://evil.example".to_string();
        assert!(origins.begin_verification(&origin));

        let bg = origins.clone();
        let org = origin.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(40));
            bg.mark_failed(org);
        });
        assert!(
            !origins.await_terminal(&origin, Duration::from_secs(5)),
            "await_terminal resolves false once verification definitively fails"
        );
        assert!(!origins.contains(&origin));
        assert!(origins.get(&origin).is_none());

        // A previously-failed origin is retried (re-claimable) on a fresh navigation.
        assert!(origins.begin_verification(&origin), "failed origin is retryable");
    }

    #[test]
    fn ready_times_out_when_verification_never_resolves() {
        let origins = VerifiedOrigins::default();
        // Pending forever (verifier hung / server unreachable): await_terminal backstops to false.
        assert!(origins.begin_verification("http://pending.forever"));
        let start = Instant::now();
        assert!(
            !origins.await_terminal("http://pending.forever", Duration::from_millis(120)),
            "an unresolved verification times out to false"
        );
        assert!(
            start.elapsed() >= Duration::from_millis(100),
            "await_terminal parked for the timeout rather than returning early"
        );
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

    // (The offline sync queue's tests — partitioning, encryption at rest,
    // fail-closed persistence, quotas, corruption quarantine, legacy
    // adoption, attempt semantics — live in sync_queue.rs; the TOFU pin
    // store's tests live in trust.rs.)

    // ---- NATIVE-SEC-001: per-app verification keys + queue partitions ----

    #[test]
    fn app_keys_separate_apps_on_one_origin() {
        // Two apps on the SAME origin verify independently — the key is the
        // unit of trust, so navigating app A → app B can't reuse A's caps.
        let origins = VerifiedOrigins::default();
        let key_a = app_key("https://formlogic.com", "alpha");
        let key_b = app_key("https://formlogic.com", "beta");
        assert_ne!(key_a, key_b);
        let mut capabilities = HashSet::new();
        capabilities.insert("vehicle.status.read".to_string());
        origins.insert_verified(
            key_a.clone(),
            VerifiedCaps { slug: "alpha".into(), capabilities, ..Default::default() },
        );
        assert!(origins.contains(&key_a));
        assert!(!origins.contains(&key_b), "app B is NOT verified by app A's manifest");
        assert!(origins.get(&key_b).is_none());
    }

    #[test]
    fn partition_uses_signed_identity_with_slug_fallback() {
        // A manifest with signed appId/accountId partitions by them…
        let caps = VerifiedCaps {
            slug: "demo".into(),
            app_id: "app-uuid-1".into(),
            account_id: "acct-hash".into(),
            manifest_version: "2026-07-12".into(),
            ..Default::default()
        };
        let p = caps.partition("https://x.example");
        assert_eq!(p.key(), "https://x.example|acct-hash|app-uuid-1");
        assert_eq!(p.app_slug, "demo");
        assert_eq!(p.manifest_version, "2026-07-12");
        // …an older server without them still partitions per app via the slug
        // (which check_manifest_identity pinned to the signed manifest).
        let legacy = VerifiedCaps { slug: "demo".into(), ..Default::default() };
        assert_eq!(legacy.partition("https://x.example").key(), "https://x.example||demo");
    }

    #[test]
    fn extract_caps_lifts_signed_identity() {
        let payload = json!({
            "appSlug": "fleet",
            "appId": "0b1c2d3e",
            "accountId": "a1b2c3d4e5f60708",
            "manifestVersion": "2026-07-12 10:00:00",
            "native": { "capabilities": [
                { "connector": "vehicle", "commands": ["status.read"] }
            ]}
        });
        let caps = extract_caps(&payload);
        assert_eq!(caps.app_id, "0b1c2d3e");
        assert_eq!(caps.account_id, "a1b2c3d4e5f60708");
        assert_eq!(caps.manifest_version, "2026-07-12 10:00:00");
        // Absent fields (older server) degrade to empty, not panic.
        let old = extract_caps(&json!({ "appSlug": "fleet", "native": {} }));
        assert_eq!(old.app_id, "");
        assert_eq!(old.account_id, "");
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

    // ---- TASK #2: well-known manifest preference + appSlug/domain identity pinning ----

    #[test]
    fn origin_host_strips_scheme_and_port() {
        assert_eq!(origin_host("https://Apps.Example.com").as_deref(), Some("apps.example.com"));
        assert_eq!(origin_host("http://localhost:8090").as_deref(), Some("localhost"));
        assert_eq!(origin_host("https://fleet.acme.co:8443/app/x").as_deref(), Some("fleet.acme.co"));
        assert_eq!(origin_host("not a url"), None);
    }

    #[test]
    fn parse_manifest_envelope_gates_on_signed_shape() {
        // A signed envelope (payload + signature) parses.
        let env = parse_manifest_envelope(r#"{"alg":"Ed25519","payload":{"appSlug":"demo"},"signature":"abc"}"#);
        assert!(env.is_some());
        // A 404 error body / anything lacking payload+signature is rejected (→ fall back).
        assert!(parse_manifest_envelope(r#"{"error":true,"message":"Not found"}"#).is_none());
        assert!(parse_manifest_envelope(r#"{"payload":{"appSlug":"demo"}}"#).is_none()); // no signature
        // Non-JSON is rejected.
        assert!(parse_manifest_envelope("<html>404</html>").is_none());
        assert!(parse_manifest_envelope("").is_none());
    }

    #[test]
    fn choose_manifest_prefers_well_known_and_skips_api() {
        // The well-known custom-domain manifest is valid → it is used and the API is NEVER fetched.
        let mut fetched: Vec<String> = Vec::new();
        let env = choose_manifest_envelope("https://fleet.acme.co", "demo", |url| {
            fetched.push(url.to_string());
            if url.ends_with("/.well-known/formlogic-app.json") {
                Ok(r#"{"alg":"Ed25519","payload":{"appSlug":"demo","domain":"fleet.acme.co"},"signature":"sig"}"#.to_string())
            } else {
                panic!("API manifest must not be fetched when well-known succeeds");
            }
        })
        .expect("well-known envelope selected");
        assert_eq!(env.pointer("/payload/domain").and_then(Value::as_str), Some("fleet.acme.co"));
        assert_eq!(fetched, vec!["https://fleet.acme.co/.well-known/formlogic-app.json".to_string()]);
    }

    #[test]
    fn choose_manifest_falls_back_when_well_known_missing_or_unparseable() {
        // (a) well-known 404s (Err) → fall back to the slug-addressed API manifest.
        let mut fetched: Vec<String> = Vec::new();
        let env = choose_manifest_envelope("https://app.formlogic.com", "demo", |url| {
            fetched.push(url.to_string());
            if url.contains("/.well-known/") {
                Err("GET returned HTTP 404".to_string())
            } else {
                Ok(r#"{"alg":"Ed25519","payload":{"appSlug":"demo"},"signature":"sig"}"#.to_string())
            }
        })
        .expect("API fallback selected");
        assert_eq!(env.pointer("/payload/appSlug").and_then(Value::as_str), Some("demo"));
        assert_eq!(
            fetched,
            vec![
                "https://app.formlogic.com/.well-known/formlogic-app.json".to_string(),
                "https://app.formlogic.com/api/app/demo/client-manifest".to_string(),
            ]
        );

        // (b) well-known returns a non-envelope body (e.g. a JSON error) → also falls back.
        let env2 = choose_manifest_envelope("https://app.formlogic.com", "demo", |url| {
            if url.contains("/.well-known/") {
                Ok(r#"{"error":true,"message":"Not found"}"#.to_string())
            } else {
                Ok(r#"{"alg":"Ed25519","payload":{"appSlug":"demo"},"signature":"sig"}"#.to_string())
            }
        })
        .expect("API fallback selected on non-envelope well-known body");
        assert_eq!(env2.pointer("/payload/appSlug").and_then(Value::as_str), Some("demo"));

        // (c) both sources unusable → the API fetch error propagates.
        let err = choose_manifest_envelope("https://x.example", "demo", |_url| Err("boom".to_string()))
            .unwrap_err();
        assert_eq!(err, "boom");
    }

    #[test]
    fn check_manifest_identity_enforces_slug_and_domain() {
        // appSlug must match the navigated slug (when present) — checked alongside the required domain.
        let slug_bad = json!({ "appSlug": "other", "domain": "demo.example.com" });
        assert!(check_manifest_identity(&slug_bad, "demo", Some("demo.example.com")).is_err());

        // A signed manifest MUST carry a `domain` matching the origin host (the server binds it on every
        // route). A matching domain (case-insensitive) grants.
        let dom_ok = json!({ "appSlug": "demo", "domain": "Fleet.Acme.CO" });
        assert!(check_manifest_identity(&dom_ok, "demo", Some("fleet.acme.co")).is_ok());
        // Wrong host → hard failure.
        let dom_bad = json!({ "appSlug": "demo", "domain": "fleet.acme.co" });
        assert!(check_manifest_identity(&dom_bad, "demo", Some("evil.example.com")).is_err());
        // Domain present but no origin host known → failure (cannot pin).
        assert!(check_manifest_identity(&dom_bad, "demo", None).is_err());
        // MISSING domain → REJECTED: a validly-signed but domain-less manifest replayed onto a foreign
        // origin must not verify (the replay attack this pin closes).
        assert!(check_manifest_identity(&json!({ "appSlug": "demo" }), "demo", Some("demo.example.com")).is_err());
        // EMPTY domain is treated as missing → also rejected.
        assert!(check_manifest_identity(&json!({ "appSlug": "demo", "domain": "" }), "demo", Some("x")).is_err());
    }

    #[test]
    fn verify_manifest_envelope_signature_then_identity() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes());

        // Build a signed envelope for a custom-domain manifest (slug=demo, domain=fleet.acme.co).
        let make_envelope = |payload: &Value| -> Value {
            let msg = php_canonical(payload);
            let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signing_key.sign(msg.as_bytes()).to_bytes());
            json!({ "alg": "Ed25519", "payload": payload, "signature": sig })
        };

        let payload = json!({
            "version": 1,
            "appSlug": "demo",
            "domain": "fleet.acme.co",
            "native": { "capabilities": [ { "connector": "vehicle", "commands": ["status.read"] } ] }
        });
        let envelope = make_envelope(&payload);

        // Signature valid + slug matches + domain matches origin host → verified, caps granted.
        let caps = verify_manifest_envelope(&envelope, &pubkey_b64, "demo", Some("fleet.acme.co"))
            .expect("valid manifest verifies");
        assert!(caps.grants("vehicle", "status.read"));

        // Same (validly signed) envelope but the navigated slug differs → identity failure.
        assert!(verify_manifest_envelope(&envelope, &pubkey_b64, "not-demo", Some("fleet.acme.co")).is_err());

        // Same envelope served from the WRONG origin host → domain pin fails even though the
        // signature is valid (a manifest bound to fleet.acme.co can't authorize evil.example.com).
        assert!(verify_manifest_envelope(&envelope, &pubkey_b64, "demo", Some("evil.example.com")).is_err());

        // A tampered payload (unsigned change) fails at the signature step, before identity.
        let tampered = json!({ "version": 1, "appSlug": "demo", "domain": "fleet.acme.co", "native": {} });
        let bad = json!({ "alg": "Ed25519", "payload": tampered, "signature": envelope["signature"] });
        assert!(verify_manifest_envelope(&bad, &pubkey_b64, "demo", Some("fleet.acme.co")).is_err());
    }

    /// LIVE integration of the full verification chain — real HTTP fetch of the
    /// signed manifest + signing key from the local dev server, Ed25519 verify,
    /// identity pinning, and the TOFU consent flow (consent injected; the native
    /// dialog itself is a thin blocking_show over the unit-tested prompt_text).
    /// Ignored by default: needs the local stack. Run with
    ///   FL_LIVE_SLUG=<published-app-slug> cargo test -- --ignored live_fetch
    #[test]
    #[ignore]
    fn live_fetch_and_verify_against_local_server() {
        let slug = std::env::var("FL_LIVE_SLUG").expect("set FL_LIVE_SLUG to a published app slug");
        let origin = std::env::var("FL_LIVE_ORIGIN").unwrap_or("http://formlogic.local".into());
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let pin_path = std::env::temp_dir().join(format!("fl-live-pins-{n}.json"));
        let pins = PinnedKeys::load(pin_path.clone());

        // 1. First use + declined consent → NO caps, NO pin.
        let declined = fetch_and_verify(&origin, &slug, &pins, &|p| {
            assert!(matches!(p, trust::TrustPrompt::FirstUse { .. }));
            false
        });
        assert!(declined.is_err(), "declined TOFU must not grant caps");

        // 2. First use + accepted consent → verified caps + pin recorded.
        let caps = fetch_and_verify(&origin, &slug, &pins, &|_| true)
            .expect("live manifest must verify");
        assert_eq!(caps.slug, slug);
        assert!(!caps.app_id.is_empty(), "server ships signed appId");
        assert!(!caps.account_id.is_empty(), "server ships signed accountId");
        let partition = caps.partition(&origin);
        assert!(partition.key().contains(&caps.app_id));

        // 3. Re-verify → pin matches, NO prompt fires.
        let no_prompt = fetch_and_verify(&origin, &slug, &pins, &|_| {
            panic!("a matching pin must not prompt")
        });
        assert!(no_prompt.is_ok());
        let _ = std::fs::remove_file(&pin_path);
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
