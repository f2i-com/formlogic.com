//! Server-to-server OpenAI Realtime bridge for the signed Aokie plugin.
//!
//! The local side is intentionally tiny and audio-native: one fenced start
//! frame, bounded control JSON, and raw PCM16LE mono 24 kHz binary frames.
//! Desktop alone resolves the reusable provider credential and translates the
//! stream to OpenAI's JSON/Base64 event dialect. No credential, raw upstream
//! event, prompt, transcript, or audio payload is written to logs.

use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame as LocalCloseFrame, Message as LocalMessage, WebSocket};
use base64::Engine;
use futures_util::{Sink, SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::{interval, timeout, MissedTickBehavior};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    protocol::{Message as UpstreamMessage, WebSocketConfig},
};

use super::egress;
use super::gateway::{provider_headers, GatewayError};
use super::providers::{Capability, Protocol, ProviderProfile, ProviderRegistryHandle};

pub const MAX_LOCAL_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_LOCAL_FRAME_BYTES: usize = 256 * 1024;
const MAX_START_BYTES: usize = 96 * 1024;
const MAX_CONTROL_BYTES: usize = 16 * 1024;
const MAX_AUDIO_FRAME_BYTES: usize = 64 * 1024;
const MAX_AUDIO_BYTES_PER_SECOND: usize = 256 * 1024;
const MAX_UPSTREAM_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_UPSTREAM_FRAME_BYTES: usize = 256 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 8 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 8 * 1024;
const MAX_TOOL_CALLS_PER_SESSION: u8 = 8;
const MIN_TOOL_CALL_INTERVAL: Duration = Duration::from_millis(250);
const START_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(2);
const SESSION_LIFETIME: Duration = Duration::from_secs(55 * 60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-4o-mini-transcribe";

/// A secret-bearing, DNS-pinned upstream request prepared before Axum accepts
/// the local upgrade. Fields are private so a handler cannot serialize or log
/// the credential headers accidentally.
pub struct PreparedRealtime {
    target: egress::ValidatedTarget,
    headers: reqwest::header::HeaderMap,
    model: String,
    destination_origin: String,
}

/// Resolve a provider, its reusable secret, endpoint, and pinned socket. The
/// returned value must only be moved into [`run`].
pub fn prepare(
    registry: &ProviderRegistryHandle,
    provider: &ProviderProfile,
) -> Result<PreparedRealtime, GatewayError> {
    if provider.protocol != Protocol::OpenAi {
        return Err(GatewayError::BadRequest(
            "Realtime streaming currently requires an OpenAI-protocol provider".into(),
        ));
    }
    if !provider.enabled || !provider.supports(Capability::Realtime) {
        return Err(GatewayError::NoProvider(
            "Realtime provider is disabled or does not advertise Realtime".into(),
        ));
    }
    let model = provider
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            GatewayError::BadRequest("Realtime provider has no model configured".into())
        })?;
    if model.len() > 256
        || model
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(GatewayError::BadRequest(
            "Realtime provider model is invalid".into(),
        ));
    }

    let websocket_path = provider.realtime_websocket_path();
    if websocket_path.len() > 2048
        || !websocket_path.starts_with('/')
        || websocket_path.starts_with("//")
        || websocket_path.contains(['?', '#'])
        || websocket_path.chars().any(char::is_control)
    {
        return Err(GatewayError::BadRequest(
            "Realtime WebSocket path is invalid".into(),
        ));
    }
    let mut target =
        egress::validate_websocket(&provider.base_url, &websocket_path, provider.local_access())
            .map_err(|error| GatewayError::BadRequest(error.to_string()))?;
    // The configured model is authoritative. A persisted/hand-edited path may
    // not smuggle a second model or fragments into the upstream selection.
    target.url.set_query(None);
    target.url.set_fragment(None);
    target.url.query_pairs_mut().append_pair("model", model);
    let destination_origin = provider.realtime_destination_origin().ok_or_else(|| {
        GatewayError::BadRequest("Realtime provider has no safe network origin".into())
    })?;

    let key = registry
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .key(&provider.id);
    if !provider.allow_local && key.as_deref().is_none_or(str::is_empty) {
        return Err(GatewayError::BadRequest(
            "Realtime provider has no stored API secret".into(),
        ));
    }
    let headers = provider_headers(provider, key.as_deref())?;

    Ok(PreparedRealtime {
        target,
        headers,
        model: model.to_string(),
        destination_origin,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CallFence {
    call_id: String,
    generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartFrame {
    #[serde(rename = "type")]
    kind: String,
    call_id: String,
    generation: u64,
    /// Consent-bound actual upstream origin advertised by `/api/ai/sources`.
    destination_origin: Option<String>,
    #[serde(default)]
    instructions: String,
    #[serde(default)]
    greeting: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    turn_detection: Option<TurnDetectionInput>,
    #[serde(default)]
    max_output_tokens: Option<u16>,
    /// The signed Aokie plugin may request only these two fixed Desktop-owned
    /// tools. It never supplies a function name, schema, transport, or service
    /// binding, so this cannot become a generic execution surface.
    #[serde(default)]
    allow_business_lookup: bool,
    #[serde(default)]
    allow_finish_call: bool,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TurnDetectionInput {
    Kind(String),
    Config(TurnDetectionConfig),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnDetectionConfig {
    #[serde(rename = "type")]
    kind: String,
    threshold: Option<f64>,
    prefix_padding_ms: Option<u64>,
    silence_duration_ms: Option<u64>,
    idle_timeout_ms: Option<u64>,
    eagerness: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum LocalControl {
    #[serde(rename = "formlogic.realtime.begin")]
    Begin {
        #[serde(rename = "callId")]
        call_id: String,
        generation: u64,
    },
    #[serde(rename = "formlogic.realtime.cancel_output")]
    CancelOutput {
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(rename = "playedMs")]
        played_ms: u64,
        #[serde(rename = "callId")]
        call_id: String,
        generation: u64,
    },
    #[serde(rename = "formlogic.realtime.stop")]
    Stop {
        #[serde(rename = "callId")]
        call_id: String,
        generation: u64,
    },
    #[serde(rename = "formlogic.realtime.tool_result")]
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        generation: u64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        ok: bool,
        output: Value,
    },
}

struct OutputItemState {
    item_id: String,
    response_id: String,
    output_index: u64,
    done: bool,
    completed: bool,
    terminal: bool,
    audio_bytes: usize,
    transcript: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AllowedTool {
    LookupBusinessData,
    FinishCall,
}

impl AllowedTool {
    fn name(self) -> &'static str {
        match self {
            Self::LookupBusinessData => "lookup_business_data",
            Self::FinishCall => "finish_call",
        }
    }
}

struct ToolCandidate {
    tool: AllowedTool,
    response_id: String,
    item_id: String,
    provider_call_id: String,
    output_index: u64,
    preamble_item_id: Option<String>,
    item_done: bool,
    item_completed: bool,
}

struct PendingToolResult {
    tool: AllowedTool,
    tool_call_id: String,
    provider_call_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ForcedResponsePurpose {
    Greeting,
    LookupContinuation,
    FinishCallFarewell,
    FinishCallRejected,
}

impl ForcedResponsePurpose {
    fn metadata_value(self) -> &'static str {
        match self {
            Self::Greeting => "greeting",
            Self::LookupContinuation => "lookup_business_data_continuation",
            Self::FinishCallFarewell => "finish_call_farewell",
            Self::FinishCallRejected => "finish_call_rejected",
        }
    }
}

struct PendingForcedResponse {
    purpose: ForcedResponsePurpose,
    tool_call_id: Option<String>,
    response_id: Option<String>,
}

struct SessionState {
    ready: bool,
    begun: bool,
    greeting: Option<String>,
    output: Option<OutputItemState>,
    allow_business_lookup: bool,
    allow_finish_call: bool,
    tool_candidate: Option<ToolCandidate>,
    pending_tool_result: Option<PendingToolResult>,
    used_tool_call_ids: Vec<String>,
    tool_call_count: u8,
    last_tool_call_at: Option<Instant>,
    pending_forced_response: Option<PendingForcedResponse>,
    invalid_controls: u8,
}

impl SessionState {
    #[cfg(test)]
    fn new(greeting: String) -> Self {
        Self::new_with_tools(greeting, false, false)
    }

    fn new_with_tools(
        greeting: String,
        allow_business_lookup: bool,
        allow_finish_call: bool,
    ) -> Self {
        Self {
            ready: false,
            begun: false,
            greeting: (!greeting.is_empty()).then_some(greeting),
            output: None,
            allow_business_lookup,
            allow_finish_call,
            tool_candidate: None,
            pending_tool_result: None,
            used_tool_call_ids: Vec::new(),
            tool_call_count: 0,
            last_tool_call_at: None,
            pending_forced_response: None,
            invalid_controls: 0,
        }
    }

    fn tool_allowed(&self, tool: AllowedTool) -> bool {
        match tool {
            AllowedTool::LookupBusinessData => self.allow_business_lookup,
            AllowedTool::FinishCall => self.allow_finish_call,
        }
    }
}

struct AudioRateWindow {
    opened: Instant,
    bytes: usize,
}

impl AudioRateWindow {
    fn new() -> Self {
        Self {
            opened: Instant::now(),
            bytes: 0,
        }
    }

    fn admit(&mut self, bytes: usize) -> bool {
        if self.opened.elapsed() >= Duration::from_secs(1) {
            self.opened = Instant::now();
            self.bytes = 0;
        }
        let Some(next) = self.bytes.checked_add(bytes) else {
            return false;
        };
        if next > MAX_AUDIO_BYTES_PER_SECOND {
            return false;
        }
        self.bytes = next;
        true
    }
}

/// Run one local/upstream session. It never reconnects: any transport failure
/// closes this exact call fence so Aokie can execute its configured safe
/// fallback without stale audio crossing into a later call.
pub async fn run(mut local: WebSocket, prepared: PreparedRealtime) {
    let start = match receive_start(&mut local).await {
        Ok(start) => start,
        Err(reason) => {
            close_local(&mut local, 1008, reason).await;
            return;
        }
    };
    let fence = CallFence {
        call_id: start.call_id.clone(),
        generation: start.generation,
    };
    if start.destination_origin.as_deref() != Some(prepared.destination_origin.as_str()) {
        let _ = local
            .send(local_error(
                &fence,
                "destination_mismatch",
                "Realtime destination changed after consent; reconnect from Receptionist settings.",
                true,
            ))
            .await;
        close_local(&mut local, 1008, "destination consent mismatch").await;
        return;
    }

    let mut upstream = match connect_upstream(&prepared).await {
        Ok(upstream) => upstream,
        Err(()) => {
            let _ = local
                .send(local_error(
                    &fence,
                    "upstream_unavailable",
                    "The configured Realtime provider could not be reached.",
                    true,
                ))
                .await;
            close_local(&mut local, 1011, "Realtime provider unavailable").await;
            return;
        }
    };

    let update = match session_update(&start, &prepared.model) {
        Ok(update) => update,
        Err(message) => {
            let _ = local
                .send(local_error(&fence, "invalid_start", message, true))
                .await;
            close_local(&mut local, 1008, "invalid Realtime start").await;
            let _ = upstream.close(None).await;
            return;
        }
    };
    if timeout(SEND_TIMEOUT, upstream.send(update))
        .await
        .ok()
        .and_then(Result::ok)
        .is_none()
    {
        let _ = local
            .send(local_error(
                &fence,
                "upstream_unavailable",
                "The Realtime provider did not accept the session configuration.",
                true,
            ))
            .await;
        close_local(&mut local, 1011, "Realtime provider unavailable").await;
        return;
    }

    let model = prepared.model;
    let destination_origin = prepared.destination_origin;
    let (mut local_tx, mut local_rx) = local.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let mut state = SessionState::new_with_tools(
        start.greeting,
        start.allow_business_lookup,
        start.allow_finish_call,
    );
    let mut audio_rate = AudioRateWindow::new();
    let lifetime = tokio::time::sleep(SESSION_LIFETIME);
    tokio::pin!(lifetime);
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    heartbeat.tick().await;

    'session: loop {
        tokio::select! {
            _ = &mut lifetime => {
                let _ = send_local(&mut local_tx, local_error(
                    &fence,
                    "session_expired",
                    "The Realtime call session reached its 55-minute safety limit.",
                    true,
                )).await;
                break 'session;
            }
            _ = heartbeat.tick() => {
                if !send_upstream(&mut upstream_tx, UpstreamMessage::Ping(Vec::new())).await
                    || !send_local(&mut local_tx, LocalMessage::Ping(Vec::new())).await
                {
                    break 'session;
                }
            }
            local_message = local_rx.next() => {
                let Some(local_message) = local_message else { break 'session; };
                let Ok(local_message) = local_message else { break 'session; };
                match local_message {
                    LocalMessage::Binary(pcm) => {
                        if !state.ready || !state.begun {
                            let _ = send_local(&mut local_tx, local_error(
                                &fence,
                                "not_ready",
                                "Wait for formlogic.realtime.ready and begin before sending audio.",
                                true,
                            )).await;
                            break 'session;
                        }
                        if pcm.is_empty()
                            || pcm.len() > MAX_AUDIO_FRAME_BYTES
                            || pcm.len() % 2 != 0
                            || !audio_rate.admit(pcm.len())
                        {
                            let _ = send_local(&mut local_tx, local_error(
                                &fence,
                                "invalid_audio",
                                "PCM frames must be even-length, bounded PCM16LE mono at 24 kHz.",
                                true,
                            )).await;
                            break 'session;
                        }
                        let encoded = base64::engine::general_purpose::STANDARD.encode(pcm);
                        let event = UpstreamMessage::Text(json!({
                            "type": "input_audio_buffer.append",
                            "audio": encoded,
                        }).to_string());
                        if !send_upstream(&mut upstream_tx, event).await {
                            break 'session;
                        }
                    }
                    LocalMessage::Text(text) => {
                        if text.len() > MAX_CONTROL_BYTES {
                            let _ = send_local(&mut local_tx, local_error(
                                &fence,
                                "invalid_control",
                                "Realtime control frame exceeded the 16 KiB limit.",
                                true,
                            )).await;
                            break 'session;
                        }
                        let control = serde_json::from_str::<LocalControl>(&text);
                        match control {
                            Ok(LocalControl::Begin { call_id, generation }) => {
                                if !exact_fence_matches(&fence, &call_id, generation)
                                    || !state.ready
                                    || state.begun
                                {
                                    state.invalid_controls = state.invalid_controls.saturating_add(1);
                                    let fatal = state.invalid_controls >= 4;
                                    let _ = send_local(&mut local_tx, local_error(
                                        &fence,
                                        "invalid_begin",
                                        "The begin request did not match this ready call.",
                                        fatal,
                                    )).await;
                                    if fatal { break 'session; }
                                    continue;
                                }
                                if let Some(greeting_event) = begin_response(&mut state) {
                                    if !send_upstream(&mut upstream_tx, greeting_event).await {
                                        break 'session;
                                    }
                                }
                            }
                            Ok(LocalControl::CancelOutput { item_id, played_ms, call_id, generation }) => {
                                let output_matches = state.output.as_ref().is_some_and(|output| {
                                    output.item_id == item_id
                                });
                                if !exact_fence_matches(&fence, &call_id, generation)
                                    || item_id.len() > 512
                                    || item_id.chars().any(char::is_control)
                                    || played_ms > 3_600_000
                                    || !output_matches
                                {
                                    state.invalid_controls = state.invalid_controls.saturating_add(1);
                                    let fatal = state.invalid_controls >= 4;
                                    let _ = send_local(&mut local_tx, local_error(
                                        &fence,
                                        "stale_output",
                                        "The output cancellation did not match this call's active item.",
                                        fatal,
                                    )).await;
                                    if fatal { break 'session; }
                                    continue;
                                }
                                // server/semantic VAD already interrupts the response on
                                // speech_started. Truncate only the audio Aokie actually
                                // played; a redundant response.cancel can itself produce a
                                // recoverable no-active-response error and obscure barge-in.
                                let truncate = truncate_event(&state, &item_id, played_ms)
                                    .expect("validated output fence");
                                if !send_upstream(&mut upstream_tx, truncate).await
                                {
                                    break 'session;
                                }
                            }
                            Ok(LocalControl::ToolResult {
                                call_id,
                                generation,
                                tool_call_id,
                                name,
                                ok,
                                output,
                            }) => {
                                if !exact_fence_matches(&fence, &call_id, generation)
                                    || !state.ready
                                    || !state.begun
                                {
                                    state.invalid_controls = state.invalid_controls.saturating_add(1);
                                    let fatal = state.invalid_controls >= 4;
                                    let _ = send_local(&mut local_tx, local_error(
                                        &fence,
                                        "stale_tool_result",
                                        "The tool result did not match this active call.",
                                        fatal,
                                    )).await;
                                    if fatal { break 'session; }
                                    continue;
                                }
                                match tool_result_events(
                                    &mut state,
                                    &tool_call_id,
                                    &name,
                                    ok,
                                    output,
                                ) {
                                    Ok(events) => {
                                        for event in events {
                                            if !send_upstream(&mut upstream_tx, event).await {
                                                break 'session;
                                            }
                                        }
                                    }
                                    Err((code, message)) => {
                                        state.invalid_controls =
                                            state.invalid_controls.saturating_add(1);
                                        let fatal = state.invalid_controls >= 4;
                                        let _ = send_local(&mut local_tx, local_error(
                                            &fence,
                                            code,
                                            message,
                                            fatal,
                                        )).await;
                                        if fatal { break 'session; }
                                    }
                                }
                            }
                            Ok(LocalControl::Stop { call_id, generation }) => {
                                if !exact_fence_matches(&fence, &call_id, generation) {
                                    let _ = send_local(&mut local_tx, local_error(
                                        &fence,
                                        "stale_session",
                                        "The stop request did not match this call.",
                                        true,
                                    )).await;
                                    break 'session;
                                }
                                let _ = send_upstream(&mut upstream_tx, UpstreamMessage::Text(
                                    json!({ "type": "response.cancel" }).to_string(),
                                )).await;
                                let _ = send_upstream(&mut upstream_tx, UpstreamMessage::Text(
                                    json!({ "type": "input_audio_buffer.clear" }).to_string(),
                                )).await;
                                break 'session;
                            }
                            Err(_) => {
                                state.invalid_controls = state.invalid_controls.saturating_add(1);
                                let fatal = state.invalid_controls >= 4;
                                let _ = send_local(&mut local_tx, local_error(
                                    &fence,
                                    "invalid_control",
                                    "Unsupported Realtime control frame.",
                                    fatal,
                                )).await;
                                if fatal { break 'session; }
                            }
                        }
                    }
                    LocalMessage::Close(_) => break 'session,
                    LocalMessage::Ping(_) | LocalMessage::Pong(_) => {}
                }
            }
            upstream_message = upstream_rx.next() => {
                let Some(upstream_message) = upstream_message else {
                    let _ = send_local(&mut local_tx, local_error(
                        &fence,
                        "upstream_closed",
                        "The Realtime provider closed the call session.",
                        true,
                    )).await;
                    break 'session;
                };
                let Ok(upstream_message) = upstream_message else {
                    let _ = send_local(&mut local_tx, local_error(
                        &fence,
                        "upstream_closed",
                        "The Realtime provider connection failed.",
                        true,
                    )).await;
                    break 'session;
                };
                match upstream_message {
                    UpstreamMessage::Text(text) => {
                        let Ok(event) = serde_json::from_str::<Value>(&text) else {
                            let _ = send_local(&mut local_tx, local_error(
                                &fence,
                                "upstream_protocol",
                                "The Realtime provider returned an invalid event.",
                                true,
                            )).await;
                            break 'session;
                        };
                        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                        if event_type == "session.updated" && !state.ready {
                            state.ready = true;
                            if !send_local(&mut local_tx, fenced_json(
                                &fence,
                                "formlogic.realtime.ready",
                                json!({
                                    "model": model,
                                    "destinationOrigin": destination_origin,
                                    "sampleRate": 24000,
                                    "channels": 1,
                                    "encoding": "pcm16le",
                                }),
                            )).await {
                                break 'session;
                            }
                            continue;
                        }

                        match translate_server_event(&event, &fence, &mut state) {
                            Ok(messages) => {
                                // Translation emits at most two messages. A terminal
                                // response may need to retire an abandoned output item
                                // before reporting its recoverable failure to Aokie.
                                for message in messages {
                                    if !send_local(&mut local_tx, message).await {
                                        break 'session;
                                    }
                                }
                            }
                            Err((code, message)) => {
                                let _ = send_local(&mut local_tx, local_error(
                                    &fence,
                                    code,
                                    message,
                                    true,
                                )).await;
                                break 'session;
                            }
                        }
                    }
                    UpstreamMessage::Close(_) => {
                        let _ = send_local(&mut local_tx, local_error(
                            &fence,
                            "upstream_closed",
                            "The Realtime provider closed the call session.",
                            true,
                        )).await;
                        break 'session;
                    }
                    UpstreamMessage::Ping(payload) => {
                        if !send_upstream(&mut upstream_tx, UpstreamMessage::Pong(payload)).await {
                            break 'session;
                        }
                    }
                    UpstreamMessage::Pong(_) => {}
                    UpstreamMessage::Binary(_) | UpstreamMessage::Frame(_) => {
                        let _ = send_local(&mut local_tx, local_error(
                            &fence,
                            "upstream_protocol",
                            "The Realtime provider returned an unsupported frame.",
                            true,
                        )).await;
                        break 'session;
                    }
                }
            }
        }
    }

    let _ = timeout(SEND_TIMEOUT, upstream_tx.send(UpstreamMessage::Close(None))).await;
    let _ = timeout(SEND_TIMEOUT, local_tx.send(LocalMessage::Close(None))).await;
}

async fn receive_start(local: &mut WebSocket) -> Result<StartFrame, &'static str> {
    let first = timeout(START_TIMEOUT, local.recv())
        .await
        .map_err(|_| "Realtime start timed out")?
        .ok_or("Realtime start was not received")?
        .map_err(|_| "Realtime start could not be read")?;
    let LocalMessage::Text(text) = first else {
        return Err("first Realtime frame must be JSON text");
    };
    if text.len() > MAX_START_BYTES {
        return Err("Realtime start exceeded the 96 KiB limit");
    }
    let start: StartFrame = serde_json::from_str(&text).map_err(|_| "Realtime start is invalid")?;
    if start.kind != "formlogic.realtime.start"
        || start.call_id.is_empty()
        || start.call_id.len() > 128
        || start.call_id.chars().any(char::is_control)
        || start.instructions.len() > 64 * 1024
        || start.instructions.contains('\0')
        || start.greeting.len() > 16 * 1024
        || start.greeting.contains('\0')
    {
        return Err("Realtime start fields are invalid");
    }
    Ok(start)
}

fn session_update(start: &StartFrame, model: &str) -> Result<UpstreamMessage, &'static str> {
    let voice = start.voice.as_deref().unwrap_or("marin").trim();
    if voice.is_empty() || voice.len() > 128 || voice.chars().any(|ch| ch.is_control()) {
        return Err("Realtime voice is invalid");
    }
    let max_output_tokens = start.max_output_tokens.unwrap_or(512);
    if !(1..=4096).contains(&max_output_tokens) {
        return Err("Realtime maxOutputTokens must be between 1 and 4096");
    }
    let turn_detection = normalized_turn_detection(start.turn_detection.as_ref())?;
    let tools = realtime_tools(start.allow_business_lookup, start.allow_finish_call);
    let tool_choice = if tools.is_empty() { "none" } else { "auto" };
    Ok(UpstreamMessage::Text(
        json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                // The query and session field are injected from the same
                // persisted provider profile; the local caller cannot choose
                // or override the upstream model.
                "model": model,
                "instructions": start.instructions,
                "max_output_tokens": max_output_tokens,
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        "format": { "type": "audio/pcm", "rate": 24000 },
                        "noise_reduction": { "type": "near_field" },
                        "transcription": { "model": DEFAULT_TRANSCRIPTION_MODEL },
                        "turn_detection": turn_detection,
                    },
                    "output": {
                        "format": { "type": "audio/pcm", "rate": 24000 },
                        "voice": voice,
                    }
                },
                "tools": tools,
                "tool_choice": tool_choice,
            }
        })
        .to_string(),
    ))
}

fn realtime_tools(allow_business_lookup: bool, allow_finish_call: bool) -> Vec<Value> {
    let mut tools = Vec::with_capacity(2);
    if allow_business_lookup {
        tools.push(json!({
            "type": "function",
            "name": AllowedTool::LookupBusinessData.name(),
            "description": "Look up current business records or availability only when the answer is not already in the supplied business context. Ask one precise data question. This tool is read-only.",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "question": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 500
                    }
                },
                "required": ["question"]
            }
        }));
    }
    if allow_finish_call {
        tools.push(json!({
            "type": "function",
            "name": AllowedTool::FinishCall.name(),
            "description": "Request a safe end to the phone call only after the caller has clearly finished and no question or task remains. The system will require a separate brief audible farewell before hanging up.",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }
        }));
    }
    tools
}

