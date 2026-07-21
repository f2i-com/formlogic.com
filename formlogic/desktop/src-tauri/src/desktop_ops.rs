//! Shared Desktop-ops handlers — Phase 3 of
//! docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md (§5.3 ops relay).
//!
//! The service/plugin lifecycle surface exists TWICE by design: the localhost
//! HTTP API (`http.rs`, driven by the operator's browser) and the remote ops
//! relay (`flows/relay.rs` intercepts relay commands whose connector id is the
//! reserved `desktop`). Both must do EXACTLY the same thing, so the handlers
//! live here once and each surface maps the outcome onto its own wire shape —
//! `http.rs` keeps its historical responses byte-for-byte (204 on lifecycle
//! mutations, the pre-serialized services snapshot, its error envelopes), the
//! relay completes commands `{status:'done'|'failed'}`.
//!
//! [`DesktopOp::from_command`] is the allow-list and the ONLY way to name an
//! op from the wire — anything else is a typed refusal BEFORE any side effect.
//!
//!   services: list / start / stop / restart / repair   (services registry)
//!   plugins:  list / start / stop / restart / health   (plugin host)

use serde_json::{json, Value};

use crate::plugins::registry::PluginHostHandle;
use crate::services::registry::{Registry, RegistryHandle};

/// The ops allow-list (plan §5.3). The wire command names are
/// `services.<verb>` / `plugins.<verb>` — the `desktop.` prefix is the
/// reserved connector id, not part of the command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopOp {
    ServicesList,
    ServicesStart,
    ServicesStop,
    ServicesRestart,
    ServicesRepair,
    PluginsList,
    PluginsStart,
    PluginsStop,
    PluginsRestart,
    PluginsHealth,
}

impl DesktopOp {
    /// The allow-list. `None` = not an op the desktop may run remotely — the
    /// caller turns that into a typed failure (never a dispatch).
    pub fn from_command(command: &str) -> Option<Self> {
        Some(match command {
            "services.list" => Self::ServicesList,
            "services.start" => Self::ServicesStart,
            "services.stop" => Self::ServicesStop,
            "services.restart" => Self::ServicesRestart,
            "services.repair" => Self::ServicesRepair,
            "plugins.list" => Self::PluginsList,
            "plugins.start" => Self::PluginsStart,
            "plugins.stop" => Self::PluginsStop,
            "plugins.restart" => Self::PluginsRestart,
            "plugins.health" => Self::PluginsHealth,
            _ => return None,
        })
    }

    /// The wire command name (for messages).
    pub fn command(self) -> &'static str {
        match self {
            Self::ServicesList => "services.list",
            Self::ServicesStart => "services.start",
            Self::ServicesStop => "services.stop",
            Self::ServicesRestart => "services.restart",
            Self::ServicesRepair => "services.repair",
            Self::PluginsList => "plugins.list",
            Self::PluginsStart => "plugins.start",
            Self::PluginsStop => "plugins.stop",
            Self::PluginsRestart => "plugins.restart",
            Self::PluginsHealth => "plugins.health",
        }
    }

    /// True for the lifecycle verbs, which take their target as `payload.id`.
    fn needs_id(self) -> bool {
        !matches!(self, Self::ServicesList | Self::PluginsList)
    }
}

/// A successful op's body. `http.rs` turns it into a response; the relay turns
/// it into the command `result` via [`OpSuccess::into_relay_result`].
#[derive(Debug, Clone)]
pub enum OpSuccess {
    /// Lifecycle mutation accepted — HTTP 204; relay `{ "ok": true }`.
    Empty,
    /// JSON body — HTTP 200; the relay result verbatim.
    Json(Value),
    /// The services snapshot is PRE-SERIALIZED (SRV-001: an `Arc<String>`
    /// clone on the hot path, never a rescan) — http serves it raw with
    /// content-type application/json; the relay parses it back into a Value so
    /// command results stay JSON.
    RawJson(String),
}

impl OpSuccess {
    /// The value carried as a relay command's `result`.
    pub fn into_relay_result(self) -> Value {
        match self {
            OpSuccess::Empty => json!({ "ok": true }),
            OpSuccess::Json(v) => v,
            OpSuccess::RawJson(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        }
    }
}

/// A failed op. `status` keeps http.rs's historical 400/404/500 split; the
/// relay carries only the typed `code` + `message`.
#[derive(Debug, Clone)]
pub struct OpFailure {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl OpFailure {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "command_failed",
            message: message.into(),
        }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            code: "command_failed",
            message: message.into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code: "command_failed",
            message: message.into(),
        }
    }
}

// ── services (services registry) ────────────────────────────────────────────

