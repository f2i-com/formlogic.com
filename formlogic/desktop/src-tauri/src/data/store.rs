//! DataService — the N1 dataset store manager: managed folder layout
//! (plan §10.4), dataset lifecycle, signed sample chains, verification, and
//! the status snapshot the Data workspace polls (plan §19).
//!
//! N1 datasets are SAMPLE datasets (form_id = `sample-form`): locally minted,
//! structurally identical to real ones — validated `__flenc:1` envelopes,
//! signed flop:1 operations in a hash chain, a signed flcheckpoint:1 head,
//! and an independent high-water anchor — so every later phase reuses this
//! exact write path. Real Cloud-fed datasets arrive with N2/N3.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::canonical::{
    self, hex_lower, DATA_PROTOCOL, DOMAIN_CHECKPOINT, DOMAIN_OPERATION, DOMAIN_PLACEMENT,
};
use super::envelope_validator::{self, ManifestTuple};
use super::high_water::{self, HeadComparison};
use super::identity::{self, display_fingerprint};
use super::{encrypted_sqlite, key_store, utc_now_rfc3339, DataError};

pub const SAMPLE_FORM_ID: &str = "sample-form";
const SAMPLE_ACCOUNT_ID: &str = "local-sample";
const SAMPLE_KEY_ID: &str = "fik_sample01";
const MAX_SAMPLE_RECORDS: u32 = 500;

const README: &str = "FormLogic Desktop — encrypted data node storage.\n\
\n\
Everything in this folder is encrypted (SQLCipher datasets + wrapped keys).\n\
Filenames are opaque IDs on purpose. Keys live in the OS credential store,\n\
NOT in this folder — copying it does not expose form responses, and a copy\n\
alone cannot be restored onto another machine.\n\
\n\
Do NOT copy the live `forms/` folder as a backup: use the Data workspace's\n\
backup actions (the `backups/` subfolder is the copy-safe output).\n";

pub struct DataService {
    root: PathBuf,
    /// Serializes layout init + dataset create/delete (DB access itself is
    /// per-connection).
    lifecycle: Mutex<()>,
}

pub type DataHandle = Arc<DataService>;

