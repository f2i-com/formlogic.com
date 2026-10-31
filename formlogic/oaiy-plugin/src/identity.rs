//! This computer's node identity: an Ed25519 key FormLogic's owner approves.
//!
//! A request that moves data is signed by this key as well as sent with the plugin's sign-in, so a
//! stolen sign-in can't name a key of its own to seal to, or push a restore. The owner approves a
//! key, not a name, by comparing the fingerprint here with the one in the browser, so it is worked
//! out and shown exactly as FormLogic does (`DataCanonicalJson::fingerprint`, `DataNodesPanel`).

use std::path::Path;

use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use sha2::{Digest, Sha256};

const FILE: &str = "node.key";
const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub struct NodeIdentity {
    signing: SigningKey,
}

impl NodeIdentity {
    pub fn from_secret_bytes(bytes: [u8; 32]) -> Self {
        NodeIdentity { signing: SigningKey::from_bytes(&bytes) }
    }

    pub fn public_key_b64(&self) -> String {
        B64.encode(self.signing.verifying_key().to_bytes())
    }

    pub fn fingerprint(&self) -> String {
        Sha256::digest(self.signing.verifying_key().to_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn sign_b64(&self, message: &[u8]) -> String {
        B64.encode(self.signing.sign(message).to_bytes())
    }

    /// This computer's identity, made on first use. A file that can't be read is an error, not a
    /// new key: a new key takes the node back to needing the owner's approval.
    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        let path = dir.join(FILE);
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                let bytes = B64.decode(text.trim()).ok().and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok());
                return bytes.map(Self::from_secret_bytes).ok_or_else(|| "This computer's node key is damaged. Forget the link and connect again.".to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not read this computer's node key: {e}")),
        }
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|e| format!("Could not make a node key: {e}"))?;
        crate::secret_file::write(&path, B64.encode(secret)).map_err(|e| format!("Could not save this computer's node key: {e}"))?;
        Ok(Self::from_secret_bytes(secret))
    }
}

/// The first 24 characters in fours, as FormLogic's Data nodes list shows them.
pub fn display_fingerprint(hex: &str) -> String {
    hex.as_bytes().chunks(4).take(6).map(|chunk| String::from_utf8_lossy(chunk).into_owned()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fl-backups-node-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_key_is_kept() {
        let dir = folder("kept");
        std::fs::create_dir_all(&dir).unwrap();
        let first = NodeIdentity::load_or_create(&dir).unwrap();
        let second = NodeIdentity::load_or_create(&dir).unwrap();
        assert_eq!(first.public_key_b64(), second.public_key_b64());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_key_is_an_error_and_not_a_new_key() {
        let dir = folder("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "not a key").unwrap();
        assert!(NodeIdentity::load_or_create(&dir).is_err());
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), "not a key");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_signature_is_ed25519_over_the_message() {
        use ed25519_dalek::{Signature, VerifyingKey};
        let identity = NodeIdentity::from_secret_bytes([7u8; 32]);
        let signature: [u8; 64] = B64.decode(identity.sign_b64(b"flsourcebackup:1|x")).unwrap().try_into().unwrap();
        let public: [u8; 32] = B64.decode(identity.public_key_b64()).unwrap().try_into().unwrap();
        VerifyingKey::from_bytes(&public).unwrap().verify_strict(b"flsourcebackup:1|x", &Signature::from_bytes(&signature)).unwrap();
    }

    #[test]
    fn the_fingerprint_is_shown_as_formlogic_shows_it() {
        // displayFingerprint: fp.slice(0, 24) in groups of four.
        let hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(display_fingerprint(hex), "0123 4567 89ab cdef 0123 4567");
    }
}
