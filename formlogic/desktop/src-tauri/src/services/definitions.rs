//! Dynamic Service Definition registry (SRV-401).
//!
//! Built-in definitions and definitions contributed by installed plugins are served through
//! ONE interface: [`catalog`] for listing, [`find`] for resolution. Everything downstream —
//! the paired browser's catalog fetch, `ServiceActionHost::resolve_action`, and therefore
//! every `service_action` flow node — sees the same composed view, so a contributed service
//! is a first-class citizen rather than a special case.
//!
//! The composition rules exist to make provenance unambiguous and takeover impossible:
//!
//!   * **built-ins always win** — a contributed definition may never shadow `openai-api`
//!     (or any built-in). Allowing that would let a plugin silently re-point every flow
//!     already bound to a built-in service;
//!   * **a definition id belongs to one plugin** — a second plugin claiming an id another
//!     already owns is refused, not first-wins-silently;
//!   * **ids are namespaced to their plugin** (`<plugin-id>` or `<plugin-id>.<something>`),
//!     the same rule Application Package v2 applies to contributed node types. Provenance is
//!     then readable from the id alone, and two plugins cannot race for a generic name;
//!   * **removal is complete** — [`remove_plugin`] drops everything a plugin contributed, so
//!     disabling or uninstalling it takes its services with it. Nothing outlives its owner.
//!
//! Registration is idempotent per plugin: re-registering replaces that plugin's own set, so a
//! restart or a re-scan refreshes rather than accumulating.
//!
//! State is process-global (like the built-in catalog it extends) because the consumers are
//! free functions reached from the flow runner and the HTTP layer alike; threading a handle
//! to all of them would buy nothing but churn.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

/// One plugin-contributed definition plus its provenance.
#[derive(Debug, Clone)]
struct Contributed {
    plugin_id: String,
    definition: Value,
}

static CONTRIBUTED: RwLock<Option<HashMap<String, Contributed>>> = RwLock::new(None);

fn with_read<T>(f: impl FnOnce(&HashMap<String, Contributed>) -> T) -> T {
    let guard = CONTRIBUTED.read().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(map) => f(map),
        None => f(&HashMap::new()),
    }
}

fn with_write<T>(f: impl FnOnce(&mut HashMap<String, Contributed>) -> T) -> T {
    let mut guard = CONTRIBUTED.write().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Is `id` a definition the host itself ships? Built-ins can never be replaced.
fn is_builtin(id: &str) -> bool {
    super::platform::builtin_catalog()
        .definitions
        .iter()
        .any(|d| d["id"].as_str() == Some(id))
}

/// A contributed definition is served to the paired website on every catalog fetch, so an
/// oversized one is a cost paid by every consumer. Definitions are metadata, not payloads.
const MAX_DEFINITION_BYTES: usize = 64 * 1024;

/// Validate one contributed definition, returning its id.
///
/// This is a STRUCTURAL gate, not the §6.5 value validator: it establishes that the entry is
/// a v3 definition, owned by the declaring plugin, and internally consistent enough that
/// resolution cannot be ambiguous. Action-level transport/schema checking stays in
/// `invocation::resolve_action`, which every execution path already goes through.
fn validate(definition: &Value, plugin_id: &str) -> Result<String, String> {
    if definition["schemaVersion"].as_u64() != Some(3) {
        return Err("definition must declare schemaVersion 3".into());
    }
    let size = serde_json::to_string(definition).map(|s| s.len()).unwrap_or(usize::MAX);
    if size > MAX_DEFINITION_BYTES {
        return Err(format!(
            "definition is {size} bytes, over the {MAX_DEFINITION_BYTES}-byte limit for a catalog entry"
        ));
    }
    let id = definition["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| "definition id is missing or too long".to_string())?;
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!("definition id {id:?} has characters outside [a-z0-9._-]"));
    }
    // Namespace rule: a plugin may only contribute under its own id.
    if id != plugin_id && !id.starts_with(&format!("{plugin_id}.")) {
        return Err(format!(
            "definition id {id:?} must be {plugin_id:?} or start with \"{plugin_id}.\" (a plugin owns only its own namespace)"
        ));
    }
    let actions = definition["actions"]
        .as_array()
        .ok_or_else(|| format!("definition {id:?} has no actions array"))?;
    if actions.is_empty() {
        return Err(format!("definition {id:?} declares no actions"));
    }
    let mut seen = Vec::new();
    for action in actions {
        let action_id = action["id"]
            .as_str()
            .filter(|a| !a.is_empty())
            .ok_or_else(|| format!("definition {id:?} has an action without an id"))?;
        if seen.contains(&action_id) {
            return Err(format!("definition {id:?} declares action {action_id:?} twice"));
        }
        seen.push(action_id);
    }
    Ok(id.to_string())
}