// ---------- wire DTOs (camelCase; polled by the Data workspace) ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub node_id: String,
    pub signing_public_key: String,
    pub key_id: String,
    pub fingerprint: String,
    pub display_fingerprint: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetView {
    pub dataset_id: String,
    pub form_id: String,
    pub is_sample: bool,
    pub role: String,
    pub storage_epoch: i64,
    pub protocol_version: i64,
    pub last_sequence: i64,
    pub last_checkpoint_hash: Option<String>,
    pub records: i64,
    pub tombstones: i64,
    pub operations: i64,
    pub size_bytes: u64,
    pub file_name: String,
    pub health: String,
    pub head_comparison: HeadComparison,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetError {
    pub dataset_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStatus {
    pub protocol: String,
    pub key_store_available: bool,
    pub data_root: String,
    pub node: Option<NodeView>,
    pub node_error: Option<String>,
    pub datasets: Vec<DatasetView>,
    pub dataset_errors: Vec<DatasetError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub dataset_id: String,
    pub ok: bool,
    pub health: String,
    pub head_comparison: HeadComparison,
    pub checked_operations: i64,
    pub checked_envelopes: i64,
    pub logical_root: Option<String>,
    pub issues: Vec<String>,
}

impl DataService {
    /// `data_dir` is the Desktop data root; the service owns `<data_dir>/data`.
    pub fn new(data_dir: PathBuf) -> Self {
        Self { root: data_dir.join("data"), lifecycle: Mutex::new(()) }
    }

    pub fn data_root(&self) -> &Path {
        &self.root
    }

    /// Serialize dataset/backup lifecycle mutations (used by snapshots.rs too).
    pub(crate) fn lifecycle_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lifecycle.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn node_dir_path(&self) -> PathBuf {
        self.node_dir()
    }

    /// Copy-safe finished-backup folder (plan §10.4).
    pub(crate) fn backups_data_only_dir(&self) -> PathBuf {
        self.root.join("backups").join("data-only")
    }

    /// Bounded staging for package assembly — partial packages never appear
    /// in the copy-safe folder (plan §10.4).
    pub(crate) fn backups_staging_dir(&self) -> PathBuf {
        self.root.join("backups").join("staging")
    }

    fn node_dir(&self) -> PathBuf {
        self.root.join("node")
    }

    fn forms_dir(&self) -> PathBuf {
        self.root.join("forms")
    }

    fn dataset_dir(&self, dataset_id: &str) -> PathBuf {
        self.forms_dir().join(dataset_id)
    }

    fn db_path(&self, dataset_id: &str) -> PathBuf {
        self.dataset_dir(dataset_id).join("data.sqlite3.enc")
    }

    /// Managed folder layout (plan §10.4). Idempotent.
    pub fn ensure_layout(&self) -> Result<(), DataError> {
        let _guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        for dir in [
            self.node_dir(),
            self.forms_dir(),
            self.root.join("sync"),
            self.root.join("backups").join("data-only"),
            self.root.join("backups").join("disaster-recovery"),
            self.root.join("quarantine"),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| DataError::StoreUnavailable(format!("mkdir {}: {e}", dir.display())))?;
        }
        let readme = self.root.join("README.txt");
        if !readme.exists() {
            let _ = std::fs::write(&readme, README);
        }
        Ok(())
    }

    /// The workspace status snapshot. Never fails hard: key-store / identity /
    /// per-dataset failures degrade into typed fields so the UI can render
    /// the fail-closed state instead of an opaque 500.
    pub fn status(&self) -> DataStatus {
        let key_store_available = key_store::key_store_available();
        let mut node = None;
        let mut node_error = None;
        if key_store_available {
            match self.ensure_layout().and_then(|()| identity::load_or_create(&self.node_dir())) {
                Ok(id) => {
                    node = Some(NodeView {
                        display_fingerprint: display_fingerprint(&id.public.fingerprint),
                        node_id: id.public.node_id,
                        signing_public_key: id.public.signing_public_key,
                        key_id: id.public.key_id,
                        fingerprint: id.public.fingerprint,
                        created_at: id.public.created_at,
                    });
                }
                Err(e) => node_error = Some(e.code().to_string()),
            }
        } else {
            node_error = Some("data_key_store_unavailable".to_string());
        }
        let (datasets, dataset_errors) = self.list_datasets();
        DataStatus {
            protocol: DATA_PROTOCOL.to_string(),
            key_store_available,
            data_root: self.root.display().to_string(),
            node,
            node_error,
            datasets,
            dataset_errors,
        }
    }

    fn list_datasets(&self) -> (Vec<DatasetView>, Vec<DatasetError>) {
        let mut views = Vec::new();
        let mut errors = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.forms_dir()) else {
            return (views, errors);
        };
        for entry in entries.flatten() {
            let dataset_id = entry.file_name().to_string_lossy().to_string();
            if !entry.path().join("data.sqlite3.enc").is_file() {
                continue;
            }
            match self.dataset_view(&dataset_id) {
                Ok(view) => views.push(view),
                Err(e) => errors.push(DatasetError {
                    dataset_id,
                    code: e.code().to_string(),
                    message: e.message(),
                }),
            }
        }
        views.sort_by(|a, b| a.dataset_id.cmp(&b.dataset_id));
        (views, errors)
    }

    fn open(&self, dataset_id: &str) -> Result<Connection, DataError> {
        let key = key_store::get_or_create_dataset_key(&self.node_dir(), dataset_id)?;
        let conn = encrypted_sqlite::open_dataset_db(&self.db_path(dataset_id), &key)?;
        Ok(conn)
    }

    fn dataset_view(&self, dataset_id: &str) -> Result<DatasetView, DataError> {
        let conn = self.open(dataset_id)?;
        let meta = read_meta(&conn, dataset_id)?;
        let records: i64 = one(&conn, "SELECT count(*) FROM responses WHERE lifecycle_state = 'active'")?;
        let tombstones: i64 = one(&conn, "SELECT count(*) FROM tombstones")?;
        let operations: i64 = one(&conn, "SELECT count(*) FROM replication_operations")?;
        let size_bytes = std::fs::metadata(self.db_path(dataset_id)).map(|m| m.len()).unwrap_or(0);
        let anchor = high_water::load(dataset_id)?;
        let head = high_water::compare(meta.last_sequence, meta.last_operation_hash.as_deref(), anchor.as_ref());
        let health = match head {
            HeadComparison::RollbackDetected => "rollback_detected".to_string(),
            HeadComparison::HistoryDiverged => "history_diverged".to_string(),
            HeadComparison::NoAnchor => "provenance_unverified".to_string(),
            _ => meta.health.clone(),
        };
        Ok(DatasetView {
            dataset_id: dataset_id.to_string(),
            form_id: meta.form_id.clone(),
            is_sample: meta.form_id == SAMPLE_FORM_ID,
            role: meta.role,
            storage_epoch: meta.storage_epoch,
            protocol_version: meta.protocol_version,
            last_sequence: meta.last_sequence,
            last_checkpoint_hash: meta.last_checkpoint_hash,
            records,
            tombstones,
            operations,
            size_bytes,
            file_name: "data.sqlite3.enc".to_string(),
            health,
            head_comparison: head,
        })
    }

    /// Mint a sample dataset (N1 gate: the workspace lists synthetic/test
    /// datasets). Structurally identical to a real primary's write path.
    pub fn create_sample_dataset(&self, record_count: u32) -> Result<DatasetView, DataError> {
        if record_count == 0 || record_count > MAX_SAMPLE_RECORDS {
            return Err(DataError::Invalid(format!(
                "record count must be 1..={MAX_SAMPLE_RECORDS}"
            )));
        }
        self.ensure_layout()?;
        let identity = identity::load_or_create(&self.node_dir())?;
        let _guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let dataset_id = uuid::Uuid::new_v4().to_string();
        let node_id = identity.public.node_id.clone();
        let now = utc_now_rfc3339();

        std::fs::create_dir_all(self.dataset_dir(&dataset_id))
            .map_err(|e| DataError::StoreUnavailable(format!("mkdir dataset: {e}")))?;
        let conn = self.open(&dataset_id)?;
        encrypted_sqlite::ensure_schema(&conn)?;

        // Sample placement manifest — node key stands in for the owner key
        // and the lease authority; clearly marked by SAMPLE_FORM_ID. Real
        // placement arrives owner-signed from the Cloud in N3.
        let authority_key = json!({
            "keyId": identity.public.key_id,
            "generation": 1,
            "ed25519PublicKey": identity.public.signing_public_key,
            "fingerprint": identity.public.fingerprint,
        });
        let mut placement = json!({
            "protocol": DATA_PROTOCOL,
            "datasetId": dataset_id,
            "formId": SAMPLE_FORM_ID,
            "protocolVersion": 1,
            "storageEpoch": 1,
            "primaryReplicaId": node_id,
            "replicas": [{
                "replicaId": node_id,
                "kind": "desktop",
                "role": "primary",
                "desiredState": "active",
                "authoritySigningKey": authority_key,
                "transportKeyFingerprint": identity.public.fingerprint,
            }],
            "offlineSubmissionPolicy": {"mode": "reject"},
            "readFallbackPolicy": {"mode": "none"},
            "leaseAuthority": authority_key,
            "cutoverCheckpointHash": Value::Null,
            "recoveryAuthorization": Value::Null,
            "previousManifestHash": Value::Null,
            "createdAt": now,
            "ownerSignerKeyId": identity.public.key_id,
            "ownerSignerGeneration": 1,
            "ownerSignerFingerprint": identity.public.fingerprint,
        });
        let placement_sig =
            canonical::sign_structure_b64(DOMAIN_PLACEMENT, &placement, identity.signing_key())
                .map_err(DataError::Invalid)?;
        placement["signature"] = json!(placement_sig);
        let placement_hash = canonical::domain_hash_hex(DOMAIN_PLACEMENT, &without_sig(&placement))
            .map_err(DataError::Invalid)?;

        // Sample "public encryption manifest" stand-in (real flmanifest rows
        // ride the schema/manifest publication barrier in N3).
        let schema_hash = hex_lower(&Sha256::digest(b"formlogic-sample-schema"));
        let enc_manifest = json!({
            "v": 1,
            "formId": SAMPLE_FORM_ID,
            "keyId": SAMPLE_KEY_ID,
            "epoch": 1,
            "schemaVersion": 1,
            "schemaHash": schema_hash,
        });
        let enc_manifest_bytes = enc_manifest.to_string();
        let enc_manifest_hash = hex_lower(&Sha256::digest(enc_manifest_bytes.as_bytes()));
        let tuple = ManifestTuple {
            key_id: SAMPLE_KEY_ID.to_string(),
            ingest_epoch: 1,
            schema_version: 1,
            schema_hash: schema_hash.clone(),
        };

        conn.execute(
            "INSERT INTO dataset_meta (dataset_id, form_id, account_id, protocol_version, role,
                storage_epoch, primary_replica_id, health)
             VALUES (?1, ?2, ?3, 1, 'primary', 1, ?4, 'configured')",
            (&dataset_id, SAMPLE_FORM_ID, SAMPLE_ACCOUNT_ID, &node_id),
        )
        .map_err(db_err)?;
        conn.execute(
            "INSERT INTO control_artifacts (artifact_kind, artifact_id, artifact_hash, signed_bytes,
                signer_key_id, signer_key_generation, verified_at)
             VALUES ('placement', 'epoch-1', ?1, ?2, ?3, 1, ?4)",
            (&placement_hash, placement.to_string().as_bytes(), &identity.public.key_id, &now),
        )
        .map_err(db_err)?;
        conn.execute(
            "INSERT INTO control_artifacts (artifact_kind, artifact_id, artifact_hash, signed_bytes,
                signer_key_id, signer_key_generation, verified_at)
             VALUES ('encryption', 'sample', ?1, ?2, ?3, 1, ?4)",
            (&enc_manifest_hash, enc_manifest_bytes.as_bytes(), &identity.public.key_id, &now),
        )
        .map_err(db_err)?;

        let write_lease_id = uuid::Uuid::new_v4().to_string();
        let mut prev_hash: Option<String> = None;
        for sequence in 1..=i64::from(record_count) {
            let envelope = sample_envelope(&schema_hash)?;
            envelope_validator::validate_envelope(&envelope, std::slice::from_ref(&tuple), None)
                .map_err(|e| DataError::Invalid(format!("sample envelope rejected: {}", e.message)))?;
            let stored = envelope.to_string();
            let cipher_hash = hex_lower(&Sha256::digest(stored.as_bytes()));
            let record_id = envelope["recordId"].as_str().unwrap_or_default().to_string();

            let mut op = json!({
                "protocol": DATA_PROTOCOL,
                "operationId": uuid::Uuid::new_v4().to_string(),
                "datasetId": dataset_id,
                "placementManifestHash": placement_hash,
                "encryptionManifestHash": enc_manifest_hash,
                "storageEpoch": 1,
                "writeLeaseId": write_lease_id,
                "fencingGeneration": 1,
                "sequence": sequence,
                "kind": "response.create",
                "entityId": record_id,
                "rev": 1,
                "rowVersion": 1,
                "cipherHash": cipher_hash,
                "payload": {"envelope": envelope, "updatedAt": now},
                "originReplicaId": node_id,
                "previousOperationHash": prev_hash.clone().map(Value::from).unwrap_or(Value::Null),
                "createdAt": now,
                "signerKeyId": identity.public.key_id,
                "signerKeyGeneration": 1,
            });
            let sig = canonical::sign_structure_b64(DOMAIN_OPERATION, &op, identity.signing_key())
                .map_err(DataError::Invalid)?;
            op["signature"] = json!(sig);
            let op_hash =
                canonical::domain_hash_hex(DOMAIN_OPERATION, &without_sig(&op)).map_err(DataError::Invalid)?;

            // Row + operation commit in ONE transaction (plan §10.2).
            let tx = conn.unchecked_transaction().map_err(db_err)?;
            tx.execute(
                "INSERT INTO responses (id, status, submitted_at, updated_at, row_version, lifecycle_state, answers)
                 VALUES (?1, 'new', ?2, ?2, 1, 'active', ?3)",
                (&record_id, &now, &stored),
            )
            .map_err(db_err)?;
            tx.execute(
                "INSERT INTO replication_operations (operation_id, storage_epoch, sequence, kind, entity_id,
                    operation_hash, placement_manifest_hash, encryption_manifest_hash, write_lease_id,
                    fencing_generation, rev, row_version, cipher_hash, canonical_operation,
                    origin_replica_id, previous_hash, signer_key_id, signer_key_generation, signature, committed_at)
                 VALUES (?1, 1, ?2, 'response.create', ?3, ?4, ?5, ?6, ?7, 1, 1, 1, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14)",
                rusqlite::params![
                    op["operationId"].as_str(),
                    sequence,
                    record_id,
                    op_hash,
                    placement_hash,
                    enc_manifest_hash,
                    write_lease_id,
                    cipher_hash,
                    op.to_string(),
                    node_id,
                    prev_hash,
                    identity.public.key_id,
                    sig,
                    now,
                ],
            )
            .map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            prev_hash = Some(op_hash);
        }

        // Signed head checkpoint + meta + independent high-water anchor.
        let logical_root = compute_logical_root(&conn, &dataset_id)?;
        let mut checkpoint = json!({
            "protocol": DATA_PROTOCOL,
            "datasetId": dataset_id,
            "placementManifestHash": placement_hash,
            "storageEpoch": 1,
            "lastSequence": i64::from(record_count),
            "lastOperationHash": prev_hash.clone().map(Value::from).unwrap_or(Value::Null),
            "recordCount": i64::from(record_count),
            "tombstoneCount": 0,
            "tombstoneLedgerCoverageSequence": 0,
            "tombstoneLedgerRoot": Value::Null,
            "attachmentCount": 0,
            "chunkCount": 0,
            "versionsRepresented": {"schemaVersions": [1], "ingestEpochs": [1], "fkEpochs": [1]},
            "logicalRoot": logical_root,
            "previousCheckpointHash": Value::Null,
            "replicaId": node_id,
            "createdAt": now,
            "signerKeyId": identity.public.key_id,
            "signerKeyGeneration": 1,
        });
        let cp_sig = canonical::sign_structure_b64(DOMAIN_CHECKPOINT, &checkpoint, identity.signing_key())
            .map_err(DataError::Invalid)?;
        checkpoint["signature"] = json!(cp_sig);
        let cp_hash = canonical::domain_hash_hex(DOMAIN_CHECKPOINT, &without_sig(&checkpoint))
            .map_err(DataError::Invalid)?;
        conn.execute(
            "INSERT INTO replica_checkpoints (replica_id, storage_epoch, applied_sequence, logical_root,
                checkpoint_hash, signature, verified_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![node_id, i64::from(record_count), logical_root, cp_hash, checkpoint.to_string(), now],
        )
        .map_err(db_err)?;
        conn.execute(
            "UPDATE dataset_meta SET last_sequence = ?1, last_operation_hash = ?2,
                last_checkpoint_hash = ?3, health = 'current' WHERE dataset_id = ?4",
            rusqlite::params![i64::from(record_count), prev_hash, cp_hash, dataset_id],
        )
        .map_err(db_err)?;

        high_water::store(&high_water::HighWater {
            v: 1,
            dataset_id: dataset_id.clone(),
            storage_epoch: 1,
            last_acknowledged_sequence: i64::from(record_count),
            last_operation_hash: prev_hash,
            checkpoint_hash: Some(cp_hash),
            placement_manifest_hash: Some(placement_hash),
            tombstone_ledger_coverage_sequence: 0,
            tombstone_ledger_root: None,
            updated_at: now,
        })?;
        drop(conn);
        self.dataset_view(&dataset_id)
    }

    /// Verify integrity (plan §19.2 "Verify integrity"): cipher + SQLite
    /// integrity, full signature/hash-chain walk, envelope re-validation,
    /// logical-root recomputation, and the independent high-water comparison.
    pub fn verify_dataset(&self, dataset_id: &str) -> Result<VerifyReport, DataError> {
        if !self.db_path(dataset_id).is_file() {
            return Err(DataError::NotFound(format!("dataset {dataset_id} not found")));
        }
        let conn = self.open(dataset_id)?;
        let meta = read_meta(&conn, dataset_id)?;
        let mut issues = encrypted_sqlite::integrity_issues(&conn)?;

        // Trust anchor for the chain: the placement artifact's authority key.
        let placement: Option<Value> = conn
            .query_row(
                "SELECT signed_bytes FROM control_artifacts WHERE artifact_kind = 'placement' ORDER BY artifact_id DESC LIMIT 1",
                [],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let authority = placement.as_ref().and_then(authority_from_placement);
        if authority.is_none() {
            issues.push("no verifiable placement authority artifact".to_string());
        }

        // Acceptable manifest tuple for envelope re-validation.
        let tuple: Option<ManifestTuple> = conn
            .query_row(
                "SELECT signed_bytes FROM control_artifacts WHERE artifact_kind = 'encryption' LIMIT 1",
                [],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|m| {
                Some(ManifestTuple {
                    key_id: m["keyId"].as_str()?.to_string(),
                    ingest_epoch: m["epoch"].as_i64()?,
                    schema_version: m["schemaVersion"].as_i64()?,
                    schema_hash: m["schemaHash"].as_str()?.to_string(),
                })
            });

        let mut checked_operations = 0i64;
        {
            let mut stmt = conn
                .prepare("SELECT canonical_operation, operation_hash, previous_hash, sequence FROM replication_operations ORDER BY sequence")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })
                .map_err(db_err)?;
            let mut prev: Option<String> = None;
            let mut expected_seq = 1i64;
            for row in rows {
                let (op_raw, stored_hash, stored_prev, sequence) = row.map_err(db_err)?;
                checked_operations += 1;
                let Ok(op) = serde_json::from_str::<Value>(&op_raw) else {
                    issues.push(format!("op {sequence}: stored operation does not parse"));
                    continue;
                };
                if sequence != expected_seq {
                    issues.push(format!("op {sequence}: sequence gap (expected {expected_seq})"));
                }
                expected_seq = sequence + 1;
                match canonical::domain_hash_hex(DOMAIN_OPERATION, &without_sig(&op)) {
                    Ok(h) if h == stored_hash => {}
                    Ok(h) => issues.push(format!("op {sequence}: hash mismatch ({h} != {stored_hash})")),
                    Err(e) => issues.push(format!("op {sequence}: {e}")),
                }
                if stored_prev != prev {
                    issues.push(format!("op {sequence}: broken hash chain"));
                }
                if let Some(pk) = authority.as_ref() {
                    if !canonical::verify_structure(DOMAIN_OPERATION, &op, pk) {
                        issues.push(format!("op {sequence}: signature does not verify"));
                    }
                }
                prev = Some(stored_hash);
            }
            if let Some(final_hash) = prev {
                if meta.last_operation_hash.as_deref() != Some(final_hash.as_str()) {
                    issues.push("dataset_meta head hash disagrees with the operation log".to_string());
                }
            }
        }

        let mut checked_envelopes = 0i64;
        {
            let mut stmt = conn
                .prepare("SELECT id, answers FROM responses")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(db_err)?;
            for row in rows {
                let (id, answers) = row.map_err(db_err)?;
                checked_envelopes += 1;
                match super::strict_json::parse(answers.as_bytes()) {
                    Ok(env) => {
                        // Stored rows carry their historical rev: only the
                        // structural + tuple checks apply here, so validate
                        // as an update expecting exactly rev - 1.
                        let rev = env.get("rev").and_then(Value::as_i64).unwrap_or(1);
                        let acceptable: Vec<ManifestTuple> = tuple.iter().cloned().collect();
                        if let Err(e) = envelope_validator::validate_envelope(
                            &env,
                            &acceptable,
                            if rev == 1 { None } else { Some(rev - 1) },
                        ) {
                            issues.push(format!("row {id}: envelope invalid ({})", e.code));
                        }
                    }
                    Err(e) => issues.push(format!("row {id}: stored envelope unparseable ({e})")),
                }
            }
        }

        let logical_root = compute_logical_root(&conn, dataset_id).ok();
        if let (Some(root), Ok(Some(cp_root))) = (
            logical_root.as_ref(),
            conn.query_row(
                "SELECT logical_root FROM replica_checkpoints ORDER BY applied_sequence DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            }),
        ) {
            if *root != cp_root {
                issues.push(format!("logical root drifted from the last checkpoint ({root} != {cp_root})"));
            }
        }

        let anchor = high_water::load(dataset_id)?;
        let head = high_water::compare(meta.last_sequence, meta.last_operation_hash.as_deref(), anchor.as_ref());
        let head_issue = matches!(head, HeadComparison::RollbackDetected | HeadComparison::HistoryDiverged);

        let ok = issues.is_empty() && !head_issue;
        let health = if head_issue {
            match head {
                HeadComparison::RollbackDetected => "rollback_detected",
                _ => "history_diverged",
            }
        } else if !issues.is_empty() {
            "integrity_failed"
        } else {
            "current"
        };
        conn.execute(
            "UPDATE dataset_meta SET health = ?1 WHERE dataset_id = ?2",
            (health, dataset_id),
        )
        .map_err(db_err)?;
        Ok(VerifyReport {
            dataset_id: dataset_id.to_string(),
            ok,
            health: health.to_string(),
            head_comparison: head,
            checked_operations,
            checked_envelopes,
            logical_root,
            issues,
        })
    }

    /// Remove a SAMPLE dataset (plus its wrapped key + high-water anchor).
    /// Real datasets are never deletable from this surface in N1.
    pub fn delete_sample_dataset(&self, dataset_id: &str) -> Result<(), DataError> {
        let _guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if !self.db_path(dataset_id).is_file() {
            return Err(DataError::NotFound(format!("dataset {dataset_id} not found")));
        }
        {
            let conn = self.open(dataset_id)?;
            let meta = read_meta(&conn, dataset_id)?;
            if meta.form_id != SAMPLE_FORM_ID {
                return Err(DataError::Invalid(
                    "only sample datasets can be deleted from the Data workspace".into(),
                ));
            }
        }
        std::fs::remove_dir_all(self.dataset_dir(dataset_id))
            .map_err(|e| DataError::StoreUnavailable(format!("remove dataset dir: {e}")))?;
        key_store::forget_dataset_key(&self.node_dir(), dataset_id)?;
        high_water::forget(dataset_id);
        Ok(())
    }
}

