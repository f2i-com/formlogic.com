//! Plugin registry — discovery, lifecycle state, and persistence.
//!
//! Plugins are directories under `<data_dir>/plugins/<id>/` with a
//! `manifest.json` (see `plugins::manifest`). The host scans that root at
//! startup and on every `GET /api/plugins`, so dropping a plugin folder in
//! is enough to register it — no restart.
//!
//! Lifecycle states (SDK contract §2):
//! `installed → stopped → starting → running → (unhealthy | crashed) → stopped`,
//! plus `disabled` (user opt-out / invalid manifest / version-incompatible —
//! always WITH a visible reason, never a silent skip).
//!
//! A small `registry.json` next to the plugin dirs persists the user's
//! disabled flags + last known state across restarts.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::events::EventBus;
use crate::plugins::manifest::{parse_manifest, parse_semver, ConnectorDecl, PluginManifest};
use crate::plugins::rpc::{LogRing, RpcErrorObj};
use crate::plugins::runner::RunningPlugin;

/// Oldest stdio protocol version this desktop still speaks. Bump both ends
/// deliberately; a plugin outside `[MIN, PLUGIN_API_VERSION]` is refused with
/// state `disabled` + reason.
pub const SUPPORTED_PLUGIN_API_MIN: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginState {
    Installed,
    Stopped,
    Starting,
    Running,
    Unhealthy,
    Crashed,
    Disabled,
}

impl PluginState {
    /// True while a supervisor task owns (or is bringing up) a process.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            PluginState::Starting | PluginState::Running | PluginState::Unhealthy
        )
    }
}

/// Result of the most recent `plugin.health` probe.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub at: DateTime<Utc>,
    pub ok: bool,
    /// "ok" | "degraded" | "error" from the plugin, or "unreachable" when the
    /// probe timed out / the transport is gone.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The plugin's full component readiness (radio/outbox/config/build …) —
    /// retained verbatim so the support bundle and readiness UIs see WHY,
    /// not just a status word (audit CROSS-OBS-001 / INT-006).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<serde_json::Value>,
}

/// Everything the host tracks about one plugin. Runtime-only — the wire view
/// is [`PluginSnapshot`].
pub(crate) struct PluginSlot {
    /// None when the manifest failed to parse/validate (state = disabled).
    pub manifest: Option<PluginManifest>,
    pub dir: PathBuf,
    pub state: PluginState,
    /// Why it's disabled/crashed — surfaced verbatim in the UI.
    pub reason: Option<String>,
    /// The persisted user opt-out (survives restarts + rescans).
    pub user_disabled: bool,
    pub logs: LogRing,
    /// The live process handle set while a supervisor runs it.
    pub running: Option<Arc<RunningPlugin>>,
    /// The plugin's event-receipt journal handle, set when a run opens it —
    /// retained after stop so retention sweeps go through the OWNING instance
    /// (never a second writer on the same file). DATA-PRIV-001.
    pub receipts: Option<Arc<crate::plugins::receipts::EventReceipts>>,
    /// Bumped on every (re)start/stop; a supervisor whose generation no longer
    /// matches must not touch the slot (stale crash reports can't clobber a
    /// newer run).
    pub generation: u64,
    /// Auto-restarts performed since the last manual start (max 3).
    pub restart_attempts: u32,
    pub last_health: Option<HealthReport>,
    pub started_at: Option<DateTime<Utc>>,
    pub pid: Option<u32>,
    /// TRUST-001: the package-signature assessment from the last scan
    /// (re-checked again at launch). Tampered ⇒ quarantined (Disabled).
    pub package_trust: crate::plugins::package_trust::PackageTrust,
}

impl PluginSlot {
    fn new(dir: PathBuf) -> Self {
        Self {
            manifest: None,
            dir,
            state: PluginState::Installed,
            reason: None,
            user_disabled: false,
            logs: LogRing::new(),
            running: None,
            receipts: None,
            generation: 0,
            restart_attempts: 0,
            last_health: None,
            started_at: None,
            pid: None,
            package_trust: crate::plugins::package_trust::PackageTrust::Unsigned,
        }
    }
}

