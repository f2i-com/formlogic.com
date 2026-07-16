//! FormLogic Desktop — entry point.
//!
//! Phase 1: bring up the Tauri shell + a tray icon + a localhost HTTP API
//! that formlogic-web can discover.
//! Phase 2: load the service registry, manage child processes, expose
//! /api/services/* and stop everything cleanly on exit.

pub mod connectors;
pub mod aokie_endpoint_identity;
pub mod aokie_companion_publisher;
pub mod consent_signing;
pub mod events;
pub mod external_url;
pub mod flows;
pub mod formlogic_client;
pub mod http;
pub mod journal_crypto;
pub mod oauth;
pub mod pairing;
pub mod plugins;
pub mod proc;
pub mod secrets;
pub mod services;

/// Port the localhost API binds to. Fixed so formlogic-web's detection probe has a
/// stable target. Shared by both binaries (the GUI and the headless server).
pub const COMPANION_PORT: u16 = 17872;

/// Version of the FormLogic Desktop HTTP surface (`apiVersion` in
/// `/api/health` + `/api/desktop/info`). Breaking changes to the HTTP API
/// bump this integer. See `docs/FORMLOGIC_INTEGRATION.md` and the canonical
/// contract in `formlogic-app/docs/FORMLOGIC_DESKTOP.md`.
pub const DESKTOP_API_VERSION: u32 = 1;

/// Version of the plugin stdio protocol (`pluginApiVersion`). Plugins declare
/// the version they speak in their manifest; Desktop refuses incompatible
/// plugins. See `formlogic-app/docs/DESKTOP_PLUGIN_SDK.md`.
pub const PLUGIN_API_VERSION: u32 = 1;

// Everything below `open_path` is the GUI companion (Tauri), gated behind the
// default `gui` feature: `cargo build --bin formlogic-server --no-default-features`
// builds the headless server WITHOUT tauri/webkit2gtk. `http` + `services`
// above are tauri-free and shared by both binaries.
#[cfg(feature = "gui")]
mod migrate;
#[cfg(feature = "gui")]
mod tray;
#[cfg(feature = "gui")]
pub use gui::run;

#[cfg(feature = "gui")]
mod gui {
use super::COMPANION_PORT;
use crate::{http, migrate, tray};
use crate::events::EventBus;
use crate::flows::{FlowRuntime, FlowRuntimeStatus};
use crate::formlogic_client::{self, FormLogicClient, FormLogicConfig};
use crate::http::CompanionConfig;
use crate::oauth::{self, OAuthLink, OAuthLinkStatus};
use crate::migrate::{MigratePlan, MigrationHandle, MigrationProgress};
use crate::pairing::{PairingHandle, PairingStore};
use crate::plugins::registry::{PluginHost, PluginHostHandle};
use crate::services::catalog::CatalogHandle;
use crate::services::downloads::{Downloads, DownloadsHandle};
use crate::services::python::{Python, PythonHandle};
use crate::services::registry::{Registry, RegistryHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, RunEvent, WindowEvent};

/// Resolve a Windows system binary to its absolute `%SystemRoot%` path, so a planted exe of the
/// same name on the process CWD or an early PATH entry can't be launched instead (mirrors
/// services::registry::system32_exe). Falls back to the bare name when SystemRoot is unset or the
/// absolute path is missing (e.g. nvidia-smi on a non-standard NVIDIA install). On non-Windows the
/// bare name is returned for the standard PATH lookup.
fn resolved_system_exe(subdir: &str, rel_win: &str, bare: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let mut p = PathBuf::from(&root);
            if !subdir.is_empty() {
                p.push(subdir);
            }
            p.push(rel_win);
            if p.exists() {
                return p.display().to_string();
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (subdir, rel_win);
    }
    bare.to_string()
}

/// Tauri command: open a folder in the OS file manager. Surfaced to the
/// React UI via `window.__TAURI_INTERNALS__.invoke('open_path', ...)` and
/// wired to every path the dashboard shows (data dir, models dir, venv
/// dirs, individual model file parents). On Windows this is `explorer
/// /select,<path>` to highlight the file when given a file path, or just
/// `explorer <dir>` for a directory.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path not found: {path}"));
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe lives in the Windows dir (not System32); resolve it absolutely so a
        // planted explorer.exe on the CWD/PATH can't be launched instead.
        let explorer = resolved_system_exe("", "explorer.exe", "explorer");
        let result = if p.is_file() {
            // `/select,` and the path MUST be a single argv token, otherwise
            // Explorer treats them as two arguments and never highlights the
            // file. std quotes paths containing spaces, which Explorer accepts.
            std::process::Command::new(&explorer)
                .arg(format!("/select,{path}"))
                .spawn()
        } else {
            std::process::Command::new(&explorer).arg(&path).spawn()
        };
        result.map_err(|e| format!("explorer spawn failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let arg = if p.is_file() {
            vec!["-R".to_string(), path.clone()]
        } else {
            vec![path.clone()]
        };
        std::process::Command::new("open")
            .args(&arg)
            .spawn()
            .map_err(|e| format!("open spawn failed: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let target = if p.is_file() {
            p.parent().unwrap_or(&p).display().to_string()
        } else {
            path.clone()
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("xdg-open spawn failed: {e}"))?;
    }
    Ok(())
}

/// Open an external URL (e.g. https://formlogic.com) in the system default browser.
/// Unlike `open_path`, this does NOT existence-check — it hands the URL to the
/// OS handler. Guarded to http/https so the UI can't ask us to launch arbitrary
/// schemes. Invoked from the header's formlogic.com link.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = crate::external_url::validate_external_http_url(&url)?;
    #[cfg(target_os = "windows")]
    std::process::Command::new(resolved_system_exe("System32", "rundll32.exe", "rundll32"))
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn()
        .map_err(|e| format!("open url failed: {e}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(url.as_str())
        .spawn()
        .map_err(|e| format!("open url failed: {e}"))?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(url.as_str())
        .spawn()
        .map_err(|e| format!("open url failed: {e}"))?;
    Ok(())
}

// COMPANION_PORT is declared at the crate root (above mod gui) so the headless
// formlogic-server shares it; here it's in scope via `use super::COMPANION_PORT`.

/// The OS-default data dir (`%APPDATA%/<id>/` on Windows, etc.). This is
/// where everything lives unless the user has chosen a custom folder.
fn default_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("FormLogic"))
}

/// Path to the tiny bootstrap pointer file that records the user's chosen
/// data dir. It MUST live at a fixed OS location (the config dir), never
/// inside the data dir itself — otherwise we couldn't find it after the
/// user relocates their data folder.
fn config_pointer_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("companion-config.json"))
}

/// Process-wide lock serializing read-modify-write cycles on the pointer
/// file. Every mutating writer (`write_config_str`, `write_extra_model_dirs`,
/// `write_hf_token`) takes this guard BEFORE reading, so concurrent mutations
/// can't read a stale object and clobber each other's keys.
fn pointer_lock() -> &'static Mutex<()> {
    static POINTER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    POINTER_LOCK.get_or_init(|| Mutex::new(()))
}

/// Atomically replace `path`'s contents: write to a sibling `<path>.tmp` then
/// rename over the target (rename is atomic within a dir). Cleans up the temp
/// file on any error so we never leave a partial `.tmp` behind.
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = {
        let mut t = path.as_os_str().to_owned();
        t.push(".tmp");
        PathBuf::from(t)
    };
    if let Err(e) = std::fs::write(&tmp, contents) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write pointer: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write pointer: {e}"));
    }
    Ok(())
}

