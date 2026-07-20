//! AI-402/403/404 — the loopback AI gateway.
//!
//! An OpenAI-compatible surface on the Desktop management plane
//! (`/api/ai/v1/…` for the default provider, `/api/ai/providers/:id/v1/…` for
//! a named one) that translates a canonical chat/audio request to whatever
//! provider resolves, attaching the user's key server-side. Consumers point
//! their existing loopback endpoint settings here and never hold a cloud key.
//!
//! AUTH (ADR-008): inference is NEVER anonymous. The route layer that mounts
//! these handlers requires the management-plane auth (webview | server token |
//! pairing token) exactly like every other `/api/…` route — there is no
//! anonymous tier, so a drive-by web page cannot spend the user's keys. The
//! signed Aokie plugin additionally receives one per-install bearer scoped to
//! inference routes; provider and credential administration remains Desktop-
//! only.
//!
//! EGRESS (AI-404): every outbound call is validated + address-pinned by
//! `egress`, and the reqwest client is built with redirects DISABLED.

use std::time::Duration;

use super::egress;
use super::providers::{
    Capability, ProviderProfile, ProviderRegistryHandle, Protocol, MAX_PROVIDER_KEY_BYTES,
};

const OUTBOUND_TIMEOUT: Duration = Duration::from_secs(120);
/// Size cap on an upstream response — enforced by `read_capped` for buffered
/// bodies and by the HTTP layer's passthrough adapter for streamed ones.
pub const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RENDERED_HEADER_BYTES: usize = 32 * 1024;
const MAX_RENDERED_CUSTOM_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_CUSTOM_PLACEHOLDERS: usize = 64;
const MAX_REALTIME_SDP_BYTES: usize = 2 * 1024 * 1024;

/// Top-level llama.cpp extensions that must not leak into a public
/// OpenAI-compatible request. Local/on-prem providers keep the canonical body
/// unchanged because these fields are useful to llama-server and compatible
/// local runtimes.
const LLAMA_CPP_ONLY_FIELDS: [&str; 3] = ["repeat_penalty", "cache_prompt", "chat_template_kwargs"];

#[derive(Debug)]
pub enum GatewayError {
    /// No provider is configured/enabled for the capability, and the caller
    /// asked for a specific provider or there's no local fallback.
    NoProvider(String),
    /// The provider config or egress policy refused the request.
    BadRequest(String),
    /// The upstream call failed.
    Upstream(String),
}

/// A bounded non-JSON upstream payload whose media type must survive the
/// Desktop gateway (transcription can return JSON, plain text, SRT, or VTT).
pub struct GatewayPayload {
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// One caller-supplied file for the OpenAI-compatible transcription adapter.
/// The HTTP layer owns multipart parsing and limits; this type is deliberately
/// free of Axum so the outbound adapter stays testable in isolation.
pub struct TranscriptionFile {
    pub filename: String,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

impl GatewayError {
    pub fn code(&self) -> &'static str {
        match self {
            GatewayError::NoProvider(_) => "no_provider",
            GatewayError::BadRequest(_) => "bad_request",
            GatewayError::Upstream(_) => "upstream_error",
        }
    }
    pub fn message(&self) -> &str {
        match self {
            GatewayError::NoProvider(m) | GatewayError::BadRequest(m) | GatewayError::Upstream(m) => m,
        }
    }
}

/// Build a redirect-disabled, address-pinned reqwest client for one target.
fn client_for(target: &egress::ValidatedTarget) -> Result<reqwest::Client, GatewayError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(OUTBOUND_TIMEOUT)
        // Pin the resolved address so a DNS rebind between validation and the
        // request can't retarget a private host.
        .resolve(&target.host, target.pinned)
        .build()
        .map_err(|e| GatewayError::Upstream(format!("client build failed: {e}")))
}

/// Render at most one `{{apiKey}}` without permitting a legacy profile or an
/// oversized keyring value to amplify a header allocation.
fn render_header(value: &str, key: Option<&str>) -> Result<String, GatewayError> {
    let count = value.matches("{{apiKey}}").count();
    let key = key.unwrap_or("");
    if count > 1 || key.len() > MAX_PROVIDER_KEY_BYTES || key.chars().any(char::is_control) {
        return Err(GatewayError::BadRequest(
            "provider credential mapping exceeded the safe header limits".into(),
        ));
    }
    let rendered_len = value
        .len()
        .checked_sub(count * "{{apiKey}}".len())
        .and_then(|len| len.checked_add(count * key.len()))
        .ok_or_else(|| GatewayError::BadRequest("provider header mapping overflowed".into()))?;
    if rendered_len > MAX_RENDERED_HEADER_BYTES {
        return Err(GatewayError::BadRequest(
            "rendered provider header exceeded the 32 KiB limit".into(),
        ));
    }
    Ok(value.replacen("{{apiKey}}", key, 1))
}

