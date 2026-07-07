//! FormLogic Desktop **account link over OAuth 2.1** — the PRIMARY way the
//! desktop obtains its scoped `flk_…` key (manual paste stays as a fallback).
//!
//! The desktop is the first-party PUBLIC native client `formlogic-desktop`
//! (docs/MCP.md §device-link). The flow, all local to this module + the two
//! Tauri commands that drive it:
//!
//!   1. bind a one-shot loopback listener on `127.0.0.1:<ephemeral port>`
//!      (RFC 8252 §7.3 — port-agnostic loopback redirect);
//!   2. generate a PKCE `code_verifier` + S256 `code_challenge` and a random
//!      `state`, then open the SYSTEM browser at `<base>/oauth/authorize?…`;
//!   3. capture the browser's redirect back to `/callback?code=…&state=…`,
//!      validate `state`, and exchange `code`+`code_verifier` at
//!      `<base>/api/oauth/token` (see `formlogic_client::exchange_oauth_code`);
//!   4. store the minted key exactly as if pasted; the runtime reconfigures.
//!
//! Everything here is GUI-independent + panic-free so it unit-tests cleanly and
//! the loopback/exchange work regardless of the Tauri build feature.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The scopes the desktop requests (== `McpOAuthService::DESKTOP_SCOPES`). Space
/// separated in the authorize URL per RFC 6749.
// responses:read (list_responses + match-based updateResponse do a LIST), responses:write
// (submit), responses:manage (updateResponse) — the headless runtime needs all three to apply an
// app's onConnectorEvent record writes + flow output actions (verified by running it locally).
pub const DESKTOP_SCOPES: &str =
    "flows:read flows:write responses:read responses:write responses:manage connector:relay";
/// The first-party PUBLIC client id (seeded server-side).
pub const CLIENT_ID: &str = "formlogic-desktop";

/// How long we wait for the user to approve in the browser before giving up.
pub const DEFAULT_LINK_TIMEOUT: Duration = Duration::from_secs(300);

// ── base64url (no padding), RFC 4648 §5 ───────────────────────────────────────

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode bytes as unpadded base64url (the encoding PKCE + `state` use).
pub fn base64url_nopad(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() * 4 + 2) / 3);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[((n >> 18) & 0x3f) as usize] as char);
        out.push(B64URL[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64URL[((n >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[(n & 0x3f) as usize] as char);
        }
    }
    out
}

// ── PKCE (RFC 7636) ───────────────────────────────────────────────────────────

/// A PKCE pair: the secret `verifier` (kept for the token exchange) and the
/// S256 `challenge` (sent in the authorize URL).
#[derive(Debug, Clone)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

/// Derive the S256 challenge for a verifier: `base64url(SHA256(ascii(verifier)))`.
pub fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64url_nopad(&digest)
}

/// Generate a fresh PKCE pair. The verifier is `base64url(32 random bytes)` = 43
/// chars, within RFC 7636's 43–128 range and drawn from the unreserved set.
pub fn generate_pkce() -> PkcePair {
    let verifier = base64url_nopad(&random_bytes::<32>());
    let challenge = pkce_challenge(&verifier);
    PkcePair { verifier, challenge }
}

/// A random opaque `state` (CSRF / response-binding), 32 bytes base64url.
pub fn generate_state() -> String {
    base64url_nopad(&random_bytes::<32>())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    // getrandom is already a dependency (pairing tokens). On the astronomically
    // unlikely error, fall back to a time+addr mix so we never panic — the value
    // is still unique-per-attempt (PKCE/state are single-use).
    if getrandom::getrandom(&mut buf).is_err() {
        let seed = Instant::now().elapsed().as_nanos() as u64 ^ (&buf as *const _ as u64);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (seed.rotate_left(i as u32 * 7) & 0xff) as u8;
        }
    }
    buf
}

// ── authorize URL ─────────────────────────────────────────────────────────────

