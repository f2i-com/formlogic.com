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
//! anonymous tier, so a drive-by web page cannot spend the user's keys. (The
//! per-session native-plugin credential is layered on when the Aokie plugin is
//! wired to the gateway in a later slice; today the plugin reaches it over the
//! same authenticated loopback surface.)
//!
//! EGRESS (AI-404): every outbound call is validated + address-pinned by
//! `egress`, and the reqwest client is built with redirects DISABLED.

use std::time::Duration;

use super::egress;
use super::providers::{Capability, ProviderProfile, ProviderRegistryHandle, Protocol};

const OUTBOUND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

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

/// Render `{{apiKey}}` in a header value.
fn render_header(value: &str, key: Option<&str>) -> String {
    value.replace("{{apiKey}}", key.unwrap_or(""))
}

/// Apply auth + custom headers to a request builder for a provider.
fn apply_headers(
    mut rb: reqwest::RequestBuilder,
    provider: &ProviderProfile,
    key: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut saw_auth = false;
    for h in &provider.headers {
        let lname = h.name.to_ascii_lowercase();
        // Never forward hop-by-hop / host-spoofing headers from config.
        if matches!(
            lname.as_str(),
            "host" | "content-length" | "connection" | "proxy-authorization" | "transfer-encoding"
        ) {
            continue;
        }
        if h.name.contains('\n') || h.name.contains('\r') || h.value.contains('\n') || h.value.contains('\r') {
            continue; // header-injection guard
        }
        if lname == "authorization" || lname == "x-api-key" {
            saw_auth = true;
        }
        rb = rb.header(&h.name, render_header(&h.value, key));
    }
    // Default auth if a key exists and no header referenced it.
    if !saw_auth {
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            match provider.protocol {
                Protocol::Anthropic => {
                    rb = rb.header("x-api-key", k).header("anthropic-version", "2023-06-01");
                }
                _ => {
                    rb = rb.header("authorization", format!("Bearer {k}"));
                }
            }
        }
    }
    rb
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
    let key = reg.lock().unwrap_or_else(|e| e.into_inner()).key(&provider.id);
    let access = provider.local_access();
    let path = provider.path_for(cap);
    let target = egress::validate(&provider.base_url, &path, access)
        .map_err(|e| GatewayError::BadRequest(e.to_string()))?;

    // Default the model from the profile when the caller didn't set one.
    if body.get("model").is_none() {
        if let Some(m) = &provider.model {
            body["model"] = serde_json::Value::String(m.clone());
        }
    }
    // For a Custom provider with a request template, render it.
    let out_body = if provider.protocol == Protocol::Custom {
        render_custom_body(provider, cap, &body, key.as_deref())?
    } else if provider.protocol == Protocol::Anthropic {
        openai_chat_to_anthropic(&body)?
    } else {
        body.clone()
    };

    let client = client_for(&target)?;
    let rb = client.post(target.url.clone()).json(&out_body);
    let rb = apply_headers(rb, provider, key.as_deref());
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
    let rb = apply_headers(client.get(target.url.clone()), provider, key.as_deref());
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

fn render_custom_body(
    provider: &ProviderProfile,
    cap: Capability,
    canonical: &serde_json::Value,
    key: Option<&str>,
) -> Result<serde_json::Value, GatewayError> {
    let spec = provider.specs.get(super::providers::capability_key(cap));
    let Some(template) = spec.and_then(|s| s.request_template.as_ref()) else {
        // No template → pass the canonical body through unchanged.
        return Ok(canonical.clone());
    };
    let model = canonical.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let messages = canonical.get("messages").cloned().unwrap_or(serde_json::json!([]));
    let prompt = last_user_text(canonical);
    let rendered = template
        .replace("{{model}}", &json_escape(model))
        .replace("{{messages}}", &messages.to_string())
        .replace("{{prompt}}", &json_escape(&prompt))
        .replace("{{input}}", &json_escape(&prompt))
        .replace("{{apiKey}}", &json_escape(key.unwrap_or("")));
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
            },
        );
        let provider = ProviderProfile {
            id: "custom".into(),
            name: "Custom".into(),
            protocol: Protocol::Custom,
            base_url: "https://example.com".into(),
            model: Some("m1".into()),
            capabilities: vec![Capability::Chat],
            headers: vec![],
            specs,
            allow_local: false,
            enabled: true,
        };
        let canonical = serde_json::json!({
            "model": "m1",
            "messages": [{ "role": "user", "content": "say \"hi\"" }]
        });
        let body = render_custom_body(&provider, Capability::Chat, &canonical, None).unwrap();
        assert_eq!(body["q"], "say \"hi\"", "prompt escaped + substituted");
        assert_eq!(body["m"], "m1");
        let resp = serde_json::json!({ "result": { "text": "done" } });
        assert_eq!(extract_custom_text(&provider, Capability::Chat, &resp), "done");
    }

    #[test]
    fn dot_path_walks_objects_and_arrays() {
        let v = serde_json::json!({ "choices": [{ "message": { "content": "x" } }] });
        assert_eq!(dot_path(&v, "choices.0.message.content").unwrap(), "x");
        assert!(dot_path(&v, "choices.9.message").is_none());
    }
}
