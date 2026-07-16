//! Optional, read-only Aokie Companion realtime publisher.
//!
//! This module is deliberately native-only. It reads one explicit set of
//! environment variables, keeps the Desktop admission token inside Rust, and
//! publishes observation snapshots from the existing Aokie plugin host. It
//! never registers a Tauri command and never forwards a Companion command to
//! the connector. Until the native media/control bridge exists, live captions
//! are the only advertised capability; every media/control
//! capability remains false and every inbound command is rejected with a
//! typed `forbidden` acknowledgement.

use crate::connectors::{self, ConnectorRequestBody};
use crate::plugins::registry::PluginHostHandle;
use chrono::{SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{header, HeaderValue, Request},
    protocol::WebSocketConfig,
    Message,
};
use url::{Host, Url};

const SCHEMA_VERSION: u64 = 1;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_REALTIME_FRAME_BYTES: usize = 16 * 1024;
const MAX_CAPTIONS: usize = 32;
const MAX_CAPTION_CHARS: usize = 2_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const AUTHORITATIVE_FAILURE_LIMIT: u8 = 3;

const ENV_URL: &str = "AOKIE_COMPANION_GATEWAY_URL";
const ENV_TOKEN: &str = "AOKIE_COMPANION_DESKTOP_TOKEN";
const ENV_APP_ID: &str = "AOKIE_COMPANION_APP_ID";
const ENV_DESKTOP_ID: &str = "AOKIE_COMPANION_DESKTOP_ID";
const ENV_V2_URL: &str = "AOKIE_COMPANION_V2_GATEWAY_URL";
const ENV_PLUGIN_TOKEN: &str = "AOKIE_COMPANION_PLUGIN_TOKEN";
const ENV_PLUGIN_ID: &str = "AOKIE_COMPANION_PLUGIN_ID";

static CAPTURED_CONFIG: OnceLock<Result<ConfiguredPublisher, String>> = OnceLock::new();
static CAPTURED_PLUGIN_BOOTSTRAP: OnceLock<Result<Option<PluginBootstrap>, String>> =
    OnceLock::new();

struct PublisherConfig {
    gateway_url: Url,
    token: String,
    app_id: String,
    desktop_id: String,
}

enum ConfiguredPublisher {
    Disabled,
    Enabled(PublisherConfig),
}

/// Private v2 bootstrap delivered only to the installed Aokie plugin through
/// the existing `plugin.init` pipe. The bearer is captured before any child
/// starts, scrubbed from the Desktop environment, and never written to disk or
/// exposed to the renderer/public connector relay.
#[derive(Clone)]
struct PluginBootstrap {
    gateway_url: Url,
    token: String,
    app_id: String,
    plugin_id: String,
}

impl PluginBootstrap {
    fn from_env() -> Result<Option<Self>, String> {
        Self::from_values(
            std::env::var(ENV_V2_URL).ok(),
            std::env::var(ENV_PLUGIN_TOKEN).ok(),
            std::env::var(ENV_APP_ID).ok(),
            std::env::var(ENV_PLUGIN_ID).ok(),
            cfg!(debug_assertions),
        )
    }

    fn from_values(
        gateway_url: Option<String>,
        token: Option<String>,
        app_id: Option<String>,
        plugin_id: Option<String>,
        allow_debug_loopback_ws: bool,
    ) -> Result<Option<Self>, String> {
        let mut values = [gateway_url, token, app_id, plugin_id];
        for value in &mut values {
            *value = value
                .take()
                .map(|candidate| candidate.trim().to_string())
                .filter(|candidate| !candidate.is_empty());
        }
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        if values.iter().any(Option::is_none) {
            let names = [ENV_V2_URL, ENV_PLUGIN_TOKEN, ENV_APP_ID, ENV_PLUGIN_ID];
            let missing = values
                .iter()
                .enumerate()
                .filter_map(|(index, value)| value.is_none().then_some(names[index]))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "Aokie Companion private plugin bootstrap is incomplete; missing {missing}"
            ));
        }
        let [gateway_url, token, app_id, plugin_id] = values;
        let gateway_url = Url::parse(gateway_url.as_deref().unwrap_or_default())
            .map_err(|_| format!("{ENV_V2_URL} is not a valid URL"))?;
        validate_gateway_url(&gateway_url, allow_debug_loopback_ws)?;
        if gateway_url.path() != "/v2/realtime" {
            return Err(format!("{ENV_V2_URL} must target /v2/realtime"));
        }
        let token = token.unwrap_or_default();
        if !(16..=16 * 1024).contains(&token.len())
            || token.chars().any(|character| character.is_ascii_control())
        {
            return Err(format!(
                "{ENV_PLUGIN_TOKEN} must be a valid 16-16384 byte bearer token"
            ));
        }
        let app_id = app_id.unwrap_or_default();
        let plugin_id = plugin_id.unwrap_or_default();
        if !safe_id(&app_id) {
            return Err(format!("{ENV_APP_ID} is invalid"));
        }
        if !safe_id(&plugin_id) {
            return Err(format!("{ENV_PLUGIN_ID} is invalid"));
        }
        Ok(Some(Self {
            gateway_url,
            token,
            app_id,
            plugin_id,
        }))
    }

    fn init_payload(&self) -> Value {
        json!({
            "schemaVersion": 2,
            "gatewayUrl": self.gateway_url.as_str(),
            "accessToken": self.token,
            "appId": self.app_id,
            "pluginId": self.plugin_id,
        })
    }
}

