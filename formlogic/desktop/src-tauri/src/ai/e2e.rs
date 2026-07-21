//! E2E envelope crypto for the Site-AI desktop tunnel
//! (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.1).
//!
//! One NaCl-compatible `crypto_box` construction — X25519 ECDH → HSalsa20 key
//! derivation → XSalsa20-Poly1305 authenticated encryption (`SalsaBox`, the
//! exact primitive tweetnacl's `box` uses, so the browser and this host
//! interoperate byte-for-byte). Interop is locked by the shared vectors in
//! `docs/contracts/e2e-envelope-vectors.json`, which a Rust test here and the
//! web vitest both seal/open.
//!
//! Keys: the desktop holds ONE long-term X25519 identity. The secret lives in
//! the OS credential store via [`crate::secrets`] (Windows Credential Manager
//! on the shipped platform) with a 0600 key-file fallback elsewhere, mirroring
//! `journal_crypto`. The browser side is a per-thread ephemeral keypair whose
//! public half arrives as routing plaintext (`eph_pub`) on each request row.
//!
//! Nonce scheme (plan §5.1): 24 bytes; byte 0 = direction
//! (`0x00` browser→desktop, `0x01` desktop→browser), bytes 1..=23 = a 23-byte
//! big-endian counter (a u64 in practice: bytes 1..16 are zero, bytes 16..24
//! are `counter.to_be_bytes()`). The request envelope uses counter 0; every
//! subsequent frame in the same direction increments it. A counter ≤ the
//! last-seen value for that direction is a replay and is rejected.
//!
//! THREAD SCOPE: sessions here are keyed by the relayed REQUEST id — one
//! request's frame thread, lifetime ≤ its server-side TTL. Counters restart
//! per request (each request envelope is counter 0), which keeps the replay
//! rule self-consistent when a chat thread spans multiple requests. The cache
//! is bounded and entries are evicted at completion.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use crypto_box::aead::{Aead, OsRng};
use crypto_box::{PublicKey, SalsaBox, SecretKey};

/// Credential-store name of the desktop's long-term E2E identity secret
/// (base64 of the 32-byte X25519 secret).
pub const IDENTITY_SECRET_NAME: &str = "desktop-e2e-identity";
/// Fallback key file when no OS credential store is available (mirrors
/// `journal_crypto`'s `journal.key`).
const IDENTITY_KEY_FILE: &str = "desktop-e2e-identity.key";

/// browser → desktop (request envelopes + inbound input frames).
pub const DIR_BROWSER_TO_DESKTOP: u8 = 0x00;
/// desktop → browser (stream frames + the final completion body).
pub const DIR_DESKTOP_TO_BROWSER: u8 = 0x01;

/// Plan §5.2: a sealed AI envelope is at most 256 KiB of plaintext.
pub const MAX_ENVELOPE_PLAINTEXT_BYTES: usize = 256 * 1024;
/// Plan §5.2: the flow lane's terminal RESULT envelope may be up to 1 MiB of
/// plaintext (progress frames stay under the 256 KiB envelope cap).
pub const MAX_FLOW_RESULT_PLAINTEXT_BYTES: usize = 1024 * 1024;
/// XSalsa20-Poly1305 adds a 16-byte tag.
const MAX_ENVELOPE_CIPHERTEXT_BYTES: usize = MAX_ENVELOPE_PLAINTEXT_BYTES + 16;
/// Bound on the in-memory session cache (threads expire server-side in minutes).
const MAX_THREAD_SESSIONS: usize = 64;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// Typed envelope failure. The plan's §5.8 taxonomy collapses every crypto /
/// wire-format rejection into `sealed_envelope_invalid` (no replay/tamper
/// oracle); the precise reason stays in the local message for logs.
#[derive(Debug, Clone)]
pub struct E2eError {
    code: &'static str,
    message: String,
}

impl E2eError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "sealed_envelope_invalid",
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for E2eError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for E2eError {}

/// The desktop's long-term X25519 identity.
pub struct E2eIdentity {
    secret: SecretKey,
    public: PublicKey,
}

impl E2eIdentity {
    /// Test seam + loader: build an identity from raw secret bytes.
    pub fn from_secret_bytes(bytes: [u8; 32]) -> Self {
        let secret = SecretKey::from(bytes);
        let public = secret.public_key();
        Self { secret, public }
    }

