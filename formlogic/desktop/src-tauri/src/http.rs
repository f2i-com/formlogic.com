//! Localhost HTTP API the formlogic-web flow editor talks to.
//!
//! Phase 1 surface:
//!   GET /api/health        → { status, companion, legacyCompanion, version,
//!                              apiVersion, pluginApiVersion }
//!   GET /api/desktop/info  → { name, companion, legacyCompanion, version,
//!                              apiVersion, pluginApiVersion, platform }
//!
//! Phase 2 surface (this file):
//!   GET    /api/services                  → list registered + running services
//!   POST   /api/services/:id/start        → spawn the service process
//!   POST   /api/services/:id/stop         → terminate it
//!   POST   /api/services/:id/install      → run install script (streams logs)
//!   POST   /api/services/:id/uninstall    → remove its installed files (clean reinstall)
//!   GET    /api/services/:id/logs[?tail]  → recent stdout+stderr lines
//!
//!   GET    /api/models                       → list known/downloaded models (+ root dir)
//!   POST   /api/models/download              → start an HF / direct-URL download
//!   GET    /api/models/downloads             → in-flight + recent downloads
//!   POST   /api/models/downloads/:id/pause   → pause an in-flight download
//!   POST   /api/models/downloads/:id/resume  → resume a paused download
//!   POST   /api/models/downloads/:id/cancel  → cancel + delete .part
//!   DELETE /api/models/:name                 → remove a model file
//!
//!   GET    /api/python                    → python runtime + venv status
//!   POST   /api/python/install            → install bundled python (PBS)
//!   GET    /api/python/logs[?tail]        → current job's logs
//!   POST   /api/python/venvs              → create or reuse a venv
//!   DELETE /api/python/venvs/:name        → remove a venv
//!
//! Phase 4 (after Playwright sidecar): /api/browser/*

use axum::{
    extract::{Path, Query, Request, State},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE, ORIGIN},
        HeaderMap, Method, StatusCode,
    },
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::connectors::{self, ConnectorFailure, ConnectorRequestBody};
use crate::flows::FlowRuntime;
use crate::pairing::{PairingHandle, RequestStatus, TokenCheck};
use crate::plugins::registry::PluginHostHandle;
use crate::services::catalog::CatalogHandle;
use crate::services::downloads::DownloadsHandle;
use crate::services::python::PythonHandle;
use crate::services::registry::RegistryHandle;
use crate::services::template::ServiceTemplate;

/// Convenience alias for the error type returned by the server loop.
type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Read-only data-dir configuration the web app shows ("your models live at
/// X"). Built by a [`ConfigProvider`] so the HTTP layer stays host-agnostic —
/// the Tauri GUI backs it with AppHandle paths, the headless `formlogic-server` with
/// env vars. This is the `GET /api/config` response shape.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConfig {
    /// The dir this running process is actually using right now.
    pub active_dir: String,
    /// The OS default (what "Reset" goes back to).
    pub default_dir: String,
    /// The override currently written to the pointer file, if any.
    pub configured_dir: Option<String>,
    /// True when a custom dir is configured (differs from default).
    pub is_custom: bool,
    /// True when the configured dir differs from the active dir.
    pub restart_required: bool,
    /// The models dir this running process is actually using.
    pub models_active_dir: String,
    /// The default the models dir falls back to (`<activeDataDir>/models`).
    pub models_default_dir: String,
    /// The `modelsDir` override currently written to the pointer, if any.
    pub models_configured_dir: Option<String>,
    /// True when a custom models dir is configured.
    pub models_is_custom: bool,
    /// True when the configured models dir differs from the active one.
    pub models_restart_required: bool,
    /// The GGUF a single-model server (llama.cpp) is set to load, if the user
    /// picked one (else none — there is no implicit default). Shown in the
    /// service's Model picker.
    pub llama_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llama_mmproj: Option<String>,
    /// The model NAME a multi-model server (Ollama) is set to use, if the user
    /// picked one (else the pre-pulled default). Shown in its Model picker.
    pub ollama_model: Option<String>,
}

/// Supplies the [`CompanionConfig`] snapshot for `GET /api/config` without
/// binding the HTTP layer to any particular host (Tauri AppHandle vs env vars).
pub trait ConfigProvider: Send + Sync + 'static {
    fn snapshot(&self, registry: &RegistryHandle) -> CompanionConfig;
}

#[derive(Clone)]
struct AppState {
    config: Arc<dyn ConfigProvider>,
    registry: RegistryHandle,
    downloads: DownloadsHandle,
    python: PythonHandle,
    catalog: CatalogHandle,
    /// The flow runtime (headless flows + Aokie), so `/api/desktop/info` can
    /// report its status. `None` before an account/runtime is wired.
    flow_runtime: Option<Arc<FlowRuntime>>,
}

/// Current companion id, reported by `/api/health` + `/api/desktop/info`.
/// The desktop app is FormLogic Desktop; web detectors key off this id.
const COMPANION_ID: &str = "formlogic-desktop";

/// Retained only for wire-shape stability with older web detectors that read a
/// separate `legacyCompanion` field. The rebrand is complete, so no distinct
/// legacy id remains — this mirrors COMPANION_ID.
const LEGACY_COMPANION_ID: &str = COMPANION_ID;

/// User-facing product name (`/api/desktop/info` `name`).
const DESKTOP_NAME: &str = "FormLogic Desktop";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    companion: &'static str,
    legacy_companion: &'static str,
    version: &'static str,
    api_version: u32,
    plugin_api_version: u32,
}

/// Build the `/api/health` payload. Split from the handler so tests can
/// assert the exact wire shape without spinning up a server.
fn health_body() -> HealthResponse {
    HealthResponse {
        status: "ok",
        companion: COMPANION_ID,
        legacy_companion: LEGACY_COMPANION_ID,
        version: env!("CARGO_PKG_VERSION"),
        api_version: crate::DESKTOP_API_VERSION,
        plugin_api_version: crate::PLUGIN_API_VERSION,
    }
}

async fn health() -> Json<HealthResponse> {
    Json(health_body())
}

/// `GET /api/desktop/info` — identity + version card for FormLogic Desktop.
/// Behind `management_auth_guard` like every non-health route (LOCAL-SEC-001);
/// the open discovery probe is `/api/health`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    name: &'static str,
    companion: &'static str,
    legacy_companion: &'static str,
    version: &'static str,
    api_version: u32,
    plugin_api_version: u32,
    /// OS family (`windows` / `macos` / `linux`), per `std::env::consts::OS`.
    platform: &'static str,
}

/// Build the `/api/desktop/info` payload (test-visible twin of `health_body`).
fn desktop_info_body() -> DesktopInfo {
    DesktopInfo {
        name: DESKTOP_NAME,
        companion: COMPANION_ID,
        legacy_companion: LEGACY_COMPANION_ID,
        version: env!("CARGO_PKG_VERSION"),
        api_version: crate::DESKTOP_API_VERSION,
        plugin_api_version: crate::PLUGIN_API_VERSION,
        platform: std::env::consts::OS,
    }
}

/// `GET /api/desktop/info` — identity/version card, extended with the flow
/// runtime status (linked, last poll, run/record counts) so the web app's
/// remote viewer + the window badge can show whether the headless runner is live.
async fn desktop_info(State(state): State<AppState>) -> impl IntoResponse {
    let mut v = serde_json::to_value(desktop_info_body()).unwrap_or_default();
    if let Some(rt) = &state.flow_runtime {
        v["flowRuntime"] = serde_json::to_value(rt.status()).unwrap_or(serde_json::Value::Null);
        // Truthful readiness (audit INT-006/C-15): the aokie plugin's last
        // health report — computed, never a constant ok — so "Listening" in
        // the web UI can say WHY the receptionist is degraded.
        if let Some(h) = rt.plugin_health("aokie") {
            v["aokiePluginHealth"] = serde_json::to_value(h).unwrap_or(serde_json::Value::Null);
        }
    }
    Json(v)
}

/// `GET /api/desktop/support-bundle` — one privacy-safe diagnostics document
/// (audit OBS-001): identity/versions, flow-runtime status, per-plugin
/// computed health, and the durable-delivery journal counts. Everything here
/// is already exposed by other endpoints — this composes the snapshot an
/// operator pastes into a bug report, with no tokens and no conversation
/// content.
async fn support_bundle(State(state): State<AppState>) -> impl IntoResponse {
    let mut v = serde_json::json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "desktop": serde_json::to_value(desktop_info_body()).unwrap_or_default(),
    });
    if let Some(rt) = &state.flow_runtime {
        v["flowRuntime"] = serde_json::to_value(rt.status()).unwrap_or(serde_json::Value::Null);
        let snapshot = rt.support_snapshot();
        v["plugins"] = snapshot.get("plugins").cloned().unwrap_or_default();
        v["journals"] = snapshot.get("journals").cloned().unwrap_or_default();
    }
    Json(v)
}

/// `GET /api/desktop/journals` — counts + retention of the local operational
/// journals (DATA-PRIV-001): the "Clear history" preview. No payload content.
async fn desktop_journals(State(state): State<AppState>) -> impl IntoResponse {
    match &state.flow_runtime {
        Some(rt) => Json(rt.journals_snapshot()).into_response(),
        None => Json(serde_json::json!({
            "receipts": {},
            "eventWork": { "pending": 0, "completed": 0, "dead": 0 },
        }))
        .into_response(),
    }
}

/// `POST /api/desktop/journals/clear` — clear LOCAL call/SMS operational
/// history (terminal work records + receipts older than the dedupe guard).
/// Pending work is never touched; cloud records are governed by FormLogic's
/// per-form retention settings, not this endpoint.
async fn desktop_journals_clear(State(state): State<AppState>) -> impl IntoResponse {
    match &state.flow_runtime {
        Some(rt) => Json(rt.clear_history()).into_response(),
        None => desktop_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "runner_unavailable",
            "no flow runtime is wired",
        ),
    }
}

// ------- services -------

async fn list_services(State(state): State<AppState>) -> impl IntoResponse {
    // SRV-001: serve the pre-serialized, revision-keyed snapshot body — an Arc
    // clone on the hot path, with NO filesystem or process probing. Template
    // folder-drops are picked up by the background refresher (registry::
    // background_refresh) instead of a rescan-per-poll here, and the mutex is
    // taken on the blocking pool so a rebuild can never stall async workers.
    let registry = state.registry.clone();
    match tokio::task::spawn_blocking(move || {
        registry
            .lock()
            .map(|mut reg| reg.snapshot_cached())
            .map_err(|_| ())
    })
    .await
    {
        Ok(Ok(body)) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            body.as_str().to_owned(),
        )
            .into_response(),
        _ => err500("registry mutex poisoned"),
    }
}

async fn start_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.start(&id));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

/// PROC-001: one-click repair — resets the crash-loop breaker + scheduled
/// restarts, tears down any stale process tree, verifies the port is actually
/// free (naming a foreign holder instead of spawning into a doomed bind race)
/// and starts fresh.
async fn repair_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.repair(&id));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

#[derive(serde::Deserialize)]
struct AutostartBody {
    policy: crate::services::registry::AutostartPolicy,
}

/// PROC-001: set a service's persisted boot-autostart policy
/// (`auto` = restore last session, `always`, `never`).
async fn set_service_autostart(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AutostartBody>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.set_autostart(&id, body.policy));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

async fn stop_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.stop(&id));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