impl PublisherConfig {
    fn from_env() -> Result<ConfiguredPublisher, String> {
        Self::from_values(
            std::env::var(ENV_URL).ok(),
            std::env::var(ENV_TOKEN).ok(),
            std::env::var(ENV_APP_ID).ok(),
            std::env::var(ENV_DESKTOP_ID).ok(),
            cfg!(debug_assertions),
        )
    }

    fn from_values(
        gateway_url: Option<String>,
        token: Option<String>,
        app_id: Option<String>,
        desktop_id: Option<String>,
        allow_debug_loopback_ws: bool,
    ) -> Result<ConfiguredPublisher, String> {
        let mut values = [gateway_url, token, app_id, desktop_id];
        for value in &mut values {
            *value = value
                .take()
                .map(|candidate| candidate.trim().to_string())
                .filter(|candidate| !candidate.is_empty());
        }
        if values.iter().all(Option::is_none) {
            return Ok(ConfiguredPublisher::Disabled);
        }
        if values.iter().any(Option::is_none) {
            let names = [ENV_URL, ENV_TOKEN, ENV_APP_ID, ENV_DESKTOP_ID];
            let missing = values
                .iter()
                .enumerate()
                .filter_map(|(index, value)| value.is_none().then_some(names[index]))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "Aokie Companion publisher configuration is incomplete; missing {missing}"
            ));
        }

        let [gateway_url, token, app_id, desktop_id] = values;
        let gateway_url = Url::parse(gateway_url.as_deref().unwrap_or_default())
            .map_err(|_| format!("{ENV_URL} is not a valid URL"))?;
        validate_gateway_url(&gateway_url, allow_debug_loopback_ws)?;
        let token = token.unwrap_or_default();
        if !(16..=16 * 1024).contains(&token.len())
            || token.chars().any(|character| character.is_ascii_control())
        {
            return Err(format!(
                "{ENV_TOKEN} must be a valid 16-16384 byte bearer token"
            ));
        }
        let app_id = app_id.unwrap_or_default();
        let desktop_id = desktop_id.unwrap_or_default();
        if !safe_id(&app_id) {
            return Err(format!("{ENV_APP_ID} is invalid"));
        }
        if !safe_id(&desktop_id) {
            return Err(format!("{ENV_DESKTOP_ID} is invalid"));
        }
        Ok(ConfiguredPublisher::Enabled(Self {
            gateway_url,
            token,
            app_id,
            desktop_id,
        }))
    }

    fn request(&self) -> Result<Request<()>, SessionError> {
        let mut request = self
            .gateway_url
            .as_str()
            .into_client_request()
            .map_err(|_| SessionError::InvalidRequest)?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", self.token))
            .map_err(|_| SessionError::InvalidRequest)?;
        authorization.set_sensitive(true);
        let app_id =
            HeaderValue::from_str(&self.app_id).map_err(|_| SessionError::InvalidRequest)?;
        let desktop_id =
            HeaderValue::from_str(&self.desktop_id).map_err(|_| SessionError::InvalidRequest)?;
        request
            .headers_mut()
            .insert(header::AUTHORIZATION, authorization);
        request.headers_mut().insert("x-aokie-app-id", app_id);
        request
            .headers_mut()
            .insert("x-aokie-device-id", desktop_id);
        Ok(request)
    }
}

fn captured_config() -> &'static Result<ConfiguredPublisher, String> {
    CAPTURED_CONFIG.get_or_init(|| {
        let configured = PublisherConfig::from_env();
        // The owned native config above becomes the sole long-lived copy.
        // Scrubbing at process entry prevents subsequently spawned services
        // and plugins from inheriting the Desktop admission credential.
        std::env::remove_var(ENV_TOKEN);
        configured
    })
}

/// Capture the native publisher configuration before Desktop can spawn child
/// processes, then remove its bearer token from the process environment.
pub fn capture_env() {
    let _ = captured_config();
    let _ = CAPTURED_PLUGIN_BOOTSTRAP.get_or_init(|| {
        let configured = PluginBootstrap::from_env();
        std::env::remove_var(ENV_PLUGIN_TOKEN);
        configured
    });
}

