//! The plugin's own link to a FormLogic account, separate from OAIY's: a sign-in in the browser with
//! a one-time code (PKCE, RFC 8252), which FormLogic turns into a key good for backups and nothing
//! else. The plugin opens the browser itself, so the sign-in address never appears in a command's
//! answer. The key is kept in `link.json` and goes with the plugin.

use std::io::{Read as _, Write as _};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{client, native, secret_file};

const FILE: &str = "link.json";
const CLIENT_ID: &str = "formlogic-backups-plugin";
const SCOPE: &str = "data:snapshot";
/// How long the person has to sign in and approve.
const SIGN_IN: Duration = Duration::from_secs(300);
/// Well over any request. A browser sends cookies for 127.0.0.1 here too, whatever their port.
const MAX_REQUEST_BYTES: usize = 65_536;

const URL_SAFE: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The linked account. Deliberately not `Debug`: it holds the key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub base_url: String,
    pub credential: String,
    pub account_id: String,
    pub account_email: String,
    pub api_key_id: String,
    pub linked_at: String,
}

pub fn load(data: &Path) -> Result<Option<Account>, String> {
    match std::fs::read(data.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| "This computer's link to FormLogic is damaged. Forget it and connect again.".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read this computer's link to FormLogic: {e}")),
    }
}

pub fn save(data: &Path, account: &Account) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(account).map_err(|e| e.to_string())?;
    secret_file::write(&data.join(FILE), bytes).map_err(|e| format!("Could not save the link: {e}"))
}

pub fn remove(data: &Path) -> Result<(), String> {
    match std::fs::remove_file(data.join(FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not forget the link: {e}")),
        _ => Ok(()),
    }
}

fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// A server as typed, as `https://host[:port][/path]` with no slash at the end. Plain http is for a
/// server on this computer: the sign-in would otherwise cross the network in the open.
pub fn normalise_server(typed: &str) -> Result<String, String> {
    let bad = || "That isn't a server address. Enter it as https://your-formlogic.example.".to_string();
    let typed = typed.trim().trim_end_matches('/');
    if typed.is_empty() || typed.len() > 200 || typed.chars().any(|c| c.is_whitespace() || c.is_control() || "\\@?#%\"'<>".contains(c)) {
        return Err(bad());
    }
    let (scheme, rest) = match typed.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("https".to_string(), typed),
    };
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority.to_ascii_lowercase(), format!("/{path}")),
        None => (rest.to_ascii_lowercase(), String::new()),
    };
    if path.split('/').any(|part| part == "." || part == "..") {
        return Err(bad());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !authority.ends_with(']') => (host.to_string(), Some(port.to_string())),
        _ => (authority.clone(), None),
    };
    let plain_name = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') && !host.starts_with(['-', '.']);
    if !plain_name && !loopback(&host) {
        return Err(bad());
    }
    if port.as_deref().is_some_and(|port| port.parse::<u16>().map_or(true, |number| number == 0)) {
        return Err(bad());
    }
    match scheme.as_str() {
        "https" => {}
        "http" if loopback(&host) => {}
        "http" => return Err("A server across the network must use https.".to_string()),
        _ => return Err(bad()),
    }
    Ok(format!("{scheme}://{authority}{path}"))
}

fn encode(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = (bytes[at] == b'%').then(|| bytes.get(at + 1..at + 3)).flatten().and_then(|pair| std::str::from_utf8(pair).ok()).and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(if bytes[at] == b'+' { b' ' } else { bytes[at] });
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_text() -> Result<String, String> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    Ok(URL_SAFE.encode(random))
}

fn challenge_of(verifier: &str) -> String {
    URL_SAFE.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(server: &str, redirect: &str, challenge: &str, state: &str, device: Option<&str>) -> String {
    let mut url = format!(
        "{server}/oauth/authorize?response_type=code&client_id={CLIENT_ID}&redirect_uri={}&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}",
        encode(redirect),
        encode(SCOPE),
    );
    if let Some(device) = device {
        url.push_str(&format!("&device={}", encode(device)));
    }
    url
}

/// What the browser came back with.
#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Refused,
    /// Not for this sign-in: a favicon, another program, a state that doesn't match.
    Ignored,
}

