//! PLG-205 — PluginInstallation → ConnectorInstance → AppBinding.
//!
//! A host-authoritative local record binding one connector instance (a plugin's
//! declared connector) to exactly ONE app. The Desktop persists the local
//! record; the hosted deployment persists a matching remote record (that side
//! lands with the Aokie migration / Phase 3). Every ownership change bumps a
//! monotonic epoch; a command/event carrying a stale epoch fails closed.
//!
//! Additive + non-breaking: bindings are consulted by the connector gateway
//! ONLY to reject a request whose app context contradicts an existing binding.
//! A request with NO app context (today's relay + direct-command paths) is
//! never affected, so the live receptionist keeps working with zero bindings.
//!
//! The host STAMPS every identity — a plugin or pack cannot supply its own
//! scope fields; they are ignored/rejected.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The state of a binding from the desktop's local point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingState {
    /// The connector instance is bound to this app and dispatch is allowed.
    Active,
    /// Bound but paused (the app or operator deactivated it).
    Inactive,
    /// The plugin/connector is not currently installed.
    Missing,
    /// The contract version is incompatible with what the app expects.
    Incompatible,
}

/// One host-authoritative binding record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBinding {
    /// Stable id for this binding record.
    pub binding_id: String,
    /// The plugin providing the connector.
    pub plugin_id: String,
    /// The connector id inside that plugin (the ConnectorInstance key).
    pub connector_id: String,
    /// The app this connector is bound to (host-stamped from the request).
    pub app_id: String,
    /// The deployment the app belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    /// The desktop connection id (which linked desktop owns this binding).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_connection_id: Option<String>,
    /// Monotonic epoch; incremented on every ownership change. A command/event
    /// with a stale epoch fails closed.
    pub epoch: u64,
    pub state: BindingState,
    pub created_at: String,
    pub updated_at: String,
}

/// The persisted document.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct BindingsDoc {
    #[serde(default)]
    bindings: Vec<AppBinding>,
}

pub struct BindingStore {
    path: PathBuf,
    doc: BindingsDoc,
    /// Monotonic counter for minting binding ids without wall-clock (which
    /// isn't available in some contexts); combined with the plugin id.
    seq: u64,
}

impl BindingStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("app-bindings.json");
        let doc = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<BindingsDoc>(&s).ok())
            .unwrap_or_default();
        let seq = doc.bindings.len() as u64;
        Self { path, doc, seq }
    }

    fn persist(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&self.doc) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &self.path).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }

    pub fn list(&self) -> Vec<AppBinding> {
        self.doc.bindings.clone()
    }

    /// The active binding for a connector, if any.
    pub fn active_for_connector(&self, plugin_id: &str, connector_id: &str) -> Option<AppBinding> {
        self.doc
            .bindings
            .iter()
            .find(|b| {
                b.plugin_id == plugin_id
                    && b.connector_id == connector_id
                    && b.state == BindingState::Active
            })
            .cloned()
    }

    /// Bind a connector instance to an app (host-stamped). One physical
    /// connector has ONE active owning app — an existing active binding for the
    /// same connector to a DIFFERENT app is deactivated and the new one takes
    /// over (both bump the epoch). Ownership may only switch while the line is
    /// idle; the caller (dispatch/relay) enforces idleness before calling this.
    pub fn bind(
        &mut self,
        plugin_id: &str,
        connector_id: &str,
        app_id: &str,
        deployment_id: Option<String>,
        desktop_connection_id: Option<String>,
        now_iso: &str,
    ) -> AppBinding {
        // Deactivate any other active binding for this connector (single owner).
        let mut max_epoch = 0u64;
        for b in &mut self.doc.bindings {
            if b.plugin_id == plugin_id && b.connector_id == connector_id {
                max_epoch = max_epoch.max(b.epoch);
                if b.app_id != app_id && b.state == BindingState::Active {
                    b.state = BindingState::Inactive;
                    b.updated_at = now_iso.to_string();
                }
            }
        }
        let epoch = max_epoch + 1;
        // Upsert the binding for (connector, app).
        if let Some(existing) = self.doc.bindings.iter_mut().find(|b| {
            b.plugin_id == plugin_id && b.connector_id == connector_id && b.app_id == app_id
        }) {
            existing.state = BindingState::Active;
            existing.epoch = epoch;
            existing.deployment_id = deployment_id;
            existing.desktop_connection_id = desktop_connection_id;
            existing.updated_at = now_iso.to_string();
            let out = existing.clone();
            self.persist();
            return out;
        }
        self.seq += 1;
        let binding = AppBinding {
            binding_id: format!("bind-{plugin_id}-{connector_id}-{}", self.seq),
            plugin_id: plugin_id.to_string(),
            connector_id: connector_id.to_string(),
            app_id: app_id.to_string(),
            deployment_id,
            desktop_connection_id,
            epoch,
            state: BindingState::Active,
            created_at: now_iso.to_string(),
            updated_at: now_iso.to_string(),
        };
        self.doc.bindings.push(binding.clone());
        self.persist();
        binding
    }

    /// Revoke a binding by id (state → Inactive, epoch bumped so stale commands
    /// fail closed).
    pub fn revoke(&mut self, binding_id: &str, now_iso: &str) -> Result<(), String> {
        let Some(b) = self.doc.bindings.iter_mut().find(|b| b.binding_id == binding_id) else {
            return Err(format!("unknown binding {binding_id:?}"));
        };
        b.state = BindingState::Inactive;
        b.epoch += 1;
        b.updated_at = now_iso.to_string();
        self.persist();
        Ok(())
    }

    /// Drop every binding for a plugin (called on uninstall).
    pub fn forget_plugin(&mut self, plugin_id: &str) {
        let before = self.doc.bindings.len();
        self.doc.bindings.retain(|b| b.plugin_id != plugin_id);
        if self.doc.bindings.len() != before {
            self.persist();
        }
    }

    /// PLG-205 non-breaking enforcement: decide whether a dispatch is allowed.
    /// `app_context` is the (appId, epoch) the CALLER claims, or None. Returns
    /// Ok when allowed, Err(reason) when it contradicts an active binding.
    /// A request with NO app context is ALWAYS allowed (today's relay/direct
    /// paths), so a connector with zero bindings behaves exactly as before.
    pub fn check_dispatch(
        &self,
        plugin_id: &str,
        connector_id: &str,
        app_context: Option<(&str, Option<u64>)>,
    ) -> Result<(), String> {
        let Some((app_id, epoch)) = app_context else {
            return Ok(()); // no app context → unchanged legacy behavior
        };
        match self.active_for_connector(plugin_id, connector_id) {
            None => Ok(()), // nothing bound → allowed (opt-in model)
            Some(binding) => {
                if binding.app_id != app_id {
                    return Err(format!(
                        "connector {connector_id:?} is bound to a different app (bound_elsewhere)"
                    ));
                }
                if let Some(e) = epoch {
                    if e != binding.epoch {
                        return Err(format!(
                            "stale binding epoch (have {e}, current {})",
                            binding.epoch
                        ));
                    }
                }
                Ok(())
            }
        }
    }
}

