//! The key backups are sealed to.
//!
//! Twelve words spell 16 random bytes (`oaiy_crypto::bip39`), and the key is derived from those
//! alone, so a lost computer loses nothing: the words make the same key anywhere. Nothing is saved
//! when the words are made: a key is kept only once the person has them, so closing the window
//! can't leave backups sealed to words nobody saw. Only the derived key is kept, in
//! `backup.key`, so anyone who gets at the data folder reads the backups but can't read the words.
//! The salt is fixed because recovery must need the words and nothing else, and the words already
//! carry 128 random bits, so a salt adds nothing.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use oaiy_crypto::bip39::{self, Entropy};
use oaiy_crypto::kdf;
use oaiy_crypto::x25519::SecretKey;
use oaiy_crypto::zeroize::{Secret, SecretString};
use zeroize::Zeroizing;

use crate::envelope;

const FILE: &str = "backup.key";
/// Which key this is, so that a look at the page doesn't read the key itself.
const ID_FILE: &str = "backup.id";
const SALT: &[u8; 16] = b"oaiy-fl-data-key";
/// The design's floor for a phrase (`oaiy-crypto`, `argon.rs`).
const OPS: u64 = 3;
const MEMORY: u64 = 64 * 1024 * 1024;
const PURPOSE: &[u8] = b"oaiy.formlogic-data.recipient.v1";

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn derive(entropy: &Entropy) -> Result<SecretKey, String> {
    let failed = |_| "Could not make the backup key.".to_string();
    let mut wrap = Secret::<32>::zeroed();
    bip39::wrap_key_into(entropy, SALT, OPS, MEMORY, &mut wrap).map_err(failed)?;
    let mut secret = Secret::<32>::zeroed();
    kdf::hkdf_sha256_secret_into(wrap.expose(), None, PURPOSE, &mut secret).map_err(failed)?;
    Ok(SecretKey::from_secret(&secret))
}

fn save(root: &Path, key: &SecretKey) -> Result<(), String> {
    let encoded = Zeroizing::new(B64.encode(key.to_secret().expose()));
    crate::secret_file::write(&root.join(FILE), encoded.as_bytes()).map_err(|e| format!("Could not save the backup key: {e}"))?;
    crate::secret_file::write(&root.join(ID_FILE), key_id(key)).map_err(|e| format!("Could not save the backup key: {e}"))
}

/// Whether this computer has a key.
pub fn exists(root: &Path) -> bool {
    root.join(FILE).is_file()
}

/// Which key this computer has, without reading it.
pub fn saved_id(root: &Path) -> Option<String> {
    std::fs::read_to_string(root.join(ID_FILE)).ok().map(|id| id.trim().to_string()).filter(|id| !id.is_empty())
}

