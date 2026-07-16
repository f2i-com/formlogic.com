//! Connector gateway — `POST /api/connectors/{id}/request` and friends.
//!
//! This is the path FormLogic Web uses to reach plugin hardware/services.
//! The check order is CONTRACTUAL (`docs/DESKTOP_PLUGIN_SDK.md` §4):
//!
//!   1. valid pairing token bound to the calling origin — enforced by the
//!      HTTP auth guard BEFORE this module runs (`auth_required` /
//!      `origin_denied`);
//!   2. connector exists (`connector_missing`) and its plugin is running
//!      (`connector_unavailable`);
//!   3. command declared in the manifest + covered by its capabilities
//!      (`capability_denied`);
//!   4. forwarded to the plugin as the `connector.request` JSON-RPC call;
//!      plugin errors surface as `command_failed` or the plugin's own typed
//!      code (carried in `error.data`).
//!
//! Requests/responses follow `connector-request/response.schema.json`; the
//! error codes are the exact set FormLogic's `ConnectorError` parses.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;

use crate::plugins::manifest::{is_valid_command_name, is_valid_plugin_id};
use crate::plugins::registry::{HealthReport, PluginHost, PluginState};
use crate::plugins::rpc::RpcFailure;
use crate::plugins::runner::failure_text;

/// Default per-request deadline when the caller sends no `timeoutMs`.
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MIN_TIMEOUT_MS: u64 = 100;
pub const MAX_TIMEOUT_MS: u64 = 120_000;

/// The typed error codes of `connector-response.schema.json`.
pub const VALID_ERROR_CODES: [&str; 9] = [
    "origin_denied",
    "capability_denied",
    "connector_missing",
    "connector_unavailable",
    "command_failed",
    "stale_call",
    "stale_turn",
    "ipc_unavailable",
    "auth_required",
];

/// Body of `POST /api/connectors/{connectorId}/request`
/// (`connector-request.schema.json`). `connectorId` is required by the schema
/// but redundant with the URL — we accept its absence and fill it from the
/// path; a MISMATCH is an error.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorRequestBody {
    #[serde(default)]
    pub connector_id: Option<String>,
    pub command: String,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub request_id: Option<String>,
    /// PLG-205 (additive, non-breaking): the app this request is on behalf of.
    /// Absent on today's relay/direct-command paths → binding enforcement is a
    /// no-op, so the live connector keeps working with zero bindings. Present →
    /// dispatch verifies it matches the connector's active AppBinding.
    #[serde(default)]
    pub app_id: Option<String>,
    /// PLG-205: the binding epoch the caller believes is current; a stale epoch
    /// fails closed.
    #[serde(default)]
    pub binding_epoch: Option<u64>,
}

/// Build a bounded request id from an operation namespace and stable execution
/// identity. Length-prefixing the parts avoids ambiguous concatenations while
/// hashing keeps caller text, phone numbers, and server ids out of logs/wire
/// metadata. Callers must pass the same parts when retrying the same effect.
pub fn stable_request_id(namespace: &str, parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(namespace.len().to_be_bytes());
    digest.update(namespace.as_bytes());
    for part in parts {
        digest.update(part.len().to_be_bytes());
        digest.update(part.as_bytes());
    }
    let hex = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("fl-{namespace}-{hex}")
}

/// Aokie commands that can cause an observable phone/radio effect. The plugin
/// durably journals this exact surface and refuses calls without requestId.
/// Keeping the host aware of the contract lets every flow/relay caller derive
/// a stable id before dispatch instead of learning through a runtime failure.
pub fn aokie_command_requires_request_id(command: &str) -> bool {
    matches!(
        command,
        "phone.startPairing"
            | "phone.stopPairing"
            | "phone.removePaired"
            | "phone.disconnect"
            | "phone.connect"
            | "phone.confirmPairing"
            | "call.activate"
            | "call.answer"
            | "call.reject"
            | "call.hangup"
            | "call.operatorSpeak"
            | "call.configureAgent"
            | "call.dial"
            | "sms.send"
    )
}

/// A typed gateway failure — becomes the `{ok:false, error:{code,message}}`
/// envelope (plus HTTP status) in the HTTP layer.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectorFailure {
    pub code: &'static str,
    pub message: String,
}