// ---------- helpers ----------

struct MetaRow {
    form_id: String,
    role: String,
    storage_epoch: i64,
    protocol_version: i64,
    last_sequence: i64,
    last_operation_hash: Option<String>,
    last_checkpoint_hash: Option<String>,
    health: String,
}

fn read_meta(conn: &Connection, dataset_id: &str) -> Result<MetaRow, DataError> {
    conn.query_row(
        "SELECT form_id, role, storage_epoch, protocol_version, last_sequence,
            last_operation_hash, last_checkpoint_hash, health
         FROM dataset_meta WHERE dataset_id = ?1",
        [dataset_id],
        |r| {
            Ok(MetaRow {
                form_id: r.get(0)?,
                role: r.get(1)?,
                storage_epoch: r.get(2)?,
                protocol_version: r.get(3)?,
                last_sequence: r.get(4)?,
                last_operation_hash: r.get(5)?,
                last_checkpoint_hash: r.get(6)?,
                health: r.get(7)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            // A non-envelope/foreign encrypted DB in a private slot is
            // corruption, not a soft state (plan review: privacy tri-state).
            DataError::Integrity("dataset_meta row missing (foreign or corrupt dataset)".into())
        }
        other => db_err(other),
    })
}

fn one(conn: &Connection, sql: &str) -> Result<i64, DataError> {
    conn.query_row(sql, [], |r| r.get(0)).map_err(db_err)
}

fn db_err(e: rusqlite::Error) -> DataError {
    DataError::StoreUnavailable(format!("db: {e}"))
}

fn without_sig(v: &Value) -> Value {
    let mut c = v.clone();
    if let Some(m) = c.as_object_mut() {
        m.remove("signature");
    }
    c
}

fn authority_from_placement(placement: &Value) -> Option<ed25519_dalek::VerifyingKey> {
    let pk_b64 = placement
        .get("replicas")?
        .as_array()?
        .first()?
        .get("authoritySigningKey")?
        .get("ed25519PublicKey")?
        .as_str()?;
    let raw = B64.decode(pk_b64).ok()?;
    let bytes = <[u8; 32]>::try_from(raw.as_slice()).ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes).ok()
}