/// Install via `Runner` (same pipe + log machinery used for service
/// processes) so the existing /logs endpoint streams progress in real
/// time — no extra plumbing on the UI side.
async fn install_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.install_streaming(&id));
    match result {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(e) => err400(&e),
    }
}

/// Cancel an in-flight install (kills the install process tree). Logs are
/// kept so the user can still read where it stopped.
async fn cancel_install_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.cancel_install(&id));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

#[derive(Deserialize)]
struct LogsQuery {
    tail: Option<usize>,
}

async fn service_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> impl IntoResponse {
    match state.registry.lock() {
        Ok(reg) => match reg.logs(&id, q.tail) {
            Some(lines) => (StatusCode::OK, Json(lines)).into_response(),
            None => (StatusCode::OK, Json(Vec::<serde_json::Value>::new())).into_response(),
        },
        Err(_) => err500("registry mutex poisoned"),
    }
}

/// Create or replace a service template from a UI form. Body is the
/// ServiceTemplate JSON itself (same shape on-disk + over the wire).
async fn add_service(
    State(state): State<AppState>,
    Json(template): Json<ServiceTemplate>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.add_template(template));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

/// Export a service as a self-contained, shareable package: the template with
/// every script it references inlined into `files`. POST the result back to
/// `/api/services` on any machine to install it — no recompile, no loose files.
async fn export_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|reg| reg.export_package(&id));
    match result {
        Ok(pkg) => Json(pkg).into_response(),
        Err(e) => err400(&e),
    }
}

async fn delete_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.delete_template(&id));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

/// Remove a service's installed files (the template's `uninstall` paths) so the
/// user can clean-reinstall — e.g. swap an old llama.cpp build for a new one.
/// Privileged + destructive (gated like delete); leaves the template in place.
async fn uninstall_service(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .registry
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())
        .and_then(|mut reg| reg.uninstall(&id));
    match result {
        Ok(n) => (StatusCode::OK, Json(serde_json::json!({ "removed": n }))).into_response(),
        Err(e) => err400(&e),
    }
}

#[derive(Deserialize)]
struct EnsureByPortRequest {
    port: u16,
}

/// Start the companion service that owns `port` if it isn't already
/// running. Called by formlogic-web before it hits a `127.0.0.1:<port>`
/// endpoint a companion service owns, so picking a stopped service in a
/// flow and running it "just works". Returns immediately after the
/// spawn — the flow's HTTP/LLM node retries while the server warms up.
async fn ensure_service_by_port(
    State(state): State<AppState>,
    Json(req): Json<EnsureByPortRequest>,
) -> impl IntoResponse {
    match state.registry.lock() {
        Ok(mut reg) => (StatusCode::OK, Json(reg.ensure_by_port(req.port))).into_response(),
        Err(_) => err500("registry mutex poisoned"),
    }
}

// ------- models -------

async fn list_models(State(state): State<AppState>) -> impl IntoResponse {
    // The recursive models-dir walk (per-file metadata across every model
    // root) can take real time on big libraries, and the Models page polls
    // this endpoint. Run it on the blocking pool so it never stalls the async
    // workers serving every other endpoint.
    let downloads = state.downloads.clone();
    match tokio::task::spawn_blocking(move || downloads.list_models()).await {
        Ok(Ok(models)) => (StatusCode::OK, Json(models)).into_response(),
        Ok(Err(e)) => err500(&e),
        Err(e) => err500(&format!("models scan failed: {e}")),
    }
}

#[derive(Deserialize)]
struct ModelDownloadRequest {
    /// Either a HuggingFace URL ("https://huggingface.co/<repo>/resolve/<rev>/<file>")
    /// or a direct download URL.
    url: String,
    /// Destination filename. Defaults to last path segment of the URL.
    #[serde(default)]
    filename: Option<String>,
    /// Optional subdirectory under the models dir.
    #[serde(default)]
    subdir: Option<String>,
    /// Optional SHA-256 pin (64 hex chars) the download must hash to
    /// before it installs (MODEL-001). For catalog URLs the CATALOG's pin
    /// is enforced server-side regardless of this field.
    #[serde(default)]
    sha256: Option<String>,
    /// Optional exact size pin, checked with `sha256`.
    #[serde(default, rename = "sizeBytes")]
    size_bytes: Option<u64>,
}

/// Validate + canonicalise a client-supplied SHA-256 pin.
fn normalise_sha256(s: &str) -> Result<String, String> {
    let s = s.trim().to_lowercase();
    if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(s)
    } else {
        Err("sha256 must be 64 hex characters".into())
    }
}

async fn start_model_download(
    State(state): State<AppState>,
    Json(req): Json<ModelDownloadRequest>,
) -> Response {
    use crate::services::catalog;
    use crate::services::downloads::{self, ExpectedDigest};

    // MODEL-001: digest pinning is decided SERVER-side. A URL that matches
    // a catalog entry inherits the catalog's pin — a paired web page (or a
    // request that simply omits the field) can't start a catalog model's
    // download without its integrity check. Non-catalog URLs may carry an
    // explicit client pin; without one the download is hashed + recorded
    // but installs unverified (there is nothing to check it against).
    let normalised = match downloads::normalise_hf_url(&req.url) {
        Ok(u) => u,
        Err(e) => return err400(&e),
    };
    let client_sha = match req.sha256.as_deref() {
        Some(s) => match normalise_sha256(s) {
            Ok(s) => Some(s),
            Err(e) => return err400(&e),
        },
        None => None,
    };
    let catalog_pin = {
        let cat = state.catalog.current();
        catalog::find_by_url(&cat, &normalised)
            .and_then(|m| m.sha256.clone().map(|sha| (sha.to_lowercase(), m.size_bytes)))
    };
    let expected = match catalog_pin {
        Some((pin, size)) => {
            if client_sha.as_deref().is_some_and(|cs| cs != pin) {
                return err400(
                    "the supplied sha256 conflicts with the catalog's pinned digest for this URL",
                );
            }
            Some(ExpectedDigest {
                sha256: pin,
                size_bytes: (size > 0).then_some(size),
            })
        }
        None => client_sha.map(|sha| ExpectedDigest {
            sha256: sha,
            size_bytes: req.size_bytes.filter(|s| *s > 0),
        }),
    };

    match state
        .downloads
        .start(&req.url, req.filename.as_deref(), req.subdir.as_deref(), expected)
    {
        Ok(id) => (StatusCode::ACCEPTED, Json(serde_json::json!({ "downloadId": id })))
            .into_response(),
        Err(e) => err400(&e),
    }
}

/// MODEL-001 Doctor/repair hook: re-hash every manifest-tracked model and
/// quarantine mismatches. Long-running on big libraries → blocking pool;
/// concurrent passes are refused (409).
async fn verify_models(State(state): State<AppState>) -> Response {
    let downloads = state.downloads.clone();
    match tokio::task::spawn_blocking(move || downloads.verify_all()).await {
        Ok(Ok(report)) => (StatusCode::OK, Json(report)).into_response(),
        Ok(Err(e)) if e.contains("already running") => {
            (StatusCode::CONFLICT, Json(serde_json::json!({ "error": e }))).into_response()
        }
        Ok(Err(e)) => err500(&e),
        Err(e) => err500(&format!("verify task failed: {e}")),
    }
}

async fn list_downloads(State(state): State<AppState>) -> impl IntoResponse {
    (StatusCode::OK, Json(state.downloads.snapshot())).into_response()
}