/// Read the whole pointer object (BOM-tolerant), or an empty map. The file
/// holds several keys now (`dataDir`, `modelsDir`), so every read/write goes
/// through this to avoid one key clobbering another.
fn read_config_obj(app: &tauri::AppHandle) -> serde_json::Map<String, serde_json::Value> {
    config_pointer_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.strip_prefix('\u{feff}').unwrap_or(&s).to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Read one non-empty string key from the pointer object, if present.
fn read_config_str(app: &tauri::AppHandle, key: &str) -> Option<String> {
    read_config_obj(app)
        .get(key)
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
}

/// Set (Some) or clear (None) one key, PRESERVING the other keys. Deletes
/// the file only when clearing the last key leaves it empty.
fn write_config_str(app: &tauri::AppHandle, key: &str, val: Option<&str>) -> Result<(), String> {
    let _guard = pointer_lock().lock().unwrap_or_else(|e| e.into_inner());
    let p = config_pointer_path(app).ok_or("cannot resolve config dir")?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir config dir: {e}"))?;
    }
    let mut obj = read_config_obj(app);
    match val {
        Some(v) if !v.trim().is_empty() => {
            obj.insert(key.to_string(), serde_json::Value::String(v.to_string()));
        }
        _ => {
            obj.remove(key);
        }
    }
    if obj.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    let body = serde_json::Value::Object(obj);
    let pretty = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    atomic_write(&p, &pretty)
}

// --- DESK-SECRET-001: the FormLogic API key lives in the OS credential store,
//     not the plaintext config. These wrappers migrate a legacy plaintext key
//     into the keyring on first read (verify-before-delete) and keep the
//     `has_key` presence check working. The value is never logged. ---

/// Read the FormLogic API key, preferring the OS credential store and
/// transparently migrating a legacy plaintext copy in `companion-config.json`
/// into the keyring on first read. On a keyring failure the plaintext copy is
/// kept and still used, so a link is never lost.
fn read_api_key(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(Some(v)) = crate::secrets::get(crate::secrets::API_KEY) {
        return Some(v);
    }
    // Legacy plaintext in the config file → migrate it out.
    let legacy = read_config_str(app, "formlogicApiKey")?;
    match crate::secrets::store_verified(crate::secrets::API_KEY, &legacy) {
        Ok(true) => {
            let _ = write_config_str(app, "formlogicApiKey", None);
            eprintln!("[formlogic] migrated the API key into the OS credential store");
        }
        Ok(false) => { /* no OS keyring here — keep the plaintext copy */ }
        Err(e) => eprintln!(
            "[formlogic] could not secure the API key in the credential store ({e}) — keeping the local copy"
        ),
    }
    Some(legacy)
}

/// Store (`Some`) or clear (`None`) the FormLogic API key. A stored key goes to
/// the credential store and its plaintext copy is removed; if the keyring is
/// unavailable/failing the key falls back to plaintext so linking still works.
fn write_api_key(app: &tauri::AppHandle, key: Option<&str>) -> Result<(), String> {
    match key {
        Some(k) if !k.trim().is_empty() => {
            let k = k.trim();
            match crate::secrets::store_verified(crate::secrets::API_KEY, k) {
                Ok(true) => {
                    let _ = write_config_str(app, "formlogicApiKey", None);
                    Ok(())
                }
                Ok(false) => write_config_str(app, "formlogicApiKey", Some(k)),
                Err(e) => {
                    eprintln!(
                        "[formlogic] credential store rejected the API key ({e}) — storing it locally"
                    );
                    write_config_str(app, "formlogicApiKey", Some(k))
                }
            }
        }
        _ => {
            // Clear both the keyring and any legacy plaintext (unlink / rotate).
            let _ = crate::secrets::delete(crate::secrets::API_KEY);
            write_config_str(app, "formlogicApiKey", None)
        }
    }
}

/// Whether a FormLogic API key is set (keyring OR legacy plaintext), without
/// materialising the value.
fn has_api_key(app: &tauri::AppHandle) -> bool {
    matches!(crate::secrets::get(crate::secrets::API_KEY), Ok(Some(_)))
        || read_config_str(app, "formlogicApiKey").is_some()
}

/// The user's chosen data dir from the pointer file, if any (else OS default).
fn read_data_dir_override(app: &tauri::AppHandle) -> Option<String> {
    read_config_str(app, "dataDir")
}

/// Write (Some) or clear (None) the data-dir override, keeping other keys.
fn write_data_dir_override(app: &tauri::AppHandle, dir: Option<&str>) -> Result<(), String> {
    write_config_str(app, "dataDir", dir)
}

/// The user's chosen models dir, if set. When unset, models live under
/// `<dataDir>/models` (the default). Kept separate from the data dir so a
/// user can park a big model library on another drive without relocating
/// venvs/templates (which can't move — absolute paths baked into venvs).
fn read_models_dir_override(app: &tauri::AppHandle) -> Option<String> {
    read_config_str(app, "modelsDir")
}

fn write_models_dir_override(app: &tauri::AppHandle, dir: Option<&str>) -> Result<(), String> {
    write_config_str(app, "modelsDir", dir)
}

/// The GGUF a single-model server (llama.cpp) should load, if the user picked
/// one in its Model selector. Unset ⇒ no model selected (no implicit default).
fn read_llama_model_override(app: &tauri::AppHandle) -> Option<String> {
    read_config_str(app, "llamaModel")
}

fn write_llama_model_override(app: &tauri::AppHandle, model: Option<&str>) -> Result<(), String> {
    write_config_str(app, "llamaModel", model)
}

fn read_llama_mmproj_override(app: &tauri::AppHandle) -> Option<String> {
    read_config_str(app, "llamaMmproj")
}

fn write_llama_mmproj_override(app: &tauri::AppHandle, path: Option<&str>) -> Result<(), String> {
    write_config_str(app, "llamaMmproj", path)
}

/// The model NAME a multi-model server (Ollama) should use, if the user picked
/// one in its Model selector. Unset ⇒ the pre-pulled default (qwen2.5:0.5b).
fn read_ollama_model_override(app: &tauri::AppHandle) -> Option<String> {
    read_config_str(app, "ollamaModel")
}

fn write_ollama_model_override(app: &tauri::AppHandle, model: Option<&str>) -> Result<(), String> {
    write_config_str(app, "ollamaModel", model)
}

