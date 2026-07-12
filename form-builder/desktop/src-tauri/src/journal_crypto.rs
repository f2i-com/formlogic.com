//! DATA-PRIV-001 — at-rest encryption for the desktop's operational journals.
//!
//! The event-receipt journal and the flow work ledger carry full event
//! envelopes — call transcripts, caller numbers, SMS bodies — so a plaintext
//! copy of the data directory must not be able to recover them. Payload blobs
//! are sealed with XChaCha20-Poly1305 under a per-install 32-byte data key:
//!
//! * **Windows (the shipped platform):** the key lives in the Windows
//!   Credential Manager via [`crate::secrets`], never on disk.
//! * **Elsewhere / keyring failure:** the key falls back to a `journal.key`
//!   file beside the journals (0600 on unix). That still defeats casual
//!   plaintext scans and keeps the wire format identical, but is only as
//!   strong as filesystem permissions — the keyring path is the audited one.
//!
//! Sealed blobs are hex(`nonce || ciphertext`) so journals stay line-oriented
//! JSONL. Decryption failures return `None` — callers treat the record's
//! payload as gone (the state/key metadata survives) rather than crashing.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::Value;

/// Credential-store name of the journal data key (hex-encoded 32 bytes).
const KEY_NAME: &str = "journal-data-key";
/// Fallback key file when no OS credential store is available.
const KEY_FILE: &str = "journal.key";

pub struct JournalCrypto {
    cipher: XChaCha20Poly1305,
}

fn hex_encode(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

impl JournalCrypto {
    pub fn from_key(key: [u8; 32]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
        }
    }

    /// Resolve (or mint) the per-install data key: credential store first,
    /// key-file fallback. Returns `None` only when every store fails — the
    /// caller keeps journaling in plaintext (availability over
    /// confidentiality) and must log that loudly.
    pub fn open_default(fallback_dir: &Path) -> Option<Self> {
        Some(Self::from_key(load_or_create_key(fallback_dir)?))
    }

    /// Seal a JSON payload → hex(nonce || ciphertext).
    pub fn encrypt(&self, v: &Value) -> Option<String> {
        let mut nonce = [0u8; 24];
        getrandom::getrandom(&mut nonce).ok()?;
        let ct = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), v.to_string().as_bytes())
            .ok()?;
        let mut out = Vec::with_capacity(24 + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Some(hex_encode(&out))
    }

    /// Open a sealed payload. `None` on tamper/garbage/wrong key.
    pub fn decrypt(&self, sealed: &str) -> Option<Value> {
        let raw = hex_decode(sealed)?;
        if raw.len() <= 24 {
            return None;
        }
        let (nonce, ct) = raw.split_at(24);
        let pt = self.cipher.decrypt(XNonce::from_slice(nonce), ct).ok()?;
        serde_json::from_slice(&pt).ok()
    }
}

fn load_or_create_key(fallback_dir: &Path) -> Option<[u8; 32]> {
    // 1. OS credential store (Windows Credential Manager on the shipped platform).
    if crate::secrets::available() {
        match crate::secrets::get(KEY_NAME) {
            Ok(Some(hexkey)) => {
                if let Some(bytes) = hex_decode(hexkey.trim()) {
                    if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                        return Some(key);
                    }
                }
                log::warn!("journal data key in the credential store is malformed — rotating it");
            }
            Ok(None) => {}
            Err(e) => log::warn!("journal data key read failed ({e}); trying the key file"),
        }
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).ok()?;
        match crate::secrets::store_verified(KEY_NAME, &hex_encode(&key)) {
            Ok(true) => return Some(key),
            Ok(false) => {}
            Err(e) => log::warn!("journal data key store failed ({e}); trying the key file"),
        }
    }

    // 2. Key file beside the journals.
    let path: PathBuf = fallback_dir.join(KEY_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Some(bytes) = hex_decode(text.trim()) {
            if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Some(key);
            }
        }
        log::warn!("journal key file is malformed — regenerating");
    }
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).ok()?;
    let _ = std::fs::create_dir_all(fallback_dir);
    if std::fs::write(&path, hex_encode(&key)).is_err() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(key)
}

/// Process-wide shared instance, keyed on first use (both journal owners —
/// the plugin runner and the flow dispatcher — must seal with the SAME key).
/// `None` (loudly logged) means every key store failed; journals stay
/// plaintext rather than losing durability.
pub fn shared(fallback_dir: &Path) -> Option<Arc<JournalCrypto>> {
    static SHARED: OnceLock<Option<Arc<JournalCrypto>>> = OnceLock::new();
    SHARED
        .get_or_init(|| match JournalCrypto::open_default(fallback_dir) {
            Some(c) => Some(Arc::new(c)),
            None => {
                log::error!(
                    "journal encryption unavailable (no credential store and the key file is unwritable) — operational journals will contain PLAINTEXT payloads"
                );
                None
            }
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn seal_and_open_round_trip() {
        let c = JournalCrypto::from_key([7u8; 32]);
        let v = json!({"name": "aokie.sms.received", "payload": {"from": "+61400000000", "body": "hi"}});
        let sealed = c.encrypt(&v).unwrap();
        assert!(!sealed.contains("61400000000"), "ciphertext leaks nothing");
        assert_eq!(c.decrypt(&sealed).unwrap(), v);
        // Every seal uses a fresh nonce.
        assert_ne!(sealed, c.encrypt(&v).unwrap());
    }

    #[test]
    fn tamper_and_wrong_key_fail_closed() {
        let c = JournalCrypto::from_key([7u8; 32]);
        let sealed = c.encrypt(&json!({"a": 1})).unwrap();
        let mut tampered = sealed.clone();
        tampered.replace_range(sealed.len() - 2.., "00");
        assert!(c.decrypt(&tampered).is_none(), "tampered blob rejected");
        assert!(c.decrypt("not-hex").is_none());
        assert!(c.decrypt("").is_none());
        let other = JournalCrypto::from_key([8u8; 32]);
        assert!(other.decrypt(&sealed).is_none(), "wrong key rejected");
    }

    #[test]
    fn key_file_fallback_round_trips_and_persists() {
        let dir = std::env::temp_dir().join(format!("fl-jc-{}", uuid::Uuid::new_v4().simple()));
        // Force the file path regardless of platform by calling the loader on
        // a throwaway dir — on Windows the credential store wins, so only
        // assert file behaviour when the store is unavailable.
        if !crate::secrets::available() {
            let k1 = load_or_create_key(&dir).unwrap();
            let k2 = load_or_create_key(&dir).unwrap();
            assert_eq!(k1, k2, "key file persists across opens");
            assert!(dir.join(KEY_FILE).is_file());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
