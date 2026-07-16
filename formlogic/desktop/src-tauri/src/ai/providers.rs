//! AI-401 — the Desktop AI provider registry.
//!
//! One versioned provider-profile schema (mirrors the web `aiProviders.ts`)
//! persisted to `<data_dir>/ai-providers.json`. API KEYS ARE NEVER IN THIS FILE
//! — they live in the OS credential store under `ai-provider:<id>`; only a
//! `hasKey` boolean is exposed. Application flows bind to logical capability
//! aliases (`receptionist-chat`, `speech-to-text`, …); the device owner maps an
//! alias to a provider profile. Exports carry the alias + requirements, never a
//! machine-specific provider id or a secret (ADR-008).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::egress::LocalAccess;

/// Credential-store name for a provider's key.
fn key_secret_name(id: &str) -> String {
    format!("ai-provider:{id}")
}

/// A capability a provider can serve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Chat,
    Transcription,
    Speech,
    Embeddings,
    Realtime,
}

/// The wire protocol dialect an adapter speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    /// OpenAI Chat Completions + Audio (the default; llama.cpp / LM Studio /
    /// Ollama's /v1 are all this).
    #[default]
    #[serde(rename = "openai")]
    OpenAi,
    /// Anthropic Messages.
    Anthropic,
    /// Fully custom HTTP — request template + response mapping.
    Custom,
}

/// Per-capability request/response customization for a Custom provider.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySpec {
    /// Path appended to baseUrl (e.g. `/v1/chat/completions`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// JSON request-body template with `{{model}} {{messages}} {{prompt}}
    /// {{input}} {{voice}} {{audio}} {{apiKey}}` placeholders (Custom only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_template: Option<String>,
    /// Dot-path into the JSON response for the text/result (Custom chat only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_path: Option<String>,
}

/// A header sent to the provider; the value may contain `{{apiKey}}`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeaderKv {
    pub name: String,
    pub value: String,
}

/// One provider profile. NO secret material — the key lives in the credential
/// store keyed by `id`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub protocol: Protocol,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub headers: Vec<HeaderKv>,
    /// Per-capability specs (Custom providers). Keyed by capability name.
    #[serde(default)]
    pub specs: HashMap<String, CapabilitySpec>,
    /// The user marked this endpoint as local (allows loopback/private/http).
    #[serde(default)]
    pub allow_local: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl ProviderProfile {
    pub fn local_access(&self) -> LocalAccess {
        if self.allow_local {
            LocalAccess::AllowLocal
        } else {
            LocalAccess::PublicOnly
        }
    }

    pub fn supports(&self, cap: Capability) -> bool {
        // Empty capabilities = all (legacy/OpenAI convenience).
        self.capabilities.is_empty() || self.capabilities.contains(&cap)
    }

    /// The default path for a capability given the protocol, or the Custom spec
    /// override.
    pub fn path_for(&self, cap: Capability) -> String {
        let key = capability_key(cap);
        if let Some(spec) = self.specs.get(key) {
            if let Some(p) = &spec.path {
                return p.clone();
            }
        }
        match (self.protocol, cap) {
            (Protocol::OpenAi, Capability::Chat) => "/v1/chat/completions".into(),
            (Protocol::OpenAi, Capability::Transcription) => "/v1/audio/transcriptions".into(),
            (Protocol::OpenAi, Capability::Speech) => "/v1/audio/speech".into(),
            (Protocol::OpenAi, Capability::Embeddings) => "/v1/embeddings".into(),
            (Protocol::OpenAi, Capability::Realtime) => "/v1/realtime".into(),
            (Protocol::Anthropic, Capability::Chat) => "/v1/messages".into(),
            (Protocol::Anthropic, _) => "/v1/messages".into(),
            (Protocol::Custom, _) => "/".into(),
        }
    }
}

pub fn capability_key(cap: Capability) -> &'static str {
    match cap {
        Capability::Chat => "chat",
        Capability::Transcription => "transcription",
        Capability::Speech => "speech",
        Capability::Embeddings => "embeddings",
        Capability::Realtime => "realtime",
    }
}