/// Render auth + custom provider headers for both HTTP and WebSocket
/// transports. Credentials remain in headers and never enter a URL or body.
pub(crate) fn provider_headers(
    provider: &ProviderProfile,
    key: Option<&str>,
) -> Result<reqwest::header::HeaderMap, GatewayError> {
    let mut headers = reqwest::header::HeaderMap::new();
    let mut saw_auth = false;
    for h in &provider.headers {
        let lname = h.name.to_ascii_lowercase();
        // Never forward hop-by-hop, host-spoofing, or WebSocket handshake
        // headers from config. tungstenite mints its own nonce/version and the
        // pinned target retains the validated Host/SNI identity.
        if matches!(
            lname.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "proxy-authorization"
                | "transfer-encoding"
                | "upgrade"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
                | "sec-websocket-protocol"
        ) {
            continue;
        }
        if h.name.contains('\n') || h.name.contains('\r') || h.value.contains('\n') || h.value.contains('\r') {
            continue; // header-injection guard
        }
        if h.value.contains("{{apiKey}}")
            || matches!(
            lname.as_str(),
            "authorization" | "x-api-key" | "api-key" | "x-auth-token" | "x-access-token"
        ) {
            saw_auth = true;
        }
        let name = reqwest::header::HeaderName::from_bytes(h.name.as_bytes())
            .map_err(|_| GatewayError::BadRequest("provider header name is invalid".into()))?;
        let rendered = render_header(&h.value, key)?;
        let value = reqwest::header::HeaderValue::from_str(&rendered)
            .map_err(|_| GatewayError::BadRequest("provider header value is invalid".into()))?;
        headers.insert(name, value);
    }
    // Default auth if a key exists and no header referenced it.
    if !saw_auth {
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            if k.len() > MAX_PROVIDER_KEY_BYTES || k.chars().any(char::is_control) {
                return Err(GatewayError::BadRequest(
                    "provider credential exceeded the safe header limits".into(),
                ));
            }
            match provider.protocol {
                Protocol::Anthropic => {
                    headers.insert(
                        reqwest::header::HeaderName::from_static("x-api-key"),
                        reqwest::header::HeaderValue::from_str(k).map_err(|_| {
                            GatewayError::BadRequest(
                                "provider credential exceeded the safe header limits".into(),
                            )
                        })?,
                    );
                    headers.insert(
                        reqwest::header::HeaderName::from_static("anthropic-version"),
                        reqwest::header::HeaderValue::from_static("2023-06-01"),
                    );
                }
                _ => {
                    let bearer = format!("Bearer {k}");
                    headers.insert(
                        reqwest::header::AUTHORIZATION,
                        reqwest::header::HeaderValue::from_str(&bearer).map_err(|_| {
                            GatewayError::BadRequest(
                                "provider credential exceeded the safe header limits".into(),
                            )
                        })?,
                    );
                }
            }
        }
    }
    Ok(headers)
}

/// Apply the shared provider headers to an ordinary HTTP request.
fn apply_headers(
    rb: reqwest::RequestBuilder,
    provider: &ProviderProfile,
    key: Option<&str>,
) -> Result<reqwest::RequestBuilder, GatewayError> {
    Ok(rb.headers(provider_headers(provider, key)?))
}

/// Resolve the provider for a request: an explicit id (`/providers/:id/…`) OR
/// a capability alias in the request (`data.provider`) OR the default enabled
/// provider. Returns None when nothing is configured (caller may fall back to
/// the local services registry).
pub fn resolve_provider(
    reg: &ProviderRegistryHandle,
    explicit_id: Option<&str>,
    alias: Option<&str>,
    cap: Capability,
) -> Result<Option<ProviderProfile>, GatewayError> {
    let reg = reg.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(id) = explicit_id {
        return match reg.get(id) {
            Some(p) if p.enabled && p.supports(cap) => Ok(Some(p)),
            Some(_) => Err(GatewayError::NoProvider(format!(
                "provider {id:?} is disabled or does not support {}",
                super::providers::capability_key(cap)
            ))),
            None => Err(GatewayError::NoProvider(format!("unknown provider {id:?}"))),
        };
    }
    Ok(reg.resolve(alias, cap))
}

/// True when the provider receives the canonical OpenAI chat body directly.
/// A Custom profile without a request template is explicitly treated as an
/// OpenAI-shaped endpoint at a custom path elsewhere in this module, so it
/// gets the same public-provider hardening.
fn uses_canonical_openai_chat_body(provider: &ProviderProfile) -> bool {
    match provider.protocol {
        Protocol::OpenAi => true,
        Protocol::Anthropic => false,
        Protocol::Custom => provider
            .specs
            .get(super::providers::capability_key(Capability::Chat))
            .and_then(|spec| spec.request_template.as_ref())
            .is_none(),
    }
}

fn is_public_openai_compatible(provider: &ProviderProfile) -> bool {
    !provider.allow_local && uses_canonical_openai_chat_body(provider)
}

/// Remove local-runtime extensions before a canonical body is sent to a
/// public provider. Do not recursively strip same-named application data from
/// messages or tool payloads; only the top-level transport extensions belong
/// to llama.cpp.
fn normalize_public_openai_body(provider: &ProviderProfile, body: &mut serde_json::Value) {
    if !is_public_openai_compatible(provider) {
        return;
    }
    if let Some(object) = body.as_object_mut() {
        for field in LLAMA_CPP_ONLY_FIELDS {
            object.remove(field);
        }
    }
}

/// Exact shape emitted by Aokie's `LlmClient::warm_prefix`: one non-streaming
/// token over a system-led prefix with llama.cpp prompt caching enabled. Keep
/// this deliberately narrow so an ordinary short customer completion can
/// never be mistaken for a warm-only request.
fn is_aokie_prefix_warm(body: &serde_json::Value) -> bool {
    const ALLOWED_FIELDS: [&str; 7] = [
        "model",
        "messages",
        "stream",
        "max_tokens",
        "temperature",
        "cache_prompt",
        "chat_template_kwargs",
    ];

    let Some(object) = body.as_object() else {
        return false;
    };
    if object
        .keys()
        .any(|key| !ALLOWED_FIELDS.contains(&key.as_str()))
        || object.get("stream").and_then(serde_json::Value::as_bool) != Some(false)
        || object.get("max_tokens").and_then(serde_json::Value::as_u64) != Some(1)
        || object
            .get("temperature")
            .and_then(serde_json::Value::as_f64)
            != Some(0.0)
        || object
            .get("cache_prompt")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        return false;
    }
    if object.get("model").is_some_and(|model| !model.is_string()) {
        return false;
    }

    let Some(first_message) = object
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .and_then(|messages| messages.first())
    else {
        return false;
    };
    if first_message
        .get("role")
        .and_then(serde_json::Value::as_str)
        != Some("system")
        || !first_message
            .get("content")
            .is_some_and(serde_json::Value::is_string)
    {
        return false;
    }

    let Some(kwargs) = object
        .get("chat_template_kwargs")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    kwargs.len() == 1
        && kwargs
            .get("enable_thinking")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
}

