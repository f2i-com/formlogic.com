//! Registry — in-memory store of templates + their runtime state.
//!
//! On init, seeds the user's config dir with built-in JSON templates
//! and shell scripts (so the user can edit them in place to add new
//! services or tweak existing ones), then loads every *.json under
//! `templates/` into the in-memory map.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::runner::{LogLine, Runner, SpawnConfig};
use super::template::{substitute, InstallSpec, NodeSpec, ServiceTemplate, UninstallSpec};

/// Built-in templates embedded at compile time. Seeded to disk on first
/// run; users can edit the on-disk copies to customise.
const BUILTIN_TEMPLATES: &[(&str, &str)] = &[
    (
        "llama-cpp.json",
        include_str!("../../resources/templates/llama-cpp.json"),
    ),
    (
        "ollama.json",
        include_str!("../../resources/templates/ollama.json"),
    ),
    (
        "playwright-browser.json",
        include_str!("../../resources/templates/playwright-browser.json"),
    ),
    (
        "krea2.json",
        include_str!("../../resources/templates/krea2.json"),
    ),
    (
        "aokie-voice.json",
        include_str!("../../resources/templates/aokie-voice.json"),
    ),
];

const BUILTIN_SCRIPTS: &[(&str, &str)] = &[
    (
        "install-ollama.ps1",
        include_str!("../../resources/scripts/install-ollama.ps1"),
    ),
    // (Python install is now native Rust — see Python::install_runtime in
    // services/python.rs — so there's no install-python.ps1 to seed.)
    (
        "install-playwright.ps1",
        include_str!("../../resources/scripts/install-playwright.ps1"),
    ),
    // The Playwright HTTP server itself — run by the playwright-browser
    // service's run.command. Seeded to scripts/ alongside the installers.
    (
        "playwright_server.py",
        include_str!("../../resources/scripts/playwright_server.py"),
    ),
    // Git-free GitHub-zip fetcher used by the Python-model installers.
    (
        "fetch_zip.py",
        include_str!("../../resources/scripts/fetch_zip.py"),
    ),
    // --- Linux install scripts (.sh) — seeded alongside the .ps1/.bat so
    // formlogic-server can install services on a headless Linux host.
    (
        "install-ollama.sh",
        include_str!("../../resources/scripts/install-ollama.sh"),
    ),
    (
        "install-playwright.sh",
        include_str!("../../resources/scripts/install-playwright.sh"),
    ),
    // NOTE: Krea-2 Turbo and Llama.cpp Server ship as SELF-CONTAINED packages --
    // their scripts live inline in the `files` map of their own templates
    // (krea2.json: krea2_server.py / krea2_gguf.py / install-krea2.ps1+.sh;
    // llama-cpp.json: install-llama-cpp.ps1+.sh) and are materialized on load,
    // so they are not listed here.
];

/// Former built-in templates that no longer ship (f2i-era video/image
/// services). init() deletes a seeded on-disk copy ONLY when it still matches
/// its `.seed` snapshot — a hand-edited copy is the user's now and stays.
const RETIRED_TEMPLATES: &[&str] = &["ltx2-video.json", "lance.json"];

/// Scripts that only existed to serve the retired templates above.
const RETIRED_SCRIPTS: &[&str] = &[
    "install-ltx2.bat",
    "install-ltx2.sh",
    "ltx2_server.py",
    "install-lance.bat",
    "install-lance.sh",
    "lance_server.py",
    "patch_lance_sharding.py",
    "patch_lance_paths.py",
    "flash_attn_shim.py",
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Stopped,
    Installing,
    Starting,
    Running,
    Errored,
}

/// PROC-001: per-service boot-autostart policy.
///   `Auto`   — restore whatever was running last session (the DESK-PROC-001
///              remembered-running behaviour; the default).
///   `Always` — start at every boot, even after an explicit Stop last session.
///   `Never`  — never start at boot, even if it was left running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AutostartPolicy {
    #[default]
    Auto,
    Always,
    Never,
}

/// PROC-001: privacy-safe structured record of a service's last spontaneous
/// exit — what the operator (and a support bundle) needs to diagnose WITHOUT
/// trawling the full log: the exit code, when, and the final stderr lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitDiagnostics {
    /// The process exit code (None = killed by signal / unknowable).
    pub code: Option<i32>,
    pub at: DateTime<Utc>,
    /// The last few stderr lines at exit, each length-capped. Same privacy
    /// class as the logs endpoint this summarises (same auth surface).
    pub stderr_tail: Vec<String>,
}

/// Runtime status of one service.
#[derive(Clone)]
pub struct ServiceRuntime {
    pub template: ServiceTemplate,
    pub status: ServiceStatus,
    pub error: Option<String>,
    pub runner: Option<Arc<Runner>>,
    /// Transient Runner that owns the in-flight install script process.
    /// Set by `install_streaming`, cleared by `reap_exited` once the
    /// script exits. While set, `logs()` returns its logs (so the UI's
    /// LogsViewer shows install progress without a separate endpoint).
    pub installer: Option<Arc<Runner>>,
    pub port: u16,
    pub last_status_change: DateTime<Utc>,
    /// DESK-PROC-001 crash supervision: consecutive rapid-crash restarts so
    /// far. Reset by a manual Start and after a quiet period (a crash long
    /// after the last one starts a fresh window).
    pub restart_attempts: u32,
    /// When the next automatic restart is due (`Errored` with a schedule).
    /// `None` = nothing scheduled (healthy, manually stopped, or crash-looped
    /// out of attempts).
    pub restart_at: Option<DateTime<Utc>>,
    /// When the service last crashed — the quiet-period anchor.
    pub last_crash_at: Option<DateTime<Utc>>,
    /// PROC-001: whether THIS run has ever passed a health probe. Separates
    /// "never became ready" (readiness-deadline breach — likely misconfigured)
    /// from "was ready, then stopped answering" (a runtime fault).
    pub ever_healthy: bool,
    /// PROC-001: the last spontaneous exit's diagnostics (kept across
    /// restarts until the next spontaneous exit replaces it).
    pub last_exit: Option<ExitDiagnostics>,
    /// SRV-001: when WE last fired a kill at this service's own process tree.
    /// `kill_process_tree` is fire-and-forget on every OS now (Windows gained
    /// parity with the always-detached Unix branch), so the dying process can
    /// hold its port for a beat after stop/repair/restart. The pre-spawn
    /// foreign-port probe is skipped inside this grace window — a lingering
    /// own process is expected teardown, not a foreign holder.
    pub own_teardown_at: Option<DateTime<Utc>>,
}

impl ServiceRuntime {
    fn new(template: ServiceTemplate) -> Self {
        let port = template.default_port;
        Self {
            template,
            status: ServiceStatus::Stopped,
            error: None,
            runner: None,
            installer: None,
            port,
            last_status_change: Utc::now(),
            restart_attempts: 0,
            restart_at: None,
            last_crash_at: None,
            ever_healthy: false,
            last_exit: None,
            own_teardown_at: None,
        }
    }

    fn set_status(&mut self, s: ServiceStatus, error: Option<String>) {
        if self.status != s || self.error != error {
            self.last_status_change = Utc::now();
        }
        self.status = s;
        self.error = error;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub status: ServiceStatus,
    pub error: Option<String>,
    pub port: u16,
    pub default_port: u16,
    pub pid: Option<u32>,
    pub started_at: Option<DateTime<Utc>>,
    pub last_status_change: DateTime<Utc>,
    pub docs_url: Option<String>,
    pub installable: bool,
    /// True when the template declares an `uninstall` spec — the desktop app
    /// shows an Uninstall button for it.
    pub uninstallable: bool,
    /// True when the service's run executable actually exists on disk (resolved the way
    /// start() does). Lets the UI show ONE button: Install when not installed, else Uninstall.
    pub installed: bool,
    /// The GPU index this service is pinned to (CUDA_VISIBLE_DEVICES), or None for default
    /// placement. Drives the GPU picker on the card.
    pub gpu: Option<u32>,
    /// How to call this service as a flow node (from the template), so the web
    /// app can surface it pre-wired. None → the client falls back to a convention.
    pub node: Option<NodeSpec>,
    /// PROC-001: this service's boot-autostart policy (auto|always|never).
    pub autostart: AutostartPolicy,
    /// PROC-001: the last spontaneous exit's diagnostics, when one happened.
    pub last_exit: Option<ExitDiagnostics>,
}

/// Result of `ensure_by_port` — surfaced to formlogic-web so it can tell the
/// user "started Ollama for you" vs "no companion service on that port".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureByPortResult {
    /// A companion service is configured for the requested port.
    pub found: bool,
    /// It was already running (no action taken).
    pub already_running: bool,
    /// We spawned it just now.
    pub started: bool,
    pub id: Option<String>,
    pub name: Option<String>,
    /// Set when found but the spawn failed.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    pub services: Vec<ServiceSnapshot>,
    /// Serialized as `dataDir` — the TS `RegistrySnapshot` interface +
    /// ServicesPanel read camelCase, like every other snapshot struct.
    /// Without the rename this came across as `data_dir` and the
    /// "configs live under …" line + open-folder button got `undefined`.
    pub data_dir: String,
    /// SRV-001: monotonic change counter. Bumped on every registry mutation;
    /// two responses with the same revision are byte-identical, so clients can
    /// skip re-rendering (and the server serves them from one cached body).
    pub revision: u64,
    /// SRV-001: when this snapshot body was BUILT (not when it was served) —
    /// the client shows "data as of …" / cache age from this.
    pub generated_at: DateTime<Utc>,
    /// SRV-001: how long the snapshot build took, in milliseconds. Regression
    /// instrumentation for the "no filesystem work on GET" invariant — this
    /// should stay well under a millisecond.
    pub build_ms: f64,
}

/// SRV-001: one pre-serialized snapshot body, valid while `revision` matches.
/// `GET /api/services` clones the `Arc` — zero building, zero filesystem work.
struct SnapshotCache {
    revision: u64,
    body: Arc<String>,
}

/// SRV-001: what the background prober needs to answer "is this service
/// installed?" WITHOUT the registry lock. Placeholder resolution (cheap string
/// work) happens under the lock when targets are collected; every filesystem
/// stat happens outside it.
pub struct InstalledProbe {
    pub id: String,
    pub kind: InstalledProbeKind,
}

pub enum InstalledProbeKind {
    /// Resolved install-completion marker path — installed iff it exists.
    Marker(PathBuf),
    /// Resolved run command. Bare names probe `bin_dir` first, then PATH
    /// (skipping UNC entries), then the per-user Programs dir.
    Command { resolved: String, bin_dir: PathBuf },
}

/// SRV-001: the filesystem half of the installed probe — a free function so it
/// can run with NO registry lock held. Mirrors `run_command_exists` /
/// `run_installed` exactly, plus: PATH directories that are UNC network paths
/// are skipped (a dead share would block on the SMB timeout — the same class
/// of hazard the run-command UNC guard already covers), and repeated bare
/// commands are memoized within one pass.
pub fn probe_installed(targets: &[InstalledProbe]) -> Vec<(String, bool)> {
    let path_var = std::env::var("PATH").ok();
    let mut memo: HashMap<&str, bool> = HashMap::new();
    let is_unc = |s: &str| s.starts_with("\\\\") || s.starts_with("//");
    targets
        .iter()
        .map(|t| {
            let ok = match &t.kind {
                InstalledProbeKind::Marker(p) => p.exists(),
                InstalledProbeKind::Command { resolved, bin_dir } => {
                    if resolved.contains(std::path::is_separator) {
                        // Same posture as run_command_exists: never stat a UNC
                        // path from an attacker-controllable template field.
                        !is_unc(resolved) && Path::new(resolved).exists()
                    } else if let Some(&hit) = memo.get(resolved.as_str()) {
                        hit
                    } else {
                        let bin = bin_dir.join(resolved);
                        let hit = bin.with_extension("exe").exists()
                            || bin.exists()
                            || path_var.as_deref().is_some_and(|path| {
                                std::env::split_paths(path)
                                    .filter(|dir| !is_unc(&dir.to_string_lossy()))
                                    .any(|dir| {
                                        let p = dir.join(resolved);
                                        p.exists() || p.with_extension("exe").exists()
                                    })
                            })
                            || user_programs_exe(resolved).is_some();
                        memo.insert(resolved.as_str(), hit);
                        hit
                    }
                }
            };
            (t.id.clone(), ok)
        })
        .collect()
}

/// SRV-001: cheap change fingerprint of the templates dir — (json file count,
/// newest json mtime). One read_dir + a stat per template file; NO parsing.
/// The background refresher re-parses templates only when this changes, so a
/// folder-dropped package still appears live (within one refresh tick) without
/// `GET /api/services` ever touching the disk.
pub fn templates_fingerprint(dir: &Path) -> Option<(usize, std::time::SystemTime)> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut count = 0usize;
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        count += 1;
        if let Ok(meta) = entry.metadata() {
            if let Ok(m) = meta.modified() {
                if m > newest {
                    newest = m;
                }
            }
        }
    }
    Some((count, newest))
}

/// SRV-001: how long after our own fire-and-forget kill a lingering port is
/// still presumed to be OUR dying process (probe skipped) rather than a
/// foreign holder. Unix has always had this window (its kill embeds a 2 s
/// TERM→KILL grace); 5 s covers taskkill scheduling on a loaded box too.
const TEARDOWN_PORT_GRACE_SECS: i64 = 5;

/// SRV-001: pure decision — skip the pre-spawn foreign-port probe when we just
/// tore our own process down (it may legitimately hold the port for a beat).
fn own_teardown_recent(teardown_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    teardown_at.is_some_and(|t| (now - t).num_seconds() < TEARDOWN_PORT_GRACE_SECS)
}

/// Combine the primary models dir with extra roots into an ordered, deduped
/// search list (primary first). Skips empties + duplicates (case-insensitive
/// on Windows, where the filesystem is).
fn combine_model_dirs(primary: &Path, extra: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::with_capacity(1 + extra.len());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Keep this identical to lib.rs `model_dir_key` (trim whitespace, then
    // trailing separators, then lowercase on Windows) so the two dedup layers
    // never disagree about whether two paths are the same.
    let norm = |p: &Path| {
        let s = p.display().to_string();
        let s = s.trim().trim_end_matches(['/', '\\']).to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    for p in std::iter::once(primary.to_path_buf()).chain(extra) {
        if p.as_os_str().is_empty() {
            continue;
        }
        let k = norm(&p);
        if k.is_empty() || !seen.insert(k) {
            continue;
        }
        out.push(p);
    }
    out
}

/// Join model roots with the OS path separator (`;` on Windows, `:` elsewhere)
/// for the `${modelDirs}` placeholder + `FORMLOGIC_MODEL_DIRS` env. Services split on
/// `os.pathsep` to recover the list.
fn join_model_dirs(dirs: &[PathBuf]) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    dirs.iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(sep)
}

/// On Unix, rewrite a Windows venv interpreter path that a template hardcodes
/// (`…/venvs/NAME/Scripts/python.exe`) into its Unix equivalent
/// (`…/venvs/NAME/bin/python`). No-op on Windows. Lets the same templates run a
/// venv-based service on either OS without per-OS run.command variants.
#[cfg(windows)]
fn os_fix_path(s: String) -> String {
    s
}
#[cfg(not(windows))]
fn os_fix_path(s: String) -> String {
    s.replace("\\Scripts\\python.exe", "/bin/python")
        .replace("/Scripts/python.exe", "/bin/python")
        .replace("/Scripts/pythonw.exe", "/bin/python")
}

/// The standard per-user install location an installer like Ollama's `OllamaSetup.exe` drops
/// `<cmd>.exe` into: `%LOCALAPPDATA%\Programs\<cmd>\<cmd>.exe`. Probed directly because such
/// installers add themselves only to the PERSISTED registry PATH — the already-running
/// companion's in-process PATH (captured at launch) doesn't pick that up until a restart, so
/// without this a just-installed ollama reads as "not installed" and refuses to start. (The
/// Windows FS is case-insensitive, so the bare `ollama` resolves the installer's `Ollama` dir.)
#[cfg(windows)]
fn user_programs_exe(cmd: &str) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let p = Path::new(&local)
        .join("Programs")
        .join(cmd)
        .join(format!("{cmd}.exe"));
    p.exists().then_some(p)
}
#[cfg(not(windows))]
fn user_programs_exe(_cmd: &str) -> Option<PathBuf> {
    None
}

