//! N2 — Cloud-primary Desktop snapshots (plan §18, §27-N2;
//! docs/FORMLOGIC_DATA_NODES.md §9).
//!
//! Pulls a signed logical package of one Private form from the Cloud, verifies
//! EVERYTHING independently (signature against the TOFU-pinned Cloud signer,
//! per-file hashes, per-response cipherHash + strict envelope validation,
//! flroot:1 recompute), and only then assembles the copy-safe
//! `<backupId>.flbackup` (a ZIP of the plan §18.4 layout) under
//! `data/backups/data-only/` via staging + fsync + rename.
//!
//! Provenance model (plan §18.5): the Cloud signer is pinned on first use over
//! the AUTHENTICATED desktop API channel and refused on change (fail closed).
//! Until N3 placement binds that key under the owner's vault signature, every
//! entry is labelled `cloud_signed_tofu` — integrity checked, owner chain
//! pending — never "authenticated".
//!
//! The Structural Test Restore (plan §18.7) never touches live data: it
//! re-verifies the package byte-for-byte, imports into a THROWAWAY encrypted
//! store under a random in-memory key, and requires the imported store to
//! recompute the manifest's exact logical root.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;

use super::canonical::{self, hex_lower, DOMAIN_BACKUP};
use super::envelope_validator::{self, ManifestTuple};
use super::store::{compute_logical_root, DataService};
use super::{atomic_write_json, encrypted_sqlite, utc_now_rfc3339, DataError};
use crate::formlogic_client::FormLogicClient;

const CLOUD_SIGNER_FILE: &str = "cloud-signer.json";
const CATALOG_FILE: &str = "backup-catalog.json";
const MANIFEST_ENTRY: &str = "manifests/backup-manifest.json";
/// Mirror of the Cloud-side cap; a package beyond it never verified anyway.
const MAX_PACKAGE_BYTES: usize = 268_435_456;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSignerPin {
    pub v: u32,
    pub public_key: String,
    pub key_id: String,
    pub fingerprint: String,
    pub pinned_at: String,
}