/// What a reconcile did (SRV-408): the applied diff, or why nothing was applied.
#[derive(Debug, Default, PartialEq)]
pub struct ReconcileReport {
    /// Ids newly offered by this plugin.
    pub added: Vec<String>,
    /// Ids it already provided and has re-declared (content may differ).
    pub updated: Vec<String>,
    /// Ids it previously provided and no longer ships.
    pub removed: Vec<String>,
    /// Non-empty => NOTHING was applied; the plugin's previous set is intact.
    pub refusals: Vec<String>,
}

impl ReconcileReport {
    pub fn applied(&self) -> bool {
        self.refusals.is_empty()
    }
}

/// Reconcile everything `plugin_id` contributes — ATOMICALLY (SRV-408).
///
/// The whole declared set is validated against the live registry BEFORE anything is written.
/// If any definition is refused, none are applied and the plugin's previous set stays exactly
/// as it was.
///
/// Partial success was the earlier behaviour and it is the wrong shape for a reconciler: a
/// plugin that ships three services and gets two leaves a state neither its author nor the
/// user can reason about, and the missing one only surfaces later as a binding that will not
/// resolve or a flow that will not compile. Refusing the set puts the failure where it can be
/// fixed — in the package — and names every reason at once.
///
/// Applying is idempotent: re-reconciling an unchanged set reports it all as `updated` and
/// changes nothing observable.
pub fn reconcile_plugin(plugin_id: &str, definitions: Vec<Value>) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let mut staged: Vec<(String, Value)> = Vec::new();

    with_write(|map| {
        // ---- validate the ENTIRE set first; nothing is written in this pass ----
        for definition in definitions {
            let id = match validate(&definition, plugin_id) {
                Ok(id) => id,
                Err(e) => {
                    report.refusals.push(e);
                    continue;
                }
            };
            if is_builtin(&id) {
                report.refusals.push(format!(
                    "definition {id:?} collides with a built-in service and cannot replace it"
                ));
                continue;
            }
            // Another PLUGIN's id (this plugin's own ids are being replaced, so they are fine).
            if let Some(existing) = map.get(&id) {
                if existing.plugin_id != plugin_id {
                    report.refusals.push(format!(
                        "definition {id:?} is already provided by plugin {:?}",
                        existing.plugin_id
                    ));
                    continue;
                }
            }
            if staged.iter().any(|(staged_id, _)| staged_id == &id) {
                report.refusals.push(format!("definition {id:?} is declared twice by this plugin"));
                continue;
            }
            staged.push((id, definition));
        }

        if !report.refusals.is_empty() {
            return; // atomic: the plugin keeps whatever it had
        }

        // ---- diff against what this plugin currently provides ----
        let previous: Vec<String> = map
            .iter()
            .filter(|(_, c)| c.plugin_id == plugin_id)
            .map(|(id, _)| id.clone())
            .collect();
        for (id, _) in &staged {
            if previous.contains(id) {
                report.updated.push(id.clone());
            } else {
                report.added.push(id.clone());
            }
        }
        for id in &previous {
            if !staged.iter().any(|(staged_id, _)| staged_id == id) {
                report.removed.push(id.clone());
            }
        }
        report.added.sort();
        report.updated.sort();
        report.removed.sort();

        // ---- commit ----
        map.retain(|_, c| c.plugin_id != plugin_id);
        for (id, definition) in staged.drain(..) {
            map.insert(id, Contributed { plugin_id: plugin_id.to_string(), definition });
        }
    });
    report
}

/// Drop everything `plugin_id` contributed (disable, uninstall, or a failed rescan).
/// Returns how many definitions were removed.
pub fn remove_plugin(plugin_id: &str) -> usize {
    with_write(|map| {
        let before = map.len();
        map.retain(|_, c| c.plugin_id != plugin_id);
        before - map.len()
    })
}

