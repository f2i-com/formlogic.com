//! Plugin lifecycle supervisor — one tokio task per running plugin.
//!
//! Per the SDK contract (`docs/DESKTOP_PLUGIN_SDK.md` §2):
//!   - spawn `entry.command entry.args...`, cwd = plugin dir, minimal env;
//!   - `plugin.init` handshake within [`INIT_TIMEOUT`] or kill + `crashed`;
//!   - `plugin.health` every [`HEALTH_INTERVAL`]; [`HEALTH_MISS_LIMIT`]
//!     consecutive misses → `unhealthy` (process kept, surfaced in UI);
//!   - process exit → `crashed`, auto-restart with exponential backoff, max
//!     [`MAX_RESTART_ATTEMPTS`], then stays `crashed` until a manual start;
//!   - stop = `plugin.shutdown`, [`SHUTDOWN_GRACE`] to exit, then kill.
//!
//! Every slot mutation is guarded by the slot's `generation`: a supervisor
//! whose generation is stale (a newer start/stop happened) silently bows out,
//! so a late crash report can never clobber a fresh run.

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

use crate::plugins::install::InstallSource;
use crate::plugins::registry::{HealthReport, PluginHost, PluginState};
use crate::plugins::rpc::{self, RpcClient, RpcFailure, SpawnSpec};

pub const INIT_TIMEOUT: Duration = Duration::from_secs(10);
pub const HEALTH_INTERVAL: Duration = Duration::from_secs(10);
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
pub const HEALTH_MISS_LIMIT: u32 = 3;
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
pub const MAX_RESTART_ATTEMPTS: u32 = 3;

/// Control messages from the host to a plugin's supervisor task.
pub enum ControlMsg {
    /// Graceful stop; the ack fires once the process is down and the slot is
    /// in its final `stopped` state.
    Stop(oneshot::Sender<()>),
}

/// Handle to a live plugin process, stored in the slot while it runs.
pub struct RunningPlugin {
    pub client: Arc<RpcClient>,
    pub control: mpsc::Sender<ControlMsg>,
    pub pid: u32,
}

enum RunOutcome {
    /// Graceful stop; ack to fire AFTER the slot reads `stopped`.
    Stopped(oneshot::Sender<()>),
    /// Abnormal end. `exit_code` is the process's code when it actually ran
    /// and exited (None for spawn/init failures and signal kills — the reason
    /// string says which); PROC-001 turns it into structured exit diagnostics.
    Crashed {
        reason: String,
        exit_code: Option<i32>,
    },
    /// Someone re-started/stopped underneath us — do nothing.
    Stale,
}

impl PluginHost {
    /// Start a plugin (manual start — resets the auto-restart budget).
    pub fn start(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let gen = {
            let mut map = self.lock_plugins();
            let slot = map
                .get_mut(id)
                .ok_or_else(|| format!("unknown plugin {id:?}"))?;
            if slot.state.is_active() {
                return Err(format!("plugin {id:?} is already {:?}", slot.state).to_lowercase());
            }
            if slot.state == PluginState::Disabled {
                return Err(match &slot.reason {
                    Some(r) => format!("plugin {id:?} is disabled: {r}"),
                    None => format!("plugin {id:?} is disabled"),
                });
            }
            if slot.manifest.is_none() {
                return Err(format!("plugin {id:?} has no valid manifest"));
            }
            // Refuse up front when the entry binary isn't there (a built-in
            // template installed without its executable): the caller gets the
            // same distinct, actionable reason the slot shows — instead of a
            // spawn failure counting as `crashed`.
            if let Some(m) = &slot.manifest {
                if let Some(reason) = crate::plugins::registry::binary_missing_reason(&slot.dir, m)
                {
                    slot.reason = Some(reason.clone());
                    return Err(reason);
                }
            }
            // TRUST-001 "verify again before launch": re-hash the package NOW,
            // not just at scan time — bytes swapped between the scan and this
            // start must still never execute. Tampered ⇒ quarantine the slot;
            // unsigned ⇒ refused only under FORMLOGIC_REQUIRE_SIGNED_PLUGINS.
            {
                use crate::plugins::package_trust::{self, PackageTrust};
                slot.package_trust = package_trust::assess(&slot.dir);
                let block = match &slot.package_trust {
                    PackageTrust::Tampered(r) => {
                        Some(format!("package verification failed (quarantined): {r}"))
                    }
                    PackageTrust::Unsigned if package_trust::require_signed() => Some(
                        "unsigned plugin refused: FORMLOGIC_REQUIRE_SIGNED_PLUGINS is on and \
                         this directory has no valid signed package manifest"
                            .into(),
                    ),
                    _ => None,
                };
                if let Some(reason) = block {
                    slot.state = PluginState::Disabled;
                    slot.reason = Some(reason.clone());
                    return Err(reason);
                }
            }
            slot.generation += 1;
            slot.state = PluginState::Starting;
            slot.reason = None;
            slot.restart_attempts = 0;
            slot.last_health = None;
            slot.generation
        };
        self.persist();
        let host = self.clone();
        let id = id.to_string();
        tokio::spawn(async move { supervise(host, id, gen).await });
        Ok(())
    }