/// Returns the private native bootstrap only to the Aokie plugin supervisor.
/// Other plugin identities cannot retrieve it. Callers should include the
/// result in `plugin.init`; never log or persist the returned value.
pub(crate) fn plugin_v2_bootstrap(plugin_id: &str) -> Result<Option<Value>, String> {
    if plugin_id != "aokie" {
        return Ok(None);
    }
    let configured = CAPTURED_PLUGIN_BOOTSTRAP.get_or_init(|| {
        let configured = PluginBootstrap::from_env();
        std::env::remove_var(ENV_PLUGIN_TOKEN);
        configured
    });
    configured
        .as_ref()
        .map(|value| value.as_ref().map(PluginBootstrap::init_payload))
        .map_err(Clone::clone)
}

fn validate_gateway_url(url: &Url, allow_debug_loopback_ws: bool) -> Result<(), String> {
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{ENV_URL} must not contain credentials, a query, or a fragment"
        ));
    }
    let has_host = url.host().is_some();
    let secure = url.scheme() == "wss" && has_host;
    let debug_loopback = url.scheme() == "ws"
        && has_host
        && allow_debug_loopback_ws
        && url.host().is_some_and(is_loopback_host);
    if !secure && !debug_loopback {
        return Err(format!(
            "{ENV_URL} must use wss (debug builds additionally allow ws on loopback)"
        ));
    }
    Ok(())
}

fn is_loopback_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[derive(Clone, Copy, Debug)]
enum SessionError {
    InvalidRequest,
    Connect,
    Transport,
    Protocol,
}

impl SessionError {
    fn label(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid native WebSocket request",
            Self::Connect => "connection failed",
            Self::Transport => "transport closed",
            Self::Protocol => "gateway protocol error",
        }
    }
}

