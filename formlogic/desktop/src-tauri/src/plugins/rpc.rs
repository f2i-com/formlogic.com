//! JSON-RPC 2.0 over stdio, newline-delimited — the plugin wire protocol.
//!
//! One JSON object per `\n`-terminated UTF-8 line, no Content-Length framing,
//! max line 1 MiB (`docs/DESKTOP_PLUGIN_SDK.md` §3). The desktop side is the
//! CLIENT: it sends requests (`plugin.init`, `plugin.health`,
//! `plugin.shutdown`, `connector.request`) and receives responses plus
//! id-less notifications (`event.emit`, `log.emit`) from the plugin.
//!
//! Non-JSON stdout lines and ALL stderr lines land in the plugin's log ring
//! buffer (`GET /api/plugins/{id}/logs`), so a plugin that prints a Python
//! traceback is debuggable rather than silently broken.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::services::runner::LogLine;

/// Max protocol line length (1 MiB). Longer lines are dropped whole — the
/// remainder up to the next newline is discarded so the stream stays in sync.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Plugin log ring buffer — last ~2000 stdout/stderr lines. Same `LogLine`
/// shape the services LogsViewer already renders, so the UI reuses it as-is.
/// (Raised 500→2000, LAT-001: a live call's SCO chatter wrapped 500 lines in
/// under a minute, so post-call latency forensics always read "logs wrapped".)
pub const PLUGIN_LOG_LINES: usize = 2000;

/// `log.emit` messages over this many bytes are truncated (contract: ≤ 2 KiB).
pub const MAX_LOG_EMIT_BYTES: usize = 2048;

#[derive(Clone)]
pub struct LogRing(Arc<Mutex<VecDeque<LogLine>>>);

