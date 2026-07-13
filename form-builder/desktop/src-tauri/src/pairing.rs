//! Origin-bound pairing tokens — the local auth for the plugin/connector API.
//!
//! Loopback is not sufficient for privileged commands (any local web page can
//! reach 127.0.0.1), so the desktop API contract (§3 of
//! `formlogic-app/docs/FORMLOGIC_DESKTOP.md`) requires:
//!
//!   1. the browser POSTs `/api/desktop/pairing-requests {origin}`;
//!   2. the user approves the request in the Desktop window (or the
//!      `FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN` dev bypass auto-approves it);
//!   3. the poll returns a bearer token (32 random bytes, base64url) BOUND to
//!      that origin — the desktop stores only `sha256(token)` + origin +
//!      createdAt in its config dir, never the plaintext;
//!   4. requests whose `Origin` header doesn't match the token's binding are
//!      rejected `origin_denied`. Tokens expire after [`TOKEN_TTL_DAYS`].

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

/// Pairing tokens live 30 days; re-pairing is a click.
pub const TOKEN_TTL_DAYS: i64 = 30;
/// Unclaimed pairing requests evaporate after 10 minutes.
pub const REQUEST_TTL_MINUTES: i64 = 10;
/// Cap on simultaneous pending requests, so a hostile local page can't grow
/// unbounded state by hammering the endpoint.
pub const MAX_PENDING_REQUESTS: usize = 32;

/// Outcome of a token check, so the guard can answer `auth_required` vs
/// `origin_denied` precisely.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenCheck {
    /// Token valid AND bound to the presented origin.
    Ok,
    /// Token exists but is bound to a different origin.
    WrongOrigin,
    /// Token unknown or expired.
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenRecord {
    /// Hex sha256 of the bearer token (plaintext is never stored).
    sha256: String,
    origin: String,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedTokens {
    #[serde(default)]
    tokens: Vec<TokenRecord>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RequestStatus {
    Pending,
    /// Carries the plaintext token for the requester's poll to pick up.
    Approved { token: String },
    Denied,
}

#[derive(Debug, Clone)]
pub struct PairingRequest {
    pub id: String,
    pub origin: String,
    pub status: RequestStatus,
    pub created_at: DateTime<Utc>,
}

/// Result of [`PairingStore::begin`]. `auto_approved` is true when the origin
/// was ALREADY trusted (a live token exists) or the dev bypass matched — the
/// caller can poll for its token immediately, no native approval needed.
/// `request_id` is `None` only for a SILENT request on an untrusted origin:
/// nothing is created (so a page probing on load can't spam the Desktop's
/// approval list), and the caller falls back to an explicit Connect click.
#[derive(Debug, Clone, PartialEq)]
pub struct BeginOutcome {
    pub request_id: Option<String>,
    pub auto_approved: bool,
}

/// Wire view of one pending request (Desktop window UI).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequestInfo {
    pub id: String,
    pub origin: String,
    pub status: &'static str,
    pub created_at: DateTime<Utc>,
}

/// Wire view of one trusted origin (`GET /api/origins`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedOrigin {
    pub origin: String,
    /// When the origin was FIRST paired.
    pub created_at: DateTime<Utc>,
    /// Live (unexpired) tokens bound to it.
    pub tokens: usize,
}

struct PairingInner {
    tokens: Vec<TokenRecord>,
    requests: HashMap<String, PairingRequest>,
}

pub type PairingHandle = Arc<PairingStore>;

pub struct PairingStore {
    /// `pairing.json` in the desktop CONFIG dir (survives data-dir moves).
    path: PathBuf,
    inner: Mutex<PairingInner>,
    /// `FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN` — auto-approve THIS exact origin.
    dev_allow_origin: Option<String>,
}

impl PairingStore {
    pub fn new(path: PathBuf, dev_allow_origin: Option<String>) -> PairingHandle {
        let persisted: PersistedTokens = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let store = Arc::new(Self {
            path,
            inner: Mutex::new(PairingInner {
                tokens: persisted.tokens,
                requests: HashMap::new(),
            }),
            dev_allow_origin: dev_allow_origin.filter(|s| !s.trim().is_empty()),
        });
        store.purge_expired();
        store
    }

