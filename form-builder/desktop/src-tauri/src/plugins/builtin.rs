//! Built-in plugin TEMPLATES bundled with the desktop app.
//!
//! Mirrors how service templates are seeded from `resources/templates/`:
//! each first-party plugin's `manifest.json` is embedded at compile time
//! (the canonical copy lives in the plugin's own repo; `resources/plugins/
//! <id>/manifest.json` here is a byte-for-byte copy) and materialised into
//! `<data>/plugins/<id>/manifest.json` when the user clicks Install — the
//! SDK contract's "built-in plugin templates may be bundled with the
//! installer and materialised on first enable" (`DESKTOP_PLUGIN_SDK.md` §1).
//!
//! Only the MANIFEST is bundled. The plugin binary (`entry.command`, e.g.
//! `aokie-plugin.exe`) is built separately and dropped into the plugin
//! folder; until it is, the registry surfaces the distinct
//! "binary … not installed" reason (`registry::binary_missing_reason`)
//! instead of a spawn-and-crash loop.

use serde::Serialize;

use crate::plugins::registry::{compatibility_error, PluginHost};

/// One bundled template: the plugin id (must equal the manifest `id` AND the
/// directory name it installs into) plus the embedded manifest body.
pub struct BuiltinPluginTemplate {
    pub id: &'static str,
    pub manifest_json: &'static str,
}

/// The bundled first-party plugins.
///
/// `aokie` — the Aokie phone bridge (izuc/aokie → `crates/aokie-plugin`);
/// its manifest here mirrors that repo's canonical
/// `crates/aokie-plugin/manifest.json` (AOKIE_PLUGIN_CONTRACT.md §1-3).
pub const BUILTIN_PLUGIN_TEMPLATES: &[BuiltinPluginTemplate] = &[BuiltinPluginTemplate {
    id: "aokie",
    manifest_json: include_str!("../../resources/plugins/aokie/manifest.json"),
}];

/// Wire shape of one built-in template in `GET /api/plugins` (`builtins`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinPluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// True when `<plugins>/<id>/manifest.json` already exists on disk (the
    /// template card hides / flips to "installed" in the UI).
    pub installed: bool,
    /// Version-compat problem between the bundled manifest and THIS desktop
    /// build, if any (None = installable). A bundled template should never
    /// be incompatible — surfaced anyway so a bad release is visible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incompatible: Option<String>,
}

fn template(id: &str) -> Option<&'static BuiltinPluginTemplate> {
    BUILTIN_PLUGIN_TEMPLATES.iter().find(|t| t.id == id)
}

impl PluginHost {
    /// The bundled templates + whether each is already installed. Served in
    /// `GET /api/plugins` so the panel can offer "Install Aokie plugin".
    pub fn builtin_plugins(&self) -> Vec<BuiltinPluginInfo> {
        BUILTIN_PLUGIN_TEMPLATES
            .iter()
            .map(|t| {
                let installed = self
                    .plugins_root()
                    .join(t.id)
                    .join("manifest.json")
                    .is_file();
                match crate::plugins::manifest::parse_manifest(t.manifest_json) {
                    Ok(m) => BuiltinPluginInfo {
                        id: t.id.to_string(),
                        name: m.name.clone(),
                        version: m.version.clone(),
                        description: m.description.clone(),
                        installed,
                        incompatible: compatibility_error(&m),
                    },
                    // A bundled manifest that doesn't parse is a build bug —
                    // unit-tested below; still surfaced, never a silent skip.
                    Err(e) => BuiltinPluginInfo {
                        id: t.id.to_string(),
                        name: t.id.to_string(),
                        version: String::new(),
                        description: None,
                        installed,
                        incompatible: Some(format!("bundled manifest is invalid: {e}")),
                    },
                }
            })
            .collect()
    }

    /// Materialise a built-in template: `<plugins>/<id>/manifest.json` from
    /// the bundled copy (atomic tmp+rename, mirroring `persist`). Idempotent;
    /// re-installing refreshes a hand-edited manifest back to the bundled one
    /// (applies on the next restart when the plugin is running). Plugin-
    /// private files (its binary, DB, logs) are never touched.
    pub fn install_builtin(&self, id: &str) -> Result<(), String> {
        let t = template(id).ok_or_else(|| format!("unknown built-in plugin {id:?}"))?;
        // Validate before writing so a broken bundle can't materialise a
        // permanently-disabled install.
        let m = crate::plugins::manifest::parse_manifest(t.manifest_json)
            .map_err(|e| format!("bundled manifest for {id:?} is invalid: {e}"))?;
        if m.id != t.id {
            return Err(format!(
                "bundled manifest id {:?} does not match template id {:?}",
                m.id, t.id
            ));
        }
        let dir = self.plugins_root().join(t.id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create plugin dir {}: {e}", dir.display()))?;
        let target = dir.join("manifest.json");
        let tmp = dir.join("manifest.json.tmp");
        std::fs::write(&tmp, t.manifest_json)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        if let Err(e) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("cannot install {}: {e}", target.display()));
        }
        // Pick the new/updated plugin up immediately.
        self.scan();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventBus;
    use crate::plugins::manifest::parse_manifest;
    use std::path::PathBuf;

