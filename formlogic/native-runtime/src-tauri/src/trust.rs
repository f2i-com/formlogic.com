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
//!
//! Reading is fail-closed too. A pin file that does not parse is kept aside
//! as `pinned-keys.json.corrupt-<unix seconds>`, never read as "no pins": a
//! key change would otherwise be asked about as a first use. While such a
//! file is kept aside, an origin with no pin is asked about with the
//! "key changed" strength of warning, since its earlier pin is unknown;
//! deleting the kept-aside file ends that. A pin file that exists but cannot
//! be opened (another program holding it) is never written over.
//!
//! A decline is remembered for the rest of the session, for every app on
//! that origin, so a reload does not ask again. Only one prompt is shown at
//! a time.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
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
    /// No pin for this origin, but the pin file could not be read, so one
    /// may have been lost: asked about as strongly as a changed key.
    Unknown,
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
    /// No pin is known for the origin because the pin file could not be read.
    UnknownPin {
        origin: String,
        slug: String,
        fingerprint: String,
        /// What happened to the pin file, in words.
        damage: String,
    },
}

pub struct PinnedKeys {
    path: PathBuf,
    map: Mutex<HashMap<String, PinnedKey>>,
    /// Set when a pin file could not be read (now or at an earlier launch,
    /// see `load`): an origin without a pin is then `PinCheck::Unknown`.
    damage: Option<String>,
    /// False when the file on disk could not be read, nor kept aside:
    /// writing it would replace pins nobody has read.
    writable: bool,
    /// Origins the person chose to keep display-only in this session.
    declined: Mutex<HashSet<String>>,
    /// Held while a prompt is shown, so only one is shown at a time.
    prompting: Mutex<()>,
}