pub type BindingStoreHandle = Arc<Mutex<BindingStore>>;

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fl-bind-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn bind_persists_and_reloads() {
        let dir = tmp();
        {
            let mut s = BindingStore::load(&dir);
            s.bind("aokie", "aokie", "app1", Some("dep1".into()), None, "t0");
        }
        let s = BindingStore::load(&dir);
        let b = s.active_for_connector("aokie", "aokie").unwrap();
        assert_eq!(b.app_id, "app1");
        assert_eq!(b.epoch, 1);
        assert_eq!(b.state, BindingState::Active);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_active_owner_per_connector_switch_bumps_epoch() {
        let dir = tmp();
        let mut s = BindingStore::load(&dir);
        let b1 = s.bind("aokie", "aokie", "app1", None, None, "t0");
        assert_eq!(b1.epoch, 1);
        // A second app takes over — app1 is deactivated, epoch increments.
        let b2 = s.bind("aokie", "aokie", "app2", None, None, "t1");
        assert_eq!(b2.app_id, "app2");
        assert_eq!(b2.epoch, 2);
        // Only app2 is active now.
        let active = s.active_for_connector("aokie", "aokie").unwrap();
        assert_eq!(active.app_id, "app2");
        // app1's record is retained but inactive.
        assert!(s.list().iter().any(|b| b.app_id == "app1" && b.state == BindingState::Inactive));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_dispatch_is_non_breaking_without_app_context() {
        let dir = tmp();
        let mut s = BindingStore::load(&dir);
        s.bind("aokie", "aokie", "app1", None, None, "t0");
        // No app context → always allowed (the live relay/direct path).
        assert!(s.check_dispatch("aokie", "aokie", None).is_ok());
        // Matching app + epoch → allowed.
        assert!(s.check_dispatch("aokie", "aokie", Some(("app1", Some(1)))).is_ok());
        // Wrong app → refused (bound_elsewhere).
        assert!(s.check_dispatch("aokie", "aokie", Some(("other", None))).unwrap_err().contains("bound to a different app"));
        // Stale epoch → refused.
        assert!(s.check_dispatch("aokie", "aokie", Some(("app1", Some(99)))).unwrap_err().contains("stale binding epoch"));
        // A connector with NO binding → allowed even with app context (opt-in).
        assert!(s.check_dispatch("weather", "weather", Some(("appX", None))).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoke_and_forget() {
        let dir = tmp();
        let mut s = BindingStore::load(&dir);
        let b = s.bind("aokie", "aokie", "app1", None, None, "t0");
        s.revoke(&b.binding_id, "t1").unwrap();
        assert!(s.active_for_connector("aokie", "aokie").is_none());
        assert!(s.revoke("nope", "t2").is_err());
        s.forget_plugin("aokie");
        assert!(s.list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