impl LogRing {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(VecDeque::with_capacity(PLUGIN_LOG_LINES))))
    }

    pub fn push(&self, stream: &'static str, text: String) {
        let line = LogLine {
            timestamp: chrono::Utc::now(),
            stream,
            text,
        };
        if let Ok(mut buf) = self.0.lock() {
            if buf.len() >= PLUGIN_LOG_LINES {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    }

    pub fn snapshot(&self, tail: Option<usize>) -> Vec<LogLine> {
        let buf = match self.0.lock() {
            Ok(b) => b,
            Err(_) => return vec![],
        };
        match tail {
            Some(n) if n < buf.len() => buf.iter().skip(buf.len() - n).cloned().collect(),
            _ => buf.iter().cloned().collect(),
        }
    }
}

impl Default for LogRing {
    fn default() -> Self {
        Self::new()
    }
}

/// The `error` member of a JSON-RPC response. `data` carries the typed
/// connector error (`{code, message}`) for `connector.request` failures.
#[derive(Debug, Clone)]
pub struct RpcErrorObj {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

/// Why a desktop→plugin request failed at the transport/protocol level.
#[derive(Debug)]
pub enum RpcFailure {
    /// No response within the deadline (the pending slot is reclaimed).
    Timeout(Duration),
    /// The plugin's stdio is gone (process exited / pipes closed).
    Closed,
    /// The plugin answered with a JSON-RPC error object.
    Remote(RpcErrorObj),
}

/// Notifications the plugin pushes (no `id`): events for the bus, log lines
/// for the ring buffer, plus INBOUND requests (id + method) the plugin makes of
/// the desktop (e.g. `flow.run` — see `docs/DESKTOP_PLUGIN_SDK.md`).
#[derive(Debug)]
pub enum PluginNotification {
    /// `realtime.emit` — a VOLATILE observation frame (guide §9.2): fan out
    /// to local subscribers and forget. Never journalled, never acked, never
    /// flow-dispatched; dropped silently when oversized or malformed.
    Realtime(Value),
    /// `event.emit` — `params.event` is the desktop-event envelope (validated
    /// upstream by the event bus, NOT here).
    Event(Value),
    /// `log.emit` — level + message (truncated to [`MAX_LOG_EMIT_BYTES`]).
    Log { level: String, message: String },
    /// A request FROM the plugin (has `id` + `method`): the desktop runs it and
    /// responds via [`RpcClient::respond`]. Only `flow.run` is supported today;
    /// anything else is answered with `method not found`.
    Request { id: Value, method: String, params: Value },
}

/// One live plugin connection: correlated request/response over the child's
/// stdin/stdout. Cheap to clone via `Arc`; safe to call from any task.
pub struct RpcClient {
    next_id: AtomicU64,
    #[allow(clippy::type_complexity)]
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcErrorObj>>>>,
    stdin: tokio::sync::Mutex<Option<tokio::process::ChildStdin>>,
    closed: AtomicBool,
}

impl RpcClient {
    fn new(stdin: tokio::process::ChildStdin) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            closed: AtomicBool::new(false),
        }
    }

    /// Send `method(params)` and await the correlated response, bounded by
    /// `timeout`. Concurrent requests are fine — correlation is by id.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcFailure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RpcFailure::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        let mut line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            .to_string();
        line.push('\n');
        {
            let mut guard = self.stdin.lock().await;
            let ok = match guard.as_mut() {
                Some(w) => {
                    w.write_all(line.as_bytes()).await.is_ok() && w.flush().await.is_ok()
                }
                None => false,
            };
            if !ok {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                return Err(RpcFailure::Closed);
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Err(_) => {
                // Reclaim the slot so a late reply is dropped, not leaked.
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(RpcFailure::Timeout(timeout))
            }
            Ok(Err(_)) => Err(RpcFailure::Closed), // reader closed the sender
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(RpcFailure::Remote(e)),
        }
    }

    /// Complete a pending request (called by the stdout reader). Unknown ids
    /// (timed-out / duplicate) are dropped silently — expected under races.
    fn complete(&self, id: u64, outcome: Result<Value, RpcErrorObj>) {
        let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
        if let Some(tx) = tx {
            let _ = tx.send(outcome);
        }
    }

    /// Answer an INBOUND request from the plugin (the `flow.run` RPC path):
    /// write a JSON-RPC response back over the child's stdin. Best-effort — a
    /// dead pipe just drops the reply (the plugin's own request will time out).
    pub async fn respond(&self, id: Value, outcome: Result<Value, RpcErrorObj>) {
        let msg = match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(e) => {
                let mut err = json!({ "code": e.code, "message": e.message });
                if let Some(d) = e.data {
                    err["data"] = d;
                }
                json!({ "jsonrpc": "2.0", "id": id, "error": err })
            }
        };
        let mut line = msg.to_string();
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        if let Some(w) = guard.as_mut() {
            let _ = w.write_all(line.as_bytes()).await;
            let _ = w.flush().await;
        }
    }

    /// Send an id-less notification to the plugin (e.g. `event.ack` after a
    /// durable receipt — audit INT-003). Best-effort like [`respond`](Self::respond).
    pub async fn notify(&self, method: &str, params: Value) {
        let mut line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        if let Some(w) = guard.as_mut() {
            let _ = w.write_all(line.as_bytes()).await;
            let _ = w.flush().await;
        }
    }

    /// Tear down: mark closed and fail every in-flight request. Called when
    /// the stdout pump sees EOF (process died) or the supervisor stops it.
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut p) = self.pending.lock() {
            p.clear(); // dropping the senders wakes the waiters with Closed
        }
    }
}

/// A freshly-spawned plugin process, before the `plugin.init` handshake.
pub struct PluginProcess {
    pub child: tokio::process::Child,
    pub client: Arc<RpcClient>,
    /// `event.emit` / `log.emit` notifications; closes when stdout closes.
    pub notifications: mpsc::UnboundedReceiver<PluginNotification>,
}

pub struct SpawnSpec<'a> {
    pub plugin_id: &'a str,
    /// The plugin's own directory (cwd of the child).
    pub plugin_dir: &'a Path,
    /// `entry.command` — already validated by the manifest loader.
    pub command: &'a str,
    pub args: &'a [String],
    /// The per-plugin writable data dir (`FORMLOGIC_PLUGIN_DATA_DIR`).
    pub data_dir: &'a Path,
    pub dev_mode: bool,
}