    /// Generate a fresh identity from OS randomness.
    pub fn generate() -> Self {
        let secret = SecretKey::generate(&mut OsRng);
        let public = secret.public_key();
        Self { secret, public }
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    pub fn public_key_b64(&self) -> String {
        B64.encode(self.public.to_bytes())
    }

    pub fn secret_key_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }

    pub fn secret_key_b64(&self) -> String {
        B64.encode(self.secret.to_bytes())
    }

    /// Load the identity from the OS credential store (or mint + persist it on
    /// first boot). Non-Windows falls back to a 0600 key file in
    /// `fallback_dir`, mirroring `journal_crypto` — only as strong as
    /// filesystem permissions there, so the keyring path stays the audited one.
    pub fn load_or_create(fallback_dir: &Path) -> Result<Self, String> {
        Self::load_or_create_named(IDENTITY_SECRET_NAME, fallback_dir)
    }

    /// `load_or_create` under an explicit credential-store name — the test
    /// seam that keeps suites away from the production key (and away from the
    /// live box's Credential Manager).
    fn load_or_create_named(name: &str, fallback_dir: &Path) -> Result<Self, String> {
        // 1. OS credential store (Windows Credential Manager on the shipped platform).
        if crate::secrets::available() {
            match crate::secrets::get(name) {
                Ok(Some(b64)) => {
                    if let Some(identity) = Self::decode_secret(b64.trim()) {
                        return Ok(identity);
                    }
                    log::warn!("e2e identity in the credential store is malformed — rotating it");
                }
                Ok(None) => {}
                Err(e) => log::warn!("e2e identity read failed ({e}); trying the key file"),
            }
            let identity = Self::generate();
            match crate::secrets::store_verified(name, &identity.secret_key_b64()) {
                Ok(true) => return Ok(identity),
                Ok(false) => {}
                Err(e) => log::warn!("e2e identity store failed ({e}); trying the key file"),
            }
        }
        Self::load_or_create_file_only(fallback_dir)
    }

    /// The key-file fallback on its own (non-Windows dev/CI; test seam).
    fn load_or_create_file_only(fallback_dir: &Path) -> Result<Self, String> {
        let path: PathBuf = fallback_dir.join(IDENTITY_KEY_FILE);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Some(identity) = Self::decode_secret(text.trim()) {
                return Ok(identity);
            }
            log::warn!("e2e identity key file is malformed — rotating it");
        }
        let identity = Self::generate();
        let mut tmp = path.clone();
        tmp.set_extension("tmp");
        std::fs::create_dir_all(fallback_dir)
            .and_then(|()| std::fs::write(&tmp, identity.secret_key_b64().as_bytes()))
            .and_then(|()| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
                }
                std::fs::rename(&tmp, &path)
            })
            .map_err(|e| format!("could not persist the e2e identity key file: {e}"))?;
        Ok(identity)
    }

    fn decode_secret(b64: &str) -> Option<Self> {
        let bytes = B64.decode(b64).ok()?;
        let bytes: [u8; 32] = bytes.as_slice().try_into().ok()?;
        Some(Self::from_secret_bytes(bytes))
    }
}

/// Build the 24-byte nonce for one frame: byte 0 = direction, bytes 1..=23 =
/// 23-byte big-endian counter (u64 → bytes 16..24, the rest zero).
pub fn frame_nonce(direction: u8, counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[0] = direction;
    nonce[16..24].copy_from_slice(&counter.to_be_bytes());
    nonce
}

/// Parse + validate a frame nonce for an expected direction. Returns the
/// counter. Rejects the wrong direction, counters that do not fit in a u64,
/// and (upstream) any counter ≤ the last seen for that direction.
fn parse_nonce(direction: u8, nonce: &[u8; 24]) -> Result<u64, E2eError> {
    if nonce[0] != direction {
        return Err(E2eError::invalid(format!(
            "wrong direction byte {:#04x} (expected {:#04x})",
            nonce[0], direction
        )));
    }
    if nonce[1..16].iter().any(|b| *b != 0) {
        return Err(E2eError::invalid("nonce counter does not fit in u64"));
    }
    let mut be = [0u8; 8];
    be.copy_from_slice(&nonce[16..24]);
    Ok(u64::from_be_bytes(be))
}

