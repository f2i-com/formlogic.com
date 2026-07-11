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
        header::{AUTHORIZATION, ORIGIN},
        HeaderMap, Method, StatusCode,
    },
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse,
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
/// Origin-gated like the other sensitive reads (see `is_restricted_read_path`),
/// no token required.
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

// ------- services -------

async fn list_services(State(state): State<AppState>) -> impl IntoResponse {
    match state.registry.lock() {
        Ok(mut reg) => {
            // Pick up any package dropped into templates/ since last poll, so
            // services are dynamically loadable just by adding a file there.
            reg.reload_new_templates();
            (StatusCode::OK, Json(reg.snapshot())).into_response()
        }
        Err(_) => err500("registry mutex poisoned"),
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
    match state.downloads.list_models() {
        Ok(models) => (StatusCode::OK, Json(models)).into_response(),
        Err(e) => err500(&e),
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
}

async fn start_model_download(
    State(state): State<AppState>,
    Json(req): Json<ModelDownloadRequest>,
) -> impl IntoResponse {
    match state
        .downloads
        .start(&req.url, req.filename.as_deref(), req.subdir.as_deref())
    {
        Ok(id) => (StatusCode::ACCEPTED, Json(serde_json::json!({ "downloadId": id })))
            .into_response(),
        Err(e) => err400(&e),
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
// These routes carry their OWN auth (pairing tokens bound to the calling
// origin — see `crate::pairing` + `plugin_auth_guard` below), so the legacy
// `origin_guard` passes them through untouched (`is_desktop_api_path`).
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

/// Routes owned by the plugin-API auth model (pairing tokens); the legacy
/// origin_guard must not double-gate them.
fn is_desktop_api_path(path: &str) -> bool {
    path == "/api/plugins"
        || path.starts_with("/api/plugins/")
        || path == "/api/connectors"
        || path.starts_with("/api/connectors/")
        || path == "/api/events"
        || path == "/api/origins"
        || path.starts_with("/api/origins/")
        || path.starts_with("/api/flows/")
        || path == "/api/desktop/pairing-requests"
        || path.starts_with("/api/desktop/pairing-requests/")
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
        && matches!(origin.as_deref(), Some(o) if is_allowed_origin_privileged(o));
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
        .is_some_and(is_allowed_origin_privileged);
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
        request_id: parsed.request_id,
    };
    match connectors::dispatch(&st.host, &connector_id, &req).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(f) => connector_failure_response(&f),
    }
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
    let Some(client) = st.flow_runtime.as_ref().and_then(|rt| rt.api_client()) else {
        return Ok(()); // unlinked — legacy local gating
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
    if !capability_grants_allow(&grants, connector_id, command) {
        return Err(desktop_err(
            StatusCode::FORBIDDEN,
            "capability_denied",
            &format!("your role does not allow {connector_id}.{command}"),
        ));
    }
    Ok(())
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

// ---- pairing ----

#[derive(Deserialize)]
struct PairingBeginBody {
    origin: String,
}

/// `POST /api/desktop/pairing-requests {origin}` → `{requestId}`. Open to any
/// http(s) origin BY DESIGN — pairing is how a new origin earns trust; the
/// user approves in the Desktop window (spam is bounded by the pending cap).
/// A browser caller's Origin header must match the origin it asks to pair.
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
    match st.pairing.begin(&body.origin) {
        Ok(id) => (StatusCode::OK, Json(serde_json::json!({ "requestId": id }))).into_response(),
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
async fn flows_run(State(st): State<DesktopState>, body: axum::body::Bytes) -> impl IntoResponse {
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
    let caps = v
        .get("capabilities")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
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

/// Whether a browser `Origin` is allowed to drive state-changing endpoints.
/// The localhost bind keeps non-browser callers out; this stops a *web page*
/// the user happens to have open from issuing drive-by POST/DELETE requests
/// (which would otherwise be possible since CORS is permissive for reads).
/// True only when `origin`'s HOST is exactly a loopback name — NOT a prefix.
/// `origin.starts_with("http://localhost")` would also accept the attacker-owned
/// `http://localhost.evil.com`, so we parse the host and compare it exactly.
/// Port-agnostic; handles bracketed IPv6 (`http://[::1]:port`).
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

fn is_allowed_origin(origin: &str) -> bool {
    // Dev + locally-served formlogic-web (any loopback port).
    if is_loopback_origin(origin) {
        return true;
    }
    // Tauri webview origins (in case the companion's own UI ever calls over HTTP).
    if origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
    {
        return true;
    }
    // Production formlogic-web: https://formlogic.com and any subdomain (port-agnostic).
    if let Some(rest) = origin.strip_prefix("https://") {
        let host = rest.split('/').next().unwrap_or(rest);
        let host = host.split(':').next().unwrap_or(host);
        if host == "formlogic.com" || host.ends_with(".formlogic.com") {
            return true;
        }
    }
    false
}

/// Endpoints that DEFINE/INSTALL arbitrary code or DESTROY user data — i.e. the
/// real exec surface. A malicious local web page (any `http://localhost:<port>`)
/// must not be able to reach these: defining a service command and starting it
/// would be remote code execution. They get the stricter origin check below and
/// fail CLOSED on a missing `Origin`. Note: starting/stopping/installing an
/// ALREADY-DEFINED service (and ensure-by-port) stays on the broad allow-list —
/// those only run commands the user already added + reviewed, and the web app
/// relies on them.
fn is_privileged_path(method: &Method, path: &str) -> bool {
    match *method {
        Method::POST => {
            matches!(
                path,
                "/api/services"
                    | "/api/models/download"
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

/// GET /api/services/:id/export returns the FULL ServiceTemplate — including `run.env` (which a
/// user-authored service may hold an API key in) and the verbatim install/helper script bodies.
/// It's the read-twin of the privileged `add_service` POST, so it's gated like a privileged read
/// (trusted origin or token) rather than left on the open GET surface.
fn is_export_path(path: &str) -> bool {
    path.starts_with("/api/services/") && path.ends_with("/export")
}

/// GET reads that expose process output / absolute paths (the OS username via the data-dir path)
/// and so must not be readable by an arbitrary cross-origin page: the logs endpoints + the config
/// snapshot. Gated on the broad allow-list (blocks only a remote cross-origin page; loopback dev
/// tools + the native CLI still pass).
fn is_restricted_read_path(path: &str) -> bool {
    path == "/api/config"
        || path == "/api/desktop/info"
        || path == "/api/desktop/support-bundle"
        || path == "/api/python/logs"
        || (path.starts_with("/api/services/") && path.ends_with("/logs"))
}

/// Stricter allow-list for privileged endpoints: the companion's OWN webview and
/// formlogic.com only — never an arbitrary localhost page. Loopback origins are
/// allowed in debug builds (the dev UI is served from a localhost port) but NOT
/// in a release build, which is what ships.
fn is_allowed_origin_privileged(origin: &str) -> bool {
    if origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
    {
        return true;
    }
    if let Some(rest) = origin.strip_prefix("https://") {
        let host = rest.split('/').next().unwrap_or(rest);
        let host = host.split(':').next().unwrap_or(host);
        if host == "formlogic.com" || host.ends_with(".formlogic.com") {
            return true;
        }
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

/// Decide whether a privileged request is allowed. A matching bearer token
/// always passes. The trusted-origin allow-list is honored ONLY for the GUI
/// companion (gui_mode), which has a real, unspoofable webview origin. A headless
/// server has no webview — any local process can forge the `Origin` header — so it
/// trusts the token alone: headless WITH a token is token-only, and headless with
/// NO token has its privileged (command-defining / destructive) routes CLOSED (the
/// operator must set FORMLOGIC_SERVER_TOKEN to administer it; the CLI sends the bearer).
fn privileged_allowed(token_ok: bool, gui_mode: bool, _has_token: bool, origin_priv_ok: bool) -> bool {
    token_ok || (gui_mode && origin_priv_ok)
}

/// Gate mutating/exec requests (POST/PUT/DELETE/PATCH) on the `Origin` header.
/// Privileged (command-defining / destructive) paths require the companion's own
/// origin and fail CLOSED on a missing Origin; other mutations keep the broad
/// loopback allow-list. GET reads and CORS preflight (OPTIONS) pass through.
async fn origin_guard(
    State(auth): State<AuthConfig>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    // The FormLogic Desktop plugin API carries its own, STRICTER auth
    // (origin-bound pairing tokens via plugin_auth_guard) — and must accept
    // paired origins the legacy allow-list doesn't know. Pass through.
    if is_desktop_api_path(req.uri().path()) {
        return next.run(req).await;
    }
    let m = req.method().clone();
    let mutating =
        m == Method::POST || m == Method::PUT || m == Method::DELETE || m == Method::PATCH;
    if mutating {
        let privileged = is_privileged_path(&m, req.uri().path());
        let origin = req
            .headers()
            .get(ORIGIN)
            .and_then(|o| o.to_str().ok())
            .map(str::to_owned);
        // A configured bearer token lets a headless/non-browser admin client
        // (the CLI, formlogic-server tooling) perform privileged ops the origin
        // allow-list would otherwise block — there's no browser origin on a
        // server. Compared without per-byte short-circuit (token_eq).
        let token_ok = matches!(
            (auth.token.as_deref(), bearer_token(&req)),
            (Some(want), Some(got)) if token_eq(want, &got)
        );
        let allowed = if privileged {
            let origin_priv_ok =
                matches!(origin.as_deref(), Some(o) if is_allowed_origin_privileged(o));
            privileged_allowed(token_ok, auth.gui_mode, auth.token.is_some(), origin_priv_ok)
        } else {
            // A configured token must gate EVERY mutation on a headless box — a
            // forged Origin (any non-browser caller can set one) must not substitute
            // for it. Mirrors privileged_allowed: pass on a matching token, OR when
            // there's no real lockdown (GUI, or no token configured) AND the origin
            // is browser-acceptable (loopback/tauri/formlogic.com) or absent (native CLI).
            // So headless+token now requires the token even with a spoofed Origin,
            // while GUI mode and the no-token default keep their broad behavior.
            let origin_ok = match origin.as_deref() {
                Some(o) => is_allowed_origin(o),
                None => true, // native/CLI caller: no browser Origin to check
            };
            token_ok || ((auth.gui_mode || auth.token.is_none()) && origin_ok)
        };
        if !allowed {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "origin not allowed" })),
            )
                .into_response();
        }
    } else if m == Method::GET {
        // The GET surface is otherwise ungated and served with CORS Any, so a page the user
        // visits could read it cross-origin. Gate the SENSITIVE reads (the rest — health, model /
        // catalog / service listings — carry no secrets and stay open). A native / no-Origin
        // caller is allowed: it has direct filesystem access anyway, and this keeps the CLI working.
        let path = req.uri().path();
        let export_read = is_export_path(path);
        let restricted_read = is_restricted_read_path(path);
        if export_read || restricted_read {
            let origin = req
                .headers()
                .get(ORIGIN)
                .and_then(|o| o.to_str().ok())
                .map(str::to_owned);
            let token_ok = matches!(
                (auth.token.as_deref(), bearer_token(&req)),
                (Some(want), Some(got)) if token_eq(want, &got)
            );
            let allowed = match origin.as_deref() {
                None => true,
                Some(o) => {
                    if export_read {
                        token_ok || (auth.gui_mode && is_allowed_origin_privileged(o))
                    } else {
                        token_ok || is_allowed_origin(o)
                    }
                }
            };
            if !allowed {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "error": "origin not allowed" })),
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
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
    // CORS stays permissive so a hosted formlogic-web at any domain can READ the
    // API (the localhost bind keeps non-local processes out). State-changing
    // and exec endpoints are additionally gated by `origin_guard` below, so a
    // random web page the user has open can't issue drive-by POST/DELETE
    // requests against the loopback API.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any);

    let state = AppState {
        config,
        registry,
        downloads,
        python,
        catalog,
        flow_runtime: flow_runtime.clone(),
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/desktop/info", get(desktop_info))
        .route("/api/desktop/support-bundle", get(support_bundle))
        .route("/api/config", get(get_config))
        // services
        .route("/api/services", get(list_services).post(add_service))
        .route("/api/services/ensure-by-port", post(ensure_service_by_port))
        .route("/api/services/:id", delete(delete_service))
        .route("/api/services/:id/start", post(start_service))
        .route("/api/services/:id/stop", post(stop_service))
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
        .with_state(state);

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

    // Plugin-API routes: everything behind the pairing-token guard.
    let plugin_api = Router::new()
        .route("/api/plugins", get(list_plugins))
        .route("/api/plugins/:id", get(get_plugin))
        .route("/api/plugins/:id/install", post(install_builtin_plugin))
        .route("/api/plugins/:id/start", post(start_plugin))
        .route("/api/plugins/:id/stop", post(stop_plugin))
        .route("/api/plugins/:id/restart", post(restart_plugin))
        .route("/api/plugins/:id/health", get(plugin_health))
        .route("/api/plugins/:id/logs", get(plugin_logs))
        .route("/api/plugins/:id/commands/:command", post(plugin_command))
        .route("/api/connectors", get(list_connectors))
        .route("/api/connectors/:id/status", get(connector_status))
        .route("/api/connectors/:id/request", post(connector_request))
        .route("/api/events", get(events_sse))
        .route("/api/origins", get(list_origins))
        .route("/api/origins/:origin", delete(revoke_origin))
        // LIVE desktop flow runner (docs/FORMLOGIC_DESKTOP.md §2).
        .route("/api/flows/run", post(flows_run))
        .route("/api/flows/runs/:id", get(flows_run_status))
        // Durable event-work DLQ (audit CROSS-EVENT-001): dead-lettered
        // plugin events with reason/age + the operator redrive.
        .route("/api/flows/event-work", get(flows_event_work))
        .route("/api/flows/event-work/redrive", post(flows_event_work_redrive))
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

    let app = app
        .merge(plugin_api)
        .merge(pairing_api)
        .layer(middleware::from_fn_with_state(
            AuthConfig { token: auth_token, gui_mode },
            origin_guard,
        ))
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
        connector_failure_status, desktop_auth_decision, desktop_info_body, health_body,
        is_desktop_api_path, is_restricted_read_path, offline_grace_grants, privileged_allowed,
        OFFLINE_GRACE_MAX_AGE,
    };
    use crate::pairing::TokenCheck;
    use axum::http::StatusCode;

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
    fn desktop_info_is_origin_gated_read() {
        // /api/desktop/info sits behind the same broad origin allow-list as
        // /api/config (no token needed); /api/health stays fully open.
        assert!(is_restricted_read_path("/api/desktop/info"));
        assert!(!is_restricted_read_path("/api/health"));
    }

    #[test]
    fn privileged_auth_matrix() {
        // Headless server (gui_mode=false) WITH a token: token is the only key;
        // a trusted/ spoofed Origin must NOT substitute.
        assert!(privileged_allowed(true, false, true, false), "valid token passes");
        assert!(!privileged_allowed(false, false, true, true), "origin can't bypass a set token");
        // GUI companion (gui_mode=true) WITH a token: token OR webview origin.
        assert!(privileged_allowed(true, true, true, false), "companion: token passes");
        assert!(privileged_allowed(false, true, true, true), "companion: webview origin passes");
        assert!(!privileged_allowed(false, true, true, false), "companion: neither → denied");
        // Headless (gui_mode=false) with NO token: privileged routes are CLOSED —
        // any local process can forge the Origin on a headless server, so a trusted
        // Origin must NOT substitute for a token. The operator must set a token.
        assert!(!privileged_allowed(false, false, false, true), "headless no-token: forged Origin does NOT pass");
        assert!(!privileged_allowed(false, false, false, false), "headless no-token: bad origin denied");
        // GUI companion with NO token: its real (unspoofable) webview origin admins.
        assert!(privileged_allowed(false, true, false, true), "GUI no-token: webview origin passes");
    }

    #[test]
    fn desktop_api_paths_bypass_the_legacy_origin_guard() {
        for p in [
            "/api/plugins",
            "/api/plugins/mock/start",
            "/api/connectors",
            "/api/connectors/mock/request",
            "/api/events",
            "/api/origins",
            "/api/origins/https%3A%2F%2Fformlogic.com",
            "/api/flows/run",
            "/api/desktop/pairing-requests",
            "/api/desktop/pairing-requests/abc/approve",
        ] {
            assert!(is_desktop_api_path(p), "{p} must be plugin-API gated");
        }
        // Legacy surface stays under origin_guard.
        for p in [
            "/api/health",
            "/api/desktop/info",
            "/api/services",
            "/api/models",
            "/api/config",
        ] {
            assert!(!is_desktop_api_path(p), "{p} must keep the legacy guard");
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