/// Per-service GPU pins (serviceId → GPU index) the user set in the GPU picker, stored as a
/// JSON object under `serviceGpus`. Applied as CUDA_VISIBLE_DEVICES at start() so heavy
/// services don't all default to GPU 0 and exhaust its VRAM.
fn read_service_gpus(app: &tauri::AppHandle) -> std::collections::HashMap<String, u32> {
    read_config_str(app, "serviceGpus")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_service_gpus(
    app: &tauri::AppHandle,
    map: &std::collections::HashMap<String, u32>,
) -> Result<(), String> {
    if map.is_empty() {
        return write_config_str(app, "serviceGpus", None);
    }
    let s = serde_json::to_string(map).map_err(|e| format!("serialize serviceGpus: {e}"))?;
    write_config_str(app, "serviceGpus", Some(&s))
}

/// Additional model search roots beyond the primary models dir, stored as a
/// JSON array under `extraModelDirs`. These are read-only weight folders the
/// user registers in Settings (e.g. `E:\ckpts`) so a service can scan several
/// drives via `${modelDirs}` / `FORMLOGIC_MODEL_DIRS`. Empty when none configured.
fn read_extra_model_dirs(app: &tauri::AppHandle) -> Vec<String> {
    read_config_obj(app)
        .get("extraModelDirs")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Persist the additional model roots, PRESERVING other config keys. An empty
/// list removes the key (and the file if it was the last key).
fn write_extra_model_dirs(app: &tauri::AppHandle, dirs: &[String]) -> Result<(), String> {
    let _guard = pointer_lock().lock().unwrap_or_else(|e| e.into_inner());
    let p = config_pointer_path(app).ok_or("cannot resolve config dir")?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir config dir: {e}"))?;
    }
    let mut obj = read_config_obj(app);
    if dirs.is_empty() {
        obj.remove("extraModelDirs");
    } else {
        obj.insert(
            "extraModelDirs".to_string(),
            serde_json::Value::Array(
                dirs.iter()
                    .map(|s| serde_json::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    if obj.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    let body = serde_json::Value::Object(obj);
    let pretty = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    atomic_write(&p, &pretty)
}

/// Case-insensitive-on-Windows path key for de-duping model dirs (trailing
/// separators ignored). Mirrors `combine_model_dirs` in registry.rs.
fn model_dir_key(s: &str) -> String {
    let s = s.trim().trim_end_matches(['/', '\\']).to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Path to the HuggingFace token file. Lives in the FIXED config dir (not
/// the data dir) so it survives a data-folder move, alongside the data-dir
/// pointer. Plaintext, matching the HF CLI's own `~/.cache/huggingface/token`
/// convention for a local single-user tool.
fn hf_token_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("hf-token"))
}

/// Read the saved HuggingFace token, if any (trimmed; BOM-tolerant for
/// hand edits). None when unset/empty. DESK-SECRET-001: prefers the OS
/// credential store and migrates a legacy `hf-token` file into it on first
/// read (verify-before-delete).
fn read_hf_token(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(Some(v)) = crate::secrets::get(crate::secrets::HF_TOKEN) {
        return Some(v);
    }
    let p = hf_token_path(app)?;
    let s = std::fs::read_to_string(&p).ok()?;
    let s = s.strip_prefix('\u{feff}').unwrap_or(&s).trim();
    if s.is_empty() {
        return None;
    }
    let val = s.to_string();
    if let Ok(true) = crate::secrets::store_verified(crate::secrets::HF_TOKEN, &val) {
        let _ = std::fs::remove_file(&p);
        eprintln!("[formlogic] migrated the HuggingFace token into the OS credential store");
    }
    Some(val)
}

/// Persist (Some) or clear (None/empty) the HuggingFace token. DESK-SECRET-001:
/// stored in the OS credential store when available (plaintext copy removed);
/// falls back to the legacy file only when the keyring is unavailable/failing.
fn write_hf_token(app: &tauri::AppHandle, token: Option<&str>) -> Result<(), String> {
    let _guard = pointer_lock().lock().unwrap_or_else(|e| e.into_inner());
    let p = hf_token_path(app).ok_or("cannot resolve config dir")?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir config dir: {e}"))?;
    }
    match token {
        Some(t) if !t.trim().is_empty() => {
            let t = t.trim();
            match crate::secrets::store_verified(crate::secrets::HF_TOKEN, t) {
                Ok(true) => {
                    let _ = std::fs::remove_file(&p);
                    Ok(())
                }
                Ok(false) => atomic_write(&p, t),
                Err(e) => {
                    eprintln!(
                        "[formlogic] credential store rejected the HuggingFace token ({e}) — storing it locally"
                    );
                    atomic_write(&p, t)
                }
            }
        }
        _ => {
            let _ = crate::secrets::delete(crate::secrets::HF_TOKEN);
            let _ = std::fs::remove_file(&p);
            Ok(())
        }
    }
}

/// Resolve the active per-user data directory. Honours a user-chosen
/// folder from the pointer file (falling back to the OS default if that
/// folder can't be created), so models/venvs/services live wherever the
/// user wants them — somewhere easy to browse, not buried in AppData.
fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(custom) = read_data_dir_override(app) {
        let p = PathBuf::from(&custom);
        if std::fs::create_dir_all(&p).is_ok() {
            return p;
        }
        log::warn!(
            "configured data dir {custom} is unusable; falling back to the default"
        );
    }
    default_data_dir(app)
}

/// Resolve the active models directory: the user's `modelsDir` override
/// (when set + creatable) else `<dataDir>/models`. This is where downloads
/// land and where the install scripts' `FORMLOGIC_MODELS_DIR` points.
fn resolve_models_dir(app: &tauri::AppHandle, data_dir: &std::path::Path) -> PathBuf {
    if let Some(custom) = read_models_dir_override(app) {
        let p = PathBuf::from(&custom);
        if std::fs::create_dir_all(&p).is_ok() {
            return p;
        }
        log::warn!("configured models dir {custom} is unusable; falling back to <dataDir>/models");
    }
    data_dir.join("models")
}

// `CompanionConfig` lives in `http.rs`; it's imported at the top of `mod gui`.
// The GUI builds it from AppHandle paths via `config_snapshot` +
// `TauriConfigProvider` below.

/// Build the config snapshot from AppHandle paths. Used by the Tauri command +
/// the GUI's `ConfigProvider`.
pub(crate) fn config_snapshot(app: &tauri::AppHandle, registry: &RegistryHandle) -> CompanionConfig {
    // One lock: pull both the active data dir and the active models dir.
    let (active_dir, models_active_dir) = registry
        .lock()
        .ok()
        .map(|r| {
            (
                r.data_dir().display().to_string(),
                r.models_dir().display().to_string(),
            )
        })
        .unwrap_or_default();
    let default_dir = default_data_dir(app).display().to_string();
    let configured_dir = read_data_dir_override(app);
    let effective = configured_dir.clone().unwrap_or_else(|| default_dir.clone());
    // Normalise trailing separators for the comparison so e.g.
    // "D:\FormLogic" and "D:\FormLogic\" don't read as a pending change.
    let norm = |s: &str| s.trim_end_matches(['/', '\\']).to_lowercase();

    // Models dir: default is <pending data dir>/models, so the "pending"
    // readout reflects where models will live after a restart that also
    // changes the data dir.
    let models_default_dir = pending_data_dir(app).join("models").display().to_string();
    let models_configured_dir = read_models_dir_override(app);
    let models_effective = models_configured_dir
        .clone()
        .unwrap_or_else(|| models_default_dir.clone());

    CompanionConfig {
        restart_required: norm(&effective) != norm(&active_dir),
        is_custom: configured_dir.is_some(),
        active_dir,
        default_dir,
        configured_dir,
        models_restart_required: norm(&models_effective) != norm(&models_active_dir),
        models_is_custom: models_configured_dir.is_some(),
        models_active_dir,
        models_default_dir,
        models_configured_dir,
        llama_model: read_llama_model_override(app),
        llama_mmproj: read_llama_mmproj_override(app),
        ollama_model: read_ollama_model_override(app),
    }
}

/// AppHandle-backed [`http::ConfigProvider`] for the GUI build — feeds the
/// HTTP `GET /api/config` handler the same snapshot the Tauri command returns.
struct TauriConfigProvider {
    app: tauri::AppHandle,
}

impl http::ConfigProvider for TauriConfigProvider {
    fn snapshot(&self, registry: &RegistryHandle) -> CompanionConfig {
        config_snapshot(&self.app, registry)
    }
}

/// Tauri command: current data-dir configuration for the Settings panel.
#[tauri::command]
fn get_config(app: tauri::AppHandle, registry: tauri::State<RegistryHandle>) -> CompanionConfig {
    config_snapshot(&app, &registry)
}

/// Reject a user-supplied directory that isn't a plain local absolute path BEFORE we touch it.
/// A UNC share (`\\server\share`) or device/verbatim namespace (`\\?\`, `\\.\`) would (a) trigger
/// an outbound SMB connection on the create_dir_all / write-probe / is_dir stat below — leaking the
/// user's NTLM hash and hanging for the SMB timeout — and (b) become a copy-then-delete migration
/// DESTINATION pointing at a network share. Mirrors the guards already on delete_model /
/// run_command_exists. Cross-drive local roots (`D:\`, `E:\ckpts`) stay allowed.
fn validate_local_dir_path(path: &str) -> Result<(), String> {
    use std::path::{Component, Prefix};
    let mut comps = Path::new(path).components();
    match comps.next() {
        // Windows drive path (C:\, D:\) or its extended-length form (\\?\C:\) — both LOCAL. Reject
        // UNC / device / non-disk verbatim prefixes. Require a following RootDir so a drive-RELATIVE
        // path (C:foo, resolved against the process CWD) is refused too.
        Some(Component::Prefix(pre)) => {
            if !matches!(pre.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
                return Err("network or device paths (UNC \\\\server\\share, \\\\?\\, \\\\.\\) aren't allowed — choose a local folder".into());
            }
            if matches!(comps.next(), Some(Component::RootDir)) {
                Ok(())
            } else {
                Err("please choose an absolute folder (e.g. C:\\models), not a drive-relative path".into())
            }
        }
        // POSIX absolute path (/…).
        Some(Component::RootDir) => Ok(()),
        // Relative / empty — refuse rather than persist an ambiguous root.
        _ => Err("please choose an absolute local folder".into()),
    }
}

/// Tauri command: set (or, with an empty string, reset) the data dir.
/// Validates that the folder is creatable + writable before persisting
/// the pointer. Takes effect on the next launch (the UI prompts to
/// restart) — we deliberately don't hot-swap the live registry / in-
/// flight downloads / running service env, which would be error-prone.
#[tauri::command]
fn set_data_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return write_data_dir_override(&app, None);
    }
    validate_local_dir_path(trimmed)?;
    let p = PathBuf::from(trimmed);
    std::fs::create_dir_all(&p).map_err(|e| format!("can't create that folder: {e}"))?;
    // Writability probe — a read-only or permission-denied folder is a
    // common foot-gun; catch it now rather than on first download.
    let probe = p.join(".formlogic-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("that folder isn't writable: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    write_data_dir_override(&app, Some(trimmed))
}

/// Tauri command: set (or, with an empty string, reset to `<dataDir>/models`)
/// the models dir. Same creatable+writable validation as the data dir.
/// Applies on next launch (Downloads + the install scripts' FORMLOGIC_MODELS_DIR
/// capture it at startup); the UI prompts to restart.
#[tauri::command]
fn set_models_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return write_models_dir_override(&app, None);
    }
    validate_local_dir_path(trimmed)?;
    let p = PathBuf::from(trimmed);
    std::fs::create_dir_all(&p).map_err(|e| format!("can't create that folder: {e}"))?;
    let probe = p.join(".formlogic-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("that folder isn't writable: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    write_models_dir_override(&app, Some(trimmed))
}

/// Push the extra dirs into the LIVE registry and return the registry-
/// normalized view (`extra_model_dirs()` — deduped, primary stripped) — the
/// exact list `list_model_dirs` reports. Add/remove return this so their reply
/// can't diverge from a subsequent refresh (no "shows then vanishes" entry).
/// Falls back to the raw list only if the registry lock is poisoned.
fn apply_and_list_extra_dirs(registry: &RegistryHandle, dirs: Vec<String>) -> Vec<String> {
    match registry.lock() {
        Ok(mut r) => {
            r.set_extra_model_dirs(dirs.iter().map(PathBuf::from).collect());
            r.extra_model_dirs()
        }
        Err(_) => dirs,
    }
}

/// Tauri command: the additional model folders the user registered (beyond
/// the primary models dir). Read live from the registry so it reflects any
/// add/remove done this session without a restart.
#[tauri::command]
fn list_model_dirs(registry: tauri::State<RegistryHandle>) -> Vec<String> {
    registry
        .lock()
        .map(|r| r.extra_model_dirs())
        .unwrap_or_default()
}

/// Tauri command: register an additional (read-only) model folder. Validates
/// it exists, persists it, and updates the LIVE registry so the next service
/// start sees it via `${modelDirs}` / `FORMLOGIC_MODEL_DIRS` — no restart needed.
/// Returns the updated extra-dirs list. A folder that's already registered (or
/// is the primary) is a no-op / error respectively.
#[tauri::command]
fn add_model_dir(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    path: String,
) -> Result<Vec<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    validate_local_dir_path(trimmed)?;
    if !PathBuf::from(trimmed).is_dir() {
        return Err(format!("not a folder: {trimmed}"));
    }
    let target = model_dir_key(trimmed);
    // Don't shadow the primary models dir.
    let primary_key = registry
        .lock()
        .ok()
        .map(|r| model_dir_key(&r.models_dir().display().to_string()));
    if primary_key.as_deref() == Some(target.as_str()) {
        return Err("that's already the primary models folder".into());
    }
    let mut dirs = read_extra_model_dirs(&app);
    // Persist only when it's genuinely new; either way return the normalized view.
    if !dirs.iter().any(|d| model_dir_key(d) == target) {
        dirs.push(trimmed.to_string());
        write_extra_model_dirs(&app, &dirs)?;
    }
    Ok(apply_and_list_extra_dirs(&registry, dirs))
}

