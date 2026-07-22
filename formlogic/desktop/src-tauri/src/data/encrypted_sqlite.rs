//! EncryptedDatasetStore driver: SQLCipher via rusqlite
//! (`bundled-sqlcipher-vendored-openssl`), plan §10.1.
//!
//! * random 256-bit key per dataset, applied via `PRAGMA key = "x'…'"` BEFORE
//!   any schema access (raw-key form skips SQLCipher's KDF — the key is
//!   already full-entropy from the OS RNG);
//! * WAL journaling, `temp_store = MEMORY`, foreign keys ON;
//! * wrong key / corrupt header / plain-SQLite file all fail closed on the
//!   post-key probe — there is NO fallback to ordinary SQLite (plan D17);
//! * `cipher_integrity_check` + `integrity_check` are the verify path.
//!
//! Record-level `__flenc:1` E2EE remains mandatory on top (plan §10.1):
//! SQLCipher protects local metadata and copied files; the envelope is what
//! preserves E2EE across Cloud/relay/backup/replica boundaries.

use rusqlite::Connection;
use std::path::Path;

use super::canonical::hex_lower;
use super::DataError;

/// Local dataset schema (plan §10.2). The replication tables are created from
/// N1 so later phases never migrate a live store's shape.
const DATASET_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS dataset_meta (
  dataset_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  role TEXT NOT NULL,
  storage_epoch INTEGER NOT NULL,
  primary_replica_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_operation_hash TEXT,
  last_checkpoint_hash TEXT,
  health TEXT NOT NULL DEFAULT 'configured'
);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new',
  submitted_at TEXT,
  updated_at TEXT,
  submitted_by_user_id TEXT,
  metadata TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  trashed_at TEXT,
  answers TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replication_operations (
  operation_id TEXT PRIMARY KEY,
  storage_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  entity_id TEXT,
  operation_hash TEXT NOT NULL,
  placement_manifest_hash TEXT NOT NULL,
  encryption_manifest_hash TEXT,
  write_lease_id TEXT NOT NULL,
  fencing_generation INTEGER NOT NULL,
  base_rev INTEGER,
  rev INTEGER,
  expected_row_version INTEGER,
  row_version INTEGER,
  cipher_hash TEXT,
  canonical_operation TEXT NOT NULL,
  origin_replica_id TEXT NOT NULL,
  previous_hash TEXT,
  signer_key_id TEXT NOT NULL,
  signer_key_generation INTEGER NOT NULL,
  signature TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_artifacts (
  artifact_kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  signed_bytes BLOB NOT NULL,
  signer_key_id TEXT NOT NULL,
  signer_key_generation INTEGER NOT NULL,
  verified_at TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (artifact_kind, artifact_id)
);
CREATE TABLE IF NOT EXISTS replication_inbox (
  operation_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  result_hash TEXT
);
CREATE TABLE IF NOT EXISTS replica_checkpoints (
  replica_id TEXT NOT NULL,
  storage_epoch INTEGER NOT NULL,
  applied_sequence INTEGER NOT NULL,
  logical_root TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (replica_id, storage_epoch, applied_sequence)
);
CREATE TABLE IF NOT EXISTS tombstones (
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  final_row_version INTEGER,
  final_rev INTEGER,
  final_cipher_hash TEXT,
  delete_reason TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  ledger_entry_hash TEXT,
  storage_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  retain_until TEXT,
  PRIMARY KEY (entity_kind, entity_id)
);
CREATE TABLE IF NOT EXISTS tombstone_ledger_state (
  coverage_sequence INTEGER NOT NULL,
  ledger_root TEXT,
  independent_anchor_verified_at TEXT
);
CREATE TABLE IF NOT EXISTS idempotency_reservations (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachment_objects (
  file_id TEXT PRIMARY KEY,
  chunk_count INTEGER NOT NULL,
  cipher_size INTEGER NOT NULL,
  cipher_hash TEXT NOT NULL,
  committed_sequence INTEGER,
  deleted_sequence INTEGER
);
CREATE TABLE IF NOT EXISTS backup_catalog (
  backup_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  checkpoint TEXT,
  manifest_hash TEXT,
  location_ref TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
";

/// Open (creating if absent) a dataset database with its 256-bit key applied
/// before any schema access. Fails closed on wrong key / corrupt header /
/// plain-SQLite content.
pub fn open_dataset_db(path: &Path, key: &[u8; 32]) -> Result<Connection, DataError> {
    let conn = Connection::open(path)
        .map_err(|e| DataError::StoreUnavailable(format!("open failed: {e}")))?;
    // Raw-key PRAGMA form; the hex string is not a secret-preserving copy
    // problem here (process memory already holds the key), and rusqlite has
    // no parameterized PRAGMA key.
    conn.pragma_update(None, "key", format!("x'{}'", hex_lower(key).to_uppercase()))
        .map_err(|e| DataError::StoreUnavailable(format!("keying failed: {e}")))?;
    // First real page read proves the key matches (or the file is garbage /
    // plain SQLite). Without this probe a wrong key surfaces later as
    // "file is not a database" mid-write.
    let probe: Result<i64, _> =
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0));
    if let Err(e) = probe {
        return Err(DataError::StoreUnavailable(format!(
            "encrypted store rejected the key (wrong key or corrupt header): {e}"
        )));
    }
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| DataError::StoreUnavailable(format!("busy_timeout: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| DataError::StoreUnavailable(format!("WAL: {e}")))?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|e| DataError::StoreUnavailable(format!("synchronous: {e}")))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| DataError::StoreUnavailable(format!("temp_store: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| DataError::StoreUnavailable(format!("foreign_keys: {e}")))?;
    Ok(conn)
}

pub fn ensure_schema(conn: &Connection) -> Result<(), DataError> {
    conn.execute_batch(DATASET_SCHEMA)
        .map_err(|e| DataError::StoreUnavailable(format!("schema: {e}")))
}

/// SQLCipher + SQLite integrity verification. Empty result = healthy.
pub fn integrity_issues(conn: &Connection) -> Result<Vec<String>, DataError> {
    let mut issues = Vec::new();
    // cipher_integrity_check returns one row PER PROBLEM PAGE (no rows = ok).
    let mut stmt = conn
        .prepare("PRAGMA cipher_integrity_check")
        .map_err(|e| DataError::StoreUnavailable(format!("cipher_integrity_check: {e}")))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| DataError::StoreUnavailable(format!("cipher_integrity_check: {e}")))?;
    for row in rows.flatten() {
        issues.push(format!("cipher: {row}"));
    }
    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| DataError::StoreUnavailable(format!("integrity_check: {e}")))?;
    if ok != "ok" {
        issues.push(format!("sqlite: {ok}"));
    }
    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fl-enc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("data.sqlite3.enc")
    }

    #[test]
    fn round_trip_wrong_key_and_no_plaintext_on_disk() {
        let path = temp_db();
        let key = [0x11u8; 32];
        {
            let conn = open_dataset_db(&path, &key).unwrap();
            ensure_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO responses (id, answers) VALUES (?1, ?2)",
                ("row-1", "data-node-canary-marker-7f3a"),
            )
            .unwrap();
            // Move WAL content into the main file so the on-disk scan below
            // sees every byte that will persist (wal_checkpoint returns a
            // result row, so it is a query, not a pragma_update).
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .unwrap();
        }
        // Wrong key fails closed on the probe.
        let wrong = open_dataset_db(&path, &[0x22u8; 32]);
        assert!(matches!(wrong, Err(DataError::StoreUnavailable(_))));

        // The file must be ciphertext: no canary, no plain SQLite header.
        let bytes = std::fs::read(&path).unwrap();
        let canary = b"data-node-canary-marker-7f3a";
        assert!(
            !bytes.windows(canary.len()).any(|w| w == canary),
            "plaintext canary must not appear in the encrypted file"
        );
        assert!(!bytes.starts_with(b"SQLite format 3"), "header must be encrypted");

        // Right key still reads.
        let conn = open_dataset_db(&path, &key).unwrap();
        let val: String = conn
            .query_row("SELECT answers FROM responses WHERE id = 'row-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(val, "data-node-canary-marker-7f3a");
        assert!(integrity_issues(&conn).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn plain_sqlite_file_is_rejected() {
        let path = temp_db();
        // Make an ordinary UNencrypted SQLite db at the path.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);").unwrap();
        }
        let res = open_dataset_db(&path, &[0x33u8; 32]);
        assert!(
            matches!(res, Err(DataError::StoreUnavailable(_))),
            "a plain SQLite file must not open as an encrypted dataset"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
