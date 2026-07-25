//! ServiceActionHost v1 (extensible-flows plan §7.5, slice 2).
//!
//! The ONE Desktop authority for resolving a ServiceDefinition action and executing it on
//! behalf of a flow node. The stored node carries only stable references (§7.3):
//! `definitionId` + `actionId` from the read-only v3 catalog and an opaque `connection`
//! (AI provider profile id) — never credentials, provider URLs, loopback ports, or process
//! details. v1 executable surface, refusing everything else with a typed §6.7 code
//! (never silently):
//!
//!   - transport `openai-compatible` with a `/v1/*` path, executed through the Desktop's
//!     own credential-holding provider gateway (loopback + internal gateway token — the
//!     gateway injects the provider credential, §7.5 step 7);
//!   - input validated against the action's declared `inputSchema`, output against
//!     `outputSchema`, both via the §6.5 JSON-Schema SUBSET validator below;
//!   - the action's declared `timeoutMs` (node data may override within bounds).
//!
//! Deferred (typed refusals until their slices land): managed-process-http and
//! plugin-command transports, streaming/cancellation, ArtifactRef outputs, binding slots,
//! digest pinning.

use serde_json::Value;
use std::time::Duration;

/// §6.7 error taxonomy subset used by v1. Stringified into FlowError messages as a
/// `code: detail` prefix (the runner's established pattern, e.g. `ai_default_unresolved`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvokeErrorCode {
    ServiceUnavailable,
    ActionUnavailable,
    InputInvalid,
    OutputInvalid,
    TransportFailed,
}

impl InvokeErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            InvokeErrorCode::ServiceUnavailable => "service_unavailable",
            InvokeErrorCode::ActionUnavailable => "action_unavailable",
            InvokeErrorCode::InputInvalid => "input_invalid",
            InvokeErrorCode::OutputInvalid => "output_invalid",
            InvokeErrorCode::TransportFailed => "transport_failed",
        }
    }
}

#[derive(Debug)]
pub struct InvokeError {
    pub code: InvokeErrorCode,
    pub message: String,
}

impl InvokeError {
    fn new(code: InvokeErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    /// `code: detail` — the message shape the flow runner surfaces.
    pub fn to_message(&self) -> String {
        format!("{}: {}", self.code.as_str(), self.message)
    }
}

/// A resolved, executable action — everything the transport needs, nothing the caller
/// must never see (no secrets; the gateway path is loopback-internal).
#[derive(Debug, Clone)]
pub struct ResolvedServiceAction {
    pub definition_id: String,
    pub definition_version: String,
    pub action_id: String,
    pub side_effects: String,
    pub timeout_ms: u64,
    pub input_schema: Value,
    pub output_schema: Value,
    method: reqwest::Method,
    path: String,
    transport: Transport,
}

/// Which lane executes an action. The distinction is not cosmetic: the two transports get their
/// base URL from completely different places, and that is the whole SSRF story.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    /// `/v1/*` through the credential-holding provider gateway. The connection selects a
    /// provider profile; the caller never supplies a URL.
    OpenAiCompatible,
    /// SRV-407: HTTP against a process the DESKTOP supervises. The definition supplies a method
    /// and a path; the host supplies scheme, host and port from the service it started. A
    /// definition therefore cannot aim a flow at an arbitrary address — it can only address the
    /// process it declared.
    ManagedProcessHttp { service_id: String },
}

impl ResolvedServiceAction {
    /// Does this action run against a process this Desktop supervises? The caller picks the lane
    /// from this rather than guessing from the definition id — the two transports resolve their
    /// base URL from completely different places, and mis-routing one would send its path to a
    /// different service entirely.
    pub fn is_managed_process(&self) -> bool {
        matches!(self.transport, Transport::ManagedProcessHttp { .. })
    }

    /// The supervised service this action addresses, when it has one.
    pub fn managed_service_id(&self) -> Option<&str> {
        match &self.transport {
            Transport::ManagedProcessHttp { service_id } => Some(service_id),
            Transport::OpenAiCompatible => None,
        }
    }
}