impl ConnectorFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// One row of `GET /api/connectors`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInfo {
    pub id: String,
    pub name: String,
    pub plugin_id: String,
    pub commands: Vec<String>,
    /// True when its plugin is `running` (requests will be forwarded).
    pub available: bool,
    pub plugin_state: PluginState,
}

/// `GET /api/connectors/{id}/status`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub connector_id: String,
    pub plugin_id: String,
    pub plugin_state: PluginState,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_health: Option<HealthReport>,
}

/// Schema-level validation of the request body (patterns + ranges), with the
/// URL's connector id as the authority. Pure, so it's unit-testable.
pub fn validate_request_body(
    path_connector_id: &str,
    body: &ConnectorRequestBody,
) -> Result<(), String> {
    if !is_valid_plugin_id(path_connector_id) {
        return Err(format!("connectorId {path_connector_id:?} is malformed"));
    }
    if let Some(b) = &body.connector_id {
        if b != path_connector_id {
            return Err(format!(
                "body connectorId {b:?} does not match the URL connector {path_connector_id:?}"
            ));
        }
    }
    if !is_valid_command_name(&body.command) {
        return Err(format!(
            "command {:?} is malformed (want dot-namespaced like \"call.answer\")",
            body.command
        ));
    }
    if let Some(t) = body.timeout_ms {
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&t) {
            return Err(format!(
                "timeoutMs {t} is out of range ({MIN_TIMEOUT_MS}-{MAX_TIMEOUT_MS})"
            ));
        }
    }
    if let Some(r) = &body.request_id {
        if r.is_empty() || r.len() > 128 {
            return Err("requestId must be 1-128 chars".into());
        }
    }
    // Aokie's physical commands keep durable receipts keyed by requestId.
    // Refuse unsafe callers here, before the request reaches the plugin.
    if path_connector_id == "aokie"
        && aokie_command_requires_request_id(&body.command)
        && body.request_id.is_none()
    {
        return Err(format!(
            "aokie {} requires requestId for durable idempotency",
            body.command
        ));
    }
    Ok(())
}

/// Which plugin (if any) exposes `connector_id`, plus what the gateway needs
/// to talk to it. Snapshot under one short lock.
struct Target {
    plugin_id: String,
    state: PluginState,
    client: Option<Arc<crate::plugins::rpc::RpcClient>>,
    manifest: crate::plugins::manifest::PluginManifest,
}

fn find_target(host: &PluginHost, connector_id: &str) -> Option<Target> {
    let map = host.lock_plugins();
    for (pid, slot) in map.iter() {
        if let Some(m) = &slot.manifest {
            if m.connector(connector_id).is_some() {
                return Some(Target {
                    plugin_id: pid.clone(),
                    state: slot.state,
                    client: slot.running.as_ref().map(|r| r.client.clone()),
                    manifest: m.clone(),
                });
            }
        }
    }
    None
}