/// Spawn the plugin child with the CONTRACT environment: nothing inherited
/// beyond a minimal allow-list (PATH; SystemRoot/TEMP/TMP on Windows) plus the
/// `FORMLOGIC_*` variables — no tokens, no HF keys, no user secrets.
pub fn spawn_plugin(spec: &SpawnSpec<'_>, logs: LogRing) -> std::io::Result<PluginProcess> {
    // Resolve the program: a command that exists inside the plugin dir runs
    // from there (Windows' CreateProcess resolves relative paths against the
    // PARENT's cwd, not the child's, so we must join explicitly). A bare name
    // that doesn't ("node") resolves via PATH ONLY in dev mode (audit FL-008):
    // an installed plugin runs exactly the binaries it ships — a manifest must
    // not be able to launch whatever happens to sit on the operator's PATH.
    let in_dir = spec.plugin_dir.join(spec.command);
    let program: OsString = if in_dir.is_file() {
        in_dir.into_os_string()
    } else if spec.dev_mode {
        OsString::from(spec.command)
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "plugin entry '{}' is not a file inside the plugin directory (PATH lookup is dev-mode only)",
                spec.command
            ),
        ));
    };

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(spec.args).current_dir(spec.plugin_dir);
    cmd.env_clear();
    let mut allow: Vec<&str> = vec!["PATH"];
    if cfg!(windows) {
        allow.extend(["SystemRoot", "TEMP", "TMP"]);
    }
    for key in allow {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    cmd.env("FORMLOGIC_PLUGIN_ID", spec.plugin_id);
    cmd.env("FORMLOGIC_PLUGIN_DATA_DIR", spec.data_dir);
    cmd.env("FORMLOGIC_DESKTOP_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env(
        "FORMLOGIC_PLUGIN_API_VERSION",
        crate::PLUGIN_API_VERSION.to_string(),
    );
    // CONSENT-001: the PUBLIC half of this install's consent-signing key.
    // Plugins that gate on operator consent (Aokie) then accept ONLY grants
    // signed by THIS Desktop — the per-install key is the device binding.
    if let Some(key) = crate::consent_signing::verify_key_b64() {
        cmd.env("FORMLOGIC_CONSENT_VERIFY_KEY", key);
    }
    // AI-405: the per-install AI-gateway token — PLUGINS ONLY (never in any
    // service's env). Unlocks the gateway's /api/ai/v1/* INFERENCE routes;
    // provider config/key routes stay management-plane.
    if let Some(tok) = crate::ai::gateway_token::token() {
        cmd.env(crate::ai::gateway_token::ENV_NAME, tok);
    }
    if spec.dev_mode {
        cmd.env("FORMLOGIC_DEV_MODE", "1");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // If the supervisor task is ever dropped mid-flight, don't leak the child.
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("plugin child has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("plugin child has no stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("plugin child has no stderr"))?;

    let client = Arc::new(RpcClient::new(stdin));
    let (ntx, nrx) = mpsc::unbounded_channel();

    // stdout pump: JSON-RPC responses → pending map; notifications → channel;
    // anything else → log ring.
    {
        let client = client.clone();
        let logs = logs.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_line_bounded(&mut reader, MAX_LINE_BYTES).await {
                    Err(_) | Ok(BoundedLine::Eof) => break,
                    Ok(BoundedLine::Oversized(n)) => logs.push(
                        "stderr",
                        format!("[desktop] dropped oversized stdout line ({n} bytes > 1 MiB)"),
                    ),
                    Ok(BoundedLine::Line(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(&line) {
                            Ok(Value::Object(obj)) => dispatch_object(obj, &client, &ntx, &logs),
                            // Valid JSON but not an object, or not JSON at
                            // all: a plain print — keep it as plugin output.
                            _ => logs.push("stdout", line),
                        }
                    }
                }
            }
            // EOF: the process is gone (or closed stdout). Fail in-flight
            // requests; dropping ntx ends the notification stream.
            client.close();
        });
    }

    // stderr pump: everything to the log ring (bounded lines too, so a
    // runaway binary can't balloon memory).
    {
        let logs = logs;
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            loop {
                match read_line_bounded(&mut reader, MAX_LINE_BYTES).await {
                    Err(_) | Ok(BoundedLine::Eof) => break,
                    Ok(BoundedLine::Oversized(n)) => logs.push(
                        "stderr",
                        format!("[desktop] dropped oversized stderr line ({n} bytes > 1 MiB)"),
                    ),
                    Ok(BoundedLine::Line(line)) => logs.push("stderr", line),
                }
            }
        });
    }

    Ok(PluginProcess {
        child,
        client,
        notifications: nrx,
    })
}