/// Resolve `definitionId`/`actionId` against the built-in v3 catalog and verify the
/// transport is one v1 can execute.
pub fn resolve_action(definition_id: &str, action_id: &str) -> Result<ResolvedServiceAction, InvokeError> {
    // SRV-401: built-ins AND definitions contributed by installed plugins resolve through the
    // one registry, so a contributed service executes by exactly the same path as a built-in.
    let definition = super::definitions::find(definition_id).ok_or_else(|| {
        InvokeError::new(
            InvokeErrorCode::ServiceUnavailable,
            format!("unknown service definition '{definition_id}' (not in the Desktop catalog)"),
        )
    })?;
    let definition = &definition;
    let action = definition["actions"]
        .as_array()
        .and_then(|actions| actions.iter().find(|a| a["id"].as_str() == Some(action_id)))
        .ok_or_else(|| {
            InvokeError::new(
                InvokeErrorCode::ActionUnavailable,
                format!("service '{definition_id}' has no action '{action_id}'"),
            )
        })?;

    let transport = &action["transport"];
    let kind = transport["kind"].as_str().unwrap_or("");
    let lane = match kind {
        "openai-compatible" => Transport::OpenAiCompatible,
        "managed-process-http" => {
            // The service id must name a process this Desktop supervises. It is validated by
            // SHAPE here and resolved to a live port at invocation — a definition can name a
            // service, never an address.
            let service_id = transport["serviceId"].as_str().unwrap_or("");
            if service_id.is_empty()
                || service_id.len() > 64
                || !service_id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
            {
                return Err(InvokeError::new(
                    InvokeErrorCode::ActionUnavailable,
                    format!("action '{action_id}' declares a managed-process transport without a valid serviceId"),
                ));
            }
            Transport::ManagedProcessHttp { service_id: service_id.to_string() }
        }
        _ => {
            return Err(InvokeError::new(
                InvokeErrorCode::ActionUnavailable,
                format!("action '{action_id}' uses transport '{kind}', which service_action v1 cannot execute yet"),
            ))
        }
    };
    let streaming_mode = action["streaming"]["mode"].as_str().unwrap_or("none");
    if streaming_mode == "events" {
        // WebSocket/event lanes (e.g. realtime) are not a request/response invocation.
        return Err(InvokeError::new(
            InvokeErrorCode::ActionUnavailable,
            format!("action '{action_id}' is an event-stream lane, not invocable as a flow node"),
        ));
    }
    let method = match transport["method"].as_str().unwrap_or("POST") {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => {
            return Err(InvokeError::new(
                InvokeErrorCode::ActionUnavailable,
                format!("action '{action_id}' transport method '{other}' is not supported"),
            ))
        }
    };
    let path = transport["path"].as_str().unwrap_or("");
    // Both lanes refuse traversal, query strings and fragments: the path is a fixed route the
    // definition declared, not a place to smuggle parameters or climb out of a namespace.
    let path_shape_ok = path.starts_with('/')
        && !path.contains("..")
        && !path.contains('?')
        && !path.contains('#')
        && !path.contains('\\')
        && !path.starts_with("//")
        && path.len() <= 512;
    let path_ok = match lane {
        // The gateway lane stays pinned to the inference surface it was built for.
        Transport::OpenAiCompatible => path_shape_ok && path.starts_with("/v1/"),
        // A managed process owns its whole route space — but only its own.
        Transport::ManagedProcessHttp { .. } => path_shape_ok,
    };
    if !path_ok {
        return Err(InvokeError::new(
            InvokeErrorCode::ActionUnavailable,
            match lane {
                Transport::OpenAiCompatible => {
                    format!("action '{action_id}' transport path is outside the /v1/* inference surface")
                }
                Transport::ManagedProcessHttp { .. } => {
                    format!("action '{action_id}' transport path must be a plain absolute route")
                }
            },
        ));
    }

    Ok(ResolvedServiceAction {
        definition_id: definition_id.to_string(),
        definition_version: definition["version"].as_str().unwrap_or("0.0.0").to_string(),
        action_id: action_id.to_string(),
        side_effects: action["sideEffects"].as_str().unwrap_or("none").to_string(),
        timeout_ms: action["timeoutMs"].as_u64().unwrap_or(120_000),
        input_schema: action["inputSchema"].clone(),
        output_schema: action["outputSchema"].clone(),
        method,
        path: path.to_string(),
        transport: lane,
    })
}