fn normalized_turn_detection(input: Option<&TurnDetectionInput>) -> Result<Value, &'static str> {
    let kind = match input {
        None => "server_vad",
        Some(TurnDetectionInput::Kind(kind)) => kind.as_str(),
        Some(TurnDetectionInput::Config(config)) => config.kind.as_str(),
    };
    match kind {
        "server_vad" => {
            let config = match input {
                Some(TurnDetectionInput::Config(config)) => Some(config),
                _ => None,
            };
            let threshold = config.and_then(|config| config.threshold).unwrap_or(0.5);
            let prefix_padding_ms = config
                .and_then(|config| config.prefix_padding_ms)
                .unwrap_or(300);
            let silence_duration_ms = config
                .and_then(|config| config.silence_duration_ms)
                .unwrap_or(500);
            let idle_timeout_ms = config.and_then(|config| config.idle_timeout_ms);
            if !(0.0..=1.0).contains(&threshold)
                || prefix_padding_ms > 5_000
                || !(100..=5_000).contains(&silence_duration_ms)
                || idle_timeout_ms.is_some_and(|value| !(5_000..=30_000).contains(&value))
            {
                return Err("server_vad settings are outside the safe bounds");
            }
            let mut value = json!({
                "type": "server_vad",
                "threshold": threshold,
                "prefix_padding_ms": prefix_padding_ms,
                "silence_duration_ms": silence_duration_ms,
                "create_response": true,
                "interrupt_response": true,
            });
            if let Some(idle_timeout_ms) = idle_timeout_ms {
                value["idle_timeout_ms"] = Value::from(idle_timeout_ms);
            }
            Ok(value)
        }
        "semantic_vad" => {
            let eagerness = match input {
                Some(TurnDetectionInput::Config(config)) => {
                    config.eagerness.as_deref().unwrap_or("auto")
                }
                _ => "auto",
            };
            if !matches!(eagerness, "low" | "medium" | "high" | "auto") {
                return Err("semantic_vad eagerness is invalid");
            }
            Ok(json!({
                "type": "semantic_vad",
                "eagerness": eagerness,
                "create_response": true,
                "interrupt_response": true,
            }))
        }
        _ => Err("turnDetection must be server_vad or semantic_vad"),
    }
}

