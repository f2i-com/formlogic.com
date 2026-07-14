//! NATIVE-SEC-001 — trust-on-first-use (TOFU) pinning of server signing keys.
//!
//! The manifest AND the Ed25519 public key are both fetched from the
//! navigated origin, so signature verification alone proves only that the
//! origin is internally consistent — any origin could serve its own manifest
//! signed by its own key and "verify". The pin store breaks that
//! self-assertion: the FIRST time an origin presents a signing key the user
//! must explicitly confirm trust (with the key's fingerprint shown), the key
//! is then pinned to the origin, and every later verification requires the
//! SAME key. A changed key is a hard stop that demands an explicit,
//! sternly-worded re-confirmation (legitimate rotation vs. impersonation is
//! a call only the operator can make).
//!
//! Pins live in `pinned-keys.json` in the app data dir. Persistence is
//! fail-closed: if a new pin cannot be written, trust is NOT granted for
//! the session (a pin that vanishes on restart would re-prompt as "first
//! use" and hide a later key substitution).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedKey {
    /// The server's Ed25519 public key exactly as served (standard base64).
    pub public_key: String,
    pub pinned_at: String,
}

/// Outcome of comparing a served key against the pin store.
#[derive(Debug)]
pub enum PinCheck {
    /// No pin for this origin yet — first use, requires explicit consent.
    NewOrigin,
    /// The served key matches the pinned one.
    Match,
    /// The served key DIFFERS from the pinned one — rotation or attack.
    Changed { old: PinnedKey },
}

/// What the user is asked to confirm.
#[derive(Debug)]
pub enum TrustPrompt {
    FirstUse {
        origin: String,
        slug: String,
        fingerprint: String,
    },
    Rotation {
        origin: String,
        slug: String,
        old_fingerprint: String,
        new_fingerprint: String,
        pinned_at: String,
    },
}

pub struct PinnedKeys {
    path: PathBuf,
    map: Mutex<HashMap<String, PinnedKey>>,
}

impl PinnedKeys {
    pub fn load(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, PinnedKey>>(&s).ok())
            .unwrap_or_default();
        PinnedKeys {
            path,
            map: Mutex::new(map),
        }
    }

    /// Compare `served_key` (standard base64, as the server exposes it)
    /// against the pin for `origin`.
    pub fn check(&self, origin: &str, served_key: &str) -> PinCheck {
        match self.map.lock().unwrap().get(origin) {
            None => PinCheck::NewOrigin,
            Some(pin) if pin.public_key.trim() == served_key.trim() => PinCheck::Match,
            Some(pin) => PinCheck::Changed { old: pin.clone() },
        }
    }

    /// Record (or replace) the pin for an origin. Fail-closed: an Err means
    /// the pin is NOT in effect and the caller must not grant trust.
    pub fn pin(&self, origin: &str, served_key: &str, now_iso: String) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let prev = map.insert(
            origin.to_string(),
            PinnedKey {
                public_key: served_key.trim().to_string(),
                pinned_at: now_iso,
            },
        );
        if let Err(e) = self.persist(&map) {
            // Roll back so memory never claims a pin the disk doesn't hold.
            match prev {
                Some(p) => {
                    map.insert(origin.to_string(), p);
                }
                None => {
                    map.remove(origin);
                }
            }
            return Err(e);
        }
        Ok(())
    }

    fn persist(&self, map: &HashMap<String, PinnedKey>) -> Result<(), String> {
        let body = serde_json::to_string_pretty(map)
            .map_err(|e| format!("pin store serialize failed: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)
                .map_err(|e| format!("pin store write failed (create): {e}"))?;
            f.write_all(body.as_bytes())
                .map_err(|e| format!("pin store write failed: {e}"))?;
            f.sync_data()
                .map_err(|e| format!("pin store fsync failed: {e}"))?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("pin store rename failed: {e}")
        })
    }
}

/// Human-checkable fingerprint of a served public key: SHA-256 of the
/// decoded key bytes, hex, grouped for readability. Falls back to hashing
/// the raw string when the base64 doesn't decode (still stable + unique).
pub fn fingerprint(pubkey_b64: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pubkey_b64.trim())
        .unwrap_or_else(|_| pubkey_b64.trim().as_bytes().to_vec());
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let grouped: Vec<String> = hex
        .as_bytes()
        .chunks(8)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect();
    format!("SHA256:{}", grouped.join(" "))
}