async fn pause_download(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.downloads.pause(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

async fn resume_download(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.downloads.resume(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

async fn cancel_download(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.downloads.cancel(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

async fn delete_model(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.downloads.delete_model(&name) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

async fn model_catalog(State(state): State<AppState>) -> impl IntoResponse {
    (StatusCode::OK, Json(state.catalog.snapshot())).into_response()
}

/// Read-only data-dir configuration so the web app can show "your models
/// live at X". Changing the dir is a desktop-only action (native picker +
/// restart), so there's intentionally no POST here.
async fn get_config(State(state): State<AppState>) -> impl IntoResponse {
    (StatusCode::OK, Json(state.config.snapshot(&state.registry))).into_response()
}

// ------- python -------

async fn python_status(State(state): State<AppState>) -> impl IntoResponse {
    // Fold the registry's venv→service usage into each venv's
    // `bound_services` so the Python tab can show "used by …". The Python
    // module is registry-agnostic, so the join happens here where both
    // handles are in scope.
    let mut snap = state.python.snapshot();
    if let Ok(reg) = state.registry.lock() {
        let usage = reg.venv_usage();
        for v in &mut snap.venvs {
            if let Some(svcs) = usage.get(&v.name) {
                v.bound_services = svcs.clone();
            }
        }
    }
    (StatusCode::OK, Json(snap)).into_response()
}

async fn install_python(State(state): State<AppState>) -> impl IntoResponse {
    match state.python.install_runtime() {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(e) => err400(&e),
    }
}

/// Logs of the currently-running Python job (install or venv create).
/// Returns an empty array when nothing is in flight; the UI's LogsViewer
/// renders the same way for either case.
async fn python_logs(
    State(state): State<AppState>,
    Query(q): Query<LogsQuery>,
) -> impl IntoResponse {
    match state.python.current_logs(q.tail) {
        Some(lines) => (StatusCode::OK, Json(lines)).into_response(),
        None => (
            StatusCode::OK,
            Json(Vec::<crate::services::runner::LogLine>::new()),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct VenvRequest {
    name: String,
    /// Pip-installable packages to set up after venv creation.
    #[serde(default)]
    requirements: Vec<String>,
}

async fn create_venv(
    State(state): State<AppState>,
    Json(req): Json<VenvRequest>,
) -> impl IntoResponse {
    match state.python.create_or_reuse_venv(&req.name, &req.requirements) {
        Ok(path) => (StatusCode::OK, Json(serde_json::json!({ "path": path }))).into_response(),
        Err(e) => err400(&e),
    }
}

async fn delete_venv(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.python.delete_venv(&name) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err400(&e),
    }
}

// ------- FormLogic Desktop plugin API (plugins / connectors / events / pairing) -------
//
// These routes carry pairing-token auth bound to the calling origin — see
// `crate::pairing` + `plugin_auth_guard` below. Since LOCAL-SEC-001 the
// management plane (services/models/python/config) sits behind the same trust
// anchors via `management_auth_guard`.
// Error envelope everywhere: `{ok:false, error:{code, message}}` with the
// typed codes from `connector-response.schema.json`.

#[derive(Clone)]
struct DesktopState {
    host: PluginHostHandle,
    pairing: PairingHandle,
    auth: AuthConfig,
    /// The headless flow runtime backing `POST /api/flows/run` +
    /// `GET /api/flows/runs/{id}`. `None` ⇒ those routes report runner_unavailable.
    flow_runtime: Option<Arc<FlowRuntime>>,
    /// Verified connector capabilities (audit SEC-001): token → (grant
    /// patterns, valid-until). Bounds server introspection to one call per
    /// token lifetime.
    capability_cache: Arc<std::sync::Mutex<std::collections::HashMap<String, (Vec<String>, std::time::Instant)>>>,
    /// Last-known VERIFIED grants per capability token (grants, verified_at) — the offline-grace
    /// source of truth (audit DESK-CAP-001). Unlike `capability_cache` (a short positive-TTL
    /// cache), entries here outlive the token TTL but are only honoured while the cloud is
    /// unreachable AND the verification is younger than `OFFLINE_GRACE_MAX_AGE`.
    capability_last_known: Arc<std::sync::Mutex<std::collections::HashMap<String, (Vec<String>, std::time::Instant)>>>,
}

/// `{ok:false, error:{code, message}}` — the contract error envelope.
fn desktop_err(status: StatusCode, code: &str, message: &str) -> axum::response::Response {
    (
        status,
        Json(serde_json::json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// HTTP status for a typed connector failure (the browser client keys off
/// the body `code`; the status is informative).
fn connector_failure_status(code: &str) -> StatusCode {
    match code {
        "auth_required" => StatusCode::UNAUTHORIZED,
        "origin_denied" | "capability_denied" => StatusCode::FORBIDDEN,
        "connector_missing" => StatusCode::NOT_FOUND,
        "connector_unavailable" | "ipc_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_GATEWAY,
    }
}

fn connector_failure_response(f: &ConnectorFailure) -> axum::response::Response {
    desktop_err(connector_failure_status(f.code), f.code, &f.message)
}

// The former `?token=` fallback for `/api/events` is GONE (audit FL-008):
// the web client streams SSE via fetch(), which can send a normal
// Authorization header — a pairing token must never appear in a URL, where
// it would land in server/proxy logs and browser history.

/// Pure decision core of [`plugin_auth_guard`], split out for tests.
/// Precedence: the headless server token and the GUI's own webview always
/// administer; otherwise a pairing token must be present AND bound to the
/// request's Origin.
fn desktop_auth_decision(
    server_token_ok: bool,
    gui_webview_ok: bool,
    pairing: Option<TokenCheck>,
) -> Result<(), (StatusCode, &'static str, &'static str)> {
    if server_token_ok || gui_webview_ok {
        return Ok(());
    }
    match pairing {
        Some(TokenCheck::Ok) => Ok(()),
        Some(TokenCheck::WrongOrigin) => Err((
            StatusCode::FORBIDDEN,
            "origin_denied",
            "token is not valid for this origin",
        )),
        Some(TokenCheck::Invalid) => Err((
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "invalid or expired pairing token",
        )),
        None => Err((
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "missing bearer token — pair with FormLogic Desktop first",
        )),
    }
}

/// Auth middleware for `/api/plugins*`, `/api/connectors*`, `/api/events`,
/// `/api/origins*`, `/api/flows/*`: a valid pairing token bound to the
/// request Origin, OR the companion's own webview (GUI), OR the headless
/// server bearer token. CORS preflights pass (they carry no credentials and
/// mutate nothing).
async fn plugin_auth_guard(
    State(st): State<DesktopState>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    let origin = req
        .headers()
        .get(ORIGIN)
        .and_then(|o| o.to_str().ok())
        .map(str::to_owned);
    let server_token_ok = matches!(
        (st.auth.token.as_deref(), bearer_token(&req)),
        (Some(want), Some(got)) if token_eq(want, &got)
    );
    let gui_webview_ok = st.auth.gui_mode
        && matches!(origin.as_deref(), Some(o) if is_gui_webview_origin(o));
    let presented = bearer_token(&req);
    let pairing = presented
        .as_deref()
        .map(|t| st.pairing.check(t, origin.as_deref()));
    match desktop_auth_decision(server_token_ok, gui_webview_ok, pairing) {
        Ok(()) => next.run(req).await,
        Err((status, code, msg)) => desktop_err(status, code, msg),
    }
}

/// True when the caller may drive pairing ADMIN (list/approve/deny): the
/// GUI's own webview or the headless server token — never a pairing token
/// (a paired page must not approve other pages).
fn pairing_admin_ok(auth: &AuthConfig, headers: &HeaderMap) -> bool {
    let token_ok = matches!(
        (
            auth.token.as_deref(),
            headers
                .get(AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(str::trim)
        ),
        (Some(want), Some(got)) if token_eq(want, got)
    );
    let origin_ok = headers
        .get(ORIGIN)
        .and_then(|o| o.to_str().ok())
        .is_some_and(is_gui_webview_origin);
    token_ok || (auth.gui_mode && origin_ok)
}

// ---- plugins ----

async fn list_plugins(State(st): State<DesktopState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "pluginsDir": st.host.plugins_root().display().to_string(),
        // Dev mode drives dev-only panel affordances (Aokie's simulate-call).
        "devMode": st.host.dev_mode(),
        "plugins": st.host.list(),
        // Bundled first-party templates (e.g. Aokie) + installed flags, so
        // the panel can offer "Install" without a separate endpoint.
        "builtins": st.host.builtin_plugins(),
    }))
}

/// `POST /api/plugins/{id}/install` — materialise a BUILT-IN plugin template
/// (bundled manifest, e.g. Aokie's) into `<plugins>/<id>/`. The plugin
/// binary is provided separately; until it's dropped into that folder the
/// plugin shows the "binary … not installed" reason rather than crashed.
async fn install_builtin_plugin(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match st.host.install_builtin(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

async fn get_plugin(State(st): State<DesktopState>, Path(id): Path<String>) -> impl IntoResponse {
    // GET /api/plugins rescans; the single-plugin read serves the cache.
    match st.host.get(&id) {
        Some(p) => Json(p).into_response(),
        None => desktop_err(
            StatusCode::NOT_FOUND,
            "command_failed",
            &format!("unknown plugin {id:?}"),
        ),
    }
}

async fn start_plugin(State(st): State<DesktopState>, Path(id): Path<String>) -> impl IntoResponse {
    match st.host.start(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

async fn stop_plugin(State(st): State<DesktopState>, Path(id): Path<String>) -> impl IntoResponse {
    match st.host.stop(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

async fn restart_plugin(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match st.host.restart(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

/// `DELETE /api/plugins/{id}[?purge=1]` — stop + remove the plugin folder
/// (manifest + binary). Plugin data under `plugin-data/<id>` is KEPT for a
/// reinstall unless `?purge=1`, which also deletes the writable data (settings,
/// outbox, receipts). Data OUTSIDE the desktop tree that the plugin declares is
/// never auto-deleted — the UI shows that inventory as a manual checklist.
/// Bundled built-ins reappear as installable templates.
#[derive(Deserialize)]
struct UninstallQuery {
    #[serde(default)]
    purge: Option<String>,
}

async fn uninstall_plugin(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    Query(q): Query<UninstallQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // PLG-105/107: lifecycle mutations are webview/server-token only — a paired
    // web page can start/stop a plugin but never install/uninstall/enable it.
    if !pairing_admin_ok(&st.auth, &headers) {
        return lifecycle_admin_denied();
    }
    let purge = matches!(q.purge.as_deref(), Some("1") | Some("true"));
    match st.host.uninstall(&id, purge).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

/// Shared 403 for the webview/server-token-only lifecycle routes.
fn lifecycle_admin_denied() -> Response {
    desktop_err(
        StatusCode::FORBIDDEN,
        "auth_required",
        "plugin install/uninstall/enable/disable require the Desktop window (or the server token) — a paired page cannot change what native code is installed",
    )
}

/// `POST /api/plugins/{id}/enable` and `.../disable` (PLG-105) — durable
/// enable/disable, persisted across restart + rescan. Disable stops a running
/// process and blocks autostart + dispatch; enable clears the opt-out.
async fn enable_plugin(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return lifecycle_admin_denied();
    }
    match st.host.set_enabled(&id, true).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

async fn disable_plugin(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return lifecycle_admin_denied();
    }
    match st.host.set_enabled(&id, false).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

/// `POST /api/plugins/install` (PLG-102/103/104) — install a native plugin from
/// a local folder or an uploaded `.formlogic-plugin` archive.
///
/// Two request shapes (both webview/server-token only — a paired web page can
/// neither hand a filesystem path nor sideload a binary):
///   - JSON `{ "path": "C:\\…\\myplugin" }` — install from a local folder;
///   - a raw `application/zip` / `application/octet-stream` body — the archive
///     bytes.
/// Returns `{ "id": "<installed plugin id>" }`.
async fn install_plugin_from_source(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    use crate::plugins::install::InstallSource;
    if !pairing_admin_ok(&st.auth, &headers) {
        return lifecycle_admin_denied();
    }
    const MAX_UPLOAD: usize = 512 * 1024 * 1024;
    if body.len() > MAX_UPLOAD {
        return desktop_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "command_failed",
            "plugin upload exceeds the 512 MiB cap",
        );
    }
    let ctype = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let source = if ctype.contains("application/json") {
        #[derive(Deserialize)]
        struct FolderBody {
            path: String,
        }
        match serde_json::from_slice::<FolderBody>(&body) {
            Ok(b) => InstallSource::Folder(std::path::PathBuf::from(b.path)),
            Err(e) => {
                return desktop_err(
                    StatusCode::BAD_REQUEST,
                    "command_failed",
                    &format!("invalid body (expected {{path}}): {e}"),
                )
            }
        }
    } else {
        if body.is_empty() {
            return desktop_err(
                StatusCode::BAD_REQUEST,
                "command_failed",
                "empty upload — send a .formlogic-plugin archive or a JSON {path}",
            );
        }
        InstallSource::Zip(body.to_vec())
    };
    // Filesystem-heavy — run off the async worker.
    let host = st.host.clone();
    match tokio::task::spawn_blocking(move || host.install_from_source(&source)).await {
        Ok(Ok(id)) => (StatusCode::OK, Json(serde_json::json!({ "id": id }))).into_response(),
        Ok(Err(e)) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
        Err(e) => desktop_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "command_failed",
            &format!("install task failed: {e}"),
        ),
    }
}

/// `GET /api/plugins/{id}/health` — probes a running plugin on demand (the
/// probe also becomes the recorded "last" report); otherwise returns the
/// last report from the supervisor's 10 s ticker.
async fn plugin_health(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if st.host.get(&id).is_none() {
        return desktop_err(
            StatusCode::NOT_FOUND,
            "command_failed",
            &format!("unknown plugin {id:?}"),
        );
    }
    // On-demand probe when live; errors are reflected in the report itself.
    let _ = st.host.probe_health(&id).await;
    match st.host.last_health(&id) {
        Some(h) => Json(serde_json::json!({ "health": h })).into_response(),
        None => desktop_err(
            StatusCode::NOT_FOUND,
            "command_failed",
            &format!("unknown plugin {id:?}"),
        ),
    }
}

async fn plugin_logs(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> impl IntoResponse {
    match st.host.logs(&id, q.tail) {
        Some(lines) => Json(lines).into_response(),
        None => desktop_err(
            StatusCode::NOT_FOUND,
            "command_failed",
            &format!("unknown plugin {id:?}"),
        ),
    }
}

/// `POST /api/plugins/{id}/commands/{command}` — admin/dev direct command:
/// forwarded as a `connector.request` to THAT plugin. Optional JSON body
/// `{payload?, timeoutMs?, requestId?, connectorId?}`; the connector defaults
/// to the plugin's connector that declares the command.
async fn plugin_command(
    State(st): State<DesktopState>,
    Path((id, command)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CommandBody {
        #[serde(default)]
        connector_id: Option<String>,
        #[serde(default)]
        payload: Option<serde_json::Value>,
        #[serde(default)]
        timeout_ms: Option<u64>,
        #[serde(default)]
        request_id: Option<String>,
    }
    let parsed: CommandBody = if body.is_empty() {
        CommandBody::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(b) => b,
            Err(e) => {
                return desktop_err(
                    StatusCode::BAD_REQUEST,
                    "command_failed",
                    &format!("invalid body: {e}"),
                )
            }
        }
    };
    // Resolve the target connector inside THIS plugin's manifest.
    let connector_id = match st.host.get(&id) {
        None => {
            return desktop_err(
                StatusCode::NOT_FOUND,
                "command_failed",
                &format!("unknown plugin {id:?}"),
            )
        }
        Some(p) => match parsed.connector_id {
            Some(c) => c,
            None => p
                .connectors
                .iter()
                .find(|c| c.commands.iter().any(|k| *k == command))
                .map(|c| c.id.clone())
                .unwrap_or_else(|| id.clone()),
        },
    };
    let req = ConnectorRequestBody {
        connector_id: Some(connector_id.clone()),
        command,
        payload: parsed.payload,
        timeout_ms: parsed.timeout_ms,
        // Native plugin controls do not have a caller-supplied retry key.
        // Mint one at this boundary so plugins can durably journal physical
        // effects; preserve an explicit key when a diagnostic caller supplies it.
        request_id: Some(direct_command_request_id(parsed.request_id)),
    };
    match connectors::dispatch(&st.host, &connector_id, &req).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(f) => connector_failure_response(&f),
    }
}

fn direct_command_request_id(provided: Option<String>) -> String {
    provided.unwrap_or_else(|| format!("desktop-admin:{}", uuid::Uuid::new_v4().simple()))
}

// ---- connectors ----

async fn list_connectors(State(st): State<DesktopState>) -> impl IntoResponse {
    st.host.scan();
    Json(connectors::list(&st.host))
}

async fn connector_status(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match connectors::status(&st.host, &id) {
        Ok(s) => Json(s).into_response(),
        Err(f) => connector_failure_response(&f),
    }
}

/// The gateway FormLogic Web calls (`connector-request/response.schema.json`).
/// True when a grant pattern list allows `command` on `connector_id`
/// (audit SEC-001): `*` (owner) | `connector.<id>` | `connector.<id>.*`
/// | exact `connector.<id>.<command>`.
fn capability_grants_allow(grants: &[String], connector_id: &str, command: &str) -> bool {
    grants.iter().any(|g| {
        g == "*"
            || g == &format!("connector.{connector_id}")
            || g == &format!("connector.{connector_id}.*")
            || g == &format!("connector.{connector_id}.{command}")
    })
}

/// Enforce the member's server-minted capability on a browser-originated
/// connector command (audit SEC-001/C-08). Rules:
/// - UNLINKED desktop (no cloud account): local single-user use — the
///   legacy origin-pairing + manifest gate stands alone.
/// - Linked: the request must carry `X-FormLogic-Capability`; the token is
///   verified server-side (cached for its lifetime) and its role-derived
///   grant patterns must allow the command. A definitive server "not
///   found" (expired/forged) denies; a TRANSPORT failure fails open with a
///   log so a local operator is not locked out of their own phone while
///   the internet is down (bounded revocation lag, documented).
/// How long a previously VERIFIED capability keeps working while the cloud is unreachable
/// (audit DESK-CAP-001). Long enough to ride out a normal outage without locking the local
/// operator out of their own phone; short enough that a revoked member's access dies within
/// minutes even if they cut the desktop's connectivity on purpose.
const OFFLINE_GRACE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The DESK-CAP-001 offline-grace decision, factored pure for tests: a token is honoured
/// during a cloud outage ONLY when this desktop verified it before AND that verification
/// is younger than the grace window — and then only with its recorded grants.
fn offline_grace_grants(last_known: Option<&(Vec<String>, std::time::Instant)>) -> Option<Vec<String>> {
    last_known
        .filter(|(_, at)| at.elapsed() < OFFLINE_GRACE_MAX_AGE)
        .map(|(g, _)| g.clone())
}

async fn check_connector_capability(
    st: &DesktopState,
    headers: &axum::http::HeaderMap,
    connector_id: &str,
    command: &str,
) -> Result<(), axum::response::Response> {
    let grants = match resolve_capability_grants(st, headers).await? {
        None => return Ok(()), // unlinked — legacy local gating
        Some(g) => g,
    };
    if !capability_grants_allow(&grants, connector_id, command) {
        return Err(desktop_err(
            StatusCode::FORBIDDEN,
            "capability_denied",
            &format!("your role does not allow {connector_id}.{command}"),
        ));
    }
    Ok(())
}

/// Resolve the caller's VERIFIED capability grants from `X-FormLogic-Capability`
/// (audit SEC-001/DESK-CAP-001, shared by the direct connector gateway and the
/// flow runner's request-capability check — FLOW-SEC-001). `Ok(None)` means the
/// desktop is UNLINKED (no cloud account): local single-user use, where the
/// legacy origin-pairing gate stands alone. Linked resolution verifies the
/// token server-side (cached for its lifetime, bounded offline grace for
/// previously verified tokens) and fails closed everywhere else.
async fn resolve_capability_grants(
    st: &DesktopState,
    headers: &axum::http::HeaderMap,
) -> Result<Option<Vec<String>>, axum::response::Response> {
    let Some(client) = st.flow_runtime.as_ref().and_then(|rt| rt.api_client()) else {
        return Ok(None); // unlinked — legacy local gating
    };
    // The token is interpolated into the introspection URL path
    // (`connector-capabilities/{token}`), so it must be opaque-safe: reject
    // anything that could reshape the request (`/`, `.`, `%`, whitespace).
    // Server-minted tokens are hex; we stay format-tolerant but path-safe.
    let Some(token) = headers
        .get("x-formlogic-capability")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|t| {
            !t.is_empty()
                && t.len() <= 128
                && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .map(str::to_string)
    else {
        return Err(desktop_err(
            StatusCode::FORBIDDEN,
            "capability_denied",
            "a connector capability is required — reload the app page to refresh your access",
        ));
    };

    let cached = st
        .capability_cache
        .lock()
        .ok()
        .and_then(|c| c.get(&token).filter(|(_, until)| *until > std::time::Instant::now()).cloned());
    let grants = match cached {
        Some((grants, _)) => grants,
        None => match client.introspect_capability(&token).await {
            Ok(Some((grants, ttl_secs))) => {
                if let Ok(mut c) = st.capability_cache.lock() {
                    // Opportunistic prune so the map stays bounded.
                    c.retain(|_, (_, until)| *until > std::time::Instant::now());
                    c.insert(
                        token.clone(),
                        (grants.clone(), std::time::Instant::now() + std::time::Duration::from_secs(ttl_secs.min(300))),
                    );
                }
                if let Ok(mut lk) = st.capability_last_known.lock() {
                    lk.retain(|_, (_, at)| at.elapsed() < OFFLINE_GRACE_MAX_AGE);
                    lk.insert(token.clone(), (grants.clone(), std::time::Instant::now()));
                }
                grants
            }
            Ok(None) => {
                if let Ok(mut lk) = st.capability_last_known.lock() {
                    lk.remove(&token);
                }
                return Err(desktop_err(
                    StatusCode::FORBIDDEN,
                    "capability_denied",
                    "this connector capability is expired or invalid — reload the app page",
                ));
            }
            // Offline grace applies ONLY to a genuine transport failure, and even then
            // ONLY to a token this desktop has previously VERIFIED (audit DESK-CAP-001):
            // the old blanket allow meant any well-formed token — revoked, forged, or a
            // low-privilege member's — could run privileged local commands for as long
            // as the cloud stayed unreachable. Now the last-known verified grants are
            // reused for a bounded window (revocation lag ≤ OFFLINE_GRACE_MAX_AGE) and
            // the per-command grant check below still applies; a cache miss fails
            // CLOSED. A server that ANSWERS with a definitive non-grant is not
            // "offline" — that denies outright (audit SEC-001).
            Err(crate::formlogic_client::FlError::Network(e)) => {
                let last_known = st
                    .capability_last_known
                    .lock()
                    .ok()
                    .and_then(|lk| lk.get(&token).cloned());
                match offline_grace_grants(last_known.as_ref()) {
                    Some(grants) => {
                        eprintln!(
                            "[desktop] capability introspection unreachable (network: {e}) — using previously verified grants (bounded offline grace)"
                        );
                        grants
                    }
                    None => {
                        eprintln!("[desktop] capability introspection unreachable (network: {e}) and no recent verification for this token — denying (fail closed)");
                        return Err(desktop_err(
                            StatusCode::FORBIDDEN,
                            "capability_denied",
                            "your access could not be verified while the cloud is unreachable — try again once the connection is back",
                        ));
                    }
                }
            }
            Err(e) => {
                eprintln!("[desktop] capability introspection refused ({e:?}) — denying (fail closed)");
                return Err(desktop_err(
                    StatusCode::FORBIDDEN,
                    "capability_denied",
                    "your connector capability could not be verified — reload the app page",
                ));
            }
        },
    };
    Ok(Some(grants))
}

/// True when the verified grant patterns cover ONE requested flow capability
/// (audit FLOW-SEC-001). `*` (owner) covers everything. `connector.<id>...`
/// requests map onto the same pattern semantics as the direct connector
/// gateway (`capability_grants_allow`), so a wildcard request needs a
/// wildcard/whole-connector grant. Every non-connector capability
/// (formlogic.kv.write, formlogic.responses.*, model.*) requires the owner
/// grant — no member role mints those today, and an unknown capability must
/// never be covered by accident.
fn grant_covers_capability(grants: &[String], cap: &str) -> bool {
    if grants.iter().any(|g| g == "*") {
        return true;
    }
    if let Some(rest) = cap.strip_prefix("connector.") {
        let (id, command) = match rest.split_once('.') {
            Some((id, command)) => (id, command),
            None => (rest, ""), // bare `connector.<id>` — whole-connector request
        };
        if id.is_empty() {
            return false;
        }
        return capability_grants_allow(grants, id, command);
    }
    false
}

async fn connector_request(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let req: ConnectorRequestBody = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return desktop_err(
                StatusCode::BAD_REQUEST,
                "command_failed",
                &format!("body does not match connector-request.schema.json: {e}"),
            )
        }
    };
    // Audit SEC-001/C-08: the local loopback enforces the SAME role-derived
    // grants as the relay — origin pairing alone no longer authorises commands.
    if let Err(denied) = check_connector_capability(&st, &headers, &id, &req.command).await {
        return denied;
    }
    match connectors::dispatch(&st.host, &id, &req).await {
        Ok(success) => (StatusCode::OK, Json(success)).into_response(),
        Err(f) => connector_failure_response(&f),
    }
}

/// CONSENT-001 `POST /api/plugins/:id/consent`: issue a Desktop-SIGNED
/// consent grant and record it in the plugin. The Desktop wizard posts the
/// operator's choices; this handler stamps acceptedAt/expiresAt, signs the
/// grant with the per-install key (the plugin only accepts grants signed by
/// THIS install), and relays `consent.set {envelope}`. Auth: the GUI's own
/// webview or the server token — NEVER a pairing token (a paired web page
/// must not grant consent on the operator's behalf).
async fn issue_plugin_consent(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::FORBIDDEN,
            "auth_required",
            "consent issuance requires the Desktop window (or the server token) — a paired page cannot grant consent",
        );
    }
    let scopes = body.get("scopes").cloned().unwrap_or_else(|| serde_json::json!({}));
    if !scopes.is_object() {
        return desktop_err(StatusCode::BAD_REQUEST, "command_failed", "scopes must be an object");
    }
    let version = body.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
    let accepted_by = body
        .get("acceptedBy")
        .and_then(|v| v.as_str())
        .unwrap_or("desktop-operator")
        .to_string();
    // Grants EXPIRE (default 12 months, capped at 10 years) so consent is
    // re-affirmed on a human timescale, not granted once forever.
    let expires_days = body
        .get("expiresDays")
        .and_then(|v| v.as_u64())
        .unwrap_or(365)
        .clamp(1, 3650);
    let now = chrono::Utc::now();
    let grant = serde_json::json!({
        "version": version,
        "scopes": scopes,
        "acceptedAt": now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "acceptedBy": accepted_by,
        "expiresAt": (now + chrono::Duration::days(expires_days as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    let envelope = match crate::consent_signing::sign_grant(&grant) {
        Ok(e) => e,
        Err(e) => return desktop_err(StatusCode::INTERNAL_SERVER_ERROR, "command_failed", &e),
    };
    let req = ConnectorRequestBody {
        connector_id: Some(id.clone()),
        command: "consent.set".into(),
        payload: Some(serde_json::json!({ "envelope": envelope })),
        timeout_ms: None,
        request_id: None,
    };
    match connectors::dispatch(&st.host, &id, &req).await {
        Ok(success) => (StatusCode::OK, Json(success)).into_response(),
        Err(f) => connector_failure_response(&f),
    }
}

// ---- events (SSE) ----

/// `GET /api/events` — Server-Sent Events stream of desktop-event envelopes:
/// `id:` = idempotencyKey, `event:` = name, `data:` = the full envelope JSON,
/// `: ping` comment every 20 s.
async fn events_sse(State(st): State<DesktopState>) -> impl IntoResponse {
    let rx = st.host.events().subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let e = SseEvent::default()
                        .id(ev.idempotency_key.clone())
                        .event(ev.name.clone())
                        .data(ev.json.as_ref());
                    return Some((Ok::<_, std::convert::Infallible>(e), rx));
                }
                // A slow consumer lagged the ring: skip what's lost, keep going
                // (consumers dedupe on idempotencyKey by contract anyway).
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(20))
            .text("ping"),
    )
}

/// `GET /api/plugins/realtime` — Server-Sent Events stream of VOLATILE
/// realtime frames (`event: realtime`, `data:` = the frame JSON). Frames are
/// droppable observations (live caller partials, session phase) — a lagged
/// subscriber skips ahead; nothing here is journalled or replayable.
async fn realtime_sse(State(st): State<DesktopState>) -> impl IntoResponse {
    let rx = st.host.realtime_subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    let e = SseEvent::default().event("realtime").data(frame);
                    return Some((Ok::<_, std::convert::Infallible>(e), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(20))
            .text("ping"),
    )
}

// ---- Aokie Companion endpoint identity + mutual pairing ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AokiePairingOfferBody {
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    desktop_connection_id: Option<String>,
}

async fn aokie_pairing_status(State(st): State<DesktopState>) -> impl IntoResponse {
    Json(st.host.aokie_endpoint_identity.status())
}

async fn create_aokie_pairing_offer(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Json(body): Json<AokiePairingOfferBody>,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::FORBIDDEN,
            "auth_required",
            "Aokie endpoint pairing must be started in the Desktop window (or with the headless server token)",
        );
    }
    let (assigned_app, instance_id) = st
        .flow_runtime
        .as_ref()
        .map(|runtime| runtime.aokie_pairing_context())
        .unwrap_or((None, "formlogic-desktop".into()));
    let app_id = body
        .app_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(assigned_app);
    let Some(app_id) = app_id else {
        return desktop_err(
            StatusCode::CONFLICT,
            "app_assignment_required",
            "Assign Aokie to exactly one app, or provide the custom server app id",
        );
    };
    let desktop_connection_id = body
        .desktop_connection_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&instance_id);
    match st.host.aokie_endpoint_identity.create_pairing_offer(
        &app_id,
        body.workspace_id.as_deref(),
        desktop_connection_id,
    ) {
        Ok(offer) => (StatusCode::CREATED, Json(offer)).into_response(),
        Err(error) => desktop_err(StatusCode::BAD_REQUEST, "pairing_failed", &error),
    }
}

/// Receive a cryptographically signed mobile response from FormLogic, a
/// custom signalling service, or a co-located test client. The relay is not
/// trusted and cannot approve the key; this handler only creates a local
/// owner-confirmation item after possession/binding/replay checks pass.
async fn receive_aokie_pairing_response(
    State(st): State<DesktopState>,
    Json(response): Json<crate::aokie_endpoint_identity::MobilePairingResponse>,
) -> Response {
    match st
        .host
        .aokie_endpoint_identity
        .receive_mobile_response(response)
    {
        Ok(pending) => (StatusCode::ACCEPTED, Json(pending)).into_response(),
        Err(error) => desktop_err(StatusCode::BAD_REQUEST, "pairing_proof_invalid", &error),
    }
}

/// The approved peer roster is a private `plugin.init` input, so an active
/// Aokie process must be cycled after every persisted roster/key mutation.
/// Inactive plugins remain inactive and will receive the latest roster on their
/// next explicit start.
async fn refresh_running_aokie_private_bootstrap(st: &DesktopState) -> Result<bool, String> {
    st.host.restart_if_active("aokie").await
}

fn aokie_roster_changed_but_refresh_failed(action: &str, error: &str) -> Response {
    desktop_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "plugin_refresh_failed",
        &format!(
            "The Aokie Companion {action} was saved, but the running Aokie plugin could not be restarted with the new endpoint roster: {error}"
        ),
    )
}

async fn approve_aokie_mobile(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::FORBIDDEN,
            "auth_required",
            "Aokie mobile approval requires the local Desktop owner",
        );
    }
    match st.host.aokie_endpoint_identity.approve_mobile(&id) {
        Ok(approved) => match refresh_running_aokie_private_bootstrap(&st).await {
            Ok(_) => (StatusCode::OK, Json(approved)).into_response(),
            Err(error) => aokie_roster_changed_but_refresh_failed("approval", &error),
        },
        Err(error) => desktop_err(StatusCode::BAD_REQUEST, "approval_failed", &error),
    }
}

async fn deny_aokie_mobile(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::FORBIDDEN,
            "auth_required",
            "Aokie mobile approval requires the local Desktop owner",
        );
    }
    match st.host.aokie_endpoint_identity.deny_mobile(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => desktop_err(StatusCode::NOT_FOUND, "approval_failed", &error),
    }
}

async fn revoke_aokie_mobile(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Path(thumbprint): Path<String>,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::FORBIDDEN,
            "auth_required",
            "Aokie mobile revocation requires the local Desktop owner",
        );
    }
    match st
        .host
        .aokie_endpoint_identity
        .revoke_mobile(&thumbprint)
    {
        Ok(()) => match refresh_running_aokie_private_bootstrap(&st).await {
            Ok(_) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => aokie_roster_changed_but_refresh_failed("revocation", &error),
        },
        Err(error) => desktop_err(StatusCode::NOT_FOUND, "revoke_failed", &error),
    }
}

async fn rotate_aokie_desktop_identity(
    State(st): State<DesktopState>,
    headers: HeaderMap,
) -> Response {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::FORBIDDEN,
            "auth_required",
            "Aokie Desktop key rotation requires the local Desktop owner",
        );
    }
    match st
        .host
        .aokie_endpoint_identity
        .rotate_identity_and_require_fresh_pairing()
    {
        Ok(status) => match refresh_running_aokie_private_bootstrap(&st).await {
            Ok(_) => (StatusCode::OK, Json(status)).into_response(),
            Err(error) => aokie_roster_changed_but_refresh_failed("identity rotation", &error),
        },
        Err(error) => desktop_err(StatusCode::INTERNAL_SERVER_ERROR, "rotation_failed", &error),
    }
}

// ---- pairing ----

#[derive(Deserialize)]
struct PairingBeginBody {
    origin: String,
    /// A page probing on load (not an explicit "Connect" click). When true,
    /// an UNTRUSTED origin is answered `{autoApproved:false}` WITHOUT creating
    /// a pending request, so a background reconnect attempt can't spam the
    /// Desktop's approval list. An already-trusted origin auto-approves either
    /// way — the browser re-pairs silently after losing its session token.
    #[serde(default)]
    silent: bool,
}

/// `POST /api/desktop/pairing-requests {origin, silent?}` →
/// `{requestId?, autoApproved}`. Open to any http(s) origin BY DESIGN —
/// pairing is how a new origin earns trust; the user approves in the Desktop
/// window (spam is bounded by the pending cap + the silent flag). A browser
/// caller's Origin header must match the origin it asks to pair.
async fn create_pairing_request(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Json(body): Json<PairingBeginBody>,
) -> impl IntoResponse {
    if let Some(o) = headers.get(ORIGIN).and_then(|o| o.to_str().ok()) {
        let same = crate::pairing::normalize_origin(o).ok()
            == crate::pairing::normalize_origin(&body.origin).ok();
        if !same || crate::pairing::normalize_origin(o).is_err() {
            return desktop_err(
                StatusCode::FORBIDDEN,
                "origin_denied",
                "body origin does not match the request Origin header",
            );
        }
    }
    match st.pairing.begin(&body.origin, body.silent) {
        Ok(outcome) => {
            if outcome.auto_approved {
                eprintln!(
                    "[desktop] pairing auto-approved for already-trusted origin {}",
                    body.origin
                );
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "requestId": outcome.request_id,
                    "autoApproved": outcome.auto_approved,
                })),
            )
                .into_response()
        }
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "origin_denied", &e),
    }
}