/// Tauri command: remove a previously-registered model folder. Persists +
/// updates the live registry. Returns the updated list.
#[tauri::command]
fn remove_model_dir(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    path: String,
) -> Result<Vec<String>, String> {
    let target = model_dir_key(&path);
    let mut dirs = read_extra_model_dirs(&app);
    dirs.retain(|d| model_dir_key(d) != target);
    write_extra_model_dirs(&app, &dirs)?;
    Ok(apply_and_list_extra_dirs(&registry, dirs))
}

/// Tauri command: the loadable GGUFs found across the model search roots —
/// the options for the llama.cpp Model picker.
#[tauri::command]
fn list_gguf_models(registry: tauri::State<RegistryHandle>) -> Vec<String> {
    registry
        .lock()
        .map(|r| r.list_gguf_models())
        .unwrap_or_default()
}

/// Tauri command: set (or clear, with '') the GGUF a single-model server
/// (llama.cpp) loads. Validates the file exists, persists it, and updates the
/// LIVE registry so the next start loads it via `${llamaModel}` — no restart.
#[tauri::command]
fn set_llama_model(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    path: String,
) -> Result<(), String> {
    let trimmed = path.trim();
    let value = if trimmed.is_empty() { None } else { Some(trimmed) };
    if let Some(v) = value {
        if !PathBuf::from(v).is_file() {
            return Err(format!("not a file: {v}"));
        }
    }
    write_llama_model_override(&app, value)?;
    if let Ok(mut r) = registry.lock() {
        r.set_llama_model(value.map(str::to_string));
    }
    Ok(())
}

/// Set (or clear with "") the optional mmproj projector for the llama service —
/// required for audio/vision content parts (Gemma 4 E2B class GGUFs).
#[tauri::command]
fn set_llama_mmproj(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    path: String,
) -> Result<(), String> {
    let trimmed = path.trim();
    let value = if trimmed.is_empty() { None } else { Some(trimmed) };
    if let Some(v) = value {
        if !PathBuf::from(v).is_file() {
            return Err(format!("not a file: {v}"));
        }
    }
    write_llama_mmproj_override(&app, value)?;
    if let Ok(mut r) = registry.lock() {
        r.set_llama_mmproj(value.map(str::to_string));
    }
    Ok(())
}

/// Tauri command: set (or clear, with '') the Ollama model NAME a node uses.
/// Persists it + updates the LIVE registry so the next /api/services snapshot
/// resolves `${ollamaModel}` in the node body — no restart.
#[tauri::command]
fn set_ollama_model(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    model: String,
) -> Result<(), String> {
    let trimmed = model.trim();
    let value = if trimmed.is_empty() { None } else { Some(trimmed) };
    write_ollama_model_override(&app, value)?;
    if let Ok(mut r) = registry.lock() {
        r.set_ollama_model(value.map(str::to_string));
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct GpuInfo {
    index: u32,
    name: String,
}

/// Tauri command: the CUDA GPUs present (index + name), via nvidia-smi. Empty on a box
/// without an NVIDIA GPU / nvidia-smi — the GPU picker then hides itself.
#[tauri::command]
fn list_gpus() -> Vec<GpuInfo> {
    let out = match std::process::Command::new(resolved_system_exe(
        "System32",
        "nvidia-smi.exe",
        "nvidia-smi",
    ))
    .args(["--query-gpu=index,name", "--format=csv,noheader,nounits"])
    .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, ',');
            let index = parts.next()?.trim().parse::<u32>().ok()?;
            let name = parts.next()?.trim().to_string();
            Some(GpuInfo { index, name })
        })
        .collect()
}

