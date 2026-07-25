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
    if kind != "openai-compatible" {
        return Err(InvokeError::new(
            InvokeErrorCode::ActionUnavailable,
            format!("action '{action_id}' uses transport '{kind}', which service_action v1 cannot execute yet"),
        ));
    }
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
    if !path.starts_with("/v1/") || path.contains("..") || path.contains('?') || path.contains('#') {
        return Err(InvokeError::new(
            InvokeErrorCode::ActionUnavailable,
            format!("action '{action_id}' transport path is outside the /v1/* inference surface"),
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

/// Execute a resolved action: validate input → gateway transport → validate output.
/// `timeout_override_ms` (node data) wins over the action's declared timeout when set.
pub async fn invoke(
    http: &reqwest::Client,
    action: &ResolvedServiceAction,
    connection: &str,
    input: &Value,
    timeout_override_ms: Option<u64>,
) -> Result<Value, InvokeError> {
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
        let detail: String = String::from_utf8_lossy(&body).chars().take(MAX_ERROR_BODY_CHARS).collect();
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
}