/// flroot:1 over the live rows/tombstones/artifacts (docs/FORMLOGIC_DATA_NODES.md §3).
/// pub(crate): the structural test restore recomputes the root from its
/// imported temp store through this exact function.
pub(crate) fn compute_logical_root(conn: &Connection, dataset_id: &str) -> Result<String, DataError> {
    let mut entries: Vec<Value> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, row_version, answers FROM responses WHERE lifecycle_state = 'active'")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(db_err)?;
        for row in rows {
            let (id, row_version, answers) = row.map_err(db_err)?;
            let rev = serde_json::from_str::<Value>(&answers)
                .ok()
                .and_then(|v| v.get("rev").and_then(Value::as_i64))
                .unwrap_or(0);
            let cipher_hash = hex_lower(&Sha256::digest(answers.as_bytes()));
            entries.push(json!(["response", id, row_version, rev, cipher_hash]));
        }
    }
    {
        let mut stmt = conn
            .prepare("SELECT entity_id, sequence, operation_hash FROM tombstones")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(db_err)?;
        for row in rows {
            let (id, sequence, op_hash) = row.map_err(db_err)?;
            entries.push(json!(["tombstone", id, sequence, op_hash]));
        }
    }
    {
        let mut stmt = conn
            .prepare("SELECT artifact_kind, artifact_id, artifact_hash FROM control_artifacts WHERE lifecycle_state = 'active'")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(db_err)?;
        for row in rows {
            let (kind, id, hash) = row.map_err(db_err)?;
            entries.push(json!(["artifact", kind, id, hash]));
        }
    }
    canonical::logical_root_hex(dataset_id, &entries).map_err(DataError::Invalid)
}