/// Public providers cannot benefit from Aokie's local llama.cpp KV warm. Give
/// the fire-and-forget caller an honest successful no-content completion with
/// zero usage instead of spending tokens upstream.
fn public_prefix_warm_completion(
    provider: &ProviderProfile,
    body: &serde_json::Value,
) -> Option<serde_json::Value> {
    if !is_public_openai_compatible(provider) || !is_aokie_prefix_warm(body) {
        return None;
    }
    let mut response = serde_json::json!({
        "id": "formlogic-aokie-prefix-warm-skipped",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "" },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
    });
    if let Some(model) = body.get("model") {
        response["model"] = model.clone();
    }
    Some(response)
}

/// Forward a chat-completions request to a resolved provider and return its
/// JSON response body. Non-streaming (streaming SSE is an additive follow-up).
/// `body` is the canonical OpenAI chat-completions request; for a Custom
/// provider the request template (if any) is rendered instead.
pub async fn chat_completions(
    reg: &ProviderRegistryHandle,
    provider: &ProviderProfile,
    mut body: serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    let cap = Capability::Chat;
    // Default the model from the profile when the caller didn't set one.
    if body.get("model").is_none() {
        if let Some(m) = &provider.model {
            body["model"] = serde_json::Value::String(m.clone());
        }
    }
    // This check intentionally precedes keyring access, DNS validation and
    // client construction: a public KV-cache warm is a local-only optimization
    // and must never create an upstream request or billable token usage.
    if let Some(response) = public_prefix_warm_completion(provider, &body) {
        return Ok(response);
    }
    normalize_public_openai_body(provider, &mut body);

    let key = reg.lock().unwrap_or_else(|e| e.into_inner()).key(&provider.id);
    let access = provider.local_access();
    let path = provider.path_for(cap);
    let target = egress::validate(&provider.base_url, &path, access)
        .map_err(|e| GatewayError::BadRequest(e.to_string()))?;

    // For a Custom provider with a request template, render it.
    let out_body = if provider.protocol == Protocol::Custom {
        render_custom_body(provider, cap, &body)?
    } else if provider.protocol == Protocol::Anthropic {
        openai_chat_to_anthropic(&body)?
    } else {
        body.clone()
    };

    let client = client_for(&target)?;
    let rb = client.post(target.url.clone()).json(&out_body);
    let rb = apply_headers(rb, provider, key.as_deref())?;
    let resp = rb
        .send()
        .await
        .map_err(|e| GatewayError::Upstream(format!("request failed: {e}")))?;
    let status = resp.status();
    let bytes = read_capped(resp).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| GatewayError::Upstream(format!("non-JSON upstream response ({status}): {e}")))?;
    if !status.is_success() {
        return Err(GatewayError::Upstream(format!(
            "upstream {status}: {}",
            value.get("error").map(|e| e.to_string()).unwrap_or_default()
        )));
    }
    // Normalize Custom / Anthropic responses back to the OpenAI shape so
    // consumers see one dialect.
    match provider.protocol {
        Protocol::Custom => Ok(wrap_text_as_openai_chat(extract_custom_text(provider, cap, &value))),
        Protocol::Anthropic => Ok(wrap_text_as_openai_chat(extract_anthropic_text(&value))),
        Protocol::OpenAi => Ok(value),
    }
}

/// Forward an OpenAI-compatible multipart transcription request. Credentials
/// and the configured default model are injected by Desktop; neither is ever
/// exposed to the website or plugin. Custom providers may override only the
/// transcription path and must otherwise accept the OpenAI multipart shape.
pub async fn transcribe(
    reg: &ProviderRegistryHandle,
    provider: &ProviderProfile,
    file: TranscriptionFile,
    mut fields: Vec<(String, String)>,
) -> Result<GatewayPayload, GatewayError> {
    if provider.protocol == Protocol::Anthropic {
        return Err(GatewayError::BadRequest(
            "Anthropic providers do not support the OpenAI transcription adapter".into(),
        ));
    }
    if !fields.iter().any(|(name, _)| name == "model") {
        if let Some(model) = provider.model.as_deref() {
            fields.push(("model".into(), model.into()));
        }
    }

    let key = reg.lock().unwrap_or_else(|e| e.into_inner()).key(&provider.id);
    let path = provider.path_for(Capability::Transcription);
    let target = egress::validate(&provider.base_url, &path, provider.local_access())
        .map_err(|e| GatewayError::BadRequest(e.to_string()))?;
    let mut part = reqwest::multipart::Part::bytes(file.bytes).file_name(file.filename);
    if let Some(content_type) = file.content_type.as_deref() {
        part = part
            .mime_str(content_type)
            .map_err(|_| GatewayError::BadRequest("audio file has an invalid content type".into()))?;
    }
    let mut form = reqwest::multipart::Form::new().part("file", part);
    for (name, value) in fields {
        form = form.text(name, value);
    }
    let client = client_for(&target)?;
    let request = apply_headers(client.post(target.url.clone()).multipart(form), provider, key.as_deref())?;
    let response = request
        .send()
        .await
        .map_err(|e| GatewayError::Upstream(format!("transcription request failed: {e}")))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = read_capped(response).await?;
    if !status.is_success() {
        return Err(GatewayError::Upstream(format!(
            "upstream {status}: {}",
            String::from_utf8_lossy(&bytes).chars().take(500).collect::<String>()
        )));
    }
    Ok(GatewayPayload { content_type, bytes })
}