/// The provider-gateway endpoint for a connection + action path. The connection id uses
/// the SAME shape rules as the runner's `named_ai_provider_endpoint` (an opaque provider
/// profile id — lowercase letters, digits, dashes; optional `provider:` prefix). The
/// caller never supplies a URL; the loopback base is composed here.
pub fn provider_gateway_endpoint(connection: &str, path: &str) -> Result<String, InvokeError> {
    let provider = connection.trim().strip_prefix("provider:").unwrap_or(connection.trim());
    if provider.is_empty()
        || provider.len() > 64
        || !provider
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(InvokeError::new(
            InvokeErrorCode::InputInvalid,
            "connection must be an AI provider id (lowercase letters, digits, and dashes)",
        ));
    }
    Ok(format!(
        "http://127.0.0.1:{}/api/ai/providers/{provider}{path}",
        crate::COMPANION_PORT
    ))
}

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024; // matches the AI relay frame cap
const MAX_ERROR_BODY_CHARS: usize = 600;

/// A managed process may legitimately return a large binary (a generated image). It never
/// travels in-band — it becomes an ArtifactRef — but it still needs a ceiling.
const MAX_ARTIFACT_RESPONSE_BYTES: usize = super::artifacts::MAX_BYTES;

/// SRV-407: the loopback endpoint of a process THIS Desktop supervises.
///
/// The scheme and host are hardcoded and the port comes from the registry entry for the service
/// the definition named. Nothing a package or definition author writes contributes a host, so
/// there is no input that could aim this at an internal address, a metadata endpoint, or the
/// wider network — the SSRF surface is closed by construction rather than by a blocklist.
///
/// A service that is not RUNNING refuses. It is deliberately never auto-started: if the owner
/// stopped it, a flow silently restarting it would override a decision they made on purpose.
pub fn managed_service_endpoint(
    registry: &super::registry::RegistryHandle,
    service_id: &str,
    path: &str,
) -> Result<String, InvokeError> {
    let guard = registry.lock().map_err(|_| {
        InvokeError::new(InvokeErrorCode::ServiceUnavailable, "the service registry is unavailable")
    })?;
    if !guard.service_running(service_id) {
        return Err(InvokeError::new(
            InvokeErrorCode::ServiceUnavailable,
            format!("the '{service_id}' service is not running — start it in Services, then run this again"),
        ));
    }
    let port = guard.service_port(service_id).ok_or_else(|| {
        InvokeError::new(
            InvokeErrorCode::ServiceUnavailable,
            format!("the '{service_id}' service has no bound port"),
        )
    })?;
    Ok(format!("http://127.0.0.1:{port}{path}"))
}

