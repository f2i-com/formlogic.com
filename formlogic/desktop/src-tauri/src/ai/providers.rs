//! AI-401 — the Desktop AI provider registry.
//!
//! One versioned provider-profile schema (mirrors the web `aiProviders.ts`)
//! persisted to `<data_dir>/ai-providers.json`. API KEYS ARE NEVER IN THIS FILE
//! — legacy keys live under `ai-provider:<id>` and reusable named keys under
//! `api-secret:<id>` in the OS credential store; only presence is exposed.
//! Application flows bind to logical capability
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

/// Credential-store name for a reusable, user-named API secret.
///
/// This namespace is deliberately separate from the legacy one-key-per-provider
/// entries above. Existing providers keep working without a migration, while
/// new profiles can share one credential by storing only its non-secret id.
fn api_secret_name(id: &str) -> String {
    format!("api-secret:{id}")
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
    /// Server-to-server WebSocket path for Realtime audio. This is distinct
    /// from `path`, which remains the browser WebRTC SDP endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket_path: Option<String>,
}

/// A header sent to the provider; the value may contain `{{apiKey}}`, expanded
/// host-side immediately before the outbound request.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeaderKv {
    pub name: String,
    pub value: String,
}

/// One provider profile. NO secret material — only an optional reusable-secret
/// reference or the legacy provider id used to resolve OS credentials.
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
    /// Optional reusable API-secret id. The value itself remains in the OS
    /// credential store under `api-secret:<id>` and is never serialized here.
    /// An absent reference retains the legacy `ai-provider:<provider-id>` key
    /// behavior for profiles created before reusable secrets existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
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
            // Official unified WebRTC session creation. Desktop combines the
            // caller's SDP with the validated session configuration here; it
            // never hands the reusable Platform API key to the browser.
            (Protocol::OpenAi, Capability::Realtime) => "/v1/realtime/calls".into(),
            (Protocol::Anthropic, Capability::Chat) => "/v1/messages".into(),
            (Protocol::Anthropic, _) => "/v1/messages".into(),
            (Protocol::Custom, _) => "/".into(),
        }
    }

    /// The server-to-server WebSocket endpoint for a Realtime provider.
    /// Provider base URLs stay HTTP(S) in the persisted schema; the egress
    /// layer converts the validated target to WS(S) after DNS pinning.
    pub fn realtime_websocket_path(&self) -> String {
        self.specs
            .get(capability_key(Capability::Realtime))
            .and_then(|spec| spec.websocket_path.as_ref())
            .cloned()
            .unwrap_or_else(|| "/v1/realtime".into())
    }

    /// Secret-free provider origin disclosed to Aokie's consent UI. It is the
    /// canonical HTTP(S) service origin behind the derived WS(S) connection,
    /// never the loopback bridge URL, and deliberately excludes credentials,
    /// path, query, and fragment.
    pub fn realtime_destination_origin(&self) -> Option<String> {
        let url = url::Url::parse(&self.base_url).ok()?;
        if !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        match url.scheme() {
            "https" | "http" => {}
            _ => return None,
        }
        let origin = url.origin().ascii_serialization();
        (origin != "null").then_some(origin)
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

/// The non-secret kind of a reusable credential. Keep this enum narrow until
/// a concrete second authentication mechanism is implemented; accepting
/// arbitrary labels would make it too easy for the UI to imply unsupported
/// OAuth/client-certificate behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ApiSecretKind {
    #[default]
    ApiKey,
}

/// Persisted metadata for one reusable API secret. No value is ever written to
/// this document; `id` is only a stable reference into the OS credential store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSecretMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: ApiSecretKind,
}