/// Tauri command: pin a service to a GPU index (CUDA_VISIBLE_DEVICES), or clear with a null
/// `gpu`. Persists to config + applies to the live registry; takes effect on the next start.
#[tauri::command]
fn set_service_gpu(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    id: String,
    gpu: Option<u32>,
) -> Result<(), String> {
    let mut map = read_service_gpus(&app);
    match gpu {
        Some(n) => {
            map.insert(id.clone(), n);
        }
        None => {
            map.remove(&id);
        }
    }
    write_service_gpus(&app, &map)?;
    if let Ok(mut r) = registry.lock() {
        r.set_service_gpu(&id, gpu);
    }
    Ok(())
}

/// Tauri command: the models pulled into the running Ollama server (its
/// `/api/tags`) — the options for the Ollama Model picker. Empty + an error
/// when Ollama isn't running.
#[tauri::command]
async fn list_ollama_models(
    registry: tauri::State<'_, RegistryHandle>,
) -> Result<Vec<String>, String> {
    let port = registry
        .lock()
        .ok()
        .and_then(|r| r.service_port("ollama"))
        .unwrap_or(11434);
    let url = format!("http://127.0.0.1:{port}/api/tags");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "Ollama isn't reachable — start it first, then refresh.".to_string())?;
    // `.text()` + serde_json avoids needing reqwest's `json` feature.
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut models: Vec<String> = match body["models"].as_array() {
        Some(arr) => arr
            .iter()
            .filter_map(|m| m["name"].as_str().map(String::from))
            .collect(),
        None => Vec::new(),
    };
    models.sort();
    Ok(models)
}

/// Tauri command: open a native folder picker, returning the chosen path
/// (or None if cancelled). Non-blocking via a oneshot so we never stall
/// the UI thread.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked.and_then(|fp| fp.as_path().map(|p| p.display().to_string())))
}

/// Tauri command: relaunch the app so a new data/models dir takes effect.
///
/// A packaged build relaunches its own binary and reloads the bundled frontend
/// from disk — clean. Under `tauri dev`, though, `app.restart()` relaunches the
/// binary but the Vite dev server is owned by the `tauri dev` supervisor and is
/// torn down with the old process, so the new window loads a dead
/// `http://localhost:1420` ("Hmmm… can't reach this page"). So in a debug build
/// we DON'T relaunch — we leave the working window in place and tell the user to
/// re-run the dev command to apply the change.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    #[cfg(debug_assertions)]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Restart needed to apply the change")
            .body(
                "Running under `tauri dev`, so the app can't relaunch itself here \
                 (it would lose the Vite dev server and show \"can't reach this page\"). \
                 Stop and re-run `npm run tauri:dev` to apply. The packaged app restarts \
                 on its own.",
            )
            .show();
    }
    #[cfg(not(debug_assertions))]
    {
        app.restart();
    }
}

/// The data dir the *next* launch will use — the configured override, or
/// the OS default when none/reset. Mirrors `config_snapshot`'s `effective`.
fn pending_data_dir(app: &tauri::AppHandle) -> PathBuf {
    read_data_dir_override(app)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_data_dir(app))
}

/// Tauri command: what a data-folder migration would move (old → pending).
#[tauri::command]
fn migration_plan(app: tauri::AppHandle, registry: tauri::State<RegistryHandle>) -> MigratePlan {
    let old = match registry.lock().ok().map(|r| r.data_dir().to_path_buf()) {
        Some(o) => o,
        None => return MigratePlan::default(),
    };
    migrate::plan(&old, &pending_data_dir(&app))
}

/// Tauri command: start copying/moving the user's data to the pending
/// folder on a background thread. The UI polls `migration_status`.
#[tauri::command]
fn start_migration(
    app: tauri::AppHandle,
    registry: tauri::State<RegistryHandle>,
    migration: tauri::State<MigrationHandle>,
    mode: String,
) -> Result<(), String> {
    let mode = migrate::Mode::parse(&mode).ok_or("mode must be 'copy' or 'move'")?;
    let old = registry
        .lock()
        .map_err(|_| "registry is busy")?
        .data_dir()
        .to_path_buf();
    let new = pending_data_dir(&app);
    // Belt-and-suspenders: reject a network/device destination before any copy+delete, in case a
    // UNC override was persisted before set_data_dir validated it.
    validate_local_dir_path(&new.to_string_lossy())?;
    if !migrate::plan(&old, &new).can_migrate {
        return Err("nothing to migrate — no pending folder change, or the old folder is empty".into());
    }
    {
        let g = migration.lock().map_err(|_| "migration state is busy")?;
        if g.running {
            return Err("a migration is already running".into());
        }
    }
    let handle: MigrationHandle = (*migration).clone();
    std::thread::spawn(move || migrate::run(old, new, mode, handle));
    Ok(())
}

/// Tauri command: current migration progress (polled by the UI).
#[tauri::command]
fn migration_status(migration: tauri::State<MigrationHandle>) -> MigrationProgress {
    migration.lock().map(|g| g.clone()).unwrap_or_default()
}

/// Tauri command: whether a HuggingFace token is currently set. We never
/// hand the token itself back to the UI — only its presence.
#[tauri::command]
fn get_hf_token_status(downloads: tauri::State<DownloadsHandle>) -> bool {
    downloads.has_token()
}

/// Tauri command: set (or clear, with an empty string) the HuggingFace
/// token. Persists it AND updates the live downloader so the next gated
/// download picks it up without a restart.
#[tauri::command]
fn set_hf_token(
    app: tauri::AppHandle,
    downloads: tauri::State<DownloadsHandle>,
    token: String,
) -> Result<(), String> {
    let trimmed = token.trim();
    let value = if trimmed.is_empty() { None } else { Some(trimmed) };
    write_hf_token(&app, value)?;
    downloads.set_token(value.map(str::to_string));
    Ok(())
}

/// The FormLogic Cloud config the Settings panel shows. The API key itself is
/// NEVER handed back to the UI — only whether one is set.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FormLogicConfigView {
    base_url: String,
    has_key: bool,
    linked: bool,
    /// The device label the OAuth link recorded (`FormLogic Desktop on <host>`),
    /// when the key was obtained via the account-link flow. None for a manually
    /// pasted key.
    device_name: Option<String>,
    /// Public database id of this OAuth-managed Desktop connection. Used only
    /// to bind Companion pairing proofs; it is not a credential.
    connection_id: Option<String>,
}

/// Tauri command: current FormLogic Cloud link config (base URL + whether a key
/// is set + whether the runtime is linked + the linked device label).
#[tauri::command]
fn get_formlogic_config(
    app: tauri::AppHandle,
    runtime: tauri::State<Arc<FlowRuntime>>,
) -> FormLogicConfigView {
    FormLogicConfigView {
        base_url: read_config_str(&app, "formlogicBaseUrl").unwrap_or_default(),
        has_key: has_api_key(&app),
        linked: runtime.status().linked,
        device_name: read_config_str(&app, "formlogicDeviceName"),
        connection_id: read_config_str(&app, "formlogicConnectionId"),
    }
}

/// This machine's name, used as the `?device=` label the minted key is named
/// for. Mirrors `FlowRuntime`'s device-name resolution.
fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "FormLogic Desktop".to_string())
}

/// Tauri command: save the FormLogic Cloud link. An empty `base_url` clears it;
/// an empty `api_key` LEAVES the existing key unchanged (so the user needn't
/// re-enter it to edit the URL). Persists to the fixed config dir + reconfigures
/// the live runtime so the change takes effect without a restart.
#[tauri::command]
fn set_formlogic_config(
    app: tauri::AppHandle,
    runtime: tauri::State<Arc<FlowRuntime>>,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    let base = base_url.trim();
    write_config_str(&app, "formlogicBaseUrl", if base.is_empty() { None } else { Some(base) })?;
    let key = api_key.trim();
    if !key.is_empty() {
        write_api_key(&app, Some(key))?;
    }
    runtime.reconfigure(FormLogicConfig {
        base_url: read_config_str(&app, "formlogicBaseUrl").unwrap_or_default(),
        api_key: read_api_key(&app).unwrap_or_default(),
    });
    Ok(())
}