/// The gateway: contract checks 2-4 (auth is upstream), then forward.
/// Returns the success body per `connector-response.schema.json`.
pub async fn dispatch(
    host: &Arc<PluginHost>,
    connector_id: &str,
    body: &ConnectorRequestBody,
) -> Result<Value, ConnectorFailure> {
    validate_request_body(connector_id, body)
        .map_err(|m| ConnectorFailure::new("command_failed", m))?;

    let target = find_target(host, connector_id).ok_or_else(|| {
        ConnectorFailure::new(
            "connector_missing",
            format!("no plugin exposes connector {connector_id:?}"),
        )
    })?;

    // Capability check BEFORE availability? No — contract order is
    // running-ness (2) then capability (3), so a stopped plugin reads as
    // `connector_unavailable` even for undeclared commands.
    if target.state != PluginState::Running {
        return Err(ConnectorFailure::new(
            "connector_unavailable",
            format!(
                "plugin {:?} is {} — start it to use this connector",
                target.plugin_id,
                serde_json::to_value(target.state)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default()
            ),
        ));
    }
    let client = target.client.ok_or_else(|| {
        ConnectorFailure::new(
            "connector_unavailable",
            format!("plugin {:?} has no live process", target.plugin_id),
        )
    })?;

    if let Err(m) = target.manifest.command_allowed(connector_id, &body.command) {
        return Err(ConnectorFailure::new("capability_denied", m));
    }

    // PLG-205: consult the AppBinding (non-breaking). A request with NO app_id
    // (relay + direct-command paths) is always allowed; a request that names an
    // app must match the connector's active binding + epoch.
    if let Some(app_id) = &body.app_id {
        let check = host
            .bindings()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_dispatch(
                &target.plugin_id,
                connector_id,
                Some((app_id.as_str(), body.binding_epoch)),
            );
        if let Err(m) = check {
            return Err(ConnectorFailure::new("bound_elsewhere", m));
        }
    }

    let timeout_ms = body
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // Rebuild the params instead of forwarding the raw body: guarantees the
    // plugin sees exactly the schema shape with the URL-authoritative id.
    let mut params = json!({
        "connectorId": connector_id,
        "command": body.command,
        "timeoutMs": timeout_ms,
    });
    if let Some(p) = &body.payload {
        params["payload"] = p.clone();
    }
    if let Some(r) = &body.request_id {
        params["requestId"] = json!(r);
    }

    match client
        .request(
            "connector.request",
            params,
            Duration::from_millis(timeout_ms),
        )
        .await
    {
        Ok(result) => {
            // The JSON-RPC result IS the success body ({ok:true, data?}).
            // Anything else from the plugin is a protocol bug → command_failed.
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                let mut out = result;
                if let (Some(rid), Some(obj)) = (&body.request_id, out.as_object_mut()) {
                    obj.entry("requestId").or_insert_with(|| json!(rid));
                }
                Ok(out)
            } else {
                Err(ConnectorFailure::new(
                    "command_failed",
                    "plugin returned a malformed connector response (missing ok:true)",
                ))
            }
        }
        Err(RpcFailure::Remote(e)) => {
            // Typed connector code travels in error.data = {code, message}.
            let code = e
                .data
                .as_ref()
                .and_then(|d| d.get("code"))
                .and_then(Value::as_str)
                .and_then(|c| VALID_ERROR_CODES.iter().find(|k| **k == c).copied())
                .unwrap_or("command_failed");
            let message = e
                .data
                .as_ref()
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| e.message.clone());
            Err(ConnectorFailure { code, message })
        }
        Err(f @ RpcFailure::Timeout(_)) => Err(ConnectorFailure::new(
            "command_failed",
            format!("connector request timed out: {}", failure_text(&f)),
        )),
        Err(RpcFailure::Closed) => Err(ConnectorFailure::new(
            "connector_unavailable",
            "plugin connection closed mid-request",
        )),
    }
}