/// `GET /api/desktop/pairing-requests/{id}` →
/// `{status: "pending"|"approved"|"denied", token?}`.
async fn poll_pairing_request(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let origin = headers.get(ORIGIN).and_then(|o| o.to_str().ok());
    match st.pairing.poll(&id, origin) {
        Ok(req) => {
            let body = match req.status {
                RequestStatus::Pending => serde_json::json!({ "status": "pending" }),
                RequestStatus::Approved { token } => {
                    serde_json::json!({ "status": "approved", "token": token })
                }
                RequestStatus::Denied => serde_json::json!({ "status": "denied" }),
            };
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => desktop_err(StatusCode::NOT_FOUND, "origin_denied", &e),
    }
}

/// `GET /api/desktop/pairing-requests` — pending requests for the Desktop
/// window's approval UI (webview / server token only).
async fn list_pairing_requests(
    State(st): State<DesktopState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "pairing administration is limited to the FormLogic Desktop window",
        );
    }
    Json(st.pairing.pending()).into_response()
}

async fn approve_pairing_request(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "pairing administration is limited to the FormLogic Desktop window",
        );
    }
    match st.pairing.approve(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

async fn deny_pairing_request(
    State(st): State<DesktopState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !pairing_admin_ok(&st.auth, &headers) {
        return desktop_err(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "pairing administration is limited to the FormLogic Desktop window",
        );
    }
    match st.pairing.deny(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => desktop_err(StatusCode::BAD_REQUEST, "command_failed", &e),
    }
}

// ---- trusted origins ----

async fn list_origins(State(st): State<DesktopState>) -> impl IntoResponse {
    Json(st.pairing.origins())
}

async fn revoke_origin(
    State(st): State<DesktopState>,
    Path(origin): Path<String>,
) -> impl IntoResponse {
    let removed = st.pairing.revoke_origin(&origin);
    Json(serde_json::json!({ "removed": removed }))
}

// ---- flows (LIVE desktop runner) ----

/// `POST /api/flows/run` — run a flow by slug (resolved via the linked account)
/// or an inline `flowJson`, per `docs/contracts/flow-run-request.schema.json`.
/// Returns a `flow-run-result`-shaped `{runId, status, result?, error?}`.
async fn flows_run(
    State(st): State<DesktopState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let rt = match &st.flow_runtime {
        Some(r) => r.clone(),
        None => {
            return desktop_err(
                StatusCode::NOT_IMPLEMENTED,
                "runner_unavailable",
                "the desktop flow runtime is not available",
            )
        }
    };
    let v: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return desktop_err(
                StatusCode::BAD_REQUEST,
                "invalid_flow",
                &format!("body does not match flow-run-request.schema.json: {e}"),
            )
        }
    };
    let correlation = v.get("correlationId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let idem = v.get("idempotencyKey").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if correlation.is_empty() || idem.is_empty() {
        return desktop_err(StatusCode::BAD_REQUEST, "invalid_flow", "correlationId and idempotencyKey are required");
    }
    let flow_json = v.get("flowJson").filter(|x| x.is_object()).cloned();
    let flow_slug = v.get("flowId").and_then(|x| x.as_str()).map(str::to_string);
    if flow_json.is_none() && flow_slug.is_none() {
        return desktop_err(StatusCode::BAD_REQUEST, "invalid_flow", "either flowId or flowJson is required");
    }
    let app_slug = v
        .get("appContext")
        .and_then(|a| a.get("appSlug"))
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let inputs = v.get("inputs").cloned().unwrap_or_else(|| serde_json::json!({}));
    let timeout = v.get("timeoutMs").and_then(|x| x.as_u64());
    let caps: Vec<String> = v
        .get("capabilities")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    // FLOW-SEC-001: the request's capability vector is a REQUEST, not a grant.
    // On a linked desktop every requested capability must be covered by the
    // caller's verified `X-FormLogic-Capability` grants (the same token +
    // introspection path as the direct connector gateway) or the run refuses —
    // exactly what flow-run-request.schema.json documents. A request with no
    // capabilities needs no token: the runner's node gates deny connector/KV
    // nodes without declared capabilities anyway. Unlinked desktops keep the
    // legacy local single-user gating (pairing stands alone).
    if !caps.is_empty() {
        match resolve_capability_grants(&st, &headers).await {
            Err(resp) => return resp,
            Ok(None) => {} // unlinked — local single-user machine
            Ok(Some(grants)) => {
                let uncovered: Vec<&str> = caps
                    .iter()
                    .filter(|c| !grant_covers_capability(&grants, c))
                    .map(String::as_str)
                    .collect();
                if !uncovered.is_empty() {
                    return desktop_err(
                        StatusCode::FORBIDDEN,
                        "capability_denied",
                        &format!(
                            "your grants do not cover the requested capabilities: {}",
                            uncovered.join(", ")
                        ),
                    );
                }
            }
        }
    }
    match rt.run_flow_direct(flow_json, flow_slug, app_slug, inputs, correlation, idem, timeout, caps).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(msg) => {
            let code = if msg.contains("not configured") {
                "runner_unavailable"
            } else if msg.to_lowercase().contains("unknown or disabled flow") {
                "invalid_flow"
            } else {
                "node_failed"
            };
            (
                StatusCode::OK,
                Json(serde_json::json!({ "runId": "", "status": "error", "error": { "code": code, "message": msg } })),
            )
                .into_response()
        }
    }
}