fn default_kind() -> String {
    "form".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalogEntry {
    /// `form` (Private-form snapshot, .flbackup) or `account` (whole-account
    /// sealed backup, .flaccount).
    #[serde(default = "default_kind")]
    pub kind: String,
    pub backup_id: String,
    pub form_id: String,
    pub dataset_id: String,
    pub form_title: String,
    pub created_at: String,
    pub bytes: u64,
    pub file_name: String,
    pub responses: i64,
    pub source: String,
    /// `cloud_signed_tofu` until the N3 owner chain exists (plan §18.5).
    pub provenance: String,
    pub last_test_ok: Option<bool>,
    pub last_test_at: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CatalogFileShape {
    v: u32,
    backups: Vec<BackupCatalogEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRestoreReport {
    pub backup_id: String,
    pub ok: bool,
    pub provenance: String,
    pub responses: i64,
    pub artifacts: i64,
    pub logical_root: Option<String>,
    pub issues: Vec<String>,
}

// ── catalog ─────────────────────────────────────────────────────────────────

fn read_catalog(svc: &DataService) -> CatalogFileShape {
    std::fs::read_to_string(svc.node_dir_path().join(CATALOG_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(CatalogFileShape { v: 1, backups: Vec::new() })
}

fn write_catalog(svc: &DataService, catalog: &CatalogFileShape) -> Result<(), DataError> {
    atomic_write_json(&svc.node_dir_path().join(CATALOG_FILE), catalog)
}

pub fn catalog(svc: &DataService) -> Vec<BackupCatalogEntry> {
    read_catalog(svc).backups
}

pub fn delete_backup(svc: &DataService, backup_id: &str) -> Result<(), DataError> {
    let _guard = svc.lifecycle_guard();
    let mut cat = read_catalog(svc);
    let Some(pos) = cat.backups.iter().position(|b| b.backup_id == backup_id) else {
        return Err(DataError::NotFound(format!("backup {backup_id} not found")));
    };
    let entry = cat.backups.remove(pos);
    let dir = if entry.kind == "account" {
        svc.backups_account_dir()
    } else {
        svc.backups_data_only_dir()
    };
    let path = dir.join(&entry.file_name);
    if path.is_file() {
        std::fs::remove_file(&path)
            .map_err(|e| DataError::StoreUnavailable(format!("remove backup: {e}")))?;
    }
    if entry.kind == "account" {
        // Its NSMK-wrapped at-rest key is now useless — drop the wrap.
        super::key_store::forget_dataset_key(&svc.node_dir_path(), &format!("acct-{backup_id}"))?;
    }
    write_catalog(svc, &cat)
}

/// Insert-or-replace a catalog entry (shared with the account-backup lane).
pub(crate) fn catalog_upsert(svc: &DataService, entry: BackupCatalogEntry) -> Result<(), DataError> {
    let _guard = svc.lifecycle_guard();
    let mut cat = read_catalog(svc);
    cat.backups.retain(|b| b.backup_id != entry.backup_id);
    cat.backups.push(entry);
    cat.backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    cat.v = 1;
    write_catalog(svc, &cat)
}

/// Record a test outcome on a catalog entry (shared with the account lane).
pub(crate) fn catalog_record_test(svc: &DataService, backup_id: &str, ok: bool) -> Result<(), DataError> {
    let _guard = svc.lifecycle_guard();
    let mut cat = read_catalog(svc);
    if let Some(e) = cat.backups.iter_mut().find(|b| b.backup_id == backup_id) {
        e.last_test_ok = Some(ok);
        e.last_test_at = Some(utc_now_rfc3339());
    }
    write_catalog(svc, &cat)
}

// ── cloud signer pin (TOFU over the authenticated channel; fail closed) ─────

pub fn pinned_signer(svc: &DataService) -> Option<CloudSignerPin> {
    std::fs::read_to_string(svc.node_dir_path().join(CLOUD_SIGNER_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

pub(crate) fn pin_or_verify_signer(svc: &DataService, identity: &Value) -> Result<CloudSignerPin, DataError> {
    let public_key = identity.get("publicKey").and_then(Value::as_str).unwrap_or("");
    let key_id = identity.get("keyId").and_then(Value::as_str).unwrap_or("");
    let fingerprint = identity.get("fingerprint").and_then(Value::as_str).unwrap_or("");
    if public_key.is_empty() || key_id.len() != 16 || fingerprint.len() != 64 {
        return Err(DataError::Invalid("cloud signing identity is malformed".into()));
    }
    // The served identity must be self-consistent, not just well-shaped.
    let raw = B64
        .decode(public_key)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
        .ok_or_else(|| DataError::Invalid("cloud signing key is not a 32-byte Ed25519 key".into()))?;
    let derived_fp = hex_lower(&Sha256::digest(raw));
    if derived_fp != fingerprint || !derived_fp.starts_with(key_id) {
        return Err(DataError::Integrity("cloud signing identity is internally inconsistent".into()));
    }
    if let Some(existing) = pinned_signer(svc) {
        if existing.public_key != public_key {
            // A silently rotated Cloud signer is exactly what pinning exists to
            // catch — refuse until the user re-pairs deliberately (plan §6).
            return Err(DataError::Integrity(
                "the Cloud snapshot signing key CHANGED since it was pinned — refusing (cloud_signer_changed)".into(),
            ));
        }
        return Ok(existing);
    }
    let pin = CloudSignerPin {
        v: 1,
        public_key: public_key.to_string(),
        key_id: key_id.to_string(),
        fingerprint: fingerprint.to_string(),
        pinned_at: utc_now_rfc3339(),
    };
    atomic_write_json(&svc.node_dir_path().join(CLOUD_SIGNER_FILE), &pin)?;
    Ok(pin)
}

pub(crate) fn pinned_verifying_key(pin: &CloudSignerPin) -> Result<ed25519_dalek::VerifyingKey, DataError> {
    let raw = B64
        .decode(&pin.public_key)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
        .ok_or_else(|| DataError::Integrity("pinned cloud signer is malformed".into()))?;
    ed25519_dalek::VerifyingKey::from_bytes(&raw)
        .map_err(|_| DataError::Integrity("pinned cloud signer is not a valid Ed25519 key".into()))
}

// ── package verification (shared by pull + test restore) ────────────────────

struct PackageSummary {
    responses: i64,
    artifacts: i64,
    logical_root: String,
}

/// Verify a package's CONTENT against its (already signature-checked)
/// manifest: file hashes, per-response cipherHash + strict envelope
/// validation against the packaged manifest tuples, and the flroot:1 root.
fn verify_package_contents(
    manifest: &Value,
    files: &HashMap<String, Vec<u8>>,
    issues: &mut Vec<String>,
) -> Result<PackageSummary, DataError> {
    let dataset_id = manifest
        .pointer("/datasets/0/datasetId")
        .and_then(Value::as_str)
        .ok_or_else(|| DataError::Invalid("manifest names no dataset".into()))?;

    let listed = manifest.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    for f in &listed {
        let path = f.get("path").and_then(Value::as_str).unwrap_or("");
        let want_sha = f.get("sha256").and_then(Value::as_str).unwrap_or("");
        let want_bytes = f.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        match files.get(path) {
            None => issues.push(format!("{path}: listed in the manifest but missing")),
            Some(bytes) => {
                if hex_lower(&Sha256::digest(bytes)) != want_sha {
                    issues.push(format!("{path}: content hash mismatch"));
                }
                if bytes.len() as u64 != want_bytes {
                    issues.push(format!("{path}: size mismatch"));
                }
            }
        }
    }
    let listed_paths: Vec<&str> = listed.iter().filter_map(|f| f.get("path").and_then(Value::as_str)).collect();
    for path in files.keys() {
        if path != MANIFEST_ENTRY && !listed_paths.contains(&path.as_str()) {
            issues.push(format!("{path}: present but not listed in the manifest"));
        }
    }

    // Acceptable manifest tuples from the packaged control artifacts.
    let empty = Vec::new();
    let control = files.get("data/control.ndjson").map(|b| b.as_slice()).unwrap_or(&empty);
    let mut tuples: Vec<ManifestTuple> = Vec::new();
    let mut entries: Vec<Value> = Vec::new();
    let mut artifacts = 0i64;
    for line in split_ndjson(control) {
        artifacts += 1;
        let parsed = match super::strict_json::parse(line) {
            Ok(v) => v,
            Err(e) => {
                issues.push(format!("control artifact does not parse strictly: {e}"));
                continue;
            }
        };
        let kind = parsed.get("kind").and_then(Value::as_str).unwrap_or("");
        let id = parsed.get("id").and_then(Value::as_str).unwrap_or("");
        if kind.is_empty() || id.is_empty() {
            issues.push("control artifact lacks kind/id".to_string());
            continue;
        }
        if kind == "manifest" {
            if let (Some(key_id), Some(epoch), Some(sv), Some(sh)) = (
                parsed.get("keyId").and_then(Value::as_str),
                parsed.get("ingestEpoch").and_then(Value::as_i64),
                parsed.get("schemaVersion").and_then(Value::as_i64),
                parsed.get("schemaHash").and_then(Value::as_str),
            ) {
                tuples.push(ManifestTuple {
                    key_id: key_id.to_string(),
                    ingest_epoch: epoch,
                    schema_version: sv,
                    schema_hash: sh.to_string(),
                });
            } else {
                issues.push(format!("manifest artifact {id} lacks its acceptance tuple"));
            }
        }
        entries.push(serde_json::json!([
            "artifact",
            kind,
            id,
            hex_lower(&Sha256::digest(line))
        ]));
    }

    let responses_file = files
        .get("data/responses.ndjson.enc")
        .map(|b| b.as_slice())
        .unwrap_or(&empty);
    let mut responses = 0i64;
    for line in split_ndjson(responses_file) {
        responses += 1;
        let row = match super::strict_json::parse(line) {
            Ok(v) => v,
            Err(e) => {
                issues.push(format!("response row does not parse strictly: {e}"));
                continue;
            }
        };
        let id = row.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
        let answers_raw = row.get("answersRaw").and_then(Value::as_str).unwrap_or("");
        let cipher_hash = row.get("cipherHash").and_then(Value::as_str).unwrap_or("");
        let row_version = row.get("rowVersion").and_then(Value::as_i64).unwrap_or(0);
        let rev = row.get("rev").and_then(Value::as_i64).unwrap_or(0);
        if hex_lower(&Sha256::digest(answers_raw.as_bytes())) != cipher_hash {
            issues.push(format!("row {id}: cipherHash does not match answersRaw"));
        }
        match super::strict_json::parse(answers_raw.as_bytes()) {
            Ok(env) => {
                let env_rev = env.get("rev").and_then(Value::as_i64).unwrap_or(1);
                let expected = if env_rev <= 1 { None } else { Some(env_rev - 1) };
                if let Err(e) = envelope_validator::validate_envelope(&env, &tuples, expected) {
                    issues.push(format!("row {id}: envelope invalid ({})", e.code));
                }
            }
            Err(e) => issues.push(format!("row {id}: envelope does not parse strictly: {e}")),
        }
        entries.push(serde_json::json!(["response", id, row_version, rev, cipher_hash]));
    }

    let want_responses = manifest.pointer("/counts/responses").and_then(Value::as_i64).unwrap_or(-1);
    if want_responses != responses {
        issues.push(format!("manifest counts {want_responses} responses, package has {responses}"));
    }
    let logical_root = canonical::logical_root_hex(dataset_id, &entries).map_err(DataError::Invalid)?;
    let want_root = manifest.get("logicalRoot").and_then(Value::as_str).unwrap_or("");
    if logical_root != want_root {
        issues.push("logical root does not match the manifest".to_string());
    }
    Ok(PackageSummary { responses, artifacts, logical_root })
}

fn split_ndjson(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty())
}

// ── pull ────────────────────────────────────────────────────────────────────

/// Pull + verify + persist one Cloud snapshot as a `.flbackup`.
pub async fn pull_cloud_snapshot(
    svc: &DataService,
    client: &FormLogicClient,
    form_id: &str,
    form_title: &str,
) -> Result<BackupCatalogEntry, DataError> {
    svc.ensure_layout()?;
    let identity = client
        .data_signing_key()
        .await
        .map_err(|e| DataError::StoreUnavailable(format!("cloud signing key: {e:?}")))?;
    let pin = pin_or_verify_signer(svc, identity.get("data").unwrap_or(&Value::Null))?;
    let verifying = pinned_verifying_key(&pin)?;

    let created = client
        .data_snapshot_create(form_id)
        .await
        .map_err(|e| DataError::StoreUnavailable(format!("snapshot create: {e:?}")))?;
    let data = created.get("data").cloned().unwrap_or(Value::Null);
    let snapshot_id = data.get("snapshotId").and_then(Value::as_str).unwrap_or("").to_string();
    let backup_id = data.get("backupId").and_then(Value::as_str).unwrap_or("").to_string();
    if snapshot_id.is_empty() || backup_id.is_empty() {
        return Err(DataError::Invalid("cloud returned no snapshot id".into()));
    }

    let result = pull_verified(svc, client, &verifying, &snapshot_id, &backup_id, form_id, form_title).await;
    // Staged Cloud copies are temporary either way (TTL sweeps as backstop).
    let _ = client.data_snapshot_delete(&snapshot_id).await;
    result
}

async fn pull_verified(
    svc: &DataService,
    client: &FormLogicClient,
    verifying: &ed25519_dalek::VerifyingKey,
    snapshot_id: &str,
    backup_id: &str,
    form_id: &str,
    form_title: &str,
) -> Result<BackupCatalogEntry, DataError> {
    // The manifest travels as its EXACT staged file so the .flbackup carries
    // byte-identical content to what was hashed/signed server-side.
    let manifest_bytes = client
        .data_snapshot_file(snapshot_id, MANIFEST_ENTRY)
        .await
        .map_err(|e| DataError::StoreUnavailable(format!("manifest download: {e:?}")))?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| DataError::Invalid("backup manifest does not parse".into()))?;
    if !canonical::verify_structure(DOMAIN_BACKUP, &manifest, verifying) {
        return Err(DataError::Integrity(
            "backup manifest signature does not verify against the pinned Cloud signer".into(),
        ));
    }
    if manifest.get("backupType").and_then(Value::as_str) != Some("data_only")
        || manifest.pointer("/datasets/0/formId").and_then(Value::as_str) != Some(form_id)
        || manifest.get("backupId").and_then(Value::as_str) != Some(backup_id)
    {
        return Err(DataError::Integrity("backup manifest does not describe this snapshot".into()));
    }

    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    files.insert(MANIFEST_ENTRY.to_string(), manifest_bytes);
    let mut total = 0usize;
    for f in manifest.get("files").and_then(Value::as_array).cloned().unwrap_or_default() {
        let path = f.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        if path.is_empty() || path.contains("..") {
            return Err(DataError::Integrity("manifest lists an unsafe path".into()));
        }
        let bytes = client
            .data_snapshot_file(snapshot_id, &path)
            .await
            .map_err(|e| DataError::StoreUnavailable(format!("{path}: {e:?}")))?;
        total += bytes.len();
        if total > MAX_PACKAGE_BYTES {
            return Err(DataError::Invalid("package exceeds the N2 size cap".into()));
        }
        files.insert(path, bytes);
    }

    let mut issues = Vec::new();
    let summary = verify_package_contents(&manifest, &files, &mut issues)?;
    if !issues.is_empty() {
        return Err(DataError::Integrity(format!(
            "package verification failed: {}",
            issues.join("; ")
        )));
    }

    // Assemble the copy-safe single file: staging → fsync → rename.
    let staging_dir = svc.backups_staging_dir();
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| DataError::StoreUnavailable(format!("staging: {e}")))?;
    let file_name = format!("{backup_id}.flbackup");
    let staged = staging_dir.join(&file_name);
    write_flbackup_zip(&staged, &files)?;
    let finished = svc.backups_data_only_dir().join(&file_name);
    std::fs::rename(&staged, &finished)
        .map_err(|e| DataError::StoreUnavailable(format!("finalize backup: {e}")))?;
    let bytes = std::fs::metadata(&finished).map(|m| m.len()).unwrap_or(0);

    let entry = BackupCatalogEntry {
        kind: "form".to_string(),
        backup_id: backup_id.to_string(),
        form_id: form_id.to_string(),
        dataset_id: form_id.to_string(),
        form_title: form_title.to_string(),
        created_at: manifest
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or(&utc_now_rfc3339())
            .to_string(),
        bytes,
        file_name,
        responses: summary.responses,
        source: "cloud".to_string(),
        provenance: "cloud_signed_tofu".to_string(),
        last_test_ok: None,
        last_test_at: None,
    };
    catalog_upsert(svc, entry.clone())?;
    Ok(entry)
}

fn write_flbackup_zip(path: &PathBuf, files: &HashMap<String, Vec<u8>>) -> Result<(), DataError> {
    let file = std::fs::File::create(path)
        .map_err(|e| DataError::StoreUnavailable(format!("create staging zip: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut names: Vec<&String> = files.keys().collect();
    names.sort();
    for name in names {
        zip.start_file(name.as_str(), options)
            .map_err(|e| DataError::StoreUnavailable(format!("zip entry {name}: {e}")))?;
        zip.write_all(&files[name])
            .map_err(|e| DataError::StoreUnavailable(format!("zip write {name}: {e}")))?;
    }
    let file = zip
        .finish()
        .map_err(|e| DataError::StoreUnavailable(format!("zip finish: {e}")))?;
    file.sync_all()
        .map_err(|e| DataError::StoreUnavailable(format!("zip fsync: {e}")))?;
    Ok(())
}

// ── structural test restore (plan §18.7) ────────────────────────────────────

pub fn structural_test_restore(svc: &DataService, backup_id: &str) -> Result<TestRestoreReport, DataError> {
    let entry = read_catalog(svc)
        .backups
        .into_iter()
        .find(|b| b.backup_id == backup_id)
        .ok_or_else(|| DataError::NotFound(format!("backup {backup_id} not found")))?;
    let path = svc.backups_data_only_dir().join(&entry.file_name);
    let files = read_flbackup_zip(&path)?;

    let mut issues = Vec::new();
    let manifest_bytes = files
        .get(MANIFEST_ENTRY)
        .ok_or_else(|| DataError::Integrity("package has no backup manifest".into()))?;
    let manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|_| DataError::Integrity("backup manifest does not parse".into()))?;

    // Signature against the pinned signer; a missing pin degrades to the
    // honest "provenance unverified" state, never to silent trust.
    let provenance = match pinned_signer(svc) {
        Some(pin) => {
            let key = pinned_verifying_key(&pin)?;
            if canonical::verify_structure(DOMAIN_BACKUP, &manifest, &key) {
                "cloud_signed_tofu".to_string()
            } else {
                issues.push("manifest signature does not verify against the pinned Cloud signer".into());
                "signature_invalid".to_string()
            }
        }
        None => "provenance_unverified".to_string(),
    };

    let summary = verify_package_contents(&manifest, &files, &mut issues)?;

    // Import into a THROWAWAY encrypted store (random in-memory key, fresh
    // temp dir) and require the imported store to recompute the exact root.
    let temp_dir = svc
        .backups_staging_dir()
        .join(format!("test-restore-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| DataError::StoreUnavailable(format!("test-restore staging: {e}")))?;
    let restore_result = (|| -> Result<(), DataError> {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key)
            .map_err(|e| DataError::StoreUnavailable(format!("no OS randomness: {e}")))?;
        let dataset_id = manifest
            .pointer("/datasets/0/datasetId")
            .and_then(Value::as_str)
            .unwrap_or("dataset");
        let conn = encrypted_sqlite::open_dataset_db(&temp_dir.join("restore.sqlite3.enc"), &key)?;
        encrypted_sqlite::ensure_schema(&conn)?;
        let empty = Vec::new();
        for line in split_ndjson(files.get("data/responses.ndjson.enc").map(|b| b.as_slice()).unwrap_or(&empty)) {
            let row: Value = serde_json::from_slice(line)
                .map_err(|_| DataError::Integrity("response row does not parse".into()))?;
            conn.execute(
                "INSERT INTO responses (id, status, submitted_at, updated_at, row_version, lifecycle_state, trashed_at, answers)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    row.get("id").and_then(Value::as_str),
                    row.get("status").and_then(Value::as_str),
                    row.get("submittedAt").and_then(Value::as_str),
                    row.get("updatedAt").and_then(Value::as_str),
                    row.get("rowVersion").and_then(Value::as_i64),
                    row.get("lifecycleState").and_then(Value::as_str),
                    row.get("trashedAt").and_then(Value::as_str),
                    row.get("answersRaw").and_then(Value::as_str),
                ],
            )
            .map_err(|e| DataError::StoreUnavailable(format!("restore insert: {e}")))?;
        }
        for line in split_ndjson(files.get("data/control.ndjson").map(|b| b.as_slice()).unwrap_or(&empty)) {
            let artifact: Value = serde_json::from_slice(line)
                .map_err(|_| DataError::Integrity("control artifact does not parse".into()))?;
            conn.execute(
                "INSERT INTO control_artifacts (artifact_kind, artifact_id, artifact_hash, signed_bytes, signer_key_id, signer_key_generation)
                 VALUES (?1, ?2, ?3, ?4, 'package', 1)",
                rusqlite::params![
                    artifact.get("kind").and_then(Value::as_str),
                    artifact.get("id").and_then(Value::as_str),
                    hex_lower(&Sha256::digest(line)),
                    line,
                ],
            )
            .map_err(|e| DataError::StoreUnavailable(format!("restore artifact: {e}")))?;
        }
        for issue in encrypted_sqlite::integrity_issues(&conn)? {
            issues.push(format!("restored store: {issue}"));
        }
        let restored_root = compute_logical_root(&conn, dataset_id)?;
        if Some(restored_root.as_str()) != manifest.get("logicalRoot").and_then(Value::as_str) {
            issues.push("restored store recomputes a different logical root".to_string());
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&temp_dir);
    restore_result?;

    let ok = issues.is_empty() && provenance == "cloud_signed_tofu";
    let report = TestRestoreReport {
        backup_id: backup_id.to_string(),
        ok,
        provenance,
        responses: summary.responses,
        artifacts: summary.artifacts,
        logical_root: Some(summary.logical_root),
        issues,
    };
    catalog_record_test(svc, backup_id, report.ok)?;
    Ok(report)
}

fn read_flbackup_zip(path: &std::path::Path) -> Result<HashMap<String, Vec<u8>>, DataError> {
    let file = std::fs::File::open(path)
        .map_err(|e| DataError::NotFound(format!("backup file missing: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| DataError::Integrity(format!("backup is not a readable package: {e}")))?;
    let mut files = HashMap::new();
    let mut total = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| DataError::Integrity(format!("package entry: {e}")))?;
        let name = entry.name().to_string();
        if name.contains("..") || name.starts_with('/') {
            return Err(DataError::Integrity("package contains an unsafe path".into()));
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| DataError::Integrity(format!("package read: {e}")))?;
        total += bytes.len();
        if total > MAX_PACKAGE_BYTES {
            return Err(DataError::Invalid("package exceeds the N2 size cap".into()));
        }
        files.insert(name, bytes);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn service() -> (DataService, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-snap-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let svc = DataService::new(dir.clone());
        svc.ensure_layout().unwrap();
        (svc, dir)
    }

    /// Build a valid in-memory package the way the PHP service does, signed by
    /// a test key, and return (files, manifest, signing key).
    fn build_package(svc: &DataService, rows: usize) -> (HashMap<String, Vec<u8>>, Value, SigningKey) {
        let sk = SigningKey::from_bytes(&[0x51u8; 32]);
        let pk = sk.verifying_key();
        // Pin the test signer as the cloud signer.
        let pin = CloudSignerPin {
            v: 1,
            public_key: B64.encode(pk.as_bytes()),
            key_id: canonical::data_key_id(&pk),
            fingerprint: canonical::data_key_fingerprint(&pk),
            pinned_at: "2026-07-22T00:00:00Z".into(),
        };
        atomic_write_json(&svc.node_dir_path().join(CLOUD_SIGNER_FILE), &pin).unwrap();

        let form_id = "11112222-3333-4333-8444-555566667777";
        let schema_hash = hex_lower(&Sha256::digest(b"pkg-schema"));
        let manifest_line = serde_json::to_string(&json!({
            "kind": "manifest", "id": "man_1", "keyId": "fik_pkg01", "ingestEpoch": 1,
            "schemaVersion": 1, "schemaHash": schema_hash,
        }))
        .unwrap();
        let control = format!("{manifest_line}\n");

        let mut entries: Vec<Value> = vec![json!([
            "artifact", "manifest", "man_1",
            hex_lower(&Sha256::digest(manifest_line.as_bytes()))
        ])];
        let mut response_lines = String::new();
        for i in 0..rows {
            let record_id = format!("7d44484{i}-9dc0-41a2-8da8-ff8cb9fca735");
            let env = json!({
                "__flenc": 1, "recordId": record_id, "rev": 1, "keyId": "fik_pkg01", "epoch": 1,
                "content": envelope_validator::CONTENT_SUITE, "wrap": envelope_validator::WRAP_SUITE,
                "schemaVersion": 1, "schemaHash": schema_hash,
                "wrappedDek": B64.encode([0x42u8; 80]), "nonce": B64.encode([0x43u8; 24]),
                "ct": B64.encode([0x44u8; 96]),
            });
            let answers_raw = env.to_string();
            let cipher_hash = hex_lower(&Sha256::digest(answers_raw.as_bytes()));
            let line = serde_json::to_string(&json!({
                "id": record_id, "status": "submitted", "submittedAt": "2026-07-22 00:00:00",
                "updatedAt": "2026-07-22 00:00:00", "rowVersion": 1, "lifecycleState": "active",
                "trashedAt": null, "rev": 1, "cipherHash": cipher_hash, "answersRaw": answers_raw,
            }))
            .unwrap();
            entries.push(json!(["response", record_id, 1, 1, cipher_hash]));
            response_lines.push_str(&line);
            response_lines.push('\n');
        }
        let logical_root = canonical::logical_root_hex(form_id, &entries).unwrap();

        let mut files: HashMap<String, Vec<u8>> = HashMap::new();
        files.insert("backup-index.json".into(), b"{\"v\":1}\n".to_vec());
        files.insert("manifests/checkpoint.json".into(), b"{}\n".to_vec());
        files.insert("data/responses.ndjson.enc".into(), response_lines.into_bytes());
        files.insert("data/control.ndjson".into(), control.into_bytes());
        files.insert("data/tombstones.ndjson".into(), Vec::new());
        files.insert("data/operations.ndjson".into(), Vec::new());

        let listed: Vec<Value> = [
            "backup-index.json",
            "manifests/checkpoint.json",
            "data/responses.ndjson.enc",
            "data/control.ndjson",
            "data/tombstones.ndjson",
            "data/operations.ndjson",
        ]
        .iter()
        .map(|p| {
            json!({
                "path": p,
                "sha256": hex_lower(&Sha256::digest(&files[*p])),
                "bytes": files[*p].len(),
            })
        })
        .collect();
        let mut manifest = json!({
            "protocol": "formlogic-data-sync/1", "formatVersion": 1, "backupType": "data_only",
            "backupId": "20260722T000000Z-test", "accountId": "u-test", "sourceReplicaId": "cloud",
            "datasets": [{"datasetId": form_id, "formId": form_id}],
            "createdAt": "2026-07-22T00:00:00Z", "storageEpoch": 0,
            "checkpointHash": hex_lower(&Sha256::digest(b"cp")), "lastSequence": 0,
            "lastOperationHash": null,
            "counts": {"responses": rows as i64, "tombstones": 0, "attachments": 0, "chunks": 0},
            "versionsRepresented": {"schemaVersions": [1], "ingestEpochs": [1], "fkEpochs": [1]},
            "files": listed, "logicalRoot": logical_root, "incrementalParent": null,
            "requiredRestoreCapabilities": ["formlogic-data-sync/1"],
            "signerKeyId": canonical::data_key_id(&pk), "signerKeyGeneration": 1,
            "authorityCertificateRef": null,
        });
        let sig = canonical::sign_structure_b64(DOMAIN_BACKUP, &manifest, &sk).unwrap();
        manifest["signature"] = json!(sig);
        files.insert(
            MANIFEST_ENTRY.into(),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        );
        (files, manifest, sk)
    }

    fn install_backup(svc: &DataService, files: &HashMap<String, Vec<u8>>, backup_id: &str, rows: i64) {
        let file_name = format!("{backup_id}.flbackup");
        write_flbackup_zip(&svc.backups_data_only_dir().join(&file_name), files).unwrap();
        let mut cat = read_catalog(svc);
        cat.v = 1;
        cat.backups.push(BackupCatalogEntry {
            kind: "form".into(),
            backup_id: backup_id.into(),
            form_id: "11112222-3333-4333-8444-555566667777".into(),
            dataset_id: "11112222-3333-4333-8444-555566667777".into(),
            form_title: "Test".into(),
            created_at: "2026-07-22T00:00:00Z".into(),
            bytes: 0,
            file_name,
            responses: rows,
            source: "cloud".into(),
            provenance: "cloud_signed_tofu".into(),
            last_test_ok: None,
            last_test_at: None,
        });
        write_catalog(svc, &cat).unwrap();
    }

    #[test]
    fn structural_test_restore_passes_a_clean_package() {
        let (svc, dir) = service();
        let (files, _, _) = build_package(&svc, 3);
        install_backup(&svc, &files, "bk-clean", 3);
        let report = structural_test_restore(&svc, "bk-clean").unwrap();
        assert!(report.ok, "issues: {:?}", report.issues);
        assert_eq!(report.responses, 3);
        assert_eq!(report.provenance, "cloud_signed_tofu");
        // The catalog remembers the outcome.
        assert_eq!(catalog(&svc)[0].last_test_ok, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_missing_and_extra_files_fail() {
        let (svc, dir) = service();
        // Tampered response byte.
        let (mut files, _, _) = build_package(&svc, 2);
        let resp = files.get_mut("data/responses.ndjson.enc").unwrap();
        let pos = resp.iter().position(|b| *b == b'4').unwrap();
        resp[pos] = b'5';
        install_backup(&svc, &files, "bk-tampered", 2);
        let report = structural_test_restore(&svc, "bk-tampered").unwrap();
        assert!(!report.ok);

        // Missing listed file.
        let (mut files, _, _) = build_package(&svc, 2);
        files.remove("data/control.ndjson");
        install_backup(&svc, &files, "bk-missing", 2);
        assert!(!structural_test_restore(&svc, "bk-missing").unwrap().ok);

        // Extra unlisted file.
        let (mut files, _, _) = build_package(&svc, 2);
        files.insert("data/smuggled.bin".into(), vec![1, 2, 3]);
        install_backup(&svc, &files, "bk-extra", 2);
        assert!(!structural_test_restore(&svc, "bk-extra").unwrap().ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signer_substitution_does_not_authenticate() {
        let (svc, dir) = service();
        let (mut files, mut manifest, _) = build_package(&svc, 1);
        // An attacker re-signs the manifest with THEIR key and swaps the
        // embedded signer id — the pinned signer must still win (N2 gate:
        // "self-contained signer-key substitution does not authenticate").
        let attacker = SigningKey::from_bytes(&[0x66u8; 32]);
        manifest["signerKeyId"] = json!(canonical::data_key_id(&attacker.verifying_key()));
        let manifest_no_sig = {
            let mut m = manifest.clone();
            m.as_object_mut().unwrap().remove("signature");
            m
        };
        let sig = canonical::sign_structure_b64(DOMAIN_BACKUP, &manifest_no_sig, &attacker).unwrap();
        manifest["signature"] = json!(sig);
        files.insert(MANIFEST_ENTRY.into(), serde_json::to_vec_pretty(&manifest).unwrap());
        install_backup(&svc, &files, "bk-substituted", 1);
        let report = structural_test_restore(&svc, "bk-substituted").unwrap();
        assert!(!report.ok);
        assert_eq!(report.provenance, "signature_invalid");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_cloud_signer_is_refused() {
        let (svc, dir) = service();
        let (_, _, _) = build_package(&svc, 1); // pins 0x51 key
        let other = SigningKey::from_bytes(&[0x77u8; 32]).verifying_key();
        let identity = json!({
            "publicKey": B64.encode(other.as_bytes()),
            "keyId": canonical::data_key_id(&other),
            "fingerprint": canonical::data_key_fingerprint(&other),
        });
        let err = pin_or_verify_signer(&svc, &identity).unwrap_err();
        assert!(err.message().contains("cloud_signer_changed"), "{err}");
        // An internally inconsistent identity is refused too.
        let bogus = json!({
            "publicKey": B64.encode(other.as_bytes()),
            "keyId": "0000000000000000",
            "fingerprint": "0".repeat(64),
        });
        assert!(pin_or_verify_signer(&svc, &bogus).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_backup_removes_file_and_entry() {
        let (svc, dir) = service();
        let (files, _, _) = build_package(&svc, 1);
        install_backup(&svc, &files, "bk-del", 1);
        assert_eq!(catalog(&svc).len(), 1);
        delete_backup(&svc, "bk-del").unwrap();
        assert!(catalog(&svc).is_empty());
        assert!(!svc.backups_data_only_dir().join("bk-del.flbackup").is_file());
        assert!(matches!(delete_backup(&svc, "bk-del"), Err(DataError::NotFound(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
