//! Node Storage Master Key + wrapped per-dataset database keys
//! (plan §9, docs/FORMLOGIC_DATA_NODES.md §4).
//!
//! * NSMK: random 32 bytes, ONLY in the OS credential store (`data-nsmk`).
//! * Per-dataset SQLCipher key: random 32 bytes, wrapped with
//!   XChaCha20-Poly1305 under the NSMK (AAD `fldbkey:1|<datasetId>`), stored
//!   base64 in `data/node/wrapped-dataset-keys.json`.
//!
//! FAIL-CLOSED everywhere (plan D17): no credential store, unwrap failure, or
//! store failure disables hosting (`data_key_store_unavailable` /
//! `encrypted_store_unavailable`) — never a plaintext key beside the data.
//! A portable restore mints a FRESH database key (plan §18.2); wrapped keys
//! are unusable without the NSMK, and the NSMK never enters any backup.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::{atomic_write_json, DataError};

const NSMK_NAME: &str = "data-nsmk";
const WRAPPED_KEYS_FILE: &str = "wrapped-dataset-keys.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct WrappedKeysFile {
    v: u32,
    /// datasetId -> base64(nonce(24) || ciphertext).
    wraps: BTreeMap<String, String>,
}

fn dataset_key_aad(dataset_id: &str) -> Vec<u8> {
    format!("fldbkey:1|{dataset_id}").into_bytes()
}

fn load_nsmk() -> Result<[u8; 32], DataError> {
    if !crate::secrets::available() {
        return Err(DataError::KeyStoreUnavailable);
    }
    match crate::secrets::get(NSMK_NAME) {
        Ok(Some(b64)) => B64
            .decode(b64.trim())
            .ok()
            .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
            .ok_or_else(|| DataError::Integrity("stored NSMK is malformed".into())),
        Ok(None) => {
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key)
                .map_err(|e| DataError::Integrity(format!("no OS randomness: {e}")))?;
            match crate::secrets::store_verified(NSMK_NAME, &B64.encode(key)) {
                Ok(true) => Ok(key),
                Ok(false) | Err(_) => Err(DataError::KeyStoreUnavailable),
            }
        }
        Err(_) => Err(DataError::KeyStoreUnavailable),
    }
}

fn read_wraps(node_dir: &Path) -> WrappedKeysFile {
    std::fs::read_to_string(node_dir.join(WRAPPED_KEYS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(WrappedKeysFile { v: 1, wraps: BTreeMap::new() })
}

/// Get (or mint + wrap) the 32-byte database key for a dataset.
pub fn get_or_create_dataset_key(node_dir: &Path, dataset_id: &str) -> Result<[u8; 32], DataError> {
    let nsmk = load_nsmk()?;
    let cipher = XChaCha20Poly1305::new((&nsmk).into());
    let mut file = read_wraps(node_dir);

    if let Some(blob_b64) = file.wraps.get(dataset_id) {
        let blob = B64
            .decode(blob_b64)
            .map_err(|_| DataError::Integrity("wrapped dataset key is not valid base64".into()))?;
        if blob.len() <= 24 {
            return Err(DataError::Integrity("wrapped dataset key is truncated".into()));
        }
        let (nonce, ct) = blob.split_at(24);
        let key = cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload { msg: ct, aad: &dataset_key_aad(dataset_id) },
            )
            .map_err(|_| DataError::Integrity("dataset key unwrap failed (wrong NSMK or tamper)".into()))?;
        return <[u8; 32]>::try_from(key.as_slice())
            .map_err(|_| DataError::Integrity("unwrapped dataset key has the wrong length".into()));
    }

    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key)
        .map_err(|e| DataError::Integrity(format!("no OS randomness: {e}")))?;
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce)
        .map_err(|e| DataError::Integrity(format!("no OS randomness: {e}")))?;
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload { msg: &key, aad: &dataset_key_aad(dataset_id) },
        )
        .map_err(|_| DataError::Integrity("dataset key wrap failed".into()))?;
    let mut blob = Vec::with_capacity(24 + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    file.wraps.insert(dataset_id.to_string(), B64.encode(&blob));
    file.v = 1;
    atomic_write_json(&node_dir.join(WRAPPED_KEYS_FILE), &file)?;
    Ok(key)
}

/// Drop a dataset's wrapped key (sample-dataset removal / future replica
/// removal). Missing entries are fine — the delete is idempotent.
pub fn forget_dataset_key(node_dir: &Path, dataset_id: &str) -> Result<(), DataError> {
    let mut file = read_wraps(node_dir);
    if file.wraps.remove(dataset_id).is_some() {
        atomic_write_json(&node_dir.join(WRAPPED_KEYS_FILE), &file)?;
    }
    Ok(())
}

/// True when the OS credential store is usable for data hosting.
pub fn key_store_available() -> bool {
    crate::secrets::available()
}

#[cfg(test)]
mod tests {
    use super::*;

    // These exercise the REAL credential store, so they only run on Windows
    // (the shipped platform) — same posture as secrets.rs tests.
    #[cfg(windows)]
    #[test]
    fn dataset_key_round_trip_and_forget() {
        let _cred = super::super::test_cred_lock();
        let dir = std::env::temp_dir().join(format!("fl-ks-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let k1 = get_or_create_dataset_key(&dir, &id).unwrap();
        let k2 = get_or_create_dataset_key(&dir, &id).unwrap();
        assert_eq!(k1, k2, "unwrap returns the same key");
        let other = get_or_create_dataset_key(&dir, &format!("{id}-b")).unwrap();
        assert_ne!(k1, other, "each dataset gets its own key");

        // AAD binds the wrap to its dataset id: copying the blob to another
        // id must fail closed, not decrypt.
        let mut file = read_wraps(&dir);
        let blob = file.wraps.get(&id).unwrap().clone();
        file.wraps.insert(format!("{id}-stolen"), blob);
        atomic_write_json(&dir.join(WRAPPED_KEYS_FILE), &file).unwrap();
        assert!(matches!(
            get_or_create_dataset_key(&dir, &format!("{id}-stolen")),
            Err(DataError::Integrity(_))
        ));

        forget_dataset_key(&dir, &id).unwrap();
        let k3 = get_or_create_dataset_key(&dir, &id).unwrap();
        assert_ne!(k1, k3, "forget mints a fresh key");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