/// `GET /api/flows/runs/{id}` — status/result of a recent run this runtime
/// executed, per `flow-run-result.schema.json`.
async fn flows_run_status(State(st): State<DesktopState>, Path(id): Path<String>) -> impl IntoResponse {
    match st.flow_runtime.as_ref().and_then(|r| r.cached_run(&id)) {
        Some(mut body) => {
            if let Some(obj) = body.as_object_mut() {
                obj.entry("runId").or_insert_with(|| serde_json::json!(id));
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        None => desktop_err(StatusCode::NOT_FOUND, "invalid_flow", "unknown run id"),
    }
}

/// `GET /api/flows/event-work` — the durable event-work DLQ (audit
/// CROSS-EVENT-001): pending/dead counts and every dead-lettered plugin event
/// with its reason, attempts and age.
async fn flows_event_work(State(st): State<DesktopState>) -> impl IntoResponse {
    match &st.flow_runtime {
        Some(rt) => (StatusCode::OK, Json(rt.event_work_debug())).into_response(),
        None => desktop_err(
            StatusCode::NOT_IMPLEMENTED,
            "runner_unavailable",
            "the desktop flow runtime is not available",
        ),
    }
}

/// `POST /api/flows/event-work/redrive {key?}` — operator redrive: revive one
/// dead event (or, with no key, the whole dead set) back through the live
/// pipeline with a fresh attempt budget.
async fn flows_event_work_redrive(
    State(st): State<DesktopState>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let rt = match &st.flow_runtime {
        Some(r) => r.clone(),
        None => {
            return desktop_err(
                StatusCode::NOT_IMPLEMENTED,
                "runner_unavailable",
                "the desktop flow runtime is not available",
            )
        }
    };
    let key = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("key").and_then(|k| k.as_str()).map(str::to_string));
    let revived = rt.redrive_event_work(key.as_deref());
    (StatusCode::OK, Json(serde_json::json!({ "revived": revived }))).into_response()
}

/// `GET /api/flows/runtime-errors` — the inspectable history behind the bare
/// `errors` counter: bounded ring, consecutive repeats collapsed with counts.
async fn flows_runtime_errors(State(st): State<DesktopState>) -> impl IntoResponse {
    let rt = match &st.flow_runtime {
        Some(r) => r.clone(),
        None => {
            return desktop_err(
                StatusCode::NOT_IMPLEMENTED,
                "runner_unavailable",
                "the desktop flow runtime is not available",
            )
        }
    };
    let status = rt.status();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "count": status.errors,
            "lastError": status.last_error,
            "errors": rt.recent_errors(),
        })),
    )
        .into_response()
}