/// Resolve a Windows system binary to its absolute `%SystemRoot%\System32` path so the
/// companion never launches a planted `cmd.exe`/`powershell.exe`/`taskkill.exe` from an
/// attacker-writable working dir or PATH entry (binary-planting defense-in-depth). Falls back
/// to the bare name if SystemRoot is somehow unset.
#[cfg(windows)]
fn system32_exe(rel: &str) -> String {
    std::env::var_os("SystemRoot")
        .map(|root| {
            Path::new(&root)
                .join("System32")
                .join(rel)
                .display()
                .to_string()
        })
        .unwrap_or_else(|| rel.to_string())
}
#[cfg(not(windows))]
fn system32_exe(rel: &str) -> String {
    rel.to_string()
}

/// Normalize a path string for managed-root containment checks: drop trailing
/// separators, and on Windows fold `/`→`\` and lowercase (so a `${dataDir}/x`
/// expansion mixing separators still compares equal to its backslash root).
fn norm_path_key(s: &str) -> String {
    let s = s.trim_end_matches(['/', '\\']);
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s.to_string()
    }
}

pub struct Registry {
    services: HashMap<String, ServiceRuntime>,
    /// Root config dir — `${dataDir}` placeholder. Contains
    /// `templates/`, `scripts/`, `bin/`, `venvs/` subdirs.
    data_dir: PathBuf,
    /// Resolved models dir — the `${modelsDir}` placeholder + the
    /// `FORMLOGIC_MODELS_DIR` install env. Usually `<dataDir>/models`, but can be
    /// a user-chosen folder on another drive (set in Settings).
    models_dir: PathBuf,
    /// All model search roots, primary first: `[models_dir] ++ extra`. Powers
    /// the `${modelDirs}` placeholder + `FORMLOGIC_MODEL_DIRS` env (os-pathsep list)
    /// so a service can scan several drives (e.g. `E:\models` AND `E:\ckpts`)
    /// for its weights. Deduped; primary stays index 0 for back-compat.
    model_dirs: Vec<PathBuf>,
    /// The GGUF a single-model server (llama.cpp) should load — the
    /// `${llamaModel}` placeholder. `None` ⇒ no model selected; start() refuses
    /// to spawn (no implicit default). Set live from the Model picker.
    llama_model: Option<String>,
    /// Optional multimodal projector (mmproj GGUF) for the single-model llama
    /// service: appended as `--mmproj <path>` at spawn. Required for
    /// input_audio/image content parts (Gemma 4 E2B class); None = text-only.
    llama_mmproj: Option<String>,
    /// The model NAME a multi-model server (Ollama) should use — substituted
    /// into the node body template as `${ollamaModel}`. `None` ⇒ the small
    /// default the installer pre-pulls (qwen2.5:0.5b). Set live from its picker.
    ollama_model: Option<String>,
    /// Per-service GPU pin: serviceId → GPU index, applied as `CUDA_VISIBLE_DEVICES` at
    /// start() so heavy services don't all default to GPU 0 and thrash. Absent ⇒ the
    /// service's own default (e.g. krea2 keeps DIT on GPU 0 + encoder on GPU 1). Set live
    /// from the GPU picker; takes effect on the next start.
    service_gpus: HashMap<String, u32>,
    /// DESK-PROC-001: ids of the services the operator has running, persisted
    /// to `<dataDir>/services-running.json` so a desktop relaunch (or a crash
    /// followed by the kill-on-close job reaping the children) restores them
    /// via [`Registry::autostart_remembered`]. Explicit Stop forgets; the
    /// shutdown-path `stop_all` deliberately does NOT.
    remembered_running: std::collections::HashSet<String>,
    /// PROC-001: explicit per-service boot policy, persisted to
    /// `<dataDir>/services-autostart.json` (only non-Auto entries). Combined
    /// with `remembered_running` by [`Registry::autostart_remembered`].
    autostart_policies: HashMap<String, AutostartPolicy>,
    /// SRV-001: monotonic mutation counter. Every state change that could
    /// alter the snapshot bumps it (over-bumping is harmless — one cheap
    /// in-memory rebuild; under-bumping would serve a stale snapshot, so
    /// mutating methods bump unconditionally and only the tick-driven
    /// reap/health/installed appliers track real changes).
    revision: u64,
    /// SRV-001: the pre-serialized snapshot body for the current revision.
    snapshot_cache: Option<SnapshotCache>,
    /// SRV-001: per-service "run executable / install marker exists" verdicts,
    /// maintained by the background prober (`background_refresh`) + targeted
    /// refreshes after install/uninstall/import — so `snapshot()` never stats
    /// the filesystem. Seeded synchronously once at init.
    installed_cache: HashMap<String, bool>,
    /// SRV-001: last observed templates-dir fingerprint; the background
    /// refresher re-parses the dir only when this changes.
    templates_fp: Option<(usize, std::time::SystemTime)>,
}

/// DESK-PROC-001 backoff policy, factored pure for tests: given how many
/// consecutive rapid restarts have already been attempted, decide the next
/// step — `Some((new_attempt_count, delay_seconds))` to schedule another
/// automatic restart, or `None` when the service is crash-looping and
/// automatic recovery must stop (the operator presses Start to reset).
/// Delays: 2, 4, 8, 16, 32 s — five attempts inside a quiet window.
fn next_restart(attempts_so_far: u32) -> Option<(u32, i64)> {
    const MAX_RESTART_ATTEMPTS: u32 = 5;
    if attempts_so_far >= MAX_RESTART_ATTEMPTS {
        return None;
    }
    let attempt = attempts_so_far + 1;
    Some((attempt, 2i64 << (attempt - 1).min(4)))
}

/// A crash after this long since the previous one starts a FRESH attempt
/// window (the earlier crashes were evidently transient — the service ran
/// fine in between).
const RESTART_QUIET_SECS: i64 = 600;

/// DESK-PROC-001: the remembered-running set on disk (a plain JSON string
/// array). Missing/corrupt reads collapse to empty — worst case the operator
/// starts services by hand once, exactly the pre-feature behaviour.
fn load_remembered_running(path: &Path) -> std::collections::HashSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn persist_remembered_running(path: &Path, ids: &std::collections::HashSet<String>) {
    let mut sorted: Vec<&String> = ids.iter().collect();
    sorted.sort();
    match serde_json::to_string_pretty(&sorted) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                log::warn!("could not persist the running-services list: {e}");
            }
        }
        Err(e) => log::warn!("could not serialize the running-services list: {e}"),
    }
}

/// PROC-001: the explicit autostart-policy map on disk (`{"id": "always"|"never"}`;
/// Auto entries are omitted). Missing/corrupt collapses to empty = all Auto,
/// exactly the pre-feature behaviour.
fn load_autostart_policies(path: &Path) -> HashMap<String, AutostartPolicy> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, AutostartPolicy>>(&s).ok())
        .unwrap_or_default()
}

fn persist_autostart_policies(path: &Path, policies: &HashMap<String, AutostartPolicy>) {
    let trimmed: std::collections::BTreeMap<&String, AutostartPolicy> = policies
        .iter()
        .filter(|(_, p)| **p != AutostartPolicy::Auto)
        .map(|(k, v)| (k, *v))
        .collect();
    match serde_json::to_string_pretty(&trimmed) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                log::warn!("could not persist the autostart policies: {e}");
            }
        }
        Err(e) => log::warn!("could not serialize the autostart policies: {e}"),
    }
}

/// PROC-001: the boot-autostart decision, factored pure for tests.
/// `Always` starts regardless of last session; `Never` never starts;
/// `Auto` (or no entry) restores the remembered-running set.
fn should_autostart(
    policy: AutostartPolicy,
    remembered: bool,
) -> bool {
    match policy {
        AutostartPolicy::Always => true,
        AutostartPolicy::Never => false,
        AutostartPolicy::Auto => remembered,
    }
}

/// PROC-001: the health-failure message, factored pure for tests. A service
/// that has NEVER answered its health probe breached its readiness deadline
/// (likely misconfigured / stuck loading); one that WAS ready has a runtime
/// fault. Same state, different operator action — say which.
fn readiness_failure_message(ever_healthy: bool, grace_secs: i64) -> String {
    if ever_healthy {
        "health check failed — process is running but stopped responding on its port".to_string()
    } else {
        format!(
            "did not become ready within {grace_secs}s (readiness deadline) — the process is up \
             but its port never answered; open Logs, or press Repair to reset and retry"
        )
    }
}

/// PROC-001: cap an exit's stderr tail for the structured diagnostics —
/// enough to name the failure, small enough to embed in every snapshot.
fn exit_stderr_tail(lines: &[crate::services::runner::LogLine]) -> Vec<String> {
    const TAIL_LINES: usize = 6;
    const LINE_CAP: usize = 300;
    lines
        .iter()
        .filter(|l| l.stream == "stderr")
        .rev()
        .take(TAIL_LINES)
        .map(|l| {
            let mut t = l.text.clone();
            if t.len() > LINE_CAP {
                let mut cap = LINE_CAP;
                while cap > 0 && !t.is_char_boundary(cap) {
                    cap -= 1;
                }
                t.truncate(cap);
                t.push('…');
            }
            t
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// PROC-001: is `port` already claimed on loopback by SOMEONE ELSE? Used as a
/// pre-spawn probe so "the port is busy" is a named diagnosis instead of a
/// service that spawns and then crash-loops against EADDRINUSE. Probe errors
/// other than AddrInUse are treated as free — the probe must never block a
/// legitimate start.
fn port_in_use(port: u16) -> bool {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(_) => false,
        Err(e) => e.kind() == std::io::ErrorKind::AddrInUse,
    }
}

/// Seed a built-in plumbing script, refreshing it when we ship a new
/// version — but never clobbering a copy the user has hand-edited. A
/// hidden `.<name>.seed` snapshot records what we last wrote, so we can
/// tell an untouched auto-seed (safe to refresh) from a user edit (leave
/// alone). Same policy as the model catalog (see catalog.rs):
///   - target missing                 → write file + snapshot
///   - target == snapshot, bundle new → refresh both (ship the fix)
///   - target != snapshot             → user edited; leave it alone
///   - snapshot missing (older build) → treat as old auto-seed; refresh
///     and start tracking. (Scripts are plumbing, rarely hand-edited, so
///     this one-time refresh is an acceptable trade for shipping fixes.)
fn seed_builtin_script(target: &Path, snapshot: &Path, body: &str) -> std::io::Result<()> {
    // Shell scripts must be LF — a CRLF copy (e.g. from a core.autocrlf=true
    // checkout that reached include_str!) breaks under `sh` on Linux. Normalize
    // .sh bodies to LF defensively; the repo .gitattributes is the primary guard.
    let lf;
    let body: &str = if target.extension().and_then(|e| e.to_str()) == Some("sh") {
        lf = body.replace("\r\n", "\n");
        &lf
    } else {
        body
    };
    match std::fs::read_to_string(target).ok() {
        None => {
            std::fs::write(target, body)?;
            let _ = std::fs::write(snapshot, body);
        }
        Some(current) => match std::fs::read_to_string(snapshot).ok() {
            Some(snap) => {
                if current.trim() == snap.trim() && current.trim() != body.trim() {
                    std::fs::write(target, body)?;
                    let _ = std::fs::write(snapshot, body);
                }
            }
            None => {
                std::fs::write(target, body)?;
                let _ = std::fs::write(snapshot, body);
            }
        },
    }
    Ok(())
}

/// Delete retired built-in files that are still pristine auto-seeds: the
/// on-disk copy must match its `.seed` snapshot byte-for-byte (modulo
/// whitespace trim, mirroring seed_builtin_script's comparison). A missing
/// snapshot means we can't prove the file is ours, so it stays. Orphaned
/// snapshots are always removed.
fn remove_retired_seeds(dir: &Path, names: &[&str]) {
    for name in names {
        let target = dir.join(name);
        let snap = dir.join(format!(".{name}.seed"));
        let target_body = std::fs::read_to_string(&target).ok();
        let snap_body = std::fs::read_to_string(&snap).ok();
        match (target_body, snap_body) {
            (Some(current), Some(seed)) => {
                if current.trim() == seed.trim() {
                    if let Err(e) = std::fs::remove_file(&target) {
                        log::warn!("could not remove retired {name}: {e}");
                    } else {
                        log::info!("removed retired built-in {name}");
                        let _ = std::fs::remove_file(&snap);
                    }
                } else {
                    log::info!("keeping user-edited retired file {name}");
                }
            }
            (None, Some(_)) => {
                let _ = std::fs::remove_file(&snap);
            }
            _ => {}
        }
    }
}

/// A package-file name is safe iff it's a bare filename (no path separator / `..` /
/// drive prefix) and not hidden — package files live directly in `scripts/`.
fn is_safe_script_name(name: &str) -> bool {
    Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|f| f == name)
        .unwrap_or(false)
        && !name.starts_with('.')
}

/// Script names OWNED by the built-ins: every `BUILTIN_SCRIPTS` key plus every file a built-in
/// TEMPLATE bundles (krea2_server.py, install-krea2.ps1, …). An imported package must never be
/// allowed to write any of these — they're seeded from the trusted compiled-in source, and
/// overwriting one would trojan a DIFFERENT, trusted service (RCE the next time the user
/// installs/starts it).
fn reserved_script_names() -> &'static std::collections::HashSet<String> {
    static SET: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    SET.get_or_init(|| {
        let mut s = std::collections::HashSet::new();
        for (name, _) in BUILTIN_SCRIPTS {
            s.insert((*name).to_string());
        }
        for (_, body) in BUILTIN_TEMPLATES {
            if let Ok(t) = serde_json::from_str::<ServiceTemplate>(body) {
                for k in t.files.keys() {
                    s.insert(k.clone());
                }
            }
        }
        s
    })
}

/// Seed every built-in template's bundled `files` from the COMPILED-IN source (trusted), so the
/// reserved-name guard in `materialize_package_files` can then refuse an imported package from
/// overwriting them.
fn seed_builtin_template_files(scripts_dir: &Path) {
    for (_, body) in BUILTIN_TEMPLATES {
        if let Ok(t) = serde_json::from_str::<ServiceTemplate>(body) {
            for (name, fbody) in &t.files {
                if !is_safe_script_name(name) {
                    continue;
                }
                let target = scripts_dir.join(name);
                let snap = scripts_dir.join(format!(".{name}.seed"));
                if let Err(e) = seed_builtin_script(&target, &snap, fbody) {
                    log::warn!("could not seed built-in template file {name}: {e}");
                }
            }
        }
    }
}

/// Write a NON-BUILT-IN (imported) package's bundled `files` into the shared scripts dir so its
/// install/run commands resolve. SECURITY: refuses any name owned by a built-in script/template
/// (so a malicious import can't overwrite a trusted service's script — cross-service RCE) and
/// any non-reserved name already owned by a DIFFERENT package (tracked via a `.<name>.owner`
/// sidecar). Built-in templates' own files are seeded by `seed_builtin_template_files`, not here.
fn materialize_package_files(scripts_dir: &Path, template_id: &str, files: &HashMap<String, String>) {
    for (name, body) in files {
        if !is_safe_script_name(name) {
            log::warn!("skipping package file with unsafe/hidden name: {name}");
            continue;
        }
        if reserved_script_names().contains(name) {
            log::warn!(
                "template '{template_id}': refusing to overwrite built-in script '{name}'"
            );
            continue;
        }
        let target = scripts_dir.join(name);
        let owner = scripts_dir.join(format!(".{name}.owner"));
        // Don't clobber a non-reserved script another package (or an unmarked pre-existing
        // file) owns — only refresh one this same template wrote.
        if target.exists()
            && std::fs::read_to_string(&owner)
                .ok()
                .as_deref()
                .map(str::trim)
                != Some(template_id)
        {
            log::warn!(
                "template '{template_id}': refusing to overwrite script '{name}' owned by another package"
            );
            continue;
        }
        let snap = scripts_dir.join(format!(".{name}.seed"));
        match seed_builtin_script(&target, &snap, body) {
            Ok(()) => {
                let _ = std::fs::write(&owner, template_id);
            }
            Err(e) => log::warn!("could not materialize package file {name}: {e}"),
        }
    }
}