/// Create a WebRTC Realtime session through OpenAI's unified server-side
/// interface. The caller supplies an SDP offer plus a bounded session object;
/// Desktop supplies the reusable API secret and returns only the SDP answer.
pub async fn realtime_session(
    reg: &ProviderRegistryHandle,
    provider: &ProviderProfile,
    sdp: String,
    mut session: serde_json::Value,
) -> Result<String, GatewayError> {
    if provider.protocol != Protocol::OpenAi {
        return Err(GatewayError::BadRequest(
            "Realtime WebRTC sessions currently require an OpenAI-protocol provider".into(),
        ));
    }
    if sdp.is_empty() || sdp.len() > MAX_REALTIME_SDP_BYTES || sdp.chars().any(|ch| ch == '\0') {
        return Err(GatewayError::BadRequest(
            "Realtime SDP must be non-empty, NUL-free, and no larger than 2 MiB".into(),
        ));
    }
    let object = session.as_object_mut().ok_or_else(|| {
        GatewayError::BadRequest("Realtime session configuration must be a JSON object".into())
    })?;
    object.insert("type".into(), serde_json::Value::String("realtime".into()));
    if !object.contains_key("model") {
        let model = provider.model.as_deref().ok_or_else(|| {
            GatewayError::BadRequest(
                "Realtime provider has no model configured and the request did not select one".into(),
            )
        })?;
        object.insert("model".into(), serde_json::Value::String(model.into()));
    }
    let session_json = serde_json::to_string(&session)
        .map_err(|_| GatewayError::BadRequest("Realtime session configuration is invalid".into()))?;
    if session_json.len() > 256 * 1024 {
        return Err(GatewayError::BadRequest(
            "Realtime session configuration exceeded the 256 KiB limit".into(),
        ));
    }

    let key = reg.lock().unwrap_or_else(|e| e.into_inner()).key(&provider.id);
    let path = provider.path_for(Capability::Realtime);
    let target = egress::validate(&provider.base_url, &path, provider.local_access())
        .map_err(|e| GatewayError::BadRequest(e.to_string()))?;
    // OpenAI's unified WebRTC endpoint dispatches these parts by media type,
    // not just by field name. `Form::text` would label both as plain text,
    // which makes the otherwise-valid offer fail at the upstream boundary.
    let sdp_part = reqwest::multipart::Part::text(sdp)
        .mime_str("application/sdp")
        .map_err(|_| GatewayError::BadRequest("Realtime SDP media type is invalid".into()))?;
    let session_part = reqwest::multipart::Part::text(session_json)
        .mime_str("application/json")
        .map_err(|_| GatewayError::BadRequest("Realtime session media type is invalid".into()))?;
    let form = reqwest::multipart::Form::new()
        .part("sdp", sdp_part)
        .part("session", session_part);
    let client = client_for(&target)?;
    let request = apply_headers(client.post(target.url.clone()).multipart(form), provider, key.as_deref())?;
    let response = request
        .send()
        .await
        .map_err(|e| GatewayError::Upstream(format!("Realtime session request failed: {e}")))?;
    let status = response.status();
    let bytes = read_capped(response).await?;
    if !status.is_success() {
        return Err(GatewayError::Upstream(format!(
            "upstream {status}: {}",
            String::from_utf8_lossy(&bytes).chars().take(500).collect::<String>()
        )));
    }
    if bytes.len() > MAX_REALTIME_SDP_BYTES {
        return Err(GatewayError::Upstream(
            "Realtime SDP answer exceeded the 2 MiB limit".into(),
        ));
    }
    validate_realtime_sdp_answer(bytes)
}

fn validate_realtime_sdp_answer(bytes: Vec<u8>) -> Result<String, GatewayError> {
    let answer = String::from_utf8(bytes)
        .map_err(|_| GatewayError::Upstream("Realtime upstream returned non-UTF-8 SDP".into()))?;
    // RFC 8866 requires the version line to be the first SDP line. Checking it
    // also prevents a 2xx JSON/error page from being handed to RTCPeerConnection
    // as though it were a successful answer.
    if answer.contains('\0') || !(answer.starts_with("v=0\r\n") || answer.starts_with("v=0\n")) {
        return Err(GatewayError::Upstream(
            "Realtime upstream returned a non-SDP success payload".into(),
        ));
    }
    Ok(answer)
}

/// AI-405: can `stream:true` be honestly proxied for this provider? Only a
/// provider whose wire dialect IS OpenAI chat-completions can stream — the
/// upstream SSE bytes pass through unaltered, so any protocol we'd have to
/// TRANSLATE per-chunk (the Anthropic mapping, a Custom request template or
/// response path) is refused rather than mangled.
pub fn protocol_streamable(provider: &ProviderProfile) -> bool {
    match provider.protocol {
        Protocol::OpenAi => true,
        Protocol::Anthropic => false,
        Protocol::Custom => {
            // A Custom provider with NEITHER a request template NOR a response
            // path is an OpenAI-shaped endpoint at a custom path — pass-through
            // works. Either mapping present ⇒ the response needs translation.
            let spec = provider
                .specs
                .get(super::providers::capability_key(Capability::Chat));
            spec.map(|s| s.request_template.is_none() && s.response_path.is_none())
                .unwrap_or(true)
        }
    }
}