/// Decision + pinning flow shared by production and tests: after the
/// manifest SIGNATURE and identity already verified with `served_key`,
/// decide whether the ORIGIN itself is trusted to hold that key. `confirm`
/// is the explicit-user-consent hook (a native dialog in production).
pub fn evaluate_trust(
    pins: &PinnedKeys,
    origin: &str,
    slug: &str,
    served_key: &str,
    now_iso: String,
    confirm: &dyn Fn(&TrustPrompt) -> bool,
) -> Result<(), String> {
    match pins.check(origin, served_key) {
        PinCheck::Match => Ok(()),
        PinCheck::NewOrigin => {
            let prompt = TrustPrompt::FirstUse {
                origin: origin.to_string(),
                slug: slug.to_string(),
                fingerprint: fingerprint(served_key),
            };
            if !confirm(&prompt) {
                return Err(format!(
                    "user declined to trust first-use signing key for {origin}"
                ));
            }
            pins.pin(origin, served_key, now_iso)
                .map_err(|e| format!("trust NOT granted — pin could not be persisted: {e}"))
        }
        PinCheck::Changed { old } => {
            let prompt = TrustPrompt::Rotation {
                origin: origin.to_string(),
                slug: slug.to_string(),
                old_fingerprint: fingerprint(&old.public_key),
                new_fingerprint: fingerprint(served_key),
                pinned_at: old.pinned_at.clone(),
            };
            if !confirm(&prompt) {
                return Err(format!(
                    "signing key for {origin} CHANGED since {} and the user declined the new key",
                    old.pinned_at
                ));
            }
            pins.pin(origin, served_key, now_iso)
                .map_err(|e| format!("trust NOT granted — re-pin could not be persisted: {e}"))
        }
    }
}