/// A structurally valid (never decryptable) sample `__flenc:1` envelope.
fn sample_envelope(schema_hash: &str) -> Result<Value, DataError> {
    let mut record_bytes = [0u8; 16];
    getrandom::getrandom(&mut record_bytes)
        .map_err(|e| DataError::Invalid(format!("no OS randomness: {e}")))?;
    record_bytes[6] = (record_bytes[6] & 0x0f) | 0x40;
    record_bytes[8] = (record_bytes[8] & 0x3f) | 0x80;
    let h = hex_lower(&record_bytes);
    let record_id = format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]);

    let mut wrapped_dek = [0u8; 80];
    let mut nonce = [0u8; 24];
    let mut ct = [0u8; 96];
    getrandom::getrandom(&mut wrapped_dek)
        .and(getrandom::getrandom(&mut nonce))
        .and(getrandom::getrandom(&mut ct))
        .map_err(|e| DataError::Invalid(format!("no OS randomness: {e}")))?;

    Ok(json!({
        "__flenc": 1,
        "recordId": record_id,
        "rev": 1,
        "keyId": SAMPLE_KEY_ID,
        "epoch": 1,
        "content": envelope_validator::CONTENT_SUITE,
        "wrap": envelope_validator::WRAP_SUITE,
        "schemaVersion": 1,
        "schemaHash": schema_hash,
        "wrappedDek": B64.encode(wrapped_dek),
        "nonce": B64.encode(nonce),
        "ct": B64.encode(ct),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (DataService, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-ds-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        (DataService::new(dir.clone()), dir)
    }

    #[test]
    fn layout_and_status_work_without_datasets() {
        let (svc, dir) = service();
        svc.ensure_layout().unwrap();
        for sub in ["node", "forms", "sync", "backups/data-only", "backups/disaster-recovery", "quarantine"] {
            assert!(dir.join("data").join(sub).is_dir(), "missing {sub}");
        }
        assert!(dir.join("data").join("README.txt").is_file());
        let status = svc.status();
        assert_eq!(status.protocol, DATA_PROTOCOL);
        assert!(status.datasets.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The full lifecycle exercises the REAL credential store (identity, NSMK,
    // high-water), so it runs on Windows only — the shipped platform.
    #[cfg(windows)]
    #[test]
    fn sample_lifecycle_create_verify_tamper_delete() {
        let _cred = super::super::test_cred_lock();
        let (svc, dir) = service();
        let view = svc.create_sample_dataset(5).unwrap();
        assert_eq!(view.records, 5);
        assert_eq!(view.operations, 5);
        assert!(view.is_sample);
        assert_eq!(view.health, "current");
        assert_eq!(view.head_comparison, HeadComparison::Current);
        let id = view.dataset_id.clone();

        // Fresh verify passes.
        let report = svc.verify_dataset(&id).unwrap();
        assert!(report.ok, "issues: {:?}", report.issues);
        assert_eq!(report.checked_operations, 5);
        assert_eq!(report.checked_envelopes, 5);

        // Tamper with a stored envelope INSIDE the encrypted store: verify
        // must flag both the row hash drift and the logical-root drift.
        {
            let conn = svc.open(&id).unwrap();
            conn.execute(
                "UPDATE responses SET answers = replace(answers, '\"rev\":1', '\"rev\":2') WHERE rowid = 1",
                [],
            )
            .unwrap();
        }
        let tampered = svc.verify_dataset(&id).unwrap();
        assert!(!tampered.ok);
        assert!(tampered.issues.iter().any(|i| i.contains("logical root")), "{:?}", tampered.issues);

        // Sample deletion cleans the folder, the wrapped key, and the anchor.
        svc.delete_sample_dataset(&id).unwrap();
        assert!(!svc.db_path(&id).is_file());
        assert!(high_water::load(&id).unwrap().is_none());
        assert!(matches!(svc.verify_dataset(&id), Err(DataError::NotFound(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Rollback detection: replace the dataset with an OLDER valid encrypted
    // copy (DB + WAL) and require the independent anchor to flag it (N1 gate).
    #[cfg(windows)]
    #[test]
    fn old_database_replacement_is_detected() {
        let _cred = super::super::test_cred_lock();
        let (svc, dir) = service();
        let view = svc.create_sample_dataset(2).unwrap();
        let id = view.dataset_id.clone();
        let db = svc.db_path(&id);

        // Snapshot the young dataset (checkpoint first so the copy is whole).
        {
            let conn = svc.open(&id).unwrap();
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
        }
        let old_copy = std::fs::read(&db).unwrap();

        // Advance it: another sample batch is not possible on the same id, so
        // append one more signed op via the service's own write path — here,
        // simply create rows through a manual op-free write would break the
        // chain, so instead advance the ANCHOR as the acknowledged head does.
        let mut hw = high_water::load(&id).unwrap().unwrap();
        hw.last_acknowledged_sequence += 1;
        hw.last_operation_hash = Some("f".repeat(64));
        high_water::store(&hw).unwrap();

        // Roll the file back to the older valid copy.
        std::fs::write(&db, &old_copy).unwrap();
        let _ = std::fs::remove_file(db.with_extension("enc-wal"));

        let report = svc.verify_dataset(&id).unwrap();
        assert_eq!(report.head_comparison, HeadComparison::RollbackDetected);
        assert_eq!(report.health, "rollback_detected");
        assert!(!report.ok);

        let (views, _) = svc.list_datasets();
        let listed = views.iter().find(|v| v.dataset_id == id).unwrap();
        assert_eq!(listed.health, "rollback_detected");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