impl Registry {
    /// Seed user dir if empty and load every template. `models_dir` is the
    /// resolved downloads/weights root (override or `<dataDir>/models`);
    /// `extra_model_dirs` are additional read-only search roots (e.g.
    /// `E:\ckpts`) the user registered in Settings — together they form the
    /// `${modelDirs}` / `FORMLOGIC_MODEL_DIRS` search list.
    pub fn init(
        data_dir: PathBuf,
        models_dir: PathBuf,
        extra_model_dirs: Vec<PathBuf>,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(data_dir.join("templates"))?;
        std::fs::create_dir_all(data_dir.join("scripts"))?;
        std::fs::create_dir_all(data_dir.join("bin"))?;
        std::fs::create_dir_all(&models_dir)?;

        // Templates re-seed on change via a snapshot — same policy as the
        // scripts below (seed_builtin_script): ship fixes to built-in
        // templates without clobbering a copy the user has hand-edited. A
        // missing snapshot (older build that used write-if-not-exists) is
        // treated as an untouched auto-seed and refreshed once, then tracked
        // — so e.g. a corrected lance.json reaches existing installs.
        for (name, body) in BUILTIN_TEMPLATES {
            let p = data_dir.join("templates").join(name);
            let snap = data_dir.join("templates").join(format!(".{name}.seed"));
            if let Err(e) = seed_builtin_script(&p, &snap, body) {
                log::warn!("could not seed built-in template {name}: {e}");
            }
        }
        // Scripts are plumbing (install .ps1 + the playwright server .py),
        // not user-facing config like templates. We still ship fixes to
        // them, so — unlike templates — re-seed on change via a snapshot,
        // never clobbering a copy the user has actually edited. Mirrors the
        // catalog's seed-snapshot policy (catalog.rs).
        for (name, body) in BUILTIN_SCRIPTS {
            let p = data_dir.join("scripts").join(name);
            let snap = data_dir.join("scripts").join(format!(".{name}.seed"));
            if let Err(e) = seed_builtin_script(&p, &snap, body) {
                log::warn!("could not seed built-in script {name}: {e}");
            }
        }
        // Seed built-in TEMPLATES' bundled files (krea2_server.py, install-krea2.ps1, …) from
        // the trusted compiled-in source, so the reserved-name guard in
        // materialize_package_files refuses any imported package from overwriting them.
        seed_builtin_template_files(&data_dir.join("scripts"));

        // Retired built-ins: sweep seeded copies off existing installs. A copy
        // that diverged from its snapshot was hand-edited — it's the user's
        // template/script now and is left alone.
        remove_retired_seeds(&data_dir.join("templates"), RETIRED_TEMPLATES);
        remove_retired_seeds(&data_dir.join("scripts"), RETIRED_SCRIPTS);

        let mut services = HashMap::new();
        for entry in std::fs::read_dir(data_dir.join("templates"))? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path)?;
            match serde_json::from_str::<ServiceTemplate>(&raw) {
                Ok(t) => {
                    // Self-contained packages carry their scripts inline; lay
                    // them down so install/run can find them by name.
                    if !t.files.is_empty() {
                        materialize_package_files(&data_dir.join("scripts"), &t.id, &t.files);
                    }
                    let id = t.id.clone();
                    services.insert(id, ServiceRuntime::new(t));
                }
                Err(e) => {
                    log::warn!("skipping bad template {}: {}", path.display(), e);
                }
            }
        }

        log::info!(
            "registry loaded {} service(s) from {}",
            services.len(),
            data_dir.display()
        );
        let model_dirs = combine_model_dirs(&models_dir, extra_model_dirs);
        let remembered_running = load_remembered_running(&data_dir.join("services-running.json"));
        let autostart_policies = load_autostart_policies(&data_dir.join("services-autostart.json"));
        let mut reg = Self {
            services,
            data_dir,
            models_dir,
            model_dirs,
            llama_model: None,
            llama_mmproj: None,
            ollama_model: None,
            service_gpus: HashMap::new(),
            remembered_running,
            autostart_policies,
            revision: 1,
            snapshot_cache: None,
            installed_cache: HashMap::new(),
            templates_fp: None,
        };
        // SRV-001: seed the installed cache synchronously ONCE (startup is the
        // one place filesystem probing is acceptable inline); afterwards the
        // background refresher + targeted post-install/uninstall refreshes own
        // it, and snapshot()/GET never touch the disk.
        reg.refresh_installed_now();
        reg.templates_fp = templates_fingerprint(&reg.data_dir.join("templates"));
        Ok(reg)
    }

    /// Last-resort in-memory registry with NO templates and NO filesystem work.
    /// Used when both the data dir AND the temp-dir fallback are unwritable, so
    /// the tray/UI still comes up (degraded) instead of panicking at startup.
    pub fn empty(data_dir: PathBuf, models_dir: PathBuf) -> Self {
        let model_dirs = combine_model_dirs(&models_dir, Vec::new());
        Self {
            services: HashMap::new(),
            data_dir,
            models_dir,
            model_dirs,
            llama_model: None,
            llama_mmproj: None,
            ollama_model: None,
            service_gpus: HashMap::new(),
            remembered_running: std::collections::HashSet::new(),
            autostart_policies: HashMap::new(),
            revision: 1,
            snapshot_cache: None,
            installed_cache: HashMap::new(),
            templates_fp: None,
        }
    }

    /// SRV-001: bump the mutation counter (invalidates the cached snapshot
    /// body). Called by every mutating method; cheap and safe to over-call.
    fn touch(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    /// Root config dir. Used by the gui-feature config/migration Tauri commands;
    /// the `#[allow(dead_code)]` keeps the headless (`--no-default-features`)
    /// build — where those callers are cfg'd out — warning-free.
    #[allow(dead_code)]
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Resolved models dir (override or `<dataDir>/models`). Used by the
    /// config snapshot to report where models actually live.
    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// All model search roots, primary first. Powers `${modelDirs}`.
    /// (Exposed for completeness alongside `extra_model_dirs()`; the env/ctx
    /// paths read the field directly via `join_model_dirs`.)
    #[allow(dead_code)]
    pub fn model_dirs(&self) -> &[PathBuf] {
        &self.model_dirs
    }

    /// The additional roots beyond the primary `models_dir` (what Settings
    /// shows + edits). Just `model_dirs[1..]`.
    pub fn extra_model_dirs(&self) -> Vec<String> {
        self.model_dirs
            .iter()
            .skip(1)
            .map(|p| p.display().to_string())
            .collect()
    }

    /// Replace the extra search roots (live — the next service start picks
    /// them up via `${modelDirs}` / `FORMLOGIC_MODEL_DIRS`). Primary stays index 0.
    pub fn set_extra_model_dirs(&mut self, extra: Vec<PathBuf>) {
        self.model_dirs = combine_model_dirs(&self.models_dir, extra);
        self.touch();
    }

    /// The configured single-model override (`${llamaModel}`), if any. `None`
    /// means no model is selected (no implicit default; start() refuses to spawn).
    pub fn llama_model(&self) -> Option<String> {
        self.llama_model.clone()
    }

    /// Set (or clear) the GGUF a single-model server loads. Live — the next
    /// service start reads it via `${llamaModel}`, no restart needed.
    pub fn llama_mmproj(&self) -> Option<String> {
        self.llama_mmproj.clone()
    }

    pub fn set_llama_mmproj(&mut self, path: Option<String>) {
        self.llama_mmproj = clean_model_opt(path);
        self.touch();
    }

    pub fn set_llama_model(&mut self, model: Option<String>) {
        self.llama_model = clean_model_opt(model);
        self.touch();
    }

    /// The configured Ollama model name (`${ollamaModel}`), if any.
    pub fn ollama_model(&self) -> Option<String> {
        self.ollama_model.clone()
    }

    /// Set (or clear) the Ollama model name. Live — the next /api/services
    /// snapshot resolves `${ollamaModel}` in the node body, no restart needed.
    pub fn set_ollama_model(&mut self, model: Option<String>) {
        self.ollama_model = clean_model_opt(model);
        self.touch();
    }

    /// The GPU index pinned for a service, if any (`None` ⇒ default placement).
    pub fn service_gpu(&self, id: &str) -> Option<u32> {
        self.service_gpus.get(id).copied()
    }

    /// Pin a service to a GPU index (or clear with `None`). Applied as
    /// `CUDA_VISIBLE_DEVICES` on the next start(); no effect on a running process.
    pub fn set_service_gpu(&mut self, id: &str, gpu: Option<u32>) {
        match gpu {
            Some(n) => {
                self.service_gpus.insert(id.to_string(), n);
            }
            None => {
                self.service_gpus.remove(id);
            }
        }
        self.touch();
    }

    /// Replace the whole per-service GPU map (loads the saved config at startup).
    pub fn set_service_gpus(&mut self, map: HashMap<String, u32>) {
        self.service_gpus = map;
        self.touch();
    }

    /// The live port of a service by id (e.g. to query Ollama's /api/tags for
    /// the list of pulled models).
    pub fn service_port(&self, id: &str) -> Option<u16> {
        self.services.get(id).map(|s| s.port)
    }

    /// Port of a RUNNING LLM-category service, so a flow reuses whatever model
    /// the desktop currently has loaded (e.g. llama.cpp with the user's gguf,
    /// or a running Ollama). Prefers llama-cpp, then ollama, then any other
    /// running LLM service. `None` if no LLM service is running.
    pub fn running_llm_port(&self) -> Option<u16> {
        let is_running_llm = |s: &ServiceRuntime| {
            s.status == ServiceStatus::Running && s.template.category.eq_ignore_ascii_case("llm")
        };
        for id in ["llama-cpp", "ollama"] {
            if let Some(s) = self.services.get(id) {
                if is_running_llm(s) {
                    return Some(s.port);
                }
            }
        }
        self.services.values().find(|s| is_running_llm(s)).map(|s| s.port)
    }

    /// Every loadable *.gguf at the top level of any model search root
    /// (primary + extras), deduped + sorted. Excludes multimodal projector
    /// files (`mmproj*`), which aren't a standalone model. Powers the
    /// llama.cpp Model picker.
    pub fn list_gguf_models(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for dir in &self.model_dirs {
            let Ok(rd) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let p = entry.path();
                let is_gguf = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("gguf"))
                    .unwrap_or(false);
                if !is_gguf {
                    continue;
                }
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.to_ascii_lowercase().starts_with("mmproj") {
                    continue;
                }
                let s = p.display().to_string();
                if seen.insert(s.clone()) {
                    out.push(s);
                }
            }
        }
        out.sort();
        out
    }

    /// True when `p` resolves inside a managed root (`${dataDir}` — which
    /// contains bin/scripts/venvs/services — or any model dir). The uninstall
    /// guard so a template's declared paths can't reach outside what FormLogic owns.
    fn path_within_managed_root(&self, p: &Path) -> bool {
        let target = norm_path_key(&p.display().to_string());
        if target.is_empty() {
            return false;
        }
        std::iter::once(&self.data_dir)
            .chain(self.model_dirs.iter())
            .any(|root| {
                let r = norm_path_key(&root.display().to_string());
                !r.is_empty()
                    && (target == r
                        || target.starts_with(&format!("{r}{}", std::path::MAIN_SEPARATOR)))
            })
    }

    /// True when `p` is EXACTLY one of the managed roots (data dir or a model
    /// dir). Used to refuse a glob sitting directly in a root, which would
    /// enumerate the whole root.
    fn is_managed_root(&self, p: &Path) -> bool {
        let t = norm_path_key(&p.display().to_string());
        !t.is_empty()
            && std::iter::once(&self.data_dir)
                .chain(self.model_dirs.iter())
                .any(|r| norm_path_key(&r.display().to_string()) == t)
    }

    /// True when `p` is EXACTLY a managed root OR a SHARED structural dir under the data dir
    /// (`bin`/`venvs`/`services`/`templates`/`scripts`). Uninstall must refuse these: removing
    /// one would wipe EVERY service's files (all venvs, all binaries, all templates), not just
    /// this service's. Paths strictly UNDER them (e.g. `${dataDir}/venvs/<id>`,
    /// `${binDir}/llama-*.exe`) are fine — this is an equality check, so they pass through.
    fn is_protected_uninstall_root(&self, p: &Path) -> bool {
        if self.is_managed_root(p) {
            return true;
        }
        let t = norm_path_key(&p.display().to_string());
        !t.is_empty()
            && ["bin", "venvs", "services", "templates", "scripts"]
                .iter()
                .any(|sub| norm_path_key(&self.data_dir.join(sub).display().to_string()) == t)
    }

    /// Remove the files/dirs a service's `uninstall` spec declares, so the user
    /// can clean-reinstall (e.g. swap an old llama.cpp build for a new one).
    /// Each path is placeholder-expanded; a `*` in the final segment globs that
    /// dir. Every path is guarded to stay inside a managed root and to contain
    /// no `..`. The service must be stopped. Returns the count removed.
    pub fn uninstall(&mut self, id: &str) -> Result<usize, String> {
        let (status, spec, port) = {
            let svc = self.services.get(id).ok_or("unknown service")?;
            (svc.status, svc.template.uninstall.clone(), svc.port)
        };
        if matches!(status, ServiceStatus::Running | ServiceStatus::Starting) {
            return Err("stop the service before uninstalling it".into());
        }
        let spec: UninstallSpec = spec.ok_or("this service has no uninstall defined")?;

        // Glob-aware single-segment removal (prefix*suffix on the file name).
        fn remove_matching(resolved: &str) -> usize {
            let p = Path::new(resolved);
            let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.contains('*') {
                let dir = p.parent().unwrap_or_else(|| Path::new("."));
                let (pre, suf) = fname.split_once('*').unwrap_or((fname, ""));
                // A bare `*` (empty prefix AND suffix) matches EVERY entry in the
                // dir — refuse it so an over-broad spec can't wipe a whole dir.
                if pre.is_empty() && suf.is_empty() {
                    return 0;
                }
                let mut n = 0;
                if let Ok(rd) = std::fs::read_dir(dir) {
                    for e in rd.flatten() {
                        let nm = e.file_name();
                        let nm = nm.to_str().unwrap_or("");
                        if nm.len() >= pre.len() + suf.len()
                            && nm.starts_with(pre)
                            && nm.ends_with(suf)
                        {
                            let t = e.path();
                            let ok = if t.is_dir() {
                                std::fs::remove_dir_all(&t).is_ok()
                            } else {
                                std::fs::remove_file(&t).is_ok()
                            };
                            if ok {
                                n += 1;
                            }
                        }
                    }
                }
                n
            } else if p.is_dir() {
                usize::from(std::fs::remove_dir_all(p).is_ok())
            } else if p.is_file() {
                usize::from(std::fs::remove_file(p).is_ok())
            } else {
                0
            }
        }

        let ctx = self.ctx(port);
        let mut removed = 0usize;
        for raw in &spec.paths {
            let resolved = os_fix_path(substitute(raw, &ctx));
            if resolved.split(['/', '\\']).any(|c| c == "..") {
                log::warn!("uninstall {id}: skipping path with '..': {resolved}");
                continue;
            }
            if !self.path_within_managed_root(Path::new(&resolved)) {
                log::warn!("uninstall {id}: skipping out-of-root path: {resolved}");
                continue;
            }
            // Refuse a path that IS a managed root or a shared structural dir (${dataDir},
            // ${modelsDir}, ${binDir}, ${dataDir}/venvs, …). remove_dir_all on one of these
            // would nuke every OTHER service's files + the model library — a hostile or buggy
            // template's "Uninstall <ServiceX>" must only touch ServiceX's own subtree.
            if self.is_protected_uninstall_root(Path::new(&resolved)) {
                log::warn!("uninstall {id}: refusing managed-root/structural path: {resolved}");
                continue;
            }
            // Refuse a glob sitting DIRECTLY in a managed root (e.g. `${modelsDir}/*`
            // or `${modelsDir}/Q*`) — it could enumerate the user's whole library.
            let pb = Path::new(&resolved);
            if pb.file_name().and_then(|n| n.to_str()).is_some_and(|f| f.contains('*'))
                && pb.parent().is_some_and(|par| self.is_managed_root(par))
            {
                log::warn!("uninstall {id}: refusing root-level glob: {resolved}");
                continue;
            }
            removed += remove_matching(&resolved);
        }
        if let Some(svc) = self.services.get_mut(id) {
            svc.set_status(ServiceStatus::Stopped, None);
            svc.error = None;
        }
        // SRV-001: the run exe / marker may just have been removed — refresh
        // this one service's installed verdict (and the snapshot revision).
        self.refresh_installed_for(id);
        self.touch();
        log::info!("uninstall {id}: removed {removed} item(s)");
        Ok(removed)
    }

    /// Whether the service's run executable exists on disk. Mirrors start()'s resolution: a
    /// path command must exist; a bare command resolves to ${binDir} first, then PATH (e.g. a
    /// system-installed `ollama`). The fallback "is it installed" signal for a service with no
    /// install-completion marker.
    fn run_command_exists(&self, run_command: &str, port: u16) -> bool {
        let raw = os_fix_path(substitute(run_command, &self.ctx(port)));
        if raw.contains(std::path::is_separator) {
            // NEVER stat a UNC / network path. run.command is attacker-controlled by an
            // imported template, and this runs on every (unprivileged) GET /api/services
            // poll before the service is ever started. A value like `\\attacker\share\x`
            // would make .exists() do an outbound SMB/WebDAV stat — leaking the user's NTLM
            // hash and hanging for the SMB timeout while holding the registry lock (DoS).
            if raw.starts_with("\\\\") || raw.starts_with("//") {
                return false;
            }
            return Path::new(&raw).exists();
        }
        let bin = self.data_dir.join("bin").join(&raw);
        if bin.with_extension("exe").exists() || bin.exists() {
            return true;
        }
        std::env::var("PATH").is_ok_and(|path| {
            std::env::split_paths(&path).any(|dir| {
                let p = dir.join(&raw);
                p.exists() || p.with_extension("exe").exists()
            })
        }) || user_programs_exe(&raw).is_some()
    }

    /// The resolved path of a service's install-completion marker, if it declares one.
    fn install_marker_path(&self, template: &ServiceTemplate, port: u16) -> Option<String> {
        template
            .installed_marker
            .as_ref()
            .map(|m| os_fix_path(substitute(m, &self.ctx(port))))
    }

    /// One-time migration for installs that predate the install-completion marker: their venv
    /// interpreter exists but the marker doesn't, so they'd wrongly read as not-installed.
    /// Backfill the marker when the run executable IS present (the prior "installed" heuristic)
    /// but the marker is missing — preserving existing installs' behavior, while NEW installs
    /// get the accurate marker from reap_exited (so a partial install reads as not-installed).
    pub fn backfill_install_markers(&mut self) {
        // ONE-TIME migration, gated by a persisted sentinel. WITHOUT this gate backfill re-runs
        // every launch and — because run_command_exists only sees the venv interpreter, created
        // at install step 1 — would re-bless a NEW failed install (interpreter present, marker
        // absent) as installed on the next restart, defeating the marker's whole purpose. A
        // pre-feature install already read installed under the old run-exe heuristic, so
        // migrating it ONCE is behavior-preserving; afterwards only reap_exited (installer exit
        // 0) ever writes a marker, so a post-migration partial install stays not-installed.
        let sentinel = self.data_dir.join(".install-markers-backfilled");
        if sentinel.exists() {
            return;
        }
        let mut backfilled: Vec<String> = Vec::new();
        for svc in self.services.values() {
            let Some(marker) = self.install_marker_path(&svc.template, svc.port) else {
                continue;
            };
            if Path::new(&marker).exists()
                || !self.run_command_exists(&svc.template.run.command, svc.port)
            {
                continue;
            }
            if let Some(parent) = Path::new(&marker).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::write(&marker, "installed by formlogic\n").is_ok() {
                backfilled.push(svc.template.id.clone());
            }
        }
        // SRV-001: the markers just written flip these services' installed
        // verdicts — reflect that in the cache now rather than waiting for
        // the next background probe pass.
        if !backfilled.is_empty() {
            for id in backfilled {
                self.installed_cache.insert(id, true);
            }
            self.touch();
        }
        let _ = std::fs::write(&sentinel, "");
    }

    pub fn snapshot(&self) -> RegistrySnapshot {
        let mut services: Vec<ServiceSnapshot> = self
            .services
            .values()
            .map(|s| ServiceSnapshot {
                id: s.template.id.clone(),
                name: s.template.name.clone(),
                description: s.template.description.clone(),
                category: s.template.category.clone(),
                status: s.status,
                error: s.error.clone(),
                port: s.port,
                default_port: s.template.default_port,
                pid: s.runner.as_ref().map(|r| r.pid),
                started_at: s.runner.as_ref().map(|r| r.started_at),
                last_status_change: s.last_status_change,
                docs_url: s.template.docs_url.clone(),
                installable: !matches!(s.template.install, InstallSpec::None),
                uninstallable: s.template.uninstall.is_some(),
                // SRV-001: served from the background-maintained cache — the
                // snapshot itself must NEVER stat the filesystem (this used to
                // walk the whole PATH per bare-command service on every poll).
                installed: self
                    .installed_cache
                    .get(&s.template.id)
                    .copied()
                    .unwrap_or(false),
                gpu: self.service_gpus.get(&s.template.id).copied(),
                autostart: self
                    .autostart_policies
                    .get(&s.template.id)
                    .copied()
                    .unwrap_or_default(),
                last_exit: s.last_exit.clone(),
                node: s.template.node.as_ref().map(|n| {
                    // Resolve companion-side `${...}` placeholders (e.g.
                    // `${ollamaModel}`) in the node body BEFORE the web app sees
                    // it — the web compiler only handles `{{...}}` vars.
                    let mut n = n.clone();
                    if let Some(bt) = &n.body_template {
                        n.body_template = Some(substitute(bt, &self.ctx(s.port)));
                    }
                    n
                }),
            })
            .collect();
        services.sort_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));
        RegistrySnapshot {
            services,
            data_dir: self.data_dir.display().to_string(),
            revision: self.revision,
            generated_at: Utc::now(),
            build_ms: 0.0,
        }
    }

    /// SRV-001: the pre-serialized snapshot body for the current revision.
    /// `GET /api/services` calls ONLY this — a cache hit is an Arc clone; a
    /// miss rebuilds from in-memory state (no filesystem, no process probing)
    /// and records how long the build took.
    pub fn snapshot_cached(&mut self) -> Arc<String> {
        if let Some(c) = &self.snapshot_cache {
            if c.revision == self.revision {
                return c.body.clone();
            }
        }
        let t0 = std::time::Instant::now();
        let mut snap = self.snapshot();
        snap.build_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let body = Arc::new(serde_json::to_string(&snap).unwrap_or_else(|e| {
            format!("{{\"services\":[],\"dataDir\":\"\",\"error\":\"snapshot serialize failed: {e}\"}}")
        }));
        self.snapshot_cache = Some(SnapshotCache {
            revision: self.revision,
            body: body.clone(),
        });
        body
    }

    /// SRV-001: collect the (cheap, in-memory) probe targets for every
    /// service. Placeholder resolution happens here under the lock; all
    /// filesystem work happens in [`probe_installed`] with NO lock held.
    pub fn installed_probe_targets(&self) -> Vec<InstalledProbe> {
        self.services
            .values()
            .map(|s| {
                let kind = match self.install_marker_path(&s.template, s.port) {
                    Some(marker) => InstalledProbeKind::Marker(PathBuf::from(marker)),
                    None => InstalledProbeKind::Command {
                        resolved: os_fix_path(substitute(
                            &s.template.run.command,
                            &self.ctx(s.port),
                        )),
                        bin_dir: self.data_dir.join("bin"),
                    },
                };
                InstalledProbe {
                    id: s.template.id.clone(),
                    kind,
                }
            })
            .collect()
    }

    /// SRV-001: fold background probe results into the installed cache.
    /// Bumps the revision only when a verdict actually changed.
    pub fn apply_installed_results(&mut self, results: &[(String, bool)]) {
        let mut changed = false;
        for (id, installed) in results {
            // A service can be deleted between collect + apply — don't
            // resurrect a stale cache entry for it.
            if !self.services.contains_key(id) {
                continue;
            }
            if self.installed_cache.insert(id.clone(), *installed) != Some(*installed) {
                changed = true;
            }
        }
        if changed {
            self.touch();
        }
    }

    /// SRV-001: synchronous full refresh of the installed cache (targets +
    /// filesystem probe + apply, all inline). Startup-only — everywhere else
    /// the split collect/probe/apply keeps FS work off the lock.
    pub fn refresh_installed_now(&mut self) {
        let targets = self.installed_probe_targets();
        let results = probe_installed(&targets);
        self.apply_installed_results(&results);
    }

    /// SRV-001: targeted single-service refresh after install / uninstall /
    /// import. One marker or bin-dir stat (plus a PATH walk for bare commands)
    /// — acceptable inline for an explicit user action on one service.
    fn refresh_installed_for(&mut self, id: &str) {
        let Some(s) = self.services.get(id) else {
            self.installed_cache.remove(id);
            return;
        };
        let target = InstalledProbe {
            id: id.to_string(),
            kind: match self.install_marker_path(&s.template, s.port) {
                Some(marker) => InstalledProbeKind::Marker(PathBuf::from(marker)),
                None => InstalledProbeKind::Command {
                    resolved: os_fix_path(substitute(&s.template.run.command, &self.ctx(s.port))),
                    bin_dir: self.data_dir.join("bin"),
                },
            },
        };
        let results = probe_installed(std::slice::from_ref(&target));
        self.apply_installed_results(&results);
    }

    /// SRV-001: the templates dir path — the background refresher fingerprints
    /// it OUTSIDE the lock.
    pub fn templates_dir(&self) -> PathBuf {
        self.data_dir.join("templates")
    }

    /// SRV-001: compare + store a freshly computed templates-dir fingerprint.
    /// Returns true when it differs from the last observed one (i.e. the dir
    /// changed and `reload_new_templates` is worth calling).
    pub fn note_templates_fingerprint(
        &mut self,
        fp: Option<(usize, std::time::SystemTime)>,
    ) -> bool {
        if self.templates_fp == fp {
            return false;
        }
        self.templates_fp = fp;
        true
    }

    /// Map venv name → ids of services whose run spec references it
    /// (`.../venvs/<name>/...`). Powers the Python tab's "used by …" line so
    /// a venv shows which services depend on it before you delete it. The
    /// Python module doesn't know about the registry, so the HTTP layer
    /// folds this into the python snapshot's `bound_services`.
    pub fn venv_usage(&self) -> HashMap<String, Vec<String>> {
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for (id, svc) in &self.services {
            let run = &svc.template.run;
            let mut fields: Vec<&str> = vec![run.command.as_str()];
            fields.extend(run.args.iter().map(|s| s.as_str()));
            fields.extend(run.env.values().map(|s| s.as_str()));
            if let Some(c) = &run.cwd {
                fields.push(c.as_str());
            }
            let mut seen = std::collections::HashSet::new();
            for f in fields {
                if let Some(name) = venv_name_in(f) {
                    if seen.insert(name.clone()) {
                        out.entry(name).or_default().push(id.clone());
                    }
                }
            }
        }
        for ids in out.values_mut() {
            ids.sort();
        }
        out
    }

    /// Recent log lines for `id`. While an install is in flight the
    /// installer's logs take precedence (that's what the user is staring
    /// at the LogsViewer for). Once install completes the installer is
    /// dropped and we fall back to the main service runner's logs.
    pub fn logs(&self, id: &str, tail: Option<usize>) -> Option<Vec<LogLine>> {
        let svc = self.services.get(id)?;
        // A live service shows its own process logs.
        if matches!(svc.status, ServiceStatus::Running | ServiceStatus::Starting) {
            if let Some(r) = &svc.runner {
                return Some(r.logs.snapshot(tail));
            }
        }
        // While installing, the installer's output is what the user is watching
        // (a stale runner from a previous run must not shadow it).
        if svc.status == ServiceStatus::Installing {
            if let Some(installer) = &svc.installer {
                return Some(installer.logs.snapshot(tail));
            }
        }
        // Stopped / Errored: prefer the runner if it actually produced output —
        // that's the most recent activity (e.g. a crash traceback). We KEEP the
        // runner after exit now, so crash logs survive. Fall back to the
        // installer (an install that failed before the service ever ran), which
        // we also KEEP after it exits.
        if let Some(r) = &svc.runner {
            let snap = r.logs.snapshot(tail);
            if !snap.is_empty() {
                return Some(snap);
            }
        }
        if let Some(installer) = &svc.installer {
            return Some(installer.logs.snapshot(tail));
        }
        None
    }

    /// Build the placeholder context for substitute().
    fn ctx(&self, port: u16) -> HashMap<&'static str, String> {
        let mut m = HashMap::new();
        m.insert("port", port.to_string());
        m.insert("dataDir", self.data_dir.display().to_string());
        m.insert("binDir", self.data_dir.join("bin").display().to_string());
        m.insert("modelsDir", self.models_dir.display().to_string());
        // Where a self-contained package's `files` are materialized, so its
        // run.command/args/env/cwd can reference bundled scripts by
        // `${scriptsDir}/name` (matches materialize_package_files' target dir).
        m.insert("scriptsDir", self.data_dir.join("scripts").display().to_string());
        // All search roots joined by the OS path separator (`;` on Windows),
        // so a service env like `"LTX2_MODEL_DIRS": "${modelDirs}"` can scan
        // several drives. Primary is always first.
        m.insert("modelDirs", join_model_dirs(&self.model_dirs));
        // Single-model LLM servers (llama.cpp) load ONE gguf via `-m
        // ${llamaModel}`. Inserted ONLY when the user has explicitly picked a
        // model — there is NO implicit default. Left unset, `${llamaModel}`
        // stays unsubstituted and start() refuses to spawn (a clear "pick a
        // model" error) rather than guessing a `model.gguf` that may not exist.
        if let Some(model) = self.llama_model.clone().filter(|s| !s.trim().is_empty()) {
            m.insert("llamaModel", model);
        }
        // Multi-model servers (Ollama) take a model NAME per request; the
        // companion resolves the user's pick into the node body template via
        // `${ollamaModel}`. ALWAYS set (with the pre-pulled default) so a node
        // never ships a literal `${ollamaModel}`.
        m.insert(
            "ollamaModel",
            self.ollama_model
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "qwen2.5:0.5b".to_string()),
        );
        m
    }

    /// Spawn the service identified by `id`. Returns Err if the template
    /// doesn't exist or the spawn fails. Currently a no-op when the
    /// service is already Running.
    pub fn start(&mut self, id: &str) -> Result<(), String> {
        self.start_with(id, true)
    }

    /// The real start. `manual` (a Start click / API call / boot restore)
    /// resets the crash-supervision counters and records the service in the
    /// remembered-running set; the automatic crash-restart path passes
    /// `false` so its attempt counter survives across restarts and the
    /// crash-loop breaker can trip (DESK-PROC-001).
    fn start_with(&mut self, id: &str, manual: bool) -> Result<(), String> {
        // SRV-001: any start attempt can mutate status/error — invalidate the
        // cached snapshot up front (over-bumping is harmless).
        self.touch();
        // Extract everything we need under a read-only borrow first so
        // we can call `self.ctx(...)` (which also borrows `self`) without
        // hitting the borrow checker. `RunSpec.clone()` is cheap — small
        // String/Vec/HashMap allocs, and start() isn't hot.
        let (port, run_spec, status) = {
            let svc = self.services.get(id).ok_or("unknown service")?;
            (svc.port, svc.template.run.clone(), svc.status)
        };
        if status == ServiceStatus::Running {
            return Ok(());
        }
        // An install in flight owns svc.installer + the bin/venv dirs. Falling
        // through would set_status(Starting) (clobbering Installing so the
        // installer is never reaped), spawn over a half-built install, and orphan
        // the installer. install_streaming() refuses the reverse collision; mirror
        // it here. ensure_by_port funnels this Err into a benign "not started".
        if status == ServiceStatus::Installing {
            return Err(format!(
                "{id}: install in progress — wait for it to finish before starting"
            ));
        }

        let ctx = self.ctx(port);

        // Resolve the command — if it doesn't already have a path
        // separator, try ${binDir} first, fall back to PATH lookup
        // (which Command::spawn does naturally).
        let raw_cmd = os_fix_path(substitute(&run_spec.command, &ctx));
        let resolved_cmd = if raw_cmd.contains(std::path::is_separator) {
            raw_cmd
        } else {
            let bin_dir = self.data_dir.join("bin").join(&raw_cmd);
            let candidates = [bin_dir.with_extension("exe"), bin_dir.clone()];
            candidates
                .iter()
                .find(|p| p.exists())
                .map(|p| p.display().to_string())
                // Resolve a just-installed system tool (e.g. ollama) to its real path so the
                // spawn doesn't fall back to the bare name + the companion's stale PATH (which
                // wouldn't find it until a restart) and Error out.
                .or_else(|| user_programs_exe(&raw_cmd).map(|p| p.display().to_string()))
                .unwrap_or(raw_cmd)
        };

        let mut args: Vec<String> = run_spec
            .args
            .iter()
            .map(|a| os_fix_path(substitute(a, &ctx)))
            .collect();
        // Optional multimodal projector for the single-model llama service
        // (the template that loads `${llamaModel}`): llama-server only accepts
        // input_audio/image content parts when launched with --mmproj. Only
        // appended when the user picked one, so text-only setups are untouched.
        if let Some(mm) = self.llama_mmproj.clone().filter(|s| !s.trim().is_empty()) {
            if run_spec.args.iter().any(|a| a.contains("${llamaModel}")) {
                args.push("--mmproj".to_string());
                args.push(os_fix_path(mm));
            }
        }
        let mut env: HashMap<String, String> = run_spec
            .env
            .iter()
            .map(|(k, v)| (k.clone(), substitute(v, &ctx)))
            .collect();
        // Pin to a chosen GPU if the user assigned one in the GPU picker — so e.g.
        // llama.cpp runs on GPU 1 while krea2 keeps GPU 0, instead of both defaulting to
        // GPU 0 and exhausting its VRAM. CUDA_VISIBLE_DEVICES re-indexes, so the service
        // sees the chosen card as cuda:0 (a multi-GPU service like krea2 then runs on the
        // one card — encoder falls back to CPU; left unset it keeps its dual-GPU default).
        if let Some(gpu) = self.service_gpus.get(id).copied() {
            // The picker shows nvidia-smi indices (PCI-bus order), but CUDA defaults to
            // CUDA_DEVICE_ORDER=FASTEST_FIRST — so on a HETEROGENEOUS box "GPU 1" could map
            // to a different physical card than the user picked. Force PCI_BUS_ID so the two
            // index spaces line up; don't clobber a template that set its own order.
            env.entry("CUDA_DEVICE_ORDER".to_string())
                .or_insert_with(|| "PCI_BUS_ID".to_string());
            env.insert("CUDA_VISIBLE_DEVICES".to_string(), gpu.to_string());
        }
        let cwd = run_spec.cwd.as_deref().map(|c| os_fix_path(substitute(c, &ctx)));

        // A required, user-chosen value the template references but that's unset
        // leaves `${llamaModel}` literal (no implicit default) — refuse to spawn
        // with a bogus path and tell the user exactly what to do.
        if resolved_cmd.contains("${llamaModel}")
            || args.iter().any(|a| a.contains("${llamaModel}"))
            || env.values().any(|v| v.contains("${llamaModel}"))
            || cwd.as_deref().is_some_and(|c| c.contains("${llamaModel}"))
        {
            return Err(format!(
                "{id}: no model selected — pick one in the service's Model selector first"
            ));
        }

        // Default the working dir to the data dir (not the inherited process CWD) when the
        // template doesn't set one, for the same reason as install: a bare helper the run
        // command shells out to can't then be hijacked by a planted binary in an attacker-
        // writable CWD (Windows searches CWD before System32/PATH).
        let data_dir_cwd = self.data_dir.display().to_string();
        let cfg = SpawnConfig {
            command: &resolved_cmd,
            args: &args,
            env: &env,
            cwd: cwd.as_deref().or(Some(data_dir_cwd.as_str())),
        };

        // PROC-001: name a missing binary BEFORE spawning — "spawn failed: The
        // system cannot find the file specified" tells the operator nothing;
        // "not installed — run Install" does. Only when the command resolved to
        // a concrete path (bare names legitimately fall back to PATH lookup).
        if resolved_cmd.contains(std::path::is_separator) && !Path::new(&resolved_cmd).exists() {
            let msg = format!(
                "{id}: binary not installed ({resolved_cmd} is missing) — run Install first"
            );
            let svc = self.services.get_mut(id).ok_or("unknown service")?;
            svc.set_status(ServiceStatus::Errored, Some(msg.clone()));
            return Err(msg);
        }

        // Now take a mutable borrow to update status + stash the runner.
        let svc = self.services.get_mut(id).ok_or("unknown service")?;
        // Tear down any lingering process from a previous (Errored / health-failed)
        // run before replacing it. Runner has no Drop, so simply overwriting
        // svc.runner below would orphan the old process (zombie + port conflict).
        let had_own_process = svc.runner.is_some();
        if let Some(old) = svc.runner.take() {
            kill_process_tree(old.pid);
            old.abandon();
            svc.own_teardown_at = Some(Utc::now());
        }
        // PROC-001: name a busy port BEFORE spawning. Only when WE didn't just
        // tear our own previous process down (its port can linger for a beat —
        // kill_process_tree is fire-and-forget on every OS, see SRV-001 grace) —
        // a fresh start against a foreign holder would otherwise spawn, lose
        // the bind race, and surface as an opaque crash loop.
        if !had_own_process
            && !own_teardown_recent(svc.own_teardown_at, Utc::now())
            && port_in_use(port)
        {
            let msg = format!(
                "{id}: port {port} is already in use by another process (not one this desktop \
                 started) — close it, or change the service's port, then press Start"
            );
            svc.set_status(ServiceStatus::Errored, Some(msg.clone()));
            return Err(msg);
        }
        svc.set_status(ServiceStatus::Starting, None);
        // DESK-PROC-001: a manual start resets crash supervision (the
        // operator explicitly re-armed it); the auto-restart path keeps its
        // counters so the crash-loop breaker can trip.
        if manual {
            svc.restart_attempts = 0;
            svc.restart_at = None;
            svc.last_crash_at = None;
        }
        // PROC-001: a fresh run has not proven readiness yet.
        svc.ever_healthy = false;

        match Runner::spawn(cfg) {
            Ok(runner) => {
                svc.runner = Some(Arc::new(runner));
                // We optimistically flip to Running. A future health-check
                // task can downgrade to Errored / upgrade to confirmed
                // Running, but the immediate UI feedback is "it's
                // starting → it spawned, looking good".
                svc.set_status(ServiceStatus::Running, None);
                // DESK-PROC-001: remember it as operator-running so a desktop
                // relaunch restores it (explicit Stop forgets; shutdown's
                // stop_all deliberately doesn't).
                if self.remembered_running.insert(id.to_string()) {
                    persist_remembered_running(
                        &self.data_dir.join("services-running.json"),
                        &self.remembered_running,
                    );
                }
                Ok(())
            }
            Err(e) => {
                let msg = format!("spawn failed: {e}");
                svc.set_status(ServiceStatus::Errored, Some(msg.clone()));
                Err(msg)
            }
        }
    }

    /// DESK-PROC-001 + PROC-001: start services at boot per their autostart
    /// policy — `Always` starts unconditionally, `Never` never starts, `Auto`
    /// (default) restores the remembered-running set from the previous
    /// session. Called once at boot AFTER the saved model selection + GPU
    /// pins are applied (they affect the spawn env). Failures are logged per
    /// service and never block the rest.
    pub fn autostart_remembered(&mut self) -> Vec<String> {
        let ids: Vec<String> = self
            .services
            .keys()
            .filter(|id| {
                should_autostart(
                    self.autostart_policies.get(*id).copied().unwrap_or_default(),
                    self.remembered_running.contains(*id),
                )
            })
            .cloned()
            .collect();
        let mut restored = Vec::new();
        for id in ids {
            match self.start_with(&id, true) {
                Ok(()) => {
                    log::info!("autostarted service {id} (policy/previous session)");
                    restored.push(id);
                }
                Err(e) => log::warn!("could not autostart service {id}: {e}"),
            }
        }
        restored
    }

    /// PROC-001: set (and persist) a service's boot-autostart policy.
    pub fn set_autostart(&mut self, id: &str, policy: AutostartPolicy) -> Result<(), String> {
        if !self.services.contains_key(id) {
            return Err("unknown service".to_string());
        }
        if policy == AutostartPolicy::Auto {
            self.autostart_policies.remove(id);
        } else {
            self.autostart_policies.insert(id.to_string(), policy);
        }
        persist_autostart_policies(
            &self.data_dir.join("services-autostart.json"),
            &self.autostart_policies,
        );
        self.touch();
        Ok(())
    }

    /// PROC-001: one-click repair — reset every piece of supervision state a
    /// wedged service can be stuck on (crash-loop breaker, scheduled restart,
    /// stale process tree, stale error) and start it fresh. When the port is
    /// held by a FOREIGN process even after our own tree is gone, refuse with
    /// a named diagnosis instead of spawning into a doomed bind race.
    pub fn repair(&mut self, id: &str) -> Result<(), String> {
        // SRV-001: repair mutates supervision state — invalidate the cached
        // snapshot up front.
        self.touch();
        {
            let svc = self.services.get_mut(id).ok_or("unknown service")?;
            if svc.status == ServiceStatus::Installing {
                return Err(format!(
                    "{id}: install in progress — wait for it to finish before repairing"
                ));
            }
            // Tear down anything of ours that's still alive.
            if let Some(runner) = svc.runner.take() {
                kill_process_tree(runner.pid);
                runner.abandon();
                svc.own_teardown_at = Some(Utc::now());
            }
            // Reset supervision state: the operator explicitly re-armed it.
            svc.restart_attempts = 0;
            svc.restart_at = None;
            svc.last_crash_at = None;
            svc.set_status(ServiceStatus::Stopped, None);
            let port = svc.port;
            // SRV-001: the kill above is fire-and-forget, so our own dying
            // process may legitimately hold the port for a beat — only a port
            // held OUTSIDE the teardown grace is a named foreign holder. (If a
            // foreign process really does hold it, the spawn loses the bind
            // race and the crash-restart's next probe names it a cycle later.)
            if !own_teardown_recent(svc.own_teardown_at, Utc::now()) && port_in_use(port) {
                let msg = format!(
                    "{id}: port {port} is still in use by another process (not one this desktop \
                     started) — close it, then press Start"
                );
                svc.set_status(ServiceStatus::Errored, Some(msg.clone()));
                return Err(msg);
            }
        }
        self.start_with(id, true)
    }

    /// DESK-PROC-001: start any crashed service whose scheduled automatic
    /// restart is due. Driven by the same 2 s reaper tick as `reap_exited`.
    pub fn run_scheduled_restarts(&mut self) {
        let now = Utc::now();
        let due: Vec<String> = self
            .services
            .values()
            .filter(|s| {
                s.status == ServiceStatus::Errored && s.restart_at.is_some_and(|t| t <= now)
            })
            .map(|s| s.template.id.clone())
            .collect();
        for id in due {
            let attempt = match self.services.get_mut(&id) {
                Some(svc) => {
                    svc.restart_at = None;
                    svc.restart_attempts
                }
                None => continue,
            };
            log::info!("auto-restarting crashed service {id} (attempt {attempt})");
            if let Err(e) = self.start_with(&id, false) {
                // Spawn failure ends automatic recovery for this crash (the
                // error is already on the service card); a later crash of a
                // successful restart schedules afresh.
                log::warn!("auto-restart of {id} failed: {e}");
            }
        }
    }

    pub fn stop(&mut self, id: &str) -> Result<(), String> {
        // SRV-001: stop mutates status/remembered state — invalidate the
        // cached snapshot up front.
        self.touch();
        // DESK-PROC-001: an explicit Stop means "the operator wants it not
        // running" — forget it (so it won't be restored at boot) and cancel
        // any pending crash-restart.
        if self.remembered_running.remove(id) {
            persist_remembered_running(
                &self.data_dir.join("services-running.json"),
                &self.remembered_running,
            );
        }
        let svc = self.services.get_mut(id).ok_or("unknown service")?;
        svc.restart_at = None;
        svc.restart_attempts = 0;
        svc.last_crash_at = None;
        if let Some(runner) = svc.runner.take() {
            // The runner may have spawned children (a shell wrapper, python
            // subprocesses); a plain kill of the direct child would orphan
            // them, so tree-kill by pid and hand the child handle over to it
            // (abandon — see Runner::abandon for the ordering rationale).
            kill_process_tree(runner.pid);
            runner.abandon();
            svc.own_teardown_at = Some(Utc::now());
        }
        // Stop during an in-flight install: the live process tree is owned by
        // svc.installer (the script + its pip/curl/git children), NOT runner — so
        // runner.take() above is a no-op for it. Tear the installer's tree down too
        // (keeping the handle so its log buffer stays visible, like cancel_install).
        // Otherwise it keeps pulling GBs invisibly (reap_exited only reaps it while
        // status==Installing) and a later start() would spawn over the half-built
        // install, the exact collision start()/install_streaming() guard against.
        if svc.status == ServiceStatus::Installing {
            if let Some(installer) = &svc.installer {
                kill_process_tree(installer.pid);
                installer.abandon();
                svc.own_teardown_at = Some(Utc::now());
            }
        }
        svc.set_status(ServiceStatus::Stopped, None);
        Ok(())
    }

    /// Ensure the service listening on `port` is running, starting it if
    /// needed. This is the companion-side mirror of the desktop's
    /// `ensure_service_ready_by_port`: formlogic-web calls it (over HTTP) right
    /// before hitting a `127.0.0.1:<port>` endpoint that a companion
    /// service owns, so picking a stopped companion service in a flow and
    /// running it "just works" — no manual Start click first.
    ///
    /// Returns immediately after kicking off the spawn (the AI/HTTP nodes
    /// already retry on connection refused / 503 while a server warms up),
    /// so the HTTP handler never blocks for the full boot time.
    pub fn ensure_by_port(&mut self, port: u16) -> EnsureByPortResult {
        // Find the service configured for this port. `port` on the runtime
        // reflects the active/overridable port; fall back to default_port.
        let id = self
            .services
            .values()
            .find(|s| s.port == port || s.template.default_port == port)
            .map(|s| s.template.id.clone());

        let Some(id) = id else {
            return EnsureByPortResult {
                found: false,
                already_running: false,
                started: false,
                id: None,
                name: None,
                error: None,
            };
        };

        let (name, status) = self
            .services
            .get(&id)
            .map(|s| (s.template.name.clone(), s.status))
            .unwrap_or((String::new(), ServiceStatus::Stopped));

        if status == ServiceStatus::Running {
            return EnsureByPortResult {
                found: true,
                already_running: true,
                started: false,
                id: Some(id),
                name: Some(name),
                error: None,
            };
        }

        match self.start(&id) {
            Ok(()) => EnsureByPortResult {
                found: true,
                already_running: false,
                started: true,
                id: Some(id),
                name: Some(name),
                error: None,
            },
            Err(e) => EnsureByPortResult {
                found: true,
                already_running: false,
                started: false,
                id: Some(id),
                name: Some(name),
                error: Some(e),
            },
        }
    }

    /// Poll for unexpected exits and update status. Cheap — only walks
    /// services that currently think they're Running or Installing.
    pub fn reap_exited(&mut self) {
        // SRV-001: this runs on the 2 s tick — bump the snapshot revision only
        // when something actually changed, so an idle system keeps serving the
        // same cached body (and clients can skip re-rendering on it).
        let mut changed = false;
        // Services whose install just succeeded (exit 0) + declare an install-completion marker.
        // Collected here, written AFTER the loop so we can resolve the marker path via self.ctx
        // (an immutable borrow) without conflicting with the mutable services iteration.
        let mut mark_installed: Vec<(String, u16, String)> = Vec::new();
        // SRV-001: marker-less services whose install just succeeded — their
        // installed verdict needs a filesystem re-probe (done after the loop).
        let mut reprobe_installed: Vec<String> = Vec::new();
        for svc in self.services.values_mut() {
            // Reap the install script if one's in flight.
            if svc.status == ServiceStatus::Installing {
                if let Some(installer) = &svc.installer {
                    if let Some(code) = installer.check_exited() {
                        if code == 0 {
                            match svc.template.installed_marker.clone() {
                                Some(marker) => mark_installed
                                    .push((svc.template.id.clone(), svc.port, marker)),
                                // SRV-001: no marker → installed-ness derives
                                // from the run exe the installer just laid
                                // down; re-probe this one service after the
                                // loop so the card flips without waiting for
                                // the next background pass.
                                None => reprobe_installed.push(svc.template.id.clone()),
                            }
                        }
                        // KEEP the installer (and its LogBuffer) so a failed
                        // install's output stays visible in the LogsViewer —
                        // previously we dropped it here, so the logs vanished
                        // the instant the install errored. install_streaming
                        // replaces it on the next install; logs() prefers the
                        // runner once the service is actually running.
                        let err = if code == 0 {
                            None
                        } else {
                            Some(format!("install failed (exit code {code}) — open Logs for details"))
                        };
                        svc.set_status(
                            if code == 0 {
                                ServiceStatus::Stopped
                            } else {
                                ServiceStatus::Errored
                            },
                            err,
                        );
                        changed = true;
                    }
                }
                continue;
            }
            if svc.status != ServiceStatus::Running {
                continue;
            }
            if let Some(runner) = &svc.runner {
                if let Some(code) = runner.check_exited() {
                    // KEEP the runner (and its LogBuffer) so a crashed service's
                    // stderr/traceback stays visible in the LogsViewer — dropping
                    // it here made crash logs vanish the instant the process died
                    // (e.g. Lance's "No module named flash_attn"). start() replaces
                    // it on restart; logs() prefers the runner's output once it has
                    // any, falling back to the installer otherwise.
                    // PROC-001: record structured exit diagnostics — code, when,
                    // and the final stderr lines — so the snapshot names the
                    // failure without a trip through the full log.
                    svc.last_exit = Some(ExitDiagnostics {
                        code: Some(code),
                        at: Utc::now(),
                        stderr_tail: exit_stderr_tail(&runner.logs.snapshot(None)),
                    });
                    changed = true;
                    if code == 0 {
                        // A clean spontaneous exit is presumed intentional
                        // (the service shut itself down) — no auto-restart.
                        svc.set_status(ServiceStatus::Stopped, None);
                    } else {
                        // DESK-PROC-001: schedule an automatic restart with
                        // exponential backoff. A crash long after the previous
                        // one starts a fresh attempt window; five rapid
                        // crashes trip the breaker and recovery stops until
                        // the operator presses Start.
                        let now = Utc::now();
                        let quiet = !svc
                            .last_crash_at
                            .is_some_and(|t| (now - t).num_seconds() <= RESTART_QUIET_SECS);
                        if quiet {
                            svc.restart_attempts = 0;
                        }
                        svc.last_crash_at = Some(now);
                        let msg = match next_restart(svc.restart_attempts) {
                            Some((attempt, delay)) => {
                                svc.restart_attempts = attempt;
                                svc.restart_at = Some(now + chrono::Duration::seconds(delay));
                                format!(
                                    "process exited (code {code}) — auto-restart {attempt}/5 in {delay}s; open Logs for details"
                                )
                            }
                            None => {
                                svc.restart_at = None;
                                format!(
                                    "process exited (code {code}) — crash-looping (5 rapid restarts); auto-restart disabled, press Start to try again. Open Logs for details"
                                )
                            }
                        };
                        svc.set_status(ServiceStatus::Errored, Some(msg));
                    }
                }
            }
        }
        // Write the install-completion marker for any service whose installer just exited 0, so
        // run_installed() flips it to installed=true. A partial/failed install (non-zero exit →
        // no marker) correctly stays not-installed even though its venv interpreter exists.
        for (id, port, marker) in mark_installed {
            let resolved = os_fix_path(substitute(&marker, &self.ctx(port)));
            if let Some(parent) = Path::new(&resolved).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::write(&resolved, "installed by formlogic\n") {
                // SRV-001: we just wrote the marker ourselves — flip the
                // cached installed verdict directly (no filesystem re-probe).
                Ok(()) => {
                    self.installed_cache.insert(id, true);
                    changed = true;
                }
                Err(e) => log::warn!("could not write install marker {resolved}: {e}"),
            }
        }
        for id in reprobe_installed {
            self.refresh_installed_for(&id);
        }
        if changed {
            self.touch();
        }
    }

    /// Snapshot of (service id, resolved health URL) pairs for every
    /// service that's currently Running AND has a health template. The
    /// background health ticker uses this — it walks the list outside
    /// the lock, hits each URL, then folds results back in via
    /// `apply_health_results`. Keeping the lock-time short matters
    /// because users hit /api/services constantly and we don't want a
    /// slow check blocking the UI.
    pub fn health_targets(&self) -> Vec<(String, String, u64)> {
        let mut out = Vec::new();
        for (id, svc) in &self.services {
            // Probe Running services (to catch a real failure) AND Errored ones
            // whose process is STILL ALIVE — so a service wrongly faulted while its
            // model was loading can RECOVER, but a crashed one (runner kept only
            // for its logs, child slot already reaped) is NOT resurrected by a
            // stale/reused listener answering on its port.
            let probe = svc.status == ServiceStatus::Running
                || (svc.status == ServiceStatus::Errored
                    && svc.runner.as_ref().is_some_and(|r| r.is_alive()));
            if !probe {
                continue;
            }
            let Some(spec) = &svc.template.health else { continue };
            let url = spec.url.replace("${port}", &svc.port.to_string());
            out.push((id.clone(), url, spec.timeout_secs));
        }
        out
    }

    /// Apply health-probe results. A success RECOVERS a service that was
    /// previously (wrongly) Errored — e.g. faulted while its model was still
    /// loading. A failure only faults a Running service AFTER its startup grace
    /// window (the health timeout), so a slow model load isn't flagged.
    pub fn apply_health_results(&mut self, results: &[(String, bool)]) {
        let now = Utc::now();
        // SRV-001: tick-driven — bump the snapshot revision only on a real
        // state change, so a healthy steady state keeps the cached body valid.
        let mut changed = false;
        for (id, ok) in results {
            let Some(svc) = self.services.get_mut(id) else { continue };
            if *ok {
                // PROC-001: this run has proven readiness — a later probe
                // failure is a runtime fault, not a readiness-deadline breach.
                svc.ever_healthy = true;
                // Healthy probe: bring a service that was faulted while it was
                // still coming up back to Running — but ONLY if its process is
                // genuinely alive, so a dead service isn't resurrected by some
                // other listener that happens to answer on its port.
                if svc.status == ServiceStatus::Errored
                    && svc.runner.as_ref().is_some_and(|r| r.is_alive())
                {
                    svc.set_status(ServiceStatus::Running, None);
                    changed = true;
                }
                continue;
            }
            // Failed probe: only fault a Running service, and only once it's had
            // its health-timeout to come up (the model may still be loading —
            // llama.cpp doesn't bind its port until after the model loads).
            if svc.status != ServiceStatus::Running {
                continue;
            }
            let grace = svc
                .template
                .health
                .as_ref()
                .map(|h| h.timeout_secs)
                .unwrap_or(30) as i64;
            let within_grace = svc
                .runner
                .as_ref()
                .map(|r| (now - r.started_at).num_seconds() < grace)
                .unwrap_or(false);
            if within_grace {
                continue;
            }
            // PROC-001: distinguish "never became ready" (readiness deadline,
            // likely misconfigured) from "was ready, then failed" (runtime
            // fault) — the operator's next step differs.
            svc.set_status(
                ServiceStatus::Errored,
                Some(readiness_failure_message(svc.ever_healthy, grace)),
            );
            changed = true;
        }
        if changed {
            self.touch();
        }
    }

    /// Resolve the install script path for `id` on the current OS, or
    /// return Err if the template doesn't have one.
    pub fn install_script(&self, id: &str) -> Result<PathBuf, String> {
        let svc = self.services.get(id).ok_or("unknown service")?;
        let (win, unix) = match &svc.template.install {
            InstallSpec::None => return Err("template has no install script".into()),
            InstallSpec::Script { windows, unix } => (windows.as_deref(), unix.as_deref()),
        };
        let name = if cfg!(windows) { win } else { unix }.ok_or_else(|| {
            format!(
                "no install script for {} on {}",
                id,
                if cfg!(windows) { "windows" } else { "unix" }
            )
        })?;
        // The install script must live directly under scripts/. Reject any
        // absolute path, `..`, or path separator so a template's install field
        // can't steer the installer at an arbitrary file (Path::join replaces
        // the base on an absolute component and honours `..`). Mirrors the
        // bare-name guard in materialize_package_files / delete_model.
        let is_bare = Path::new(name)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|f| f == name)
            .unwrap_or(false);
        if !is_bare || name.starts_with('.') {
            return Err(format!("invalid install script name: {name}"));
        }
        let p = self.data_dir.join("scripts").join(name);
        if !p.exists() {
            return Err(format!("install script missing: {}", p.display()));
        }
        Ok(p)
    }

    /// Kick off the install script in the background. Returns immediately;
    /// the script's stdout/stderr stream into the service's installer
    /// LogBuffer (visible via /api/services/:id/logs) and `reap_exited()`
    /// flips the status to Stopped or Errored on completion.
    ///
    /// Why streaming instead of blocking `.output()`? Some installs take
    /// minutes (llama.cpp CUDA zip is ~500 MB), and the user wants to
    /// see "Downloading…" + "Extracting…" lines tick by — same UX as
    /// running the .ps1 in a console themselves.
    pub fn install_streaming(&mut self, id: &str) -> Result<(), String> {
        let script = self.install_script(id)?;

        // Block double-installs, and refuse to install over a LIVE service —
        // its running process would be orphaned (Runner has no Drop), so the
        // user must stop it first.
        if let Some(svc) = self.services.get(id) {
            if svc.status == ServiceStatus::Installing {
                return Err("install already in progress".into());
            }
            if matches!(svc.status, ServiceStatus::Running | ServiceStatus::Starting) {
                return Err("stop the service before installing/reinstalling it".into());
            }
        }
        // Errored-with-live-runner: a service faulted while still coming up (a slow
        // model load past the health grace) keeps its process ALIVE while status is
        // Errored — which the guard above doesn't catch. Runner has no Drop, so
        // installing over it would orphan that process: it locks the live binary /
        // venv the installer overwrites + holds the port, and once status flips to
        // Installing reap_exited never reaps it. Tear it down first, exactly as
        // start() does before respawning, so Reinstall just works from Errored.
        if let Some(svc) = self.services.get_mut(id) {
            if svc.runner.as_ref().is_some_and(|r| r.is_alive()) {
                if let Some(old) = svc.runner.take() {
                    kill_process_tree(old.pid);
                    old.abandon();
                    svc.own_teardown_at = Some(Utc::now());
                }
            }
        }

        let bin_dir = self.data_dir.join("bin").display().to_string();
        let models_dir = self.models_dir.display().to_string();
        let data_dir = self.data_dir.display().to_string();
        let venvs_dir = self.data_dir.join("venvs").display().to_string();
        let scripts_dir = self.data_dir.join("scripts").display().to_string();

        // Dispatch by script extension so a service can ship a one-click
        // `.bat` (cmd) installer as well as a `.ps1`. A `.bat` sidesteps the
        // PowerShell-5.1 ANSI-codepage parse trap entirely (see python.rs)
        // and is double-clickable outside the app too.
        let script_str = script.display().to_string();
        let ext = script
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let (cmd_str, args_vec): (String, Vec<String>) = if cfg!(windows) {
            match ext.as_str() {
                "bat" | "cmd" => (system32_exe("cmd.exe"), vec!["/C".into(), script_str]),
                _ => (
                    system32_exe("WindowsPowerShell\\v1.0\\powershell.exe"),
                    vec![
                        "-NoProfile".into(),
                        "-ExecutionPolicy".into(),
                        "Bypass".into(),
                        "-File".into(),
                        script_str,
                    ],
                ),
            }
        } else {
            ("sh".to_string(), vec![script_str])
        };

        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("FORMLOGIC_BIN_DIR".into(), bin_dir);
        env.insert("FORMLOGIC_MODELS_DIR".into(), models_dir);
        // All registered model roots (primary + extras), os-pathsep-joined, so
        // an installer can scan every drive the user added in Settings.
        env.insert("FORMLOGIC_MODEL_DIRS".into(), join_model_dirs(&self.model_dirs));
        // Extra vars so a Python-service installer can locate the bundled
        // interpreter (`%FORMLOGIC_DATA_DIR%\python\python.exe`), the shared venvs
        // root, and seeded helper scripts without hard-coding the data dir.
        env.insert("FORMLOGIC_DATA_DIR".into(), data_dir);
        env.insert("FORMLOGIC_VENVS_DIR".into(), venvs_dir);
        env.insert("FORMLOGIC_SCRIPTS_DIR".into(), scripts_dir);

        let cfg = SpawnConfig {
            command: &cmd_str,
            args: &args_vec,
            env: &env,
            // Run the installer in the data dir, not the inherited process CWD: the install
            // scripts shell out to bare helpers (curl/tar/where/git/robocopy) and Windows
            // searches the CWD before System32/PATH, so a planted binary in an attacker-
            // writable CWD would otherwise run during install. (Reuses the FORMLOGIC_DATA_DIR value.)
            cwd: env.get("FORMLOGIC_DATA_DIR").map(String::as_str),
        };

        let runner = Runner::spawn(cfg).map_err(|e| {
            let msg = format!("install spawn failed: {e}");
            if let Some(svc) = self.services.get_mut(id) {
                svc.set_status(ServiceStatus::Errored, Some(msg.clone()));
            }
            msg
        })?;

        let svc = self.services.get_mut(id).ok_or("unknown service")?;
        svc.installer = Some(Arc::new(runner));
        svc.set_status(ServiceStatus::Installing, None);
        self.touch();
        Ok(())
    }

    /// Cancel an in-flight install. The installer is `cmd /C <script>` (or
    /// `sh`), which spawns children (pip, python downloads); killing just the
    /// shell would orphan those, so we kill the whole process TREE. The
    /// installer's LogBuffer is kept so the user still sees where it stopped.
    pub fn cancel_install(&mut self, id: &str) -> Result<(), String> {
        let svc = self.services.get_mut(id).ok_or("unknown service")?;
        if svc.status != ServiceStatus::Installing {
            return Err("no install is in progress for this service".into());
        }
        if let Some(installer) = &svc.installer {
            kill_process_tree(installer.pid);
            installer.abandon();
            svc.own_teardown_at = Some(Utc::now());
        }
        svc.set_status(ServiceStatus::Stopped, Some("install cancelled".into()));
        self.touch();
        Ok(())
    }

    /// Stop every running service AND tear down any in-flight installer
    /// (called on app exit).
    pub fn stop_all(&mut self) {
        let ids: Vec<String> = self.services.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
            // stop() only handles the runner; an in-flight install is owned by
            // svc.installer (cmd /C <script> → pip/curl/powershell children).
            // Tear it down too so quitting doesn't leave a detached download or
            // build running unmanaged.
            if let Some(svc) = self.services.get_mut(&id) {
                if let Some(installer) = svc.installer.take() {
                    kill_process_tree(installer.pid);
                    installer.abandon();
                }
            }
        }
    }

    /// Create or replace a service template from a UI form. Writes to
    /// `templates/<id>.json` and refreshes the in-memory entry. Refuses
    /// to clobber a currently-Running service so the user doesn't lose
    /// the live runner reference.
    pub fn add_template(&mut self, template: ServiceTemplate) -> Result<(), String> {
        if !valid_service_id(&template.id) {
            return Err("service id must be lowercase letters/digits/dash/underscore (1–64 chars)".into());
        }
        if let Some(existing) = self.services.get(&template.id) {
            if existing.status == ServiceStatus::Running
                || existing.status == ServiceStatus::Installing
            {
                return Err(format!(
                    "service {} is {:?}; stop it before editing",
                    template.id, existing.status
                ));
            }
        }
        let path = self
            .data_dir
            .join("templates")
            .join(format!("{}.json", template.id));
        let json = serde_json::to_string_pretty(&template)
            .map_err(|e| format!("serialize: {e}"))?;
        // Write atomically: lay down a sibling .tmp then rename over the
        // target. rename is atomic on the same volume, so a crash mid-write
        // can never leave a half-written / corrupt template behind.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("rename {} -> {}: {e}", tmp.display(), path.display()));
        }
        // Lay down any bundled scripts so a self-contained imported package is
        // immediately installable/runnable.
        if !template.files.is_empty() {
            materialize_package_files(&self.data_dir.join("scripts"), &template.id, &template.files);
        }
        let id = template.id.clone();
        self.services.insert(id.clone(), ServiceRuntime::new(template));
        // SRV-001: seed this service's installed verdict now (explicit user
        // action, one service) instead of waiting for the background pass,
        // and refresh the templates fingerprint so the background refresher
        // doesn't re-parse the dir for a change we just made ourselves.
        self.refresh_installed_for(&id);
        self.templates_fp = templates_fingerprint(&self.data_dir.join("templates"));
        self.touch();
        Ok(())
    }

    /// Build a shareable, self-contained package for `id`: the template with
    /// every script it references inlined into `files`, so the result is one
    /// JSON that installs + runs anywhere with no recompile. Best-effort
    /// bundling: includes the install script(s) plus any file in the scripts
    /// dir whose name appears in the template JSON or the install script's own
    /// text (so helper scripts the installer calls come along too).
    pub fn export_package(&self, id: &str) -> Result<ServiceTemplate, String> {
        let svc = self.services.get(id).ok_or("unknown service")?;
        let mut t = svc.template.clone();
        // A self-contained template already declares its authoritative file set;
        // capture it so export round-trips those completely (re-read from disk to
        // pick up hand-edits), regardless of whether each name appears in `hay`.
        let declared: Vec<String> = t.files.keys().cloned().collect();
        t.files.clear();
        let scripts_dir = self.data_dir.join("scripts");

        // Haystack of names to search for: the serialized template (catches
        // run.command/args refs) + the install scripts' own text (catches
        // helpers the installer shells out to, e.g. fetch_zip.py).
        let mut hay = serde_json::to_string(&t).unwrap_or_default();
        if let InstallSpec::Script { windows, unix } = &t.install {
            for n in [windows.as_deref(), unix.as_deref()].into_iter().flatten() {
                hay.push(' ');
                hay.push_str(n);
                if let Ok(s) = std::fs::read_to_string(scripts_dir.join(n)) {
                    hay.push('\n');
                    hay.push_str(&s);
                }
            }
        }

        let mut files = HashMap::new();
        // The template's own declared files are authoritative — always include
        // them (re-read for hand-edits), so a self-contained package round-trips
        // even if a name doesn't happen to appear in the haystack.
        for name in &declared {
            if let Ok(body) = std::fs::read_to_string(scripts_dir.join(name)) {
                files.insert(name.clone(), body);
            }
        }
        // Plus any other script in the dir whose name is referenced by the
        // template/install text (helpers the installer shells out to).
        if let Ok(rd) = std::fs::read_dir(&scripts_dir) {
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_file() {
                    continue;
                }
                let Some(fname) = p.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                // Skip hidden snapshot files + already-included declared files.
                if fname.starts_with('.') || files.contains_key(fname) || !hay.contains(fname) {
                    continue;
                }
                if let Ok(body) = std::fs::read_to_string(&p) {
                    files.insert(fname.to_string(), body);
                }
            }
        }
        t.files = files;
        Ok(t)
    }

    /// Re-scan the templates dir and register any package whose id isn't loaded
    /// yet — so dropping a `*.json` into `templates/` (or an Import) shows up
    /// live, no restart. Existing services (incl. running ones) are left
    /// untouched, so this is safe to call on every poll. Returns how many were
    /// newly added. Bundled `files` are materialized for the new ones.
    pub fn reload_new_templates(&mut self) -> usize {
        let dir = self.data_dir.join("templates");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return 0;
        };
        let scripts_dir = self.data_dir.join("scripts");
        let mut added = 0usize;
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let t: ServiceTemplate = match serde_json::from_str(&raw) {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("skipping bad template {}: {}", path.display(), e);
                    continue;
                }
            };
            // Already known (by id) — don't disturb its in-memory/runtime state.
            if self.services.contains_key(&t.id) {
                continue;
            }
            if !t.files.is_empty() {
                materialize_package_files(&scripts_dir, &t.id, &t.files);
            }
            log::info!("dynamically loaded service '{}' from {}", t.id, path.display());
            let id = t.id.clone();
            self.services.insert(id.clone(), ServiceRuntime::new(t));
            // SRV-001: seed the new service's installed verdict immediately —
            // this path only runs when the templates fingerprint changed
            // (folder drop / import), never on the GET hot path.
            self.refresh_installed_for(&id);
            added += 1;
        }
        if added > 0 {
            self.touch();
        }
        added
    }

    /// Remove a template + its on-disk JSON. Refuses if Running.
    pub fn delete_template(&mut self, id: &str) -> Result<(), String> {
        if let Some(svc) = self.services.get(id) {
            if svc.status == ServiceStatus::Running
                || svc.status == ServiceStatus::Installing
            {
                return Err(format!("service {id} is {:?}; stop it first", svc.status));
            }
        } else {
            return Err("unknown service".into());
        }
        let path = self
            .data_dir
            .join("templates")
            .join(format!("{}.json", id));
        // Best-effort file removal — if it's missing on disk but in
        // memory (shouldn't happen normally) we still proceed.
        let _ = std::fs::remove_file(&path);
        self.services.remove(id);
        self.installed_cache.remove(id);
        self.templates_fp = templates_fingerprint(&self.data_dir.join("templates"));
        self.touch();
        Ok(())
    }
}