    fn lock(&self) -> MutexGuard<'_, PairingInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Begin pairing for `origin`. With the dev bypass OR an already-trusted
    /// origin (one that still holds a live token), the request is born
    /// APPROVED — a browser that lost its session token re-pairs with no
    /// native prompt, because the user already vouched for this exact origin
    /// and a same-origin page could use the existing token anyway (so a fresh
    /// one grants nothing new). A brand-new origin still needs explicit
    /// approval. `silent` (a page probing on load) suppresses creating a
    /// PENDING request for an untrusted origin, so it can't clutter the
    /// Desktop's approval list — the caller then shows an explicit button.
    pub fn begin(&self, origin: &str, silent: bool) -> Result<BeginOutcome, String> {
        let origin = normalize_origin(origin)?;
        let id = uuid::Uuid::new_v4().to_string();
        let dev_approved = self.dev_allow_origin.as_deref() == Some(origin.as_str());
        let mut token_to_store: Option<String> = None;
        {
            let mut inner = self.lock();
            purge_expired_inner(&mut inner);
            let already_trusted = inner
                .tokens
                .iter()
                .any(|t| t.origin == origin && !token_expired(t));
            let auto = dev_approved || already_trusted;
            // A silent probe on an untrusted origin creates NOTHING — no
            // pending request, no Desktop-window nag. The caller falls back to
            // an explicit Connect click, which is a non-silent begin().
            if !auto && silent {
                return Ok(BeginOutcome {
                    request_id: None,
                    auto_approved: false,
                });
            }
            // One pending request per origin: re-POSTing replaces it, so the
            // pending list in the Desktop window never shows duplicates.
            inner
                .requests
                .retain(|_, r| !(r.origin == origin && r.status == RequestStatus::Pending));
            if !auto
                && inner
                    .requests
                    .values()
                    .filter(|r| r.status == RequestStatus::Pending)
                    .count()
                    >= MAX_PENDING_REQUESTS
            {
                return Err("too many pending pairing requests".into());
            }
            let status = if auto {
                let token = generate_token()?;
                token_to_store = Some(token.clone());
                RequestStatus::Approved { token }
            } else {
                RequestStatus::Pending
            };
            if let Some(t) = &token_to_store {
                inner.tokens.push(TokenRecord {
                    sha256: sha256_hex(t),
                    origin: origin.clone(),
                    created_at: Utc::now(),
                });
            }
            inner.requests.insert(
                id.clone(),
                PairingRequest {
                    id: id.clone(),
                    origin,
                    status,
                    created_at: Utc::now(),
                },
            );
        }
        if token_to_store.is_some() {
            self.persist();
        }
        Ok(BeginOutcome {
            request_id: Some(id),
            auto_approved: token_to_store.is_some(),
        })
    }

    /// Poll a request. `origin_hint` (the caller's Origin header, when it
    /// sent one) must match the request's origin — a page can't harvest a
    /// token that was requested for someone else's origin.
    pub fn poll(&self, id: &str, origin_hint: Option<&str>) -> Result<PairingRequest, String> {
        let mut inner = self.lock();
        purge_expired_inner(&mut inner);
        let req = inner
            .requests
            .get(id)
            .ok_or_else(|| "unknown or expired pairing request".to_string())?;
        if let Some(o) = origin_hint {
            if normalize_origin(o).as_deref() != Ok(req.origin.as_str()) {
                return Err("origin does not match this pairing request".into());
            }
        }
        Ok(req.clone())
    }

    /// Approve a pending request (Desktop window / privileged caller):
    /// mints + persists the origin-bound token.
    pub fn approve(&self, id: &str) -> Result<(), String> {
        let token = generate_token()?;
        {
            let mut inner = self.lock();
            let req = inner
                .requests
                .get_mut(id)
                .ok_or_else(|| "unknown or expired pairing request".to_string())?;
            if req.status != RequestStatus::Pending {
                return Err("pairing request is not pending".into());
            }
            let origin = req.origin.clone();
            req.status = RequestStatus::Approved { token: token.clone() };
            inner.tokens.push(TokenRecord {
                sha256: sha256_hex(&token),
                origin,
                created_at: Utc::now(),
            });
        }
        self.persist();
        Ok(())
    }