/// `POST /api/flows/runtime-errors/clear` — operator reset of the diagnostic
/// error counter + history (nothing operational changes).
async fn flows_runtime_errors_clear(State(st): State<DesktopState>) -> impl IntoResponse {
    let rt = match &st.flow_runtime {
        Some(r) => r.clone(),
        None => {
            return desktop_err(
                StatusCode::NOT_IMPLEMENTED,
                "runner_unavailable",
                "the desktop flow runtime is not available",
            )
        }
    };
    rt.clear_errors();
    StatusCode::NO_CONTENT.into_response()
}

// ------- helpers -------

fn err400(msg: &str) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

fn err500(msg: &str) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

/// True only when `origin`'s HOST is exactly a loopback name — NOT a prefix.
/// `origin.starts_with("http://localhost")` would also accept the attacker-owned
/// `http://localhost.evil.com`, so we parse the host and compare it exactly.
/// Port-agnostic; handles bracketed IPv6 (`http://[::1]:port`). Only consulted
/// in debug builds (the dev webview is a localhost port); release trusts the
/// tauri origins alone.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn is_loopback_origin(origin: &str) -> bool {
    let rest = match origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split('/').next().unwrap_or(rest);
    if let Some(inner) = host.strip_prefix('[') {
        // Bracketed IPv6: take the part before ']'.
        return inner.split(']').next() == Some("::1");
    }
    // host[:port] — strip a trailing :port (none of our loopback names contain ':').
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    host == "localhost" || host == "127.0.0.1"
}

/// Endpoints that DEFINE/INSTALL arbitrary code or DESTROY user data — i.e. the
/// real exec surface. A native no-Origin caller (curl, scripts) may drive the
/// rest of the management plane on a GUI/no-token box, but these fail CLOSED
/// without the server token: defining a service command and starting it would
/// be remote code execution.
fn is_privileged_path(method: &Method, path: &str) -> bool {
    match *method {
        Method::POST => {
            matches!(
                path,
                "/api/services"
                    | "/api/models/download"
                    // verify quarantines (renames aside) mismatching model
                    // files — a mutation of the library, same tier as delete.
                    | "/api/models/verify"
                    | "/api/python/venvs"
                    | "/api/python/install"
            ) || (path.starts_with("/api/services/") && path.ends_with("/uninstall"))
        }
        Method::DELETE => {
            path.starts_with("/api/services/")
                || path.starts_with("/api/models/")
                || path.starts_with("/api/python/venvs/")
        }
        _ => false,
    }
}

/// The companion's OWN webview — the only browser-ish origin trusted WITHOUT a
/// pairing token (it's the desktop app's own UI; a web page can never carry a
/// tauri origin). Loopback origins are allowed in debug builds (the dev UI is
/// served from a localhost port) but NOT in a release build, which is what ships.
///
/// LOCAL-SEC-001: this deliberately does NOT trust `https://*.formlogic.com` (or
/// any other remote origin). A hosted web page — including formlogic.com itself,
/// whose subdomains/XSS must not reach the local management plane — earns access
/// ONLY through an exact-origin pairing token.
fn is_gui_webview_origin(origin: &str) -> bool {
    if origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
    {
        return true;
    }
    #[cfg(debug_assertions)]
    if is_loopback_origin(origin) {
        return true;
    }
    false
}

/// Extract a `Bearer <token>` from the Authorization header, if present.
fn bearer_token(req: &Request) -> Option<String> {
    req.headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_owned())
}

/// Compare the configured token to the supplied one without short-circuiting on
/// the first differing byte (so it can't be recovered prefix-by-prefix via
/// timing). Length still differs early — acceptable for a loopback secret.
fn token_eq(want: &str, got: &str) -> bool {
    let (w, g) = (want.as_bytes(), got.as_bytes());
    if w.len() != g.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..w.len() {
        diff |= w[i] ^ g[i];
    }
    diff == 0
}

/// Auth config for the origin guard: an optional bearer `token` (the only key
/// for privileged routes on a headless server that has one set) plus `gui_mode`,
/// which the GUI companion sets so its trusted webview still reaches privileged
/// routes via the origin allow-list even when a token is ALSO configured -- so
/// the CLI can drive the companion without locking out its own UI.
#[derive(Clone)]
struct AuthConfig {
    token: Option<String>,
    gui_mode: bool,
}

/// Pure decision core of [`management_auth_guard`] (LOCAL-SEC-001), split out
/// for tests.
///
/// Browser-facing requests — an `Origin` header is present; browsers always
/// send one here because `127.0.0.1:17872` is cross-origin to every page —
/// must carry a pairing token bound to that EXACT origin. There is no origin
/// allow-list any more: `https://formlogic.com`, its subdomains, `null` and
/// every other page all take the same pairing path, so a compromised
/// subdomain / site XSS cannot reach the local management plane. The
/// companion's own webview (unspoofable by web content) and the headless
/// server bearer token administer without pairing.
///
/// Native callers (no `Origin`: curl, scripts, the CLI) run as the user and
/// are outside the browser threat model, so they keep their legacy posture —
/// EXCEPT the exec surface (`is_privileged_path`: defining/installing code,
/// destroying data), which stays closed without the server token, and a
/// headless box with a token configured stays token-only for every mutation.
#[allow(clippy::too_many_arguments)] // deliberately a flat, test-friendly decision table
fn management_auth_decision(
    server_token_ok: bool,
    gui_webview_ok: bool,
    gui_mode: bool,
    has_server_token: bool,
    privileged: bool,
    mutating: bool,
    origin_present: bool,
    pairing: Option<TokenCheck>,
) -> Result<(), (StatusCode, &'static str, &'static str)> {
    if server_token_ok || gui_webview_ok {
        return Ok(());
    }
    if origin_present {
        // Browser-facing: exact-origin pairing token or nothing.
        return match pairing {
            Some(TokenCheck::Ok) => Ok(()),
            Some(TokenCheck::WrongOrigin) => Err((
                StatusCode::FORBIDDEN,
                "origin_denied",
                "token is not valid for this origin",
            )),
            Some(TokenCheck::Invalid) => Err((
                StatusCode::UNAUTHORIZED,
                "auth_required",
                "invalid or expired pairing token",
            )),
            None => Err((
                StatusCode::UNAUTHORIZED,
                "auth_required",
                "missing bearer token — pair with FormLogic Desktop first",
            )),
        };
    }
    // Native local caller (no browser Origin).
    if privileged {
        return Err((
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "this operation requires the server token or the Desktop window",
        ));
    }
    if mutating && !gui_mode && has_server_token {
        // Headless with a token configured: the token gates every mutation.
        return Err((
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "this server requires its bearer token",
        ));
    }
    Ok(())
}