/// Begin is deliberately separate from ready: callers may preconnect while a
/// phone is still ringing, but no greeting is generated (and no PCM accepted)
/// until Aokie proves the answered, unscreened, Aokie-owned SCO call.
fn begin_response(state: &mut SessionState) -> Option<UpstreamMessage> {
    state.begun = true;
    state.greeting.take().map(|greeting| {
        state.pending_forced_response = Some(PendingForcedResponse {
            purpose: ForcedResponsePurpose::Greeting,
            tool_call_id: None,
            response_id: None,
        });
        UpstreamMessage::Text(
            json!({
                "type": "response.create",
                "response": {
                    "instructions": greeting,
                    "output_modalities": ["audio"],
                    "tools": [],
                    "tool_choice": "none",
                    "metadata": {
                        "formlogic_purpose": ForcedResponsePurpose::Greeting.metadata_value(),
                    },
                }
            })
            .to_string(),
        )
    })
}

fn truncate_event(state: &SessionState, item_id: &str, played_ms: u64) -> Option<UpstreamMessage> {
    state
        .output
        .as_ref()
        .filter(|output| output.item_id == item_id)
        .map(|_| {
            UpstreamMessage::Text(
                json!({
                    "type": "conversation.item.truncate",
                    "item_id": item_id,
                    "content_index": 0,
                    "audio_end_ms": played_ms,
                })
                .to_string(),
            )
        })
}

fn allowed_tool(name: &str) -> Option<AllowedTool> {
    match name {
        "lookup_business_data" => Some(AllowedTool::LookupBusinessData),
        "finish_call" => Some(AllowedTool::FinishCall),
        _ => None,
    }
}

fn validate_tool_arguments(
    tool: AllowedTool,
    arguments: &str,
) -> Result<Value, (&'static str, &'static str)> {
    if arguments.is_empty() || arguments.len() > MAX_TOOL_ARGUMENT_BYTES || arguments.contains('\0')
    {
        return Err((
            "invalid_tool_arguments",
            "Realtime tool arguments exceeded the safe limit.",
        ));
    }
    let value: Value = serde_json::from_str(arguments).map_err(|_| {
        (
            "invalid_tool_arguments",
            "Realtime tool arguments were not valid JSON.",
        )
    })?;
    let object = value.as_object().ok_or((
        "invalid_tool_arguments",
        "Realtime tool arguments must be a JSON object.",
    ))?;
    match tool {
        AllowedTool::LookupBusinessData => {
            if object.len() != 1 || !object.contains_key("question") {
                return Err((
                    "invalid_tool_arguments",
                    "Business lookup accepts only a question.",
                ));
            }
            let question = object
                .get("question")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|question| {
                    !question.is_empty()
                        && question.chars().count() <= 500
                        && !question.chars().any(char::is_control)
                })
                .ok_or((
                    "invalid_tool_arguments",
                    "Business lookup requires one bounded plain-text question.",
                ))?;
            Ok(json!({ "question": question }))
        }
        AllowedTool::FinishCall => {
            if !object.is_empty() {
                return Err((
                    "invalid_tool_arguments",
                    "Finish call accepts only an empty object.",
                ));
            }
            Ok(json!({}))
        }
    }
}

fn tool_result_events(
    state: &mut SessionState,
    tool_call_id: &str,
    name: &str,
    ok: bool,
    output: Value,
) -> Result<Vec<UpstreamMessage>, (&'static str, &'static str)> {
    if safe_token(tool_call_id, 512).is_none() || safe_token(name, 96).is_none() {
        return Err((
            "stale_tool_result",
            "Realtime tool result identity was invalid.",
        ));
    }
    if state
        .used_tool_call_ids
        .iter()
        .any(|used| used == tool_call_id)
    {
        return Err((
            "duplicate_tool_result",
            "Realtime tool result was already consumed.",
        ));
    }
    if state.pending_forced_response.is_some() {
        return Err((
            "stale_tool_result",
            "A forced Realtime response is already active.",
        ));
    }
    let Some(pending) = state.pending_tool_result.as_ref() else {
        return Err((
            "stale_tool_result",
            "No Realtime tool call is awaiting a result.",
        ));
    };
    if pending.tool_call_id != tool_call_id
        || pending.provider_call_id != tool_call_id
        || pending.tool.name() != name
    {
        return Err((
            "stale_tool_result",
            "Realtime tool result did not match the pending call.",
        ));
    }

    let output_envelope = json!({ "ok": ok, "output": output });
    let output = serde_json::to_string(&output_envelope).map_err(|_| {
        (
            "invalid_tool_result",
            "Realtime tool result could not be encoded.",
        )
    })?;
    if output.len() > MAX_TOOL_OUTPUT_BYTES || output.contains('\0') {
        return Err((
            "invalid_tool_result",
            "Realtime tool result exceeded the safe limit.",
        ));
    }

    let pending = state
        .pending_tool_result
        .take()
        .expect("pending tool identity was validated");
    state.used_tool_call_ids.push(tool_call_id.to_string());

    let mut response = json!({
        "output_modalities": ["audio"],
        "tools": [],
        "tool_choice": "none",
    });
    let purpose = match (pending.tool, ok) {
        (AllowedTool::LookupBusinessData, _) => {
            response["instructions"] = Value::String(
                "Answer the caller's pending question briefly using the function result. If the lookup failed, say that you could not check it just now. Do not claim any action was completed."
                    .into(),
            );
            ForcedResponsePurpose::LookupContinuation
        }
        (AllowedTool::FinishCall, true) => {
            response["instructions"] = Value::String(
                "Say one brief, warm goodbye now. Do not ask a question, offer more help, introduce a new topic, or mention tools."
                    .into(),
            );
            ForcedResponsePurpose::FinishCallFarewell
        }
        (AllowedTool::FinishCall, false) => {
            response["instructions"] = Value::String(
                "The call could not be ended. Briefly continue the conversation without claiming it ended and without asking the function again in this response."
                    .into(),
            );
            ForcedResponsePurpose::FinishCallRejected
        }
    };
    response["metadata"] = json!({
        "formlogic_purpose": purpose.metadata_value(),
        "formlogic_tool_call_id": tool_call_id,
    });
    state.pending_forced_response = Some(PendingForcedResponse {
        purpose,
        tool_call_id: Some(tool_call_id.to_string()),
        response_id: None,
    });

    Ok(vec![
        UpstreamMessage::Text(
            json!({
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": pending.provider_call_id,
                    "output": output,
                }
            })
            .to_string(),
        ),
        UpstreamMessage::Text(
            json!({
                "type": "response.create",
                "response": response,
            })
            .to_string(),
        ),
    ])
}

fn is_brief_non_question_farewell(transcript: &str) -> bool {
    let transcript = transcript.trim();
    if transcript.is_empty()
        || transcript.len() > 320
        || transcript.contains(['?', '\u{ff1f}', '\u{061f}'])
    {
        return false;
    }
    let lower = transcript.to_lowercase();
    [
        "goodbye",
        "bye",
        "take care",
        "thanks for calling",
        "thank you for calling",
        "have a good",
        "have a lovely",
        "talk soon",
    ]
    .iter()
    .any(|farewell| lower.contains(farewell))
}