/// Decode a fixed-size base64 field (public keys are 32 B, nonces 24 B).
fn decode_b64_fixed<const N: usize>(value: &str, what: &str) -> Result<[u8; N], E2eError> {
    let bytes = B64
        .decode(value.trim())
        .map_err(|_| E2eError::invalid(format!("{what} is not valid base64")))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| E2eError::invalid(format!("{what} must be {N} bytes")))
}

/// One peer session: the precomputed shared box plus the replay state for one
/// relayed request. The browser's ephemeral public key is pinned at open time
/// so a later frame naming the same request but a different key is rejected.
struct ThreadSession {
    peer_eph_pub: [u8; 32],
    shared: SalsaBox,
    /// Highest browser→desktop counter accepted so far (`None` = none yet).
    last_inbound: Option<u64>,
    /// Next desktop→browser counter to seal with.
    next_outbound: u64,
}

/// Per-request session cache (peer ephemeral pubkey → shared key + counters).
/// Bounded FIFO; entries are also dropped when a request completes.
pub struct E2eSessions {
    inner: Mutex<(HashMap<String, ThreadSession>, VecDeque<String>)>,
}

impl Default for E2eSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl E2eSessions {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new((HashMap::new(), VecDeque::new())),
        }
    }

    pub fn thread_count(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).0.len()
    }

    /// Drop a request's session at completion/expiry (best-effort).
    pub fn drop_thread(&self, thread: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.0.remove(thread).is_some() {
            if let Some(pos) = g.1.iter().position(|k| k == thread) {
                g.1.remove(pos);
            }
        }
    }

    /// Insert a new session, evicting the oldest beyond the bound.
    fn insert(&self, thread: &str, session: ThreadSession) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.0.insert(thread.to_string(), session).is_none() {
            g.1.push_back(thread.to_string());
        }
        while g.1.len() > MAX_THREAD_SESSIONS {
            if let Some(old) = g.1.pop_front() {
                g.0.remove(&old);
            }
        }
    }

    /// Open a sealed inbound frame (request envelope or later input) for
    /// `thread`. Creates the session on first contact, enforces the pinned
    /// peer key, the direction byte and the strictly-increasing counter, then
    /// decrypts. Any failure maps to `sealed_envelope_invalid`.
    ///
    /// `envelope_b64` is the wire form: `base64(nonce(24) || ciphertext)`.
    pub fn open_inbound(
        &self,
        identity: &E2eIdentity,
        thread: &str,
        eph_pub_b64: &str,
        envelope_b64: &str,
    ) -> Result<Vec<u8>, E2eError> {
        let eph_pub_bytes = decode_b64_fixed::<32>(eph_pub_b64, "eph_pub")?;
        if eph_pub_bytes.iter().all(|b| *b == 0) {
            // An all-zero X25519 public key forces a trivially known shared
            // secret (small-order point) — refuse it rather than "decrypt"
            // under a key anyone can derive.
            return Err(E2eError::invalid("eph_pub is a small-order point"));
        }
        let (nonce, ct) = unpack_envelope(envelope_b64)?;
        let counter = parse_nonce(DIR_BROWSER_TO_DESKTOP, &nonce)?;

        // Fast path: existing session (replay check + pinned peer + decrypt),
        // all under one lock acquisition.
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = g.0.get_mut(thread) {
                if session.peer_eph_pub != eph_pub_bytes {
                    return Err(E2eError::invalid(
                        "eph_pub changed mid-request (pinned at first contact)",
                    ));
                }
                if session.last_inbound.is_some_and(|last| counter <= last) {
                    return Err(E2eError::invalid(format!(
                        "replayed or out-of-order counter {counter}"
                    )));
                }
                let plaintext = session
                    .shared
                    .decrypt((&nonce).into(), ct.as_slice())
                    .map_err(|_| E2eError::invalid("authentication failed"))?;
                session.last_inbound = Some(counter);
                return Ok(plaintext);
            }
        }

        // First contact for this thread: must be the counter-0 request
        // envelope (a later counter with no session is unverifiable).
        if counter != 0 {
            return Err(E2eError::invalid(
                "first frame for a request must use counter 0",
            ));
        }
        let peer = PublicKey::from(eph_pub_bytes);
        let shared = SalsaBox::new(&peer, &identity.secret);
        let plaintext = shared
            .decrypt((&nonce).into(), ct.as_slice())
            .map_err(|_| E2eError::invalid("authentication failed"))?;
        self.insert(
            thread,
            ThreadSession {
                peer_eph_pub: eph_pub_bytes,
                shared,
                last_inbound: Some(0),
                next_outbound: 0,
            },
        );
        Ok(plaintext)
    }

    /// Seal one outbound frame for `thread` (stream delta / final body).
    /// Returns the wire envelope `base64(nonce(24) || ciphertext)`; the
    /// counter is handed out strictly-increasing per direction.
    pub fn seal_outbound(&self, thread: &str, plaintext: &[u8]) -> Result<String, E2eError> {
        self.seal_outbound_with_cap(thread, plaintext, MAX_ENVELOPE_PLAINTEXT_BYTES)
    }

    /// [`seal_outbound`] with an explicit plaintext cap — the flow relay lane's
    /// terminal result envelope is allowed up to
    /// [`MAX_FLOW_RESULT_PLAINTEXT_BYTES`] (plan §5.2) instead of the 256 KiB
    /// frame cap.
    pub fn seal_outbound_with_cap(
        &self,
        thread: &str,
        plaintext: &[u8],
        max_plaintext_bytes: usize,
    ) -> Result<String, E2eError> {
        if plaintext.len() > max_plaintext_bytes {
            return Err(E2eError::invalid("frame exceeds its plaintext cap"));
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session =
            g.0.get_mut(thread)
                .ok_or_else(|| E2eError::invalid("no open session for this request"))?;
        let nonce = frame_nonce(DIR_DESKTOP_TO_BROWSER, session.next_outbound);
        let ct = session
            .shared
            .encrypt((&nonce).into(), plaintext)
            .map_err(|_| E2eError::invalid("encryption failed"))?;
        session.next_outbound += 1;
        Ok(pack_envelope(&nonce, &ct))
    }
}