/// This computer's key, or `None` before one is made or recovered.
pub fn load(root: &Path) -> Result<Option<SecretKey>, String> {
    let text = match std::fs::read_to_string(root.join(FILE)) {
        Ok(text) => Zeroizing::new(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read the backup key: {e}")),
    };
    let damaged = "The backup key file is damaged. Enter your twelve words to make it again.";
    let bytes = Zeroizing::new(B64.decode(text.trim()).map_err(|_| damaged.to_string())?);
    SecretKey::from_slice(&bytes).map(Some).map_err(|_| damaged.to_string())
}

/// New words. Nothing is saved until they come back through [`recover`]. Refuses while a key is
/// here: the backups sealed to it need the words it came from.
pub fn new_words(root: &Path) -> Result<SecretString, String> {
    if exists(root) {
        return Err("This computer already has a backup key.".to_string());
    }
    let entropy = Entropy::random().map_err(|_| "Could not make the backup key.".to_string())?;
    Ok(bip39::encode(&entropy))
}

/// Which key the words make, without saving it.
pub fn id_of_words(words: &str) -> Result<String, String> {
    let entropy = bip39::decode(words).map_err(|_| "Those are not the twelve words: check each one.".to_string())?;
    Ok(key_id(&derive(&entropy)?))
}

/// The key the words make, saved here. Words that fail their checksum change nothing. Their
/// checksum is only four bits, so one mistyped word can pass it: when there are backups here the
/// key must open one of them, or nothing changes.
pub fn recover(root: &Path, words: &str, backups: &[PathBuf]) -> Result<SecretKey, String> {
    let entropy = bip39::decode(words).map_err(|_| "Those are not the twelve words: check each one.".to_string())?;
    let key = derive(&entropy)?;
    if !backups.is_empty() && !backups.iter().any(|backup| envelope::opens(backup, &key)) {
        return Err("Those words don't open the backups on this computer: check each one. Nothing has changed.".to_string());
    }
    save(root, &key)?;
    Ok(key)
}

/// The public key, as FormLogic takes it.
pub fn public_b64(key: &SecretKey) -> String {
    B64.encode(key.public_key().as_bytes())
}

/// What a sealed file calls this key (`keyId` in its header).
pub fn key_id(key: &SecretKey) -> String {
    oaiy_crypto::kdf::sha256_hex(key.public_key().as_bytes())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fl-backups-keys-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The whole recipe, worked out in PHP with libsodium: argon2id13 of the 16 zero bytes these
    /// words spell, `flphras1`, then HKDF-SHA256. Change any part of it here and every recovery of
    /// every backup ever made breaks, so it is pinned from outside.
    #[test]
    fn the_key_is_the_one_the_recipe_gives() {
        let dir = folder("known");
        let key = recover(&dir, WORDS, &[]).unwrap();
        assert_eq!(public_b64(&key), include_str!("fixtures/words-public-key.txt").trim());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_words_make_the_same_key_on_another_computer() {
        let first = folder("first");
        let second = folder("second");
        let words = new_words(&first).unwrap();
        assert_eq!(words.expose().split_whitespace().count(), 12);

        let key = recover(&first, words.expose(), &[]).unwrap();
        let again = recover(&second, words.expose(), &[]).unwrap();
        assert_eq!(public_b64(&key), public_b64(&again));
        assert_eq!(public_b64(&key), public_b64(&load(&second).unwrap().unwrap()));
        let _ = std::fs::remove_dir_all(first);
        let _ = std::fs::remove_dir_all(second);
    }

    #[test]
    fn nothing_is_kept_until_the_words_come_back() {
        let dir = folder("unsaved");
        new_words(&dir).unwrap();
        assert!(!exists(&dir), "someone who leaves the page has lost nothing");
        assert!(new_words(&dir).is_ok(), "and can start again");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn new_words_are_refused_while_a_key_is_here() {
        let dir = folder("twice");
        recover(&dir, WORDS, &[]).unwrap();
        assert!(new_words(&dir).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn words_that_fail_their_check_change_nothing() {
        let dir = folder("wrong");
        let key = recover(&dir, WORDS, &[]).unwrap();
        let wrong = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        assert!(recover(&dir, wrong, &[]).is_err());
        assert_eq!(public_b64(&key), public_b64(&load(&dir).unwrap().unwrap()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A word mistyped into another real word passes the checksum one time in sixteen.
    #[test]
    fn words_that_pass_their_check_but_open_nothing_here_change_nothing() {
        let dir = folder("typo");
        let key = recover(&dir, WORDS, &[]).unwrap();
        let backup = dir.join("backup.flbk");
        std::fs::write(&backup, envelope::sealed_for_tests(&key)).unwrap();
        let other = "legal winner thank year wave sausage worth useful legal winner thank yellow";

        let refused = recover(&dir, other, std::slice::from_ref(&backup)).err().unwrap();

        assert!(refused.contains("Nothing has changed"));
        assert_eq!(public_b64(&key), public_b64(&load(&dir).unwrap().unwrap()));
        assert!(recover(&dir, WORDS, std::slice::from_ref(&backup)).is_ok(), "the right words still work");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_words_are_not_stored() {
        let dir = folder("stored");
        let words = new_words(&dir).unwrap();
        recover(&dir, words.expose(), &[]).unwrap();
        let first_word = words.expose().split_whitespace().next().unwrap().to_string();
        assert!(!std::fs::read_to_string(dir.join(FILE)).unwrap().contains(&first_word));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn no_key_yet_is_not_an_error() {
        let dir = folder("none");
        assert!(load(&dir).unwrap().is_none());
        assert!(saved_id(&dir).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_key_file_says_how_to_mend_it() {
        let dir = folder("damaged");
        std::fs::write(dir.join(FILE), "not a key").unwrap();
        assert!(load(&dir).err().unwrap().contains("twelve words"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn which_key_is_known_without_reading_it() {
        let dir = folder("id");
        let key = recover(&dir, WORDS, &[]).unwrap();
        assert_eq!(saved_id(&dir), Some(key_id(&key)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_key_id_is_formlogics() {
        // FormLogic: substr(hash('sha256', $publicKey), 0, 16).
        let key = SecretKey::from_bytes([7u8; 32]);
        assert_eq!(key_id(&key), oaiy_crypto::kdf::sha256_hex(key.public_key().as_bytes())[..16]);
        assert_eq!(key_id(&key).len(), 16);
    }
}