/// Strip anything that looks like a credential out of an error detail before it travels.
///
/// A managed process's error body is written by third-party code and can echo back the request —
/// including a header or token it was given. That detail ends up in a flow run log, which is read
/// by people debugging unrelated things, so it is redacted rather than trusted to be harmless.
fn redact(detail: &str) -> String {
    let mut out = String::with_capacity(detail.len());
    for token in detail.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let looks_secret = trimmed.len() >= 16
            && (trimmed.starts_with("sk-")
                || trimmed.starts_with("Bearer")
                || trimmed.starts_with("flk_")
                || trimmed.starts_with("eyJ")
                || (trimmed.len() >= 32
                    && trimmed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')));
        if looks_secret {
            out.push_str("[redacted]");
            out.push_str(&token[trimmed.len()..]);
        } else {
            out.push_str(token);
        }
    }
    out.chars().take(MAX_ERROR_BODY_CHARS).collect()
}

/// Execute a resolved action on the MANAGED-PROCESS lane: validate input → loopback HTTP to the
/// supervised process → typed output.
///
/// A JSON response is validated against the action's declared output schema, exactly like the
/// gateway lane. A NON-JSON response (an image, an audio file) becomes an ArtifactRef stored on
/// this device — large binary data never travels in-band, so it cannot end up inside a flow
/// revision or a run log.
pub async fn invoke_managed(
    http: &reqwest::Client,
    registry: &super::registry::RegistryHandle,
    action: &ResolvedServiceAction,
    input: &Value,
    timeout_override_ms: Option<u64>,
    device_id: &str,
) -> Result<Value, InvokeError> {
    let Transport::ManagedProcessHttp { service_id } = &action.transport else {
        return Err(InvokeError::new(
            InvokeErrorCode::ActionUnavailable,
            "this action does not use the managed-process transport",
        ));
    };
    if let Err(detail) = schema_subset::validate(&action.input_schema, input) {
        return Err(InvokeError::new(InvokeErrorCode::InputInvalid, detail));
    }
    let endpoint = managed_service_endpoint(registry, service_id, &action.path)?;
    let timeout = Duration::from_millis(timeout_override_ms.unwrap_or(action.timeout_ms).clamp(100, 600_000));

    let mut request = http.request(action.method.clone(), &endpoint).timeout(timeout);
    if action.method == reqwest::Method::POST {
        request = request.json(input);
    }
    let response = request.send().await.map_err(|e| {
        InvokeError::new(
            InvokeErrorCode::TransportFailed,
            format!("the '{service_id}' service did not respond: {}", redact(&e.to_string())),
        )
    })?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = response.bytes().await.map_err(|e| {
        InvokeError::new(
            InvokeErrorCode::TransportFailed,
            format!("reading the '{service_id}' response failed: {}", redact(&e.to_string())),
        )
    })?;

    if !status.is_success() {
        let detail = redact(&String::from_utf8_lossy(&body));
        return Err(InvokeError::new(
            InvokeErrorCode::TransportFailed,
            format!("the '{service_id}' service returned {status}: {detail}"),
        ));
    }

    let is_json = content_type.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json");
    if is_json {
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(InvokeError::new(
                InvokeErrorCode::TransportFailed,
                format!("response exceeds the {MAX_RESPONSE_BYTES}-byte cap"),
            ));
        }
        let output: Value = serde_json::from_slice(&body).map_err(|_| {
            InvokeError::new(InvokeErrorCode::OutputInvalid, "the service response is not valid JSON")
        })?;
        if let Err(detail) = schema_subset::validate(&action.output_schema, &output) {
            return Err(InvokeError::new(InvokeErrorCode::OutputInvalid, detail));
        }
        return Ok(output);
    }

    if body.len() > MAX_ARTIFACT_RESPONSE_BYTES {
        return Err(InvokeError::new(
            InvokeErrorCode::TransportFailed,
            format!("binary response exceeds the {MAX_ARTIFACT_RESPONSE_BYTES}-byte artifact cap"),
        ));
    }
    super::artifacts::store(&body, &content_type, device_id)
        .map_err(|detail| InvokeError::new(InvokeErrorCode::OutputInvalid, detail))
}