fn completed_farewell_item_matches(response: &Value, output: &OutputItemState) -> bool {
    let Some(items) = response.get("output").and_then(Value::as_array) else {
        return false;
    };
    items.len() == 1
        && items[0].get("id").and_then(Value::as_str) == Some(output.item_id.as_str())
        && items[0].get("type").and_then(Value::as_str) == Some("message")
        && items[0].get("role").and_then(Value::as_str) == Some("assistant")
        && items[0].get("status").and_then(Value::as_str) == Some("completed")
}

async fn connect_upstream(
    prepared: &PreparedRealtime,
) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, ()> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect(prepared.target.pinned))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let _ = tcp.set_nodelay(true);
    let mut request = prepared
        .target
        .url
        .as_str()
        .into_client_request()
        .map_err(|_| ())?;
    for (name, value) in &prepared.headers {
        request.headers_mut().insert(name.clone(), value.clone());
    }
    request.headers_mut().insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("FormLogic-Desktop/Realtime"),
    );
    let config = WebSocketConfig {
        write_buffer_size: 32 * 1024,
        max_write_buffer_size: 1024 * 1024,
        max_message_size: Some(MAX_UPSTREAM_MESSAGE_BYTES),
        max_frame_size: Some(MAX_UPSTREAM_FRAME_BYTES),
        ..WebSocketConfig::default()
    };
    timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::client_async_tls_with_config(request, tcp, Some(config), None),
    )
    .await
    .map_err(|_| ())?
    .map(|(stream, _response)| stream)
    .map_err(|_| ())
}

fn translate_server_event(
    event: &Value,
    fence: &CallFence,
    state: &mut SessionState,
) -> Result<Vec<LocalMessage>, (&'static str, &'static str)> {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "session.created" | "session.updated" | "rate_limits.updated" => Ok(Vec::new()),
        "response.created" => {
            if state.pending_tool_result.is_some() {
                return Err((
                    "upstream_protocol",
                    "Realtime started another response before the pending tool result arrived.",
                ));
            }
            if let Some(forced) = state.pending_forced_response.as_mut() {
                let response_id = safe_id(event.pointer("/response/id"))?;
                let metadata_tool_call = event
                    .pointer("/response/metadata/formlogic_tool_call_id")
                    .and_then(Value::as_str);
                let purpose = event
                    .pointer("/response/metadata/formlogic_purpose")
                    .and_then(Value::as_str);
                if forced.response_id.is_some()
                    || metadata_tool_call != forced.tool_call_id.as_deref()
                    || purpose != Some(forced.purpose.metadata_value())
                {
                    return Err((
                        "upstream_protocol",
                        "Realtime forced response did not match its host-created request.",
                    ));
                }
                forced.response_id = Some(response_id);
            }
            Ok(Vec::new())
        }
        "input_audio_buffer.speech_started" => Ok(vec![fenced_json(
            fence,
            "formlogic.realtime.speech_started",
            json!({
                "itemId": safe_id(event.get("item_id"))?,
                "audioStartMs": event.get("audio_start_ms").and_then(Value::as_u64),
            }),
        )]),
        // Aokie's initial contract consumes final transcripts only. Suppress
        // deltas rather than making it accumulate an ambiguous shared type.
        "conversation.item.input_audio_transcription.delta" => Ok(Vec::new()),
        "conversation.item.input_audio_transcription.completed" => Ok(vec![fenced_json(
            fence,
            "formlogic.realtime.input_transcript",
            json!({
                "itemId": safe_id(event.get("item_id"))?,
                "transcript": bounded_content(event.get("transcript"), 64 * 1024)?,
                "final": true,
            }),
        )]),
        "response.output_item.added" => {
            let item_id = safe_id(event.pointer("/item/id"))?;
            let response_id = safe_id(event.get("response_id"))?;
            let output_index = event.get("output_index").and_then(Value::as_u64).ok_or((
                "upstream_protocol",
                "Realtime output item omitted its output index.",
            ))?;
            match event.pointer("/item/type").and_then(Value::as_str) {
                Some("message") => {
                    let forced_response_matches =
                        state.pending_forced_response.as_ref().is_none_or(|forced| {
                            forced.response_id.as_deref() == Some(response_id.as_str())
                        });
                    if event.pointer("/item/role").and_then(Value::as_str) != Some("assistant")
                        || output_index != 0
                        || state.output.as_ref().is_some_and(|output| !output.done)
                        || state
                            .output
                            .as_ref()
                            .is_some_and(|output| output.response_id == response_id)
                        || state.tool_candidate.is_some()
                        || state.pending_tool_result.is_some()
                        || !forced_response_matches
                    {
                        return Err((
                            "upstream_protocol",
                            "Realtime output item ordering or assistant identity was invalid.",
                        ));
                    }
                    state.output = Some(OutputItemState {
                        item_id: item_id.clone(),
                        response_id: response_id.clone(),
                        output_index,
                        done: false,
                        completed: false,
                        terminal: false,
                        audio_bytes: 0,
                        transcript: None,
                    });
                    Ok(vec![fenced_json(
                        fence,
                        "formlogic.realtime.output_item_started",
                        json!({ "itemId": item_id, "responseId": response_id }),
                    )])
                }
                Some("function_call") => {
                    if state.pending_forced_response.is_some() {
                        return Err((
                            "tool_not_allowed",
                            "Host-forced Realtime responses may not invoke tools.",
                        ));
                    }
                    if !state.begun
                        || state.tool_candidate.is_some()
                        || state.pending_tool_result.is_some()
                        || state.output.as_ref().is_some_and(|output| !output.done)
                    {
                        return Err((
                            "upstream_protocol",
                            "Realtime function-call ordering was invalid.",
                        ));
                    }
                    let name = event
                        .pointer("/item/name")
                        .and_then(Value::as_str)
                        .and_then(|name| safe_token(name, 96))
                        .ok_or((
                            "upstream_protocol",
                            "Realtime function call omitted a valid name.",
                        ))?;
                    let tool = allowed_tool(&name).ok_or((
                        "tool_not_allowed",
                        "Realtime requested a tool outside the fixed allow-list.",
                    ))?;
                    if !state.tool_allowed(tool) {
                        return Err((
                            "tool_not_allowed",
                            "Realtime requested a tool that was not enabled for this call.",
                        ));
                    }
                    let provider_call_id = safe_id(event.pointer("/item/call_id"))?;
                    let preamble_item_id = match state
                        .output
                        .as_ref()
                        .filter(|output| output.response_id == response_id)
                    {
                        Some(output)
                            if output_index == 1
                                && output.output_index == 0
                                && output.done
                                && output.completed
                                && !output.terminal =>
                        {
                            Some(output.item_id.clone())
                        }
                        Some(_) => {
                            return Err((
                                "upstream_protocol",
                                "Realtime tool preamble was not one completed index-zero assistant message.",
                            ));
                        }
                        None if output_index == 0 => None,
                        None => {
                            return Err((
                                "upstream_protocol",
                                "Realtime function call had an unsupported output order.",
                            ));
                        }
                    };
                    state.tool_candidate = Some(ToolCandidate {
                        tool,
                        response_id,
                        item_id,
                        provider_call_id,
                        output_index,
                        preamble_item_id,
                        item_done: false,
                        item_completed: false,
                    });
                    Ok(Vec::new())
                }
                _ => Err((
                    "upstream_protocol",
                    "Realtime returned an unsupported output item type.",
                )),
            }
        }
        // These events are advisory streaming progress only. OpenAI documents
        // that even the `done` variant is emitted for interrupted, incomplete,
        // and cancelled responses, so it must never authorize local execution.
        "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
            Ok(Vec::new())
        }
        "response.output_audio.delta" => {
            let item_id = safe_id(event.get("item_id"))?;
            let response_id = safe_id(event.get("response_id"))?;
            if !state.output.as_ref().is_some_and(|output| {
                !output.done && output.item_id == item_id && output.response_id == response_id
            }) {
                return Err((
                    "upstream_protocol",
                    "Realtime audio did not match the active assistant item.",
                ));
            }
            let delta = event
                .get("delta")
                .and_then(Value::as_str)
                .ok_or(("upstream_protocol", "Realtime audio delta was malformed."))?;
            if delta.len() > (MAX_AUDIO_FRAME_BYTES * 4 / 3 + 8) {
                return Err((
                    "upstream_protocol",
                    "Realtime audio delta exceeded the safe limit.",
                ));
            }
            let pcm = base64::engine::general_purpose::STANDARD
                .decode(delta)
                .map_err(|_| ("upstream_protocol", "Realtime audio delta was malformed."))?;
            if pcm.is_empty() || pcm.len() > MAX_AUDIO_FRAME_BYTES || pcm.len() % 2 != 0 {
                return Err((
                    "upstream_protocol",
                    "Realtime audio was not bounded PCM16LE.",
                ));
            }
            if let Some(output) = state.output.as_mut() {
                output.audio_bytes = output.audio_bytes.saturating_add(pcm.len());
            }
            Ok(vec![LocalMessage::Binary(pcm)])
        }
        "response.output_audio_transcript.delta" => Ok(Vec::new()),
        "response.output_audio_transcript.done" => {
            let item_id = safe_id(event.get("item_id"))?;
            let response_id = safe_id(event.get("response_id"))?;
            if !state.output.as_ref().is_some_and(|output| {
                !output.done && output.item_id == item_id && output.response_id == response_id
            }) {
                return Err((
                    "upstream_protocol",
                    "Realtime transcript did not match the active assistant item.",
                ));
            }
            let transcript = bounded_content(event.get("transcript"), 64 * 1024)?;
            if let Some(output) = state.output.as_mut() {
                output.transcript = Some(transcript.clone());
            }
            Ok(vec![fenced_json(
                fence,
                "formlogic.realtime.output_transcript",
                json!({
                    "itemId": item_id,
                    "transcript": transcript,
                    "final": true,
                }),
            )])
        }
        "response.output_item.done" => {
            let item_id = safe_id(event.pointer("/item/id"))?;
            let response_id = safe_id(event.get("response_id"))?;
            if state.tool_candidate.as_ref().is_some_and(|candidate| {
                candidate.item_id == item_id && candidate.response_id == response_id
            }) {
                let candidate = state
                    .tool_candidate
                    .as_mut()
                    .expect("matching function-call candidate");
                if candidate.item_done
                    || event.pointer("/item/type").and_then(Value::as_str) != Some("function_call")
                    || event.pointer("/item/name").and_then(Value::as_str)
                        != Some(candidate.tool.name())
                    || event.pointer("/item/call_id").and_then(Value::as_str)
                        != Some(candidate.provider_call_id.as_str())
                    || event.get("output_index").and_then(Value::as_u64)
                        != Some(candidate.output_index)
                {
                    return Err((
                        "upstream_protocol",
                        "Realtime completed a mismatched function-call item.",
                    ));
                }
                let item_status = event.pointer("/item/status").and_then(Value::as_str);
                if !matches!(item_status, Some("completed" | "incomplete")) {
                    return Err((
                        "upstream_protocol",
                        "Realtime function-call item had an invalid terminal status.",
                    ));
                }
                candidate.item_done = true;
                candidate.item_completed = item_status == Some("completed");
                return Ok(Vec::new());
            }

            let Some(output) = state.output.as_mut() else {
                return Err((
                    "upstream_protocol",
                    "Realtime completed an unknown output item.",
                ));
            };
            let item_status = event.pointer("/item/status").and_then(Value::as_str);
            if output.done
                || output.item_id != item_id
                || output.response_id != response_id
                || event.get("output_index").and_then(Value::as_u64) != Some(output.output_index)
                || event.pointer("/item/type").and_then(Value::as_str) != Some("message")
                || event.pointer("/item/role").and_then(Value::as_str) != Some("assistant")
                || !matches!(item_status, Some("completed" | "incomplete"))
            {
                return Err((
                    "upstream_protocol",
                    "Realtime completed a mismatched output item.",
                ));
            }
            output.done = true;
            output.completed = item_status == Some("completed");
            Ok(vec![fenced_json(
                fence,
                "formlogic.realtime.output_item_done",
                json!({ "itemId": item_id, "responseId": response_id }),
            )])
        }
        "error" => {
            let code = event
                .pointer("/error/code")
                .and_then(Value::as_str)
                .and_then(|code| safe_token(code, 96))
                .unwrap_or_else(|| "provider_error".into());
            // Preserve only the provider's bounded schema-field identifier for
            // diagnostics. Never relay its free-form message, request body, or
            // credential-bearing metadata back to a plugin.
            let parameter = event
                .pointer("/error/param")
                .and_then(Value::as_str)
                .and_then(|parameter| safe_token(parameter, 192));
            Ok(vec![fenced_json(
                fence,
                "formlogic.realtime.error",
                json!({
                    "code": code,
                    "message": "The Realtime provider reported an error.",
                    "fatal": !state.ready,
                    "parameter": parameter,
                }),
            )])
        }
        "response.done" => {
            let status = event.pointer("/response/status").and_then(Value::as_str);
            if !matches!(
                status,
                Some("completed" | "cancelled" | "failed" | "incomplete")
            ) {
                return Err((
                    "upstream_protocol",
                    "Realtime returned a terminal response with an invalid status.",
                ));
            }
            let response_id = safe_id(event.pointer("/response/id"))?;
            if let Some(forced) = state.pending_forced_response.as_ref() {
                let expected_response_id = forced.response_id.as_deref().ok_or((
                    "upstream_protocol",
                    "Realtime forced response completed before its identity was established.",
                ))?;
                if expected_response_id != response_id {
                    return Err((
                        "upstream_protocol",
                        "Realtime output crossed the pending forced-response fence.",
                    ));
                }
                if state.tool_candidate.is_some() {
                    return Err((
                        "tool_not_allowed",
                        "Host-forced Realtime responses may not invoke tools.",
                    ));
                }
            }
            if let Some(output) = state
                .output
                .as_mut()
                .filter(|output| output.response_id == response_id)
            {
                output.terminal = true;
            }

            if state.tool_candidate.is_some() {
                let candidate = state
                    .tool_candidate
                    .take()
                    .expect("checked function-call candidate");
                if candidate.response_id != response_id {
                    return Err((
                        "upstream_protocol",
                        "Realtime terminal response crossed the active function-call fence.",
                    ));
                }
                if status != Some("completed") {
                    return Ok(if matches!(status, Some("failed" | "incomplete")) {
                        vec![local_error(
                            fence,
                            "response_failed",
                            "The Realtime provider could not complete the tool request.",
                            false,
                        )]
                    } else {
                        Vec::new()
                    });
                }
                if !candidate.item_done || !candidate.item_completed {
                    return Err((
                        "upstream_protocol",
                        "Realtime completed a tool response without a completed function-call item.",
                    ));
                }
                let items = event
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .ok_or((
                        "upstream_protocol",
                        "Realtime completed a tool response without its output item.",
                    ))?;
                let expected_items = if candidate.preamble_item_id.is_some() {
                    2
                } else {
                    1
                };
                if items.len() != expected_items {
                    return Err((
                        "upstream_protocol",
                        "Realtime tool response contained an unsupported output sequence.",
                    ));
                }
                if let Some(preamble_item_id) = candidate.preamble_item_id.as_deref() {
                    let preamble = &items[0];
                    if candidate.output_index != 1
                        || preamble.get("id").and_then(Value::as_str) != Some(preamble_item_id)
                        || preamble.get("type").and_then(Value::as_str) != Some("message")
                        || preamble.get("role").and_then(Value::as_str) != Some("assistant")
                        || preamble.get("status").and_then(Value::as_str) != Some("completed")
                        || !state.output.as_ref().is_some_and(|output| {
                            output.item_id == preamble_item_id
                                && output.response_id == response_id
                                && output.output_index == 0
                                && output.done
                                && output.completed
                        })
                    {
                        return Err((
                            "upstream_protocol",
                            "Realtime terminal tool preamble did not match its completed assistant item.",
                        ));
                    }
                } else if candidate.output_index != 0 {
                    return Err((
                        "upstream_protocol",
                        "Realtime single-item tool response had an invalid output index.",
                    ));
                }
                let item = &items[candidate.output_index as usize];
                if item.get("id").and_then(Value::as_str) != Some(candidate.item_id.as_str())
                    || item.get("type").and_then(Value::as_str) != Some("function_call")
                    || item.get("status").and_then(Value::as_str) != Some("completed")
                    || item.get("name").and_then(Value::as_str) != Some(candidate.tool.name())
                    || item.get("call_id").and_then(Value::as_str)
                        != Some(candidate.provider_call_id.as_str())
                {
                    return Err((
                        "upstream_protocol",
                        "Realtime terminal function-call identity did not match its streamed item.",
                    ));
                }
                if state.pending_tool_result.is_some()
                    || state.tool_call_count >= MAX_TOOL_CALLS_PER_SESSION
                    || state
                        .last_tool_call_at
                        .is_some_and(|last| last.elapsed() < MIN_TOOL_CALL_INTERVAL)
                    || state
                        .used_tool_call_ids
                        .iter()
                        .any(|used| used == &candidate.provider_call_id)
                {
                    return Err((
                        "tool_limit",
                        "Realtime tool call count, rate, or replay limit was exceeded.",
                    ));
                }
                let arguments = validate_tool_arguments(
                    candidate.tool,
                    item.get("arguments").and_then(Value::as_str).ok_or((
                        "invalid_tool_arguments",
                        "Realtime terminal function call omitted its arguments.",
                    ))?,
                )?;
                state.tool_call_count = state.tool_call_count.saturating_add(1);
                state.last_tool_call_at = Some(Instant::now());
                state.pending_tool_result = Some(PendingToolResult {
                    tool: candidate.tool,
                    tool_call_id: candidate.provider_call_id.clone(),
                    provider_call_id: candidate.provider_call_id.clone(),
                });
                return Ok(vec![fenced_json(
                    fence,
                    "formlogic.realtime.tool_call",
                    json!({
                        "toolCallId": candidate.provider_call_id,
                        "name": candidate.tool.name(),
                        "arguments": arguments,
                    }),
                )]);
            }

            if event
                .pointer("/response/output")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("type").and_then(Value::as_str) == Some("function_call")
                    })
                })
            {
                return Err((
                    "upstream_protocol",
                    "Realtime completed an untracked function call.",
                ));
            }

            // `response.output_item.done` normally precedes `response.done`.
            // Recover defensively when an interrupted/terminal response omits
            // it: retire the exact active item before Aokie sees any error, so
            // its binary-audio fence cannot remain abandoned. A completed item
            // stays retained for the normal post-completion playout-tail
            // truncation path.
            let mut messages = Vec::with_capacity(3);
            if let Some(output) = state.output.as_mut().filter(|output| !output.done) {
                if output.response_id != response_id {
                    return Err((
                        "upstream_protocol",
                        "Realtime terminal response did not match the active assistant item.",
                    ));
                }
                let item_id = output.item_id.clone();
                let response_id = output.response_id.clone();
                output.done = true;
                output.completed = status == Some("completed");
                messages.push(fenced_json(
                    fence,
                    "formlogic.realtime.output_item_done",
                    json!({
                        "itemId": item_id,
                        "responseId": response_id,
                    }),
                ));
            }
            if let Some(forced) = state.pending_forced_response.take() {
                if forced.purpose == ForcedResponsePurpose::FinishCallFarewell {
                    let tool_call_id = forced.tool_call_id.ok_or((
                        "upstream_protocol",
                        "Realtime finish-call farewell omitted its tool identity.",
                    ))?;
                    let farewell_ok = status == Some("completed")
                        && state.output.as_ref().is_some_and(|output| {
                            output.done
                                && output.response_id == response_id
                                && output.audio_bytes > 0
                                && output
                                    .transcript
                                    .as_deref()
                                    .is_some_and(is_brief_non_question_farewell)
                                && completed_farewell_item_matches(
                                    event.pointer("/response").unwrap_or(&Value::Null),
                                    output,
                                )
                        });
                    if farewell_ok {
                        let output = state.output.as_ref().expect("validated farewell output");
                        messages.push(fenced_json(
                            fence,
                            "formlogic.realtime.hangup_requested",
                            json!({
                                "toolCallId": tool_call_id,
                                "responseId": response_id,
                                "itemId": output.item_id,
                            }),
                        ));
                    } else if status == Some("completed") {
                        messages.push(local_error(
                            fence,
                            "farewell_not_confirmed",
                            "The finish-call response was not a completed audible non-question farewell.",
                            false,
                        ));
                    }
                }
            }
            if matches!(status, Some("failed" | "incomplete")) {
                messages.push(local_error(
                    fence,
                    "response_failed",
                    "The Realtime provider could not complete the response.",
                    false,
                ));
            }
            Ok(messages)
        }
        _ => Ok(Vec::new()),
    }
}