impl PinnedKeys {
    pub fn load(path: PathBuf) -> Self {
        let mut damage = None;
        let mut writable = true;
        let map = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<HashMap<String, PinnedKey>>(&bytes) {
                Ok(map) => map,
                Err(parse) => {
                    let aside = aside_path(&path, crate::sync_queue::now_secs());
                    match std::fs::rename(&path, &aside) {
                        Ok(()) => {
                            damage = Some(format!(
                                "it did not parse ({parse}) and is kept aside as {}",
                                aside.display()
                            ))
                        }
                        Err(e) => {
                            writable = false;
                            damage = Some(format!(
                                "it did not parse ({parse}) and could not be kept aside ({e})"
                            ));
                        }
                    }
                    HashMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => {
                writable = false;
                damage = Some(format!("it could not be opened ({e})"));
                HashMap::new()
            }
        };
        // A file kept aside at an earlier launch still counts: the pins it held are as
        // unknown now as they were then.
        if damage.is_none() {
            if let Some(aside) = kept_aside(&path) {
                damage = Some(format!("an earlier one did not parse and is kept aside as {}", aside.display()));
            }
        }
        if let Some(d) = &damage {
            eprintln!("[formlogic] the pin file {} could not be read: {d}", path.display());
        }
        PinnedKeys {
            path,
            map: Mutex::new(map),
            damage,
            writable,
            declined: Mutex::new(HashSet::new()),
            prompting: Mutex::new(()),
        }
    }

    /// True when `origin` has a pin (whatever its key).
    pub fn is_pinned(&self, origin: &str) -> bool {
        self.map.lock().unwrap().contains_key(origin)
    }

    /// Compare `served_key` (standard base64, as the server exposes it)
    /// against the pin for `origin`.
    pub fn check(&self, origin: &str, served_key: &str) -> PinCheck {
        match self.map.lock().unwrap().get(origin) {
            None if self.damage.is_some() => PinCheck::Unknown,
            None => PinCheck::NewOrigin,
            Some(pin) if pin.public_key.trim() == served_key.trim() => PinCheck::Match,
            Some(pin) => PinCheck::Changed { old: pin.clone() },
        }
    }

    /// Record (or replace) the pin for an origin. Fail-closed: an Err means
    /// the pin is NOT in effect and the caller must not grant trust.
    pub fn pin(&self, origin: &str, served_key: &str, now_iso: String) -> Result<(), String> {
        if !self.writable {
            return Err(format!(
                "{} could not be read, so it is not written over: {}",
                self.path.display(),
                self.damage.as_deref().unwrap_or("")
            ));
        }
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

    fn has_declined(&self, origin: &str) -> bool {
        self.declined.lock().unwrap().contains(origin)
    }

    fn decline(&self, origin: &str) {
        self.declined.lock().unwrap().insert(origin.to_string());
    }
}

/// Where a pin file that does not parse is kept: `<file>.corrupt-<unix seconds>`,
/// never over an earlier one.
fn aside_path(path: &Path, now: u64) -> PathBuf {
    let mut n = 0;
    loop {
        let mut name = path.as_os_str().to_owned();
        name.push(if n == 0 { format!(".corrupt-{now}") } else { format!(".corrupt-{now}-{n}") });
        let candidate = PathBuf::from(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// A pin file kept aside at an earlier launch, if one is still there.
fn kept_aside(path: &Path) -> Option<PathBuf> {
    let prefix = format!("{}.corrupt-", path.file_name()?.to_string_lossy());
    std::fs::read_dir(path.parent()?)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&prefix)))
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
///
/// A decline is remembered for the session (`PinnedKeys::declined`), for every
/// app on the origin: the same question is not asked on every reload. Only
/// one prompt is shown at a time; a second verification of the same server
/// waits for the answer to the first and goes by it.
pub fn evaluate_trust(
    pins: &PinnedKeys,
    origin: &str,
    slug: &str,
    served_key: &str,
    now_iso: String,
    confirm: &dyn Fn(&TrustPrompt) -> bool,
) -> Result<(), String> {
    if let PinCheck::Match = pins.check(origin, served_key) {
        return Ok(());
    }
    let _turn = pins.prompting.lock().unwrap_or_else(|e| e.into_inner());
    if pins.has_declined(origin) {
        return Err(format!(
            "the user chose to keep {origin} display-only earlier in this session"
        ));
    }
    match pins.check(origin, served_key) {
        PinCheck::Match => Ok(()),
        PinCheck::NewOrigin => {
            let prompt = TrustPrompt::FirstUse {
                origin: origin.to_string(),
                slug: slug.to_string(),
                fingerprint: fingerprint(served_key),
            };
            if !confirm(&prompt) {
                pins.decline(origin);
                return Err(format!(
                    "user declined to trust first-use signing key for {origin}"
                ));
            }
            pins.pin(origin, served_key, now_iso)
                .map_err(|e| format!("trust NOT granted — pin could not be persisted: {e}"))
        }
        PinCheck::Unknown => {
            let prompt = TrustPrompt::UnknownPin {
                origin: origin.to_string(),
                slug: slug.to_string(),
                fingerprint: fingerprint(served_key),
                damage: pins.damage.clone().unwrap_or_default(),
            };
            if !confirm(&prompt) {
                pins.decline(origin);
                return Err(format!(
                    "the pin for {origin} is unknown (the pin file could not be read) and the user declined the key"
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
                pins.decline(origin);
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
        TrustPrompt::UnknownPin {
            origin,
            slug,
            fingerprint,
            damage,
        } => (
            "SECURITY WARNING — trusted server keys could not be read".to_string(),
            format!(
                "{origin} (app \"{slug}\") presents this signing key:\n\n{fingerprint}\n\nThe \
                 runtime's record of the server keys you trusted could not be read ({damage}), so it \
                 cannot tell whether this is the key you trusted before or a different one. A \
                 different one can mean the server rotated its key — or that something is \
                 impersonating it. Only trust it if the server operator confirms this fingerprint."
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

        // Accepted (in a later session: a decline holds for the rest of this one) → pinned;
        // the SAME key later matches WITHOUT a prompt.
        let pins = PinnedKeys::load(path.clone());
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

        // Explicitly confirmed rotation (in a later session: the decline holds for the rest of
        // this one) re-pins the new key.
        let pins = PinnedKeys::load(path.clone());
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

    /// The files beside `path` that hold a damaged pin store kept aside.
    fn kept_aside(path: &std::path::Path) -> Vec<PathBuf> {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{name}.corrupt-")))
            .collect()
    }

    fn damaged_store(tag: &str) -> (PathBuf, PathBuf) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fl-pins-{tag}-{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pinned-keys.json");
        std::fs::write(&path, b"{ \"https://a.example\": { \"publicKey\": ").unwrap();
        (dir, path)
    }

    #[test]
    fn a_damaged_pin_store_is_kept_aside_and_an_unpinned_origin_needs_the_strong_confirmation() {
        let (dir, path) = damaged_store("damaged");
        let pins = PinnedKeys::load(path.clone());
        // The damaged bytes are kept, not read as "no pins".
        let aside = kept_aside(&path);
        assert_eq!(aside.len(), 1, "kept aside: {aside:?}");
        assert!(std::fs::read_to_string(&aside[0]).unwrap().contains("https://a.example"));
        // a.example's pin may have been in it: its key is not "first seen".
        let asked = std::cell::RefCell::new(Vec::new());
        let ok = evaluate_trust(&pins, "https://a.example", "demo", KEY_B, "t".into(), &|p| {
            asked.borrow_mut().push(format!("{p:?}"));
            true
        });
        assert!(ok.is_ok());
        let asked = asked.into_inner();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].starts_with("UnknownPin"), "asked {asked:?}");
        // Confirmed, the key is pinned and later matches without a prompt.
        assert!(matches!(pins.check("https://a.example", KEY_B), PinCheck::Match));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_pin_store_still_counts_after_one_origin_is_confirmed_and_the_runtime_restarts() {
        let (dir, path) = damaged_store("damaged-restart");
        let pins = PinnedKeys::load(path.clone());
        evaluate_trust(&pins, "https://a.example", "demo", KEY_A, "t".into(), &|_| true).unwrap();
        drop(pins);
        // The new file parses cleanly and holds a.example alone.
        let pins = PinnedKeys::load(path.clone());
        assert!(matches!(pins.check("https://a.example", KEY_A), PinCheck::Match));
        let asked = std::cell::RefCell::new(Vec::new());
        let _ = evaluate_trust(&pins, "https://b.example", "demo", KEY_A, "t".into(), &|p| {
            asked.borrow_mut().push(format!("{p:?}"));
            false
        });
        let asked = asked.into_inner();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].starts_with("UnknownPin"), "asked {asked:?}");
        // Deleting the kept-aside file is how the person says the old pins are gone for good.
        for aside in kept_aside(&path) {
            std::fs::remove_file(aside).unwrap();
        }
        let pins = PinnedKeys::load(path.clone());
        assert!(matches!(pins.check("https://b.example", KEY_A), PinCheck::NewOrigin));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_pin_store_that_cannot_be_read_is_never_written_over() {
        use std::os::windows::fs::OpenOptionsExt;
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fl-pins-locked-{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pinned-keys.json");
        let held = format!("{{\"https://a.example\":{{\"publicKey\":\"{KEY_A}\",\"pinnedAt\":\"t0\"}}}}");
        std::fs::write(&path, &held).unwrap();
        // Another program holds the file with no sharing (a backup or virus scanner, say).
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        let pins = PinnedKeys::load(path.clone());
        drop(lock);
        let asked = std::cell::Cell::new(0);
        let res = evaluate_trust(&pins, "https://b.example", "demo", KEY_B, "t".into(), &|_| {
            asked.set(asked.get() + 1);
            true
        });
        assert!(res.is_err(), "trust granted with a pin that cannot be kept");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), held, "the unread pins were written over");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_decline_is_remembered_for_the_session_for_every_app_on_that_server() {
        let (path, pins) = tmp_store("declined");
        let asked = &std::cell::Cell::new(0);
        let ask = |answer: bool| {
            move |_: &TrustPrompt| {
                asked.set(asked.get() + 1);
                answer
            }
        };
        assert!(evaluate_trust(&pins, "https://a.example", "alpha", KEY_A, "t".into(), &ask(false)).is_err());
        assert_eq!(asked.get(), 1);
        // A reload of the page, or another app on the same server: not asked again.
        assert!(evaluate_trust(&pins, "https://a.example", "alpha", KEY_A, "t".into(), &ask(true)).is_err());
        assert!(evaluate_trust(&pins, "https://a.example", "beta", KEY_A, "t".into(), &ask(true)).is_err());
        assert_eq!(asked.get(), 1);
        // Another server is its own question.
        assert!(evaluate_trust(&pins, "https://b.example", "alpha", KEY_A, "t".into(), &ask(true)).is_ok());
        assert_eq!(asked.get(), 2);
        // The next session asks again.
        let pins = PinnedKeys::load(path.clone());
        assert!(evaluate_trust(&pins, "https://a.example", "alpha", KEY_A, "t".into(), &ask(true)).is_ok());
        assert_eq!(asked.get(), 3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn two_verifications_of_one_server_raise_one_prompt() {
        let (path, pins) = tmp_store("one-prompt");
        let pins = std::sync::Arc::new(pins);
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = ["alpha", "beta"]
            .into_iter()
            .map(|slug| {
                let (pins, asked) = (pins.clone(), asked.clone());
                std::thread::spawn(move || {
                    evaluate_trust(&pins, "https://a.example", slug, KEY_A, "t".into(), &|_| {
                        asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(150));
                        true
                    })
                })
            })
            .collect();
        for t in threads {
            assert!(t.join().unwrap().is_ok());
        }
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        let _ = std::fs::remove_file(&path);
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

        let (t3, b3) = prompt_text(&TrustPrompt::UnknownPin {
            origin: "https://a.example".into(),
            slug: "demo".into(),
            fingerprint: "SHA256:served".into(),
            damage: "kept aside as pinned-keys.json.corrupt-1".into(),
        });
        assert!(t3.contains("WARNING"));
        assert!(b3.contains("https://a.example") && b3.contains("SHA256:served") && b3.contains("corrupt-1"));
    }
}