/// Render a prompt as native-dialog (title, body) text.
pub fn prompt_text(p: &TrustPrompt) -> (String, String) {
    match p {
        TrustPrompt::FirstUse {
            origin,
            slug,
            fingerprint,
        } => (
            "Trust this FormLogic server?".to_string(),
            format!(
                "First connection to {origin}\n\nThe app \"{slug}\" wants native device access and \
                 offline sync. The server's signing key fingerprint is:\n\n{fingerprint}\n\n\
                 Only continue if this is a server you run or trust. If you choose \"Keep \
                 display-only\", the app still works in the browser sandbox without native access."
            ),
        ),
        TrustPrompt::Rotation {
            origin,
            slug,
            old_fingerprint,
            new_fingerprint,
            pinned_at,
        } => (
            "SECURITY WARNING — server signing key changed".to_string(),
            format!(
                "{origin} (app \"{slug}\") now presents a DIFFERENT signing key than the one you \
                 trusted on {pinned_at}.\n\nPreviously pinned:\n{old_fingerprint}\n\nNow served:\n\
                 {new_fingerprint}\n\nThis can mean the server legitimately rotated its key — or \
                 that something is impersonating it. Only trust the new key if the server operator \
                 confirms the rotation."
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_store(tag: &str) -> (PathBuf, PinnedKeys) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("fl-pins-{tag}-{n}.json"));
        let _ = std::fs::remove_file(&path);
        let pins = PinnedKeys::load(path.clone());
        (path, pins)
    }

    const KEY_A: &str = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
    const KEY_B: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    #[test]
    fn first_use_requires_consent_then_pins() {
        let (path, pins) = tmp_store("first");
        // Declined → no trust, nothing pinned.
        let declined =
            evaluate_trust(&pins, "https://a.example", "demo", KEY_A, "t0".into(), &|_| false);
        assert!(declined.is_err());
        assert!(matches!(pins.check("https://a.example", KEY_A), PinCheck::NewOrigin));

        // Accepted → pinned; the SAME key later matches WITHOUT a prompt.
        let mut prompted = std::cell::Cell::new(false);
        let ok = evaluate_trust(&pins, "https://a.example", "demo", KEY_A, "t1".into(), &|p| {
            assert!(matches!(p, TrustPrompt::FirstUse { .. }));
            prompted.set(true);
            true
        });
        assert!(ok.is_ok());
        assert!(prompted.get());
        prompted = std::cell::Cell::new(false);
        let again =
            evaluate_trust(&pins, "https://a.example", "demo", KEY_A, "t2".into(), &|_| {
                prompted.set(true);
                true
            });
        assert!(again.is_ok());
        assert!(!prompted.get(), "a matching pin never prompts");

        // The pin survives a reload.
        let pins2 = PinnedKeys::load(path.clone());
        assert!(matches!(pins2.check("https://a.example", KEY_A), PinCheck::Match));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn key_rotation_is_a_hard_stop_until_reconfirmed() {
        let (path, pins) = tmp_store("rotate");
        evaluate_trust(&pins, "https://a.example", "demo", KEY_A, "t0".into(), &|_| true).unwrap();

        // A DIFFERENT key must not silently verify — declined rotation = no trust,
        // and the OLD pin stays in force.
        let refused =
            evaluate_trust(&pins, "https://a.example", "demo", KEY_B, "t1".into(), &|p| {
                assert!(matches!(p, TrustPrompt::Rotation { .. }));
                false
            });
        assert!(refused.is_err());
        assert!(refused.unwrap_err().contains("CHANGED"));
        assert!(matches!(pins.check("https://a.example", KEY_A), PinCheck::Match));

        // Explicitly confirmed rotation re-pins the new key.
        evaluate_trust(&pins, "https://a.example", "demo", KEY_B, "t2".into(), &|_| true).unwrap();
        assert!(matches!(pins.check("https://a.example", KEY_B), PinCheck::Match));
        assert!(matches!(
            pins.check("https://a.example", KEY_A),
            PinCheck::Changed { .. }
        ));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn origins_are_pinned_independently() {
        let (path, pins) = tmp_store("multi");
        evaluate_trust(&pins, "https://a.example", "x", KEY_A, "t".into(), &|_| true).unwrap();
        // A different origin serving its own key is still FIRST USE — one
        // origin's pin never vouches for another.
        assert!(matches!(pins.check("https://b.example", KEY_A), PinCheck::NewOrigin));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unpersistable_pin_means_no_trust() {
        // A pin store pointed at an unwritable path must refuse trust.
        let dir = std::env::temp_dir().join(format!(
            "fl-pins-nodir-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        // Parent dir does NOT exist → persist fails.
        let pins = PinnedKeys::load(dir.join("missing").join("pins.json"));
        let res = evaluate_trust(&pins, "https://a.example", "x", KEY_A, "t".into(), &|_| true);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("NOT granted"));
        // And memory rolled back: still NewOrigin, not a phantom Match.
        assert!(matches!(pins.check("https://a.example", KEY_A), PinCheck::NewOrigin));
    }

    #[test]
    fn fingerprints_are_stable_and_distinct() {
        let a = fingerprint(KEY_A);
        let b = fingerprint(KEY_B);
        assert!(a.starts_with("SHA256:"));
        assert_ne!(a, b);
        assert_eq!(a, fingerprint(KEY_A));
        // Grouped hex is human-checkable.
        assert!(a.split(' ').count() > 4);
    }

    #[test]
    fn prompt_texts_carry_the_decision_material() {
        let (t1, b1) = prompt_text(&TrustPrompt::FirstUse {
            origin: "https://a.example".into(),
            slug: "demo".into(),
            fingerprint: "SHA256:abcd".into(),
        });
        assert!(t1.contains("Trust"));
        assert!(b1.contains("https://a.example") && b1.contains("SHA256:abcd") && b1.contains("demo"));

        let (t2, b2) = prompt_text(&TrustPrompt::Rotation {
            origin: "https://a.example".into(),
            slug: "demo".into(),
            old_fingerprint: "SHA256:old".into(),
            new_fingerprint: "SHA256:new".into(),
            pinned_at: "2026-01-01T00:00:00Z".into(),
        });
        assert!(t2.contains("WARNING"));
        assert!(b2.contains("SHA256:old") && b2.contains("SHA256:new") && b2.contains("2026-01-01"));
    }
}
