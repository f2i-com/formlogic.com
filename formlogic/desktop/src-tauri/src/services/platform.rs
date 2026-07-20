//! Service-platform definition catalog.
//!
//! The v3 contract deliberately sits above the legacy managed-process
//! [`ServiceTemplate`](super::template::ServiceTemplate): a definition can
//! describe a remote provider, delegated agent, plugin connector, or process.
//! The first slice exposes built-in definitions read-only while existing
//! runtime/provider stores remain the projections that actually execute them.

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

const OPENAI_API_DEFINITION: &str =
    include_str!("../../../../../docs/contracts/fixtures/openai-api.service-definition.v3.json");
const OPENAI_CODEX_DEFINITION: &str = include_str!(
    "../../../../../docs/contracts/fixtures/openai-codex-agent.service-definition.v3.json"
);

static DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDefinitionCatalog {
    pub schema_version: u32,
    pub definitions: Vec<Value>,
}

/// Return the signed-in-product-independent built-in catalog.
///
/// Definitions contain no connection credentials and are safe to return to a
/// paired web app. Parsing is cached so list/search UI refreshes do not repeat
/// JSON work.
pub fn builtin_catalog() -> ServiceDefinitionCatalog {
    let definitions = DEFINITIONS.get_or_init(|| {
        [OPENAI_API_DEFINITION, OPENAI_CODEX_DEFINITION]
            .into_iter()
            .map(|raw| {
                serde_json::from_str(raw)
                    .expect("built-in service-definition fixtures must remain valid JSON")
            })
            .collect()
    });
    ServiceDefinitionCatalog {
        schema_version: 3,
        definitions: definitions.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn builtins_have_unique_definition_and_action_ids() {
        let catalog = builtin_catalog();
        assert_eq!(catalog.schema_version, 3);
        assert_eq!(catalog.definitions.len(), 2);

        let mut definition_ids = HashSet::new();
        for definition in &catalog.definitions {
            assert_eq!(definition["schemaVersion"], 3);
            let id = definition["id"].as_str().expect("definition id");
            assert!(definition_ids.insert(id), "duplicate definition id {id}");

            let mut action_ids = HashSet::new();
            for action in definition["actions"].as_array().expect("actions") {
                let action_id = action["id"].as_str().expect("action id");
                assert!(
                    action_ids.insert(action_id),
                    "duplicate action id {id}/{action_id}"
                );
            }
        }
    }

    #[test]
    fn chatgpt_subscription_agent_advertises_only_its_text_call_pilot() {
        let catalog = builtin_catalog();
        let codex = catalog
            .definitions
            .iter()
            .find(|d| d["id"] == "openai-codex-agent")
            .expect("codex definition");
        let capabilities = codex["capabilities"].as_array().expect("capabilities");
        assert!(capabilities.iter().any(|v| v == "llm.chat"));
        assert!(!capabilities.iter().any(|v| v == "voice.calls"));
        assert!(!capabilities.iter().any(|v| v == "voice.realtime"));
        assert!(codex["actions"]
            .as_array()
            .expect("actions")
            .iter()
            .any(|action| action["id"] == "live-call.chat"
                && action["streaming"]["mode"] == "sse"
                && action["streaming"]["cancellable"] == true));
        assert!(codex["name"]
            .as_str()
            .expect("name")
            .contains("Sign in with ChatGPT"));
    }

    #[test]
    fn openai_api_definition_states_separate_billing() {
        let catalog = builtin_catalog();
        let api = catalog
            .definitions
            .iter()
            .find(|d| d["id"] == "openai-api")
            .expect("OpenAI API definition");
        assert!(api["name"]
            .as_str()
            .expect("name")
            .contains("separate API billing"));
    }
}