    /// Stop a plugin: graceful shutdown of a live process, or just finalize
    /// the state for one that's crashed / mid-backoff. Idempotent.
    pub async fn stop(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let running = {
            let mut map = self.lock_plugins();
            let slot = map
                .get_mut(id)
                .ok_or_else(|| format!("unknown plugin {id:?}"))?;
            match slot.state {
                PluginState::Stopped | PluginState::Installed | PluginState::Disabled => {
                    return Ok(())
                }
                _ => {}
            }
            match slot.running.clone() {
                Some(r) => Some(r),
                None => {
                    // Crashed, or a supervisor sleeping out its backoff: bump
                    // the generation so it bows out, and finalize here.
                    slot.generation += 1;
                    slot.state = PluginState::Stopped;
                    slot.reason = None;
                    slot.pid = None;
                    slot.started_at = None;
                    None
                }
            }
        };
        if let Some(r) = running {
            let (ack_tx, ack_rx) = oneshot::channel();
            let sent = r.control.send(ControlMsg::Stop(ack_tx)).await.is_ok();
            if sent {
                // init(10s) + shutdown grace(5s) + margin: the supervisor may
                // be mid-handshake when the stop lands.
                let _ = tokio::time::timeout(Duration::from_secs(18), ack_rx).await;
            }
            // If the supervisor died without finalizing, force the slot down.
            let mut map = self.lock_plugins();
            if let Some(slot) = map.get_mut(id) {
                let same_run = slot
                    .running
                    .as_ref()
                    .map(|cur| Arc::ptr_eq(cur, &r))
                    .unwrap_or(false);
                if same_run {
                    slot.generation += 1;
                    slot.state = PluginState::Stopped;
                    slot.running = None;
                    slot.pid = None;
                    slot.started_at = None;
                }
            }
        }
        self.persist();
        Ok(())
    }

    /// Stop-then-start. Used by `POST /api/plugins/{id}/restart`.
    pub async fn restart(self: &Arc<Self>, id: &str) -> Result<(), String> {
        self.stop(id).await?;
        self.start(id)
    }

    /// Refresh an active plugin without turning an installed/stopped/disabled
    /// plugin on as a side effect. This is used after native-only configuration
    /// changes (such as the Aokie Companion peer roster) that are deliberately
    /// supplied only during `plugin.init`.
    pub async fn restart_if_active(self: &Arc<Self>, id: &str) -> Result<bool, String> {
        let active = {
            let map = self.lock_plugins();
            let Some(slot) = map.get(id) else {
                return Ok(false);
            };
            slot.state.is_active()
        };
        if !active {
            return Ok(false);
        }
        self.restart(id).await?;
        Ok(true)
    }