/// Start the optional publisher from its four environment variables.
///
/// Missing all four variables disables it. Partial/invalid configuration is
/// rejected without starting a network task. The function intentionally owns
/// its reconnect loop for the lifetime of Desktop.
pub async fn run_from_env(host: PluginHostHandle) {
    let config = match captured_config() {
        Ok(ConfiguredPublisher::Disabled) => return,
        Ok(ConfiguredPublisher::Enabled(config)) => config,
        Err(message) => {
            log::warn!("{message}");
            return;
        }
    };
    log::info!("Aokie Companion read-only publisher enabled (media and control remain disabled)");

    let mut delay = Duration::from_secs(1);
    loop {
        let session_started = Instant::now();
        let outcome = run_session(config, host.clone()).await;
        match outcome {
            Ok(()) => log::warn!("Aokie Companion publisher socket closed; reconnecting"),
            Err(error) => log::warn!(
                "Aokie Companion publisher {} (credential redacted); reconnecting",
                error.label()
            ),
        }
        // A socket that stayed healthy for a while earns a fresh short retry.
        // Fast rejects/closes back off together, avoiding a reconnect storm.
        if session_started.elapsed() >= Duration::from_secs(30) {
            delay = Duration::from_secs(1);
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

async fn run_session(config: &PublisherConfig, host: PluginHostHandle) -> Result<(), SessionError> {
    let request = config.request()?;
    let websocket_config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..WebSocketConfig::default()
    };
    let (socket, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(websocket_config), false),
    )
    .await
    .map_err(|_| SessionError::Connect)?
    .map_err(|_| SessionError::Connect)?;
    let (mut writer, mut reader) = socket.split();

    let resume = json!({
        "kind": "desktop_resume",
        "schemaVersion": SCHEMA_VERSION,
        "appId": config.app_id,
        "desktopId": config.desktop_id,
    })
    .to_string();
    send_text(&mut writer, resume).await?;

    let mut realtime = host.realtime_subscribe();
    let mut state = PublisherState::new(config.app_id.clone());
    let mut poll = tokio::time::interval(POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Do not send a ping immediately after the resume frame.
    ping.tick().await;
    let mut connector_warning_active = false;
    let mut consecutive_authoritative_failures = 0u8;

    loop {
        tokio::select! {
            _ = poll.tick() => {
                match poll_authoritative(&host).await {
                    Ok(observation) => {
                        consecutive_authoritative_failures = 0;
                        if connector_warning_active {
                            log::info!("Aokie Companion publisher regained authoritative plugin state");
                            connector_warning_active = false;
                        }
                        let frame = state.apply_authoritative(observation);
                        if let Some(frame) = state.take_changed(frame) {
                            send_text(&mut writer, frame).await?;
                        }
                    }
                    Err(()) => {
                        consecutive_authoritative_failures = consecutive_authoritative_failures.saturating_add(1);
                        if !connector_warning_active {
                            log::warn!("Aokie Companion publisher cannot read a consistent Aokie call snapshot; no idle/call state was asserted");
                            connector_warning_active = true;
                        }
                        if consecutive_authoritative_failures >= AUTHORITATIVE_FAILURE_LIMIT {
                            // Closing the publisher socket makes the gateway
                            // revoke its last snapshot and fence every mobile
                            // until a new authoritative poll succeeds.
                            return Err(SessionError::Transport);
                        }
                    }
                }
            }
            event = realtime.recv() => {
                match event {
                    Ok(frame) => {
                        if state.apply_realtime(&frame) {
                            if let Some(frame) = state.current_frame() {
                                if let Some(frame) = state.take_changed(frame) {
                                    send_text(&mut writer, frame).await?;
                                }
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Dropped observations cannot be reconstructed. Clear the
                        // volatile captions and let the authoritative poll retain
                        // only topology/call truth.
                        if state.clear_volatile() {
                            if let Some(frame) = state.current_frame() {
                                if let Some(frame) = state.take_changed(frame) {
                                    send_text(&mut writer, frame).await?;
                                }
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err(SessionError::Transport);
                    }
                }
            }
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_MESSAGE_BYTES => {
                        let acknowledgement = forbidden_ack(&text, config)?;
                        send_text(&mut writer, acknowledgement).await?;
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        tokio::time::timeout(SEND_TIMEOUT, writer.send(Message::Pong(bytes)))
                            .await
                            .map_err(|_| SessionError::Transport)?
                            .map_err(|_| SessionError::Transport)?;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    _ => return Err(SessionError::Protocol),
                }
            }
            _ = ping.tick() => {
                tokio::time::timeout(SEND_TIMEOUT, writer.send(Message::Ping(Vec::new().into())))
                    .await
                    .map_err(|_| SessionError::Transport)?
                    .map_err(|_| SessionError::Transport)?;
            }
        }
    }
}

async fn send_text<S>(writer: &mut S, encoded: String) -> Result<(), SessionError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    tokio::time::timeout(SEND_TIMEOUT, writer.send(Message::Text(encoded.into())))
        .await
        .map_err(|_| SessionError::Transport)?
        .map_err(|_| SessionError::Transport)
}

fn forbidden_ack(encoded: &str, config: &PublisherConfig) -> Result<String, SessionError> {
    let value: Value = serde_json::from_str(encoded).map_err(|_| SessionError::Protocol)?;
    if value.get("kind").and_then(Value::as_str) != Some("command")
        || value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
        || value.get("appId").and_then(Value::as_str) != Some(config.app_id.as_str())
    {
        return Err(SessionError::Protocol);
    }
    let device_id = value
        .get("deviceId")
        .and_then(Value::as_str)
        .filter(|value| safe_id(value))
        .ok_or(SessionError::Protocol)?;
    let command_id = value
        .pointer("/payload/commandId")
        .and_then(Value::as_str)
        .filter(|value| safe_id(value))
        .ok_or(SessionError::Protocol)?;
    Ok(json!({
        "kind": "desktop_command_ack",
        "schemaVersion": SCHEMA_VERSION,
        "appId": config.app_id,
        "deviceId": device_id,
        "payload": {
            "commandId": command_id,
            "accepted": false,
            "error": {
                "code": "forbidden",
                "message": "this Desktop publisher is observation-only; remote call control is disabled"
            }
        }
    })
    .to_string())
}

#[derive(Clone, PartialEq, Eq)]
struct CallView {
    call_id: String,
    state: &'static str,
    caller_name: Option<String>,
    from: Option<String>,
    switchboard_revision: u64,
}

enum AuthoritativeObservation {
    Idle,
    Live(CallView),
}

async fn poll_authoritative(host: &PluginHostHandle) -> Result<AuthoritativeObservation, ()> {
    let current = connectors::dispatch(
        host,
        "aokie",
        &ConnectorRequestBody {
            connector_id: Some("aokie".into()),
            command: "call.current".into(),
            payload: None,
            timeout_ms: Some(3_000),
            request_id: None,
            ..Default::default()
        },
    )
    .await
    .map_err(|_| ())?;
    let switchboard = connectors::dispatch(
        host,
        "aokie",
        &ConnectorRequestBody {
            connector_id: Some("aokie".into()),
            command: "call.switchboard".into(),
            payload: None,
            timeout_ms: Some(3_000),
            request_id: None,
            ..Default::default()
        },
    )
    .await
    .map_err(|_| ())?;
    reconcile_authoritative(&current, &switchboard)
}

fn reconcile_authoritative(
    current_response: &Value,
    switchboard_response: &Value,
) -> Result<AuthoritativeObservation, ()> {
    if current_response.get("ok").and_then(Value::as_bool) != Some(true)
        || switchboard_response.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return Err(());
    }
    let current = parse_call(current_response.pointer("/data/call").ok_or(())?)?;
    let foreground = parse_call(switchboard_response.pointer("/data/foreground").ok_or(())?)?;
    let revision = switchboard_response
        .pointer("/data/revision")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())?;

    match (current, foreground) {
        (None, None) => Ok(AuthoritativeObservation::Idle),
        (Some(current), Some(foreground))
            if current.call_id == foreground.call_id && current.state == foreground.state =>
        {
            if current.state == "ended" {
                return Ok(AuthoritativeObservation::Idle);
            }
            Ok(AuthoritativeObservation::Live(CallView {
                call_id: current.call_id,
                state: current.state,
                caller_name: current.caller_name.or(foreground.caller_name),
                from: current.from.or(foreground.from),
                switchboard_revision: revision,
            }))
        }
        // Sequential reads can straddle a topology transition. Refuse to
        // invent either idle or live truth and retry on the next poll.
        _ => Err(()),
    }
}

fn parse_call(value: &Value) -> Result<Option<CallView>, ()> {
    if value.is_null() {
        return Ok(None);
    }
    let call_id = value
        .get("callId")
        .and_then(Value::as_str)
        .filter(|value| safe_id(value))
        .ok_or(())?
        .to_string();
    let state = match value.get("state").and_then(Value::as_str) {
        Some("ringing") => "ringing",
        Some("active") => "active",
        Some("ended") => "ended",
        _ => return Err(()),
    };
    let caller_name = bounded_text(value.get("callerName"), 200);
    let from = bounded_text(value.get("from"), 200);
    Ok(Some(CallView {
        call_id,
        state,
        caller_name,
        from,
        switchboard_revision: 0,
    }))
}

fn bounded_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let sanitized = text
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .take(max_chars)
        .collect::<String>();
    let sanitized = sanitized.trim();
    (!sanitized.is_empty()).then(|| sanitized.to_string())
}

#[derive(Clone)]
struct CaptionRecord {
    caption_id: String,
    speaker: &'static str,
    text: String,
    occurred_at: String,
}

impl CaptionRecord {
    fn to_json(&self) -> Value {
        json!({
            "captionId": self.caption_id,
            "speaker": self.speaker,
            "text": self.text,
            "occurredAt": self.occurred_at,
            // Realtime frames are volatile observations, not the durable
            // transcript authority. Never claim they are final text.
            "finalText": false,
        })
    }
}

struct PublisherState {
    app_id: String,
    current: Option<CallView>,
    call_epoch: u64,
    remote_revision: u64,
    realtime_nonce: Option<String>,
    realtime_sequence: u64,
    captions: VecDeque<CaptionRecord>,
    last_fingerprint: Option<String>,
}

impl PublisherState {
    fn new(app_id: String) -> Self {
        Self {
            app_id,
            current: None,
            call_epoch: 0,
            remote_revision: 0,
            realtime_nonce: None,
            realtime_sequence: 0,
            captions: VecDeque::new(),
            last_fingerprint: None,
        }
    }

    fn apply_authoritative(&mut self, observation: AuthoritativeObservation) -> String {
        match observation {
            AuthoritativeObservation::Idle => {
                self.reset_call();
                json!({
                    "kind": "desktop_idle",
                    "schemaVersion": SCHEMA_VERSION,
                    "appId": self.app_id,
                })
                .to_string()
            }
            AuthoritativeObservation::Live(call) => {
                if self.current.as_ref().map(|value| value.call_id.as_str())
                    != Some(call.call_id.as_str())
                {
                    self.reset_call();
                }
                self.current = Some(call);
                self.current_frame()
                    .expect("a live authoritative call always produces a frame")
            }
        }
    }

    fn reset_call(&mut self) {
        self.current = None;
        self.call_epoch = 0;
        self.remote_revision = 0;
        self.realtime_nonce = None;
        self.realtime_sequence = 0;
        self.captions.clear();
    }

    fn clear_volatile(&mut self) -> bool {
        let changed = !self.captions.is_empty();
        self.captions.clear();
        self.realtime_nonce = None;
        self.realtime_sequence = 0;
        changed
    }

    fn current_frame(&self) -> Option<String> {
        let call = self.current.as_ref()?;
        let caller = caller_summary(call);
        let captions = self
            .captions
            .iter()
            .map(CaptionRecord::to_json)
            .collect::<Vec<_>>();
        Some(
            json!({
                "kind": "desktop_snapshot",
                "payload": {
                    "schemaVersion": SCHEMA_VERSION,
                    "callId": call.call_id,
                    "callEpoch": self.call_epoch,
                    "ownerEpoch": 0,
                    "switchboardRevision": call.switchboard_revision,
                    "remoteRevision": self.remote_revision,
                    "telephonyState": call.state,
                    "serviceMode": "aokie_active",
                    "talkOwner": { "kind": "aokie" },
                    "mediaState": "none",
                    "gatewayReachable": true,
                    "capabilities": {
                        "liveCaptions": true,
                        "monitorAudio": false,
                        "softwareHold": false,
                        "voiceConsult": false,
                        "takeover": false,
                        "endCaller": false,
                    },
                    "disclosure": {
                        "required": false,
                        "verified": false,
                        "policyVersion": "publisher_read_only_v1",
                    },
                    "secondaryCallPolicy": "miss_and_callback",
                    "caller": caller,
                    "participants": [],
                    "captions": captions,
                    "occurredAt": now_iso8601(),
                }
            })
            .to_string(),
        )
    }

    fn take_changed(&mut self, encoded: String) -> Option<String> {
        let fingerprint = frame_fingerprint(&encoded)?;
        if self.last_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return None;
        }
        self.last_fingerprint = Some(fingerprint);
        Some(encoded)
    }

    fn apply_realtime(&mut self, encoded: &str) -> bool {
        if encoded.len() > MAX_REALTIME_FRAME_BYTES {
            return false;
        }
        let Ok(frame) = serde_json::from_str::<Value>(encoded) else {
            return false;
        };
        let Some(call) = self.current.as_ref() else {
            return false;
        };
        if frame.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
            || frame.get("callId").and_then(Value::as_str) != Some(call.call_id.as_str())
        {
            return false;
        }
        let Some(call_epoch) = frame
            .get("callEpoch")
            .and_then(Value::as_u64)
            .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        else {
            return false;
        };
        let Some(sequence) = frame
            .get("seq")
            .and_then(Value::as_u64)
            .filter(|value| (1..=MAX_JSON_SAFE_INTEGER).contains(value))
        else {
            return false;
        };
        let Some(nonce) = frame
            .get("sessionNonce")
            .and_then(Value::as_str)
            .filter(|value| safe_short_id(value))
        else {
            return false;
        };
        if self.realtime_nonce.as_deref() == Some(nonce) && sequence <= self.realtime_sequence {
            return false;
        }
        let Some(occurred_at) = frame
            .get("occurredAt")
            .and_then(Value::as_str)
            .filter(|value| valid_timestamp(value))
        else {
            return false;
        };
        let kind = frame.get("kind").and_then(Value::as_str);
        let supported = matches!(kind, Some("user.partial" | "session.phase"))
            || (kind == Some("assistant.delivery")
                && frame.pointer("/data/state").and_then(Value::as_str) == Some("sent_to_sco"));
        if !supported || call_epoch < self.call_epoch {
            return false;
        }
        if call_epoch == self.call_epoch
            && self.realtime_nonce.is_some()
            && self.realtime_nonce.as_deref() != Some(nonce)
        {
            return false;
        }
        if call_epoch > self.call_epoch {
            self.clear_volatile();
        }

        self.call_epoch = call_epoch;
        self.realtime_nonce = Some(nonce.to_string());
        self.realtime_sequence = sequence;
        self.remote_revision = self
            .remote_revision
            .checked_add(1)
            .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
            .unwrap_or(MAX_JSON_SAFE_INTEGER);

        let caption = match kind {
            Some("user.partial") => {
                let turn_id = frame
                    .get("turnId")
                    .and_then(Value::as_str)
                    .filter(|value| safe_short_id(value));
                let text =
                    bounded_text(frame.pointer("/data/providerStableText"), MAX_CAPTION_CHARS);
                match (turn_id, text) {
                    (Some(turn_id), Some(text)) => Some(CaptionRecord {
                        caption_id: format!("rt_{nonce}_{turn_id}"),
                        speaker: "caller",
                        text,
                        occurred_at: occurred_at.to_string(),
                    }),
                    _ => None,
                }
            }
            Some("assistant.delivery") => {
                bounded_text(frame.pointer("/data/text"), MAX_CAPTION_CHARS).map(|text| {
                    CaptionRecord {
                        caption_id: format!("rt_{nonce}_a{sequence}"),
                        speaker: "aokie",
                        text,
                        occurred_at: occurred_at.to_string(),
                    }
                })
            }
            // `session.phase` has no field in Companion protocol v1. Advancing
            // the remote revision records fresh endpoint observation without
            // inventing a caption, participant, media state, or capability.
            Some("session.phase") => None,
            _ => unreachable!("unsupported realtime kinds return before state mutation"),
        };
        if let Some(caption) = caption {
            self.upsert_caption(caption);
        }
        true
    }

    fn upsert_caption(&mut self, caption: CaptionRecord) {
        if let Some(existing) = self
            .captions
            .iter_mut()
            .find(|existing| existing.caption_id == caption.caption_id)
        {
            *existing = caption;
            return;
        }
        self.captions.push_back(caption);
        while self.captions.len() > MAX_CAPTIONS {
            self.captions.pop_front();
        }
    }
}