fn read_callback(request_line: &str, state: &str) -> Callback {
    let target = request_line.strip_prefix("GET ").and_then(|rest| rest.split(' ').next()).unwrap_or("");
    let Some(query) = target.strip_prefix("/callback?") else { return Callback::Ignored };
    let field = |name: &str| query.split('&').find_map(|pair| pair.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| decode(value)));
    if !field("state").is_some_and(|sent| oaiy_crypto::zeroize::ct_eq(sent.as_bytes(), state.as_bytes())) {
        return Callback::Ignored;
    }
    match (field("code"), field("error")) {
        (Some(code), None) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Refused,
    }
}

fn answer_browser(stream: &mut TcpStream, status: &str, words: &str) {
    let page = format!("<!doctype html><meta charset=utf-8><title>FormLogic Backups</title><p style=\"font:16px system-ui;margin:3em;text-align:center\">{words}</p>");
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{page}", page.len());
    let _ = stream.flush();
    // Closed from this end first, and only then let go: closing with bytes unread resets the
    // connection, the browser loses the page, and its retry finds nobody listening.
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut rest = [0u8; 1024];
    while matches!(stream.read(&mut rest), Ok(read) if read > 0) {}
}

/// Reads the whole request and gives back its first line. A browser also opens connections it
/// sends nothing on, so a silent one is let go after a moment, and a slow one no later: this is one
/// connection at a time, and nothing here should be able to hold up the sign-in.
fn first_line(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    let until = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    while Instant::now() < until && bytes.len() < MAX_REQUEST_BYTES && !bytes.windows(4).any(|end| end == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&bytes).lines().next().map(str::to_string)
}

/// Waits for the browser to come back with this sign-in's code.
fn wait_for_code(listener: &TcpListener, state: &str, until: Instant) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    while Instant::now() < until {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(format!("The sign-in stopped: {e}")),
        };
        let _ = stream.set_nonblocking(false);
        match first_line(&mut stream).map(|line| read_callback(&line, state)) {
            Some(Callback::Code(code)) => {
                answer_browser(&mut stream, "200 OK", "FormLogic Backups is connected. You can close this tab.");
                return Ok(code);
            }
            Some(Callback::Refused) => {
                answer_browser(&mut stream, "200 OK", "Nothing was connected. You can close this tab.");
                return Err("The sign-in was refused in the browser.".to_string());
            }
            _ => answer_browser(&mut stream, "404 Not Found", "Not found."),
        }
    }
    Err("The sign-in timed out. Try again.".to_string())
}

fn exchange(server: &str, code: &str, verifier: &str, redirect: &str) -> Result<Account, String> {
    let sent = client::agent(Duration::from_secs(30)).post(&format!("{server}/api/oauth/token")).send_form(&[
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect),
    ]);
    let refused = "FormLogic did not finish the sign-in. Check that this server has the backup connection (FormLogic 0.1.18 or later), and try again.".to_string();
    let body: Value = match sent {
        Ok(response) if response.status() == 200 => client::read_json(response).ok_or_else(|| refused.clone())?,
        _ => return Err(refused),
    };
    let text = |field: &str| body.get(field).and_then(Value::as_str).map(str::to_string).filter(|value| !value.is_empty());
    let (Some(credential), Some(api_key_id), Some(account_id)) = (text("formlogic_api_key"), text("api_key_id"), text("account_id")) else {
        return Err(refused);
    };
    Ok(Account {
        base_url: server.to_string(),
        credential,
        api_key_id,
        account_id,
        account_email: text("account_email").unwrap_or_default(),
        linked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })
}