/// A capability alias → provider mapping. Flows reference the alias; the owner
/// maps it here. `alias` is a logical name (`receptionist-chat`); `providerId`
/// is a machine-local id.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasBinding {
    pub alias: String,
    pub capability: Capability,
    pub provider_id: String,
}

/// The persisted registry document (keys excluded — those are in the keyring).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDoc {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<ProviderProfile>,
    #[serde(default)]
    pub aliases: Vec<AliasBinding>,
}

fn one() -> u32 {
    1
}

/// Public snapshot of one provider — the wire view (no secret; `hasKey`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    pub profile: ProviderProfile,
    pub has_key: bool,
}

pub struct ProviderRegistry {
    path: PathBuf,
    doc: RegistryDoc,
}

impl ProviderRegistry {
    /// Load from `<data_dir>/ai-providers.json` (empty on missing/corrupt).
    pub fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("ai-providers.json");
        let doc = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<RegistryDoc>(&s).ok())
            .unwrap_or_default();
        Self { path, doc }
    }

    fn persist(&self) {
        match serde_json::to_string_pretty(&self.doc) {
            Ok(json) => {
                let tmp = self.path.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok()
                    && std::fs::rename(&tmp, &self.path).is_err()
                {
                    let _ = std::fs::remove_file(&tmp);
                }
            }
            Err(e) => log::warn!("could not serialize ai-providers.json: {e}"),
        }
    }

    /// Public list — profiles + hasKey, never the secret.
    pub fn list(&self) -> Vec<ProviderView> {
        self.doc
            .providers
            .iter()
            .map(|p| ProviderView {
                profile: p.clone(),
                has_key: has_key(&p.id),
            })
            .collect()
    }

    pub fn aliases(&self) -> Vec<AliasBinding> {
        self.doc.aliases.clone()
    }

    pub fn get(&self, id: &str) -> Option<ProviderProfile> {
        self.doc.providers.iter().find(|p| p.id == id).cloned()
    }

    /// Resolve a provider for a capability: an explicit alias first, else the
    /// first enabled provider that supports the capability. `None` = nothing
    /// configured (the caller falls back to the local services registry).
    pub fn resolve(&self, alias_or_none: Option<&str>, cap: Capability) -> Option<ProviderProfile> {
        if let Some(alias) = alias_or_none {
            if let Some(binding) = self
                .doc
                .aliases
                .iter()
                .find(|a| a.alias == alias && a.capability == cap)
            {
                if let Some(p) = self.get(&binding.provider_id) {
                    if p.enabled && p.supports(cap) {
                        return Some(p);
                    }
                }
            }
            // An alias that names a specific provider id directly also works.
            if let Some(p) = self.get(alias) {
                if p.enabled && p.supports(cap) {
                    return Some(p);
                }
            }
        }
        self.doc
            .providers
            .iter()
            .find(|p| p.enabled && p.supports(cap))
            .cloned()
    }

    /// Upsert a provider profile (validates id + baseUrl shape). Returns the id.
    pub fn upsert(&mut self, profile: ProviderProfile) -> Result<String, String> {
        if !valid_id(&profile.id) {
            return Err("provider id must be lowercase letters/digits/dash (1–64 chars)".into());
        }
        if profile.base_url.trim().is_empty() {
            return Err("provider base URL is required".into());
        }
        let id = profile.id.clone();
        match self.doc.providers.iter_mut().find(|p| p.id == id) {
            Some(existing) => *existing = profile,
            None => self.doc.providers.push(profile),
        }
        self.persist();
        Ok(id)
    }

    /// Delete a provider + its key + any aliases bound to it.
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let before = self.doc.providers.len();
        self.doc.providers.retain(|p| p.id != id);
        if self.doc.providers.len() == before {
            return Err(format!("unknown provider {id:?}"));
        }
        self.doc.aliases.retain(|a| a.provider_id != id);
        let _ = crate::secrets::delete(&key_secret_name(id));
        self.persist();
        Ok(())
    }

    /// Set (or clear with `None`) a provider's API key in the credential store.
    pub fn set_key(&self, id: &str, key: Option<&str>) -> Result<(), String> {
        if self.get(id).is_none() {
            return Err(format!("unknown provider {id:?}"));
        }
        match key {
            Some(k) if !k.is_empty() => {
                if !crate::secrets::store_verified(&key_secret_name(id), k)? {
                    return Err(
                        "no OS credential store on this platform — cannot store the API key safely"
                            .into(),
                    );
                }
                Ok(())
            }
            _ => crate::secrets::delete(&key_secret_name(id)),
        }
    }

    /// Read a provider's key (for the gateway's outbound request only — never
    /// returned over HTTP).
    pub fn key(&self, id: &str) -> Option<String> {
        crate::secrets::get(&key_secret_name(id)).ok().flatten()
    }

    /// Set an alias→provider binding.
    pub fn set_alias(&mut self, alias: AliasBinding) -> Result<(), String> {
        if self.get(&alias.provider_id).is_none() {
            return Err(format!("unknown provider {:?}", alias.provider_id));
        }
        self.doc
            .aliases
            .retain(|a| !(a.alias == alias.alias && a.capability == alias.capability));
        self.doc.aliases.push(alias);
        self.persist();
        Ok(())
    }
}

