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
}

struct OutputItemState {
    item_id: String,
    response_id: String,
    done: bool,
}

struct SessionState {
    ready: bool,
    begun: bool,
    greeting: Option<String>,
    output: Option<OutputItemState>,
    invalid_controls: u8,
}

impl SessionState {
    fn new(greeting: String) -> Self {
        Self {
            ready: false,
            begun: false,
            greeting: (!greeting.is_empty()).then_some(greeting),
            output: None,
            invalid_controls: 0,
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
    let mut state = SessionState::new(start.greeting);
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
                "tools": [],
                "tool_choice": "none",
            }
        })
        .to_string(),
    ))
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
        UpstreamMessage::Text(
            json!({
                "type": "response.create",
                "response": {
                    "instructions": greeting,
                    "output_modalities": ["audio"],
                    "tools": [],
                    "tool_choice": "none",
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
            if event.pointer("/item/type").and_then(Value::as_str) != Some("message")
                || event.pointer("/item/role").and_then(Value::as_str) != Some("assistant")
                || state.output.as_ref().is_some_and(|output| !output.done)
            {
                return Err((
                    "upstream_protocol",
                    "Realtime output item ordering or assistant identity was invalid.",
                ));
            }
            state.output = Some(OutputItemState {
                item_id: item_id.clone(),
                response_id: response_id.clone(),
                done: false,
            });
            Ok(vec![fenced_json(
                fence,
                "formlogic.realtime.output_item_started",
                json!({ "itemId": item_id, "responseId": response_id }),
            )])
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
            Ok(vec![fenced_json(
                fence,
                "formlogic.realtime.output_transcript",
                json!({
                    "itemId": item_id,
                    "transcript": bounded_content(event.get("transcript"), 64 * 1024)?,
                    "final": true,
                }),
            )])
        }
        "response.output_item.done" => {
            let item_id = safe_id(event.pointer("/item/id"))?;
            let response_id = safe_id(event.get("response_id"))?;
            let Some(output) = state.output.as_mut() else {
                return Err((
                    "upstream_protocol",
                    "Realtime completed an unknown output item.",
                ));
            };
            if output.done || output.item_id != item_id || output.response_id != response_id {
                return Err((
                    "upstream_protocol",
                    "Realtime completed a mismatched output item.",
                ));
            }
            output.done = true;
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

            // `response.output_item.done` normally precedes `response.done`.
            // Recover defensively when an interrupted/terminal response omits
            // it: retire the exact active item before Aokie sees any error, so
            // its binary-audio fence cannot remain abandoned. A completed item
            // stays retained for the normal post-completion playout-tail
            // truncation path.
            let mut messages = Vec::with_capacity(2);
            if let Some(output) = state.output.as_mut().filter(|output| !output.done) {
                let response_id = safe_id(event.pointer("/response/id"))?;
                if output.response_id != response_id {
                    return Err((
                        "upstream_protocol",
                        "Realtime terminal response did not match the active assistant item.",
                    ));
                }
                let item_id = output.item_id.clone();
                let response_id = output.response_id.clone();
                output.done = true;
                messages.push(fenced_json(
                    fence,
                    "formlogic.realtime.output_item_done",
                    json!({
                        "itemId": item_id,
                        "responseId": response_id,
                    }),
                ));
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
        }
    }

    fn add_output(state: &mut SessionState, fence: &CallFence) {
        let event = json!({
            "type": "response.output_item.added",
            "response_id": "response-1",
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
        assert_eq!(
            value["session"]["audio"]["output"]["format"]["rate"],
            24000
        );
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
            "item": { "id": "item-1" },
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
            "item": { "id": "item-1" },
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
