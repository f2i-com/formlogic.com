//! Desktop event bus — plugin → desktop → browser fan-out.
//!
//! Every event is a `desktop-event.schema.json` envelope. The bus VALIDATES
//! before it forwards (per `docs/DESKTOP_PLUGIN_SDK.md` §3): the envelope
//! must be schema-shaped, `source`/`pluginId` must match the emitting plugin,
//! the `name` must be declared in the plugin's manifest `events`, and the
//! serialized size must be ≤ 64 KiB. Invalid events are dropped + logged,
//! never forwarded — a buggy plugin can't spoof another plugin's events or
//! flood consumers with junk.
//!
//! Consumers subscribe via a tokio broadcast channel; the HTTP layer exposes
//! it as `GET /api/events` (SSE: `id:` = idempotencyKey, `event:` = name,
//! `data:` = the full envelope JSON, `: ping` comment every 20 s).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::plugins::manifest::{is_valid_event_name, PluginManifest};
use crate::plugins::rpc::LogRing;

/// Serialized-envelope size cap (contract: 64 KiB).
pub const MAX_EVENT_BYTES: usize = 64 * 1024;

/// Broadcast buffer: slow SSE consumers lag (and skip) rather than block
/// producers. 256 envelopes is plenty for bursty device events.
const BUS_CAPACITY: usize = 256;

/// The desktop-event envelope (`desktop-event.schema.json`).
/// `deny_unknown_fields` mirrors `additionalProperties: false`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    pub schema_version: u32,
    pub source: String,
    pub name: String,
    pub correlation_id: String,
    pub idempotency_key: String,
    pub occurred_at: String,
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
}