    pub fn deny(&self, id: &str) -> Result<(), String> {
        let mut inner = self.lock();
        let req = inner
            .requests
            .get_mut(id)
            .ok_or_else(|| "unknown or expired pairing request".to_string())?;
        if req.status != RequestStatus::Pending {
            return Err("pairing request is not pending".into());
        }
        req.status = RequestStatus::Denied;
        Ok(())
    }

    /// Pending requests for the Desktop window's approval UI.
    pub fn pending(&self) -> Vec<PairingRequestInfo> {
        let mut inner = self.lock();
        purge_expired_inner(&mut inner);
        let mut out: Vec<PairingRequestInfo> = inner
            .requests
            .values()
            .filter(|r| r.status == RequestStatus::Pending)
            .map(|r| PairingRequestInfo {
                id: r.id.clone(),
                origin: r.origin.clone(),
                status: "pending",
                created_at: r.created_at,
            })
            .collect();
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// Validate a bearer token against the presented origin.
    pub fn check(&self, token: &str, origin: Option<&str>) -> TokenCheck {
        let hash = sha256_hex(token);
        let inner = self.lock();
        let rec = inner
            .tokens
            .iter()
            .find(|t| t.sha256 == hash && !token_expired(t));
        match (rec, origin) {
            (None, _) => TokenCheck::Invalid,
            (Some(rec), Some(o)) => {
                if normalize_origin(o).as_deref() == Ok(rec.origin.as_str()) {
                    TokenCheck::Ok
                } else {
                    TokenCheck::WrongOrigin
                }
            }
            // Tokens are origin-bound by design; a caller that presents no
            // Origin at all can't prove the binding.
            (Some(_), None) => TokenCheck::WrongOrigin,
        }
    }

    /// Distinct trusted origins with live tokens (`GET /api/origins`).
    pub fn origins(&self) -> Vec<TrustedOrigin> {
        let inner = self.lock();
        let mut by_origin: HashMap<&str, (DateTime<Utc>, usize)> = HashMap::new();
        for t in inner.tokens.iter().filter(|t| !token_expired(t)) {
            let e = by_origin
                .entry(t.origin.as_str())
                .or_insert((t.created_at, 0));
            e.0 = e.0.min(t.created_at);
            e.1 += 1;
        }
        let mut out: Vec<TrustedOrigin> = by_origin
            .into_iter()
            .map(|(origin, (created_at, tokens))| TrustedOrigin {
                origin: origin.to_string(),
                created_at,
                tokens,
            })
            .collect();
        out.sort_by(|a, b| a.origin.cmp(&b.origin));
        out
    }

    /// Revoke an origin's trust: delete all its tokens (and deny anything it
    /// still has pending). `DELETE /api/origins/{origin}`.
    pub fn revoke_origin(&self, origin: &str) -> usize {
        let normalized = match normalize_origin(origin) {
            Ok(o) => o,
            Err(_) => origin.to_string(),
        };
        let removed = {
            let mut inner = self.lock();
            let before = inner.tokens.len();
            inner.tokens.retain(|t| t.origin != normalized);
            for r in inner.requests.values_mut() {
                if r.origin == normalized && r.status == RequestStatus::Pending {
                    r.status = RequestStatus::Denied;
                }
            }
            before - inner.tokens.len()
        };
        self.persist();
        removed
    }

    fn purge_expired(&self) {
        let mut inner = self.lock();
        purge_expired_inner(&mut inner);
    }

    fn persist(&self) {
        let body = {
            let inner = self.lock();
            let live: Vec<TokenRecord> = inner
                .tokens
                .iter()
                .filter(|t| !token_expired(t))
                .cloned()
                .collect();
            match serde_json::to_string_pretty(&PersistedTokens { tokens: live }) {
                Ok(b) => b,
                Err(_) => return,
            }
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &self.path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    #[cfg(test)]
    fn backdate_token(&self, token: &str, days: i64) {
        let hash = sha256_hex(token);
        let mut inner = self.lock();
        for t in &mut inner.tokens {
            if t.sha256 == hash {
                t.created_at = Utc::now() - ChronoDuration::days(days);
            }
        }
    }
}

fn token_expired(t: &TokenRecord) -> bool {
    Utc::now() - t.created_at > ChronoDuration::days(TOKEN_TTL_DAYS)
}

fn purge_expired_inner(inner: &mut PairingInner) {
    inner.tokens.retain(|t| !token_expired(t));
    let cutoff = Utc::now() - ChronoDuration::minutes(REQUEST_TTL_MINUTES);
    inner.requests.retain(|_, r| r.created_at > cutoff);
}

/// Canonicalize an Origin string: `scheme://host[:port]`, lowercased scheme +
/// host, no trailing slash. Rejects anything that isn't a plain http(s)
/// origin (`null`, extension schemes, etc. can't pair).
pub fn normalize_origin(origin: &str) -> Result<String, String> {
    let origin = origin.trim().trim_end_matches('/');
    if origin.is_empty() || origin.len() > 256 {
        return Err("origin must be 1-256 chars".into());
    }
    let (scheme, rest) = origin
        .split_once("://")
        .ok_or_else(|| format!("origin {origin:?} is not scheme://host[:port]"))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("origin scheme {scheme:?} is not http(s)"));
    }
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ', '\\']) {
        return Err(format!("origin {origin:?} must be scheme://host[:port] only"));
    }
    Ok(format!("{scheme}://{}", rest.to_ascii_lowercase()))
}