/// Pack one wire envelope: `base64(nonce(24) || ciphertext)` — the single
/// string the relay tables/routes carry (plan §5.1 frame blob).
pub fn pack_envelope(nonce: &[u8; 24], ct: &[u8]) -> String {
    let mut bytes = Vec::with_capacity(24 + ct.len());
    bytes.extend_from_slice(nonce);
    bytes.extend_from_slice(ct);
    B64.encode(bytes)
}

/// Unpack the wire envelope into `(nonce, ciphertext)`.
pub fn unpack_envelope(envelope_b64: &str) -> Result<([u8; 24], Vec<u8>), E2eError> {
    let bytes = B64
        .decode(envelope_b64.trim())
        .map_err(|_| E2eError::invalid("envelope is not valid base64"))?;
    if bytes.len() < 24 + 16 {
        return Err(E2eError::invalid("envelope is shorter than nonce + tag"));
    }
    if bytes.len() > 24 + MAX_ENVELOPE_CIPHERTEXT_BYTES {
        return Err(E2eError::invalid("envelope exceeds the 256 KiB cap"));
    }
    let nonce: [u8; 24] = bytes[..24]
        .try_into()
        .map_err(|_| E2eError::invalid("envelope nonce is malformed"))?;
    Ok((nonce, bytes[24..].to_vec()))
}

/// Seal one detached frame with an explicit identity/peer pair — the shape
/// the shared interop vectors use (no session cache involved).
pub fn seal_detached(
    own_secret: &[u8; 32],
    peer_public: &[u8; 32],
    direction: u8,
    counter: u64,
    plaintext: &[u8],
) -> Result<(String, String), E2eError> {
    let secret = SecretKey::from(*own_secret);
    let peer = PublicKey::from(*peer_public);
    let shared = SalsaBox::new(&peer, &secret);
    let nonce = frame_nonce(direction, counter);
    let ct = shared
        .encrypt((&nonce).into(), plaintext)
        .map_err(|_| E2eError::invalid("encryption failed"))?;
    Ok((B64.encode(nonce), B64.encode(ct)))
}

/// [`seal_detached`] returning the packed wire envelope directly.
pub fn seal_detached_envelope(
    own_secret: &[u8; 32],
    peer_public: &[u8; 32],
    direction: u8,
    counter: u64,
    plaintext: &[u8],
) -> Result<String, E2eError> {
    let (nonce_b64, ct_b64) =
        seal_detached(own_secret, peer_public, direction, counter, plaintext)?;
    let nonce = decode_b64_fixed::<24>(&nonce_b64, "nonce")?;
    let ct = B64
        .decode(ct_b64)
        .map_err(|_| E2eError::invalid("ciphertext is not valid base64"))?;
    Ok(pack_envelope(&nonce, &ct))
}