/// `GET /api/connectors` — every connector declared by a known plugin, with
/// availability (only `running` plugins accept requests).
pub fn list(host: &PluginHost) -> Vec<ConnectorInfo> {
    let map = host.lock_plugins();
    let mut out = Vec::new();
    for (pid, slot) in map.iter() {
        let Some(m) = &slot.manifest else { continue };
        for c in &m.connectors {
            out.push(ConnectorInfo {
                id: c.id.clone(),
                name: c.name.clone(),
                plugin_id: pid.clone(),
                commands: c.commands.clone(),
                available: slot.state == PluginState::Running,
                plugin_state: slot.state,
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// `GET /api/connectors/{id}/status`.
pub fn status(host: &PluginHost, connector_id: &str) -> Result<ConnectorStatus, ConnectorFailure> {
    let map = host.lock_plugins();
    for (pid, slot) in map.iter() {
        if let Some(m) = &slot.manifest {
            if m.connector(connector_id).is_some() {
                return Ok(ConnectorStatus {
                    connector_id: connector_id.to_string(),
                    plugin_id: pid.clone(),
                    plugin_state: slot.state,
                    available: slot.state == PluginState::Running,
                    last_health: slot.last_health.clone(),
                });
            }
        }
    }
    Err(ConnectorFailure::new(
        "connector_missing",
        format!("no plugin exposes connector {connector_id:?}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(json: &str) -> ConnectorRequestBody {
        serde_json::from_str(json).expect("body parses")
    }

    /// Audit CROSS-COMPAT-001: this repo's Aokie artifacts are locked to the
    /// SHARED contract fixture (byte-identical copy in the aokie repo, locked
    /// there against contract.rs). A unilateral contract change fails one
    /// repo's CI until the fixture is updated in a coordinated PR set.
    #[test]
    fn cross_repo_contract_fixture_matches_bundled_artifacts() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../docs/contracts/aokie-connector-contract.v1.json"
        ))
        .expect("contract fixture parses");
        let bundled: serde_json::Value = serde_json::from_str(include_str!(
            "../resources/plugins/aokie/manifest.json"
        ))
        .expect("bundled aokie manifest parses");

        assert_eq!(
            fixture["events"], bundled["events"],
            "bundled aokie manifest events drifted from the contract fixture"
        );
        assert_eq!(
            fixture["commands"], bundled["connectors"][0]["commands"],
            "bundled aokie manifest commands drifted from the contract fixture"
        );
        assert_eq!(
            fixture["pluginApiVersion"], bundled["pluginApiVersion"],
            "pluginApiVersion drifted"
        );
        for err in fixture["errors"].as_array().expect("errors array") {
            let code = err.as_str().unwrap();
            assert!(
                VALID_ERROR_CODES.contains(&code),
                "fixture error '{code}' missing from VALID_ERROR_CODES"
            );
        }
    }

    #[test]
    fn body_validation() {
        // Minimal valid body (connectorId comes from the URL).
        let b = body(r#"{ "command": "echo.ping" }"#);
        assert!(validate_request_body("mock", &b).is_ok());
        // Body id must MATCH the URL when present.
        let b = body(r#"{ "connectorId": "other", "command": "echo.ping" }"#);
        assert!(validate_request_body("mock", &b).is_err());
        let b = body(r#"{ "connectorId": "mock", "command": "echo.ping" }"#);
        assert!(validate_request_body("mock", &b).is_ok());
        // Command pattern.
        let b = body(r#"{ "command": "EchoPing" }"#);
        assert!(validate_request_body("mock", &b).is_err());
        // timeoutMs range.
        let b = body(r#"{ "command": "echo.ping", "timeoutMs": 50 }"#);
        assert!(validate_request_body("mock", &b).is_err());
        let b = body(r#"{ "command": "echo.ping", "timeoutMs": 120001 }"#);
        assert!(validate_request_body("mock", &b).is_err());
        // requestId length.
        let long = "x".repeat(129);
        let b = body(&format!(
            r#"{{ "command": "echo.ping", "requestId": "{long}" }}"#
        ));
        assert!(validate_request_body("mock", &b).is_err());
    }

    #[test]
    fn unknown_body_fields_are_rejected() {
        // additionalProperties: false — a typo'd field must not pass silently.
        assert!(serde_json::from_str::<ConnectorRequestBody>(
            r#"{ "command": "echo.ping", "payloadd": {} }"#
        )
        .is_err());
    }

    #[test]
    fn aokie_physical_commands_require_a_bounded_stable_request_id() {
        for command in [
            "phone.connect",
            "phone.startPairing",
            "call.answer",
            "sms.send",
        ] {
            let missing = body(&format!(r#"{{ "command": "{command}" }}"#));
            let error = validate_request_body("aokie", &missing).unwrap_err();
            assert!(error.contains(command));
            assert!(error.contains("requires requestId"));
        }

        let read = body(r#"{ "command": "phone.status" }"#);
        assert!(validate_request_body("aokie", &read).is_ok());

        let stable_a = stable_request_id("flow-command", &["run-42", "connect"]);
        let stable_b = stable_request_id("flow-command", &["run-42", "connect"]);
        let other = stable_request_id("flow-command", &["run-43", "connect"]);
        assert_eq!(stable_a, stable_b);
        assert_ne!(stable_a, other);
        assert!(stable_a.len() <= 128);

        let accepted = body(&format!(
            r#"{{ "command": "phone.connect", "payload": {{ "address": "00:11:22:33:44:55" }}, "requestId": "{stable_a}" }}"#
        ));
        assert!(validate_request_body("aokie", &accepted).is_ok());
    }
}
