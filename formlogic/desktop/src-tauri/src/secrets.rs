//! DESK-SECRET-001 — OS credential store for Desktop secrets.
//!
//! The long-lived FormLogic Desktop API key (`flk_…`) and the HuggingFace
//! token used to be kept in plaintext in the companion config dir. This
//! module moves them into the OS credential store (Windows Credential
//! Manager) behind a small keyring abstraction, so a filesystem-only copy of
//! the config contains no usable secret. The config keeps only NON-secret
//! references (base URL, connection id, whether a key is set).
//!
//! Design points:
//! * **Verify-before-delete migration.** [`store_verified`] writes the secret
//!   AND reads it back before the caller removes any plaintext copy — a
//!   keyring that silently fails can never leave the operator locked out with
//!   the plaintext already gone.
//! * **Windows-first, safe elsewhere.** The credential-store backend is
//!   compiled on Windows (the audited, shipped platform). On other platforms
//!   the keyring reports unavailable and callers keep their existing plaintext
//!   behaviour, so a headless Linux build is unaffected.
//! * **No secret ever logged.** Callers log presence / migration, never the
//!   value.

/// One service namespace for every Desktop secret; the per-secret `name` is
/// the credential's "username" within it.
const SERVICE: &str = "com.formlogic.desktop";

/// Stable secret names.
pub const API_KEY: &str = "formlogic-api-key";
pub const HF_TOKEN: &str = "hf-token";

/// Whether an OS credential store is available on this platform/build.
#[cfg(windows)]
pub fn available() -> bool {
    true
}
#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

#[cfg(windows)]
pub fn set(name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, name).map_err(|e| format!("keyring entry: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("keyring set: {e}"))
}

#[cfg(windows)]
pub fn get(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, name).map_err(|e| format!("keyring entry: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get: {e}")),
    }
}

#[cfg(windows)]
pub fn delete(name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, name).map_err(|e| format!("keyring entry: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

// --- Non-Windows stubs: no OS keyring wired, so report unavailable and let
//     callers fall back to their existing plaintext storage. ---
#[cfg(not(windows))]
pub fn set(_name: &str, _value: &str) -> Result<(), String> {
    Err("no OS credential store on this platform".to_string())
}
#[cfg(not(windows))]
pub fn get(_name: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(windows))]
pub fn delete(_name: &str) -> Result<(), String> {
    Ok(())
}

/// Store `value` in the credential store and confirm it reads back before the
/// caller drops any plaintext copy.
///
/// * `Ok(true)`  — the secret is safely in the keyring; the caller SHOULD now
///   delete the plaintext copy.
/// * `Ok(false)` — no keyring on this platform; the caller keeps plaintext.
/// * `Err(_)`    — a hard keyring error (or a read-back mismatch); the caller
///   MUST keep the plaintext copy so the user isn't locked out.
pub fn store_verified(name: &str, value: &str) -> Result<bool, String> {
    if !available() {
        return Ok(false);
    }
    set(name, value)?;
    match get(name)? {
        Some(v) if v == value => Ok(true),
        _ => Err(
            "keyring stored a value that did not read back — keeping the local copy".to_string(),
        ),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Round-trips through the REAL Windows Credential Manager under a unique
    /// name so it can't collide with a live secret, and cleans up.
    #[test]
    fn windows_keyring_round_trips_and_deletes() {
        let name = format!("test-secret-{}", uuid::Uuid::new_v4().simple());
        assert!(available());
        assert_eq!(get(&name).unwrap(), None, "unused name starts empty");

        assert!(store_verified(&name, "s3cr3t-flk_value").unwrap());
        assert_eq!(get(&name).unwrap().as_deref(), Some("s3cr3t-flk_value"));

        // Overwrite round-trips too.
        assert!(store_verified(&name, "rotated").unwrap());
        assert_eq!(get(&name).unwrap().as_deref(), Some("rotated"));

        delete(&name).unwrap();
        assert_eq!(get(&name).unwrap(), None, "deleted secret is gone");
        // Deleting a missing entry is idempotent.
        delete(&name).unwrap();
    }
}