/// Open one packed wire envelope with an explicit identity/peer pair.
pub fn open_detached_envelope(
    own_secret: &[u8; 32],
    peer_public: &[u8; 32],
    direction: u8,
    envelope_b64: &str,
) -> Result<Vec<u8>, E2eError> {
    let (nonce, ct) = unpack_envelope(envelope_b64)?;
    parse_nonce(direction, &nonce)?;
    let secret = SecretKey::from(*own_secret);
    let peer = PublicKey::from(*peer_public);
    let shared = SalsaBox::new(&peer, &secret);
    shared
        .decrypt((&nonce).into(), ct.as_slice())
        .map_err(|_| E2eError::invalid("authentication failed"))
}

/// Open one detached frame with an explicit identity/peer pair (vectors +
/// wrong-key tests). Direction is validated; no replay state is tracked here
/// (that lives in [`E2eSessions`]).
pub fn open_detached(
    own_secret: &[u8; 32],
    peer_public: &[u8; 32],
    direction: u8,
    nonce_b64: &str,
    ct_b64: &str,
) -> Result<Vec<u8>, E2eError> {
    let nonce = decode_b64_fixed::<24>(nonce_b64, "nonce")?;
    parse_nonce(direction, &nonce)?;
    let ct = B64
        .decode(ct_b64.trim())
        .map_err(|_| E2eError::invalid("ciphertext is not valid base64"))?;
    if ct.len() < 16 || ct.len() > MAX_ENVELOPE_CIPHERTEXT_BYTES {
        return Err(E2eError::invalid("ciphertext length is out of bounds"));
    }
    let secret = SecretKey::from(*own_secret);
    let peer = PublicKey::from(*peer_public);
    let shared = SalsaBox::new(&peer, &secret);
    shared
        .decrypt((&nonce).into(), ct.as_slice())
        .map_err(|_| E2eError::invalid("authentication failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_identity(seed: u8) -> E2eIdentity {
        E2eIdentity::from_secret_bytes([seed; 32])
    }

    fn browser_keypair(seed: u8) -> ([u8; 32], [u8; 32]) {
        let secret = [seed; 32];
        let public = SecretKey::from(secret).public_key().to_bytes();
        (secret, public)
    }

    /// Test glue: pack (nonce_b64, ct_b64) into the wire envelope string.
    fn pack_pair(nonce_b64: &str, ct_b64: &str) -> String {
        let nonce = decode_b64_fixed::<24>(nonce_b64, "nonce").unwrap();
        let ct = B64.decode(ct_b64).unwrap();
        pack_envelope(&nonce, &ct)
    }

    fn unpack_pair(envelope: &str) -> (String, String) {
        let (nonce, ct) = unpack_envelope(envelope).unwrap();
        (B64.encode(nonce), B64.encode(ct))
    }

    #[test]
    fn nonce_layout_is_direction_plus_big_endian_counter() {
        let nonce = frame_nonce(DIR_BROWSER_TO_DESKTOP, 0x0102_0304_0506_0708);
        assert_eq!(nonce[0], DIR_BROWSER_TO_DESKTOP);
        assert_eq!(&nonce[1..16], &[0u8; 15]);
        assert_eq!(
            &nonce[16..24],
            &[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]
        );
        assert_eq!(
            parse_nonce(DIR_BROWSER_TO_DESKTOP, &nonce).unwrap(),
            0x0102_0304_0506_0708
        );
        // Wrong direction is rejected; oversized counters are rejected.
        assert!(parse_nonce(DIR_DESKTOP_TO_BROWSER, &nonce).is_err());
        let mut huge = nonce;
        huge[1] = 1;
        assert!(parse_nonce(DIR_BROWSER_TO_DESKTOP, &huge).is_err());
    }

    #[test]
    fn envelope_round_trip_both_directions() {
        let desktop = test_identity(0xD1);
        let (browser_secret, browser_public) = browser_keypair(0xB1);
        let sessions = E2eSessions::new();
        let eph_pub_b64 = B64.encode(browser_public);

        // Browser → desktop request envelope (counter 0).
        let (nonce, ct) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            0,
            br#"{"v":1,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        let opened = sessions
            .open_inbound(&desktop, "req-1", &eph_pub_b64, &pack_pair(&nonce, &ct))
            .unwrap();
        assert_eq!(
            String::from_utf8(opened).unwrap(),
            r#"{"v":1,"messages":[{"role":"user","content":"hi"}]}"#
        );

        // Desktop → browser frames (counters 0, 1).
        let fenv0 = sessions
            .seal_outbound("req-1", br#"{"v":1,"kind":"delta"}"#)
            .unwrap();
        let fenv1 = sessions
            .seal_outbound("req-1", br#"{"v":1,"kind":"final"}"#)
            .unwrap();
        let (fnonce0, fct0) = unpack_pair(&fenv0);
        let (fnonce1, fct1) = unpack_pair(&fenv1);
        assert_eq!(
            open_detached(
                &browser_secret,
                &desktop.public_key_bytes(),
                DIR_DESKTOP_TO_BROWSER,
                &fnonce0,
                &fct0
            )
            .unwrap(),
            br#"{"v":1,"kind":"delta"}"#
        );
        assert_eq!(
            open_detached(
                &browser_secret,
                &desktop.public_key_bytes(),
                DIR_DESKTOP_TO_BROWSER,
                &fnonce1,
                &fct1
            )
            .unwrap(),
            br#"{"v":1,"kind":"final"}"#
        );
        // Outbound counters increase: nonces differ and decode to 0 then 1.
        let n0 = decode_b64_fixed::<24>(&fnonce0, "nonce").unwrap();
        let n1 = decode_b64_fixed::<24>(&fnonce1, "nonce").unwrap();
        assert_eq!(parse_nonce(DIR_DESKTOP_TO_BROWSER, &n0).unwrap(), 0);
        assert_eq!(parse_nonce(DIR_DESKTOP_TO_BROWSER, &n1).unwrap(), 1);
    }

    #[test]
    fn wrong_key_cannot_open() {
        let desktop = test_identity(0xD2);
        let (browser_secret, browser_public) = browser_keypair(0xB2);
        let sessions = E2eSessions::new();
        let (nonce, ct) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            0,
            b"secret",
        )
        .unwrap();
        // A different desktop identity fails authentication.
        let wrong = test_identity(0x99);
        let err = sessions
            .open_inbound(
                &wrong,
                "req-2",
                &B64.encode(browser_public),
                &pack_pair(&nonce, &ct),
            )
            .unwrap_err();
        assert_eq!(err.code(), "sealed_envelope_invalid");
    }

    #[test]
    fn replay_and_out_of_order_counters_are_rejected() {
        let desktop = test_identity(0xD3);
        let (browser_secret, browser_public) = browser_keypair(0xB3);
        let eph_pub_b64 = B64.encode(browser_public);
        let sessions = E2eSessions::new();

        let (n0, c0) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            0,
            b"turn 1",
        )
        .unwrap();
        sessions
            .open_inbound(&desktop, "req-3", &eph_pub_b64, &pack_pair(&n0, &c0))
            .unwrap();
        // Replaying the same frame (counter 0 ≤ last-seen 0) is rejected.
        assert!(sessions
            .open_inbound(&desktop, "req-3", &eph_pub_b64, &pack_pair(&n0, &c0))
            .is_err());
        // Counter 1 is accepted; counter 1 again (or a lower one) is not.
        let (n1, c1) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            1,
            b"input",
        )
        .unwrap();
        sessions
            .open_inbound(&desktop, "req-3", &eph_pub_b64, &pack_pair(&n1, &c1))
            .unwrap();
        assert!(sessions
            .open_inbound(&desktop, "req-3", &eph_pub_b64, &pack_pair(&n1, &c1))
            .is_err());
        // A first-contact frame with a nonzero counter is rejected.
        let (n5, c5) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            5,
            b"late",
        )
        .unwrap();
        assert!(sessions
            .open_inbound(&desktop, "req-never", &eph_pub_b64, &pack_pair(&n5, &c5))
            .is_err());
        // A mid-request key change is rejected.
        let (_, other_public) = browser_keypair(0x44);
        let (n2, c2) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            2,
            b"third",
        )
        .unwrap();
        assert!(sessions
            .open_inbound(
                &desktop,
                "req-3",
                &B64.encode(other_public),
                &pack_pair(&n2, &c2)
            )
            .is_err());
        // An all-zero peer key is refused before any decryption.
        let (nz, cz) = seal_detached(
            &browser_secret,
            &desktop.public_key_bytes(),
            DIR_BROWSER_TO_DESKTOP,
            0,
            b"x",
        )
        .unwrap();
        assert!(sessions
            .open_inbound(
                &desktop,
                "req-zero",
                &B64.encode([0u8; 32]),
                &pack_pair(&nz, &cz)
            )
            .is_err());
    }

    #[test]
    fn identity_persists_across_loads() {
        // File fallback: stable across loads, independent of any keyring.
        let dir = std::env::temp_dir().join(format!("formlogic-e2e-id-{}", uuid::Uuid::new_v4()));
        let first = E2eIdentity::load_or_create_file_only(&dir).unwrap();
        let second = E2eIdentity::load_or_create_file_only(&dir).unwrap();
        assert_eq!(first.public_key_b64(), second.public_key_b64());
        let _ = std::fs::remove_dir_all(dir);

        // Credential-store path under a UNIQUE name (never the production key)
        // with cleanup, exactly like the secrets.rs keyring test.
        #[cfg(windows)]
        {
            let name = format!("test-e2e-identity-{}", uuid::Uuid::new_v4().simple());
            let dir =
                std::env::temp_dir().join(format!("formlogic-e2e-id-{}", uuid::Uuid::new_v4()));
            let first = E2eIdentity::load_or_create_named(&name, &dir).unwrap();
            let second = E2eIdentity::load_or_create_named(&name, &dir).unwrap();
            assert_eq!(first.public_key_b64(), second.public_key_b64());
            crate::secrets::delete(&name).unwrap();
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// Shared interop vectors (`docs/contracts/e2e-envelope-vectors.json`) —
    /// the web vitest seals/opens the same file. Here: seal with THIS
    /// implementation and require the stored ciphertext byte-for-byte, and
    /// open every stored ciphertext back to its plaintext. Regenerate the
    /// file deliberately with `FORMLOGIC_E2E_VECTORS_WRITE=1`.
    #[test]
    fn shared_interop_vectors() {
        use serde_json::{json, Value};

        let desktop_secret: [u8; 32] = core::array::from_fn(|i| 0x10 + i as u8);
        let browser_secret: [u8; 32] = core::array::from_fn(|i| 0x40 + i as u8);
        let desktop_public = SecretKey::from(desktop_secret).public_key().to_bytes();
        let browser_public = SecretKey::from(browser_secret).public_key().to_bytes();

        let plaintexts: [(&str, u8, u64, &str); 5] = [
            (
                "request-envelope",
                DIR_BROWSER_TO_DESKTOP,
                0,
                r#"{"v":1,"model":"test-model","threadId":"thread-1","messages":[{"role":"user","content":"Say hi."}],"clientSeq":1}"#,
            ),
            (
                "delta-frame-0",
                DIR_DESKTOP_TO_BROWSER,
                0,
                r#"{"v":1,"kind":"delta","delta":{"choices":[{"index":0,"delta":{"content":"Hi"}}]}}"#,
            ),
            (
                "delta-frame-1",
                DIR_DESKTOP_TO_BROWSER,
                1,
                r#"{"v":1,"kind":"delta","delta":{"choices":[{"index":0,"delta":{"content":" there"}}]}}"#,
            ),
            (
                "final-body",
                DIR_DESKTOP_TO_BROWSER,
                2,
                r#"{"v":1,"kind":"final"}"#,
            ),
            (
                "input-frame",
                DIR_BROWSER_TO_DESKTOP,
                1,
                r#"{"v":1,"kind":"input","approved":true}"#,
            ),
        ];

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/contracts/e2e-envelope-vectors.json"
        );

        if std::env::var("FORMLOGIC_E2E_VECTORS_WRITE").is_ok() {
            let mut vectors = Vec::new();
            for (name, direction, counter, plaintext) in plaintexts {
                // Seal from the SENDER's perspective for each direction.
                let (own, peer) = if direction == DIR_BROWSER_TO_DESKTOP {
                    (browser_secret, desktop_public)
                } else {
                    (desktop_secret, browser_public)
                };
                let (nonce, ct) =
                    seal_detached(&own, &peer, direction, counter, plaintext.as_bytes())
                        .expect("seal vector");
                let nonce_bytes = decode_b64_fixed::<24>(&nonce, "nonce").unwrap();
                let ct_bytes = B64.decode(&ct).unwrap();
                vectors.push(json!({
                    "name": name,
                    "direction": direction,
                    "counter": counter,
                    "nonce": nonce,
                    "plaintext": plaintext,
                    "ciphertext": ct,
                    "envelope": pack_envelope(&nonce_bytes, &ct_bytes),
                }));
            }
            let doc = json!({
                "version": 1,
                "algorithm": "NaCl crypto_box — X25519 ECDH → HSalsa20 → XSalsa20-Poly1305 (tweetnacl box-compatible)",
                "ciphertextLayout": "base64( 16-byte Poly1305 tag || ciphertext ) — the NaCl/tweetnacl layout",
                "wireEnvelope": "base64( nonce(24 bytes) || ciphertext ) — the single string the relay rows/routes carry; per-vector nonce+ciphertext fields are its components",
                "nonceScheme": "24 bytes, base64: byte 0 = direction (0x00 browser→desktop, 0x01 desktop→browser); bytes 1..=23 = big-endian counter (bytes 1..16 zero, bytes 16..24 = counter as u64 BE). The request envelope uses counter 0; each subsequent frame in the same direction increments.",
                "sessionScope": "one relayed request id; the peer ephemeral key is pinned at first contact and counters restart per request",
                "desktop": {
                    "secretKey": B64.encode(desktop_secret),
                    "publicKey": B64.encode(desktop_public),
                },
                "browser": {
                    "secretKey": B64.encode(browser_secret),
                    "publicKey": B64.encode(browser_public),
                },
                "vectors": vectors,
            });
            std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap() + "\n")
                .expect("write shared vectors");
            return;
        }

        let text = std::fs::read_to_string(path)
            .expect("docs/contracts/e2e-envelope-vectors.json must exist (run with FORMLOGIC_E2E_VECTORS_WRITE=1 to mint)");
        let doc: Value = serde_json::from_str(&text).expect("vectors doc parses");
        assert_eq!(
            doc["desktop"]["publicKey"].as_str().unwrap(),
            B64.encode(desktop_public),
            "desktop public key drifted"
        );
        assert_eq!(
            doc["browser"]["publicKey"].as_str().unwrap(),
            B64.encode(browser_public),
            "browser public key drifted"
        );
        assert_eq!(
            doc["desktop"]["secretKey"].as_str().unwrap(),
            B64.encode(desktop_secret)
        );
        assert_eq!(
            doc["browser"]["secretKey"].as_str().unwrap(),
            B64.encode(browser_secret)
        );

        for vector in doc["vectors"].as_array().expect("vectors array") {
            let name = vector["name"].as_str().unwrap().to_string();
            let direction = vector["direction"].as_u64().unwrap() as u8;
            let counter = vector["counter"].as_u64().unwrap();
            let nonce = vector["nonce"].as_str().unwrap();
            let plaintext = vector["plaintext"].as_str().unwrap();
            let ciphertext = vector["ciphertext"].as_str().unwrap();

            let (own, peer) = if direction == DIR_BROWSER_TO_DESKTOP {
                (browser_secret, desktop_public)
            } else {
                (desktop_secret, browser_public)
            };
            // Seal with THIS implementation: must reproduce the stored bytes.
            let (sealed_nonce, sealed_ct) =
                seal_detached(&own, &peer, direction, counter, plaintext.as_bytes())
                    .unwrap_or_else(|e| panic!("seal {name}: {e}"));
            assert_eq!(sealed_nonce, nonce, "nonce mismatch on {name}");
            assert_eq!(sealed_ct, ciphertext, "ciphertext mismatch on {name}");
            let nonce_bytes = decode_b64_fixed::<24>(nonce, "nonce").unwrap();
            let ct_bytes = B64.decode(ciphertext).unwrap();
            assert_eq!(
                vector["envelope"].as_str().unwrap(),
                pack_envelope(&nonce_bytes, &ct_bytes),
                "wire envelope mismatch on {name}"
            );
            // Open the stored ciphertext from the RECIPIENT's side.
            let (recipient, sender_pub) = if direction == DIR_BROWSER_TO_DESKTOP {
                (desktop_secret, browser_public)
            } else {
                (browser_secret, desktop_public)
            };
            let opened = open_detached(&recipient, &sender_pub, direction, nonce, ciphertext)
                .unwrap_or_else(|e| panic!("open {name}: {e}"));
            assert_eq!(
                String::from_utf8(opened).unwrap(),
                plaintext,
                "plaintext mismatch on {name}"
            );
        }
    }
}