/// Build `<base>/oauth/authorize?…` (the SPA consent route). `base_url` is the
/// SITE root; it's normalized (trailing slash / `/api` suffix stripped). All
/// values are properly percent-encoded (scope has spaces, device may too).
pub fn build_authorize_url(
    base_url: &str,
    redirect_uri: &str,
    scope: &str,
    challenge: &str,
    state: &str,
    device: &str,
) -> Result<String, String> {
    let base = crate::formlogic_client::normalize_base(base_url);
    if base.is_empty() {
        return Err("base URL is empty".into());
    }
    let mut url = url::Url::parse(&format!("{base}/oauth/authorize"))
        .map_err(|e| format!("invalid base URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", scope)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("device", device);
    Ok(url.into())
}

// ── loopback callback ─────────────────────────────────────────────────────────

/// The parsed OAuth redirect query (`/callback?…`). Either `code` (+ `state`) on
/// success, or `error` (+ optional `error_description`) on denial.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

impl CallbackParams {
    /// A usable OAuth response — carries a code or an error (not a stray hit like
    /// `/favicon.ico`).
    fn is_oauth_response(&self) -> bool {
        self.code.is_some() || self.error.is_some()
    }
}

/// Split an HTTP request line ("GET /callback?a=b HTTP/1.1") into (path, query).
pub fn parse_request_target(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let _method = parts.next()?;
    let target = parts.next()?;
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.to_string(), String::new()),
    };
    Some((path, query))
}

/// Parse a `code=…&state=…` (or `error=…`) query string into `CallbackParams`.
pub fn parse_callback_query(query: &str) -> CallbackParams {
    let mut out = CallbackParams::default();
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        let v = v.into_owned();
        match k.as_ref() {
            "code" if !v.is_empty() => out.code = Some(v),
            "state" if !v.is_empty() => out.state = Some(v),
            "error" if !v.is_empty() => out.error = Some(v),
            "error_description" if !v.is_empty() => out.error_description = Some(v),
            _ => {}
        }
    }
    out
}

/// Why a loopback wait ended without a usable OAuth response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopbackError {
    /// The user pressed Cancel in the desktop UI.
    Cancelled,
    /// No callback arrived within the deadline.
    Timeout,
    /// The listener/socket errored irrecoverably.
    Io(String),
}

impl std::fmt::Display for LoopbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoopbackError::Cancelled => write!(f, "linking was cancelled"),
            LoopbackError::Timeout => write!(f, "timed out waiting for the browser approval"),
            LoopbackError::Io(e) => write!(f, "loopback error: {e}"),
        }
    }
}

/// A one-shot loopback HTTP listener for the OAuth redirect. Binds an ephemeral
/// `127.0.0.1` port; `accept_callback` serves exactly the OAuth hit (answering
/// stray requests like `/favicon.ico` with 404 and continuing to wait).
pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