/// The composed catalog: built-ins first (stable order), then contributed ids sorted so the
/// listing is deterministic for a caller diffing it.
///
/// Each contributed entry is stamped with `provider` — the plugin that supplies it. Without
/// that, a picker offering "Mock Images" alongside "OpenAI API" gives the user no way to tell
/// a host service from one a plugin installed, which is exactly the sort of thing someone
/// should know before pointing a flow at it. Built-ins carry no `provider` (the host is the
/// provider), and the field is stamped by the HOST, never read from the plugin's file — a
/// definition cannot claim a provenance it does not have.
pub fn catalog() -> super::platform::ServiceDefinitionCatalog {
    let mut catalog = super::platform::builtin_catalog();
    let mut contributed: Vec<(String, Value)> = with_read(|map| {
        map.iter()
            .map(|(id, c)| {
                let mut definition = c.definition.clone();
                if let Some(object) = definition.as_object_mut() {
                    object.insert("provider".into(), Value::String(c.plugin_id.clone()));
                }
                (id.clone(), definition)
            })
            .collect()
    });
    contributed.sort_by(|a, b| a.0.cmp(&b.0));
    catalog
        .definitions
        .extend(contributed.into_iter().map(|(_, definition)| definition));
    catalog
}

/// Resolve one definition by id across built-ins and contributions.
pub fn find(definition_id: &str) -> Option<Value> {
    if let Some(builtin) = super::platform::builtin_catalog()
        .definitions
        .into_iter()
        .find(|d| d["id"].as_str() == Some(definition_id))
    {
        return Some(builtin);
    }
    with_read(|map| map.get(definition_id).map(|c| c.definition.clone()))
}