fn safe_id(value: Option<&Value>) -> Result<String, (&'static str, &'static str)> {
    value
        .and_then(Value::as_str)
        .and_then(|value| safe_token(value, 512))
        .ok_or((
            "upstream_protocol",
            "Realtime provider returned an invalid item fence.",
        ))
}

fn safe_token(value: &str, max_bytes: usize) -> Option<String> {
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_string())
}

fn bounded_content(
    value: Option<&Value>,
    max_bytes: usize,
) -> Result<String, (&'static str, &'static str)> {
    let value = value.and_then(Value::as_str).ok_or((
        "upstream_protocol",
        "Realtime transcript event was malformed.",
    ))?;
    if value.len() > max_bytes || value.contains('\0') {
        return Err((
            "upstream_protocol",
            "Realtime transcript event exceeded the safe limit.",
        ));
    }
    Ok(value.to_string())
}

fn exact_fence_matches(fence: &CallFence, call_id: &str, generation: u64) -> bool {
    call_id == fence.call_id && generation == fence.generation
}

fn fenced_json(fence: &CallFence, kind: &str, extra: Value) -> LocalMessage {
    let mut object = extra.as_object().cloned().unwrap_or_default();
    object.insert("type".into(), Value::String(kind.into()));
    object.insert("callId".into(), Value::String(fence.call_id.clone()));
    object.insert("generation".into(), Value::from(fence.generation));
    LocalMessage::Text(Value::Object(object).to_string())
}

fn local_error(fence: &CallFence, code: &str, message: &str, fatal: bool) -> LocalMessage {
    fenced_json(
        fence,
        "formlogic.realtime.error",
        json!({ "code": code, "message": message, "fatal": fatal }),
    )
}