impl Loopback {
    /// Bind `127.0.0.1:0` (kernel-assigned free port).
    pub async fn bind() -> Result<Self, LoopbackError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| LoopbackError::Io(e.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|e| LoopbackError::Io(e.to_string()))?
            .port();
        Ok(Self { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The redirect URI to register in the authorize request. Uses `127.0.0.1`
    /// (matched port-agnostically by the backend's registered loopback URIs).
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Block until the OAuth callback arrives, or `cancel` flips, or `deadline`
    /// passes. Non-OAuth requests get a 404 and the wait continues.
    pub async fn accept_callback(
        &self,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CallbackParams, LoopbackError> {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(LoopbackError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(LoopbackError::Timeout);
            }
            // Wake at least every 250 ms to re-check cancel + deadline.
            let accept = tokio::time::timeout(Duration::from_millis(250), self.listener.accept());
            let (stream, _addr) = match accept.await {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return Err(LoopbackError::Io(e.to_string())),
                Err(_) => continue, // tick — re-check cancel/deadline
            };
            match handle_connection(stream).await {
                Some(params) if params.is_oauth_response() => return Ok(params),
                _ => continue, // favicon / empty / non-OAuth — keep waiting
            }
        }
    }
}

/// Read one request, answer it, and (when it's the OAuth callback) return the
/// parsed params. Best-effort throughout — a flaky socket just yields `None`.
async fn handle_connection(mut stream: TcpStream) -> Option<CallbackParams> {
    // The request line is all we need; cap the read so a slow/oversized client
    // can't stall us. 8 KiB comfortably holds the callback line + headers.
    let mut buf = vec![0u8; 8192];
    let n = match tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return None,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let first_line = head.lines().next().unwrap_or("");
    let (path, query) = match parse_request_target(first_line) {
        Some(pq) => pq,
        None => {
            let _ = respond(&mut stream, 400, "Bad Request").await;
            return None;
        }
    };
    if path != "/callback" {
        let _ = respond(&mut stream, 404, "Not Found").await;
        return None;
    }
    let params = parse_callback_query(&query);
    let page = if params.error.is_some() {
        closing_page(false, params.error_description.as_deref().or(params.error.as_deref()))
    } else if params.code.is_some() {
        closing_page(true, None)
    } else {
        // /callback with neither code nor error — not our response.
        let _ = respond(&mut stream, 400, "Missing authorization code").await;
        return None;
    };
    let _ = respond_html(&mut stream, &page).await;
    Some(params)
}

async fn respond(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    let body = format!("{status} {reason}");
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await
}

async fn respond_html(stream: &mut TcpStream, html: &str) -> std::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await
}

/// The page the browser shows after the redirect. Self-contained (CSP-safe),
/// theme-neutral, tells the user they can close the tab.
fn closing_page(success: bool, error: Option<&str>) -> String {
    let (title, message) = if success {
        (
            "You're linked",
            "FormLogic Desktop is now connected to your account. You can close this tab and return to the app.".to_string(),
        )
    } else {
        (
            "Linking failed",
            format!(
                "FormLogic Desktop could not be linked{}. You can close this tab and try again from the app.",
                error.map(|e| format!(": {}", html_escape(e))).unwrap_or_default()
            ),
        )
    };
    let accent = if success { "#4f46e5" } else { "#b91c1c" };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>FormLogic Desktop</title></head>\
<body style=\"margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center\">\
<main style=\"max-width:28rem;padding:2rem;text-align:center\">\
<div style=\"width:3rem;height:3rem;border-radius:9999px;margin:0 auto 1rem;background:{accent};display:flex;align-items:center;justify-content:center;font-size:1.5rem\">{icon}</div>\
<h1 style=\"font-size:1.25rem;margin:0 0 .5rem\">{title}</h1>\
<p style=\"margin:0;color:#9ca3af;line-height:1.5\">{message}</p>\
</main></body></html>",
        accent = accent,
        icon = if success { "&#10003;" } else { "&#33;" },
        title = title,
        message = message,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ── link status machine (Tauri-managed, polled by the UI) ────────────────────

/// The observable phase of an in-progress / finished link attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkPhase {
    /// No attempt has run this session.
    Idle,
    /// Binding the loopback + opening the browser.
    Starting,
    /// Waiting for the user to approve in the browser.
    AwaitingBrowser,
    /// Redeeming the code for the scoped key.
    Exchanging,
    /// Linked successfully.
    Linked,
    /// The user cancelled.
    Cancelled,
    /// The attempt failed (see `message`).
    Error,
}

/// A snapshot of the link machine for `formlogic_oauth_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthLinkStatus {
    pub phase: LinkPhase,
    /// True while an attempt is running (Starting/AwaitingBrowser/Exchanging).
    pub in_progress: bool,
    /// A human message for the current phase (progress or error text).
    pub message: Option<String>,
    /// The linked device label (on success).
    pub device_name: Option<String>,
}

/// Shared, Tauri-managed link machine. One attempt at a time (`begin` gates it).
pub struct OAuthLink {
    phase: Mutex<LinkPhase>,
    message: Mutex<Option<String>>,
    device_name: Mutex<Option<String>>,
    running: AtomicBool,
    cancel: AtomicBool,
}