fn safe_short_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_timestamp(value: &str) -> bool {
    value.len() <= 64 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn now_iso8601() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn caller_summary(call: &CallView) -> Value {
    let label = call
        .caller_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(200).collect::<String>());
    let masked_number = call.from.as_deref().and_then(mask_number);
    if label.is_none() && masked_number.is_none() {
        Value::Null
    } else {
        json!({ "label": label, "maskedNumber": masked_number })
    }
}

fn mask_number(value: &str) -> Option<String> {
    let digits = value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.len() < 3 {
        return None;
    }
    let suffix = &digits[digits.len() - 3..];
    Some(format!("••• {suffix}"))
}

fn frame_fingerprint(encoded: &str) -> Option<String> {
    let mut value: Value = serde_json::from_str(encoded).ok()?;
    if let Some(payload) = value.get_mut("payload").and_then(Value::as_object_mut) {
        payload.remove("occurredAt");
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_config() -> PublisherConfig {
        match PublisherConfig::from_values(
            Some("wss://gateway.example/v1/realtime".into()),
            Some("desktop_token_123456789".into()),
            Some("app_a".into()),
            Some("desktop_a".into()),
            false,
        )
        .expect("valid")
        {
            ConfiguredPublisher::Enabled(config) => config,
            ConfiguredPublisher::Disabled => panic!("expected enabled"),
        }
    }

    #[test]
    fn configuration_is_all_or_nothing_and_remote_ws_is_rejected() {
        assert!(matches!(
            PublisherConfig::from_values(None, None, None, None, false).unwrap(),
            ConfiguredPublisher::Disabled
        ));
        assert!(PublisherConfig::from_values(
            Some("wss://gateway.example/v1/realtime".into()),
            None,
            Some("app_a".into()),
            Some("desktop_a".into()),
            false,
        )
        .is_err());
        assert!(PublisherConfig::from_values(
            Some("ws://gateway.example/v1/realtime".into()),
            Some("desktop_token_123456789".into()),
            Some("app_a".into()),
            Some("desktop_a".into()),
            true,
        )
        .is_err());
        assert!(PublisherConfig::from_values(
            Some("ws://127.0.0.1:18787/v1/realtime".into()),
            Some("desktop_token_123456789".into()),
            Some("app_a".into()),
            Some("desktop_a".into()),
            true,
        )
        .is_ok());
    }

    #[test]
    fn private_v2_bootstrap_is_all_or_nothing_and_requires_the_v2_path() {
        assert!(PluginBootstrap::from_values(None, None, None, None, false)
            .unwrap()
            .is_none());
        assert!(PluginBootstrap::from_values(
            Some("wss://gateway.example/v2/realtime".into()),
            Some("plugin_token_123456789".into()),
            Some("app_a".into()),
            None,
            false,
        )
        .is_err());
        assert!(PluginBootstrap::from_values(
            Some("wss://gateway.example/v1/realtime".into()),
            Some("plugin_token_123456789".into()),
            Some("app_a".into()),
            Some("plugin_a".into()),
            false,
        )
        .is_err());
        assert!(PluginBootstrap::from_values(
            Some("ws://gateway.example/v2/realtime".into()),
            Some("plugin_token_123456789".into()),
            Some("app_a".into()),
            Some("plugin_a".into()),
            true,
        )
        .is_err());
        assert!(PluginBootstrap::from_values(
            Some("ws://127.0.0.1:18787/v2/realtime".into()),
            Some("plugin_token_123456789".into()),
            Some("app_a".into()),
            Some("plugin_a".into()),
            true,
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn private_bootstrap_keeps_the_bearer_out_of_the_uri() {
        let bootstrap = PluginBootstrap::from_values(
            Some("wss://gateway.example/v2/realtime".into()),
            Some("plugin_token_123456789".into()),
            Some("app_a".into()),
            Some("plugin_a".into()),
            false,
        )
        .unwrap()
        .unwrap();
        assert!(!bootstrap
            .gateway_url
            .as_str()
            .contains("plugin_token_123456789"));
        let payload = bootstrap.init_payload();
        assert_eq!(payload["gatewayUrl"], "wss://gateway.example/v2/realtime");
        assert_eq!(payload["appId"], "app_a");
        assert_eq!(payload["pluginId"], "plugin_a");
        assert_eq!(payload["accessToken"], "plugin_token_123456789");
    }

    #[test]
    fn admission_headers_are_native_and_the_token_never_enters_the_uri() {
        let config = enabled_config();
        let request = config.request().expect("native request");
        assert_eq!(request.uri(), "wss://gateway.example/v1/realtime");
        assert_eq!(request.headers().get("x-aokie-app-id").unwrap(), "app_a");
        assert_eq!(
            request.headers().get("x-aokie-device-id").unwrap(),
            "desktop_a"
        );
        assert_eq!(
            request.headers().get(header::AUTHORIZATION).unwrap(),
            "Bearer desktop_token_123456789"
        );
        assert!(request
            .headers()
            .get(header::AUTHORIZATION)
            .unwrap()
            .is_sensitive());
        assert!(!request.uri().to_string().contains("desktop_token"));
    }

    #[test]
    fn reconciler_refuses_torn_reads_and_accepts_consistent_idle_or_live() {
        let idle_current = json!({"ok":true,"data":{"call":null}});
        let idle_switchboard = json!({"ok":true,"data":{"foreground":null,"revision":4}});
        assert!(matches!(
            reconcile_authoritative(&idle_current, &idle_switchboard).unwrap(),
            AuthoritativeObservation::Idle
        ));

        let current = json!({"ok":true,"data":{"call":{"callId":"call_a","from":"+61400111222","state":"active"}}});
        let switchboard = json!({"ok":true,"data":{"foreground":{"callId":"call_a","from":"+61400111222","state":"active"},"revision":7}});
        let AuthoritativeObservation::Live(call) =
            reconcile_authoritative(&current, &switchboard).unwrap()
        else {
            panic!("expected live")
        };
        assert_eq!(call.call_id, "call_a");
        assert_eq!(call.switchboard_revision, 7);

        let torn = json!({"ok":true,"data":{"foreground":null,"revision":8}});
        assert!(reconcile_authoritative(&current, &torn).is_err());
    }

    #[test]
    fn snapshot_omits_gateway_fields_and_advertises_only_live_captions() {
        let mut state = PublisherState::new("app_a".into());
        let encoded = state.apply_authoritative(AuthoritativeObservation::Live(CallView {
            call_id: "call_a".into(),
            state: "active",
            caller_name: Some("Mia".into()),
            from: Some("+61400111222".into()),
            switchboard_revision: 7,
        }));
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["kind"], "desktop_snapshot");
        assert!(value["payload"].get("appId").is_none());
        assert!(value["payload"].get("streamNonce").is_none());
        assert!(value["payload"].get("sequence").is_none());
        assert_eq!(value["payload"]["capabilities"]["liveCaptions"], true);
        for capability in [
            "monitorAudio",
            "softwareHold",
            "voiceConsult",
            "takeover",
            "endCaller",
        ] {
            assert_eq!(value["payload"]["capabilities"][capability], false);
        }
        assert_eq!(value["payload"]["mediaState"], "none");
        assert_eq!(value["payload"]["caller"]["maskedNumber"], "••• 222");
        assert!(!encoded.contains("+61400111222"));

        let idle: Value =
            serde_json::from_str(&state.apply_authoritative(AuthoritativeObservation::Idle))
                .unwrap();
        assert_eq!(
            idle,
            json!({
                "kind":"desktop_idle","schemaVersion":1,"appId":"app_a"
            })
        );
    }

    #[test]
    fn realtime_caption_is_bounded_replaced_and_never_claimed_final() {
        let mut state = PublisherState::new("app_a".into());
        state.apply_authoritative(AuthoritativeObservation::Live(CallView {
            call_id: "call_a".into(),
            state: "active",
            caller_name: None,
            from: None,
            switchboard_revision: 1,
        }));
        let first = json!({
            "schemaVersion":1,"callId":"call_a","callEpoch":9,
            "sessionNonce":"nonce_a","seq":1,"occurredAt":"2026-07-15T06:00:04Z",
            "kind":"user.partial","turnId":"t1","revision":1,
            "data":{"providerStableText":"hello","unstableText":""}
        });
        assert!(state.apply_realtime(&first.to_string()));
        let replacement = json!({
            "schemaVersion":1,"callId":"call_a","callEpoch":9,
            "sessionNonce":"nonce_a","seq":2,"occurredAt":"2026-07-15T06:00:05Z",
            "kind":"user.partial","turnId":"t1","revision":2,
            "data":{"providerStableText":"updated","unstableText":"ignored"}
        });
        assert!(state.apply_realtime(&replacement.to_string()));
        assert_eq!(state.captions.len(), 1);
        assert_eq!(state.captions[0].text, "updated");
        let value: Value = serde_json::from_str(&state.current_frame().unwrap()).unwrap();
        assert_eq!(value["payload"]["captions"][0]["finalText"], false);
        assert_eq!(value["payload"]["callEpoch"], 9);
    }

    #[test]
    fn every_valid_inbound_command_gets_a_typed_forbidden_ack() {
        let config = enabled_config();
        let command = json!({
            "kind":"command","schemaVersion":1,"appId":"app_a","deviceId":"device_a",
            "payload":{"commandId":"cmd_a","type":"takeover_claim"}
        });
        let ack: Value =
            serde_json::from_str(&forbidden_ack(&command.to_string(), &config).unwrap()).unwrap();
        assert_eq!(ack["kind"], "desktop_command_ack");
        assert_eq!(ack["deviceId"], "device_a");
        assert_eq!(ack["payload"]["commandId"], "cmd_a");
        assert_eq!(ack["payload"]["accepted"], false);
        assert_eq!(ack["payload"]["error"]["code"], "forbidden");
    }

    #[test]
    fn fingerprints_ignore_only_the_top_level_observation_time() {
        let a = json!({"kind":"desktop_snapshot","payload":{"occurredAt":"2026-07-15T00:00:00Z","captions":[]}}).to_string();
        let b = json!({"kind":"desktop_snapshot","payload":{"occurredAt":"2026-07-15T00:00:01Z","captions":[]}}).to_string();
        assert_eq!(frame_fingerprint(&a), frame_fingerprint(&b));
    }

    #[test]
    fn bounded_text_removes_protocol_disallowed_control_characters() {
        let input = json!("hello\u{0000} world\nnext");
        assert_eq!(
            bounded_text(Some(&input), 200).as_deref(),
            Some("hello world\nnext")
        );
        assert_eq!(bounded_text(Some(&json!("\u{0001}")), 200), None);
    }
}
