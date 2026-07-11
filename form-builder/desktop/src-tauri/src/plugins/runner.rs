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
    Crashed(String),
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
                if let Some(reason) =
                    crate::plugins::registry::binary_missing_reason(&slot.dir, m)
                {
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

    /// Uninstall a plugin (`DELETE /api/plugins/{id}`): stop it if active,
    /// remove `<plugins>/<id>` (manifest + binary), and forget the slot. The
    /// plugin's WRITABLE data under `<plugin-data>/<id>` (settings, outbox,
    /// pairing) is deliberately KEPT so a reinstall resumes where it left off
    /// — wiping data is a separate, explicit filesystem action. A bundled
    /// built-in (e.g. Aokie) reappears as an installable template afterwards.
    pub async fn uninstall(self: &Arc<Self>, id: &str) -> Result<(), String> {
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
            map.remove(id);
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
        let res = client.request("plugin.health", json!({}), HEALTH_TIMEOUT).await;
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

/// True when a manifest declares the `flow.run` capability (bare or `flow.*`).
pub fn declares_flow_run(manifest: &crate::plugins::manifest::PluginManifest) -> bool {
    manifest
        .capabilities
        .iter()
        .any(|c| c == FLOW_RUN_CAPABILITY || c == "flow.*")
}

/// Handle one inbound plugin request. Only `flow.run` is supported, and only
/// when the manifest DECLARES the `flow.run` capability (else `capability_denied`)
/// and a FormLogic account is linked (else `runner_unavailable`).
async fn handle_inbound_plugin_request(
    host: &Arc<PluginHost>,
    manifest: &crate::plugins::manifest::PluginManifest,
    plugin_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, crate::plugins::rpc::RpcErrorObj> {
    use crate::plugins::rpc::RpcErrorObj;
    if method != "flow.run" {
        return Err(RpcErrorObj { code: -32601, message: format!("method not found: {method}"), data: None });
    }
    if !declares_flow_run(manifest) {
        return Err(RpcErrorObj {
            code: -32000,
            message: "capability 'flow.run' is not declared in the plugin manifest".into(),
            data: Some(json!({ "code": "capability_denied" })),
        });
    }
    match host.rpc_handler() {
        Some(h) => h.handle(plugin_id.to_string(), method.to_string(), params).await,
        None => Err(RpcErrorObj {
            code: -32001,
            message: "flow runtime is not linked to a FormLogic account".into(),
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
            RunOutcome::Crashed(reason) => {
                let attempts = {
                    let mut map = host.lock_plugins();
                    match map.get_mut(&id) {
                        Some(slot) if slot.generation == gen => {
                            slot.state = PluginState::Crashed;
                            slot.reason = Some(reason.clone());
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
async fn run_once(host: &Arc<PluginHost>, id: &str, gen: u64) -> RunOutcome {
    // Snapshot everything needed to spawn, without holding the lock across IO.
    let (dir, manifest, logs) = {
        let map = host.lock_plugins();
        match map.get(id) {
            Some(slot) if slot.generation == gen => match &slot.manifest {
                Some(m) => (slot.dir.clone(), m.clone(), slot.logs.clone()),
                None => return RunOutcome::Crashed("manifest missing".into()),
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
    let receipts = match crate::plugins::receipts::EventReceipts::open(
        data_dir.join("host-event-receipts.jsonl"),
    ) {
        Ok(r) => Some(Arc::new(r)),
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
        Err(e) => return RunOutcome::Crashed(format!("spawn failed: {e}")),
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
                                        host.events.publish_from_plugin(
                                            &id, &manifest, envelope, &logs,
                                        );
                                        pump_client
                                            .notify(
                                                "event.ack",
                                                json!({ "idempotencyKey": key }),
                                            )
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
                                            .notify(
                                                "event.ack",
                                                json!({ "idempotencyKey": key }),
                                            )
                                            .await;
                                    }
                                    Err(e) => {
                                        logs.push(
                                            "stderr",
                                            format!(
                                                "[desktop] receipt journal write failed for {key}: {e} — NOT acked, plugin will re-deliver"
                                            ),
                                        );
                                        host.events.publish_from_plugin(
                                            &id, &manifest, envelope, &logs,
                                        );
                                    }
                                }
                            }
                            // No journal or no idempotencyKey: legacy path.
                            _ => {
                                host.events.publish_from_plugin(&id, &manifest, envelope, &logs);
                            }
                        }
                    }
                    rpc::PluginNotification::Log { level, message } => {
                        logs.push("stdout", format!("[{level}] {message}"));
                    }
                    rpc::PluginNotification::Request { id: rpc_id, method, params } => {
                        // Gate + route off the pump so a slow flow can't stall
                        // event/log delivery; the reply goes back over stdin.
                        let host = host.clone();
                        let manifest = manifest.clone();
                        let client = pump_client.clone();
                        let plugin_id = id.clone();
                        tokio::spawn(async move {
                            let outcome =
                                handle_inbound_plugin_request(&host, &manifest, &plugin_id, &method, params).await;
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
    let init_params = json!({
        "desktopVersion": env!("CARGO_PKG_VERSION"),
        "pluginApiVersion": crate::PLUGIN_API_VERSION,
        "dataDir": data_dir.display().to_string(),
        "devMode": host.dev_mode,
        "features": features,
    });
    tokio::select! {
        res = client.request("plugin.init", init_params, INIT_TIMEOUT) => {
            if let Err(f) = res {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return RunOutcome::Crashed(format!("plugin.init failed: {}", failure_text(&f)));
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
                return RunOutcome::Crashed(match code {
                    Some(c) => format!("process exited with code {c}"),
                    None => "process exited (killed by signal)".into(),
                });
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
        let _ = client.request("plugin.shutdown", json!({}), SHUTDOWN_GRACE).await;
        let _ = child.wait().await;
    };
    if tokio::time::timeout(SHUTDOWN_GRACE, graceful).await.is_err() {
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
                detail: v
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
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
        assert!(!declares_flow_run(&manifest("\"connector.aokie.call.answer\"")));
    }

    #[tokio::test]
    async fn missing_capability_is_capability_denied() {
        let h = host();
        let m = manifest("\"connector.aokie.call.answer\"");
        let err = handle_inbound_plugin_request(&h, &m, "aokie", "flow.run", json!({})).await.unwrap_err();
        assert_eq!(err.data.unwrap()["code"], "capability_denied");
    }

    #[tokio::test]
    async fn declared_but_unlinked_is_runner_unavailable() {
        let h = host(); // no rpc handler registered (no account linked)
        let m = manifest("\"flow.run\"");
        let err = handle_inbound_plugin_request(&h, &m, "aokie", "flow.run", json!({ "flowSlug": "x" })).await.unwrap_err();
        assert_eq!(err.data.unwrap()["code"], "runner_unavailable");
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let h = host();
        let m = manifest("\"flow.run\"");
        let err = handle_inbound_plugin_request(&h, &m, "aokie", "not.a.method", json!({})).await.unwrap_err();
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

        h.uninstall("aokie").await.expect("uninstall");
        assert!(!dir.exists(), "plugin dir must be removed");
        assert!(h.get("aokie").is_none(), "slot must be forgotten");
        // The bundled template is offered for install again.
        let builtins = h.builtin_plugins();
        let aokie = builtins.iter().find(|b| b.id == "aokie").expect("template listed");
        assert!(!aokie.installed);

        // Unknown ids refuse cleanly.
        assert!(h.uninstall("aokie").await.is_err());
    }
}