/// Wire shape of one plugin in `GET /api/plugins` — everything the panel
/// needs: identity, lifecycle, health, and the declared surface.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSnapshot {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub state: PluginState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub dir: String,
    pub plugin_api_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_desktop_version: Option<String>,
    pub capabilities: Vec<String>,
    pub connectors: Vec<ConnectorDecl>,
    pub events: Vec<String>,
    pub pid: Option<u32>,
    pub started_at: Option<DateTime<Utc>>,
    pub last_health: Option<HealthReport>,
    pub restart_attempts: u32,
    /// TRUST-001: "verified" | "unsigned" | "tampered".
    pub package: &'static str,
    /// Publisher key id + bundle version for a verified package.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_detail: Option<String>,
}

/// Persisted per-plugin entry in `registry.json`.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedEntry {
    #[serde(default)]
    disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_state: Option<PluginState>,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedRegistry {
    #[serde(default)]
    plugins: HashMap<String, PersistedEntry>,
}

pub type PluginHostHandle = Arc<PluginHost>;

/// A future returned by a [`PluginRpcHandler`] (manually boxed to keep the
/// handler object-safe without pulling in `async-trait`).
pub type PluginRpcFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<serde_json::Value, RpcErrorObj>> + Send>>;

/// Routes INBOUND plugin requests (`flow.run`) to the flow runtime. The
/// FlowRuntime implements this and registers it via [`PluginHost::set_rpc_handler`];
/// the plugin supervisor pump calls it after the manifest capability check.
pub trait PluginRpcHandler: Send + Sync {
    fn handle(&self, plugin_id: String, method: String, params: serde_json::Value) -> PluginRpcFuture;
}

/// The plugin host: shared by the HTTP layer, the supervisors, and (in the
/// GUI) the exit hook. Tauri-free, so both binaries use it identically.
pub struct PluginHost {
    /// `<data_dir>/plugins` — one subdir per plugin.
    pub(crate) plugins_root: PathBuf,
    /// `<data_dir>/plugin-data/<id>` — the per-plugin WRITABLE dir handed to
    /// the process as `FORMLOGIC_PLUGIN_DATA_DIR` (kept outside the plugin
    /// dir so wiping/reinstalling a plugin never nukes its data).
    pub(crate) plugin_data_root: PathBuf,
    registry_path: PathBuf,
    pub(crate) dev_mode: bool,
    pub(crate) events: EventBus,
    pub(crate) plugins: Mutex<HashMap<String, PluginSlot>>,
    /// Handler for inbound plugin requests (`flow.run`); set once a FormLogic
    /// account is linked. `None` ⇒ answer `flow.run` with a "not linked" error.
    pub(crate) rpc_handler: Mutex<Option<Arc<dyn PluginRpcHandler>>>,
    /// Receipt accountability guard (WORK-DUR-001): applied to every plugin's
    /// receipt journal so rotation/retention never drops an entry that is the
    /// only durable copy of an acked event. Set by the flow runtime.
    pub(crate) receipts_guard: Mutex<Option<Arc<crate::plugins::receipts::AccountedFn>>>,
}

impl PluginHost {
    /// Build the host, load persisted flags, and run the initial scan.
    pub fn new(data_dir: &Path, dev_mode: bool, events: EventBus) -> PluginHostHandle {
        let plugins_root = data_dir.join("plugins");
        let plugin_data_root = data_dir.join("plugin-data");
        let _ = std::fs::create_dir_all(&plugins_root);
        let _ = std::fs::create_dir_all(&plugin_data_root);
        let registry_path = plugins_root.join("registry.json");
        let host = Arc::new(Self {
            plugins_root,
            plugin_data_root,
            registry_path,
            dev_mode,
            events,
            plugins: Mutex::new(HashMap::new()),
            rpc_handler: Mutex::new(None),
            receipts_guard: Mutex::new(None),
        });
        host.scan();
        host
    }