async fn send_local<S>(sink: &mut S, message: LocalMessage) -> bool
where
    S: Sink<LocalMessage> + Unpin,
{
    timeout(SEND_TIMEOUT, sink.send(message))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn send_upstream<S>(sink: &mut S, message: UpstreamMessage) -> bool
where
    S: Sink<UpstreamMessage> + Unpin,
{
    timeout(SEND_TIMEOUT, sink.send(message))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn close_local(local: &mut WebSocket, code: u16, reason: &'static str) {
    let reason = if reason.len() > 120 {
        "Realtime protocol error"
    } else {
        reason
    };
    let _ = timeout(
        SEND_TIMEOUT,
        local.send(LocalMessage::Close(Some(LocalCloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::Request;

    fn start(turn_detection: Option<TurnDetectionInput>) -> StartFrame {
        StartFrame {
            kind: "formlogic.realtime.start".into(),
            call_id: "call-1".into(),
            generation: 7,
            destination_origin: Some("https://api.openai.com".into()),
            instructions: "Be concise.".into(),
            greeting: "Hello".into(),
            voice: Some("marin".into()),
            turn_detection,
            max_output_tokens: Some(256),
            allow_business_lookup: false,
            allow_finish_call: false,
        }
    }

    fn add_output(state: &mut SessionState, fence: &CallFence) {
        let event = json!({
            "type": "response.output_item.added",
            "response_id": "response-1",
            "output_index": 0,
            "item": { "id": "item-1", "type": "message", "role": "assistant" },
        });
        let mut messages = translate_server_event(&event, fence, state).unwrap();
        assert_eq!(messages.len(), 1, "one item-start control");
        let message = messages.pop().expect("item-start control");
        let LocalMessage::Text(text) = message else {
            panic!("text item-start expected");
        };
        assert!(text.contains("formlogic.realtime.output_item_started"));
    }

    fn response_done(response_id: &str, status: &str) -> Value {
        json!({
            "type": "response.done",
            "response": { "id": response_id, "status": status },
        })
    }

    fn text_event(message: &LocalMessage) -> Value {
        let LocalMessage::Text(text) = message else {
            panic!("text event expected");
        };
        serde_json::from_str(text).expect("valid local JSON event")
    }

    fn call_fence() -> CallFence {
        CallFence {
            call_id: "call-1".into(),
            generation: 7,
        }
    }

    fn tool_state(lookup: bool, finish: bool) -> SessionState {
        let mut state = SessionState::new_with_tools(String::new(), lookup, finish);
        state.ready = true;
        state.begun = true;
        state
    }

    fn complete_tool_response(
        state: &mut SessionState,
        fence: &CallFence,
        name: &str,
        arguments: &str,
        response_status: &str,
        item_status: &str,
    ) -> Result<Vec<LocalMessage>, (&'static str, &'static str)> {
        let added = json!({
            "type": "response.output_item.added",
            "response_id": "tool-response-1",
            "output_index": 0,
            "item": {
                "id": "tool-item-1",
                "type": "function_call",
                "status": "in_progress",
                "name": name,
                "call_id": "provider-tool-call-1",
                "arguments": "",
            },
        });
        assert!(translate_server_event(&added, fence, state)?.is_empty());

        let done = json!({
            "type": "response.output_item.done",
            "response_id": "tool-response-1",
            "output_index": 0,
            "item": {
                "id": "tool-item-1",
                "type": "function_call",
                "status": item_status,
                "name": name,
                "call_id": "provider-tool-call-1",
                "arguments": arguments,
            },
        });
        assert!(translate_server_event(&done, fence, state)?.is_empty());

        translate_server_event(
            &json!({
                "type": "response.done",
                "response": {
                    "id": "tool-response-1",
                    "status": response_status,
                    "output": [{
                        "id": "tool-item-1",
                        "type": "function_call",
                        "status": item_status,
                        "name": name,
                        "call_id": "provider-tool-call-1",
                        "arguments": arguments,
                    }],
                },
            }),
            fence,
            state,
        )
    }

    #[tokio::test]
    async fn pinned_websocket_handshake_uses_exact_path_model_and_secret_header() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, peer) = listener.accept().await.unwrap();
            assert!(peer.ip().is_loopback());
            let mut websocket = accept_hdr_async(stream, |request: &Request, response| {
                assert_eq!(request.uri().path(), "/v1/realtime");
                assert_eq!(request.uri().query(), Some("model=gpt-realtime-2.1-mini"));
                assert_eq!(
                    request.headers().get(AUTHORIZATION),
                    Some(&HeaderValue::from_static("Bearer fake-test-key"))
                );
                assert_eq!(
                    request.headers().get(reqwest::header::USER_AGENT),
                    Some(&HeaderValue::from_static("FormLogic-Desktop/Realtime"))
                );
                Ok(response)
            })
            .await
            .unwrap();
            let close = timeout(Duration::from_secs(2), websocket.next())
                .await
                .expect("client should close the fake upstream");
            assert!(close.is_some());
        });

        let mut target = egress::validate_websocket(
            &format!("http://{address}"),
            "/v1/realtime",
            egress::LocalAccess::AllowLocal,
        )
        .unwrap();
        target
            .url
            .query_pairs_mut()
            .append_pair("model", "gpt-realtime-2.1-mini");
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer fake-test-key"),
        );
        let prepared = PreparedRealtime {
            target,
            headers,
            model: "gpt-realtime-2.1-mini".into(),
            destination_origin: format!("http://{address}"),
        };

        let mut upstream = connect_upstream(&prepared)
            .await
            .expect("fake upstream handshake should succeed");
        upstream.close(None).await.unwrap();
        server.await.unwrap();
    }

    #[test]
    fn session_update_forces_pcm_audio_vad_and_no_tools() {
        let UpstreamMessage::Text(text) =
            session_update(&start(None), "gpt-realtime-2.1-mini").unwrap()
        else {
            panic!("text event expected");
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "session.update");
        assert_eq!(value["session"]["output_modalities"], json!(["audio"]));
        assert_eq!(value["session"]["audio"]["input"]["format"]["rate"], 24000);
        assert_eq!(
            value["session"]["audio"]["output"]["format"]["type"],
            "audio/pcm"
        );
        assert_eq!(value["session"]["audio"]["output"]["format"]["rate"], 24000);
        assert_eq!(
            value["session"]["audio"]["input"]["noise_reduction"]["type"],
            "near_field"
        );
        assert_eq!(
            value["session"]["audio"]["input"]["turn_detection"]["interrupt_response"],
            true
        );
        assert_eq!(value["session"]["tools"], json!([]));
        assert_eq!(value["session"]["tool_choice"], "none");
        assert_eq!(value["session"]["model"], "gpt-realtime-2.1-mini");
    }

    #[test]
    fn session_tools_are_fixed_and_enabled_only_by_signed_start_booleans() {
        let mut configured = start(None);
        configured.allow_business_lookup = true;
        configured.allow_finish_call = true;
        let UpstreamMessage::Text(text) =
            session_update(&configured, "gpt-realtime-2.1-mini").unwrap()
        else {
            panic!("text event expected");
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        let tools = value["session"]["tools"].as_array().expect("tool array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "lookup_business_data");
        assert_eq!(tools[0]["parameters"]["additionalProperties"], false);
        assert_eq!(
            tools[0]["parameters"]["properties"]["question"]["maxLength"],
            500
        );
        assert_eq!(tools[1]["name"], "finish_call");
        assert_eq!(tools[1]["parameters"]["additionalProperties"], false);
        assert_eq!(tools[1]["parameters"]["properties"], json!({}));
        assert_eq!(value["session"]["tool_choice"], "auto");
    }

    #[test]
    fn argument_stream_events_alone_never_authorize_a_tool_call() {
        let fence = call_fence();
        let mut state = tool_state(true, true);
        for kind in [
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
        ] {
            let messages = translate_server_event(
                &json!({
                    "type": kind,
                    "response_id": "response-untrusted",
                    "item_id": "item-untrusted",
                    "call_id": "call-untrusted",
                    "name": "finish_call",
                    "arguments": "{}",
                    "delta": "{}",
                    "output_index": 0,
                }),
                &fence,
                &mut state,
            )
            .unwrap();
            assert!(messages.is_empty());
        }
        assert!(state.tool_candidate.is_none());
        assert!(state.pending_tool_result.is_none());
    }

    #[test]
    fn only_completed_exact_function_call_relays_a_fenced_tool_call() {
        let fence = call_fence();
        let mut state = tool_state(true, false);
        let messages = complete_tool_response(
            &mut state,
            &fence,
            "lookup_business_data",
            r#"{"question":"availability 2026-08-12"}"#,
            "completed",
            "completed",
        )
        .unwrap();
        assert_eq!(messages.len(), 1);
        let call = text_event(&messages[0]);
        assert_eq!(call["type"], "formlogic.realtime.tool_call");
        assert_eq!(call["callId"], "call-1");
        assert_eq!(call["generation"], 7);
        assert_eq!(call["toolCallId"], "provider-tool-call-1");
        assert_eq!(call["name"], "lookup_business_data");
        assert_eq!(call["arguments"]["question"], "availability 2026-08-12");
        assert!(state.pending_tool_result.is_some());
    }

    #[test]
    fn completed_assistant_preamble_then_one_tool_call_is_accepted_in_exact_order() {
        let fence = call_fence();
        let mut state = tool_state(true, false);

        let started = translate_server_event(
            &json!({
                "type": "response.output_item.added",
                "response_id": "mixed-response-1",
                "output_index": 0,
                "item": {
                    "id": "preamble-item-1",
                    "type": "message",
                    "role": "assistant",
                    "status": "in_progress",
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(
            text_event(&started[0])["type"],
            "formlogic.realtime.output_item_started"
        );
        let pcm = translate_server_event(
            &json!({
                "type": "response.output_audio.delta",
                "response_id": "mixed-response-1",
                "item_id": "preamble-item-1",
                "delta": base64::engine::general_purpose::STANDARD.encode([0_u8, 0]),
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert!(matches!(&pcm[0], LocalMessage::Binary(bytes) if !bytes.is_empty()));
        let preamble_done = translate_server_event(
            &json!({
                "type": "response.output_item.done",
                "response_id": "mixed-response-1",
                "output_index": 0,
                "item": {
                    "id": "preamble-item-1",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(
            text_event(&preamble_done[0])["type"],
            "formlogic.realtime.output_item_done"
        );

        assert!(translate_server_event(
            &json!({
                "type": "response.output_item.added",
                "response_id": "mixed-response-1",
                "output_index": 1,
                "item": {
                    "id": "mixed-tool-item-1",
                    "type": "function_call",
                    "status": "in_progress",
                    "name": "lookup_business_data",
                    "call_id": "mixed-provider-call-1",
                    "arguments": "",
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap()
        .is_empty());
        assert!(translate_server_event(
            &json!({
                "type": "response.output_item.done",
                "response_id": "mixed-response-1",
                "output_index": 1,
                "item": {
                    "id": "mixed-tool-item-1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "lookup_business_data",
                    "call_id": "mixed-provider-call-1",
                    "arguments": "{\"question\":\"availability\"}",
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap()
        .is_empty());

        let calls = translate_server_event(
            &json!({
                "type": "response.done",
                "response": {
                    "id": "mixed-response-1",
                    "status": "completed",
                    "output": [
                        {
                            "id": "preamble-item-1",
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                        },
                        {
                            "id": "mixed-tool-item-1",
                            "type": "function_call",
                            "status": "completed",
                            "name": "lookup_business_data",
                            "call_id": "mixed-provider-call-1",
                            "arguments": "{\"question\":\"availability\"}",
                        }
                    ],
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(calls.len(), 1);
        let call = text_event(&calls[0]);
        assert_eq!(call["type"], "formlogic.realtime.tool_call");
        assert_eq!(call["toolCallId"], "mixed-provider-call-1");
        assert_eq!(call["arguments"]["question"], "availability");
    }

    #[test]
    fn cancelled_and_incomplete_function_calls_are_never_executed() {
        let fence = call_fence();
        for (response_status, item_status) in
            [("cancelled", "incomplete"), ("incomplete", "incomplete")]
        {
            let mut state = tool_state(true, false);
            let messages = complete_tool_response(
                &mut state,
                &fence,
                "lookup_business_data",
                r#"{"question":"availability"}"#,
                response_status,
                item_status,
            )
            .unwrap();
            assert!(messages
                .iter()
                .all(|message| { text_event(message)["type"] != "formlogic.realtime.tool_call" }));
            assert!(state.pending_tool_result.is_none());
            assert_eq!(state.tool_call_count, 0);
        }
    }

    #[test]
    fn unknown_tools_and_extra_arguments_fail_closed() {
        let fence = call_fence();
        let mut unknown = tool_state(true, true);
        let event = json!({
            "type": "response.output_item.added",
            "response_id": "tool-response-1",
            "output_index": 0,
            "item": {
                "id": "tool-item-1",
                "type": "function_call",
                "name": "arbitrary_service_action",
                "call_id": "provider-tool-call-1",
            },
        });
        assert_eq!(
            translate_server_event(&event, &fence, &mut unknown)
                .unwrap_err()
                .0,
            "tool_not_allowed"
        );

        let mut extra = tool_state(true, false);
        let error = complete_tool_response(
            &mut extra,
            &fence,
            "lookup_business_data",
            r#"{"question":"availability","endpoint":"https://evil.example"}"#,
            "completed",
            "completed",
        )
        .unwrap_err();
        assert_eq!(error.0, "invalid_tool_arguments");
        assert!(extra.pending_tool_result.is_none());

        let mut finish_extra = tool_state(false, true);
        let error = complete_tool_response(
            &mut finish_extra,
            &fence,
            "finish_call",
            r#"{"reason":"caller said goodbye"}"#,
            "completed",
            "completed",
        )
        .unwrap_err();
        assert_eq!(error.0, "invalid_tool_arguments");

        let mut oversized = tool_state(true, false);
        let question = "x".repeat(501);
        let arguments = serde_json::to_string(&json!({ "question": question })).unwrap();
        let error = complete_tool_response(
            &mut oversized,
            &fence,
            "lookup_business_data",
            &arguments,
            "completed",
            "completed",
        )
        .unwrap_err();
        assert_eq!(error.0, "invalid_tool_arguments");
    }

    #[test]
    fn tool_result_is_one_use_and_sends_output_before_a_tools_none_response() {
        let fence = call_fence();
        let mut state = tool_state(true, false);
        complete_tool_response(
            &mut state,
            &fence,
            "lookup_business_data",
            r#"{"question":"availability"}"#,
            "completed",
            "completed",
        )
        .unwrap();

        let events = tool_result_events(
            &mut state,
            "provider-tool-call-1",
            "lookup_business_data",
            true,
            json!({ "digest": "Open at 10 AM" }),
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        let UpstreamMessage::Text(item_text) = &events[0] else {
            panic!("function output must be text JSON");
        };
        let item: Value = serde_json::from_str(item_text).unwrap();
        assert_eq!(item["type"], "conversation.item.create");
        assert_eq!(item["item"]["type"], "function_call_output");
        assert_eq!(item["item"]["call_id"], "provider-tool-call-1");
        let encoded_output = item["item"]["output"].as_str().unwrap();
        let encoded_output: Value = serde_json::from_str(encoded_output).unwrap();
        assert_eq!(encoded_output["ok"], true);
        assert_eq!(encoded_output["output"]["digest"], "Open at 10 AM");

        let UpstreamMessage::Text(response_text) = &events[1] else {
            panic!("response.create must be text JSON");
        };
        let response: Value = serde_json::from_str(response_text).unwrap();
        assert_eq!(response["type"], "response.create");
        assert_eq!(response["response"]["tool_choice"], "none");
        assert_eq!(response["response"]["tools"], json!([]));

        let replay = tool_result_events(
            &mut state,
            "provider-tool-call-1",
            "lookup_business_data",
            true,
            json!({ "digest": "must not be sent twice" }),
        )
        .unwrap_err();
        assert_eq!(replay.0, "duplicate_tool_result");
    }

    #[test]
    fn provider_tool_calls_fail_closed_in_greeting_and_lookup_continuation() {
        let fence = call_fence();
        let mut greeting = SessionState::new("Welcome to FormLogic".into());
        greeting.ready = true;
        let Some(UpstreamMessage::Text(greeting_create)) = begin_response(&mut greeting) else {
            panic!("greeting response.create expected");
        };
        let greeting_create: Value = serde_json::from_str(&greeting_create).unwrap();
        assert_eq!(greeting_create["response"]["tools"], json!([]));
        assert_eq!(greeting_create["response"]["tool_choice"], "none");
        assert_eq!(
            greeting_create["response"]["metadata"]["formlogic_purpose"],
            "greeting"
        );
        translate_server_event(
            &json!({
                "type": "response.created",
                "response": {
                    "id": "greeting-response-1",
                    "status": "in_progress",
                    "metadata": { "formlogic_purpose": "greeting" },
                },
            }),
            &fence,
            &mut greeting,
        )
        .unwrap();
        let greeting_tool = json!({
            "type": "response.output_item.added",
            "response_id": "greeting-response-1",
            "output_index": 0,
            "item": {
                "id": "forbidden-greeting-tool",
                "type": "function_call",
                "name": "finish_call",
                "call_id": "forbidden-greeting-call",
            },
        });
        assert_eq!(
            translate_server_event(&greeting_tool, &fence, &mut greeting)
                .unwrap_err()
                .0,
            "tool_not_allowed"
        );

        let mut lookup = tool_state(true, false);
        complete_tool_response(
            &mut lookup,
            &fence,
            "lookup_business_data",
            r#"{"question":"availability"}"#,
            "completed",
            "completed",
        )
        .unwrap();
        let continuation = tool_result_events(
            &mut lookup,
            "provider-tool-call-1",
            "lookup_business_data",
            true,
            json!({ "answer": "Open" }),
        )
        .unwrap();
        let UpstreamMessage::Text(continuation_create) = &continuation[1] else {
            panic!("lookup response.create expected");
        };
        let continuation_create: Value = serde_json::from_str(continuation_create).unwrap();
        assert_eq!(continuation_create["response"]["tools"], json!([]));
        assert_eq!(continuation_create["response"]["tool_choice"], "none");
        assert_eq!(
            continuation_create["response"]["metadata"]["formlogic_purpose"],
            "lookup_business_data_continuation"
        );
        translate_server_event(
            &json!({
                "type": "response.created",
                "response": {
                    "id": "lookup-continuation-1",
                    "status": "in_progress",
                    "metadata": {
                        "formlogic_purpose": "lookup_business_data_continuation",
                        "formlogic_tool_call_id": "provider-tool-call-1",
                    },
                },
            }),
            &fence,
            &mut lookup,
        )
        .unwrap();
        let continuation_tool = json!({
            "type": "response.output_item.added",
            "response_id": "lookup-continuation-1",
            "output_index": 0,
            "item": {
                "id": "forbidden-continuation-tool",
                "type": "function_call",
                "name": "lookup_business_data",
                "call_id": "forbidden-continuation-call",
            },
        });
        assert_eq!(
            translate_server_event(&continuation_tool, &fence, &mut lookup)
                .unwrap_err()
                .0,
            "tool_not_allowed"
        );
    }

    #[test]
    fn successful_finish_call_hangs_up_only_after_completed_audible_farewell() {
        let fence = call_fence();
        let mut state = tool_state(false, true);
        let calls = complete_tool_response(
            &mut state,
            &fence,
            "finish_call",
            r#"{}"#,
            "completed",
            "completed",
        )
        .unwrap();
        assert_eq!(text_event(&calls[0])["name"], "finish_call");

        let continuation = tool_result_events(
            &mut state,
            "provider-tool-call-1",
            "finish_call",
            true,
            json!({ "accepted": true }),
        )
        .unwrap();
        let UpstreamMessage::Text(create_text) = &continuation[1] else {
            panic!("response.create must be JSON text");
        };
        let create: Value = serde_json::from_str(create_text).unwrap();
        assert_eq!(create["response"]["tool_choice"], "none");
        assert_eq!(create["response"]["tools"], json!([]));
        assert_eq!(
            create["response"]["metadata"]["formlogic_tool_call_id"],
            "provider-tool-call-1"
        );

        assert!(translate_server_event(
            &json!({
                "type": "response.created",
                "response": {
                    "id": "farewell-response-1",
                    "status": "in_progress",
                    "metadata": {
                        "formlogic_purpose": "finish_call_farewell",
                        "formlogic_tool_call_id": "provider-tool-call-1",
                    },
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap()
        .is_empty());
        let started = translate_server_event(
            &json!({
                "type": "response.output_item.added",
                "response_id": "farewell-response-1",
                "output_index": 0,
                "item": {
                    "id": "farewell-item-1",
                    "type": "message",
                    "role": "assistant",
                    "status": "in_progress",
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(
            text_event(&started[0])["type"],
            "formlogic.realtime.output_item_started"
        );
        let audio = translate_server_event(
            &json!({
                "type": "response.output_audio.delta",
                "response_id": "farewell-response-1",
                "item_id": "farewell-item-1",
                "delta": base64::engine::general_purpose::STANDARD.encode([0_u8, 0]),
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert!(matches!(&audio[0], LocalMessage::Binary(bytes) if !bytes.is_empty()));
        translate_server_event(
            &json!({
                "type": "response.output_audio_transcript.done",
                "response_id": "farewell-response-1",
                "item_id": "farewell-item-1",
                "transcript": "Thanks for calling. Goodbye!",
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        translate_server_event(
            &json!({
                "type": "response.output_item.done",
                "response_id": "farewell-response-1",
                "output_index": 0,
                "item": {
                    "id": "farewell-item-1",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        let terminal = translate_server_event(
            &json!({
                "type": "response.done",
                "response": {
                    "id": "farewell-response-1",
                    "status": "completed",
                    "output": [{
                        "id": "farewell-item-1",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                    }],
                },
            }),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(terminal.len(), 1);
        let hangup = text_event(&terminal[0]);
        assert_eq!(hangup["type"], "formlogic.realtime.hangup_requested");
        assert_eq!(hangup["callId"], "call-1");
        assert_eq!(hangup["generation"], 7);
        assert_eq!(hangup["toolCallId"], "provider-tool-call-1");
        assert_eq!(hangup["responseId"], "farewell-response-1");
        assert_eq!(hangup["itemId"], "farewell-item-1");
        assert!(state.pending_forced_response.is_none());
    }

    #[test]
    fn question_or_silent_output_is_never_a_finish_call_farewell() {
        assert!(!is_brief_non_question_farewell(
            "Can I help with anything else?"
        ));
        assert!(!is_brief_non_question_farewell(""));
        assert!(is_brief_non_question_farewell(
            "Thank you for calling. Take care!"
        ));

        let fence = call_fence();
        for (audio_bytes, transcript) in [
            (2, Some("Can I help with anything else?")),
            (0, Some("Thank you for calling. Goodbye!")),
        ] {
            let mut state = tool_state(false, true);
            state.pending_forced_response = Some(PendingForcedResponse {
                purpose: ForcedResponsePurpose::FinishCallFarewell,
                tool_call_id: Some("provider-tool-call-1".into()),
                response_id: Some("farewell-response-1".into()),
            });
            state.output = Some(OutputItemState {
                item_id: "farewell-item-1".into(),
                response_id: "farewell-response-1".into(),
                output_index: 0,
                done: true,
                completed: true,
                terminal: true,
                audio_bytes,
                transcript: transcript.map(str::to_string),
            });

            let terminal = translate_server_event(
                &json!({
                    "type": "response.done",
                    "response": {
                        "id": "farewell-response-1",
                        "status": "completed",
                        "output": [{
                            "id": "farewell-item-1",
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                        }],
                    },
                }),
                &fence,
                &mut state,
            )
            .unwrap();
            assert!(terminal.iter().all(|message| {
                text_event(message)["type"] != "formlogic.realtime.hangup_requested"
            }));
            assert_eq!(text_event(&terminal[0])["code"], "farewell_not_confirmed");
            assert!(state.pending_forced_response.is_none());
        }
    }

    #[test]
    fn pending_finish_farewell_rejects_crossed_response_identity() {
        let fence = call_fence();
        let mut state = tool_state(false, true);
        state.pending_forced_response = Some(PendingForcedResponse {
            purpose: ForcedResponsePurpose::FinishCallFarewell,
            tool_call_id: Some("provider-tool-call-1".into()),
            response_id: Some("farewell-response-1".into()),
        });

        let added = json!({
            "type": "response.output_item.added",
            "response_id": "unrelated-response",
            "output_index": 0,
            "item": {
                "id": "unrelated-item",
                "type": "message",
                "role": "assistant",
                "status": "in_progress",
            },
        });
        assert_eq!(
            translate_server_event(&added, &fence, &mut state)
                .unwrap_err()
                .0,
            "upstream_protocol"
        );

        let terminal = response_done("unrelated-response", "cancelled");
        assert_eq!(
            translate_server_event(&terminal, &fence, &mut state)
                .unwrap_err()
                .0,
            "upstream_protocol"
        );
        assert!(state.pending_forced_response.is_some());
    }

    #[test]
    fn semantic_vad_is_bounded_and_interruptible() {
        let input = TurnDetectionInput::Config(TurnDetectionConfig {
            kind: "semantic_vad".into(),
            threshold: None,
            prefix_padding_ms: None,
            silence_duration_ms: None,
            idle_timeout_ms: None,
            eagerness: Some("high".into()),
        });
        let value = normalized_turn_detection(Some(&input)).unwrap();
        assert_eq!(value["type"], "semantic_vad");
        assert_eq!(value["eagerness"], "high");
        assert_eq!(value["create_response"], true);
        assert_eq!(value["interrupt_response"], true);
    }

    #[test]
    fn upstream_audio_becomes_bounded_raw_pcm() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 2,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        let pcm = vec![1u8, 0, 2, 0];
        let event = json!({
            "type": "response.output_audio.delta",
            "item_id": "item-1",
            "response_id": "response-1",
            "delta": base64::engine::general_purpose::STANDARD.encode(&pcm),
        });
        let mut translated = translate_server_event(&event, &fence, &mut state).unwrap();
        assert_eq!(translated.len(), 1, "one binary event");
        let translated = translated.pop().expect("binary event");
        assert_eq!(translated, LocalMessage::Binary(pcm));
        assert_eq!(
            state.output.as_ref().map(|output| output.item_id.as_str()),
            Some("item-1")
        );
    }

    #[test]
    fn every_control_event_is_call_fenced() {
        let fence = CallFence {
            call_id: "call-abc".into(),
            generation: 42,
        };
        let LocalMessage::Text(text) = fenced_json(
            &fence,
            "formlogic.realtime.ready",
            json!({ "sampleRate": 24000 }),
        ) else {
            panic!("text event expected");
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["callId"], "call-abc");
        assert_eq!(value["generation"], 42);
    }

    #[test]
    fn output_delta_refuses_oversized_or_odd_pcm() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        let event = json!({
            "type": "response.output_audio.delta",
            "item_id": "item-1",
            "response_id": "response-1",
            "delta": base64::engine::general_purpose::STANDARD.encode([1u8]),
        });
        assert!(translate_server_event(&event, &fence, &mut state).is_err());
    }

    #[test]
    fn output_items_cannot_overlap_or_cross_response_fences() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        let overlap = json!({
            "type": "response.output_item.added",
            "response_id": "response-2",
            "output_index": 0,
            "item": { "id": "item-2", "type": "message", "role": "assistant" },
        });
        assert!(translate_server_event(&overlap, &fence, &mut state).is_err());
        let mismatch = json!({
            "type": "response.output_audio.delta",
            "item_id": "item-2",
            "response_id": "response-2",
            "delta": base64::engine::general_purpose::STANDARD.encode([0u8, 0]),
        });
        assert!(translate_server_event(&mismatch, &fence, &mut state).is_err());
    }

    #[test]
    fn only_assistant_message_items_can_open_the_binary_audio_lane() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        for item in [
            json!({ "id": "item-1", "type": "message", "role": "user" }),
            json!({ "id": "item-1", "type": "function_call", "role": "assistant" }),
        ] {
            let event = json!({
                "type": "response.output_item.added",
                "response_id": "response-1",
                "output_index": 0,
                "item": item,
            });
            assert!(translate_server_event(&event, &fence, &mut state).is_err());
        }
    }

    #[test]
    fn terminal_output_identity_survives_for_playout_tail_truncation() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        let done = json!({
            "type": "response.output_item.done",
            "response_id": "response-1",
            "output_index": 0,
            "item": {
                "id": "item-1",
                "type": "message",
                "role": "assistant",
                "status": "completed",
            },
        });
        translate_server_event(&done, &fence, &mut state).unwrap();
        assert!(state.output.as_ref().is_some_and(|output| output.done));
        let Some(UpstreamMessage::Text(text)) = truncate_event(&state, "item-1", 375) else {
            panic!("completed playout tail must remain truncatable");
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "conversation.item.truncate");
        assert_eq!(value["audio_end_ms"], 375);
    }

    #[test]
    fn active_incomplete_response_retires_item_before_recoverable_error() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);

        let messages = translate_server_event(
            &response_done("response-1", "incomplete"),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(messages.len(), 2);
        let done = text_event(&messages[0]);
        assert_eq!(done["type"], "formlogic.realtime.output_item_done");
        assert_eq!(done["itemId"], "item-1");
        assert_eq!(done["responseId"], "response-1");
        assert_eq!(done["callId"], "call-1");
        assert_eq!(done["generation"], 1);
        let error = text_event(&messages[1]);
        assert_eq!(error["type"], "formlogic.realtime.error");
        assert_eq!(error["code"], "response_failed");
        assert_eq!(error["fatal"], false);
        assert!(state.output.as_ref().is_some_and(|output| output.done));
    }

    #[test]
    fn already_done_incomplete_response_emits_only_recoverable_error() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        let item_done = json!({
            "type": "response.output_item.done",
            "response_id": "response-1",
            "output_index": 0,
            "item": {
                "id": "item-1",
                "type": "message",
                "role": "assistant",
                "status": "completed",
            },
        });
        assert_eq!(
            translate_server_event(&item_done, &fence, &mut state)
                .unwrap()
                .len(),
            1
        );

        let messages = translate_server_event(
            &response_done("response-1", "incomplete"),
            &fence,
            &mut state,
        )
        .unwrap();
        assert_eq!(messages.len(), 1);
        let error = text_event(&messages[0]);
        assert_eq!(error["type"], "formlogic.realtime.error");
        assert_eq!(error["fatal"], false);
        assert!(state.output.as_ref().is_some_and(|output| output.done));
    }

    #[test]
    fn provider_error_exposes_only_a_bounded_parameter_identifier() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        let messages = translate_server_event(
            &json!({
                "type": "error",
                "error": {
                    "code": "missing_required_parameter",
                    "param": "session.audio.output.voice",
                    "message": "free-form upstream detail must not cross the bridge"
                }
            }),
            &fence,
            &mut state,
        )
        .unwrap();

        let error = text_event(&messages[0]);
        assert_eq!(error["type"], "formlogic.realtime.error");
        assert_eq!(error["code"], "missing_required_parameter");
        assert_eq!(error["parameter"], "session.audio.output.voice");
        assert_eq!(error["message"], "The Realtime provider reported an error.");
        assert!(!error.to_string().contains("free-form upstream detail"));
    }

    #[test]
    fn next_output_item_is_accepted_after_synthetic_retirement() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        translate_server_event(&response_done("response-1", "failed"), &fence, &mut state).unwrap();

        let next = json!({
            "type": "response.output_item.added",
            "response_id": "response-2",
            "output_index": 0,
            "item": { "id": "item-2", "type": "message", "role": "assistant" },
        });
        let messages = translate_server_event(&next, &fence, &mut state).unwrap();
        assert_eq!(messages.len(), 1);
        let started = text_event(&messages[0]);
        assert_eq!(started["type"], "formlogic.realtime.output_item_started");
        assert_eq!(started["itemId"], "item-2");
        assert!(state.output.as_ref().is_some_and(|output| {
            !output.done && output.item_id == "item-2" && output.response_id == "response-2"
        }));
    }

    #[test]
    fn completed_and_cancelled_responses_retire_an_active_item_without_error() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        for status in ["completed", "cancelled"] {
            let mut state = SessionState::new(String::new());
            add_output(&mut state, &fence);
            let messages =
                translate_server_event(&response_done("response-1", status), &fence, &mut state)
                    .unwrap();
            assert_eq!(messages.len(), 1, "{status}");
            assert_eq!(
                text_event(&messages[0])["type"],
                "formlogic.realtime.output_item_done",
                "{status}"
            );
            assert!(state.output.as_ref().is_some_and(|output| output.done));
        }
    }

    #[test]
    fn terminal_response_must_match_the_active_output_identity() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        add_output(&mut state, &fence);
        assert!(translate_server_event(
            &response_done("response-other", "cancelled"),
            &fence,
            &mut state,
        )
        .is_err());
        assert!(state
            .output
            .as_ref()
            .is_some_and(|output| !output.done && output.response_id == "response-1"));
    }

    #[test]
    fn controls_require_exact_call_and_generation_fences() {
        for frame in [
            json!({ "type": "formlogic.realtime.begin", "callId": "c" }),
            json!({ "type": "formlogic.realtime.cancel_output", "itemId": "i", "playedMs": 1, "generation": 1 }),
            json!({ "type": "formlogic.realtime.stop", "callId": "c" }),
        ] {
            assert!(serde_json::from_value::<LocalControl>(frame).is_err());
        }
        let fence = CallFence {
            call_id: "c".into(),
            generation: 9,
        };
        assert!(exact_fence_matches(&fence, "c", 9));
        assert!(!exact_fence_matches(&fence, "other", 9));
        assert!(!exact_fence_matches(&fence, "c", 10));
    }

    #[test]
    fn preconnected_abandoned_ring_never_generates_a_greeting() {
        let mut state = SessionState::new("Thanks for calling".into());
        state.ready = true;
        assert!(!state.begun);
        assert!(
            state.greeting.is_some(),
            "ready retains rather than generates greeting"
        );
        let Some(UpstreamMessage::Text(text)) = begin_response(&mut state) else {
            panic!("begin should generate one greeting");
        };
        assert!(text.contains("response.create"));
        assert!(state.begun);
        assert!(begin_response(&mut state).is_none(), "greeting is one-shot");
    }

    #[test]
    fn transcript_deltas_are_suppressed_until_final_text() {
        let fence = CallFence {
            call_id: "call-1".into(),
            generation: 1,
        };
        let mut state = SessionState::new(String::new());
        let input_delta = json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "input-1",
            "delta": "partial",
        });
        assert!(translate_server_event(&input_delta, &fence, &mut state)
            .unwrap()
            .is_empty());
    }
}