impl Default for OAuthLink {
    fn default() -> Self {
        Self {
            phase: Mutex::new(LinkPhase::Idle),
            message: Mutex::new(None),
            device_name: Mutex::new(None),
            running: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
}

impl OAuthLink {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }

    /// Try to claim the single attempt slot. Returns false if one is already
    /// running. Clears any prior cancel flag so a fresh attempt starts clean.
    pub fn begin(&self) -> bool {
        if self.running.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.cancel.store(false, Ordering::SeqCst);
        true
    }

    /// Release the attempt slot (call once when an attempt task ends).
    pub fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// Ask the running attempt to stop at the next check.
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Advance the phase, replacing the message.
    pub fn set(&self, phase: LinkPhase, message: Option<String>) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase;
        *self.message.lock().unwrap_or_else(|e| e.into_inner()) = message;
    }

    /// Terminal success — record the device label.
    pub fn set_linked(&self, device_name: Option<String>) {
        *self.device_name.lock().unwrap_or_else(|e| e.into_inner()) = device_name.clone();
        let msg = device_name
            .as_deref()
            .map(|d| format!("Linked as {d}"))
            .unwrap_or_else(|| "Linked".to_string());
        self.set(LinkPhase::Linked, Some(msg));
    }

    pub fn status(&self) -> OAuthLinkStatus {
        let phase = *self.phase.lock().unwrap_or_else(|e| e.into_inner());
        OAuthLinkStatus {
            phase,
            in_progress: matches!(
                phase,
                LinkPhase::Starting | LinkPhase::AwaitingBrowser | LinkPhase::Exchanging
            ),
            message: self.message.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            device_name: self.device_name.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_rfc_vectors() {
        // RFC 4648 §10 test vectors, base64url no-pad.
        assert_eq!(base64url_nopad(b""), "");
        assert_eq!(base64url_nopad(b"f"), "Zg");
        assert_eq!(base64url_nopad(b"fo"), "Zm8");
        assert_eq!(base64url_nopad(b"foo"), "Zm9v");
        assert_eq!(base64url_nopad(b"foob"), "Zm9vYg");
        assert_eq!(base64url_nopad(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url_nopad(b"foobar"), "Zm9vYmFy");
        // A byte that exercises the '-'/'_' url-safe alphabet (0xfb,0xff → "-_").
        assert_eq!(base64url_nopad(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn pkce_s256_rfc7636_appendix_b() {
        // RFC 7636 Appendix B canonical vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = pkce_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_pkce_roundtrips() {
        let p = generate_pkce();
        // Verifier is 43 chars (32 bytes base64url no-pad) and derives its challenge.
        assert_eq!(p.verifier.len(), 43);
        assert_eq!(pkce_challenge(&p.verifier), p.challenge);
        // Two generations differ.
        assert_ne!(generate_pkce().verifier, p.verifier);
        // State is also 43 chars and unique.
        assert_eq!(generate_state().len(), 43);
        assert_ne!(generate_state(), generate_state());
    }

    #[test]
    fn request_target_parsing() {
        assert_eq!(
            parse_request_target("GET /callback?code=abc&state=xyz HTTP/1.1"),
            Some(("/callback".into(), "code=abc&state=xyz".into()))
        );
        assert_eq!(
            parse_request_target("GET /favicon.ico HTTP/1.1"),
            Some(("/favicon.ico".into(), String::new()))
        );
        assert_eq!(parse_request_target(""), None);
        assert_eq!(parse_request_target("GARBAGE"), None);
    }

    #[test]
    fn callback_query_parsing() {
        let ok = parse_callback_query("code=the-code&state=the-state");
        assert_eq!(ok.code.as_deref(), Some("the-code"));
        assert_eq!(ok.state.as_deref(), Some("the-state"));
        assert!(ok.error.is_none());
        assert!(ok.is_oauth_response());

        // Percent-decoding + error path.
        let err = parse_callback_query("error=access_denied&error_description=User%20said%20no");
        assert_eq!(err.error.as_deref(), Some("access_denied"));
        assert_eq!(err.error_description.as_deref(), Some("User said no"));
        assert!(err.code.is_none());
        assert!(err.is_oauth_response());

        // A stray hit (no oauth fields) is not a response.
        assert!(!parse_callback_query("").is_oauth_response());
        assert!(!parse_callback_query("foo=bar").is_oauth_response());
        // Empty values are ignored.
        assert!(parse_callback_query("code=&state=").code.is_none());
    }

    #[test]
    fn authorize_url_encodes_params() {
        let url = build_authorize_url(
            "https://formlogic.com/",
            "http://127.0.0.1:54321/callback",
            DESKTOP_SCOPES,
            "CHAL",
            "STATE",
            "Reception PC",
        )
        .expect("builds");
        assert!(url.starts_with("https://formlogic.com/oauth/authorize?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=formlogic-desktop"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        // Spaces are percent/plus-encoded, not literal.
        assert!(url.contains("scope=flows%3Aread"));
        assert!(url.contains("connector%3Arelay"));
        assert!(url.contains("device=Reception+PC") || url.contains("device=Reception%20PC"));
        // /api base suffix is stripped by normalization.
        let u2 = build_authorize_url("https://x.test/api", "http://127.0.0.1:1/callback", "s", "c", "st", "d").unwrap();
        assert!(u2.starts_with("https://x.test/oauth/authorize?"));
        // Empty base rejected.
        assert!(build_authorize_url("   ", "r", "s", "c", "st", "d").is_err());
    }

    #[test]
    fn link_machine_gates_and_transitions() {
        let link = OAuthLink::new();
        assert_eq!(link.status().phase, LinkPhase::Idle);
        assert!(!link.status().in_progress);

        // Only one attempt at a time.
        assert!(link.begin());
        assert!(!link.begin());
        assert!(link.is_running());

        link.set(LinkPhase::AwaitingBrowser, Some("waiting".into()));
        let s = link.status();
        assert_eq!(s.phase, LinkPhase::AwaitingBrowser);
        assert!(s.in_progress);
        assert_eq!(s.message.as_deref(), Some("waiting"));

        // Cancel is observable via the flag.
        link.request_cancel();
        assert!(link.cancel_flag().load(Ordering::SeqCst));

        link.set_linked(Some("Reception PC".into()));
        link.finish();
        let s = link.status();
        assert_eq!(s.phase, LinkPhase::Linked);
        assert!(!s.in_progress);
        assert_eq!(s.device_name.as_deref(), Some("Reception PC"));

        // A fresh begin clears the stale cancel flag.
        assert!(link.begin());
        assert!(!link.cancel_flag().load(Ordering::SeqCst));
        link.finish();
    }

    #[tokio::test]
    async fn loopback_captures_the_callback() {
        let lb = Loopback::bind().await.expect("bind");
        let uri = lb.redirect_uri();
        assert!(uri.starts_with("http://127.0.0.1:"));
        let port = lb.port();
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(5);

        // Drive a client hit concurrently with the accept.
        let client = tokio::spawn(async move {
            // A stray favicon first — must be ignored.
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)).await {
                let _ = s.write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n").await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(b"GET /callback?code=abc123&state=st9 HTTP/1.1\r\nHost: x\r\n\r\n")
                .await
                .unwrap();
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        });

        let params = lb.accept_callback(&cancel, deadline).await.expect("callback");
        assert_eq!(params.code.as_deref(), Some("abc123"));
        assert_eq!(params.state.as_deref(), Some("st9"));
        let page = client.await.unwrap();
        assert!(page.contains("200 OK"));
        assert!(page.contains("You&#39;re linked") || page.contains("linked"));
    }

    #[tokio::test]
    async fn loopback_honours_cancel() {
        let lb = Loopback::bind().await.expect("bind");
        let cancel = AtomicBool::new(true); // already cancelled
        let deadline = Instant::now() + Duration::from_secs(5);
        assert_eq!(
            lb.accept_callback(&cancel, deadline).await.unwrap_err(),
            LoopbackError::Cancelled
        );
    }

    #[tokio::test]
    async fn loopback_times_out() {
        let lb = Loopback::bind().await.expect("bind");
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now(); // already past
        assert_eq!(
            lb.accept_callback(&cancel, deadline).await.unwrap_err(),
            LoopbackError::Timeout
        );
    }
}