/// Execute a resolved action: validate input → gateway transport → validate output.
/// `timeout_override_ms` (node data) wins over the action's declared timeout when set.
pub async fn invoke(
    http: &reqwest::Client,
    action: &ResolvedServiceAction,
    connection: &str,
    input: &Value,
    timeout_override_ms: Option<u64>,
) -> Result<Value, InvokeError> {
    if action.transport != Transport::OpenAiCompatible {
        // Sending a managed-process action down the gateway lane would resolve its path against
        // a provider profile — a different service entirely. Refuse rather than mis-route.
        return Err(InvokeError::new(
            InvokeErrorCode::ActionUnavailable,
            "this action uses the managed-process transport and must be invoked on that lane",
        ));
    }
    if let Err(detail) = schema_subset::validate(&action.input_schema, input) {
        return Err(InvokeError::new(InvokeErrorCode::InputInvalid, detail));
    }
    let endpoint = provider_gateway_endpoint(connection, &action.path)?;
    let timeout = Duration::from_millis(timeout_override_ms.unwrap_or(action.timeout_ms).clamp(100, 600_000));

    let token = crate::ai::gateway_token::token().ok_or_else(|| {
        InvokeError::new(
            InvokeErrorCode::ServiceUnavailable,
            "the internal AI gateway credential is unavailable",
        )
    })?;
    let mut request = http.request(action.method.clone(), &endpoint).timeout(timeout).bearer_auth(token);
    if action.method == reqwest::Method::POST {
        request = request.json(input);
    }
    let response = request
        .send()
        .await
        .map_err(|e| InvokeError::new(InvokeErrorCode::TransportFailed, format!("gateway unreachable: {e}")))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|e| InvokeError::new(InvokeErrorCode::TransportFailed, format!("gateway read failed: {e}")))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(InvokeError::new(
            InvokeErrorCode::TransportFailed,
            format!("response exceeds the {MAX_RESPONSE_BYTES}-byte cap"),
        ));
    }
    if !status.is_success() {
        let detail = redact(&String::from_utf8_lossy(&body));
        return Err(InvokeError::new(
            InvokeErrorCode::TransportFailed,
            format!("provider gateway returned {status}: {detail}"),
        ));
    }
    let output: Value = serde_json::from_slice(&body).map_err(|_| {
        InvokeError::new(InvokeErrorCode::OutputInvalid, "provider response is not valid JSON")
    })?;
    if let Err(detail) = schema_subset::validate(&action.output_schema, &output) {
        return Err(InvokeError::new(InvokeErrorCode::OutputInvalid, detail));
    }
    Ok(output)
}

/// §6.5 JSON-Schema SUBSET validator: type (incl. nullable unions), properties, required,
/// additionalProperties (false | schema), items, enum, const, minLength/maxLength,
/// minimum/maximum. Unknown/annotation keywords (title, description, default, format,
/// $schema, …) are deliberately ignored; recursion is depth-capped. This is the runtime
/// authority the plan's cross-language fixture suite will pin — keep the keyword set in
/// lock-step with the plan when extending it.
pub mod schema_subset {
    use serde_json::Value;

    const MAX_DEPTH: usize = 32;

    pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
        walk(schema, value, "$", 0)
    }

    fn type_name(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(n) => {
                if n.is_i64() || n.is_u64() {
                    "integer"
                } else {
                    "number"
                }
            }
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    fn matches_type(expected: &str, value: &Value) -> bool {
        match expected {
            // Every integer is a number; "integer" additionally requires no fraction.
            "number" => matches!(value, Value::Number(_)),
            "integer" => matches!(value, Value::Number(n) if n.is_i64() || n.is_u64()),
            other => type_name(value) == other,
        }
    }

    fn walk(schema: &Value, value: &Value, path: &str, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(format!("{path}: schema nesting exceeds the depth limit"));
        }
        let Some(schema) = schema.as_object() else {
            return Ok(()); // absent/non-object schema = unconstrained (annotation-only)
        };

        if let Some(expected) = schema.get("type") {
            let ok = match expected {
                Value::String(t) => matches_type(t, value),
                Value::Array(types) => types
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|t| matches_type(t, value)),
                _ => true,
            };
            if !ok {
                return Err(format!(
                    "{path}: expected {}, got {}",
                    expected_label(expected),
                    type_name(value)
                ));
            }
        }
        if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
            if !allowed.iter().any(|candidate| candidate == value) {
                return Err(format!("{path}: value is not one of the allowed enum values"));
            }
        }
        if let Some(expected) = schema.get("const") {
            if expected != value {
                return Err(format!("{path}: value does not equal the required const"));
            }
        }
        if let Value::String(s) = value {
            if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
                if (s.chars().count() as u64) < min {
                    return Err(format!("{path}: shorter than minLength {min}"));
                }
            }
            if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
                if (s.chars().count() as u64) > max {
                    return Err(format!("{path}: longer than maxLength {max}"));
                }
            }
        }
        if let Value::Number(n) = value {
            if let (Some(min), Some(v)) = (schema.get("minimum").and_then(Value::as_f64), n.as_f64()) {
                if v < min {
                    return Err(format!("{path}: below minimum {min}"));
                }
            }
            if let (Some(max), Some(v)) = (schema.get("maximum").and_then(Value::as_f64), n.as_f64()) {
                if v > max {
                    return Err(format!("{path}: above maximum {max}"));
                }
            }
        }
        if let Value::Array(items) = value {
            if let Some(item_schema) = schema.get("items") {
                for (i, item) in items.iter().enumerate() {
                    walk(item_schema, item, &format!("{path}[{i}]"), depth + 1)?;
                }
            }
        }
        if let Value::Object(map) = value {
            let properties = schema.get("properties").and_then(Value::as_object);
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for name in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(name) {
                        return Err(format!("{path}: missing required property '{name}'"));
                    }
                }
            }
            if let Some(properties) = properties {
                for (name, prop_schema) in properties {
                    if let Some(prop_value) = map.get(name) {
                        walk(prop_schema, prop_value, &format!("{path}.{name}"), depth + 1)?;
                    }
                }
            }
            match schema.get("additionalProperties") {
                Some(Value::Bool(false)) => {
                    for name in map.keys() {
                        if !properties.map(|p| p.contains_key(name)).unwrap_or(false) {
                            return Err(format!("{path}: unexpected property '{name}'"));
                        }
                    }
                }
                Some(extra_schema @ Value::Object(_)) => {
                    for (name, prop_value) in map {
                        if !properties.map(|p| p.contains_key(name)).unwrap_or(false) {
                            walk(extra_schema, prop_value, &format!("{path}.{name}"), depth + 1)?;
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn expected_label(expected: &Value) -> String {
        match expected {
            Value::String(t) => t.clone(),
            Value::Array(types) => types
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" | "),
            _ => "value".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_chat_complete_from_the_builtin_catalog() {
        let action = resolve_action("openai-api", "chat.complete").expect("resolves");
        assert_eq!(action.definition_id, "openai-api");
        assert_eq!(action.definition_version, "1.2.0");
        assert_eq!(action.path, "/v1/chat/completions");
        assert_eq!(action.side_effects, "none");
        assert_eq!(action.timeout_ms, 120_000);
    }

    #[test]
    fn unknown_definition_and_action_get_typed_codes() {
        let err = resolve_action("nope", "chat.complete").unwrap_err();
        assert_eq!(err.code, InvokeErrorCode::ServiceUnavailable);
        let err = resolve_action("openai-api", "nope").unwrap_err();
        assert_eq!(err.code, InvokeErrorCode::ActionUnavailable);
    }

    #[test]
    fn event_stream_lanes_are_not_invocable() {
        // realtime.stream.connect is an events lane restricted to the Aokie plugin —
        // it must never become a generic flow node (plan §16.3).
        let err = resolve_action("openai-api", "realtime.stream.connect").unwrap_err();
        assert_eq!(err.code, InvokeErrorCode::ActionUnavailable);
        assert!(err.message.contains("event-stream"));
        let err = resolve_action("openai-api", "realtime.session.create").unwrap_err();
        assert_eq!(err.code, InvokeErrorCode::ActionUnavailable);
    }

    #[test]
    fn gateway_endpoint_validates_connection_and_never_accepts_urls() {
        assert_eq!(
            provider_gateway_endpoint("provider:openai-platform", "/v1/chat/completions").unwrap(),
            format!(
                "http://127.0.0.1:{}/api/ai/providers/openai-platform/v1/chat/completions",
                crate::COMPANION_PORT
            )
        );
        for invalid in ["", "Provider:openai", "https://example.com", "../x", "open_ai"] {
            assert!(provider_gateway_endpoint(invalid, "/v1/models").is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn schema_subset_validates_the_documented_keyword_set() {
        let schema = json!({
            "type": "object",
            "required": ["messages"],
            "additionalProperties": false,
            "properties": {
                "model": { "type": "string", "minLength": 1 },
                "messages": { "type": "array", "items": { "type": "object" } },
                "temperature": { "type": "number", "minimum": 0, "maximum": 2 },
                "mode": { "enum": ["fast", "slow"] },
                "count": { "type": ["integer", "null"] }
            }
        });
        let ok = json!({ "messages": [{ "role": "user" }], "model": "m", "temperature": 1.5, "mode": "fast", "count": null });
        assert!(schema_subset::validate(&schema, &ok).is_ok());

        let cases: Vec<(Value, &str)> = vec![
            (json!({}), "missing required"),
            (json!({ "messages": "not-array" }), "expected array"),
            (json!({ "messages": [], "model": "" }), "minLength"),
            (json!({ "messages": [], "temperature": 3 }), "maximum"),
            (json!({ "messages": [], "mode": "warp" }), "enum"),
            (json!({ "messages": [], "count": 1.5 }), "expected integer | null"),
            (json!({ "messages": [], "extra": 1 }), "unexpected property"),
            (json!({ "messages": ["str"] }), "expected object"),
        ];
        for (value, needle) in cases {
            let err = schema_subset::validate(&schema, &value).unwrap_err();
            assert!(err.contains(needle), "value {value} → '{err}' (wanted '{needle}')");
        }

        // Integers satisfy "number"; annotation keywords and absent schemas are unconstrained.
        assert!(schema_subset::validate(&json!({ "type": "number" }), &json!(3)).is_ok());
        assert!(schema_subset::validate(&json!({ "description": "x" }), &json!("anything")).is_ok());
        assert!(schema_subset::validate(&Value::Null, &json!({ "a": 1 })).is_ok());
    }
    // -- SRV-407: managed-process-http ------------------------------------------------------

    /// A v3 definition whose action addresses a process the Desktop supervises.
    ///
    /// The contributed-definition registry is process-GLOBAL, so each test owns a distinct
    /// plugin id — otherwise one test's cleanup removes another's registration mid-run, and the
    /// suite fails only under parallel load.
    fn managed_definition(plugin: &str, service_id: &str, path: &str) -> serde_json::Value {
        json!({
            "schemaVersion": 3,
            "id": format!("{plugin}.images"),
            "name": "SRV-407 Demo Images",
            "version": "1.0.0",
            "actions": [{
                "id": "render",
                "title": "Render an image",
                "sideEffects": "none",
                "timeoutMs": 5000,
                "transport": { "kind": "managed-process-http", "serviceId": service_id, "method": "POST", "path": path },
                "inputSchema": {
                    "type": "object",
                    "properties": { "prompt": { "type": "string", "minLength": 1 } },
                    "required": ["prompt"]
                },
                "outputSchema": { "type": "object" }
            }]
        })
    }

    fn with_managed_definition<T>(plugin: &str, definition: serde_json::Value, body: impl FnOnce() -> T) -> T {
        // Hold the SHARED registry lock: definitions::tests can reset the whole global map, and
        // without this the failure only shows up under parallel load.
        let _guard = super::super::definitions::test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        super::super::definitions::reconcile_plugin(plugin, vec![definition]);
        let out = body();
        super::super::definitions::remove_plugin(plugin);
        out
    }

    #[test]
    fn a_managed_action_resolves_onto_its_own_lane() {
        let plugin = "srv407lane";
        with_managed_definition(plugin, managed_definition(plugin, "demo-imaging", "/render"), || {
            let action = resolve_action("srv407lane.images", "render").expect("resolves");
            assert!(action.is_managed_process());
            assert_eq!(action.managed_service_id(), Some("demo-imaging"));
            // A managed process owns its whole route space, so /v1/* is not required here.
            assert_eq!(action.path, "/render");
        });
    }

    #[test]
    fn a_managed_transport_without_a_valid_service_id_is_refused() {
        let plugin = "srv407sid";
        for bad in ["", "Not A Service", "../../etc", &"x".repeat(65)] {
            let mut definition = managed_definition(plugin, "demo-imaging", "/render");
            definition["actions"][0]["transport"]["serviceId"] = json!(bad);
            with_managed_definition(plugin, definition, || {
                let err = resolve_action("srv407sid.images", "render").unwrap_err();
                assert_eq!(err.code, InvokeErrorCode::ActionUnavailable);
                assert!(err.message.contains("serviceId"), "'{bad}' must be refused by shape");
            });
        }
    }

    #[test]
    fn a_managed_path_cannot_traverse_smuggle_or_change_host() {
        // The path is a fixed route the definition declared. Traversal, a query string, a
        // fragment, a protocol-relative prefix and a backslash are all ways to make a declared
        // route address something else, and each is refused.
        for hostile in ["../admin", "/render?token=x", "/render#frag", "//evil.test/render", "/a\\b", "render"] {
            let definition = managed_definition("srv407path", "demo-imaging", hostile);
            with_managed_definition("srv407path", definition, || {
                let err = resolve_action("srv407path.images", "render").unwrap_err();
                assert_eq!(err.code, InvokeErrorCode::ActionUnavailable, "'{hostile}' must be refused");
            });
        }
    }

    #[test]
    fn a_managed_action_cannot_be_sent_down_the_gateway_lane() {
        // Mis-routing would resolve the path against a provider profile — a different service
        // entirely — so the gateway lane refuses rather than sending it.
        let plugin = "srv407route";
        with_managed_definition(plugin, managed_definition(plugin, "demo-imaging", "/render"), || {
            let action = resolve_action("srv407route.images", "render").expect("resolves");
            let client = reqwest::Client::new();
            let outcome = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(invoke(&client, &action, "openai", &json!({ "prompt": "hi" }), None));
            let err = outcome.unwrap_err();
            assert_eq!(err.code, InvokeErrorCode::ActionUnavailable);
            assert!(err.message.contains("managed-process"));
        });
    }

    #[test]
    fn a_stopped_service_refuses_rather_than_being_auto_started() {
        // The acceptance criterion: a manual stop is RESPECTED. A flow silently restarting a
        // service the owner stopped would override a decision they made on purpose.
        let registry: super::super::registry::RegistryHandle = std::sync::Arc::new(std::sync::Mutex::new(
            super::super::registry::Registry::empty(
                std::env::temp_dir().join("srv407-empty"),
                std::env::temp_dir().join("srv407-empty-models"),
            ),
        ));
        let err = managed_service_endpoint(&registry, "demo-imaging", "/render").unwrap_err();
        assert_eq!(err.code, InvokeErrorCode::ServiceUnavailable);
        assert!(err.message.contains("not running"), "the refusal names the fix: start it");
    }

    #[test]
    fn the_endpoint_is_composed_by_the_host_not_the_definition() {
        // The whole SSRF story: scheme and host are hardcoded and the port comes from the
        // registry entry for the service. No definition field contributes an address.
        let endpoint = format!("http://127.0.0.1:{}{}", 51234, "/render");
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        assert!(!endpoint.contains("evil"));
    }

    #[test]
    fn error_details_are_redacted_before_they_travel() {
        // A managed process's error body is third-party text that can echo back what it was
        // given. It lands in a flow run log, so anything credential-shaped is stripped.
        let redacted = redact("upstream rejected key sk-abcdefghijklmnopqrstuvwxyz012345 for tenant 7");
        assert!(!redacted.contains("sk-abcdefghijklmnopqrstuvwxyz012345"));
        assert!(redacted.contains("[redacted]"));
        assert!(redacted.contains("upstream rejected key"), "the useful part of the message survives");

        let jwt = redact("Authorization failed: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.body.sig");
        assert!(!jwt.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));

        // Ordinary prose is untouched — over-redaction that eats the message is its own failure.
        let plain = redact("the render queue is full, try again shortly");
        assert_eq!(plain, "the render queue is full, try again shortly");
    }

    #[test]
    fn a_long_error_body_cannot_flood_a_run_log() {
        let flood = "x ".repeat(10_000);
        assert!(redact(&flood).chars().count() <= MAX_ERROR_BODY_CHARS);
    }
}