/// Public/admin view of secret metadata. Presence and references are safe to
/// show in the Desktop window; the secret value is intentionally impossible to
/// represent in this type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSecretView {
    #[serde(flatten)]
    pub meta: ApiSecretMeta,
    pub has_value: bool,
    pub used_by: Vec<String>,
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
    #[serde(default)]
    pub secrets: Vec<ApiSecretMeta>,
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
            .retain(|profile| valid_id(&profile.id) && !shadows_virtual_provider_id(&profile.id));
        // Secret metadata is filesystem data and therefore untrusted. Keep the
        // first valid id and discard malformed/duplicate rows. Providers whose
        // reference no longer resolves are disabled while the reference is
        // cleared: falling back silently to an unrelated legacy key would send
        // customer data with the wrong account. A dangling or path-shaped id
        // must never become a credential-store lookup key.
        let mut secret_ids = HashSet::new();
        doc.secrets.retain_mut(|secret| {
            if normalize_api_secret_meta(secret).is_err() || !secret_ids.insert(secret.id.clone()) {
                return false;
            }
            true
        });
        for profile in &mut doc.providers {
            let Some(raw_secret_ref) = profile.secret_ref.take() else {
                continue;
            };
            let secret_ref = raw_secret_ref.trim().to_string();
            if valid_id(&secret_ref) && secret_ids.contains(&secret_ref) {
                profile.secret_ref = Some(secret_ref);
            } else {
                profile.enabled = false;
            }
        }
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
                has_key: self.provider_has_key(p),
            })
            .collect()
    }

    /// Reusable secret metadata + presence/reference state. The secret value
    /// never enters the returned type.
    pub fn list_secrets(&self) -> Vec<ApiSecretView> {
        self.doc
            .secrets
            .iter()
            .map(|secret| {
                let mut used_by = self
                    .doc
                    .providers
                    .iter()
                    .filter(|provider| provider.secret_ref.as_deref() == Some(secret.id.as_str()))
                    .map(|provider| provider.id.clone())
                    .collect::<Vec<_>>();
                used_by.sort();
                ApiSecretView {
                    meta: secret.clone(),
                    has_value: reusable_secret_has_value(&secret.id),
                    used_by,
                }
            })
            .collect()
    }

    pub fn get_secret_meta(&self, id: &str) -> Option<ApiSecretMeta> {
        self.doc
            .secrets
            .iter()
            .find(|secret| secret.id == id)
            .cloned()
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
        if let Some(alias) = alias_or_none.filter(|alias| !alias.trim().is_empty()) {
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
            // A caller that selected a concrete provider/alias must never
            // spill into the default provider. Besides hiding configuration
            // errors, fallback here could spend a different reusable secret
            // and send customer data to the wrong vendor/account.
            return None;
        }
        self.doc
            .providers
            .iter()
            .find(|p| p.enabled && p.supports(cap))
            .cloned()
    }

    /// Upsert a provider profile (validates id + baseUrl shape). Returns the id.
    pub fn upsert(&mut self, mut profile: ProviderProfile) -> Result<String, String> {
        if shadows_virtual_provider_id(&profile.id) {
            return Err(
                "this provider id is reserved for FormLogic's connected ChatGPT/Codex delegated adapter"
                    .into(),
            );
        }
        if !valid_id(&profile.id) {
            return Err("provider id must be lowercase letters/digits/dash (1–64 chars)".into());
        }
        if profile.base_url.trim().is_empty() {
            return Err("provider base URL is required".into());
        }
        profile.secret_ref = match profile.secret_ref.take() {
            Some(secret_ref) => {
                let secret_ref = secret_ref.trim();
                if secret_ref.is_empty() {
                    None
                } else {
                    if !valid_id(secret_ref) {
                        return Err(
                            "provider secretRef must be lowercase letters/digits/dash (1–64 chars)"
                                .into(),
                        );
                    }
                    if self.get_secret_meta(secret_ref).is_none() {
                        return Err(format!("unknown reusable API secret {secret_ref:?}"));
                    }
                    Some(secret_ref.to_string())
                }
            }
            None => None,
        };
        normalize_provider_metadata(&mut profile)?;
        let id = profile.id.clone();
        match self.doc.providers.iter_mut().find(|p| p.id == id) {
            Some(existing) => *existing = profile,
            None => self.doc.providers.push(profile),
        }
        self.persist();
        Ok(id)
    }

    /// Delete a provider + its legacy private key + any aliases bound to it.
    /// A referenced reusable secret is retained because other providers may
    /// share it (and because connection deletion must never imply credential
    /// deletion).
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

    /// Create or rename reusable API-secret metadata. The value is managed by
    /// [`set_secret_value`] and never crosses this persistence boundary.
    pub fn upsert_secret(&mut self, mut secret: ApiSecretMeta) -> Result<String, String> {
        normalize_api_secret_meta(&mut secret)?;
        let id = secret.id.clone();
        match self
            .doc
            .secrets
            .iter_mut()
            .find(|existing| existing.id == id)
        {
            Some(existing) => *existing = secret,
            None => self.doc.secrets.push(secret),
        }
        self.persist();
        Ok(id)
    }

    /// Delete an unreferenced reusable secret and its credential-store value.
    /// Refuse while any provider uses it so shared credentials cannot vanish as
    /// a side effect of editing another connection.
    pub fn delete_secret(&mut self, id: &str) -> Result<(), String> {
        if self.get_secret_meta(id).is_none() {
            return Err(format!("unknown reusable API secret {id:?}"));
        }
        let mut used_by = self
            .doc
            .providers
            .iter()
            .filter(|provider| provider.secret_ref.as_deref() == Some(id))
            .map(|provider| provider.id.clone())
            .collect::<Vec<_>>();
        if !used_by.is_empty() {
            used_by.sort();
            return Err(format!(
                "reusable API secret {id:?} is used by provider(s): {}",
                used_by.join(", ")
            ));
        }
        crate::secrets::delete(&api_secret_name(id))?;
        self.doc.secrets.retain(|secret| secret.id != id);
        self.persist();
        Ok(())
    }

    /// Store, rotate, or clear one reusable API-secret value. The registry must
    /// already contain its non-secret metadata, which prevents arbitrary HTTP
    /// path values from becoming keyring entry names.
    pub fn set_secret_value(&self, id: &str, value: Option<&str>) -> Result<(), String> {
        if self.get_secret_meta(id).is_none() {
            return Err(format!("unknown reusable API secret {id:?}"));
        }
        match value {
            Some(value) if !value.is_empty() => {
                validate_secret_value(value)?;
                if !crate::secrets::store_verified(&api_secret_name(id), value)? {
                    return Err(
                        "no OS credential store on this platform — cannot store the API secret safely"
                            .into(),
                    );
                }
                Ok(())
            }
            _ => crate::secrets::delete(&api_secret_name(id)),
        }
    }

    /// Set (or clear with `None`) a provider's API key in the credential store.
    pub fn set_key(&self, id: &str, key: Option<&str>) -> Result<(), String> {
        let Some(provider) = self.get(id) else {
            return Err(format!("unknown provider {id:?}"));
        };
        if let Some(secret_ref) = provider.secret_ref.as_deref() {
            return Err(format!(
                "provider {id:?} uses reusable API secret {secret_ref:?}; rotate or clear it through the API Secrets endpoint"
            ));
        }
        match key {
            Some(k) if !k.is_empty() => {
                validate_secret_value(k)?;
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
        let provider = self.get(id)?;
        match provider.secret_ref.as_deref() {
            Some(secret_ref) if self.get_secret_meta(secret_ref).is_some() => {
                crate::secrets::get(&api_secret_name(secret_ref))
                    .ok()
                    .flatten()
            }
            Some(_) => None,
            None => crate::secrets::get(&key_secret_name(id)).ok().flatten(),
        }
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

    fn provider_has_key(&self, provider: &ProviderProfile) -> bool {
        match provider.secret_ref.as_deref() {
            Some(secret_ref) if self.get_secret_meta(secret_ref).is_some() => {
                reusable_secret_has_value(secret_ref)
            }
            Some(_) => false,
            None => legacy_provider_has_key(&provider.id),
        }
    }
}

fn legacy_provider_has_key(id: &str) -> bool {
    crate::secrets::get(&key_secret_name(id))
        .ok()
        .flatten()
        .is_some()
}

fn reusable_secret_has_value(id: &str) -> bool {
    crate::secrets::get(&api_secret_name(id))
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
fn shadows_virtual_provider_id(id: &str) -> bool {
    if super::codex::is_virtual_provider_id(id) {
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
        .is_some_and(super::codex::is_virtual_provider_id)
}

const MAX_CATEGORY_CHARS: usize = 64;
const MAX_TAGS: usize = 24;
const MAX_TAG_CHARS: usize = 48;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_NAME_CHARS: usize = 128;
const MAX_HEADER_VALUE_CHARS: usize = 4096;
const MAX_MAPPING_TEMPLATE_BYTES: usize = 256 * 1024;
const MAX_MAPPING_PLACEHOLDERS: usize = 64;
const MAX_SECRET_NAME_CHARS: usize = 96;
/// Windows Generic Credentials cap the credential blob at 2,560 bytes. The
/// current keyring backend stores passwords as UTF-16, so validation below
/// checks both the UTF-8 input size and its encoded UTF-16 byte count before a
/// platform call. OpenAI/vendor API keys are far smaller; refusing larger
/// values gives a useful error instead of the keyring's opaque platform-limit
/// failure.
pub(crate) const MAX_PROVIDER_KEY_BYTES: usize = 2_560;

fn normalize_api_secret_meta(secret: &mut ApiSecretMeta) -> Result<(), String> {
    secret.id = secret.id.trim().to_ascii_lowercase();
    if !valid_id(&secret.id) {
        return Err("API secret id must be lowercase letters/digits/dash (1–64 chars)".into());
    }
    secret.name = secret.name.trim().to_string();
    if secret.name.is_empty() {
        return Err("API secret display name is required".into());
    }
    if secret.name.chars().any(char::is_control) {
        return Err("API secret display name must be a single-line label".into());
    }
    if secret.name.chars().count() > MAX_SECRET_NAME_CHARS {
        return Err(format!(
            "API secret display name must be at most {MAX_SECRET_NAME_CHARS} characters"
        ));
    }
    Ok(())
}

fn validate_secret_value(value: &str) -> Result<(), String> {
    let utf16_bytes = value
        .encode_utf16()
        .count()
        .checked_mul(2)
        .ok_or_else(|| "API secret is too large".to_string())?;
    if value.len() > MAX_PROVIDER_KEY_BYTES || utf16_bytes > MAX_PROVIDER_KEY_BYTES {
        return Err(format!(
            "API secrets must fit the Windows credential-store limit of {MAX_PROVIDER_KEY_BYTES} bytes (including UTF-16 encoding)"
        ));
    }
    if value.chars().any(char::is_control) {
        return Err("API secrets must be single-line values without control characters".into());
    }
    Ok(())
}

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
        if let Some(path) = spec.websocket_path.as_deref() {
            if path.len() > 2048
                || !path.starts_with('/')
                || path.starts_with("//")
                || path.contains(['?', '#'])
                || path.chars().any(char::is_control)
            {
                return Err(
                    "Realtime WebSocket paths must be relative paths beginning with one / and cannot contain a query or fragment"
                        .into(),
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
            secret_ref: None,
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
    fn virtual_codex_provider_ids_cannot_be_persisted() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        let async_id = super::super::codex::ASYNC_PROVIDER_ID;
        let error = reg
            .upsert(profile(async_id, vec![Capability::Chat]))
            .expect_err("async Codex provider id must stay host-owned");
        assert!(error.contains("reserved"), "{error}");
        assert!(reg.get(async_id).is_none());
        for variant in super::super::codex::CodexLiveCallVariant::ALL {
            let id = variant.provider_id();
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
                secrets: vec![],
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
        let encoded_luna = "openai-codex-agent-luna%2Dlow";
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("ai-providers.json"),
            serde_json::to_vec(&RegistryDoc {
                version: 1,
                providers: vec![
                    profile("openai", vec![Capability::Chat]),
                    profile(encoded_none, vec![Capability::Chat]),
                    profile(encoded_low, vec![Capability::Chat]),
                    profile(encoded_luna, vec![Capability::Chat]),
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
                        alias: "shadow-luna".into(),
                        capability: Capability::Chat,
                        provider_id: encoded_luna.into(),
                    },
                    AliasBinding {
                        alias: "invalid".into(),
                        capability: Capability::Chat,
                        provider_id: "OpenAI".into(),
                    },
                ],
                secrets: vec![],
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
        for id in [encoded_none, encoded_low, encoded_luna] {
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
                websocket_path: None,
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
            .contains("credential-store limit"));

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
        // A direct provider id is also an explicit, fail-closed selection.
        assert_eq!(
            reg.resolve(Some("whisper"), Capability::Transcription)
                .unwrap()
                .id,
            "whisper"
        );
        assert!(
            reg.resolve(Some("missing-provider"), Capability::Chat)
                .is_none(),
            "a stale named selection must not spend the default provider's key"
        );
        assert!(
            reg.resolve(Some("receptionist-chat"), Capability::Transcription)
                .is_none(),
            "an alias for the wrong capability must not fall through"
        );
        // No alias → first enabled provider that supports the capability.
        assert_eq!(
            reg.resolve(None, Capability::Transcription).unwrap().id,
            "whisper"
        );
        assert_eq!(
            reg.resolve(Some("  "), Capability::Transcription)
                .unwrap()
                .id,
            "whisper",
            "a blank selector retains default-provider behavior"
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
    fn reusable_secret_metadata_round_trips_without_a_value() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        reg.upsert_secret(ApiSecretMeta {
            id: "  Shared-OpenAI  ".into(),
            name: "  Company OpenAI key  ".into(),
            kind: ApiSecretKind::ApiKey,
        })
        .unwrap();

        let reloaded = ProviderRegistry::load(&dir);
        let secret = reloaded.get_secret_meta("shared-openai").unwrap();
        assert_eq!(secret.name, "Company OpenAI key");
        let persisted = std::fs::read_to_string(dir.join("ai-providers.json")).unwrap();
        assert!(persisted.contains("shared-openai"));
        assert!(!persisted.contains("secretValue"));
        assert!(!persisted.contains("apiKey"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn providers_can_share_a_secret_and_provider_delete_retains_it() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        reg.upsert_secret(ApiSecretMeta {
            id: "shared-openai".into(),
            name: "Shared OpenAI key".into(),
            kind: ApiSecretKind::ApiKey,
        })
        .unwrap();

        for id in ["transcriber", "audio-chat"] {
            let mut provider = profile(id, vec![Capability::Chat]);
            provider.secret_ref = Some("shared-openai".into());
            reg.upsert(provider).unwrap();
        }
        let view = reg
            .list_secrets()
            .into_iter()
            .find(|view| view.meta.id == "shared-openai")
            .unwrap();
        assert_eq!(view.used_by, ["audio-chat", "transcriber"]);
        assert!(reg
            .delete_secret("shared-openai")
            .unwrap_err()
            .contains("audio-chat"));

        reg.delete("transcriber").unwrap();
        assert!(reg.get_secret_meta("shared-openai").is_some());
        let view = reg
            .list_secrets()
            .into_iter()
            .find(|view| view.meta.id == "shared-openai")
            .unwrap();
        assert_eq!(view.used_by, ["audio-chat"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_provider_key_endpoint_cannot_mutate_a_shared_secret() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        reg.upsert_secret(ApiSecretMeta {
            id: "shared-openai".into(),
            name: "Shared OpenAI key".into(),
            kind: ApiSecretKind::ApiKey,
        })
        .unwrap();
        let mut provider = profile("audio-chat", vec![Capability::Chat]);
        provider.secret_ref = Some("shared-openai".into());
        reg.upsert(provider).unwrap();

        let error = reg
            .set_key("audio-chat", Some("must-not-write"))
            .unwrap_err();
        assert!(error.contains("API Secrets endpoint"));
        assert!(!reg.list_secrets()[0].has_value);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn provider_secret_reference_must_resolve() {
        let dir = tmp();
        let mut reg = ProviderRegistry::load(&dir);
        let mut provider = profile("openai", vec![Capability::Chat]);
        provider.secret_ref = Some("missing".into());
        assert!(reg
            .upsert(provider)
            .unwrap_err()
            .contains("unknown reusable API secret"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_dangling_secret_reference_disables_provider_instead_of_falling_back() {
        let dir = tmp();
        let mut provider = profile("openai", vec![Capability::Chat]);
        provider.secret_ref = Some("missing-secret".into());
        std::fs::write(
            dir.join("ai-providers.json"),
            serde_json::to_vec(&RegistryDoc {
                version: 1,
                providers: vec![provider],
                aliases: vec![],
                secrets: vec![],
            })
            .unwrap(),
        )
        .unwrap();

        let reg = ProviderRegistry::load(&dir);
        let loaded = reg.get("openai").unwrap();
        assert!(!loaded.enabled, "credential ambiguity must fail closed");
        assert_eq!(loaded.secret_ref, None);
        assert!(reg.resolve(None, Capability::Chat).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn api_secret_limits_match_windows_keyring_encoding() {
        assert!(validate_secret_value(&"x".repeat(MAX_PROVIDER_KEY_BYTES / 2)).is_ok());
        // UTF-8 still fits (1,281 bytes), but Windows keyring encodes the
        // value as UTF-16 (2,562 bytes), just over its 2,560-byte limit.
        assert!(validate_secret_value(&"x".repeat(MAX_PROVIDER_KEY_BYTES / 2 + 1)).is_err());
        assert!(validate_secret_value("sk-valid_single-line").is_ok());
        assert!(validate_secret_value("sk-invalid\nline").is_err());
    }

    #[test]
    fn default_paths_follow_protocol() {
        let p = profile("openai", vec![]);
        assert_eq!(p.path_for(Capability::Chat), "/v1/chat/completions");
        assert_eq!(p.path_for(Capability::Speech), "/v1/audio/speech");
        assert_eq!(p.path_for(Capability::Realtime), "/v1/realtime/calls");
        assert_eq!(p.realtime_websocket_path(), "/v1/realtime");
        assert_eq!(
            p.realtime_destination_origin().as_deref(),
            Some("https://api.openai.com")
        );
        assert!(p.supports(Capability::Chat), "empty caps = all");
    }

    #[test]
    fn realtime_websocket_path_is_independent_and_bounded() {
        let dir = tmp();
        let mut registry = ProviderRegistry::load(&dir);
        let mut provider = profile("realtime", vec![Capability::Realtime]);
        provider.specs.insert(
            "realtime".into(),
            CapabilitySpec {
                path: Some("/v1/realtime/calls".into()),
                websocket_path: Some("/custom/realtime".into()),
                ..CapabilitySpec::default()
            },
        );
        registry.upsert(provider.clone()).unwrap();
        assert_eq!(
            registry.get("realtime").unwrap().realtime_websocket_path(),
            "/custom/realtime"
        );
        provider.specs.get_mut("realtime").unwrap().websocket_path =
            Some("/v1/realtime?model=smuggled".into());
        assert!(registry.upsert(provider).unwrap_err().contains("WebSocket"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn destination_origin_drops_paths_queries_and_credentials() {
        let mut provider = profile("realtime", vec![Capability::Realtime]);
        provider.base_url = "https://api.example.test:8443/customer/path?token=hidden".into();
        assert_eq!(
            provider.realtime_destination_origin().as_deref(),
            Some("https://api.example.test:8443")
        );
        provider.base_url = "https://user:secret@api.example.test/v1".into();
        assert!(provider.realtime_destination_origin().is_none());
    }
}