/// Route one parsed JSON object from the plugin's stdout.
fn dispatch_object(
    obj: serde_json::Map<String, Value>,
    client: &Arc<RpcClient>,
    ntx: &mpsc::UnboundedSender<PluginNotification>,
    logs: &LogRing,
) {
    if let Some(id) = obj.get("id").and_then(Value::as_u64) {
        if obj.contains_key("result") || obj.get("error").filter(|e| !e.is_null()).is_some() {
            let outcome = match obj.get("error").filter(|e| !e.is_null()) {
                Some(err) => Err(RpcErrorObj {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("(no message)")
                        .to_string(),
                    data: err.get("data").cloned(),
                }),
                None => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
            };
            client.complete(id, outcome);
        } else if let Some(method) = obj.get("method").and_then(Value::as_str) {
            // A request FROM the plugin (id + method, no result/error) — e.g.
            // `flow.run`. Forward it to the supervisor pump, which routes it to
            // the flow runtime and answers via RpcClient::respond.
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            let _ = ntx.send(PluginNotification::Request {
                id: Value::from(id),
                method: method.to_string(),
                params,
            });
        } else {
            logs.push(
                "stderr",
                "[desktop] ignored malformed message from plugin (id without result/error/method)".into(),
            );
        }
        return;
    }
    match parse_notification(&obj) {
        Some(n) => {
            let _ = ntx.send(n);
        }
        None => logs.push(
            "stderr",
            format!(
                "[desktop] ignored malformed/unknown notification: {:?}",
                obj.get("method").and_then(Value::as_str).unwrap_or("?")
            ),
        ),
    }
}

/// Parse an id-less JSON-RPC notification into the typed enum. `None` when
/// the method is unknown or the params are malformed (caller logs + drops).
fn parse_notification(obj: &serde_json::Map<String, Value>) -> Option<PluginNotification> {
    let params = obj.get("params");
    match obj.get("method").and_then(Value::as_str)? {
        "realtime.emit" => {
            let frame = params?.get("frame")?.clone();
            // App-level frame cap (guide §9.2): the stdio protocol allows
            // 1 MiB lines, but realtime frames must stay small.
            if frame.to_string().len() > 16 * 1024 {
                return None;
            }
            Some(PluginNotification::Realtime(frame))
        }
        "event.emit" => {
            let event = params?.get("event")?.clone();
            Some(PluginNotification::Event(event))
        }
        "log.emit" => {
            let p = params?;
            let message = p.get("message")?.as_str()?;
            let level = p
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info")
                .to_string();
            let mut message = message.to_string();
            if message.len() > MAX_LOG_EMIT_BYTES {
                let mut cut = MAX_LOG_EMIT_BYTES;
                while !message.is_char_boundary(cut) {
                    cut -= 1;
                }
                message.truncate(cut);
                message.push('…');
            }
            Some(PluginNotification::Log { level, message })
        }
        _ => None,
    }
}

/// Outcome of one bounded line read.
#[derive(Debug, PartialEq)]
pub enum BoundedLine {
    /// A complete line (without the terminator; trailing `\r` stripped).
    Line(String),
    /// The line exceeded the cap; it was discarded whole (`usize` = bytes
    /// dropped) and the stream is positioned after its newline.
    Oversized(usize),
    Eof,
}

/// Read one `\n`-terminated line, enforcing the 1 MiB protocol cap without
/// ever buffering more than the cap. `tokio`'s `read_line` has no limit, so a
/// hostile/buggy plugin could otherwise make the host balloon.
pub async fn read_line_bounded<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<BoundedLine> {
    let mut buf: Vec<u8> = Vec::new();
    let mut dropped = 0usize;
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            // EOF.
            return Ok(if oversized {
                BoundedLine::Oversized(dropped)
            } else if buf.is_empty() {
                BoundedLine::Eof
            } else {
                BoundedLine::Line(finish_line(buf))
            });
        }
        match chunk.iter().position(|b| *b == b'\n') {
            Some(pos) => {
                if oversized {
                    dropped += pos;
                    reader.consume(pos + 1);
                    return Ok(BoundedLine::Oversized(dropped));
                }
                if buf.len() + pos > max {
                    dropped = buf.len() + pos;
                    reader.consume(pos + 1);
                    return Ok(BoundedLine::Oversized(dropped));
                }
                buf.extend_from_slice(&chunk[..pos]);
                reader.consume(pos + 1);
                return Ok(BoundedLine::Line(finish_line(buf)));
            }
            None => {
                let n = chunk.len();
                if oversized {
                    dropped += n;
                } else if buf.len() + n > max {
                    oversized = true;
                    dropped = buf.len() + n;
                    buf.clear();
                } else {
                    buf.extend_from_slice(chunk);
                }
                reader.consume(n);
            }
        }
    }
}