fn has_key(id: &str) -> bool {
    crate::secrets::get(&key_secret_name(id))
        .ok()
        .flatten()
        .is_some()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub type ProviderRegistryHandle = Arc<Mutex<ProviderRegistry>>;

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fl-ai-prov-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn profile(id: &str, caps: Vec<Capability>) -> ProviderProfile {
        ProviderProfile {
            id: id.into(),
            name: id.into(),
            protocol: Protocol::OpenAi,
            base_url: "https://api.openai.com".into(),
            model: Some("gpt-4o-mini".into()),
            capabilities: caps,
            headers: vec![],
            specs: HashMap::new(),
            allow_local: false,
            enabled: true,
        }
    }

    #[test]
    fn upsert_persist_and_reload() {
        let dir = tmp();
        {
            let mut reg = ProviderRegistry::load(&dir);
            reg.upsert(profile("openai", vec![Capability::Chat])).unwrap();
        }
        // Reload from disk — profile survives, no key.
        let reg = ProviderRegistry::load(&dir);
        let list = reg.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].profile.id, "openai");
        assert!(!list[0].has_key, "no key stored");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_by_alias_then_by_capability() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        reg.upsert(profile("openai", vec![Capability::Chat])).unwrap();
        reg.upsert(profile("whisper", vec![Capability::Transcription])).unwrap();
        reg.set_alias(AliasBinding {
            alias: "receptionist-chat".into(),
            capability: Capability::Chat,
            provider_id: "openai".into(),
        })
        .unwrap();

        // Alias resolves to the bound provider.
        assert_eq!(
            reg.resolve(Some("receptionist-chat"), Capability::Chat).unwrap().id,
            "openai"
        );
        // No alias → first enabled provider that supports the capability.
        assert_eq!(
            reg.resolve(None, Capability::Transcription).unwrap().id,
            "whisper"
        );
        // A capability nobody serves → None (caller falls back to local).
        assert!(reg.resolve(None, Capability::Realtime).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_provider_and_its_aliases() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        reg.upsert(profile("openai", vec![Capability::Chat])).unwrap();
        reg.set_alias(AliasBinding {
            alias: "a".into(),
            capability: Capability::Chat,
            provider_id: "openai".into(),
        })
        .unwrap();
        reg.delete("openai").unwrap();
        assert!(reg.list().is_empty());
        assert!(reg.aliases().is_empty(), "aliases to a deleted provider are dropped");
        assert!(reg.delete("openai").is_err(), "double delete refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_paths_follow_protocol() {
        let p = profile("openai", vec![]);
        assert_eq!(p.path_for(Capability::Chat), "/v1/chat/completions");
        assert_eq!(p.path_for(Capability::Speech), "/v1/audio/speech");
        assert!(p.supports(Capability::Chat), "empty caps = all");
    }
}