/// Auth middleware for the MANAGEMENT plane — services / models / python /
/// config / desktop-info / support-bundle (everything in the legacy router
/// except `/api/health`, which stays an open, secret-free probe). Same trust
/// anchors as [`plugin_auth_guard`] (LOCAL-SEC-001: pairing is no longer
/// applied "more narrowly" than the service/model/python surface), plus the
/// native no-Origin posture described on [`management_auth_decision`].
async fn management_auth_guard(
    State(st): State<DesktopState>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    let m = req.method().clone();
    let mutating =
        m == Method::POST || m == Method::PUT || m == Method::DELETE || m == Method::PATCH;
    let origin = req
        .headers()
        .get(ORIGIN)
        .and_then(|o| o.to_str().ok())
        .map(str::to_owned);
    let server_token_ok = matches!(
        (st.auth.token.as_deref(), bearer_token(&req)),
        (Some(want), Some(got)) if token_eq(want, &got)
    );
    let gui_webview_ok = st.auth.gui_mode
        && matches!(origin.as_deref(), Some(o) if is_gui_webview_origin(o));
    let pairing = bearer_token(&req)
        .as_deref()
        .map(|t| st.pairing.check(t, origin.as_deref()));
    match management_auth_decision(
        server_token_ok,
        gui_webview_ok,
        st.auth.gui_mode,
        st.auth.token.is_some(),
        is_privileged_path(&m, req.uri().path()),
        mutating,
        origin.is_some(),
        pairing,
    ) {
        Ok(()) => next.run(req).await,
        Err((status, code, msg)) => desktop_err(status, code, msg),
    }
}