/// Which plugin provides `definition_id`, if any (None for built-ins and unknown ids).
pub fn provider_of(definition_id: &str) -> Option<String> {
    with_read(|map| map.get(definition_id).map(|c| c.plugin_id.clone()))
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    with_write(|map| map.clear());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    // The registry is process-global, so these tests serialize against each other.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn definition(id: &str, actions: &[&str]) -> Value {
        json!({
            "schemaVersion": 3,
            "id": id,
            "name": format!("Service {id}"),
            "version": "1.0.0",
            "actions": actions.iter().map(|a| json!({
                "id": a,
                "transport": { "kind": "openai-compatible", "method": "POST", "path": "/v1/images/generations" }
            })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn contributed_definitions_join_the_builtin_catalog_and_resolve() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        let report = reconcile_plugin("acme", vec![definition("acme.images", &["generate-image"])]);
        assert!(report.applied(), "{report:?}");
        assert_eq!(report.added, vec!["acme.images".to_string()]);

        let catalog = catalog();
        assert!(catalog.definitions.iter().any(|d| d["id"] == "openai-api"), "built-ins survive");
        let contributed = catalog
            .definitions
            .iter()
            .find(|d| d["id"] == "acme.images")
            .expect("contributed entry is listed");
        // Provenance is stamped by the HOST so a picker can say where a service came from.
        assert_eq!(contributed["provider"], "acme");
        let builtin = catalog.definitions.iter().find(|d| d["id"] == "openai-api").unwrap();
        assert!(builtin.get("provider").is_none(), "built-ins have no plugin provider");
        assert_eq!(find("acme.images").expect("resolves")["id"], "acme.images");
        assert_eq!(provider_of("acme.images").as_deref(), Some("acme"));
        assert_eq!(provider_of("openai-api"), None, "built-ins have no plugin owner");

        reset_for_tests();
    }

    #[test]
    fn a_plugin_cannot_shadow_a_builtin_or_take_over_another_plugins_id() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        // Shadowing a built-in would silently re-point every flow bound to it.
        let report = reconcile_plugin("openai-api", vec![definition("openai-api", &["chat.complete"])]);
        assert_eq!(report.refusals.len(), 1);
        assert!(report.refusals[0].contains("built-in"), "{report:?}");
        assert_eq!(provider_of("openai-api"), None);

        reconcile_plugin("acme", vec![definition("acme.images", &["generate-image"])]);
        // A second plugin claiming acme's id is refused twice over (namespace + ownership).
        let report = reconcile_plugin("evil", vec![definition("acme.images", &["generate-image"])]);
        assert_eq!(report.refusals.len(), 1);
        assert!(report.refusals[0].contains("own namespace"), "{report:?}");
        assert_eq!(provider_of("acme.images").as_deref(), Some("acme"), "ownership is unchanged");

        reset_for_tests();
    }

    #[test]
    fn a_definition_cannot_claim_a_provenance_it_does_not_have() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        // The file says it comes from a trusted-sounding plugin; the host stamps the truth.
        let mut liar = definition("acme.images", &["generate-image"]);
        liar["provider"] = json!("formlogic-official");
        assert!(reconcile_plugin("acme", vec![liar]).applied());

        let listed = catalog()
            .definitions
            .into_iter()
            .find(|d| d["id"] == "acme.images")
            .expect("listed");
        assert_eq!(listed["provider"], "acme", "the host's stamp wins over the file's claim");

        reset_for_tests();
    }

    #[test]
    fn an_oversized_definition_is_refused() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        // Every catalog fetch would carry this; definitions are metadata, not payloads.
        let mut bloated = definition("acme.bloat", &["generate-image"]);
        bloated["description"] = json!("x".repeat(MAX_DEFINITION_BYTES));
        let report = reconcile_plugin("acme", vec![bloated, definition("acme.ok", &["generate-image"])]);
        assert!(!report.applied());
        assert_eq!(report.refusals.len(), 1);
        assert!(report.refusals[0].contains("over the"), "{report:?}");
        // SRV-408: atomic — the oversized entry takes its whole set with it.
        assert!(find("acme.bloat").is_none());
        assert!(find("acme.ok").is_none());

        reset_for_tests();
    }

    #[test]
    fn one_bad_definition_refuses_the_whole_set_and_keeps_the_previous_one() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        // A working prior state to protect.
        assert!(reconcile_plugin("acme", vec![definition("acme.images", &["generate-image"])]).applied());

        let mut wrong_version = definition("acme.old", &["a"]);
        wrong_version["schemaVersion"] = json!(2);
        let duplicate_actions = definition("acme.dupe", &["a", "a"]);
        let no_actions = json!({ "schemaVersion": 3, "id": "acme.empty", "actions": [] });

        // SRV-408: the plugin now ships a set that is partly broken. Applying the good half
        // would leave a state neither the author nor the user can reason about, and the
        // missing service would only surface later as a binding that will not resolve.
        let report = reconcile_plugin(
            "acme",
            vec![wrong_version, duplicate_actions, no_actions, definition("acme.good", &["generate-image"])],
        );
        assert!(!report.applied());
        assert_eq!(report.refusals.len(), 3, "every reason is named at once: {report:?}");
        assert!(find("acme.good").is_none(), "no part of a refused set is applied");
        assert!(
            find("acme.images").is_some(),
            "the plugin keeps exactly what it had before the bad reconcile"
        );

        reset_for_tests();
    }

    #[test]
    fn the_same_id_declared_twice_by_one_plugin_is_refused() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        // Otherwise which of the two wins would be an accident of iteration order.
        let report = reconcile_plugin(
            "acme",
            vec![definition("acme.images", &["generate-image"]), definition("acme.images", &["upscale"])],
        );
        assert!(!report.applied());
        assert!(report.refusals[0].contains("declared twice"), "{report:?}");
        assert!(find("acme.images").is_none());

        reset_for_tests();
    }

    #[test]
    fn reconcile_reports_the_diff_and_removal_is_complete() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();

        let first = reconcile_plugin(
            "acme",
            vec![definition("acme.images", &["generate-image"]), definition("acme.audio", &["speak"])],
        );
        assert_eq!(first.added, vec!["acme.audio".to_string(), "acme.images".to_string()]);
        assert!(first.removed.is_empty());

        // A set that no longer ships acme.audio: dropped, and REPORTED as dropped.
        let second = reconcile_plugin("acme", vec![definition("acme.images", &["generate-image", "upscale"])]);
        assert!(second.applied());
        assert_eq!(second.updated, vec!["acme.images".to_string()]);
        assert_eq!(second.removed, vec!["acme.audio".to_string()]);
        assert!(find("acme.audio").is_none(), "definitions the plugin stopped shipping disappear");
        assert_eq!(find("acme.images").expect("still there")["actions"].as_array().unwrap().len(), 2);

        // Re-applying the SAME set changes nothing observable (idempotent).
        let third = reconcile_plugin("acme", vec![definition("acme.images", &["generate-image", "upscale"])]);
        assert!(third.applied());
        assert!(third.added.is_empty() && third.removed.is_empty());
        assert_eq!(third.updated, vec!["acme.images".to_string()]);

        // Disable/uninstall takes everything with it; built-ins and other plugins are untouched.
        reconcile_plugin("other", vec![definition("other.thing", &["do"])]);
        assert_eq!(remove_plugin("acme"), 1);
        assert!(find("acme.images").is_none());
        assert!(find("other.thing").is_some(), "another plugin's services survive");
        assert!(catalog().definitions.iter().any(|d| d["id"] == "openai-api"));

        reset_for_tests();
    }
}
