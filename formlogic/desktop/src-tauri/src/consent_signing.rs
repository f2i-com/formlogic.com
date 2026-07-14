//! CONSENT-001 — the Desktop-held consent-signing key.
//!
//! Consent grants are ISSUED by this Desktop (the operator accepts the
//! wizard) and VERIFIED by the plugin: the Desktop signs the exact grant
//! JSON bytes with a per-install Ed25519 key, and passes the PUBLIC half to
//! every plugin it spawns (`FORMLOGIC_CONSENT_VERIFY_KEY`). Because the key
//! is per-install, a grant signed on any other machine can never satisfy
//! this device's gate — the key **is** the device binding the audit asks
//! for, with no extra identity plumbing.
//!
//! The 32-byte seed lives in the OS credential store (`consent-signing-key`,
//! hex) with a key-file fallback (`consent-signing.key` in the plugin-data
//! root, 0600 on unix) — the same tiering as the journal data key. If no
//! store is writable the signer is unavailable and consent issuance fails
//! loudly (never an unsigned grant from a signing-capable Desktop).

use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::OnceLock;

const KEY_NAME: &str = "consent-signing-key";
const KEY_FILE: &str = "consent-signing.key";

static KEY: OnceLock<Option<SigningKey>> = OnceLock::new();

fn hex_encode(b: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        let _ = write!(s, "{x:02x}");
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

fn seed_from_hex(hex: &str) -> Option<[u8; 32]> {
    hex_decode(hex).and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
}

fn load_or_create_seed(fallback_dir: &Path) -> Option<[u8; 32]> {
    // 1. OS credential store.
    if crate::secrets::available() {
        match crate::secrets::get(KEY_NAME) {
            Ok(Some(hex)) => {
                if let Some(seed) = seed_from_hex(&hex) {
                    return Some(seed);
                }
                log::warn!("consent-signing key in the credential store is malformed — rotating");
            }
            Ok(None) => {}
            Err(e) => log::warn!("consent-signing key read failed ({e}); trying the key file"),
        }
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).ok()?;
        match crate::secrets::store_verified(KEY_NAME, &hex_encode(&seed)) {
            Ok(true) => return Some(seed),
            Ok(false) | Err(_) => {
                log::warn!("consent-signing key could not be stored in the credential store; falling back to the key file");
            }
        }
    }
    // 2. Key-file fallback beside the plugin data.
    let path = fallback_dir.join(KEY_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Some(seed) = seed_from_hex(&text) {
            return Some(seed);
        }
        log::warn!("consent-signing.key is malformed — rotating");
    }
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).ok()?;
    let _ = std::fs::create_dir_all(fallback_dir);
    if std::fs::write(&path, hex_encode(&seed)).is_err() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(seed)
}

/// Initialise the signer once at startup (before any plugin spawns, so the
/// verify key rides in every child's environment).
pub fn init(fallback_dir: &Path) {
    let _ = KEY.get_or_init(|| load_or_create_seed(fallback_dir).map(|s| SigningKey::from_bytes(&s)));
}

fn key() -> Option<&'static SigningKey> {
    KEY.get().and_then(|k| k.as_ref())
}

/// The public verify key (standard base64) passed to spawned plugins.
pub fn verify_key_b64() -> Option<String> {
    key().map(|k| base64::engine::general_purpose::STANDARD.encode(k.verifying_key().to_bytes()))
}

/// Sign a consent grant: `grant` is the FULL grant object (version, scopes,
/// acceptedAt, acceptedBy, expiresAt); the returned envelope carries the
/// exact signed bytes (base64) + an Ed25519 signature over them — the same
/// raw-byte scheme as package trust, so there is no canonicalisation
/// surface. Errors when the signer is unavailable (no key store writable).
pub fn sign_grant(grant: &Value) -> Result<Value, String> {
    let key = key().ok_or(
        "consent signing key unavailable — no credential store or key file is writable on this install",
    )?;
    let payload = serde_json::to_vec(grant).map_err(|e| format!("serialize grant: {e}"))?;
    let sig = key.sign(&payload);
    Ok(json!({
        "format": 1,
        "alg": "Ed25519",
        "keyId": "desktop-install",
        "payloadB64": base64::engine::general_purpose::STANDARD.encode(&payload),
        "signature": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn init_sign_verify_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "fl-consent-sign-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        init(&dir);
        let pub_b64 = verify_key_b64().expect("signer initialised");

        let grant = json!({
            "version": 1,
            "scopes": { "bluetooth": true, "transcription": true },
            "acceptedAt": "2026-07-12T00:00:00Z",
            "acceptedBy": "op@example.com",
            "expiresAt": "2027-07-12T00:00:00Z",
        });
        let envelope = sign_grant(&grant).unwrap();
        assert_eq!(envelope["alg"], "Ed25519");

        // Verify exactly as the plugin does: signature over the raw payload bytes.
        let payload = base64::engine::general_purpose::STANDARD
            .decode(envelope["payloadB64"].as_str().unwrap())
            .unwrap();
        let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(envelope["signature"].as_str().unwrap())
            .unwrap();
        let pk_bytes = base64::engine::general_purpose::STANDARD.decode(&pub_b64).unwrap();
        let pk = VerifyingKey::from_bytes(&<[u8; 32]>::try_from(pk_bytes.as_slice()).unwrap()).unwrap();
        let sig = Signature::from_bytes(&<[u8; 64]>::try_from(sig_bytes.as_slice()).unwrap());
        pk.verify(&payload, &sig).expect("desktop-signed grant verifies");
        let roundtrip: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(roundtrip, grant);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
