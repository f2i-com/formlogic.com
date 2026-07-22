//! Data-node signing identity (plan §13.1, docs/FORMLOGIC_DATA_NODES.md §4).
//!
//! A stable per-install Ed25519 identity, DISTINCT from the tunnel X25519 key,
//! the consent-signing key, and the API credential (plan D16). The 32-byte
//! seed lives ONLY in the OS credential store (`data-node-signing-key`);
//! `data/node/public-identity.json` holds the public half for display and
//! later enrolment. FAIL-CLOSED: no credential store → no identity → data
//! hosting disabled with `data_key_store_unavailable` (plan D17) — this
//! deliberately diverges from the journal/consent plaintext fallbacks.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::canonical::{data_key_fingerprint, data_key_id};
use super::{atomic_write_json, DataError};

const SIGNING_KEY_NAME: &str = "data-node-signing-key";
const IDENTITY_FILE: &str = "public-identity.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicIdentity {
    pub v: u32,
    pub node_id: String,
    pub signing_public_key: String,
    pub key_id: String,
    pub fingerprint: String,
    pub created_at: String,
}

pub struct NodeIdentity {
    pub public: PublicIdentity,
    signing_key: SigningKey,
}

impl NodeIdentity {
    pub fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }
}

/// Load (or mint) the node identity. `node_dir` is `<data-root>/node`.
pub fn load_or_create(node_dir: &Path) -> Result<NodeIdentity, DataError> {
    if !crate::secrets::available() {
        return Err(DataError::KeyStoreUnavailable);
    }
    let seed: [u8; 32] = match crate::secrets::get(SIGNING_KEY_NAME) {
        Ok(Some(b64)) => B64
            .decode(b64.trim())
            .ok()
            .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
            .ok_or_else(|| DataError::Integrity("stored node signing seed is malformed".into()))?,
        Ok(None) => {
            let mut seed = [0u8; 32];
            getrandom::getrandom(&mut seed)
                .map_err(|e| DataError::Integrity(format!("no OS randomness: {e}")))?;
            match crate::secrets::store_verified(SIGNING_KEY_NAME, &B64.encode(seed)) {
                Ok(true) => seed,
                // Ok(false) = no keyring; Err = hard failure. Both fail closed —
                // an unprotected signing seed must never exist on disk.
                Ok(false) | Err(_) => return Err(DataError::KeyStoreUnavailable),
            }
        }
        Err(_) => return Err(DataError::KeyStoreUnavailable),
    };
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying = signing_key.verifying_key();
    let expected_pk = B64.encode(verifying.as_bytes());

    let path = node_dir.join(IDENTITY_FILE);
    let existing: Option<PublicIdentity> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let public = match existing {
        Some(p) if p.signing_public_key == expected_pk => p,
        // Missing or stale (e.g. the seed was rotated): re-derive; the seed in
        // the credential store is authoritative, the JSON is a projection.
        _ => {
            let public = PublicIdentity {
                v: 1,
                node_id: uuid::Uuid::new_v4().to_string(),
                signing_public_key: expected_pk,
                key_id: data_key_id(&verifying),
                fingerprint: data_key_fingerprint(&verifying),
                created_at: super::utc_now_rfc3339(),
            };
            atomic_write_json(&path, &public)?;
            public
        }
    };
    Ok(NodeIdentity { public, signing_key })
}

/// Display fingerprint: first 24 hex chars in groups of 4 (UI-only).
pub fn display_fingerprint(fingerprint: &str) -> String {
    fingerprint
        .chars()
        .take(24)
        .collect::<Vec<_>>()
        .chunks(4)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_fingerprint_groups_by_four() {
        let fp = "0123456789abcdef0011223344556677".to_string() + &"0".repeat(32);
        assert_eq!(display_fingerprint(&fp), "0123 4567 89ab cdef 0011 2233");
    }

    // Full identity round-trip runs only where a real credential store exists.
    #[cfg(windows)]
    #[test]
    fn identity_is_stable_across_loads() {
        let _cred = super::super::test_cred_lock();
        let dir = std::env::temp_dir().join(format!("fl-id-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = load_or_create(&dir).unwrap();
        let b = load_or_create(&dir).unwrap();
        assert_eq!(a.public.node_id, b.public.node_id, "node id persists via the JSON");
        assert_eq!(a.public.signing_public_key, b.public.signing_public_key);
        assert_eq!(a.public.key_id.len(), 16);
        assert_eq!(a.public.fingerprint.len(), 64);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