/// 32 bytes of OS randomness, base64url (no padding) — the bearer token.
fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("os randomness unavailable: {e}"))?;
    Ok(base64url(&bytes))
}

fn sha256_hex(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Minimal base64url (RFC 4648 §5, no padding) encoder — 20 lines beats a
/// crate for one call site.
fn base64url(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(dev: Option<&str>) -> (PairingHandle, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "fl-pairing-{}-{}.json",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        (
            PairingStore::new(path.clone(), dev.map(str::to_string)),
            path,
        )
    }

    fn approve_and_take_token(store: &PairingStore, origin: &str) -> String {
        let id = store.begin(origin, false).expect("begin").request_id.expect("id");
        store.approve(&id).expect("approve");
        match store.poll(&id, Some(origin)).expect("poll").status {
            RequestStatus::Approved { token } => token,
            other => panic!("expected approved, got {other:?}"),
        }
    }

    #[test]
    fn base64url_known_vectors() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8"); // url-safe alphabet
    }

    #[test]
    fn pairing_flow_binds_token_to_origin() {
        let (store, path) = temp_store(None);
        let origin = "https://formlogic.com";
        let outcome = store.begin(origin, false).unwrap();
        assert!(!outcome.auto_approved, "a brand-new origin is not auto-approved");
        let id = outcome.request_id.unwrap();
        // Pending until approved.
        assert!(matches!(
            store.poll(&id, Some(origin)).unwrap().status,
            RequestStatus::Pending
        ));
        assert_eq!(store.pending().len(), 1);
        store.approve(&id).unwrap();
        let token = match store.poll(&id, Some(origin)).unwrap().status {
            RequestStatus::Approved { token } => token,
            other => panic!("{other:?}"),
        };
        assert!(token.len() >= 43, "32 random bytes base64url");
        // Valid for its origin; denied for any other; useless with no origin.
        assert_eq!(store.check(&token, Some(origin)), TokenCheck::Ok);
        assert_eq!(
            store.check(&token, Some("https://evil.example")),
            TokenCheck::WrongOrigin
        );
        assert_eq!(store.check(&token, None), TokenCheck::WrongOrigin);
        assert_eq!(store.check("bogus", Some(origin)), TokenCheck::Invalid);
        // Only the hash is on disk.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&token));
        assert!(raw.contains(&sha256_hex(&token)));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn poll_from_the_wrong_origin_is_rejected() {
        let (store, path) = temp_store(None);
        let id = store.begin("https://formlogic.com", false).unwrap().request_id.unwrap();
        store.approve(&id).unwrap();
        assert!(store.poll(&id, Some("https://evil.example")).is_err());
        // No hint (native caller) is fine — the request id is the capability.
        assert!(store.poll(&id, None).is_ok());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tokens_expire_and_survive_restart_until_then() {
        let (store, path) = temp_store(None);
        let origin = "http://localhost:5173";
        let token = approve_and_take_token(&store, origin);
        // Reload from disk — the hash persists.
        let store2 = PairingStore::new(path.clone(), None);
        assert_eq!(store2.check(&token, Some(origin)), TokenCheck::Ok);
        // Expire it.
        store2.backdate_token(&token, TOKEN_TTL_DAYS + 1);
        assert_eq!(store2.check(&token, Some(origin)), TokenCheck::Invalid);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn revoke_origin_deletes_its_tokens_only() {
        let (store, path) = temp_store(None);
        let t1 = approve_and_take_token(&store, "https://a.example");
        let t2 = approve_and_take_token(&store, "https://b.example");
        assert_eq!(store.origins().len(), 2);
        let removed = store.revoke_origin("https://a.example");
        assert_eq!(removed, 1);
        assert_eq!(store.check(&t1, Some("https://a.example")), TokenCheck::Invalid);
        assert_eq!(store.check(&t2, Some("https://b.example")), TokenCheck::Ok);
        assert_eq!(store.origins().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dev_bypass_auto_approves_only_the_exact_origin() {
        let (store, path) = temp_store(Some("http://localhost:5173"));
        // Exact match: born approved.
        let out = store.begin("http://localhost:5173", false).unwrap();
        assert!(out.auto_approved);
        assert!(matches!(
            store.poll(&out.request_id.unwrap(), None).unwrap().status,
            RequestStatus::Approved { .. }
        ));
        // Different port: normal pending flow.
        let id2 = store.begin("http://localhost:1420", false).unwrap().request_id.unwrap();
        assert!(matches!(
            store.poll(&id2, None).unwrap().status,
            RequestStatus::Pending
        ));
        let _ = std::fs::remove_file(&path);
    }

    /// The re-pair path (2026-07-13): once an origin holds a live token, a
    /// fresh `begin` for it is AUTO-approved — a browser that lost its session
    /// token reconnects with no native prompt. A SILENT probe on an UNTRUSTED
    /// origin creates nothing (no Desktop-window nag); the same probe on a
    /// trusted origin is auto-approved.
    #[test]
    fn trusted_origin_re_pairs_without_a_prompt() {
        let (store, path) = temp_store(None);
        let origin = "http://formlogic.local";

        // Silent probe before any trust: nothing created, not approved.
        let probe = store.begin(origin, true).unwrap();
        assert_eq!(probe, BeginOutcome { request_id: None, auto_approved: false });
        assert_eq!(store.pending().len(), 0, "a silent untrusted probe leaves no pending request");

        // Establish trust the normal way (native approval).
        let token = approve_and_take_token(&store, origin);
        assert_eq!(store.check(&token, Some(origin)), TokenCheck::Ok);

        // Now a SILENT re-pair is auto-approved with a fresh token — no prompt.
        let re = store.begin(origin, true).unwrap();
        assert!(re.auto_approved, "an already-trusted origin re-pairs silently");
        let fresh = match store.poll(&re.request_id.unwrap(), Some(origin)).unwrap().status {
            RequestStatus::Approved { token } => token,
            other => panic!("expected approved, got {other:?}"),
        };
        assert_ne!(fresh, token, "a distinct token is minted");
        assert_eq!(store.check(&fresh, Some(origin)), TokenCheck::Ok);
        assert_eq!(store.pending().len(), 0, "auto-approved re-pairs never sit pending");

        // A DIFFERENT untrusted origin still needs explicit approval, silent or not.
        assert!(!store.begin("http://evil.local", true).unwrap().auto_approved);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn origin_normalization() {
        assert_eq!(
            normalize_origin("HTTPS://FormLogic.com/").unwrap(),
            "https://formlogic.com"
        );
        assert_eq!(
            normalize_origin("http://localhost:5173").unwrap(),
            "http://localhost:5173"
        );
        assert!(normalize_origin("null").is_err());
        assert!(normalize_origin("file:///etc").is_err());
        assert!(normalize_origin("https://a.example/path").is_err());
        assert!(normalize_origin("https://user@a.example").is_err());
        assert!(normalize_origin("").is_err());
    }

    #[test]
    fn pending_request_cap_and_dedupe() {
        let (store, path) = temp_store(None);
        for i in 0..MAX_PENDING_REQUESTS {
            store.begin(&format!("https://site{i}.example"), false).unwrap();
        }
        assert!(store.begin("https://one-more.example", false).is_err());
        // Re-requesting an EXISTING origin replaces its pending entry
        // (dedupe), so it stays under the cap.
        assert!(store.begin("https://site0.example", false).is_ok());
        assert_eq!(store.pending().len(), MAX_PENDING_REQUESTS);
        let _ = std::fs::remove_file(&path);
    }
}