/// A validated, already-serialized event as it travels the bus. The JSON is
/// pre-rendered once (`Arc<str>`) so N subscribers don't re-serialize.
#[derive(Debug, Clone)]
pub struct PublishedEvent {
    pub name: String,
    pub idempotency_key: String,
    pub json: Arc<str>,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<PublishedEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BUS_CAPACITY);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PublishedEvent> {
        self.tx.subscribe()
    }

    /// Validate + publish an envelope emitted by `plugin_id` (via `event.emit`).
    /// On failure the event is dropped and the reason lands in the plugin's
    /// log ring — visible in `GET /api/plugins/{id}/logs`, never forwarded.
    pub fn publish_from_plugin(
        &self,
        plugin_id: &str,
        manifest: &PluginManifest,
        envelope: Value,
        logs: &LogRing,
    ) {
        match validate_plugin_envelope(plugin_id, manifest, envelope) {
            Ok(ev) => {
                // send() only errors when there are no subscribers — fine.
                let _ = self.tx.send(ev);
            }
            Err(e) => logs.push("stderr", format!("[desktop] dropped invalid event: {e}")),
        }
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Envelope validation for plugin-sourced events. Split out (pure) so tests
/// can hit every rejection path without a bus or a process.
pub fn validate_plugin_envelope(
    plugin_id: &str,
    manifest: &PluginManifest,
    envelope: Value,
) -> Result<PublishedEvent, String> {
    let env: EventEnvelope = serde_json::from_value(envelope)
        .map_err(|e| format!("envelope does not match desktop-event.schema.json: {e}"))?;
    if env.schema_version != 1 {
        return Err(format!("schemaVersion {} unsupported (want 1)", env.schema_version));
    }
    if env.source != plugin_id {
        return Err(format!(
            "source {:?} does not match the emitting plugin {plugin_id:?}",
            env.source
        ));
    }
    if let Some(pid) = &env.plugin_id {
        if pid != plugin_id {
            return Err(format!(
                "pluginId {pid:?} does not match the emitting plugin {plugin_id:?}"
            ));
        }
    }
    if !is_valid_event_name(&env.name) {
        return Err(format!("event name {:?} is malformed", env.name));
    }
    if !manifest.declares_event(&env.name) {
        return Err(format!(
            "event name {:?} is not declared in the plugin's manifest events",
            env.name
        ));
    }
    if env.correlation_id.is_empty() || env.correlation_id.len() > 128 {
        return Err("correlationId must be 1-128 chars".into());
    }
    if env.idempotency_key.is_empty() || env.idempotency_key.len() > 255 {
        return Err("idempotencyKey must be 1-255 chars".into());
    }
    if env.occurred_at.is_empty() || env.occurred_at.len() > 64 {
        return Err("occurredAt must be a timestamp string".into());
    }
    if let Some(sev) = &env.severity {
        if !matches!(sev.as_str(), "debug" | "info" | "warning" | "error") {
            return Err(format!("severity {sev:?} is not one of debug|info|warning|error"));
        }
    }
    let json = serde_json::to_string(&env).map_err(|e| format!("serialize: {e}"))?;
    if json.len() > MAX_EVENT_BYTES {
        return Err(format!(
            "envelope is {} bytes (max {MAX_EVENT_BYTES})",
            json.len()
        ));
    }
    Ok(PublishedEvent {
        name: env.name,
        idempotency_key: env.idempotency_key,
        json: json.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::parse_manifest;

    fn mock_manifest() -> PluginManifest {
        parse_manifest(
            r#"{
                "schemaVersion": 1, "id": "mock", "name": "Mock", "version": "0.1.0",
                "entry": { "kind": "process", "command": "mock" },
                "events": ["mock.tick"]
            }"#,
        )
        .expect("manifest")
    }

    fn envelope() -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "source": "mock",
            "name": "mock.tick",
            "correlationId": "session-1",
            "idempotencyKey": "mock:session-1:tick:1:v1",
            "occurredAt": "2026-07-07T00:00:00Z",
            "data": { "n": 1 }
        })
    }

    #[test]
    fn valid_envelope_passes_and_serializes_once() {
        let ev = validate_plugin_envelope("mock", &mock_manifest(), envelope()).expect("valid");
        assert_eq!(ev.name, "mock.tick");
        assert_eq!(ev.idempotency_key, "mock:session-1:tick:1:v1");
        // The pre-rendered JSON round-trips as the envelope.
        let back: EventEnvelope = serde_json::from_str(&ev.json).unwrap();
        assert_eq!(back.source, "mock");
    }

    #[test]
    fn undeclared_event_name_is_dropped() {
        let mut e = envelope();
        e["name"] = "mock.other".into();
        let err = validate_plugin_envelope("mock", &mock_manifest(), e).unwrap_err();
        assert!(err.contains("not declared"), "{err}");
    }

    #[test]
    fn spoofed_source_or_plugin_id_is_dropped() {
        let mut e = envelope();
        e["source"] = "aokie".into();
        assert!(validate_plugin_envelope("mock", &mock_manifest(), e).is_err());
        let mut e = envelope();
        e["pluginId"] = "aokie".into();
        assert!(validate_plugin_envelope("mock", &mock_manifest(), e).is_err());
    }

    #[test]
    fn oversized_and_malformed_envelopes_are_dropped() {
        // > 64 KiB data payload.
        let mut e = envelope();
        e["data"] = Value::String("x".repeat(MAX_EVENT_BYTES + 1));
        assert!(validate_plugin_envelope("mock", &mock_manifest(), e)
            .unwrap_err()
            .contains("bytes"));
        // Unknown field (additionalProperties: false).
        let mut e = envelope();
        e["extra"] = 1.into();
        assert!(validate_plugin_envelope("mock", &mock_manifest(), e).is_err());
        // Missing required field.
        let mut e = envelope();
        e.as_object_mut().unwrap().remove("idempotencyKey");
        assert!(validate_plugin_envelope("mock", &mock_manifest(), e).is_err());
        // Bad severity.
        let mut e = envelope();
        e["severity"] = "fatal".into();
        assert!(validate_plugin_envelope("mock", &mock_manifest(), e).is_err());
    }

    #[tokio::test]
    async fn bus_delivers_to_subscribers() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        let logs = LogRing::new();
        bus.publish_from_plugin("mock", &mock_manifest(), envelope(), &logs);
        let got = rx.recv().await.expect("delivered");
        assert_eq!(got.name, "mock.tick");
        // Invalid one is dropped (not delivered) and logged.
        let mut bad = envelope();
        bad["name"] = "mock.undeclared".into();
        bus.publish_from_plugin("mock", &mock_manifest(), bad, &logs);
        assert!(rx.try_recv().is_err());
        assert!(logs
            .snapshot(None)
            .iter()
            .any(|l| l.text.contains("dropped invalid event")));
    }
}
