//! Encrypted Data Nodes — Desktop-hosted encrypted dataset storage (N1).
//!
//! Plan authority: docs/FORMLOGIC_DESKTOP_ENCRYPTED_DATA_NODES_PLAN.md;
//! implementation constants: docs/FORMLOGIC_DATA_NODES.md. Phase N1 scope:
//! local SQLCipher dataset stores, node identity, NSMK-wrapped dataset keys,
//! independent high-water rollback detection, the strict `__flenc:1`
//! validator, and the operational (read-only) Data workspace surface. The
//! relay/replication/migration modules land in N3+.
//!
//! File map vs plan §23.1: `schema`/`integrity` live inside
//! [`encrypted_sqlite`]; `status`/`operations`/`checkpoints` (N1 subset)
//! inside [`store`]; `relay`/`admissions`/`leases`/`replication`/`outbox`/
//! `snapshots`/`restore`/`migration` are N2/N3 work and deliberately absent.

pub mod canonical;
pub mod encrypted_sqlite;
pub mod envelope_validator;
pub mod high_water;
pub mod account_backup;
pub mod identity;
pub mod key_store;
pub mod scheduler;
pub mod snapshots;
pub mod store;
pub mod strict_json;

pub use store::{DataHandle, DataService};

use serde::Serialize;
use std::path::Path;

/// Typed failures, mapped onto the plan §21.3 error codes at the HTTP edge.
#[derive(Debug)]
pub enum DataError {
    /// No usable OS credential store — data hosting is disabled (plan D17).
    KeyStoreUnavailable,
    /// The encrypted store cannot be opened/driven (wrong key, corrupt
    /// header, unsupported cipher, I/O failure). Never falls back to plain
    /// SQLite.
    StoreUnavailable(String),
    /// Integrity/trust violation (tampered wrap, malformed anchor, chain
    /// break).
    Integrity(String),
    NotFound(String),
    Invalid(String),
}

impl DataError {
    pub fn code(&self) -> &'static str {
        match self {
            DataError::KeyStoreUnavailable => "data_key_store_unavailable",
            DataError::StoreUnavailable(_) => "encrypted_store_unavailable",
            DataError::Integrity(_) => "replica_integrity_failed",
            DataError::NotFound(_) => "dataset_not_found",
            DataError::Invalid(_) => "invalid_request",
        }
    }

    pub fn message(&self) -> String {
        match self {
            DataError::KeyStoreUnavailable => {
                "no secure OS key store is available; data hosting is disabled (no plaintext fallback)"
                    .to_string()
            }
            DataError::StoreUnavailable(m)
            | DataError::Integrity(m)
            | DataError::NotFound(m)
            | DataError::Invalid(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for DataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

/// Serializes tests that hit the REAL Windows Credential Manager: parallel
/// hammering from many tests can transiently fail unrelated reads (observed
/// once against aokie_endpoint_identity on a cold run), so credential-touching
/// data tests take this lock and keep the pressure low.
#[cfg(test)]
pub(crate) fn test_cred_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// RFC3339 UTC with integer seconds and 'Z' (the frozen timestamp shape for
/// signed structures — docs/FORMLOGIC_DATA_NODES.md §2).
pub(crate) fn utc_now_rfc3339() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Atomic JSON write: temp file + fsync + rename. (Directory fsync is not a
/// thing on Windows; the rename is atomic on NTFS.)
pub(crate) fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), DataError> {
    let parent = path
        .parent()
        .ok_or_else(|| DataError::Invalid("path has no parent".into()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| DataError::StoreUnavailable(format!("mkdir {}: {e}", parent.display())))?;
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| DataError::Invalid(format!("serialize: {e}")))?;
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| DataError::StoreUnavailable(format!("create {}: {e}", tmp.display())))?;
        f.write_all(json.as_bytes())
            .map_err(|e| DataError::StoreUnavailable(format!("write: {e}")))?;
        f.sync_all()
            .map_err(|e| DataError::StoreUnavailable(format!("fsync: {e}")))?;
    }
    if std::fs::rename(&tmp, path).is_err() {
        // Windows rename cannot replace an existing file; drop the old
        // projection first (the credential store, not this JSON, is the
        // authoritative copy of anything secret).
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp, path)
            .map_err(|e| DataError::StoreUnavailable(format!("rename into place: {e}")))?;
    }
    Ok(())
}