/// AI-405: forward a `stream:true` chat-completions request and hand back the
/// upstream `reqwest::Response` for incremental byte passthrough (the HTTP
/// layer pipes `bytes_stream()` straight to the client — no buffering).
/// SAME egress hardening as the buffered path: validated + address-pinned
/// client, redirects disabled, headers applied server-side. Callers must
/// gate on [`protocol_streamable`] first. A non-2xx upstream is read (capped)
/// and surfaced as a normal `GatewayError::Upstream` so error bodies never
/// masquerade as an event stream.
pub async fn chat_completions_stream(
    reg: &ProviderRegistryHandle,
    provider: &ProviderProfile,
    mut body: serde_json::Value,
) -> Result<reqwest::Response, GatewayError> {
    let cap = Capability::Chat;
    // Default the model from the profile when the caller didn't set one.
    if body.get("model").is_none() {
        if let Some(m) = &provider.model {
            body["model"] = serde_json::Value::String(m.clone());
        }
    }
    normalize_public_openai_body(provider, &mut body);

    let key = reg.lock().unwrap_or_else(|e| e.into_inner()).key(&provider.id);
    let access = provider.local_access();
    let path = provider.path_for(cap);
    let target = egress::validate(&provider.base_url, &path, access)
        .map_err(|e| GatewayError::BadRequest(e.to_string()))?;

    let client = client_for(&target)?;
    let rb = client.post(target.url.clone()).json(&body);
    let rb = apply_headers(rb, provider, key.as_deref())?;
    let resp = rb
        .send()
        .await
        .map_err(|e| GatewayError::Upstream(format!("request failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let bytes = read_capped(resp).await.unwrap_or_default();
        let detail = String::from_utf8_lossy(&bytes);
        return Err(GatewayError::Upstream(format!(
            "upstream {status}: {}",
            detail.chars().take(500).collect::<String>()
        )));
    }
    Ok(resp)
}

/// List models from a resolved provider (`GET <base>/v1/models`) or, for a
/// provider with a fixed model, synthesize a one-entry list.
pub async fn list_models(
    reg: &ProviderRegistryHandle,
    provider: &ProviderProfile,
) -> Result<serde_json::Value, GatewayError> {
    if provider.protocol != Protocol::OpenAi {
        // Anthropic/Custom: report the configured model as the only entry.
        let id = provider.model.clone().unwrap_or_else(|| provider.id.clone());
        return Ok(serde_json::json!({ "object": "list", "data": [{ "id": id, "object": "model" }] }));
    }
    let key = reg.lock().unwrap_or_else(|e| e.into_inner()).key(&provider.id);
    let target = egress::validate(&provider.base_url, "/v1/models", provider.local_access())
        .map_err(|e| GatewayError::BadRequest(e.to_string()))?;
    let client = client_for(&target)?;
    let rb = apply_headers(client.get(target.url.clone()), provider, key.as_deref())?;
    let resp = rb
        .send()
        .await
        .map_err(|e| GatewayError::Upstream(format!("request failed: {e}")))?;
    let status = resp.status();
    let bytes = read_capped(resp).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| GatewayError::Upstream(format!("non-JSON upstream ({status}): {e}")))?;
    if !status.is_success() {
        return Err(GatewayError::Upstream(format!("upstream {status}")));
    }
    Ok(value)
}

/// A cheap reachability + auth probe for the "Test" button: hit /v1/models
/// (OpenAI) or a HEAD-ish check. Returns Ok(()) on 2xx.
pub async fn test_provider(
    reg: &ProviderRegistryHandle,
    provider: &ProviderProfile,
) -> Result<(), GatewayError> {
    // Models list doubles as the auth check for OpenAI-shaped providers.
    if provider.protocol == Protocol::OpenAi {
        list_models(reg, provider).await.map(|_| ())
    } else {
        // For Anthropic/Custom just validate egress + that a key exists if the
        // endpoint is public.
        egress::validate(&provider.base_url, &provider.path_for(Capability::Chat), provider.local_access())
            .map_err(|e| GatewayError::BadRequest(e.to_string()))?;
        Ok(())
    }
}

async fn read_capped(resp: reqwest::Response) -> Result<Vec<u8>, GatewayError> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| GatewayError::Upstream(format!("read failed: {e}")))?;
        if out.len() as u64 + chunk.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(GatewayError::Upstream("upstream response exceeded the size cap".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

// ---- protocol adapters (small, deliberately explicit) ----

fn render_bounded_template(
    template: &str,
    replacements: &[(&str, String)],
) -> Result<String, GatewayError> {
    let mut rendered_len = template.len();
    let mut placeholder_count = 0usize;
    for (placeholder, value) in replacements {
        let count = template.matches(placeholder).count();
        placeholder_count = placeholder_count
            .checked_add(count)
            .ok_or_else(|| GatewayError::BadRequest("custom mapping count overflowed".into()))?;
        rendered_len = rendered_len
            .checked_sub(
                count
                    .checked_mul(placeholder.len())
                    .ok_or_else(|| GatewayError::BadRequest("custom mapping overflowed".into()))?,
            )
            .and_then(|len| len.checked_add(count.checked_mul(value.len())?))
            .ok_or_else(|| GatewayError::BadRequest("custom mapping overflowed".into()))?;
    }
    if placeholder_count > MAX_CUSTOM_PLACEHOLDERS {
        return Err(GatewayError::BadRequest(format!(
            "custom request templates are limited to {MAX_CUSTOM_PLACEHOLDERS} data placeholders"
        )));
    }
    if rendered_len > MAX_RENDERED_CUSTOM_BODY_BYTES {
        return Err(GatewayError::BadRequest(
            "rendered custom request exceeded the 4 MiB limit".into(),
        ));
    }

    // Render in one bounded allocation. This avoids the repeated global
    // replacement amplification that a legacy on-disk profile could trigger.
    let mut out = String::with_capacity(rendered_len);
    let mut cursor = 0usize;
    while cursor < template.len() {
        let next = replacements
            .iter()
            .filter_map(|(placeholder, value)| {
                template[cursor..]
                    .find(placeholder)
                    .map(|offset| (cursor + offset, *placeholder, value.as_str()))
            })
            .min_by_key(|(position, _, _)| *position);
        let Some((position, placeholder, value)) = next else {
            out.push_str(&template[cursor..]);
            break;
        };
        out.push_str(&template[cursor..position]);
        out.push_str(value);
        cursor = position + placeholder.len();
    }
    debug_assert_eq!(out.len(), rendered_len);
    Ok(out)
}

fn render_custom_body(
    provider: &ProviderProfile,
    cap: Capability,
    canonical: &serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    let spec = provider.specs.get(super::providers::capability_key(cap));
    let Some(template) = spec.and_then(|s| s.request_template.as_ref()) else {
        // No template → pass the canonical body through unchanged.
        return Ok(canonical.clone());
    };
    if template.contains("{{apiKey}}") {
        return Err(GatewayError::BadRequest(
            "custom request templates cannot reference {{apiKey}}; credentials are injected into HTTP headers by the Desktop host"
                .into(),
        ));
    }
    let model = canonical.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let prompt = last_user_text(canonical);
    let messages = if template.contains("{{messages}}") {
        canonical
            .get("messages")
            .cloned()
            .unwrap_or(serde_json::json!([]))
            .to_string()
    } else {
        String::new()
    };
    let rendered = render_bounded_template(
        template,
        &[
            ("{{model}}", json_escape(model)),
            ("{{messages}}", messages),
            ("{{prompt}}", json_escape(&prompt)),
            ("{{input}}", json_escape(&prompt)),
        ],
    )?;
    serde_json::from_str(&rendered)
        .map_err(|e| GatewayError::BadRequest(format!("custom request template did not render to JSON: {e}")))
}

fn extract_custom_text(provider: &ProviderProfile, cap: Capability, resp: &serde_json::Value) -> String {
    let spec = provider.specs.get(super::providers::capability_key(cap));
    let path = spec
        .and_then(|s| s.response_path.as_deref())
        .unwrap_or("choices.0.message.content");
    dot_path(resp, path)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn openai_chat_to_anthropic(body: &serde_json::Value) -> Result<serde_json::Value, GatewayError> {
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("claude-3-5-sonnet-latest");
    let max = body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(1024);
    let mut system = String::new();
    let mut messages = Vec::new();
    if let Some(arr) = body.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if role == "system" {
                if !system.is_empty() {
                    system.push('\n');
                }
                system.push_str(content);
            } else {
                messages.push(serde_json::json!({ "role": role, "content": content }));
            }
        }
    }
    let mut out = serde_json::json!({ "model": model, "max_tokens": max, "messages": messages });
    if !system.is_empty() {
        out["system"] = serde_json::Value::String(system);
    }
    Ok(out)
}

fn extract_anthropic_text(resp: &serde_json::Value) -> String {
    resp.get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn wrap_text_as_openai_chat(text: String) -> serde_json::Value {
    serde_json::json!({
        "object": "chat.completion",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": text }, "finish_reason": "stop" }]
    })
}

fn last_user_text(body: &serde_json::Value) -> String {
    body.get("messages")
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.iter().rev().find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user")))
        .and_then(|m| m.get("content").and_then(|c| c.as_str()))
        .unwrap_or("")
        .to_string()
}

fn json_escape(s: &str) -> String {
    // Escape into a JSON string body (without the surrounding quotes) so it can
    // be substituted inside a template's quoted field.
    let quoted = serde_json::Value::String(s.to_string()).to_string();
    quoted[1..quoted.len() - 1].to_string()
}

/// Minimal dot-path lookup with numeric array indices (`choices.0.message.content`).
fn dot_path<'a>(v: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut cur = v;
    for seg in path.split('.') {
        if let Ok(idx) = seg.parse::<usize>() {
            cur = cur.get(idx)?;
        } else {
            cur = cur.get(seg)?;
        }
    }
    Some(cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(protocol: Protocol, allow_local: bool) -> ProviderProfile {
        ProviderProfile {
            id: "test-provider".into(),
            name: "Test provider".into(),
            category: None,
            tags: vec![],
            protocol,
            base_url: "https://example.com".into(),
            model: Some("test-model".into()),
            capabilities: vec![Capability::Chat],
            headers: vec![],
            secret_ref: None,
            specs: Default::default(),
            allow_local,
            enabled: true,
        }
    }

    #[test]
    fn openai_to_anthropic_moves_system_and_maps_messages() {
        let body = serde_json::json!({
            "model": "claude-3-5-sonnet-latest",
            "max_tokens": 200,
            "messages": [
                { "role": "system", "content": "you are terse" },
                { "role": "user", "content": "hi" }
            ]
        });
        let out = openai_chat_to_anthropic(&body).unwrap();
        assert_eq!(out["system"], "you are terse");
        assert_eq!(out["messages"].as_array().unwrap().len(), 1);
        assert_eq!(out["messages"][0]["role"], "user");
        assert_eq!(out["max_tokens"], 200);
    }

    #[test]
    fn anthropic_text_extraction_and_openai_wrap() {
        let resp = serde_json::json!({ "content": [{ "type": "text", "text": "hello" }, { "type": "text", "text": " world" }] });
        assert_eq!(extract_anthropic_text(&resp), "hello world");
        let wrapped = wrap_text_as_openai_chat("hi".into());
        assert_eq!(wrapped["choices"][0]["message"]["content"], "hi");
    }

    #[test]
    fn custom_template_renders_and_response_path_extracts() {
        let mut specs = std::collections::HashMap::new();
        specs.insert(
            "chat".to_string(),
            super::super::providers::CapabilitySpec {
                path: Some("/generate".into()),
                request_template: Some(r#"{"q":"{{prompt}}","m":"{{model}}"}"#.into()),
                response_path: Some("result.text".into()),
                websocket_path: None,
            },
        );
        let provider = ProviderProfile {
            id: "custom".into(),
            name: "Custom".into(),
            category: None,
            tags: vec![],
            protocol: Protocol::Custom,
            base_url: "https://example.com".into(),
            model: Some("m1".into()),
            capabilities: vec![Capability::Chat],
            headers: vec![],
            secret_ref: None,
            specs,
            allow_local: false,
            enabled: true,
        };
        let canonical = serde_json::json!({
            "model": "m1",
            "messages": [{ "role": "user", "content": "say \"hi\"" }]
        });
        let body = render_custom_body(&provider, Capability::Chat, &canonical).unwrap();
        assert_eq!(body["q"], "say \"hi\"", "prompt escaped + substituted");
        assert_eq!(body["m"], "m1");
        let resp = serde_json::json!({ "result": { "text": "done" } });
        assert_eq!(extract_custom_text(&provider, Capability::Chat, &resp), "done");
    }

    #[test]
    fn custom_template_refuses_placeholder_amplification_before_rendering() {
        let mut provider = profile(Protocol::Custom, false);
        provider.specs.insert(
            "chat".into(),
            super::super::providers::CapabilitySpec {
                request_template: Some(format!(
                    r#"{{"q":"{}"}}"#,
                    "{{prompt}}".repeat(MAX_CUSTOM_PLACEHOLDERS + 1)
                )),
                ..super::super::providers::CapabilitySpec::default()
            },
        );
        let canonical = serde_json::json!({
            "messages": [{ "role": "user", "content": "large customer prompt" }]
        });
        let error = render_custom_body(&provider, Capability::Chat, &canonical)
            .expect_err("placeholder amplification must be refused");
        assert!(error.message().contains("data placeholders"));
    }

    #[test]
    fn public_openai_normalization_strips_llama_fields_but_local_preserves_them() {
        let original = serde_json::json!({
            "model": "m1",
            "messages": [{ "role": "user", "content": "hello" }],
            "stream": true,
            "temperature": 0.35,
            "repeat_penalty": 1.15,
            "cache_prompt": true,
            "chat_template_kwargs": { "enable_thinking": false },
            "metadata": { "cache_prompt": "application data is untouched" }
        });

        let mut public_body = original.clone();
        normalize_public_openai_body(&profile(Protocol::OpenAi, false), &mut public_body);
        for field in LLAMA_CPP_ONLY_FIELDS {
            assert!(
                public_body.get(field).is_none(),
                "{field} reached a public provider"
            );
        }
        assert_eq!(public_body["temperature"], 0.35);
        assert_eq!(
            public_body["metadata"]["cache_prompt"],
            "application data is untouched"
        );

        let mut local_body = original.clone();
        normalize_public_openai_body(&profile(Protocol::OpenAi, true), &mut local_body);
        assert_eq!(
            local_body, original,
            "local llama-compatible request changed"
        );
    }

    #[tokio::test]
    async fn public_aokie_prefix_warm_short_circuits_before_egress() {
        let mut provider = profile(Protocol::OpenAi, false);
        // If the warm request reaches egress validation this URL is rejected;
        // success therefore locks the no-upstream branch ahead of transport.
        provider.base_url = "not a provider URL".into();
        let body = serde_json::json!({
            "model": "m1",
            "messages": [{ "role": "system", "content": "You are Aokie." }],
            "stream": false,
            "max_tokens": 1,
            "temperature": 0.0,
            "cache_prompt": true,
            "chat_template_kwargs": { "enable_thinking": false }
        });
        let reg = std::sync::Arc::new(std::sync::Mutex::new(
            super::super::providers::ProviderRegistry::load(std::path::Path::new(
                "__formlogic_gateway_warm_test_missing__",
            )),
        ));

        let response = chat_completions(&reg, &provider, body.clone())
            .await
            .expect("public warm is a successful local no-op");
        assert_eq!(response["id"], "formlogic-aokie-prefix-warm-skipped");
        assert_eq!(response["choices"][0]["message"]["content"], "");
        assert_eq!(response["usage"]["total_tokens"], 0);

        assert!(public_prefix_warm_completion(&profile(Protocol::OpenAi, true), &body).is_none());
        let mut ordinary_short_completion = body;
        ordinary_short_completion["cache_prompt"] = serde_json::Value::Bool(false);
        assert!(public_prefix_warm_completion(
            &profile(Protocol::OpenAi, false),
            &ordinary_short_completion
        )
        .is_none());
    }

    #[tokio::test]
    async fn realtime_uses_the_media_types_required_by_the_unified_endpoint() {
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let handler_observed = observed.clone();
        let app = axum::Router::new().route(
            "/v1/realtime/calls",
            axum::routing::post(move |mut multipart: axum::extract::Multipart| {
                let handler_observed = handler_observed.clone();
                async move {
                    let mut parts = Vec::new();
                    while let Some(field) = multipart
                        .next_field()
                        .await
                        .expect("valid Realtime multipart request")
                    {
                        let name = field.name().unwrap_or_default().to_owned();
                        let content_type = field.content_type().unwrap_or_default().to_owned();
                        let text = field.text().await.expect("text multipart field");
                        parts.push((name, content_type, text));
                    }
                    *handler_observed.lock().unwrap() = parts;
                    (
                        axum::http::StatusCode::CREATED,
                        [(axum::http::header::CONTENT_TYPE, "application/sdp")],
                        "v=0\r\nanswer\r\n",
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve Realtime fixture");
        });

        let mut provider = profile(Protocol::OpenAi, true);
        provider.base_url = format!("http://{address}");
        provider.capabilities = vec![Capability::Realtime];
        let registry = std::sync::Arc::new(std::sync::Mutex::new(
            super::super::providers::ProviderRegistry::load(std::path::Path::new(
                "__formlogic_gateway_realtime_test_missing__",
            )),
        ));
        let answer = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            realtime_session(
                &registry,
                &provider,
                "v=0\r\no=offer\r\n".into(),
                serde_json::json!({ "instructions": "Be concise." }),
            ),
        )
        .await
        .expect("Realtime fixture timed out")
        .expect("Realtime request succeeded");
        server.abort();

        assert_eq!(answer, "v=0\r\nanswer\r\n");
        let parts = observed.lock().unwrap();
        assert_eq!(parts.len(), 2);
        let sdp = parts
            .iter()
            .find(|(name, _, _)| name == "sdp")
            .expect("SDP part");
        assert_eq!(sdp.1, "application/sdp");
        assert!(sdp.2.starts_with("v=0"));
        let session = parts
            .iter()
            .find(|(name, _, _)| name == "session")
            .expect("session part");
        assert_eq!(session.1, "application/json");
        let session_json: serde_json::Value =
            serde_json::from_str(&session.2).expect("session JSON");
        assert_eq!(session_json["type"], "realtime");
        assert_eq!(session_json["model"], "test-model");
    }

    #[test]
    fn realtime_refuses_a_non_sdp_success_payload() {
        let error =
            validate_realtime_sdp_answer(br#"{"error":"not really an SDP answer"}"#.to_vec())
                .expect_err("a JSON 2xx payload must not reach RTCPeerConnection");
        assert!(error.message().contains("non-SDP"));
        assert!(validate_realtime_sdp_answer(b"v=0\r\no=answer\r\n".to_vec()).is_ok());
    }

    #[test]
    fn custom_body_rejects_api_key_placeholder_and_header_auth_remains_host_side() {
        let mut provider = profile(Protocol::Custom, false);
        provider.specs.insert(
            "chat".into(),
            super::super::providers::CapabilitySpec {
                path: Some("/generate".into()),
                request_template: Some(r#"{"prompt":"{{prompt}}","key":"{{apiKey}}"}"#.into()),
                response_path: None,
                websocket_path: None,
            },
        );
        let canonical = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        let err = render_custom_body(&provider, Capability::Chat, &canonical)
            .expect_err("body mappings must not receive credentials");
        assert!(matches!(err, GatewayError::BadRequest(_)));
        assert!(err.message().contains("cannot reference {{apiKey}}"));

        let openai = profile(Protocol::OpenAi, false);
        let request = apply_headers(
            reqwest::Client::new().post("https://example.com/v1/chat/completions"),
            &openai,
            Some("sk-host-only"),
        )
        .expect("header mapping is valid")
        .build()
        .expect("request builds");
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer sk-host-only")
        );

        let mut vendor = profile(Protocol::Custom, false);
        vendor.headers.push(super::super::providers::HeaderKv {
            name: "X-Goog-Api-Key".into(),
            value: "{{apiKey}}".into(),
        });
        let request = apply_headers(
            reqwest::Client::new().post("https://example.com/generate"),
            &vendor,
            Some("vendor-host-only"),
        )
        .expect("vendor header mapping")
        .build()
        .expect("request builds");
        assert_eq!(
            request
                .headers()
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("vendor-host-only")
        );
        assert!(
            request.headers().get(reqwest::header::AUTHORIZATION).is_none(),
            "a custom credential header must suppress default Bearer duplication"
        );
    }

    /// AI-405 decision table: which protocols may proxy `stream:true` SSE.
    /// OpenAI-dialect providers pass bytes through; anything the gateway
    /// would have to translate per-chunk is refused (streaming_unsupported).
    #[test]
    fn streamable_decision_follows_the_wire_dialect() {
        let base = |protocol: Protocol, specs: std::collections::HashMap<String, super::super::providers::CapabilitySpec>| ProviderProfile {
            id: "p".into(),
            name: "p".into(),
            category: None,
            tags: vec![],
            protocol,
            base_url: "https://example.com".into(),
            model: None,
            capabilities: vec![],
            headers: vec![],
            secret_ref: None,
            specs,
            allow_local: false,
            enabled: true,
        };
        // OpenAI dialect (openai / ollama / lmstudio presets) → streamable.
        assert!(protocol_streamable(&base(Protocol::OpenAi, Default::default())));
        // Anthropic needs per-chunk translation → refused.
        assert!(!protocol_streamable(&base(Protocol::Anthropic, Default::default())));
        // Custom with no chat mapping = OpenAI-shaped at a custom base → streamable.
        assert!(protocol_streamable(&base(Protocol::Custom, Default::default())));
        // Custom with ONLY a path override is still OpenAI-shaped.
        let mut path_only = std::collections::HashMap::new();
        path_only.insert(
            "chat".to_string(),
            super::super::providers::CapabilitySpec {
                path: Some("/api/chat".into()),
                request_template: None,
                response_path: None,
                websocket_path: None,
            },
        );
        assert!(protocol_streamable(&base(Protocol::Custom, path_only)));
        // A request template or response path ⇒ translated responses ⇒ refused.
        for (tpl, rp) in [(Some(r#"{"q":"{{prompt}}"}"#.to_string()), None), (None, Some("result.text".to_string()))] {
            let mut specs = std::collections::HashMap::new();
            specs.insert(
                "chat".to_string(),
                super::super::providers::CapabilitySpec {
                    path: None,
                    request_template: tpl,
                    response_path: rp,
                    websocket_path: None,
                },
            );
            assert!(!protocol_streamable(&base(Protocol::Custom, specs)));
        }
    }

    #[test]
    fn dot_path_walks_objects_and_arrays() {
        let v = serde_json::json!({ "choices": [{ "message": { "content": "x" } }] });
        assert_eq!(dot_path(&v, "choices.0.message.content").unwrap(), "x");
        assert!(dot_path(&v, "choices.9.message").is_none());
    }
}