/// The whole sign-in, from opening the browser to holding the key. `server` is already normal.
pub fn sign_in(server: &str, device: Option<&str>) -> Result<Account, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Could not listen for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_text()?;
    let state = random_text()?;
    native::open_url(&authorize_url(server, &redirect, &challenge_of(&verifier), &state, device))?;
    let code = wait_for_code(&listener, &state, Instant::now() + SIGN_IN)?;
    exchange(server, &code, &verifier, &redirect)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_is_put_in_one_form() {
        assert_eq!(normalise_server("https://Forms.Example.com/").unwrap(), "https://forms.example.com");
        assert_eq!(normalise_server("forms.example.com").unwrap(), "https://forms.example.com");
        assert_eq!(normalise_server(" https://example.com:8443/formlogic/ ").unwrap(), "https://example.com:8443/formlogic");
        assert_eq!(normalise_server("http://127.0.0.1:8091").unwrap(), "http://127.0.0.1:8091");
        assert_eq!(normalise_server("http://localhost:8091").unwrap(), "http://localhost:8091");
        assert_eq!(normalise_server("http://[::1]:8091").unwrap(), "http://[::1]:8091");
    }

    #[test]
    fn plain_http_is_only_for_this_computer() {
        assert!(normalise_server("http://forms.example.com").unwrap_err().contains("https"));
        assert!(normalise_server("http://localhost.example.com").is_err());
        assert!(normalise_server("http://127.0.0.1.example.com").is_err());
    }

    #[test]
    fn an_address_that_could_mean_two_things_is_refused() {
        for bad in [
            "", "ftp://example.com", "file:///etc/passwd", "https://user:pw@example.com", "https://good.example@evil.example", "https://example.com?x=1", "https://example.com#x",
            "https://exa mple.com", "https://example.com\\@evil.example", "https://example.com/../x", "https://example.com:99999", "https://example.com:0", "https://example.com:x",
            "https://-example.com", "https:///x", "javascript:alert(1)",
        ] {
            assert!(normalise_server(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_challenge_is_rfc_7636s() {
        // RFC 7636, appendix B.
        assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn the_sign_in_address_asks_for_the_one_scope() {
        let url = authorize_url("https://x.example", "http://127.0.0.1:5111/callback", "abc", "st", Some("Front Desk"));
        assert!(url.starts_with("https://x.example/oauth/authorize?"), "{url}");
        assert!(url.contains("client_id=formlogic-backups-plugin"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5111%2Fcallback"));
        assert!(url.contains("scope=data%3Asnapshot"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("device=Front%20Desk"));
    }

    #[test]
    fn only_this_sign_ins_answer_counts() {
        let state = "right-state";
        assert_eq!(read_callback("GET /callback?code=c1&state=right-state HTTP/1.1", state), Callback::Code("c1".to_string()));
        assert_eq!(read_callback("GET /callback?error=access_denied&state=right-state HTTP/1.1", state), Callback::Refused);
        assert_eq!(read_callback("GET /callback?code=c1&state=wrong HTTP/1.1", state), Callback::Ignored);
        assert_eq!(read_callback("GET /callback?code=c1 HTTP/1.1", state), Callback::Ignored);
        assert_eq!(read_callback("GET /favicon.ico HTTP/1.1", state), Callback::Ignored);
        assert_eq!(read_callback("POST /callback?code=c1&state=right-state HTTP/1.1", state), Callback::Ignored);
    }

    #[test]
    fn the_browser_comes_back_through_the_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            for target in ["/favicon.ico", "/callback?code=wrong&state=other", "/callback?code=the%2Dcode&state=st"] {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(stream, "GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
                let mut answer = String::new();
                stream.read_to_string(&mut answer).unwrap();
                assert!(answer.contains("Connection: close"), "{answer}");
            }
        });
        assert_eq!(wait_for_code(&listener, "st", Instant::now() + Duration::from_secs(20)).unwrap(), "the-code");
        browser.join().unwrap();
    }

    /// What a browser does: an idle connection first, then a long request. Closing with its
    /// headers unread would reset the connection and lose the page.
    #[test]
    fn a_browsers_long_request_gets_its_page() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            let _idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let cookies = "x".repeat(20_000);
            write!(stream, "GET /callback?code=c&state=st HTTP/1.1\r\nHost: x\r\nCookie: {cookies}\r\n\r\n").unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            answer
        });
        assert_eq!(wait_for_code(&listener, "st", Instant::now() + Duration::from_secs(20)).unwrap(), "c");
        assert!(browser.join().unwrap().contains("FormLogic Backups is connected"));
    }

    #[test]
    fn a_sign_in_nobody_finishes_gives_up() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        assert!(wait_for_code(&listener, "st", Instant::now() + Duration::from_millis(200)).unwrap_err().contains("timed out"));
    }

    #[test]
    fn the_link_is_saved_and_forgotten() {
        let dir = std::env::temp_dir().join(format!("fl-backups-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).unwrap().is_none());
        let account = Account { base_url: "https://x.example".into(), credential: "flk_x".into(), account_id: "u1".into(), account_email: "a@x.example".into(), api_key_id: "k1".into(), linked_at: "now".into() };
        save(&dir, &account).unwrap();
        assert_eq!(load(&dir).unwrap().unwrap().credential, "flk_x");
        remove(&dir).unwrap();
        assert!(load(&dir).unwrap().is_none());
        remove(&dir).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