    fn temp_data_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fl-plugin-builtin-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every bundled template must parse, validate, match its template id,
    /// and be version-compatible with THIS desktop build — for the REAL
    /// aokie manifest this is the deliverable "verify the compat check works
    /// with the real manifest" (it must NOT read as disabled).
    #[test]
    fn bundled_templates_are_valid_and_compatible() {
        for t in BUILTIN_PLUGIN_TEMPLATES {
            let m = parse_manifest(t.manifest_json)
                .unwrap_or_else(|e| panic!("bundled manifest {} invalid: {e}", t.id));
            assert_eq!(m.id, t.id, "manifest id must equal the template id");
            assert_eq!(
                compatibility_error(&m),
                None,
                "bundled template {} must be compatible with this desktop",
                t.id
            );
        }
    }

    /// The real aokie manifest's declared surface is self-consistent: every
    /// connector command is covered by a capability (else the gateway would
    /// deny commands the contract promises), and the contract's MVP command
    /// set + event set are all present.
    #[test]
    fn aokie_manifest_surface_matches_the_contract() {
        let m = parse_manifest(template("aokie").unwrap().manifest_json).unwrap();
        assert_eq!(m.plugin_api_version, 1);
        let con = m.connector("aokie").expect("aokie connector declared");
        for cmd in &con.commands {
            assert!(
                m.command_allowed("aokie", cmd).is_ok(),
                "declared command {cmd} must be capability-covered"
            );
        }
        for cmd in [
            "dongle.list",
            "dongle.diagnostics",
            "phone.status",
            "call.answer",
            "sms.send",
            "settings.set",
        ] {
            assert!(m.declares_command("aokie", cmd), "MVP command {cmd} missing");
        }
        for ev in [
            "aokie.call.incoming",
            "aokie.call.turn.final",
            "aokie.call.ended",
            "aokie.sms.received",
            "aokie.dongle.ready",
            // Live-radio events the plugin actually emits — undeclared, the
            // host would silently drop them (audit C-03).
            "aokie.phone.connected",
            "aokie.call.ringing",
            "aokie.call.audio.connected",
            "aokie.call.audio.disconnected",
        ] {
            assert!(m.declares_event(ev), "MVP event {ev} missing");
        }
    }

    #[test]
    fn install_builtin_materialises_and_is_idempotent() {
        let data = temp_data_dir("install");
        let host = PluginHost::new(&data, false, EventBus::new());

        let before = host.builtin_plugins();
        let aokie = before.iter().find(|b| b.id == "aokie").expect("aokie listed");
        assert!(!aokie.installed);
        assert!(aokie.incompatible.is_none());
        assert_eq!(aokie.name, "Aokie Phone Bridge");

        host.install_builtin("aokie").expect("install");
        let manifest_path = data.join("plugins").join("aokie").join("manifest.json");
        assert!(manifest_path.is_file());
        assert_eq!(
            std::fs::read_to_string(&manifest_path).unwrap(),
            template("aokie").unwrap().manifest_json,
            "installed manifest is the bundled copy, byte for byte"
        );
        assert!(host
            .builtin_plugins()
            .iter()
            .find(|b| b.id == "aokie")
            .unwrap()
            .installed);
        // The plugin is registered right away (install_builtin rescans).
        let snap = host.get("aokie").expect("registered");
        assert_eq!(snap.name, "Aokie Phone Bridge");

        // Idempotent — and a hand-edited manifest is repaired to the bundle.
        std::fs::write(&manifest_path, "{ broken").unwrap();
        host.install_builtin("aokie").expect("re-install");
        assert_eq!(
            std::fs::read_to_string(&manifest_path).unwrap(),
            template("aokie").unwrap().manifest_json
        );

        assert!(host.install_builtin("nope").is_err());
        let _ = std::fs::remove_dir_all(&data);
    }
}