    /// PLG-102/103/104: install a native plugin from a local folder or a
    /// `.formlogic-plugin` archive. Stages under the plugins root, validates
    /// (manifest, symlink refusal, package signature), refuses id/connector/
    /// event collisions against installed plugins, then atomically moves it
    /// into `<plugins>/<manifest.id>` (replacing an existing install of the
    /// SAME id — an update). Returns the installed plugin id. Filesystem only;
    /// the caller starts/binds it afterwards.
    pub fn install_from_source(
        self: &Arc<Self>,
        source: &InstallSource,
    ) -> Result<String, String> {
        use crate::plugins::install;
        let plugins_root = self.plugins_root().to_path_buf();
        // 1. stage
        let staging = match source {
            InstallSource::Folder(p) => install::copy_folder_to_staging(&plugins_root, p),
            InstallSource::Zip(bytes) => install::extract_zip_to_staging(&plugins_root, bytes),
        }
        .map_err(|e| e.to_string())?;
        // 2. validate (manifest + symlink refusal + signature)
        let require_signed = crate::plugins::package_trust::require_signed();
        let manifest = match install::validate_staged(&staging, require_signed) {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e.to_string());
            }
        };
        // 3. collision check against OTHER installed plugins
        let installed: Vec<install::OwnedSurface> = {
            let map = self.lock_plugins();
            map.values()
                .filter_map(|s| s.manifest.as_ref())
                .map(install::OwnedSurface::from_manifest)
                .collect()
        };
        if let Some(reason) = install::collision_reason(&manifest, &installed) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("cannot install {:?}: {reason}", manifest.id));
        }
        // 4. an existing install of the same id is an UPDATE — stop it first so
        //    its files aren't locked during the swap (Windows). We can't await
        //    here (install_from_source is sync for the HTTP handler), so refuse
        //    an update to a currently-active plugin with a clear message.
        {
            let map = self.lock_plugins();
            if let Some(slot) = map.get(&manifest.id) {
                if slot.state.is_active() {
                    drop(map);
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(format!(
                        "plugin {:?} is running — stop it before reinstalling/updating",
                        manifest.id
                    ));
                }
            }
        }
        // 5. commit (atomic move, replacing same-id)
        install::commit_staged(&plugins_root, &manifest.id, &staging)
            .map_err(|e| e.to_string())?;
        // 6. rescan so the new slot appears (with fresh trust assessment).
        {
            // Drop any stale slot for this id so scan re-derives it cleanly.
            let mut map = self.lock_plugins();
            map.remove(&manifest.id);
        }
        self.scan();
        // 7. PLG-206: install the plugin's manifest-declared service templates,
        //    stamped with this plugin as owner. A bad template file is logged
        //    and skipped — it never fails the install.
        self.install_owned_services(&manifest.id, &manifest, &plugins_root.join(&manifest.id));
        Ok(manifest.id)
    }

    /// PLG-206: load + install the service templates a plugin's manifest
    /// declares (`services[].templateFile`, package-relative), stamped owned by
    /// the plugin. Best-effort per template.
    fn install_owned_services(
        self: &Arc<Self>,
        plugin_id: &str,
        manifest: &crate::plugins::manifest::PluginManifest,
        plugin_dir: &std::path::Path,
    ) {
        if manifest.services.is_empty() {
            return;
        }
        let Some(services) = self.services_registry() else {
            log::warn!("plugin {plugin_id}: declares services but no services registry is wired");
            return;
        };
        for svc_ref in &manifest.services {
            // The template path is validated package-relative at manifest parse;
            // resolve it under the plugin dir and refuse anything that escapes.
            let path = plugin_dir.join(&svc_ref.template_file);
            if !path.starts_with(plugin_dir) {
                log::warn!(
                    "plugin {plugin_id}: service template {:?} escapes the plugin dir — skipped",
                    svc_ref.template_file
                );
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("plugin {plugin_id}: cannot read service template {}: {e}", path.display());
                    continue;
                }
            };
            let template: crate::services::template::ServiceTemplate =
                match serde_json::from_str(&raw) {
                    Ok(t) => t,
                    Err(e) => {
                        log::warn!("plugin {plugin_id}: bad service template {}: {e}", path.display());
                        continue;
                    }
                };
            let mut reg = services.lock().unwrap_or_else(|e| e.into_inner());
            match reg.add_owned_template(template, plugin_id) {
                Ok(()) => log::info!("plugin {plugin_id}: installed owned service template"),
                Err(e) => log::warn!("plugin {plugin_id}: owned service refused: {e}"),
            }
        }
    }

    /// Uninstall a plugin (`DELETE /api/plugins/{id}`): stop it if active,
    /// remove `<plugins>/<id>` (manifest + binary), and forget the slot.
    ///
    /// PLG-107: when `purge` is true, ALSO remove the plugin's writable data at
    /// `<plugin-data>/<id>` (settings, outbox, receipts, command journal). The
    /// receipts journal handle held on the slot is dropped BEFORE the delete so
    /// Windows can remove the open file. Data OUTSIDE the desktop's tree that a
    /// plugin declares (its own `%APPDATA%`, credential-manager entries, driver
    /// artifacts) is NEVER auto-deleted — the caller surfaces that inventory to
    /// the user as a manual checklist. With `purge` false the data is kept so a
    /// reinstall resumes where it left off. A bundled built-in reappears as an
    /// installable template afterwards.
    pub async fn uninstall(self: &Arc<Self>, id: &str, purge: bool) -> Result<(), String> {
        // Only registered slots can be uninstalled; slot ids exist only for
        // scanned folders whose `manifest.id == dir_name`, so this also rules
        // out path tricks in `id`.
        let dir = {
            let map = self.lock_plugins();
            let slot = map
                .get(id)
                .ok_or_else(|| format!("unknown plugin {id:?}"))?;
            slot.dir.clone()
        };
        self.stop(id).await?;
        // PLG-205: drop this plugin's connector→app bindings.
        self.bindings()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget_plugin(id);
        // PLG-206: remove any service templates this plugin owned (stopping a
        // running one first) BEFORE deleting the plugin dir, so an owned
        // service never outlives its plugin as a dead card.
        if let Some(services) = self.services_registry() {
            let removed = services
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove_owned_by(id);
            if !removed.is_empty() {
                log::info!("plugin {id}: removed {} owned service(s)", removed.len());
            }
        }
        // Defense in depth: never remove anything outside the plugins root.
        if !dir.starts_with(self.plugins_root()) {
            return Err(format!(
                "plugin dir {} is outside the plugins root",
                dir.display()
            ));
        }
        std::fs::remove_dir_all(&dir).map_err(|e| {
            format!(
                "cannot remove {} (is the plugin binary still running or locked?): {e}",
                dir.display()
            )
        })?;
        {
            let mut map = self.lock_plugins();
            // PLG-107: drop the receipts handle so its journal file is closed
            // before we try to remove the data dir (Windows locks open files).
            if let Some(slot) = map.get_mut(id) {
                slot.receipts = None;
            }
            map.remove(id);
        }
        if purge {
            let data_dir = self.plugin_data_root.join(id);
            // Defense in depth: the data dir must sit under the plugin-data root.
            if data_dir.starts_with(&self.plugin_data_root) && data_dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&data_dir) {
                    // Non-fatal: the code is gone; report the data-purge miss.
                    log::warn!("purge: could not remove {} : {e}", data_dir.display());
                    self.persist();
                    self.scan();
                    return Err(format!(
                        "plugin removed, but its data at {} could not be deleted (a file may be \
                         locked): {e}",
                        data_dir.display()
                    ));
                }
            }
        }
        self.persist();
        self.scan();
        Ok(())
    }

    /// Best-effort shutdown of every running plugin (process exit path).
    pub async fn stop_all(self: &Arc<Self>) {
        let ids: Vec<String> = {
            let map = self.lock_plugins();
            map.iter()
                .filter(|(_, s)| s.state.is_active())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    /// On-demand `plugin.health` probe (also records it as the last report).
    /// The supervisor's own 10 s ticker uses the same wire call.
    pub async fn probe_health(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let (client, gen) = {
            let map = self.lock_plugins();
            let slot = map
                .get(id)
                .ok_or_else(|| format!("unknown plugin {id:?}"))?;
            match (&slot.running, slot.state) {
                (Some(r), s) if s.is_active() => (r.client.clone(), slot.generation),
                _ => return Err(format!("plugin {id:?} is not running")),
            }
        };
        let res = client
            .request("plugin.health", json!({}), HEALTH_TIMEOUT)
            .await;
        let report = health_report(&res);
        self.record_health(id, gen, report.clone());
        match res {
            Ok(v) => Ok(v),
            Err(f) => Err(format!("health probe failed: {}", failure_text(&f))),
        }
    }

    // ---- slot mutations, all generation-guarded ----

    fn generation_valid(&self, id: &str, gen: u64) -> bool {
        let map = self.lock_plugins();
        map.get(id).map(|s| s.generation == gen).unwrap_or(false)
    }

    fn record_health(&self, id: &str, gen: u64, report: HealthReport) {
        let mut map = self.lock_plugins();
        if let Some(slot) = map.get_mut(id) {
            if slot.generation == gen {
                slot.last_health = Some(report);
            }
        }
    }

    fn set_state(&self, id: &str, gen: u64, state: PluginState, reason: Option<String>) -> bool {
        let changed = {
            let mut map = self.lock_plugins();
            match map.get_mut(id) {
                Some(slot) if slot.generation == gen => {
                    slot.state = state;
                    slot.reason = reason;
                    if !state.is_active() {
                        slot.running = None;
                        slot.pid = None;
                        slot.started_at = None;
                    }
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist();
        }
        changed
    }
}

/// The manifest capability that gates the inbound `flow.run` RPC.
pub const FLOW_RUN_CAPABILITY: &str = "flow.run";
/// AOK-302: the generic host admission/identity broker capability. Any plugin
/// the host is willing to broker for (see [`admission_eligible`]) declares
/// this to reach the credential-minting `host.admission` RPC.
pub const HOST_ADMISSION_CAPABILITY: &str = "host.admission";
/// Legacy alias kept so the deployed Aokie plugin — which declares and calls
/// `companion.admission` — keeps working unchanged during the migration.
pub const COMPANION_ADMISSION_CAPABILITY: &str = "companion.admission";

/// True when a manifest declares the `flow.run` capability (bare or `flow.*`).
pub fn declares_flow_run(manifest: &crate::plugins::manifest::PluginManifest) -> bool {
    manifest
        .capabilities
        .iter()
        .any(|c| c == FLOW_RUN_CAPABILITY || c == "flow.*")
}

/// AOK-302: which plugins the host will broker admission for. A generic
/// capability NAME does not widen this set — the host remains the security
/// authority. Today only the (package-verified, account-linked) Aokie plugin;
/// AOK-303 (supervised) generalizes the broker + identity migration before any
/// other plugin is added here. Kept as a single seam so the pin is a stated
/// policy, not string equality scattered through the request path.
pub fn admission_eligible(plugin_id: &str) -> bool {
    matches!(plugin_id, "aokie")
}

/// The admission broker is intentionally a separate, exact capability — a
/// generic `flow.*` grant must never expose a credential-minting host method.
/// A plugin declares eligibility via EITHER the generic `host.admission`
/// capability or the legacy `companion.admission` alias.
pub fn declares_admission(manifest: &crate::plugins::manifest::PluginManifest) -> bool {
    manifest
        .capabilities
        .iter()
        .any(|c| c == HOST_ADMISSION_CAPABILITY || c == COMPANION_ADMISSION_CAPABILITY)
}

/// Legacy exact check retained for tests/back-compat: only the `companion.admission`
/// alias (not the generic capability). Prefer [`declares_admission`].
pub fn declares_companion_admission(
    manifest: &crate::plugins::manifest::PluginManifest,
) -> bool {
    manifest
        .capabilities
        .iter()
        .any(|capability| capability == COMPANION_ADMISSION_CAPABILITY)
}

/// Handle one inbound plugin request. Every method has an exact manifest
/// capability and the credential broker is additionally pinned to plugin id
/// `aokie`; neither method is reachable when the FormLogic account is unlinked.
async fn handle_inbound_plugin_request(
    host: &Arc<PluginHost>,
    manifest: &crate::plugins::manifest::PluginManifest,
    plugin_id: &str,
    package_verified: bool,
    method: &str,
    params: Value,
) -> Result<Value, crate::plugins::rpc::RpcErrorObj> {
    use crate::plugins::rpc::RpcErrorObj;
    match method {
        "flow.run" if !declares_flow_run(manifest) => {
            return Err(RpcErrorObj {
                code: -32000,
                message: "capability 'flow.run' is not declared in the plugin manifest".into(),
                data: Some(json!({ "code": "capability_denied" })),
            });
        }
        // AOK-302: the generic host admission broker + its legacy alias. The
        // host stays the security authority — package-verified, account-linked
        // (checked below), and only brokered for `admission_eligible` plugins.
        "host.admission" | "companion.admission"
            if !package_verified
                || !admission_eligible(plugin_id)
                || !declares_admission(manifest) =>
        {
            return Err(RpcErrorObj {
                code: -32000,
                message: format!("capability '{method}' is not available to this plugin"),
                data: Some(json!({ "code": "capability_denied" })),
            });
        }
        "flow.run" | "host.admission" | "companion.admission" => {}
        _ => {
            return Err(RpcErrorObj {
                code: -32601,
                message: format!("method not found: {method}"),
                data: None,
            });
        }
    }
    match host.rpc_handler() {
        Some(h) => {
            h.handle(plugin_id.to_string(), method.to_string(), params)
                .await
        }
        None => Err(RpcErrorObj {
            code: -32001,
            message: "FormLogic account services are not linked".into(),
            data: Some(json!({ "code": "runner_unavailable" })),
        }),
    }
}

/// The per-plugin supervisor: run the process, and on crash retry with
/// exponential backoff (1 s, 2 s, 4 s) up to [`MAX_RESTART_ATTEMPTS`].
async fn supervise(host: Arc<PluginHost>, id: String, gen: u64) {
    loop {
        match run_once(&host, &id, gen).await {
            RunOutcome::Stale => return,
            RunOutcome::Stopped(ack) => {
                host.set_state(&id, gen, PluginState::Stopped, None);
                let _ = ack.send(());
                return;
            }
            RunOutcome::Crashed { reason, exit_code } => {
                let attempts = {
                    let mut map = host.lock_plugins();
                    match map.get_mut(&id) {
                        Some(slot) if slot.generation == gen => {
                            slot.state = PluginState::Crashed;
                            slot.reason = Some(reason.clone());
                            // PROC-001: structured exit diagnostics — the exit
                            // code, when, and the final stderr lines — so the
                            // snapshot names the failure without a log trawl.
                            slot.last_exit = Some(crate::plugins::registry::PluginExit {
                                code: exit_code,
                                at: chrono::Utc::now(),
                                stderr_tail: slot
                                    .logs
                                    .snapshot(None)
                                    .iter()
                                    .filter(|l| l.stream == "stderr")
                                    .rev()
                                    .take(6)
                                    .map(|l| {
                                        let mut t = l.text.clone();
                                        if t.len() > 300 {
                                            let mut cap = 300;
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
                                    .collect(),
                            });
                            slot.running = None;
                            slot.pid = None;
                            slot.started_at = None;
                            slot.restart_attempts
                        }
                        _ => return, // superseded
                    }
                };
                host.persist();
                if attempts >= MAX_RESTART_ATTEMPTS {
                    // Budget exhausted: stays crashed until a manual start.
                    return;
                }
                let delay = Duration::from_secs(1 << attempts); // 1s, 2s, 4s
                tokio::time::sleep(delay).await;
                // A stop()/start() during the backoff bumps the generation.
                if !host.generation_valid(&id, gen) {
                    return;
                }
                {
                    let mut map = host.lock_plugins();
                    match map.get_mut(&id) {
                        Some(slot) if slot.generation == gen => {
                            slot.restart_attempts += 1;
                            slot.state = PluginState::Starting;
                        }
                        _ => return,
                    }
                }
            }
        }
    }
}

/// One process lifetime: spawn → init → run (health + control + exit watch).
/// Assemble the Aokie-only private init object. A package name is not a trust
/// boundary: the endpoint seed is released only after launch-time package
/// verification, and only when the approved-mobile roster satisfies the v2
/// plugin peer policy. An unsigned/dev Aokie build may still run its local
/// Bluetooth connector, but remote Companion admission remains unavailable.
fn private_aokie_bootstrap(
    host: &Arc<PluginHost>,
    plugin_id: &str,
    package_verified: bool,
) -> Result<Option<Value>, String> {
    if plugin_id != "aokie" || !package_verified {
        return Ok(None);
    }
    let Some(identity) = host.aokie_endpoint_identity.private_bootstrap()? else {
        return Ok(None);
    };
    let session = crate::aokie_companion_publisher::plugin_v2_bootstrap(plugin_id)?;
    Ok(Some(compose_private_aokie_bootstrap(
        plugin_id,
        identity,
        session,
    )?))
}

/// Combine the package-gated endpoint authority with either an explicit
/// startup admission or the strict identity-only shape. In the latter case
/// the plugin uses its private `companion.admission` host RPC to obtain the
/// first short-lived admission, just as it already does for later rotations.
fn compose_private_aokie_bootstrap(
    plugin_id: &str,
    identity: Value,
    session: Option<Value>,
) -> Result<Value, String> {
    let mut bootstrap = session.unwrap_or_else(|| {
        json!({
            "schemaVersion": 2,
            "pluginId": plugin_id,
        })
    });
    let target = bootstrap
        .as_object_mut()
        .ok_or_else(|| "Aokie private bootstrap is not an object".to_string())?;
    for (key, value) in identity
        .as_object()
        .ok_or_else(|| "Aokie endpoint identity bootstrap is not an object".to_string())?
    {
        target.insert(key.clone(), value.clone());
    }
    Ok(bootstrap)
}

async fn run_once(host: &Arc<PluginHost>, id: &str, gen: u64) -> RunOutcome {
    // Snapshot everything needed to spawn, without holding the lock across IO.
    let (dir, manifest, logs, package_verified) = {
        let map = host.lock_plugins();
        match map.get(id) {
            Some(slot) if slot.generation == gen => match &slot.manifest {
                Some(m) => (
                    slot.dir.clone(),
                    m.clone(),
                    slot.logs.clone(),
                    matches!(
                        slot.package_trust,
                        crate::plugins::package_trust::PackageTrust::Verified { .. }
                    ),
                ),
                None => {
                    return RunOutcome::Crashed {
                        reason: "manifest missing".into(),
                        exit_code: None,
                    }
                }
            },
            _ => return RunOutcome::Stale,
        }
    };
    let data_dir = host.plugin_data_root.join(id);
    let _ = std::fs::create_dir_all(&data_dir);

    // Durable event receipts (audit INT-003): journal every event.emit
    // BEFORE acknowledging it, so the plugin's outbox can stop re-delivering.
    // If the journal can't open, the desktop must NOT advertise `eventAck` —
    // promising acks it can never send would dead-letter every event.
    // Payloads are sealed at rest (DATA-PRIV-001); a missing crypto key store
    // falls back to plaintext LOUDLY inside journal_crypto::shared.
    let receipts = match crate::plugins::receipts::EventReceipts::open_encrypted(
        data_dir.join("host-event-receipts.jsonl"),
        crate::journal_crypto::shared(&host.plugin_data_root),
    ) {
        Ok(r) => {
            // WORK-DUR-001: rotation/retention must never drop an entry the
            // work ledger hasn't accounted for — this receipt may be the only
            // durable copy of an event we already acked to the plugin.
            if let Some(guard) = host.receipts_guard() {
                r.set_accounted_guard(guard);
            }
            Some(Arc::new(r))
        }
        Err(e) => {
            logs.push(
                "stderr",
                format!("[desktop] event receipts unavailable ({e}) — running without eventAck"),
            );
            None
        }
    };

    let spec = SpawnSpec {
        plugin_id: id,
        plugin_dir: &dir,
        command: &manifest.entry.command,
        args: &manifest.entry.args,
        data_dir: &data_dir,
        dev_mode: host.dev_mode,
    };
    let proc = match rpc::spawn_plugin(&spec, logs.clone()) {
        Ok(p) => p,
        Err(e) => {
            return RunOutcome::Crashed {
                reason: format!("spawn failed: {e}"),
                exit_code: None,
            }
        }
    };
    let mut child = proc.child;
    let client = proc.client;
    let mut notifications = proc.notifications;

    let (ctl_tx, mut ctl_rx) = mpsc::channel::<ControlMsg>(4);
    let running = Arc::new(RunningPlugin {
        client: client.clone(),
        control: ctl_tx,
        pid: child.id().unwrap_or(0),
    });
    let registered = {
        let mut map = host.lock_plugins();
        match map.get_mut(id) {
            Some(slot) if slot.generation == gen => {
                slot.running = Some(running.clone());
                // Retention sweeps must go through the OWNING journal instance
                // (DATA-PRIV-001) — hand the host this run's handle.
                slot.receipts = receipts.clone();
                slot.pid = child.id();
                true
            }
            _ => false,
        }
    };
    if !registered {
        // Superseded before we could register — reap the fresh child.
        let _ = child.start_kill();
        let _ = child.wait().await;
        return RunOutcome::Stale;
    }

    // Notification pump: events → bus (validated there), log.emit → ring,
    // inbound requests (flow.run) → flow runtime, answered over stdin.
    {
        let host = host.clone();
        let id = id.to_string();
        let manifest = manifest.clone();
        let logs = logs.clone();
        let pump_client = client.clone();
        let pump_receipts = receipts.clone();
        let package_verified = package_verified;
        tokio::spawn(async move {
            while let Some(n) = notifications.recv().await {
                match n {
                    rpc::PluginNotification::Event(envelope) => {
                        // Durable-receipt + ack path (audit INT-003). Journal
                        // BEFORE ack; a replayed duplicate is re-acked but
                        // never re-published. A journal write failure means
                        // NO ack — the plugin keeps the row and re-delivers.
                        let key = envelope
                            .get("idempotencyKey")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string);
                        match (pump_receipts.as_ref(), key) {
                            (Some(receipts), Some(key)) => {
                                use crate::plugins::receipts::ReceiptOutcome;
                                match receipts.record(&key, &envelope) {
                                    Ok(ReceiptOutcome::New) => {
                                        host.events
                                            .publish_from_plugin(&id, &manifest, envelope, &logs);
                                        pump_client
                                            .notify("event.ack", json!({ "idempotencyKey": key }))
                                            .await;
                                    }
                                    Ok(ReceiptOutcome::Duplicate) => {
                                        logs.push(
                                            "stdout",
                                            format!(
                                                "[desktop] deduped replayed event {key} (acked again, not re-published)"
                                            ),
                                        );
                                        pump_client
                                            .notify("event.ack", json!({ "idempotencyKey": key }))
                                            .await;
                                    }
                                    Err(e) => {
                                        logs.push(
                                            "stderr",
                                            format!(
                                                "[desktop] receipt journal write failed for {key}: {e} — NOT acked, plugin will re-deliver"
                                            ),
                                        );
                                        host.events
                                            .publish_from_plugin(&id, &manifest, envelope, &logs);
                                    }
                                }
                            }
                            // No journal or no idempotencyKey: legacy path.
                            _ => {
                                host.events
                                    .publish_from_plugin(&id, &manifest, envelope, &logs);
                            }
                        }
                    }
                    rpc::PluginNotification::Realtime(frame) => {
                        // Volatile lane: fan out and forget. No receipts, no
                        // ack, no EventBus, no journal — by design (§9.1).
                        let _ = host.realtime.send(frame.to_string());
                    }
                    rpc::PluginNotification::Log { level, message } => {
                        logs.push("stdout", format!("[{level}] {message}"));
                    }
                    rpc::PluginNotification::Request {
                        id: rpc_id,
                        method,
                        params,
                    } => {
                        // Gate + route off the pump so a slow flow can't stall
                        // event/log delivery; the reply goes back over stdin.
                        let host = host.clone();
                        let manifest = manifest.clone();
                        let client = pump_client.clone();
                        let plugin_id = id.clone();
                        tokio::spawn(async move {
                            let outcome = handle_inbound_plugin_request(
                                &host,
                                &manifest,
                                &plugin_id,
                                package_verified,
                                &method,
                                params,
                            )
                            .await;
                            client.respond(rpc_id, outcome).await;
                        });
                    }
                }
            }
        });
    }

    // Handshake — cancellable by a Stop that lands mid-init. `features`
    // advertises `eventAck` only when the receipt journal is actually open
    // (audit INT-003) — an ack-capable plugin then holds outboxed events
    // until our event.ack confirms durable receipt.
    let mut features: Vec<&str> = Vec::new();
    if receipts.is_some() {
        features.push("eventAck");
    }
    let private_bootstrap = match private_aokie_bootstrap(host, id, package_verified) {
        Ok(value) => value,
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return RunOutcome::Crashed {
                reason: format!("private plugin bootstrap rejected: {error}"),
                exit_code: None,
            };
        }
    };
    if private_bootstrap.is_some() {
        features.push("aokieCompanionV2");
    }
    let mut init_params = json!({
        "desktopVersion": env!("CARGO_PKG_VERSION"),
        "pluginApiVersion": crate::PLUGIN_API_VERSION,
        "dataDir": data_dir.display().to_string(),
        "devMode": host.dev_mode,
        "features": features,
    });
    if let Some(private_bootstrap) = private_bootstrap {
        init_params
            .as_object_mut()
            .expect("plugin.init parameters are an object")
            .insert("privateBootstrap".into(), private_bootstrap);
    }
    tokio::select! {
        res = client.request("plugin.init", init_params, INIT_TIMEOUT) => {
            if let Err(f) = res {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return RunOutcome::Crashed {
                    reason: format!("plugin.init failed: {}", failure_text(&f)),
                    exit_code: None,
                };
            }
        }
        msg = ctl_rx.recv() => {
            if let Some(ControlMsg::Stop(ack)) = msg {
                graceful_shutdown(&client, &mut child, &logs).await;
                return RunOutcome::Stopped(ack);
            }
        }
    }

    if !host.set_state(id, gen, PluginState::Running, None) {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return RunOutcome::Stale;
    }
    {
        let mut map = host.lock_plugins();
        if let Some(slot) = map.get_mut(id) {
            if slot.generation == gen {
                slot.started_at = Some(chrono::Utc::now());
            }
        }
    }
    logs.push("stdout", "[desktop] plugin initialized".into());

    // Main loop: exit watch + control + health ticker. The first health tick
    // fires one full interval after init (the init reply already proved it
    // alive).
    let mut health = tokio::time::interval_at(
        tokio::time::Instant::now() + HEALTH_INTERVAL,
        HEALTH_INTERVAL,
    );
    health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut misses = 0u32;
    loop {
        tokio::select! {
            status = child.wait() => {
                let code = status.ok().and_then(|s| s.code());
                return RunOutcome::Crashed {
                    reason: match code {
                        Some(c) => format!("process exited with code {c}"),
                        None => "process exited (killed by signal)".into(),
                    },
                    exit_code: code,
                };
            }
            msg = ctl_rx.recv() => {
                if let Some(ControlMsg::Stop(ack)) = msg {
                    graceful_shutdown(&client, &mut child, &logs).await;
                    return RunOutcome::Stopped(ack);
                }
            }
            _ = health.tick() => {
                let res = client.request("plugin.health", json!({}), HEALTH_TIMEOUT).await;
                host.record_health(id, gen, health_report(&res));
                match res {
                    Ok(_) => {
                        misses = 0;
                        // Recovered from unhealthy → running again.
                        let mut map = host.lock_plugins();
                        if let Some(slot) = map.get_mut(id) {
                            if slot.generation == gen && slot.state == PluginState::Unhealthy {
                                slot.state = PluginState::Running;
                            }
                        }
                    }
                    Err(_) => {
                        misses += 1;
                        if misses == HEALTH_MISS_LIMIT {
                            logs.push("stderr", format!(
                                "[desktop] {HEALTH_MISS_LIMIT} consecutive health probes missed — marking unhealthy"
                            ));
                            let mut map = host.lock_plugins();
                            if let Some(slot) = map.get_mut(id) {
                                if slot.generation == gen && slot.state == PluginState::Running {
                                    slot.state = PluginState::Unhealthy;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// `plugin.shutdown`, up to [`SHUTDOWN_GRACE`] for the process to exit on its
/// own, then kill. Never blocks longer than ~the grace period.
async fn graceful_shutdown(
    client: &Arc<RpcClient>,
    child: &mut tokio::process::Child,
    logs: &rpc::LogRing,
) {
    let graceful = async {
        let _ = client
            .request("plugin.shutdown", json!({}), SHUTDOWN_GRACE)
            .await;
        let _ = child.wait().await;
    };
    if tokio::time::timeout(SHUTDOWN_GRACE, graceful)
        .await
        .is_err()
    {
        logs.push(
            "stderr",
            "[desktop] plugin did not exit within the shutdown grace period — killing".into(),
        );
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

fn health_report(res: &Result<Value, RpcFailure>) -> HealthReport {
    match res {
        Ok(v) => {
            let status = v
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("ok")
                .to_string();
            HealthReport {
                at: chrono::Utc::now(),
                ok: status == "ok",
                detail: v.get("detail").and_then(Value::as_str).map(str::to_string),
                components: v.get("components").cloned(),
                status,
            }
        }
        Err(f) => HealthReport {
            at: chrono::Utc::now(),
            ok: false,
            status: "unreachable".into(),
            detail: Some(failure_text(f)),
            components: None,
        },
    }
}

pub(crate) fn failure_text(f: &RpcFailure) -> String {
    match f {
        RpcFailure::Timeout(d) => format!("no response within {} ms", d.as_millis()),
        RpcFailure::Closed => "plugin connection closed".into(),
        RpcFailure::Remote(e) => format!("plugin error {}: {}", e.code, e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventBus;
    use crate::plugins::manifest::parse_manifest;

    fn manifest(caps: &str) -> crate::plugins::manifest::PluginManifest {
        parse_manifest(&format!(
            r#"{{ "schemaVersion": 1, "id": "aokie", "name": "Aokie", "version": "0.1.0",
                 "entry": {{ "kind": "process", "command": "aokie" }}, "capabilities": [{caps}] }}"#
        ))
        .expect("manifest")
    }

    fn host() -> Arc<PluginHost> {
        let dir = std::env::temp_dir().join(format!("flrun-{}", uuid::Uuid::new_v4().simple()));
        PluginHost::new(&dir, false, EventBus::new())
    }

    #[test]
    fn declares_flow_run_matches_bare_and_wildcard() {
        assert!(declares_flow_run(&manifest("\"flow.run\"")));
        assert!(declares_flow_run(&manifest("\"flow.*\"")));
        assert!(!declares_flow_run(&manifest(
            "\"connector.aokie.call.answer\""
        )));
    }

    #[test]
    fn companion_admission_requires_the_exact_capability() {
        assert!(declares_companion_admission(&manifest(
            "\"companion.admission\""
        )));
        assert!(!declares_companion_admission(&manifest("\"flow.*\"")));
        assert!(!declares_companion_admission(&manifest(
            "\"companion.*\""
        )));
    }

    /// AOK-302: admission is declared by EITHER the generic capability or the
    /// legacy alias — but never by a wildcard grant.
    #[test]
    fn declares_admission_accepts_generic_or_legacy_but_not_wildcards() {
        assert!(declares_admission(&manifest("\"host.admission\"")));
        assert!(declares_admission(&manifest("\"companion.admission\"")));
        assert!(!declares_admission(&manifest("\"flow.*\"")));
        assert!(!declares_admission(&manifest("\"host.*\"")));
        assert!(!declares_admission(&manifest("\"companion.*\"")));
    }

    /// AOK-302: a generic capability name does NOT widen who the host brokers
    /// for — only `admission_eligible` plugins qualify.
    #[test]
    fn admission_eligibility_is_a_stated_policy_not_a_generic_open_door() {
        assert!(admission_eligible("aokie"));
        assert!(!admission_eligible("not-aokie"));
        assert!(!admission_eligible("some-other-plugin"));
    }

    #[test]
    fn identity_only_private_bootstrap_names_the_plugin_for_brokered_admission() {
        let identity = json!({
            "endpointIdentity": {
                "algorithm": "ed25519",
                "publicKey": "desktop-public-key",
                "thumbprint": "desktop-thumbprint",
                "privateKeySeed": "private-seed",
            },
            "approvedMobileRoster": {
                "revision": 1,
                "rosterHash": "roster-hash",
                "keys": [],
            },
        });

        let bootstrap =
            compose_private_aokie_bootstrap("aokie", identity, None).expect("bootstrap");

        assert_eq!(bootstrap["schemaVersion"], 2);
        assert_eq!(bootstrap["pluginId"], "aokie");
        assert!(bootstrap.get("endpointIdentity").is_some());
        assert!(bootstrap.get("approvedMobileRoster").is_some());
        assert!(bootstrap.get("gatewayUrl").is_none());
        assert!(bootstrap.get("accessToken").is_none());
        assert!(bootstrap.get("appId").is_none());
    }

    #[tokio::test]
    async fn companion_admission_is_pinned_to_aokie_and_a_linked_handler() {
        let h = host();
        let m = manifest("\"companion.admission\"");
        let wrong_plugin = handle_inbound_plugin_request(
            &h,
            &m,
            "not-aokie",
            true,
            "companion.admission",
            json!({}),
        )
        .await
        .unwrap_err();
        assert_eq!(wrong_plugin.data.unwrap()["code"], "capability_denied");

        let unsigned = handle_inbound_plugin_request(
            &h,
            &m,
            "aokie",
            false,
            "companion.admission",
            json!({}),
        )
        .await
        .unwrap_err();
        assert_eq!(unsigned.data.unwrap()["code"], "capability_denied");

        let unlinked = handle_inbound_plugin_request(
            &h,
            &m,
            "aokie",
            true,
            "companion.admission",
            json!({ "appId": "app_1", "pluginId": "plugin_1" }),
        )
        .await
        .unwrap_err();
        assert_eq!(unlinked.data.unwrap()["code"], "runner_unavailable");
    }

    /// AOK-302: the generic `host.admission` method is gated by the SAME
    /// security authority as the legacy alias — eligible plugin, package
    /// verified, account linked — and a plugin declaring only the generic
    /// capability reaches the broker (unlinked → runner_unavailable proves it
    /// passed the capability gate).
    #[tokio::test]
    async fn host_admission_is_generic_but_keeps_the_security_authority() {
        let h = host();
        let generic = manifest("\"host.admission\"");

        // Not eligible → denied even with the generic capability + verified pkg.
        let wrong_plugin =
            handle_inbound_plugin_request(&h, &generic, "not-aokie", true, "host.admission", json!({}))
                .await
                .unwrap_err();
        assert_eq!(wrong_plugin.data.unwrap()["code"], "capability_denied");

        // Eligible but unsigned → denied.
        let unsigned =
            handle_inbound_plugin_request(&h, &generic, "aokie", false, "host.admission", json!({}))
                .await
                .unwrap_err();
        assert_eq!(unsigned.data.unwrap()["code"], "capability_denied");

        // Eligible + verified + declares the generic capability → past the gate,
        // into the broker (no linked handler in the test host).
        let unlinked = handle_inbound_plugin_request(
            &h,
            &generic,
            "aokie",
            true,
            "host.admission",
            json!({ "appId": "app_1", "pluginId": "plugin_1" }),
        )
        .await
        .unwrap_err();
        assert_eq!(unlinked.data.unwrap()["code"], "runner_unavailable");

        // The legacy alias still works when only the generic capability is
        // declared — either method name is accepted under either capability.
        let alias_ok = handle_inbound_plugin_request(
            &h,
            &generic,
            "aokie",
            true,
            "companion.admission",
            json!({ "appId": "app_1", "pluginId": "plugin_1" }),
        )
        .await
        .unwrap_err();
        assert_eq!(alias_ok.data.unwrap()["code"], "runner_unavailable");
    }

    #[tokio::test]
    async fn missing_capability_is_capability_denied() {
        let h = host();
        let m = manifest("\"connector.aokie.call.answer\"");
        let err = handle_inbound_plugin_request(&h, &m, "aokie", false, "flow.run", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.data.unwrap()["code"], "capability_denied");
    }

    #[tokio::test]
    async fn declared_but_unlinked_is_runner_unavailable() {
        let h = host(); // no rpc handler registered (no account linked)
        let m = manifest("\"flow.run\"");
        let err =
            handle_inbound_plugin_request(&h, &m, "aokie", false, "flow.run", json!({ "flowSlug": "x" }))
                .await
                .unwrap_err();
        assert_eq!(err.data.unwrap()["code"], "runner_unavailable");
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let h = host();
        let m = manifest("\"flow.run\"");
        let err = handle_inbound_plugin_request(&h, &m, "aokie", false, "not.a.method", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code, -32601);
    }

    #[tokio::test]
    async fn uninstall_removes_dir_and_slot_and_reoffers_builtin() {
        let h = host();
        // Materialise the bundled Aokie template, then uninstall it.
        h.install_builtin("aokie").expect("install builtin");
        let dir = h.plugins_root().join("aokie");
        assert!(dir.join("manifest.json").is_file());
        assert!(h.get("aokie").is_some());

        h.uninstall("aokie", false).await.expect("uninstall");
        assert!(!dir.exists(), "plugin dir must be removed");
        assert!(h.get("aokie").is_none(), "slot must be forgotten");
        // The bundled template is offered for install again.
        let builtins = h.builtin_plugins();
        let aokie = builtins
            .iter()
            .find(|b| b.id == "aokie")
            .expect("template listed");
        assert!(!aokie.installed);

        // Unknown ids refuse cleanly.
        assert!(h.uninstall("aokie", false).await.is_err());
    }

    /// PLG-107: `purge` also removes the plugin's writable data dir; without it
    /// the data survives an uninstall for a later reinstall.
    #[tokio::test]
    async fn uninstall_purge_removes_plugin_data() {
        let h = host();
        h.install_builtin("aokie").expect("install builtin");
        // Seed some writable data as a running plugin would.
        let data_dir = h.plugin_data_root.join("aokie");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("settings.json"), "{}").unwrap();

        // Uninstall WITHOUT purge keeps the data.
        h.uninstall("aokie", false).await.expect("uninstall");
        assert!(data_dir.join("settings.json").exists(), "data kept without purge");

        // Reinstall + uninstall WITH purge removes it.
        h.install_builtin("aokie").expect("reinstall builtin");
        h.uninstall("aokie", true).await.expect("uninstall+purge");
        assert!(!data_dir.exists(), "purge must remove the data dir");
    }

    /// PLG-105: disable persists the opt-out (stops + blocks autostart); enable
    /// clears it.
    #[tokio::test]
    async fn disable_then_enable_round_trip() {
        let h = host();
        h.install_builtin("aokie").expect("install builtin");
        h.set_enabled("aokie", false).await.expect("disable");
        let snap = h.get("aokie").expect("slot");
        assert_eq!(snap.state, PluginState::Disabled);
        // The persisted flag survives a rescan.
        h.scan();
        assert_eq!(h.get("aokie").unwrap().state, PluginState::Disabled);
        // Re-enable clears it (back to installed; binary-missing reason is fine).
        h.set_enabled("aokie", true).await.expect("enable");
        assert_ne!(h.get("aokie").unwrap().state, PluginState::Disabled);
    }
}