/// Kill a process and its descendants. The installer shell spawns pip /
/// python downloaders; a plain kill of the shell would orphan them (they'd
/// keep downloading), so use the OS tree-kill.
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // SRV-001: fire-and-forget (`spawn`, not `status`) — parity with the
        // always-detached Unix branch below. The old blocking `.status()` wait
        // ran UNDER the registry mutex on every stop/repair/restart, stalling
        // concurrent `GET /api/services` for the taskkill round trip. Callers
        // stamp `own_teardown_at` and the pre-spawn port probe tolerates the
        // brief window where the dying process still holds its port.
        let _ = std::process::Command::new(system32_exe("taskkill.exe"))
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(not(windows))]
    {
        // Negative pid = the process GROUP (the shell + its children). Graceful
        // SIGTERM, then escalate to SIGKILL after a short grace so a descendant
        // that ignores/slow-handles TERM (pip/curl/git mid-download, a Chromium
        // renderer under Playwright) can't linger and keep a port bound — matching
        // the forceful `taskkill /T /F` on Windows. Detached (no .wait()) so app
        // exit / a held Registry lock never blocks on the grace sleep.
        let _ = std::process::Command::new("sh")
            .args([
                "-c",
                &format!("kill -TERM -{pid} 2>/dev/null; sleep 2; kill -KILL -{pid} 2>/dev/null"),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

fn valid_service_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Trim a model selection and treat all-whitespace/empty as "unset" (`None`).
/// Shared by `set_llama_model` / `set_ollama_model`.
fn clean_model_opt(model: Option<String>) -> Option<String> {
    model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Extract the venv name from a path-ish string containing a `venvs/<name>`
/// (or `venvs\<name>`) segment — e.g. `${dataDir}/venvs/ltx2/Scripts/python.exe`
/// → `Some("ltx2")`. Returns None when there's no such segment.
fn venv_name_in(s: &str) -> Option<String> {
    let norm = s.replace('\\', "/");
    let idx = norm.find("venvs/")?;
    let rest = &norm[idx + "venvs/".len()..];
    let name: String = rest.chars().take_while(|&c| c != '/').collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

pub type RegistryHandle = Arc<Mutex<Registry>>;

/// SRV-001: one background maintenance pass — the filesystem work that used to
/// run inline (under the registry mutex!) on EVERY `GET /api/services` poll:
/// per-service installed probing (bin-dir stats + PATH walks) and templates-dir
/// re-parsing. Collect under a short lock → probe with NO lock → apply under a
/// short lock; templates are re-parsed only when the dir fingerprint changed.
/// Callers drive this on a ~10 s cadence from a blocking-pool task.
pub fn background_refresh(registry: &RegistryHandle) {
    // Phase A: collect targets under a short lock (string/placeholder work only).
    let (targets, templates_dir) = {
        let reg = registry.lock().unwrap_or_else(|e| e.into_inner());
        (reg.installed_probe_targets(), reg.templates_dir())
    };
    // Phase B: every filesystem stat happens here, lock-free.
    let results = probe_installed(&targets);
    let fp = templates_fingerprint(&templates_dir);
    // Phase C: fold back in under a short lock. reload_new_templates does
    // read+parse under the lock, but ONLY when the fingerprint changed (a
    // folder drop / import) — never on the steady-state path.
    let mut reg = registry.lock().unwrap_or_else(|e| e.into_inner());
    reg.apply_installed_results(&results);
    if reg.note_templates_fingerprint(fp) {
        reg.reload_new_templates();
    }
}

#[cfg(test)]
mod tests {
    use super::venv_name_in;
    use super::{load_remembered_running, next_restart, persist_remembered_running};
    use super::{
        exit_stderr_tail, load_autostart_policies, persist_autostart_policies, port_in_use,
        readiness_failure_message, should_autostart, AutostartPolicy,
    };
    use chrono::Utc;
    use std::collections::HashMap;
    use std::sync::Arc;

    /// DESK-PROC-001 backoff decision table: exponential delays, then the
    /// crash-loop breaker.
    #[test]
    fn restart_backoff_escalates_then_trips_the_breaker() {
        assert_eq!(next_restart(0), Some((1, 2)));
        assert_eq!(next_restart(1), Some((2, 4)));
        assert_eq!(next_restart(2), Some((3, 8)));
        assert_eq!(next_restart(3), Some((4, 16)));
        assert_eq!(next_restart(4), Some((5, 32)));
        // Five rapid restarts spent → crash-looping, stop automatic recovery.
        assert_eq!(next_restart(5), None);
        assert_eq!(next_restart(99), None);
    }

    /// DESK-PROC-001: the remembered-running set survives a round trip, and a
    /// missing/corrupt file collapses to empty (pre-feature behaviour).
    #[test]
    fn remembered_running_round_trips_and_tolerates_corruption() {
        let dir = std::env::temp_dir().join(format!(
            "fl-services-running-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("services-running.json");

        assert!(load_remembered_running(&path).is_empty(), "missing file → empty");

        let ids: std::collections::HashSet<String> =
            ["llama-cpp", "aokie-voice"].iter().map(|s| s.to_string()).collect();
        persist_remembered_running(&path, &ids);
        assert_eq!(load_remembered_running(&path), ids);

        std::fs::write(&path, "{not json").unwrap();
        assert!(load_remembered_running(&path).is_empty(), "corrupt file → empty");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PROC-001: the boot-autostart decision table — `Always` regardless of
    /// last session, `Never` never, `Auto` restores the remembered set.
    #[test]
    fn autostart_policy_decision_table() {
        use super::AutostartPolicy::*;
        assert!(should_autostart(Always, false));
        assert!(should_autostart(Always, true));
        assert!(!should_autostart(Never, true));
        assert!(!should_autostart(Never, false));
        assert!(should_autostart(Auto, true));
        assert!(!should_autostart(Auto, false));
    }

    /// PROC-001: autostart policies persist (Auto entries omitted) and a
    /// missing/corrupt file collapses to all-Auto.
    #[test]
    fn autostart_policies_round_trip_and_tolerate_corruption() {
        let dir = std::env::temp_dir().join(format!(
            "fl-services-autostart-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("services-autostart.json");

        assert!(load_autostart_policies(&path).is_empty(), "missing file → all Auto");

        let mut policies = HashMap::new();
        policies.insert("llama-cpp".to_string(), AutostartPolicy::Always);
        policies.insert("krea2".to_string(), AutostartPolicy::Never);
        policies.insert("ollama".to_string(), AutostartPolicy::Auto);
        persist_autostart_policies(&path, &policies);
        let loaded = load_autostart_policies(&path);
        assert_eq!(loaded.get("llama-cpp"), Some(&AutostartPolicy::Always));
        assert_eq!(loaded.get("krea2"), Some(&AutostartPolicy::Never));
        assert_eq!(loaded.get("ollama"), None, "Auto is the default — never persisted");

        std::fs::write(&path, "{not json").unwrap();
        assert!(load_autostart_policies(&path).is_empty(), "corrupt file → all Auto");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PROC-001: a never-ready service reports a readiness-deadline breach
    /// (misconfiguration posture, points at Repair); a was-ready one reports
    /// a runtime fault. Same Errored state, different operator action.
    #[test]
    fn readiness_message_distinguishes_never_ready_from_fell_over() {
        let never = readiness_failure_message(false, 30);
        assert!(never.contains("did not become ready within 30s"), "got: {never}");
        assert!(never.contains("Repair"), "got: {never}");
        let fell = readiness_failure_message(true, 30);
        assert!(fell.contains("stopped responding"), "got: {fell}");
        assert!(!fell.contains("readiness deadline"), "got: {fell}");
    }

    /// PROC-001: the exit stderr tail keeps only the LAST stderr lines, in
    /// order, length-capped — a summary, never a second log pipeline.
    #[test]
    fn exit_stderr_tail_filters_caps_and_preserves_order() {
        use crate::services::runner::LogLine;
        let line = |stream: &'static str, text: &str| LogLine {
            timestamp: Utc::now(),
            stream,
            text: text.to_string(),
        };
        let mut lines: Vec<LogLine> = (0..10)
            .map(|i| line("stderr", &format!("err {i}")))
            .collect();
        lines.push(line("stdout", "noise that must not appear"));
        lines.push(line("stderr", &"x".repeat(400)));

        let tail = exit_stderr_tail(&lines);
        assert_eq!(tail.len(), 6, "capped at 6 lines");
        assert!(tail.iter().all(|t: &String| !t.contains("noise")), "stdout excluded");
        // Order preserved: the oldest kept line comes first, the capped long
        // line (the newest) last.
        assert_eq!(tail[0], "err 5");
        assert!(tail[5].ends_with('…'), "long line capped: {}", &tail[5][..40]);
        assert!(tail[5].len() < 400);
    }

    /// PROC-001: the pre-spawn port probe — busy loopback port detected,
    /// free port passes.
    #[test]
    fn port_probe_names_a_busy_port() {
        let holder = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = holder.local_addr().unwrap().port();
        assert!(port_in_use(port), "held port must probe busy");
        drop(holder);
        assert!(!port_in_use(port), "released port must probe free");
    }

    #[test]
    fn extracts_venv_name_from_run_command() {
        // Forward + back slashes, with the `${dataDir}` placeholder intact.
        assert_eq!(
            venv_name_in("${dataDir}/venvs/ltx2/Scripts/python.exe").as_deref(),
            Some("ltx2")
        );
        assert_eq!(
            venv_name_in("${dataDir}\\venvs\\lance\\Scripts\\python.exe").as_deref(),
            Some("lance")
        );
        assert_eq!(
            venv_name_in("C:/data/venvs/playwright/Scripts/python.exe").as_deref(),
            Some("playwright")
        );
    }

    #[test]
    fn no_venv_segment_returns_none() {
        assert_eq!(venv_name_in("ollama"), None);
        assert_eq!(venv_name_in("${binDir}/llama-server.exe"), None);
        // `venvs/` with nothing after it is not a usable name.
        assert_eq!(venv_name_in("x/venvs/"), None);
    }

    #[test]
    fn all_builtin_templates_deserialize() {
        for (name, body) in super::BUILTIN_TEMPLATES {
            let t: super::ServiceTemplate = serde_json::from_str(body)
                .unwrap_or_else(|e| panic!("builtin template {name} failed to deserialize: {e}"));
            assert!(!t.id.is_empty(), "builtin template {name} has empty id");
        }
    }

    /// Retired-builtin sweep: pristine seeds (content == snapshot) are removed
    /// along with their snapshot; a hand-edited copy survives; an orphaned
    /// snapshot with no template goes away.
    #[test]
    fn retired_seed_sweep_removes_pristine_keeps_edited() {
        let dir = std::env::temp_dir().join(format!(
            "fl-retired-seeds-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("pristine.json"), "{\"id\":\"old\"}").unwrap();
        std::fs::write(dir.join(".pristine.json.seed"), "{\"id\":\"old\"}").unwrap();
        std::fs::write(dir.join("edited.json"), "{\"id\":\"mine\"}").unwrap();
        std::fs::write(dir.join(".edited.json.seed"), "{\"id\":\"old\"}").unwrap();
        std::fs::write(dir.join(".orphan.json.seed"), "{}").unwrap();

        super::remove_retired_seeds(
            &dir,
            &["pristine.json", "edited.json", "orphan.json", "never-existed.json"],
        );

        assert!(!dir.join("pristine.json").exists(), "pristine copy removed");
        assert!(!dir.join(".pristine.json.seed").exists(), "its snapshot removed");
        assert!(dir.join("edited.json").exists(), "edited copy kept");
        assert!(dir.join(".edited.json.seed").exists(), "edited snapshot kept");
        assert!(!dir.join(".orphan.json.seed").exists(), "orphan snapshot removed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn krea2_has_uninstall_and_central_models() {
        let (_, body) = super::BUILTIN_TEMPLATES
            .iter()
            .find(|(n, _)| *n == "krea2.json")
            .expect("krea2.json builtin");
        let t: super::ServiceTemplate = serde_json::from_str(body).expect("krea2 deserializes");
        // Uninstall removes the venv + repo (program files) so the button appears...
        let paths = &t.uninstall.expect("krea2 declares an uninstall spec").paths;
        assert!(
            paths.iter().any(|p| p == "${dataDir}/venvs/krea2"),
            "krea2 uninstall should remove its venv, got {paths:?}"
        );
        // ...but must NOT delete the central models (matches the "models not touched"
        // convention in the uninstall confirm dialog + avoids deleting a big download).
        assert!(
            !paths.iter().any(|p| p.contains("modelsDir")),
            "krea2 uninstall should NOT delete the central models dir, got {paths:?}"
        );
        // Models centralized: checkpoint + HF cache live under ${modelsDir}.
        assert!(
            body.contains("${modelsDir}/krea2/checkpoints"),
            "krea2 checkpoint should live under the central models dir"
        );
    }

    #[test]
    fn aokie_voice_is_a_speech_service_riding_the_plugin_install() {
        let (_, body) = super::BUILTIN_TEMPLATES
            .iter()
            .find(|(n, _)| *n == "aokie-voice.json")
            .expect("aokie-voice.json builtin");
        let t: super::ServiceTemplate = serde_json::from_str(body).expect("aokie-voice deserializes");
        assert_eq!(t.id, "aokie-voice");
        assert_eq!(t.category, "Speech");
        // The server binary ships WITH the Aokie plugin (dropped next to
        // aokie-plugin.exe) — no install spec of its own; `installed` derives
        // from the run exe existing under the plugin dir.
        assert!(
            matches!(t.install, super::InstallSpec::None),
            "aokie-voice must not declare its own installer"
        );
        assert!(
            t.run.command.starts_with("${dataDir}/plugins/aokie/"),
            "run command should live in the aokie plugin dir, got {}",
            t.run.command
        );
        assert!(t.health.is_some(), "aokie-voice should declare a health check");
    }

    #[test]
    fn uninstall_refuses_managed_roots_and_structural_dirs() {
        use std::path::PathBuf;
        let data = PathBuf::from("C:/formlogic/data");
        let models = PathBuf::from("C:/formlogic/models");
        let reg = super::Registry::empty(data.clone(), models.clone());
        // The data dir, the models dir, and the shared structural dirs must ALL be refused —
        // an uninstall removing one would remove_dir_all every OTHER service's files / the
        // whole model library, not just the service being uninstalled.
        let mut protected: Vec<PathBuf> = ["bin", "venvs", "services", "templates", "scripts"]
            .iter()
            .map(|s| data.join(s))
            .collect();
        protected.push(data.clone());
        protected.push(models.clone());
        for p in &protected {
            assert!(
                reg.is_protected_uninstall_root(p),
                "uninstall must REFUSE the root/structural path {}",
                p.display()
            );
        }
        // Per-service subtrees + the llama-cpp glob target sit STRICTLY under a structural
        // dir; the guard is an equality check (not a prefix), so they still pass through and
        // real built-in uninstalls keep working.
        for p in [
            data.join("venvs/krea2"),
            data.join("services/ltx2"),
            data.join("bin/llama-server.exe"),
            models.join("krea2/checkpoints"),
        ] {
            assert!(
                !reg.is_protected_uninstall_root(&p),
                "uninstall must ALLOW the per-service path {}",
                p.display()
            );
        }
    }

    #[test]
    fn package_files_cannot_overwrite_builtin_or_others_scripts() {
        use std::collections::HashMap;
        let dir = std::env::temp_dir().join(format!("formlogic-mpf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let reserved = super::reserved_script_names();
        assert!(
            !reserved.is_empty(),
            "reserved set should be populated from the built-ins"
        );
        // A name owned by a built-in script / built-in template.
        let reserved_name = reserved.iter().next().unwrap().clone();
        std::fs::write(dir.join(&reserved_name), "GENUINE").unwrap();
        // An imported package must NOT overwrite a built-in's script (cross-service RCE).
        let mut evil = HashMap::new();
        evil.insert(reserved_name.clone(), "EVIL".to_string());
        super::materialize_package_files(&dir, "attacker-pkg", &evil);
        assert_eq!(
            std::fs::read_to_string(dir.join(&reserved_name)).unwrap(),
            "GENUINE",
            "an imported package must not overwrite a built-in script"
        );

        // A package writes its OWN non-reserved helper → allowed + owned.
        let mut a = HashMap::new();
        a.insert("pkgA_helper.py".to_string(), "A".to_string());
        super::materialize_package_files(&dir, "pkgA", &a);
        assert_eq!(std::fs::read_to_string(dir.join("pkgA_helper.py")).unwrap(), "A");
        // A DIFFERENT package must NOT clobber pkgA's helper.
        let mut b = HashMap::new();
        b.insert("pkgA_helper.py".to_string(), "B".to_string());
        super::materialize_package_files(&dir, "pkgB", &b);
        assert_eq!(
            std::fs::read_to_string(dir.join("pkgA_helper.py")).unwrap(),
            "A",
            "package B must not overwrite package A's script"
        );
        // pkgA CAN refresh its own helper.
        let mut a2 = HashMap::new();
        a2.insert("pkgA_helper.py".to_string(), "A2".to_string());
        super::materialize_package_files(&dir, "pkgA", &a2);
        assert_eq!(
            std::fs::read_to_string(dir.join("pkgA_helper.py")).unwrap(),
            "A2"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn installed_marker_gates_installed_over_run_executable() {
        let data = std::env::temp_dir().join(format!("formlogic-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();

        let json = r#"{
            "id": "svc", "name": "Svc", "description": "", "category": "test",
            "defaultPort": 9999,
            "installedMarker": "${dataDir}/venvs/svc/.formlogic-installed",
            "run": { "command": "${dataDir}/venvs/svc/Scripts/python.exe", "args": [] }
        }"#;
        let t: super::ServiceTemplate = serde_json::from_str(json).unwrap();
        let mut reg = super::Registry::empty(data.clone(), data.join("models"));
        reg.services
            .insert("svc".to_string(), super::ServiceRuntime::new(t.clone()));
        // SRV-001: installed-ness is read from the cache, maintained via the
        // probe machinery — exercise it exactly the way the background pass does.
        let installed = |reg: &mut super::Registry| {
            reg.refresh_installed_for("svc");
            reg.installed_cache.get("svc").copied().unwrap_or(false)
        };

        // The venv interpreter exists (a partial install creates it at step 1) BUT no marker →
        // must read as NOT installed (this is the whole point of the marker).
        let interp = data.join("venvs/svc/Scripts/python.exe");
        std::fs::create_dir_all(interp.parent().unwrap()).unwrap();
        std::fs::write(&interp, "").unwrap();
        assert!(
            !installed(&mut reg),
            "interpreter present but no marker must read as not-installed"
        );

        // Marker present (installer exited 0) → installed.
        std::fs::write(data.join("venvs/svc/.formlogic-installed"), "").unwrap();
        assert!(installed(&mut reg), "marker present → installed");

        // backfill: a pre-marker install (interp present, marker removed) gets the marker back.
        std::fs::remove_file(data.join("venvs/svc/.formlogic-installed")).unwrap();
        let mut reg2 = super::Registry::empty(data.clone(), data.join("models"));
        reg2.services
            .insert("svc".to_string(), super::ServiceRuntime::new(t.clone()));
        reg2.backfill_install_markers();
        assert!(
            data.join("venvs/svc/.formlogic-installed").exists(),
            "backfill should restore the marker for an existing install (interp present)"
        );
        assert_eq!(
            reg2.installed_cache.get("svc"),
            Some(&true),
            "backfill must flip the cached installed verdict too"
        );

        // backfill is ONE-TIME (sentinel persisted): a NEW partial install after migration
        // (interpreter present, marker absent) must NOT be re-blessed on a later run/restart.
        std::fs::remove_file(data.join("venvs/svc/.formlogic-installed")).unwrap();
        reg2.backfill_install_markers();
        assert!(
            !data.join("venvs/svc/.formlogic-installed").exists(),
            "one-time backfill must not resurrect a post-migration partial install"
        );

        let _ = std::fs::remove_dir_all(&data);
    }

    /// SRV-001: the snapshot body is served from a revision-keyed cache — the
    /// same revision returns the SAME Arc (no rebuild), any mutation bumps the
    /// revision and produces a fresh body.
    #[test]
    fn snapshot_cache_hits_until_a_mutation_bumps_the_revision() {
        let data = std::env::temp_dir().join(format!("fl-snapcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        let mut reg = super::Registry::empty(data.clone(), data.join("models"));

        let a = reg.snapshot_cached();
        let b = reg.snapshot_cached();
        assert!(Arc::ptr_eq(&a, &b), "unchanged revision must serve the cached body");

        reg.set_ollama_model(Some("qwen2.5:7b".into()));
        let c = reg.snapshot_cached();
        assert!(!Arc::ptr_eq(&a, &c), "a mutation must invalidate the cached body");
        assert!(c.contains("\"revision\""), "snapshot carries its revision");
        assert!(c.contains("\"generatedAt\""), "snapshot carries generatedAt");
        assert!(c.contains("\"buildMs\""), "snapshot carries buildMs");

        let _ = std::fs::remove_dir_all(&data);
    }

    /// SRV-001: the lock-free installed prober — marker paths, bin-dir hits,
    /// and the UNC refusal (never stat a network path from a template field).
    #[test]
    fn probe_installed_covers_marker_bindir_and_unc() {
        use super::{probe_installed, InstalledProbe, InstalledProbeKind};
        let data = std::env::temp_dir().join(format!("fl-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let bin = data.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("mytool.exe"), "").unwrap();
        let marker = data.join("marker.txt");
        std::fs::write(&marker, "").unwrap();

        let targets = vec![
            InstalledProbe {
                id: "marker-present".into(),
                kind: InstalledProbeKind::Marker(marker.clone()),
            },
            InstalledProbe {
                id: "marker-missing".into(),
                kind: InstalledProbeKind::Marker(data.join("nope.txt")),
            },
            InstalledProbe {
                id: "bare-in-bindir".into(),
                kind: InstalledProbeKind::Command {
                    resolved: "mytool".into(),
                    bin_dir: bin.clone(),
                },
            },
            InstalledProbe {
                id: "unc-refused".into(),
                kind: InstalledProbeKind::Command {
                    resolved: "\\\\attacker\\share\\x.exe".into(),
                    bin_dir: bin.clone(),
                },
            },
        ];
        let results: std::collections::HashMap<String, bool> =
            probe_installed(&targets).into_iter().collect();
        assert_eq!(results["marker-present"], true);
        assert_eq!(results["marker-missing"], false);
        assert_eq!(results["bare-in-bindir"], true);
        assert_eq!(results["unc-refused"], false, "UNC paths must never be statted");

        let _ = std::fs::remove_dir_all(&data);
    }

    /// SRV-001: the templates-dir fingerprint changes when a json is added or
    /// removed — the background refresher's cheap "should I re-parse?" signal.
    #[test]
    fn templates_fingerprint_tracks_dir_changes() {
        let dir = std::env::temp_dir().join(format!("fl-tfp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let fp0 = super::templates_fingerprint(&dir);
        assert_eq!(fp0.map(|(n, _)| n), Some(0));
        std::fs::write(dir.join("a.json"), "{}").unwrap();
        let fp1 = super::templates_fingerprint(&dir);
        assert_ne!(fp0, fp1, "adding a template must change the fingerprint");
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let fp2 = super::templates_fingerprint(&dir);
        assert_eq!(
            fp1.map(|(n, _)| n),
            fp2.map(|(n, _)| n),
            "non-json files don't count"
        );
        std::fs::remove_file(dir.join("a.json")).unwrap();
        let fp3 = super::templates_fingerprint(&dir);
        assert_ne!(fp1.map(|(n, _)| n), fp3.map(|(n, _)| n));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// SRV-001: the own-teardown port-probe grace — a port lingering right
    /// after OUR fire-and-forget kill is expected teardown; outside the window
    /// (or with no teardown at all) the foreign-holder probe runs.
    #[test]
    fn own_teardown_grace_window() {
        use super::own_teardown_recent;
        let now = Utc::now();
        assert!(!own_teardown_recent(None, now), "no teardown → probe runs");
        assert!(
            own_teardown_recent(Some(now - chrono::Duration::seconds(2)), now),
            "2s after our own kill → inside the grace"
        );
        assert!(
            !own_teardown_recent(Some(now - chrono::Duration::seconds(30)), now),
            "30s later → grace expired, probe runs"
        );
    }
}
