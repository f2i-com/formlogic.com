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
use std::collections::{HashMap, HashSet};
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
    /// {{input}} {{voice}} {{audio}}` placeholders (Custom only). Credentials
    /// are deliberately unavailable to body mappings and are injected by the
    /// Desktop host as HTTP headers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_template: Option<String>,
    /// Dot-path into the JSON response for the text/result (Custom chat only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_path: Option<String>,
}

/// A header sent to the provider; the value may contain `{{apiKey}}`, expanded
/// host-side immediately before the outbound request.
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
    /// Optional user-defined grouping label for the unified service browser.
    /// Absent on every profile created before service metadata was introduced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Optional search/filter labels. Order is preserved; duplicates are
    /// removed case-insensitively when a profile is saved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
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
        let mut doc = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<RegistryDoc>(&s).ok())
            .unwrap_or_default();
        // Treat persisted data as untrusted: old/hand-edited files bypass the
        // upsert validator. Invalid ids (including percent-encoded shadows of
        // the host-owned Codex adapters) must never reach the public list or
        // URL composer. Drop aliases whose provider was filtered as well.
        doc.providers
            .retain(|profile| valid_id(&profile.id) && !shadows_live_call_provider_id(&profile.id));
        let provider_ids = doc
            .providers
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<HashSet<_>>();
        doc.aliases
            .retain(|alias| provider_ids.contains(alias.provider_id.as_str()));
        Self { path, doc }
    }

    fn persist(&self) {
        match serde_json::to_string_pretty(&self.doc) {
            Ok(json) => {
                let tmp = self.path.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &self.path).is_err()
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
    pub fn upsert(&mut self, mut profile: ProviderProfile) -> Result<String, String> {
        if shadows_live_call_provider_id(&profile.id) {
            return Err(
                "this provider id is reserved for FormLogic's connected ChatGPT/Codex call adapter"
                    .into(),
            );
        }
        if !valid_id(&profile.id) {
            return Err("provider id must be lowercase letters/digits/dash (1–64 chars)".into());
        }
        if profile.base_url.trim().is_empty() {
            return Err("provider base URL is required".into());
        }
        normalize_provider_metadata(&mut profile)?;
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
                if k.len() > MAX_PROVIDER_KEY_BYTES || k.chars().any(char::is_control) {
                    return Err(format!(
                        "provider API keys must be single-line values no larger than {MAX_PROVIDER_KEY_BYTES} bytes"
                    ));
                }
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
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Axum decodes a route parameter once before the HTTP handler selects a
/// provider. Keep a persisted/custom id from becoming one of the host-owned
/// virtual providers after that same single decoding pass. This is deliberately
/// not form decoding: `+` remains a literal plus in URI path segments.
fn shadows_live_call_provider_id(id: &str) -> bool {
    if super::codex::is_live_call_provider_id(id) {
        return true;
    }

    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let raw = id.as_bytes();
    let mut decoded = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] != b'%' {
            decoded.push(raw[index]);
            index += 1;
            continue;
        }
        let Some((&high, &low)) = raw.get(index + 1).zip(raw.get(index + 2)) else {
            return false;
        };
        let Some((high, low)) = hex(high).zip(hex(low)) else {
            return false;
        };
        decoded.push(high << 4 | low);
        index += 3;
    }
    std::str::from_utf8(&decoded)
        .ok()
        .is_some_and(super::codex::is_live_call_provider_id)
}

const MAX_CATEGORY_CHARS: usize = 64;
const MAX_TAGS: usize = 24;
const MAX_TAG_CHARS: usize = 48;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_NAME_CHARS: usize = 128;
const MAX_HEADER_VALUE_CHARS: usize = 4096;
const MAX_MAPPING_TEMPLATE_BYTES: usize = 256 * 1024;
const MAX_MAPPING_PLACEHOLDERS: usize = 64;
pub(crate) const MAX_PROVIDER_KEY_BYTES: usize = 16 * 1024;

/// Keep service-browser metadata useful and bounded without imposing an ASCII
/// vocabulary: customer categories and tags may be localized. Legacy profiles
/// omit both fields and therefore pass through unchanged.
fn normalize_provider_metadata(profile: &mut ProviderProfile) -> Result<(), String> {
    profile.category = match profile.category.take() {
        Some(category) => {
            if category.chars().any(char::is_control) {
                return Err("provider category must be a single-line label".into());
            }
            let category = category.trim();
            if category.is_empty() {
                None
            } else {
                if category.chars().count() > MAX_CATEGORY_CHARS {
                    return Err(format!(
                        "provider category must be at most {MAX_CATEGORY_CHARS} characters"
                    ));
                }
                Some(category.to_string())
            }
        }
        None => None,
    };

    if profile.tags.len() > MAX_TAGS {
        return Err(format!("provider tags are limited to {MAX_TAGS}"));
    }
    let mut seen = HashSet::new();
    let mut tags = Vec::with_capacity(profile.tags.len());
    for tag in std::mem::take(&mut profile.tags) {
        if tag.chars().any(char::is_control) {
            return Err("provider tags must be single-line labels".into());
        }
        let tag = tag.trim();
        if tag.is_empty() {
            return Err("provider tags cannot be empty".into());
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(format!(
                "provider tags must be at most {MAX_TAG_CHARS} characters each"
            ));
        }
        if seen.insert(tag.to_lowercase()) {
            tags.push(tag.to_string());
        }
    }
    profile.tags = tags;

    if profile.headers.len() > MAX_HEADERS {
        return Err(format!("provider headers are limited to {MAX_HEADERS}"));
    }
    let mut header_names = HashSet::new();
    for header in &mut profile.headers {
        header.name = header.name.trim().to_string();
        header.value = header.value.trim().to_string();
        if header.name.is_empty() || !header.name.bytes().all(is_http_token_byte) {
            return Err("provider header names must be valid HTTP token names".into());
        }
        if header.name.chars().count() > MAX_HEADER_NAME_CHARS {
            return Err(format!(
                "provider header names must be at most {MAX_HEADER_NAME_CHARS} characters"
            ));
        }
        if header.value.chars().any(char::is_control) {
            return Err("provider header values must be single-line text".into());
        }
        if header.value.chars().count() > MAX_HEADER_VALUE_CHARS {
            return Err(format!(
                "provider header values must be at most {MAX_HEADER_VALUE_CHARS} characters"
            ));
        }
        if header.value.matches("{{apiKey}}").count() > 1 {
            return Err("each provider header may reference {{apiKey}} at most once".into());
        }
        if !header_names.insert(header.name.to_ascii_lowercase()) {
            return Err(format!("duplicate provider header {:?}", header.name));
        }
        if is_credential_header(&header.name) && !header.value.contains("{{apiKey}}") {
            return Err(format!(
                "credential header {:?} must use {{{{apiKey}}}} so the secret stays in the OS credential store",
                header.name
            ));
        }
    }

    for spec in profile.specs.values() {
        if let Some(path) = spec.path.as_deref() {
            if path.len() > 2048 || !path.starts_with('/') || path.starts_with("//") {
                return Err(
                    "custom endpoint paths must be relative paths beginning with one /".into(),
                );
            }
        }
        if let Some(template) = spec.request_template.as_deref() {
            if template.len() > MAX_MAPPING_TEMPLATE_BYTES {
                return Err("custom request templates are limited to 256 KiB".into());
            }
            if template.contains("{{apiKey}}") {
                return Err(
                    "custom request templates cannot reference {{apiKey}}; credentials are injected into HTTP headers by the Desktop host"
                        .into(),
                );
            }
            let placeholders = ["{{model}}", "{{messages}}", "{{prompt}}", "{{input}}"]
                .into_iter()
                .map(|placeholder| template.matches(placeholder).count())
                .sum::<usize>();
            if placeholders > MAX_MAPPING_PLACEHOLDERS {
                return Err(format!(
                    "custom request templates are limited to {MAX_MAPPING_PLACEHOLDERS} data placeholders"
                ));
            }
        }
        if spec
            .response_path
            .as_deref()
            .is_some_and(|path| path.len() > 2048)
        {
            return Err("custom response paths are limited to 2048 bytes".into());
        }
    }
    Ok(())
}

fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn is_credential_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "x-api-key"
            | "api-key"
            | "x-auth-token"
            | "x-access-token"
    )
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
            category: None,
            tags: vec![],
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
            reg.upsert(profile("openai", vec![Capability::Chat]))
                .unwrap();
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
    fn legacy_profiles_default_metadata_and_tagged_profiles_round_trip() {
        let legacy: ProviderProfile = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy",
            "baseUrl": "https://example.com"
        }))
        .unwrap();
        assert_eq!(legacy.category, None);
        assert!(legacy.tags.is_empty());

        let dir = tmp();
        let mut tagged = profile("tagged", vec![Capability::Chat]);
        tagged.category = Some("  Generative AI  ".into());
        tagged.tags = vec!["Chat".into(), "trusted".into(), "chat".into()];
        ProviderRegistry::load(&dir).upsert(tagged).unwrap();

        let reloaded = ProviderRegistry::load(&dir);
        let view = reloaded.list().pop().unwrap();
        assert_eq!(view.profile.category.as_deref(), Some("Generative AI"));
        assert_eq!(view.profile.tags, ["Chat", "trusted"]);
        let wire = serde_json::to_value(&view).unwrap();
        assert_eq!(wire["category"], "Generative AI");
        assert_eq!(wire["tags"], serde_json::json!(["Chat", "trusted"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn virtual_codex_call_provider_ids_cannot_be_persisted() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        for id in [
            super::super::codex::LIVE_CALL_PROVIDER_NONE_ID,
            super::super::codex::LIVE_CALL_PROVIDER_LOW_ID,
        ] {
            let error = reg
                .upsert(profile(id, vec![Capability::Chat]))
                .expect_err("virtual Codex provider id must stay host-owned");
            assert!(error.contains("reserved"), "{error}");
            assert!(reg.get(id).is_none());
        }

        let reserved = super::super::codex::LIVE_CALL_PROVIDER_NONE_ID;
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("ai-providers.json"),
            serde_json::to_vec(&RegistryDoc {
                version: 1,
                providers: vec![profile(reserved, vec![Capability::Chat])],
                aliases: vec![AliasBinding {
                    alias: "receptionist-chat".into(),
                    capability: Capability::Chat,
                    provider_id: reserved.into(),
                }],
            })
            .unwrap(),
        )
        .unwrap();
        let reloaded = ProviderRegistry::load(&dir);
        assert!(reloaded.list().is_empty());
        assert!(reloaded.aliases().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_invalid_or_encoded_codex_shadow_ids_are_filtered() {
        let dir = tmp();
        let encoded_none = "openai%2Dcodex-agent-none";
        let encoded_low = "%6fpenai-codex-agent-low";
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("ai-providers.json"),
            serde_json::to_vec(&RegistryDoc {
                version: 1,
                providers: vec![
                    profile("openai", vec![Capability::Chat]),
                    profile(encoded_none, vec![Capability::Chat]),
                    profile(encoded_low, vec![Capability::Chat]),
                    profile("OpenAI", vec![Capability::Chat]),
                    profile("malformed%GG", vec![Capability::Chat]),
                ],
                aliases: vec![
                    AliasBinding {
                        alias: "valid".into(),
                        capability: Capability::Chat,
                        provider_id: "openai".into(),
                    },
                    AliasBinding {
                        alias: "shadow-none".into(),
                        capability: Capability::Chat,
                        provider_id: encoded_none.into(),
                    },
                    AliasBinding {
                        alias: "shadow-low".into(),
                        capability: Capability::Chat,
                        provider_id: encoded_low.into(),
                    },
                    AliasBinding {
                        alias: "invalid".into(),
                        capability: Capability::Chat,
                        provider_id: "OpenAI".into(),
                    },
                ],
            })
            .unwrap(),
        )
        .unwrap();

        let mut reloaded = ProviderRegistry::load(&dir);
        assert_eq!(
            reloaded
                .list()
                .into_iter()
                .map(|view| view.profile.id)
                .collect::<Vec<_>>(),
            ["openai"]
        );
        assert_eq!(
            reloaded
                .aliases()
                .into_iter()
                .map(|alias| alias.alias)
                .collect::<Vec<_>>(),
            ["valid"]
        );
        for id in [encoded_none, encoded_low] {
            let error = reloaded
                .upsert(profile(id, vec![Capability::Chat]))
                .expect_err("a once-decoded Codex shadow must be reserved");
            assert!(error.contains("reserved"), "{id}: {error}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn provider_metadata_rejects_unbounded_or_multiline_labels() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);

        let mut multiline = profile("multiline", vec![]);
        multiline.category = Some("AI\nUnsafe".into());
        assert!(reg.upsert(multiline).unwrap_err().contains("single-line"));

        let mut too_many = profile("too-many", vec![]);
        too_many.tags = (0..=MAX_TAGS).map(|i| format!("tag-{i}")).collect();
        assert!(reg.upsert(too_many).unwrap_err().contains("limited"));

        let mut too_long = profile("too-long", vec![]);
        too_long.tags = vec!["x".repeat(MAX_TAG_CHARS + 1)];
        assert!(reg.upsert(too_long).unwrap_err().contains("at most"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_mapping_keeps_credentials_header_only() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);

        let mut safe = profile("safe-custom", vec![Capability::Chat]);
        safe.protocol = Protocol::Custom;
        safe.headers.push(HeaderKv {
            name: "X-API-Key".into(),
            value: "{{apiKey}}".into(),
        });
        safe.specs.insert(
            "chat".into(),
            CapabilitySpec {
                path: Some("/generate".into()),
                request_template: Some(r#"{"prompt":"{{prompt}}"}"#.into()),
                response_path: Some("result.text".into()),
            },
        );
        reg.upsert(safe).unwrap();

        let mut body_secret = profile("body-secret", vec![Capability::Chat]);
        body_secret.specs.insert(
            "chat".into(),
            CapabilitySpec {
                request_template: Some(r#"{"key":"{{apiKey}}"}"#.into()),
                ..CapabilitySpec::default()
            },
        );
        assert!(reg
            .upsert(body_secret)
            .unwrap_err()
            .contains("cannot reference {{apiKey}}"));

        let mut plaintext_header = profile("plain-secret", vec![Capability::Chat]);
        plaintext_header.headers.push(HeaderKv {
            name: "Authorization".into(),
            value: "Bearer pasted-secret".into(),
        });
        assert!(reg
            .upsert(plaintext_header)
            .unwrap_err()
            .contains("OS credential store"));

        let mut repeated_header = profile("repeat-secret", vec![Capability::Chat]);
        repeated_header.headers.push(HeaderKv {
            name: "X-Goog-Api-Key".into(),
            value: "{{apiKey}}{{apiKey}}".into(),
        });
        assert!(reg
            .upsert(repeated_header)
            .unwrap_err()
            .contains("at most once"));

        let mut amplified_body = profile("amplified-body", vec![Capability::Chat]);
        amplified_body.specs.insert(
            "chat".into(),
            CapabilitySpec {
                request_template: Some(format!(
                    r#"{{"q":"{}"}}"#,
                    "{{prompt}}".repeat(MAX_MAPPING_PLACEHOLDERS + 1)
                )),
                ..CapabilitySpec::default()
            },
        );
        assert!(reg
            .upsert(amplified_body)
            .unwrap_err()
            .contains("data placeholders"));

        reg.upsert(profile("key-limit", vec![Capability::Chat]))
            .unwrap();
        assert!(reg
            .set_key("key-limit", Some(&"x".repeat(MAX_PROVIDER_KEY_BYTES + 1)))
            .unwrap_err()
            .contains("single-line"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_by_alias_then_by_capability() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        reg.upsert(profile("openai", vec![Capability::Chat]))
            .unwrap();
        reg.upsert(profile("whisper", vec![Capability::Transcription]))
            .unwrap();
        reg.set_alias(AliasBinding {
            alias: "receptionist-chat".into(),
            capability: Capability::Chat,
            provider_id: "openai".into(),
        })
        .unwrap();

        // Alias resolves to the bound provider.
        assert_eq!(
            reg.resolve(Some("receptionist-chat"), Capability::Chat)
                .unwrap()
                .id,
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
        reg.upsert(profile("openai", vec![Capability::Chat]))
            .unwrap();
        reg.set_alias(AliasBinding {
            alias: "a".into(),
            capability: Capability::Chat,
            provider_id: "openai".into(),
        })
        .unwrap();
        reg.delete("openai").unwrap();
        assert!(reg.list().is_empty());
        assert!(
            reg.aliases().is_empty(),
            "aliases to a deleted provider are dropped"
        );
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