/// Tauri command: clear the FormLogic Cloud link (Unlink). Best-effort DELETEs
/// the desktop-connection first (which cascades to revoke the tied key
/// server-side) using the current key, then clears the local config + device
/// label + connection id and stops the runtime. The remote delete failing is
/// non-fatal — the user can always revoke from Settings → API keys.
#[tauri::command]
async fn disconnect_formlogic(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Arc<FlowRuntime>>,
) -> Result<(), String> {
    // Only OAuth-linked installs carry a connection id; a hand-entered key isn't a managed
    // connection, so we don't ask the server to revoke it (it may be used elsewhere).
    if read_config_str(&app, "formlogicConnectionId").is_some() {
        if let Some(client) = FormLogicClient::new(&runtime.config()) {
            let _ = client.delete_desktop_connection().await;
        }
    }
    write_config_str(&app, "formlogicBaseUrl", None)?;
    write_api_key(&app, None)?;
    let _ = write_config_str(&app, "formlogicConnectionId", None);
    let _ = write_config_str(&app, "formlogicDeviceName", None);
    runtime.reconfigure(FormLogicConfig { base_url: String::new(), api_key: String::new() });
    Ok(())
}

/// Tauri command: "Test connection" — a cheap authenticated probe.
#[tauri::command]
async fn test_formlogic_connection(
    runtime: tauri::State<'_, Arc<FlowRuntime>>,
) -> Result<(), String> {
    runtime.test_connection().await
}

/// Tauri command: live flow-runtime status (linked, last poll, counts) for the
/// Settings panel + the window badge.
#[tauri::command]
fn formlogic_status(runtime: tauri::State<Arc<FlowRuntime>>) -> FlowRuntimeStatus {
    runtime.status()
}

// ── OAuth account link (device-link, docs/MCP.md §device-link) ────────────────

/// Tauri command: start the OAuth "Link FormLogic account" flow. Binds a
/// loopback callback, opens the system browser to the consent page, and (in a
/// background task) exchanges the returned code for the scoped `flk_` key,
/// storing it exactly as a manual key. Returns immediately; the UI polls
/// `formlogic_oauth_status`. `base_url` empty ⇒ reuse the saved/typed base.
#[tauri::command]
fn formlogic_oauth_start(
    app: tauri::AppHandle,
    runtime: tauri::State<Arc<FlowRuntime>>,
    link: tauri::State<Arc<OAuthLink>>,
    base_url: String,
) -> Result<(), String> {
    let mut base = formlogic_client::normalize_base(&base_url);
    if base.is_empty() {
        base = read_config_str(&app, "formlogicBaseUrl")
            .map(|s| formlogic_client::normalize_base(&s))
            .unwrap_or_default();
    }
    if base.is_empty() {
        return Err("Enter your FormLogic base URL first (e.g. https://formlogic.com).".into());
    }
    if !link.begin() {
        return Err("A link attempt is already in progress.".into());
    }
    let link = link.inner().clone();
    let runtime = runtime.inner().clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_oauth_link(app_handle, runtime, link.clone(), base).await;
        link.finish();
    });
    Ok(())
}

/// Tauri command: cancel an in-progress link attempt (the loopback wait aborts).
#[tauri::command]
fn formlogic_oauth_cancel(link: tauri::State<Arc<OAuthLink>>) {
    link.request_cancel();
}

/// Tauri command: current OAuth link phase/message (polled by the UI).
#[tauri::command]
fn formlogic_oauth_status(link: tauri::State<Arc<OAuthLink>>) -> OAuthLinkStatus {
    link.status()
}

/// The background OAuth link task: loopback → browser → callback → token
/// exchange → persist + reconfigure. Every failure path sets an Error/Cancelled
/// phase; it never panics.
async fn run_oauth_link(
    app: tauri::AppHandle,
    runtime: Arc<FlowRuntime>,
    link: Arc<OAuthLink>,
    base: String,
) {
    use oauth::{LinkPhase, LoopbackError};

    link.set(LinkPhase::Starting, Some("Starting the secure link…".into()));
    let loopback = match oauth::Loopback::bind().await {
        Ok(l) => l,
        Err(e) => {
            link.set(LinkPhase::Error, Some(format!("Could not start the local listener: {e}")));
            return;
        }
    };
    let redirect = loopback.redirect_uri();
    let pkce = oauth::generate_pkce();
    let state = oauth::generate_state();
    let device = hostname();
    let url = match oauth::build_authorize_url(
        &base,
        &redirect,
        oauth::DESKTOP_SCOPES,
        &pkce.challenge,
        &state,
        &device,
    ) {
        Ok(u) => u,
        Err(e) => {
            link.set(LinkPhase::Error, Some(format!("Could not build the sign-in URL: {e}")));
            return;
        }
    };
    if let Err(e) = open_url(url) {
        link.set(LinkPhase::Error, Some(format!("Could not open your browser: {e}")));
        return;
    }
    link.set(
        LinkPhase::AwaitingBrowser,
        Some("Waiting for you to approve access in your browser…".into()),
    );

    let deadline = std::time::Instant::now() + oauth::DEFAULT_LINK_TIMEOUT;
    let params = match loopback.accept_callback(link.cancel_flag(), deadline).await {
        Ok(p) => p,
        Err(LoopbackError::Cancelled) => {
            link.set(LinkPhase::Cancelled, Some("Linking cancelled.".into()));
            return;
        }
        Err(e) => {
            link.set(LinkPhase::Error, Some(e.to_string()));
            return;
        }
    };
    if let Some(err) = &params.error {
        let msg = params.error_description.clone().unwrap_or_else(|| err.clone());
        link.set(LinkPhase::Error, Some(format!("Authorization was denied: {msg}")));
        return;
    }
    // Bind the response to our request (anti-CSRF, RFC 6749 §10.12).
    if params.state.as_deref() != Some(state.as_str()) {
        link.set(LinkPhase::Error, Some("Security check failed (state mismatch). Please try again.".into()));
        return;
    }
    let code = match &params.code {
        Some(c) => c.clone(),
        None => {
            link.set(LinkPhase::Error, Some("No authorization code was returned.".into()));
            return;
        }
    };

    link.set(LinkPhase::Exchanging, Some("Finishing sign-in…".into()));
    let token = match formlogic_client::exchange_oauth_code(&base, &redirect, &code, &pkce.verifier).await {
        Ok(t) => t,
        Err(e) => {
            link.set(LinkPhase::Error, Some(format!("Could not complete linking: {e}")));
            return;
        }
    };

    // Persist the minted key exactly as a manual key + the link metadata.
    if let Err(e) = write_config_str(&app, "formlogicBaseUrl", Some(&base)) {
        link.set(LinkPhase::Error, Some(format!("Could not save the link: {e}")));
        return;
    }
    if let Err(e) = write_api_key(&app, Some(&token.api_key)) {
        link.set(LinkPhase::Error, Some(format!("Could not save the key: {e}")));
        return;
    }
    let _ = write_config_str(&app, "formlogicConnectionId", token.desktop_connection_id.as_deref());
    let _ = write_config_str(&app, "formlogicDeviceName", token.device_name.as_deref());
    runtime.reconfigure(FormLogicConfig {
        base_url: base,
        api_key: token.api_key,
    });
    // The token response names the OAuth placeholder row. Immediately heartbeat
    // with this install's stable instance id so the backend can reattach the key
    // to its durable row; the native observer persists the canonical id it
    // returns. A transient/older-backend failure remains non-fatal and the
    // regular heartbeat loop retries reconciliation later.
    if let Err(error) = runtime.sync_desktop_connection().await {
        eprintln!("[formlogic] post-link Desktop id reconciliation deferred: {error}");
    }
    link.set_linked(token.device_name);
}