/// `services.list` — the pre-serialized, revision-keyed snapshot (SRV-001): an
/// Arc clone on the hot path with NO filesystem or process probing. Template
/// folder-drops are picked up by the background refresher (registry::
/// background_refresh) instead of a rescan-per-poll here, and the mutex is
/// taken on the blocking pool so a rebuild can never stall async workers.
pub async fn services_list(registry: &RegistryHandle) -> Result<OpSuccess, OpFailure> {
    let registry = registry.clone();
    match tokio::task::spawn_blocking(move || {
        registry
            .lock()
            .map(|mut reg| reg.snapshot_cached())
            .map_err(|_| ())
    })
    .await
    {
        Ok(Ok(body)) => Ok(OpSuccess::RawJson(body.as_str().to_owned())),
        _ => Err(OpFailure::internal("registry mutex poisoned")),
    }
}

pub fn service_start(registry: &RegistryHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    service_mutation(registry, |reg| reg.start(id))
}

pub fn service_stop(registry: &RegistryHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    service_mutation(registry, |reg| reg.stop(id))
}

/// `services.repair` (PROC-001): resets the crash-loop breaker + scheduled
/// restarts, tears down any stale process tree, verifies the port is actually
/// free (naming a foreign holder instead of spawning into a doomed bind race)
/// and starts fresh.
pub fn service_repair(registry: &RegistryHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    service_mutation(registry, |reg| reg.repair(id))
}

/// `services.restart` has no localhost HTTP route of its own; the ops relay
/// gets it as stop + start under ONE registry lock, so a concurrent list never
/// observes a half-restarted service.
pub fn service_restart(registry: &RegistryHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    service_mutation(registry, |reg| {
        // Best-effort stop: not-running is fine, a genuine stop failure is
        // surfaced by the start that follows (same as the repair flow).
        let _ = reg.stop(id);
        reg.start(id)
    })
}

fn service_mutation(
    registry: &RegistryHandle,
    action: impl FnOnce(&mut Registry) -> Result<(), String>,
) -> Result<OpSuccess, OpFailure> {
    registry
        .lock()
        .map_err(|_| OpFailure::bad_request("registry mutex poisoned"))
        .and_then(|mut reg| action(&mut reg).map_err(OpFailure::bad_request))?;
    Ok(OpSuccess::Empty)
}

// ── plugins (plugin host) ───────────────────────────────────────────────────

/// `plugins.list` — installed plugins + bundled first-party templates (the
/// same document `GET /api/plugins` serves).
pub fn plugins_list(host: &PluginHostHandle) -> Result<OpSuccess, OpFailure> {
    Ok(OpSuccess::Json(json!({
        "pluginsDir": host.plugins_root().display().to_string(),
        // Dev mode drives dev-only panel affordances (Aokie's simulate-call).
        "devMode": host.dev_mode(),
        "plugins": host.list(),
        // Bundled first-party templates (e.g. Aokie) + installed flags, so
        // the panel can offer "Install" without a separate endpoint.
        "builtins": host.builtin_plugins(),
    })))
}

pub fn plugin_start(host: &PluginHostHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    host.start(id).map_err(OpFailure::bad_request)?;
    Ok(OpSuccess::Empty)
}

pub async fn plugin_stop(host: &PluginHostHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    host.stop(id).await.map_err(OpFailure::bad_request)?;
    Ok(OpSuccess::Empty)
}

pub async fn plugin_restart(host: &PluginHostHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    host.restart(id).await.map_err(OpFailure::bad_request)?;
    Ok(OpSuccess::Empty)
}

/// `plugins.health` — probes a running plugin on demand (the probe also
/// becomes the recorded "last" report); otherwise returns the last report
/// from the supervisor's 10 s ticker.
pub async fn plugin_health(host: &PluginHostHandle, id: &str) -> Result<OpSuccess, OpFailure> {
    if host.get(id).is_none() {
        return Err(OpFailure::not_found(format!("unknown plugin {id:?}")));
    }
    // On-demand probe when live; errors are reflected in the report itself.
    let _ = host.probe_health(id).await;
    match host.last_health(id) {
        Some(h) => Ok(OpSuccess::Json(json!({ "health": h }))),
        None => Err(OpFailure::not_found(format!("unknown plugin {id:?}"))),
    }
}

// ── relay entry point ───────────────────────────────────────────────────────