pub async fn serve(
    port: u16,
    config: Arc<dyn ConfigProvider>,
    // Optional bearer token gating privileged routes for non-browser clients.
    auth_token: Option<String>,
    // GUI companion: also accept its trusted webview origin for privileged
    // routes, so configuring a token (for CLI access) doesn't lock out the UI.
    gui_mode: bool,
    registry: RegistryHandle,
    downloads: DownloadsHandle,
    python: PythonHandle,
    catalog: CatalogHandle,
    // FormLogic Desktop plugin host + pairing store (shared by both binaries).
    plugin_host: PluginHostHandle,
    pairing: PairingHandle,
    // The headless flow runtime (flows + Aokie). `None` disables the live
    // `/api/flows/*` routes (they report runner_unavailable).
    flow_runtime: Option<Arc<FlowRuntime>>,
) -> Result<(), BoxError> {
    // CORS stays permissive at the HTTP layer (the localhost bind keeps
    // non-local processes out, and `Authorization` must be readable from any
    // paired origin). AUTHORIZATION is what actually gates access: every
    // non-health route requires the GUI webview, the server token, or an
    // exact-origin pairing token (LOCAL-SEC-001) — so a random web page the
    // user has open can neither read nor mutate the management plane.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        // Private Network Access (2026-07-13): a browser reaching this
        // loopback bridge from a hostname/HTTPS origin (e.g. https://
        // formlogic.local) sends `Access-Control-Request-Private-Network: true`
        // on its preflight and BLOCKS the request unless the response echoes
        // `Access-Control-Allow-Private-Network: true`. Without this, detection
        // + every connector call silently failed from such origins and Device
        // Setup showed "FormLogic Desktop is not connected" though it was.
        // tower-http only adds the header when the browser asks (see
        // AllowPrivateNetwork), so plain same-address-space requests are
        // unaffected. The bind stays 127.0.0.1 and every non-health route is
        // still pairing-token gated (LOCAL-SEC-001) — this only unblocks the
        // CORS preflight, it does not grant access.
        .allow_private_network(true);

    let state = AppState {
        config,
        registry,
        downloads,
        python,
        catalog,
        flow_runtime: flow_runtime.clone(),
    };

    let desktop_state = DesktopState {
        host: plugin_host,
        pairing,
        auth: AuthConfig {
            token: auth_token.clone(),
            gui_mode,
        },
        flow_runtime,
        capability_cache: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        capability_last_known: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };

    // The ONLY unauthenticated route: the discovery probe. Its body is
    // secret-free by contract (`health_reports_new_and_legacy_identity`).
    let open_api = Router::new()
        .route("/api/health", get(health))
        .with_state(state.clone());

    // Management plane (services / models / python / config / desktop-info):
    // every route behind the pairing-token guard (LOCAL-SEC-001).
    let management_api = Router::new()
        .route("/api/desktop/info", get(desktop_info))
        .route("/api/desktop/support-bundle", get(support_bundle))
        .route("/api/desktop/journals", get(desktop_journals))
        .route("/api/desktop/journals/clear", post(desktop_journals_clear))
        .route("/api/config", get(get_config))
        // services
        .route("/api/services", get(list_services).post(add_service))
        .route("/api/services/ensure-by-port", post(ensure_service_by_port))
        .route("/api/services/:id", delete(delete_service))
        .route("/api/services/:id/start", post(start_service))
        .route("/api/services/:id/stop", post(stop_service))
        .route("/api/services/:id/repair", post(repair_service))
        .route("/api/services/:id/autostart", post(set_service_autostart))
        .route("/api/services/:id/install", post(install_service))
        .route("/api/services/:id/uninstall", post(uninstall_service))
        .route(
            "/api/services/:id/cancel-install",
            post(cancel_install_service),
        )
        .route("/api/services/:id/logs", get(service_logs))
        .route("/api/services/:id/export", get(export_service))
        // models
        .route("/api/models", get(list_models))
        .route("/api/models/catalog", get(model_catalog))
        .route("/api/models/verify", post(verify_models))
        .route("/api/models/download", post(start_model_download))
        .route("/api/models/downloads", get(list_downloads))
        .route("/api/models/downloads/:id/pause", post(pause_download))
        .route("/api/models/downloads/:id/resume", post(resume_download))
        .route("/api/models/downloads/:id/cancel", post(cancel_download))
        .route("/api/models/:name", delete(delete_model))
        // python
        .route("/api/python", get(python_status))
        .route("/api/python/install", post(install_python))
        .route("/api/python/logs", get(python_logs))
        .route("/api/python/venvs", post(create_venv))
        .route("/api/python/venvs/:name", delete(delete_venv))
        .route_layer(middleware::from_fn_with_state(
            desktop_state.clone(),
            management_auth_guard,
        ))
        .with_state(state);

    // Plugin-API routes: everything behind the pairing-token guard.
    let plugin_api = Router::new()
        .route("/api/plugins", get(list_plugins))
        // PLG-102: UI-driven install from a folder path or an uploaded archive.
        // Registered before the `:id` routes so `install` is not captured as an
        // id (axum prefers a static segment, but keep the ordering explicit).
        .route("/api/plugins/install", post(install_plugin_from_source))
        .route("/api/plugins/:id", get(get_plugin).delete(uninstall_plugin))
        .route("/api/plugins/:id/install", post(install_builtin_plugin))
        .route("/api/plugins/:id/enable", post(enable_plugin))
        .route("/api/plugins/:id/disable", post(disable_plugin))
        .route("/api/plugins/:id/start", post(start_plugin))
        .route("/api/plugins/:id/stop", post(stop_plugin))
        .route("/api/plugins/:id/restart", post(restart_plugin))
        .route("/api/plugins/:id/health", get(plugin_health))
        .route("/api/plugins/:id/logs", get(plugin_logs))
        .route("/api/plugins/:id/commands/:command", post(plugin_command))
        .route("/api/plugins/:id/consent", post(issue_plugin_consent))
        .route("/api/connectors", get(list_connectors))
        .route("/api/connectors/:id/status", get(connector_status))
        .route("/api/connectors/:id/request", post(connector_request))
        .route("/api/events", get(events_sse))
        // Volatile realtime lane (guide §9.2): live caller partials + session
        // phase. Under /api/plugins* so the SAME management-plane auth guard
        // applies (webview | server token | pairing token).
        .route("/api/plugins/realtime", get(realtime_sse))
        .route(
            "/api/aokie/companion/pairing",
            get(aokie_pairing_status),
        )
        .route(
            "/api/aokie/companion/pairing/offers",
            post(create_aokie_pairing_offer),
        )
        .route(
            "/api/aokie/companion/pairing/responses",
            post(receive_aokie_pairing_response),
        )
        .route(
            "/api/aokie/companion/pairing/approvals/:id/approve",
            post(approve_aokie_mobile),
        )
        .route(
            "/api/aokie/companion/pairing/approvals/:id/deny",
            post(deny_aokie_mobile),
        )
        .route(
            "/api/aokie/companion/mobiles/:thumbprint",
            delete(revoke_aokie_mobile),
        )
        .route(
            "/api/aokie/companion/identity/rotate",
            post(rotate_aokie_desktop_identity),
        )
        .route("/api/origins", get(list_origins))
        .route("/api/origins/:origin", delete(revoke_origin))
        // LIVE desktop flow runner (docs/FORMLOGIC_DESKTOP.md §2).
        .route("/api/flows/run", post(flows_run))
        .route("/api/flows/runs/:id", get(flows_run_status))
        // Durable event-work DLQ (audit CROSS-EVENT-001): dead-lettered
        // plugin events with reason/age + the operator redrive.
        .route("/api/flows/event-work", get(flows_event_work))
        .route("/api/flows/event-work/redrive", post(flows_event_work_redrive))
        .route("/api/flows/runtime-errors", get(flows_runtime_errors))
        .route("/api/flows/runtime-errors/clear", post(flows_runtime_errors_clear))
        .route_layer(middleware::from_fn_with_state(
            desktop_state.clone(),
            plugin_auth_guard,
        ))
        .with_state(desktop_state.clone());

    // Pairing routes do their own per-handler auth: begin/poll are open (any
    // origin may ASK; only the user grants), list/approve/deny are
    // webview/server-token only.
    let pairing_api = Router::new()
        .route(
            "/api/desktop/pairing-requests",
            post(create_pairing_request).get(list_pairing_requests),
        )
        .route("/api/desktop/pairing-requests/:id", get(poll_pairing_request))
        .route(
            "/api/desktop/pairing-requests/:id/approve",
            post(approve_pairing_request),
        )
        .route(
            "/api/desktop/pairing-requests/:id/deny",
            post(deny_pairing_request),
        )
        .with_state(desktop_state);

    let app = open_api
        .merge(management_api)
        .merge(plugin_api)
        .merge(pairing_api)
        .layer(cors);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // DESK-PROC-001: keep this listener socket out of spawned children so a
    // service can never inherit it and wedge :17872 after it (or the desktop)
    // dies. Best-effort — a failure here is logged, not fatal.
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        if let Err(e) = crate::proc::set_socket_non_inheritable(listener.as_raw_socket()) {
            log::warn!("could not make the API listener socket non-inheritable: {e}");
        }
    }

    log::info!("FormLogic Desktop API listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        connector_failure_status, desktop_auth_decision, desktop_info_body,
        direct_command_request_id, grant_covers_capability, health_body, is_gui_webview_origin,
        is_privileged_path, management_auth_decision, offline_grace_grants,
        OFFLINE_GRACE_MAX_AGE,
    };
    use crate::pairing::TokenCheck;
    use axum::http::{Method, StatusCode};

    #[test]
    fn direct_plugin_commands_always_have_a_safe_request_id() {
        let supplied = "ui-phone.connect-existing".to_string();
        assert_eq!(
            direct_command_request_id(Some(supplied.clone())),
            supplied,
            "a caller's retry key must be preserved"
        );

        let generated = direct_command_request_id(None);
        assert!(generated.starts_with("desktop-admin:"));
        assert_eq!(generated.len(), "desktop-admin:".len() + 32);
        assert!(generated.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')
        }));
    }

    #[test]
    fn flow_run_capability_requests_map_onto_grants() {
        // FLOW-SEC-001: the /api/flows/run capability vector is a REQUEST that
        // must be covered by the caller's verified grants — decision table.
        let g = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // Owner grant covers everything, including non-connector capabilities.
        let owner = g(&["*"]);
        for cap in ["connector.aokie.call.answer", "connector.aokie.*", "formlogic.kv.write", "model.llm.local"] {
            assert!(grant_covers_capability(&owner, cap), "owner covers {cap}");
        }

        // Whole-connector grants cover exact commands and the wildcard request.
        for grants in [g(&["connector.aokie"]), g(&["connector.aokie.*"])] {
            assert!(grant_covers_capability(&grants, "connector.aokie.call.answer"));
            assert!(grant_covers_capability(&grants, "connector.aokie.*"));
            assert!(grant_covers_capability(&grants, "connector.aokie"));
            assert!(!grant_covers_capability(&grants, "connector.other.thing"), "no cross-connector bleed");
        }

        // An exact-command grant covers exactly that command — never the wildcard.
        let exact = g(&["connector.aokie.call.answer"]);
        assert!(grant_covers_capability(&exact, "connector.aokie.call.answer"));
        assert!(!grant_covers_capability(&exact, "connector.aokie.*"), "wildcard request needs a wildcard grant");
        assert!(!grant_covers_capability(&exact, "connector.aokie.call.reject"));
        assert!(!grant_covers_capability(&exact, "connector.aokie"));

        // Non-connector capabilities require the owner grant; unknown shapes
        // are never covered by accident. Forged/enlarged vectors die here.
        for grants in [g(&["connector.aokie.*"]), g(&["connector.aokie"]), g(&[])] {
            for cap in ["formlogic.kv.write", "formlogic.responses.write", "model.llm.local", "connector.", ""] {
                assert!(!grant_covers_capability(&grants, cap), "{cap} must not be covered by {grants:?}");
            }
        }
    }

    #[test]
    fn offline_grace_honours_only_recent_verified_tokens_with_their_grants() {
        // DESK-CAP-001: a cloud outage must never turn into a blanket allow.
        let now = std::time::Instant::now();
        let grants = vec!["connector.aokie.call.answer".to_string()];

        // Never verified on this desktop → fail closed.
        assert_eq!(offline_grace_grants(None), None);

        // Recently verified → the RECORDED grants apply (the per-command check still runs).
        assert_eq!(offline_grace_grants(Some(&(grants.clone(), now))), Some(grants.clone()));

        // Verified too long ago → the grace window has lapsed; fail closed.
        if let Some(stale) = now.checked_sub(OFFLINE_GRACE_MAX_AGE + std::time::Duration::from_secs(1)) {
            assert_eq!(offline_grace_grants(Some(&(grants, stale))), None);
        }
    }

    #[test]
    fn health_reports_new_and_legacy_identity() {
        // Exact wire shape of GET /api/health after the FormLogic Desktop
        // rebrand — both web detectors key off these fields, so any drift
        // here breaks discovery.
        let v = serde_json::to_value(health_body()).expect("health serializes");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["companion"], "formlogic-desktop");
        assert_eq!(v["legacyCompanion"], "formlogic-desktop");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["apiVersion"], 1);
        assert_eq!(v["pluginApiVersion"], 1);
        // No extra/renamed keys sneak in (camelCase contract).
        assert_eq!(v.as_object().expect("object").len(), 6);
    }

    #[test]
    fn desktop_info_shape() {
        let v = serde_json::to_value(desktop_info_body()).expect("info serializes");
        assert_eq!(v["name"], "FormLogic Desktop");
        assert_eq!(v["companion"], "formlogic-desktop");
        assert_eq!(v["legacyCompanion"], "formlogic-desktop");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["apiVersion"], 1);
        assert_eq!(v["pluginApiVersion"], 1);
        assert_eq!(v["platform"], std::env::consts::OS);
        assert_eq!(v.as_object().expect("object").len(), 7);
    }

    #[test]
    fn gui_webview_origin_trusts_no_web_page() {
        // LOCAL-SEC-001: only the companion's own webview is trusted without a
        // pairing token. formlogic.com — and EVERY subdomain — must pair like
        // any other page, so a compromised subdomain / site XSS can't reach
        // the local management plane. 'null' and garbage origins never pass.
        for o in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
            assert!(is_gui_webview_origin(o), "{o} is the desktop's own UI");
        }
        for o in [
            "https://formlogic.com",
            "https://app.formlogic.com",
            "https://evil.formlogic.com",
            "https://formlogic.com.evil.example",
            "http://formlogic.local",
            "null",
            "",
        ] {
            assert!(!is_gui_webview_origin(o), "{o} must NOT bypass pairing");
        }
        // Loopback dev servers are webview-equivalent ONLY in debug builds.
        #[cfg(not(debug_assertions))]
        assert!(!is_gui_webview_origin("http://localhost:1420"));
    }

    /// Shorthand: management decision for a browser caller (Origin present).
    fn browser(pairing: Option<TokenCheck>) -> Result<(), (StatusCode, &'static str, &'static str)> {
        management_auth_decision(false, false, true, false, false, true, true, pairing)
    }

    #[test]
    fn management_auth_matrix_browser_facing() {
        // LOCAL-SEC-001 acceptance: an unpaired browser origin cannot touch the
        // management plane at all — reads included — regardless of which origin
        // it is. Exact-origin pairing is the only browser path in.
        assert!(browser(Some(TokenCheck::Ok)).is_ok(), "paired origin passes");
        let (s, c, _) = browser(None).unwrap_err();
        assert_eq!((s, c), (StatusCode::UNAUTHORIZED, "auth_required"), "no token → 401");
        let (s, c, _) = browser(Some(TokenCheck::Invalid)).unwrap_err();
        assert_eq!((s, c), (StatusCode::UNAUTHORIZED, "auth_required"), "bogus token → 401");
        // A REAL token stolen by (or minted for) a different origin — e.g. a
        // formlogic.com subdomain replaying another page's pairing — dies here.
        let (s, c, _) = browser(Some(TokenCheck::WrongOrigin)).unwrap_err();
        assert_eq!((s, c), (StatusCode::FORBIDDEN, "origin_denied"), "cross-origin replay → 403");

        // The desktop's own webview and the server token still administer.
        assert!(management_auth_decision(true, false, false, true, true, true, true, None).is_ok());
        assert!(management_auth_decision(false, true, true, false, true, true, true, None).is_ok());
    }

    #[test]
    fn management_auth_matrix_native_callers() {
        // Native callers (no Origin header — curl, scripts, the CLI) keep their
        // legacy posture on a GUI / no-token box…
        assert!(
            management_auth_decision(false, false, true, false, false, false, false, None).is_ok(),
            "GUI box: native read/mutation passes"
        );
        assert!(
            management_auth_decision(false, false, false, false, false, true, false, None).is_ok(),
            "headless no-token: native non-privileged mutation passes"
        );
        // …but the exec surface (define/install code, destroy data) stays
        // CLOSED without the server token, exactly as before.
        let (s, c, _) =
            management_auth_decision(false, false, true, false, true, true, false, None).unwrap_err();
        assert_eq!((s, c), (StatusCode::UNAUTHORIZED, "auth_required"), "privileged native → token only");
        // Headless WITH a token: every mutation requires the token (a native
        // caller could otherwise forge/omit Origin to sidestep the lockdown).
        let (s, c, _) =
            management_auth_decision(false, false, false, true, false, true, false, None).unwrap_err();
        assert_eq!((s, c), (StatusCode::UNAUTHORIZED, "auth_required"));
        // Headless+token GETs stay open to native callers (local diagnosis).
        assert!(management_auth_decision(false, false, false, true, false, false, false, None).is_ok());
    }

    #[test]
    fn privileged_paths_are_the_exec_surface() {
        for (m, p) in [
            (Method::POST, "/api/services"),
            (Method::POST, "/api/models/download"),
            (Method::POST, "/api/models/verify"),
            (Method::POST, "/api/python/install"),
            (Method::POST, "/api/python/venvs"),
            (Method::POST, "/api/services/x/uninstall"),
            (Method::DELETE, "/api/services/x"),
            (Method::DELETE, "/api/models/some.gguf"),
            (Method::DELETE, "/api/python/venvs/v"),
        ] {
            assert!(is_privileged_path(&m, p), "{m} {p} is privileged");
        }
        for (m, p) in [
            (Method::POST, "/api/services/x/start"),
            (Method::POST, "/api/services/x/stop"),
            (Method::POST, "/api/services/x/install"),
            (Method::GET, "/api/services"),
        ] {
            assert!(!is_privileged_path(&m, p), "{m} {p} is not privileged");
        }
    }

    #[test]
    fn desktop_auth_matrix() {
        // Server token or the GUI webview always administer.
        assert!(desktop_auth_decision(true, false, None).is_ok());
        assert!(desktop_auth_decision(false, true, None).is_ok());
        // Pairing token bound to the calling origin passes.
        assert!(desktop_auth_decision(false, false, Some(TokenCheck::Ok)).is_ok());
        // Valid token, wrong origin → origin_denied (403).
        let (status, code, _) =
            desktop_auth_decision(false, false, Some(TokenCheck::WrongOrigin)).unwrap_err();
        assert_eq!((status, code), (StatusCode::FORBIDDEN, "origin_denied"));
        // Bogus/expired token → auth_required (401).
        let (status, code, _) =
            desktop_auth_decision(false, false, Some(TokenCheck::Invalid)).unwrap_err();
        assert_eq!((status, code), (StatusCode::UNAUTHORIZED, "auth_required"));
        // No credentials at all → auth_required (401).
        let (status, code, _) = desktop_auth_decision(false, false, None).unwrap_err();
        assert_eq!((status, code), (StatusCode::UNAUTHORIZED, "auth_required"));
    }


    #[test]
    fn connector_failure_statuses_match_codes() {
        assert_eq!(connector_failure_status("auth_required"), StatusCode::UNAUTHORIZED);
        assert_eq!(connector_failure_status("origin_denied"), StatusCode::FORBIDDEN);
        assert_eq!(connector_failure_status("capability_denied"), StatusCode::FORBIDDEN);
        assert_eq!(connector_failure_status("connector_missing"), StatusCode::NOT_FOUND);
        assert_eq!(
            connector_failure_status("connector_unavailable"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(connector_failure_status("command_failed"), StatusCode::BAD_GATEWAY);
    }
}