pub fn run() {
    // Capture and scrub the optional Companion bearer before any managed
    // service/plugin can inherit this process's environment.
    crate::aokie_companion_publisher::capture_env();
    // DESK-PROC-001: put the desktop (and, by inheritance, every service /
    // plugin / model process it spawns) in a kill-on-close Job Object BEFORE
    // anything is spawned, so the whole tree dies with the desktop.
    if let Err(e) = crate::proc::install_kill_on_close_group() {
        log::warn!("could not install the kill-on-close process group: {e}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .invoke_handler(tauri::generate_handler![
            open_path,
            open_url,
            get_config,
            set_data_dir,
            set_models_dir,
            pick_folder,
            restart_app,
            migration_plan,
            start_migration,
            migration_status,
            get_hf_token_status,
            set_hf_token,
            list_model_dirs,
            add_model_dir,
            remove_model_dir,
            list_gguf_models,
            set_llama_model,
            set_llama_mmproj,
            set_ollama_model,
            list_gpus,
            set_service_gpu,
            list_ollama_models,
            get_formlogic_config,
            set_formlogic_config,
            disconnect_formlogic,
            test_formlogic_connection,
            formlogic_status,
            formlogic_oauth_start,
            formlogic_oauth_cancel,
            formlogic_oauth_status
        ])
        .setup(|app| {
            // Build the registry once, share it with both the HTTP server
            // and Tauri-managed state. Failures here are non-fatal — we
            // fall back to an empty registry so the tray still works and
            // the user sees a clear error in the LogsViewer.
            let data_dir = resolve_data_dir(app.handle());
            // Models live under a separately-configurable dir (the user can
            // park a big library on another drive); defaults to <dataDir>/models.
            let models_dir = resolve_models_dir(app.handle(), &data_dir);
            // Additional read-only weight folders the user registered (e.g.
            // E:\ckpts) — joined with the primary into the ${modelDirs} search
            // list so a service can scan several drives.
            let extra_model_dirs: Vec<PathBuf> = read_extra_model_dirs(app.handle())
                .into_iter()
                .map(PathBuf::from)
                .collect();
            let registry: RegistryHandle =
                match Registry::init(data_dir.clone(), models_dir.clone(), extra_model_dirs) {
                    Ok(r) => Arc::new(Mutex::new(r)),
                    Err(e) => {
                        log::error!("registry init failed at {}: {e}", data_dir.display());
                        // Empty placeholder; the UI surfaces "no templates" cleanly.
                        let fallback = std::env::temp_dir().join("formlogic-desktop-fallback");
                        let fb_models = fallback.join("models");
                        // Even the temp-dir fallback does filesystem work and can
                        // fail (read-only/full temp). Don't panic — degrade to a
                        // truly in-memory empty registry so the tray/UI still runs.
                        let reg = Registry::init(fallback.clone(), fb_models.clone(), Vec::new())
                            .unwrap_or_else(|e2| {
                                log::error!(
                                    "temp-dir fallback registry init also failed: {e2}; running with an empty in-memory registry"
                                );
                                Registry::empty(fallback, fb_models)
                            });
                        Arc::new(Mutex::new(reg))
                    }
                };
            // Apply the saved llama.cpp model selection (if any) to the live
            // registry so the next flow-triggered start loads it — no restart.
            if let Ok(mut r) = registry.lock() {
                r.set_llama_model(read_llama_model_override(app.handle()));
                r.set_llama_mmproj(read_llama_mmproj_override(app.handle()));
                r.set_ollama_model(read_ollama_model_override(app.handle()));
                // Drop GPU pins to cards that no longer exist (removed / re-imaged box) —
                // otherwise start() would export CUDA_VISIBLE_DEVICES at a missing index and
                // CUDA would see ZERO devices (silent CPU fallback / hard crash). Only prune
                // when enumeration actually succeeds, so a transient nvidia-smi hiccup can't
                // wipe valid pins.
                let mut gpus = read_service_gpus(app.handle());
                let available = list_gpus();
                if !available.is_empty() {
                    let valid: std::collections::HashSet<u32> =
                        available.iter().map(|g| g.index).collect();
                    let before = gpus.len();
                    gpus.retain(|_, idx| valid.contains(idx));
                    if gpus.len() != before {
                        log::warn!(
                            "dropped {} GPU pin(s) for device(s) no longer present",
                            before - gpus.len()
                        );
                        let _ = write_service_gpus(app.handle(), &gpus);
                    }
                }
                r.set_service_gpus(gpus);
                // Backfill install-completion markers for venv services installed before the
                // marker existed, so they don't suddenly read as not-installed.
                r.backfill_install_markers();
                // DESK-PROC-001: restore the services that were running when the
                // desktop last exited (model selection + GPU pins are applied
                // above, so they spawn with the right env). With the kill-on-
                // close job reaping children on ANY desktop exit, this is what
                // brings llama-cpp / aokie-voice back without manual Start.
                let restored = r.autostart_remembered();
                if !restored.is_empty() {
                    log::info!("restored {} service(s) from the previous session: {}",
                        restored.len(), restored.join(", "));
                }
            }
            // Build Downloads + Python + Catalog helpers from the
            // registry's data dir so all four share `${dataDir}`
            // consistently. All are Tauri-managed so any future Tauri
            // command can reach them alongside the HTTP layer.
            let downloads: DownloadsHandle = Downloads::new(models_dir.clone()).into_handle();
            // Load the saved HuggingFace token (if any) so gated downloads
            // work from the first launch without re-entering it.
            downloads.set_token(read_hf_token(app.handle()));
            let python: PythonHandle = Python::new(data_dir.clone()).into_handle();
            let catalog = CatalogHandle::new(data_dir.clone());

            // FormLogic Desktop plugin host: scans <dataDir>/plugins/ and
            // supervises plugin processes. Dev mode (debug build or
            // FORMLOGIC_DEV_MODE=1) is forwarded to plugins as
            // FORMLOGIC_DEV_MODE=1.
            let dev_mode = cfg!(debug_assertions)
                || std::env::var("FORMLOGIC_DEV_MODE").is_ok_and(|v| v == "1");
            let plugin_host: PluginHostHandle =
                PluginHost::new(&data_dir, dev_mode, EventBus::new());
            // Pairing tokens live in the FIXED config dir (like the data-dir
            // pointer) so they survive a data-folder move.
            let pairing_path = app
                .handle()
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("FormLogic"))
                .join("pairing.json");
            let pairing: PairingHandle = PairingStore::new(
                pairing_path,
                std::env::var("FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN").ok(),
            );

            // FormLogic Cloud link + headless flow runtime. Config (base URL +
            // API key) lives in the FIXED config dir (companion-config.json) so it
            // survives a data-folder move, like the pairing store. With both set,
            // FormLogic Desktop becomes the HEADLESS runtime for flows + the Aokie
            // receptionist (event + claim loops); the web app only views state.
            let fl_config = FormLogicConfig {
                base_url: read_config_str(app.handle(), "formlogicBaseUrl").unwrap_or_default(),
                api_key: read_api_key(app.handle()).unwrap_or_default(),
            };
            let flow_runtime = FlowRuntime::new(plugin_host.clone(), Some(registry.clone()), fl_config);
            // Reconcile only the public Desktop connection id into native config.
            // The heartbeat's API key remains inside FormLogicClient and never
            // crosses this callback or the renderer boundary. We compare against
            // disk on every successful heartbeat so a prior write failure can be
            // repaired by a later pass.
            {
                let app_handle = app.handle().clone();
                flow_runtime.set_desktop_connection_id_observer(Arc::new(move |canonical_id| {
                    if read_config_str(&app_handle, "formlogicConnectionId").as_deref()
                        == Some(canonical_id)
                    {
                        return;
                    }
                    if let Err(error) = write_config_str(
                        &app_handle,
                        "formlogicConnectionId",
                        Some(canonical_id),
                    ) {
                        eprintln!(
                            "[formlogic] could not persist reconciled Desktop connection id: {error}"
                        );
                    }
                }));
            }
            // start() launches the flow event/claim/heartbeat loops via tokio::spawn, which needs an
            // ambient Tokio runtime. Unlike formlogic-server (#[tokio::main]), Tauri's setup hook runs
            // OUTSIDE the runtime, so run start() ON Tauri's async runtime (tokio) — otherwise
            // tokio::spawn panics ("there is no reactor running") and the app crashes on launch.
            {
                let fr = flow_runtime.clone();
                tauri::async_runtime::spawn(async move { fr.start(); });
            }
            // Autostart installed+enabled plugins (e.g. the Aokie phone bridge) so their connectors
            // are live for events + relayed commands without a manual click. start() spawns a
            // supervisor via tokio::spawn, so run it on Tauri's async runtime (setup isn't a Tokio
            // context) — same reason as the flow runtime above.
            {
                let ph = plugin_host.clone();
                tauri::async_runtime::spawn(async move { ph.autostart_installed(); });
            }
            // Optional outbound Aokie Companion publisher. This is a native,
            // observation-only task: its admission token never enters Tauri
            // state/the webview, and inbound commands are always rejected.
            {
                let ph = plugin_host.clone();
                tauri::async_runtime::spawn(async move {
                    crate::aokie_companion_publisher::run_from_env(ph).await;
                });
            }
            // Launch FormLogic Desktop on login (one-time default-on so the flow runtime + connector
            // relay are always available for remote/web-driven control; the user can turn it off in
            // the OS startup settings). enable() is idempotent; we set it once so a later disable sticks.
            if read_config_str(app.handle(), "autostartInitialized").is_none() {
                use tauri_plugin_autostart::ManagerExt;
                match app.autolaunch().enable() {
                    Ok(()) => log::info!("autostart: enabled (launch on login)"),
                    Err(e) => log::warn!("autostart: could not enable: {e}"),
                }
                let _ = write_config_str(app.handle(), "autostartInitialized", Some("1"));
            }

            // OAuth "Link account" machine (device-link, docs/MCP.md). One
            // attempt at a time; the UI drives it via the formlogic_oauth_* commands.
            let oauth_link = OAuthLink::new();

            app.manage(registry.clone());
            app.manage(downloads.clone());
            app.manage(python.clone());
            app.manage(catalog.clone());
            app.manage(plugin_host.clone());
            app.manage(pairing.clone());
            app.manage(flow_runtime.clone());
            app.manage(oauth_link.clone());
            // Poll-able state for an in-progress data-folder migration.
            let migration: MigrationHandle = Arc::new(Mutex::new(MigrationProgress::default()));
            app.manage(migration);

            // Spawn the localhost HTTP server on its own task. Errors here
            // are non-fatal for the tray itself — the user can still
            // interact with the UI, just no API.
            let app_handle = app.handle().clone();
            let registry_for_http = registry.clone();
            let downloads_for_http = downloads.clone();
            let python_for_http = python.clone();
            let catalog_for_http = catalog.clone();
            let plugin_host_for_http = plugin_host.clone();
            let pairing_for_http = pairing.clone();
            let flow_runtime_for_http = flow_runtime.clone();
            let config_provider: Arc<dyn http::ConfigProvider> =
                Arc::new(TauriConfigProvider { app: app_handle });
            tauri::async_runtime::spawn(async move {
                if let Err(e) = http::serve(
                    COMPANION_PORT,
                    config_provider,
                    // GUI: webview-origin auth, plus an OPTIONAL bearer token
                    // (set FORMLOGIC_SERVER_TOKEN) so the CLI can drive this companion
                    // without locking out the webview (gui_mode = true below).
                    std::env::var("FORMLOGIC_SERVER_TOKEN").ok().filter(|s| !s.is_empty()),
                    true,
                    registry_for_http,
                    downloads_for_http,
                    python_for_http,
                    catalog_for_http,
                    plugin_host_for_http,
                    pairing_for_http,
                    Some(flow_runtime_for_http),
                )
                .await
                {
                    log::error!("HTTP server exited: {e}");
                }
            });

            // Periodically reap exited child processes so the UI status
            // flips from "Running" to "Stopped"/"Errored" within a tick.
            // Cheap — walks only services that think they're running or
            // installing, plus the optional Python install/venv job.
            let registry_for_reaper = registry.clone();
            let python_for_reaper = python.clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u64 = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if let Ok(mut reg) = registry_for_reaper.lock() {
                        reg.reap_exited();
                        // DESK-PROC-001: fire any due crash-restart (bounded
                        // backoff; the crash-loop breaker lives in the reap).
                        reg.run_scheduled_restarts();
                    }
                    python_for_reaper.reap_exited();
                    // SRV-001: every 5th tick (~10 s), run the background
                    // maintenance pass — installed-exe probing + templates-dir
                    // fingerprinting — on the blocking pool, with the registry
                    // lock held only for the cheap collect/apply halves. This
                    // is the filesystem work GET /api/services used to do
                    // inline on every 2 s poll.
                    tick = tick.wrapping_add(1);
                    if tick % 5 == 0 {
                        let reg = registry_for_reaper.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            crate::services::registry::background_refresh(&reg);
                        })
                        .await;
                    }
                }
            });

            // Health-probe ticker: every 10s, walk Running services, hit
            // their health URLs out-of-lock, then fold results back in.
            // Catches the case where the process spawned fine but didn't
            // actually bind its port (config error, port collision, etc.)
            // — without this, the UI would happily say "Running" forever.
            let registry_for_health = registry.clone();
            tauri::async_runtime::spawn(async move {
                let client = match reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                {
                    Ok(c) => c,
                    Err(e) => {
                        log::warn!("health: client build failed: {e}");
                        return;
                    }
                };
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    let targets: Vec<(String, String, u64)> =
                        match registry_for_health.lock() {
                            Ok(r) => r.health_targets(),
                            Err(_) => continue,
                        };
                    if targets.is_empty() {
                        continue;
                    }
                    let mut results = Vec::with_capacity(targets.len());
                    for (id, url, timeout) in targets {
                        let req = client
                            .get(&url)
                            .timeout(std::time::Duration::from_secs(timeout.min(10)));
                        let ok = matches!(req.send().await, Ok(r) if r.status().is_success());
                        results.push((id, ok));
                    }
                    if let Ok(mut r) = registry_for_health.lock() {
                        r.apply_health_results(&results);
                    }
                }
            });

            // Build the tray icon + menu. tray::setup hides the main
            // window on close so the companion stays alive in the tray.
            tray::setup(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide-on-close instead of quit. The window can be reopened
            // from the tray menu. Quit lives explicitly under tray > Quit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| {
            match event {
                // Keep the app alive only for the IMPLICIT exit (last window
                // closed => code is None) so it stays in the tray. An EXPLICIT
                // app.exit()/app.restart() carries Some(code) and MUST pass through
                // — otherwise tray > Quit and the packaged restart become no-ops and
                // the RunEvent::Exit arm below (which runs stop_all) never fires,
                // orphaning every running service.
                RunEvent::ExitRequested { code, api, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                // On real Exit (tray > Quit, or programmatic app.exit),
                // stop every running service so we don't leak orphaned
                // processes. Done synchronously — the user just clicked
                // Quit and is waiting; a few hundred ms is fine.
                RunEvent::Exit => {
                    // Plugins first (they get a graceful plugin.shutdown with a
                    // bounded grace window), then services. block_on is safe
                    // here: Exit runs on the main thread, not a runtime worker.
                    if let Some(host) = app_handle.try_state::<PluginHostHandle>() {
                        let host = host.inner().clone();
                        log::info!("stopping all plugins on exit");
                        let _ = tauri::async_runtime::block_on(async move {
                            tokio::time::timeout(
                                std::time::Duration::from_secs(8),
                                host.stop_all(),
                            )
                            .await
                        });
                    }
                    if let Some(reg) = app_handle.try_state::<RegistryHandle>() {
                        // Recover from a poisoned mutex — stopping services on exit
                        // matters more than poison-safety (else they're orphaned).
                        let mut r = reg.lock().unwrap_or_else(|e| e.into_inner());
                        log::info!("stopping all services on exit");
                        r.stop_all();
                    }
                }
                _ => {}
            }
        });
}
} // mod gui