/// Execute one allow-listed relay op. `registry` is `None` on a runtime wired
/// without the services registry — services ops then fail typed, never panic.
/// Lifecycle verbs take their target as `payload.id` (the service/plugin id).
pub async fn execute(
    op: DesktopOp,
    registry: Option<&RegistryHandle>,
    host: &PluginHostHandle,
    payload: &Value,
) -> Result<OpSuccess, OpFailure> {
    let id = if op.needs_id() {
        let raw = payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        Some(raw.ok_or_else(|| {
            OpFailure::bad_request(format!("desktop op '{}' requires payload.id", op.command()))
        })?)
    } else {
        None
    };
    let id = id.as_deref().unwrap_or("");
    let registry = || {
        registry.ok_or_else(|| {
            OpFailure::bad_request("the services registry is unavailable on this desktop")
        })
    };
    match op {
        DesktopOp::ServicesList => services_list(registry()?).await,
        DesktopOp::ServicesStart => service_start(registry()?, id),
        DesktopOp::ServicesStop => service_stop(registry()?, id),
        DesktopOp::ServicesRestart => service_restart(registry()?, id),
        DesktopOp::ServicesRepair => service_repair(registry()?, id),
        DesktopOp::PluginsList => plugins_list(host),
        DesktopOp::PluginsStart => plugin_start(host, id),
        DesktopOp::PluginsStop => plugin_stop(host, id).await,
        DesktopOp::PluginsRestart => plugin_restart(host, id).await,
        DesktopOp::PluginsHealth => plugin_health(host, id).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_list_accepts_exactly_the_ten_documented_ops() {
        let expected = [
            ("services.list", DesktopOp::ServicesList),
            ("services.start", DesktopOp::ServicesStart),
            ("services.stop", DesktopOp::ServicesStop),
            ("services.restart", DesktopOp::ServicesRestart),
            ("services.repair", DesktopOp::ServicesRepair),
            ("plugins.list", DesktopOp::PluginsList),
            ("plugins.start", DesktopOp::PluginsStart),
            ("plugins.stop", DesktopOp::PluginsStop),
            ("plugins.restart", DesktopOp::PluginsRestart),
            ("plugins.health", DesktopOp::PluginsHealth),
        ];
        for (wire, op) in expected {
            assert_eq!(DesktopOp::from_command(wire), Some(op), "op {wire}");
            assert_eq!(op.command(), wire);
        }
        for rejected in [
            "",
            "services",
            "services.delete",
            "plugins.install",
            "plugins.enable",
            "plugins.disable",
            "services.list ",
            "SERVICES.LIST",
            "desktop.services.list", // the prefix is the connector id, not the command
        ] {
            assert_eq!(
                DesktopOp::from_command(rejected),
                None,
                "accepted {rejected:?}"
            );
        }
    }

    #[test]
    fn lifecycle_ops_require_payload_id() {
        assert!(DesktopOp::ServicesStart.needs_id());
        assert!(DesktopOp::PluginsHealth.needs_id());
        assert!(!DesktopOp::ServicesList.needs_id());
        assert!(!DesktopOp::PluginsList.needs_id());
    }

    fn test_host() -> PluginHostHandle {
        crate::plugins::registry::PluginHost::new(
            &std::env::temp_dir().join(format!("fl-desktop-ops-{}", uuid::Uuid::new_v4().simple())),
            false,
            crate::events::EventBus::new(),
        )
    }

    #[tokio::test]
    async fn lifecycle_op_without_payload_id_is_a_typed_refusal() {
        let host = test_host();
        let failure = execute(DesktopOp::PluginsHealth, None, &host, &json!({}))
            .await
            .expect_err("payload.id is required");
        assert_eq!(failure.status, 400);
        assert!(
            failure.message.contains("payload.id"),
            "got: {}",
            failure.message
        );
    }

    #[tokio::test]
    async fn plugin_health_on_unknown_plugin_is_not_found() {
        let host = test_host();
        let failure = execute(
            DesktopOp::PluginsHealth,
            None,
            &host,
            &json!({ "id": "nope" }),
        )
        .await
        .expect_err("unknown plugin");
        assert_eq!(failure.status, 404);
        assert_eq!(failure.code, "command_failed");
    }

    #[tokio::test]
    async fn services_ops_without_a_registry_fail_typed() {
        let host = test_host();
        let failure = execute(DesktopOp::ServicesList, None, &host, &Value::Null)
            .await
            .expect_err("no registry wired");
        assert_eq!(failure.status, 400);
        assert!(
            failure.message.contains("registry is unavailable"),
            "got: {}",
            failure.message
        );
    }

    #[tokio::test]
    async fn plugins_list_runs_without_a_services_registry() {
        let host = test_host();
        let outcome = execute(DesktopOp::PluginsList, None, &host, &Value::Null)
            .await
            .expect("plugins.list needs no registry");
        let result = outcome.into_relay_result();
        assert!(result.get("plugins").is_some(), "got: {result}");
        assert!(result.get("pluginsDir").is_some(), "got: {result}");
    }

    #[test]
    fn services_restart_of_an_unknown_service_fails_typed() {
        // Registry::empty — no process is ever spawned for an unknown id.
        let registry: RegistryHandle = std::sync::Arc::new(std::sync::Mutex::new(
            crate::services::registry::Registry::empty(
                std::env::temp_dir().join(format!("fl-ops-reg-{}", uuid::Uuid::new_v4().simple())),
                std::env::temp_dir()
                    .join(format!("fl-ops-models-{}", uuid::Uuid::new_v4().simple())),
            ),
        ));
        let failure = service_restart(&registry, "nope").expect_err("unknown service");
        assert_eq!(failure.status, 400);
        assert!(
            failure.message.contains("unknown service"),
            "got: {}",
            failure.message
        );
    }
}