    /// Register the receipt accountability guard (WORK-DUR-001) and apply it
    /// to every journal instance already open; future runner registrations
    /// pick it up via [`receipts_guard`](Self::receipts_guard).
    pub fn set_receipts_guard(&self, guard: Arc<crate::plugins::receipts::AccountedFn>) {
        *self
            .receipts_guard
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(guard.clone());
        for slot in self.lock_plugins().values() {
            if let Some(r) = &slot.receipts {
                r.set_accounted_guard(guard.clone());
            }
        }
    }

    pub(crate) fn receipts_guard(&self) -> Option<Arc<crate::plugins::receipts::AccountedFn>> {
        self.receipts_guard
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }

    /// Register the handler for inbound plugin requests (the `flow.run` RPC).
    pub fn set_rpc_handler(&self, handler: Arc<dyn PluginRpcHandler>) {
        *self.rpc_handler.lock().unwrap_or_else(|e| e.into_inner()) = Some(handler);
    }

    /// The current inbound-request handler, if a FormLogic account is linked.
    pub fn rpc_handler(&self) -> Option<Arc<dyn PluginRpcHandler>> {
        self.rpc_handler.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn plugins_root(&self) -> &Path {
        &self.plugins_root
    }

    /// Whether the host runs plugins in dev mode (forwarded to them as
    /// `FORMLOGIC_DEV_MODE=1`). Surfaced in `GET /api/plugins` so the panel
    /// can show dev-only affordances (e.g. Aokie's "Simulate incoming call").
    pub fn dev_mode(&self) -> bool {
        self.dev_mode
    }

    pub(crate) fn lock_plugins(&self) -> MutexGuard<'_, HashMap<String, PluginSlot>> {
        // Recover from poison: a panicked supervisor must not brick the whole
        // plugin API for the process lifetime.
        self.plugins.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Installed plugin ids, sorted (support bundle / diagnostics).
    pub fn plugin_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.lock_plugins().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Drop receipt-journal entries older than `cutoff` across every plugin
    /// (DATA-PRIV-001 retention sweep / "clear history"). Journals with a
    /// LIVE handle are swept through the owning instance; a plugin that never
    /// ran this session gets its journal opened plaintext-read/rewrite (safe:
    /// sweeping keeps raw lines verbatim, so sealed payloads stay sealed).
    /// Returns how many entries were removed.
    pub fn sweep_receipts(&self, cutoff: chrono::DateTime<chrono::Utc>) -> usize {
        let handles: Vec<(String, Option<Arc<crate::plugins::receipts::EventReceipts>>)> = self
            .lock_plugins()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.receipts.clone()))
            .collect();
        let mut removed = 0usize;
        for (id, receipts) in handles {
            match receipts {
                Some(r) => match r.retain_since(cutoff) {
                    Ok(n) => removed += n,
                    Err(e) => log::warn!("receipt sweep failed for {id}: {e}"),
                },
                None => {
                    let path = self.plugin_data_root.join(&id).join("host-event-receipts.jsonl");
                    if !path.is_file() {
                        continue;
                    }
                    match crate::plugins::receipts::EventReceipts::open(path) {
                        Ok(r) => {
                            // The accountability guard applies to fresh opens
                            // too (WORK-DUR-001): an unaccounted entry is
                            // never dropped, whichever path sweeps it.
                            if let Some(guard) = self.receipts_guard() {
                                r.set_accounted_guard(guard);
                            }
                            match r.retain_since(cutoff) {
                                Ok(n) => removed += n,
                                Err(e) => log::warn!("receipt sweep failed for {id}: {e}"),
                            }
                        }
                        Err(e) => log::warn!("receipt sweep open failed for {id}: {e}"),
                    }
                }
            }
        }
        removed
    }

    /// Per-plugin receipt counts (journals preview). Live instances answer
    /// from memory; others from a line count.
    pub fn receipt_counts(&self) -> Vec<(String, usize)> {
        let handles: Vec<(String, Option<Arc<crate::plugins::receipts::EventReceipts>>)> = self
            .lock_plugins()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.receipts.clone()))
            .collect();
        let mut out = Vec::new();
        for (id, receipts) in handles {
            let count = match receipts {
                Some(r) => r.len(),
                None => {
                    let path = self.plugin_data_root.join(&id).join("host-event-receipts.jsonl");
                    std::fs::read_to_string(&path)
                        .map(|t| t.lines().count())
                        .unwrap_or(0)
                }
            };
            out.push((id, count));
        }
        out.sort();
        out
    }

    /// Discover plugins under the root. Running plugins are left untouched
    /// (a manifest edit applies on the next restart); everything else is
    /// (re)loaded so `GET /api/plugins` always reflects the disk.
    pub fn scan(&self) {
        let persisted = self.load_persisted();
        let mut found: HashMap<String, (PathBuf, Result<PluginManifest, String>)> = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&self.plugins_root) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let manifest_path = dir.join("manifest.json");
                if !manifest_path.is_file() {
                    continue; // not a plugin dir
                }
                let dir_name = match dir.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                let loaded = std::fs::read_to_string(&manifest_path)
                    .map_err(|e| format!("cannot read manifest.json: {e}"))
                    .and_then(|text| parse_manifest(&text))
                    .and_then(|m| {
                        if m.id != dir_name {
                            Err(format!(
                                "manifest id {:?} does not match the plugin directory name {:?}",
                                m.id, dir_name
                            ))
                        } else {
                            Ok(m)
                        }
                    });
                found.insert(dir_name, (dir, loaded));
            }
        }

        {
            let mut map = self.lock_plugins();
            // Drop slots whose directory vanished — unless a process is still
            // live (it keeps its slot until it stops/crashes).
            map.retain(|id, slot| found.contains_key(id) || slot.state.is_active());

            for (id, (dir, loaded)) in found {
                let slot = map.entry(id.clone()).or_insert_with(|| PluginSlot::new(dir.clone()));
                if slot.state.is_active() {
                    continue; // live process: don't clobber
                }
                slot.dir = dir;
                slot.user_disabled = persisted
                    .plugins
                    .get(&id)
                    .map(|p| p.disabled)
                    .unwrap_or(false);
                // TRUST-001 "verify before staging": assess the package
                // signature/digests for every inert plugin dir on each scan. A
                // present-but-invalid package manifest QUARANTINES the plugin;
                // a missing one is an unsigned sideload (refused only when
                // FORMLOGIC_REQUIRE_SIGNED_PLUGINS=1). start() re-checks.
                slot.package_trust = crate::plugins::package_trust::assess(&slot.dir);
                let trust_block: Option<String> = match &slot.package_trust {
                    crate::plugins::package_trust::PackageTrust::Tampered(r) => {
                        Some(format!("package verification failed (quarantined): {r}"))
                    }
                    crate::plugins::package_trust::PackageTrust::Unsigned
                        if crate::plugins::package_trust::require_signed() =>
                    {
                        Some(
                            "unsigned plugin refused: FORMLOGIC_REQUIRE_SIGNED_PLUGINS is on and \
                             this directory has no valid signed package manifest"
                                .into(),
                        )
                    }
                    _ => None,
                };
                match loaded {
                    Err(e) => {
                        slot.manifest = None;
                        slot.state = PluginState::Disabled;
                        slot.reason = Some(e);
                    }
                    Ok(m) => {
                        let compat = compatibility_error(&m);
                        let missing = binary_missing_reason(&slot.dir, &m);
                        slot.manifest = Some(m);
                        if let Some(e) = trust_block {
                            slot.state = PluginState::Disabled;
                            slot.reason = Some(e);
                        } else if let Some(e) = compat {
                            slot.state = PluginState::Disabled;
                            slot.reason = Some(e);
                        } else if slot.user_disabled {
                            slot.state = PluginState::Disabled;
                            slot.reason = Some("disabled by user".into());
                        } else {
                            if matches!(slot.state, PluginState::Disabled) {
                                // Was disabled for a reason that no longer holds
                                // (manifest fixed / re-enabled): back to installed.
                                slot.state = PluginState::Installed;
                                slot.reason = None;
                            }
                            // Missing-binary hint on the inert states: a
                            // template installed without its executable shows
                            // this distinct reason (never a spawn-crash loop),
                            // and it clears as soon as the file appears.
                            // Crashed keeps its own, more specific reason.
                            if matches!(
                                slot.state,
                                PluginState::Installed | PluginState::Stopped
                            ) {
                                slot.reason = missing;
                            }
                        }
                        // Stopped / crashed / installed states persist as-is.
                    }
                }
            }
        }
        self.persist();
    }

    /// Rescan + snapshot every plugin (the `GET /api/plugins` body).
    pub fn list(&self) -> Vec<PluginSnapshot> {
        self.scan();
        let map = self.lock_plugins();
        let mut out: Vec<PluginSnapshot> = map
            .iter()
            .map(|(id, slot)| snapshot_of(id, slot))
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn get(&self, id: &str) -> Option<PluginSnapshot> {
        let map = self.lock_plugins();
        map.get(id).map(|slot| snapshot_of(id, slot))
    }

    /// Autostart at boot: start every installed, enabled plugin whose entry binary is present, so a
    /// connector like the Aokie phone bridge is LIVE — ready to emit events (incoming call/SMS) and
    /// to serve relayed connector commands — without a manual click each session. The persistent
    /// opt-out is `user_disabled` (Disable), which this skips; a transient Stop does not survive a
    /// restart (Disable is the durable off switch). Must be called from a Tokio context (start()
    /// spawns a supervisor task). Idempotent: already-active plugins are skipped by start().
    pub fn autostart_installed(self: &Arc<Self>) {
        let ids: Vec<String> = {
            let map = self.lock_plugins();
            map.iter()
                .filter(|(_, slot)| {
                    !slot.user_disabled
                        && matches!(slot.state, PluginState::Installed | PluginState::Stopped)
                        && slot
                            .manifest
                            .as_ref()
                            .is_some_and(|m| binary_missing_reason(&slot.dir, m).is_none())
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            match self.start(&id) {
                Ok(()) => log::info!("plugin autostart: {id}"),
                Err(e) => log::warn!("plugin autostart {id} skipped: {e}"),
            }
        }
    }

    pub fn logs(&self, id: &str, tail: Option<usize>) -> Option<Vec<crate::services::runner::LogLine>> {
        let map = self.lock_plugins();
        map.get(id).map(|slot| slot.logs.snapshot(tail))
    }

    /// The last health probe result (`GET /api/plugins/{id}/health`).
    pub fn last_health(&self, id: &str) -> Option<Option<HealthReport>> {
        let map = self.lock_plugins();
        map.get(id).map(|slot| slot.last_health.clone())
    }

    // ---- persistence ----

    fn load_persisted(&self) -> PersistedRegistry {
        std::fs::read_to_string(&self.registry_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Write the small registry JSON (disabled flags + last states).
    /// Best-effort: a read-only disk must not break lifecycle transitions.
    pub(crate) fn persist(&self) {
        let reg = {
            let map = self.lock_plugins();
            PersistedRegistry {
                plugins: map
                    .iter()
                    .map(|(id, slot)| {
                        (
                            id.clone(),
                            PersistedEntry {
                                disabled: slot.user_disabled,
                                last_state: Some(slot.state),
                            },
                        )
                    })
                    .collect(),
            }
        };
        let body = match serde_json::to_string_pretty(&reg) {
            Ok(b) => b,
            Err(_) => return,
        };
        // Atomic replace (tmp + rename), mirroring the pointer-file writes.
        let tmp = self.registry_path.with_extension("json.tmp");
        if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &self.registry_path).is_err()
        {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

fn snapshot_of(id: &str, slot: &PluginSlot) -> PluginSnapshot {
    let m = slot.manifest.as_ref();
    PluginSnapshot {
        id: id.to_string(),
        name: m.map(|m| m.name.clone()).unwrap_or_else(|| id.to_string()),
        version: m.map(|m| m.version.clone()).unwrap_or_default(),
        description: m.and_then(|m| m.description.clone()),
        state: slot.state,
        reason: slot.reason.clone(),
        dir: slot.dir.display().to_string(),
        plugin_api_version: m.map(|m| m.plugin_api_version),
        min_desktop_version: m.and_then(|m| m.min_desktop_version.clone()),
        capabilities: m.map(|m| m.capabilities.clone()).unwrap_or_default(),
        connectors: m.map(|m| m.connectors.clone()).unwrap_or_default(),
        events: m.map(|m| m.events.clone()).unwrap_or_default(),
        pid: slot.pid,
        started_at: slot.started_at,
        last_health: slot.last_health.clone(),
        restart_attempts: slot.restart_attempts,
        package: slot.package_trust.label(),
        package_detail: match &slot.package_trust {
            crate::plugins::package_trust::PackageTrust::Verified { key_id, version, .. } => {
                Some(format!("v{version} · key {key_id}"))
            }
            _ => None,
        },
    }
}

/// When the manifest's `entry.command` resolves to nothing runnable — no
/// file inside the plugin dir, and (for bare names) nothing on PATH —
/// return the human reason surfaced on the slot / by `start()`. This is
/// what an installed built-in TEMPLATE shows until the user builds the
/// plugin binary and drops it in — a distinct, actionable reason instead
/// of a spawn-and-crash loop. Mirrors `rpc::spawn_plugin`'s resolution
/// (plugin-dir file first, then the PATH lookup for bare names).
pub fn binary_missing_reason(dir: &Path, m: &PluginManifest) -> Option<String> {
    let cmd = &m.entry.command;
    if dir.join(cmd).is_file() {
        return None;
    }
    // Paths with separators only ever resolve inside the plugin dir; bare
    // names ("node", "aokie-plugin.exe") fall through to the PATH lookup.
    let bare = !cmd.contains('/') && !cmd.contains('\\');
    if bare && resolves_on_path(cmd) {
        return None;
    }
    Some(format!(
        "binary {cmd:?} not installed — build the plugin and place it in this folder"
    ))
}

/// Whether a bare command name resolves via the PATH lookup the spawn would
/// use (on Windows also trying the standard executable extensions when the
/// name carries none).
fn resolves_on_path(cmd: &str) -> bool {
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    let has_ext = Path::new(cmd).extension().is_some();
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if dir.join(cmd).is_file() {
            return true;
        }
        if cfg!(windows) && !has_ext {
            for ext in ["exe", "cmd", "bat", "com"] {
                if dir.join(format!("{cmd}.{ext}")).is_file() {
                    return true;
                }
            }
        }
    }
    false
}

/// Version-compat check: protocol version within the supported range,
/// `minDesktopVersion` not newer than this build. Returns the human reason
/// when incompatible (→ state `disabled`).
pub fn compatibility_error(m: &PluginManifest) -> Option<String> {
    if m.plugin_api_version < SUPPORTED_PLUGIN_API_MIN
        || m.plugin_api_version > crate::PLUGIN_API_VERSION
    {
        return Some(format!(
            "plugin speaks pluginApiVersion {} but this desktop supports {}..={}",
            m.plugin_api_version,
            SUPPORTED_PLUGIN_API_MIN,
            crate::PLUGIN_API_VERSION
        ));
    }
    if let Some(min) = &m.min_desktop_version {
        let want = parse_semver(min);
        let have = parse_semver(env!("CARGO_PKG_VERSION"));
        match (want, have) {
            (Some(w), Some(h)) if w > h => {
                return Some(format!(
                    "plugin requires FormLogic Desktop >= {min} (this is {})",
                    env!("CARGO_PKG_VERSION")
                ));
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json(id: &str, extra: &str) -> String {
        format!(
            r#"{{
                "schemaVersion": 1, "id": "{id}", "name": "T", "version": "0.1.0",
                "entry": {{ "kind": "process", "command": "run" }}{extra}
            }}"#
        )
    }

    fn temp_data_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fl-plugin-reg-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plugin(data_dir: &Path, id: &str, manifest: &str) {
        let dir = data_dir.join("plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
    }

    #[test]
    fn scan_loads_valid_and_flags_invalid() {
        let data = temp_data_dir("scan");
        std::fs::create_dir_all(data.join("plugins")).unwrap();
        write_plugin(&data, "good", &manifest_json("good", ""));
        write_plugin(&data, "broken", "{ not json");
        // Directory-name mismatch is an errored install, not a silent skip.
        write_plugin(&data, "renamed", &manifest_json("other-id", ""));

        let host = PluginHost::new(&data, false, EventBus::new());
        let list = host.list();
        assert_eq!(list.len(), 3);
        let by_id = |id: &str| list.iter().find(|p| p.id == id).unwrap();
        assert_eq!(by_id("good").state, PluginState::Installed);
        assert_eq!(by_id("broken").state, PluginState::Disabled);
        assert!(by_id("broken").reason.as_deref().unwrap().contains("manifest"));
        assert_eq!(by_id("renamed").state, PluginState::Disabled);
        assert!(by_id("renamed")
            .reason
            .as_deref()
            .unwrap()
            .contains("does not match"));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn incompatible_versions_surface_as_disabled_with_reason() {
        let data = temp_data_dir("compat");
        write_plugin(
            &data,
            "future",
            &manifest_json("future", r#", "pluginApiVersion": 99"#),
        );
        write_plugin(
            &data,
            "needs-new-desktop",
            &manifest_json("needs-new-desktop", r#", "minDesktopVersion": "999.0.0""#),
        );
        let host = PluginHost::new(&data, false, EventBus::new());
        let list = host.list();
        let by_id = |id: &str| list.iter().find(|p| p.id == id).unwrap();
        assert_eq!(by_id("future").state, PluginState::Disabled);
        assert!(by_id("future").reason.as_deref().unwrap().contains("pluginApiVersion"));
        assert_eq!(by_id("needs-new-desktop").state, PluginState::Disabled);
        assert!(by_id("needs-new-desktop")
            .reason
            .as_deref()
            .unwrap()
            .contains("requires FormLogic Desktop"));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn user_disabled_flag_persists_across_hosts() {
        let data = temp_data_dir("persist");
        write_plugin(&data, "good", &manifest_json("good", ""));
        {
            let host = PluginHost::new(&data, false, EventBus::new());
            {
                let mut map = host.lock_plugins();
                let slot = map.get_mut("good").unwrap();
                slot.user_disabled = true;
                slot.state = PluginState::Disabled;
                slot.reason = Some("disabled by user".into());
            }
            host.persist();
        }
        // Fresh host (simulated restart) re-reads registry.json.
        let host = PluginHost::new(&data, false, EventBus::new());
        let p = host.get("good").unwrap();
        assert_eq!(p.state, PluginState::Disabled);
        assert_eq!(p.reason.as_deref(), Some("disabled by user"));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn missing_binary_surfaces_a_distinct_reason_not_crashed() {
        let data = temp_data_dir("missing-bin");
        // Command name chosen to never exist on PATH.
        let manifest = manifest_json("aokie", "").replace(
            "\"command\": \"run\"",
            "\"command\": \"fl-test-no-such-binary.exe\"",
        );
        write_plugin(&data, "aokie", &manifest);
        let host = PluginHost::new(&data, false, EventBus::new());
        let p = host.get("aokie").unwrap();
        // Distinct reason on the INSTALLED state — never crashed/disabled.
        assert_eq!(p.state, PluginState::Installed);
        let reason = p.reason.as_deref().expect("missing-binary reason");
        assert!(reason.contains("not installed"), "{reason}");
        assert!(reason.contains("fl-test-no-such-binary.exe"), "{reason}");

        // Dropping the executable in clears the hint on the next scan.
        std::fs::write(
            data.join("plugins")
                .join("aokie")
                .join("fl-test-no-such-binary.exe"),
            b"",
        )
        .unwrap();
        let list = host.list(); // list() rescans
        let p = list.iter().find(|p| p.id == "aokie").unwrap();
        assert_eq!(p.state, PluginState::Installed);
        assert_eq!(p.reason, None);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn compatibility_matrix() {
        let ok: PluginManifest =
            serde_json::from_str(&manifest_json("ok", r#", "minDesktopVersion": "0.0.1""#))
                .unwrap();
        assert!(compatibility_error(&ok).is_none());
        let old: PluginManifest =
            serde_json::from_str(&manifest_json("old", r#", "pluginApiVersion": 0"#)).unwrap();
        // pluginApiVersion 0 fails manifest VALIDATION before compat, but the
        // compat check must also refuse it defensively.
        assert!(compatibility_error(&old).is_some());
    }
}