fn finish_line(mut buf: Vec<u8>) -> String {
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_emit_parses_to_the_volatile_variant() {
        let obj = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "realtime.emit",
            "params": { "frame": { "kind": "user.partial", "seq": 1 } }
        });
        let n = parse_notification(obj.as_object().unwrap());
        assert!(matches!(n, Some(PluginNotification::Realtime(_))));
        // Oversized frames are dropped whole (guide §9.2 16 KiB app cap).
        let big = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "realtime.emit",
            "params": { "frame": { "text": "x".repeat(20_000) } }
        });
        assert!(parse_notification(big.as_object().unwrap()).is_none());
        // Malformed (no frame) is dropped, not mistaken for an event.
        let bad = serde_json::json!({ "jsonrpc": "2.0", "method": "realtime.emit", "params": {} });
        assert!(parse_notification(bad.as_object().unwrap()).is_none());
    }

    async fn read_all(input: &[u8], max: usize) -> Vec<BoundedLine> {
        let mut reader = BufReader::new(input);
        let mut out = Vec::new();
        loop {
            let item = read_line_bounded(&mut reader, max).await.expect("read");
            let eof = item == BoundedLine::Eof;
            out.push(item);
            if eof {
                return out;
            }
        }
    }

    #[tokio::test]
    async fn bounded_reader_reads_plain_and_crlf_lines() {
        let out = read_all(b"one\r\ntwo\nthree", 64).await;
        assert_eq!(
            out,
            vec![
                BoundedLine::Line("one".into()),
                BoundedLine::Line("two".into()),
                BoundedLine::Line("three".into()), // EOF without newline still yields the tail
                BoundedLine::Eof,
            ]
        );
    }

    #[tokio::test]
    async fn bounded_reader_drops_oversized_line_and_stays_in_sync() {
        // 100-byte line against a 10-byte cap: dropped whole, and the NEXT
        // line still parses — the stream must never desync mid-line.
        let mut input = vec![b'x'; 100];
        input.push(b'\n');
        input.extend_from_slice(b"ok\n");
        let out = read_all(&input, 10).await;
        assert_eq!(out[0], BoundedLine::Oversized(100));
        assert_eq!(out[1], BoundedLine::Line("ok".into()));
        assert_eq!(out[2], BoundedLine::Eof);
    }

    #[tokio::test]
    async fn bounded_reader_handles_oversized_line_at_eof() {
        let input = vec![b'x'; 50];
        let out = read_all(&input, 10).await;
        assert_eq!(out[0], BoundedLine::Oversized(50));
        assert_eq!(out[1], BoundedLine::Eof);
    }

    #[test]
    fn parse_notification_shapes() {
        let ev: serde_json::Map<String, Value> = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"event.emit","params":{"event":{"name":"mock.tick"}}}"#,
        )
        .unwrap();
        assert!(matches!(
            parse_notification(&ev),
            Some(PluginNotification::Event(_))
        ));

        let log: serde_json::Map<String, Value> = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"log.emit","params":{"level":"warning","message":"hi"}}"#,
        )
        .unwrap();
        match parse_notification(&log) {
            Some(PluginNotification::Log { level, message }) => {
                assert_eq!(level, "warning");
                assert_eq!(message, "hi");
            }
            other => panic!("expected log, got {other:?}"),
        }

        // Unknown methods and malformed params are None (dropped + logged).
        let unk: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"nope.new"}"#).unwrap();
        assert!(parse_notification(&unk).is_none());
        let bad: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"log.emit","params":{}}"#).unwrap();
        assert!(parse_notification(&bad).is_none());
    }

    #[test]
    fn log_emit_truncates_oversized_messages() {
        let big = "a".repeat(MAX_LOG_EMIT_BYTES + 100);
        let obj: serde_json::Map<String, Value> = serde_json::from_str(&format!(
            r#"{{"method":"log.emit","params":{{"message":"{big}"}}}}"#
        ))
        .unwrap();
        match parse_notification(&obj) {
            Some(PluginNotification::Log { message, .. }) => {
                assert!(message.len() <= MAX_LOG_EMIT_BYTES + '…'.len_utf8());
                assert!(message.ends_with('…'));
            }
            other => panic!("expected log, got {other:?}"),
        }
    }

    #[test]
    fn log_ring_caps_at_capacity() {
        let ring = LogRing::new();
        for i in 0..(PLUGIN_LOG_LINES + 20) {
            ring.push("stdout", format!("line {i}"));
        }
        let all = ring.snapshot(None);
        assert_eq!(all.len(), PLUGIN_LOG_LINES);
        assert_eq!(all[0].text, "line 20"); // oldest 20 dropped
        assert_eq!(ring.snapshot(Some(2)).len(), 2);
    }
}
