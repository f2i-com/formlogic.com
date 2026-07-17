//! AI-405 — the per-install AI-gateway token handed to PLUGINS.
//!
//! Native plugins (Aokie) reach the loopback AI gateway's INFERENCE routes
//! (`/api/ai/v1/*`, `/api/ai/providers/:id/v1/*`) without a webview origin or
//! a pairing ceremony: the Desktop mints ONE random per-install token, stores
//! it in the OS credential store (`ai-gateway-token`, hex — same tiering as
//! the consent-signing key, with a key-file fallback beside the plugin data),
//! and injects it into every plugin child's environment as
//! `FORMLOGIC_AI_GATEWAY_TOKEN`. The HTTP guard accepts it — via a
//! constant-time compare — for the inference routes ONLY; provider config,
//! key management and aliases stay management-plane (webview | server token |
//! pairing token), so a leaked plugin token can spend inference but never
//! read or rewire keys.

use std::path::Path;
use std::sync::OnceLock;

const TOKEN_NAME: &str = "ai-gateway-token";
const TOKEN_FILE: &str = "ai-gateway-token.key";

/// The environment variable the token rides into plugin children on.
pub const ENV_NAME: &str = "FORMLOGIC_AI_GATEWAY_TOKEN";

static TOKEN: OnceLock<Option<String>> = OnceLock::new();

fn hex_encode(b: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        let _ = write!(s, "{x:02x}");
    }
    s
}

/// Mint a fresh 32-byte random token (64 hex chars). None only when the OS
/// RNG is unavailable.
fn mint() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(hex_encode(&bytes))
}

/// A stored token is valid iff it is exactly 64 lowercase-hex chars — anything
/// else (truncated file, hand edit) rotates rather than silently weakening.
fn valid(t: &str) -> bool {
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Load the per-install token, minting + persisting one on first run.
/// `use_store` selects the OS credential store first (false in tests so they
/// never touch the machine's real credential entry); the key-file fallback
/// mirrors `consent_signing::load_or_create_seed`.
fn load_or_create(fallback_dir: &Path, use_store: bool) -> Option<String> {
    // 1. OS credential store.
    if use_store {
        match crate::secrets::get(TOKEN_NAME) {
            Ok(Some(t)) if valid(t.trim()) => return Some(t.trim().to_string()),
            Ok(Some(_)) => {
                log::warn!("ai-gateway token in the credential store is malformed — rotating");
            }
            Ok(None) => {}
            Err(e) => log::warn!("ai-gateway token read failed ({e}); trying the key file"),
        }
        let token = mint()?;
        match crate::secrets::store_verified(TOKEN_NAME, &token) {
            Ok(true) => return Some(token),
            Ok(false) | Err(_) => {
                log::warn!("ai-gateway token could not be stored in the credential store; falling back to the key file");
            }
        }
    }
    // 2. Key-file fallback beside the plugin data.
    let path = fallback_dir.join(TOKEN_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let t = text.trim();
        if valid(t) {
            return Some(t.to_string());
        }
        log::warn!("{TOKEN_FILE} is malformed — rotating");
    }
    let token = mint()?;
    let _ = std::fs::create_dir_all(fallback_dir);
    if std::fs::write(&path, &token).is_err() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(token)
}

/// Initialise once at startup — BEFORE any plugin spawns, so the token rides
/// in every child's environment (same call site as `consent_signing::init`).
pub fn init(fallback_dir: &Path) {
    let _ = TOKEN.get_or_init(|| load_or_create(fallback_dir, crate::secrets::available()));
}

/// The token, when the store was initialised and writable. `None` before
/// `init` (the HTTP guard then simply never accepts a plugin bearer — fail
/// closed) or when no store was writable.
pub fn token() -> Option<String> {
    TOKEN.get().and_then(|t| t.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fl-ai-gw-token-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Round trip through the key-file path (use_store=false so the test never
    /// touches the machine's REAL credential entry): first call mints +
    /// persists, second call returns the SAME token, a corrupted file rotates.
    #[test]
    fn token_mints_persists_and_rotates_on_corruption() {
        let dir = tmp();
        let first = load_or_create(&dir, false).expect("minted");
        assert!(valid(&first), "minted token is 64 hex chars: {first}");
        let second = load_or_create(&dir, false).expect("reloaded");
        assert_eq!(first, second, "stable across restarts");

        std::fs::write(dir.join(TOKEN_FILE), "not-a-token").unwrap();
        let rotated = load_or_create(&dir, false).expect("rotated");
        assert!(valid(&rotated));
        assert_ne!(rotated, "not-a-token");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validity_rejects_wrong_length_and_non_hex() {
        assert!(valid(&"a".repeat(64)));
        assert!(!valid(&"a".repeat(63)));
        assert!(!valid(&"A".repeat(64)), "uppercase is not our alphabet");
        assert!(!valid(&"g".repeat(64)));
        assert!(!valid(""));
    }
}
