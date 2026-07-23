//! Sealed whole-account backups pulled from the Cloud
//! (docs/FORMLOGIC_DATA_NODES.md §10).
//!
//! Unlike the Private-form snapshot lane, the archive CONTAINS PLAINTEXT form
//! data — the user explicitly wants a desktop-held copy of everything. So the
//! transfer is sealed end-to-end (this node mints a fresh ephemeral X25519
//! key per request; the Cloud encrypts the archive to it BEFORE the bytes
//! leave the service), and at rest the payload is immediately RE-encrypted
//! under an NSMK-wrapped per-backup key — decrypted zip bytes touch memory
//! only, never this disk. Recovery of the local copy therefore needs THIS
//! desktop's key store (the Cloud original stays the primary copy).
//!
//! Local `.flaccount` file = ZIP { local.json, payload.bin } where payload.bin
//! uses the same chunked XChaCha20-Poly1305 framing as the wire (4-byte BE
//! ciphertext length per chunk; nonce = 16-byte base || 64-bit BE index; AAD
//! `flaccount-local:1|<backupId>|<i>|<count>`).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use crypto_box::aead::Aead as BoxAead;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

use super::canonical::{self, hex_lower, DOMAIN_BACKUP};
use super::snapshots::{self, BackupCatalogEntry, TestRestoreReport};
use super::store::DataService;
use super::{key_store, utc_now_rfc3339, DataError};
use crate::formlogic_client::FormLogicClient;

const WIRE_AAD_PREFIX: &str = "flaccount:1";
const LOCAL_AAD_PREFIX: &str = "flaccount-local:1";
/// Deep zip validation happens in memory; beyond this we trust hash + AEAD.
const ZIP_VALIDATE_MAX_BYTES: u64 = 67_108_864; // 64 MiB
const MAX_ZIP_BYTES: u64 = 268_435_456; // mirror of the Cloud cap

struct WireHeader {
    backup_id: String,
    account_id: String,
    created_at: String,
    chunk_bytes: u64,
    chunk_count: u64,
    zip_bytes: u64,
    zip_sha256: String,
    base_nonce: [u8; 16],
    cloud_epk: [u8; 32],
    key_nonce: [u8; 24],
    wrapped_key: Vec<u8>,
    /// Signed content counts (responses/forms) for the catalog display.
    responses: i64,
    forms: i64,
}

fn parse_header(header: &Value) -> Result<WireHeader, DataError> {
    let bad = |m: &str| DataError::Integrity(format!("account-backup header: {m}"));
    if header.get("kind").and_then(Value::as_str) != Some("account-backup") {
        return Err(bad("wrong kind"));
    }
    let b64_exact = |field: &str, len: usize| -> Result<Vec<u8>, DataError> {
        let raw = B64
            .decode(header.get(field).and_then(Value::as_str).unwrap_or(""))
            .map_err(|_| bad(&format!("{field} is not base64")))?;
        if raw.len() != len {
            return Err(bad(&format!("{field} has the wrong length")));
        }
        Ok(raw)
    };
    let zip_bytes = header.get("zipBytes").and_then(Value::as_u64).unwrap_or(0);
    if zip_bytes == 0 || zip_bytes > MAX_ZIP_BYTES {
        return Err(bad("zipBytes out of range"));
    }
    Ok(WireHeader {
        backup_id: header.get("backupId").and_then(Value::as_str).unwrap_or("").to_string(),
        account_id: header.get("accountId").and_then(Value::as_str).unwrap_or("").to_string(),
        created_at: header.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string(),
        chunk_bytes: header.get("chunkBytes").and_then(Value::as_u64).unwrap_or(0),
        chunk_count: header.get("chunkCount").and_then(Value::as_u64).unwrap_or(0),
        zip_bytes,
        zip_sha256: header.get("zipSha256").and_then(Value::as_str).unwrap_or("").to_string(),
        base_nonce: b64_exact("baseNonce", 16)?.try_into().unwrap(),
        cloud_epk: b64_exact("cloudEphemeralPk", 32)?.try_into().unwrap(),
        key_nonce: b64_exact("keyNonce", 24)?.try_into().unwrap(),
        wrapped_key: b64_exact("wrappedKey", 48)?,
        responses: header.pointer("/counts/responses").and_then(Value::as_i64).unwrap_or(0),
        forms: header.pointer("/counts/forms").and_then(Value::as_i64).unwrap_or(0),
    })
}

fn chunk_nonce(base: &[u8; 16], index: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..16].copy_from_slice(base);
    nonce[16..].copy_from_slice(&index.to_be_bytes());
    nonce
}

/// Pull, verify, and locally re-seal a whole-account backup.
pub async fn pull_account_backup(
    svc: &DataService,
    client: &FormLogicClient,
) -> Result<BackupCatalogEntry, DataError> {
    svc.ensure_layout()?;
    std::fs::create_dir_all(svc.backups_account_dir())
        .map_err(|e| DataError::StoreUnavailable(format!("backups/account: {e}")))?;

    // Pin/verify the Cloud signer over the authenticated channel first.
    let identity = client
        .data_signing_key()
        .await
        .map_err(|e| DataError::StoreUnavailable(format!("cloud signing key: {e:?}")))?;
    let pin = snapshots::pin_or_verify_signer(svc, identity.get("data").unwrap_or(&Value::Null))?;
    let verifying = snapshots::pinned_verifying_key(&pin)?;

    // Fresh ephemeral X25519 pair; the secret never leaves this function.
    let mut esk_bytes = [0u8; 32];
    getrandom::getrandom(&mut esk_bytes)
        .map_err(|e| DataError::StoreUnavailable(format!("no OS randomness: {e}")))?;
    let esk = crypto_box::SecretKey::from(esk_bytes);
    let epk_b64 = B64.encode(esk.public_key().as_bytes());

    // Node-signed transfer-key challenge (review FL-001): prove the ephemeral
    // key is OURS with the enrolled node signing key, so the server never
    // seals an account export to an unbound key.
    let identity = super::identity::load_or_create(&svc.node_dir_path())?;
    let requested_at = super::utc_now_rfc3339();
    let challenge = format!("flaccountreq:1|{requested_at}|{epk_b64}");
    let signature = {
        use ed25519_dalek::Signer as _;
        identity.signing_key().sign(challenge.as_bytes())
    };

    let created = client
        .data_account_backup_create(&serde_json::json!({
            "ephemeralPk": epk_b64,
            "requestedAt": requested_at,
            "ephemeralPkSignature": B64.encode(signature.to_bytes()),
        }))
        .await
        .map_err(|e| DataError::StoreUnavailable(format!("account-backup create: {e:?}")))?;
    let header_value = created.pointer("/data/header").cloned().unwrap_or(Value::Null);
    if !canonical::verify_structure(DOMAIN_BACKUP, &header_value, &verifying) {
        return Err(DataError::Integrity(
            "account-backup header signature does not verify against the pinned Cloud signer".into(),
        ));
    }
    let header = parse_header(&header_value)?;
    if header.backup_id.is_empty() || header.chunk_count == 0 || header.chunk_bytes == 0 {
        return Err(DataError::Integrity("account-backup header is incomplete".into()));
    }

    // Stream the sealed payload to staging.
    let staging = svc.backups_staging_dir();
    std::fs::create_dir_all(&staging)
        .map_err(|e| DataError::StoreUnavailable(format!("staging: {e}")))?;
    let wire_path = staging.join(format!("{}.wire", header.backup_id));
    let result = pull_verified(svc, client, &header, &header_value, &esk, &wire_path).await;
    let _ = std::fs::remove_file(&wire_path);
    let _ = client.data_account_backup_delete(&header.backup_id).await;
    result
}

async fn pull_verified(
    svc: &DataService,
    client: &FormLogicClient,
    header: &WireHeader,
    signed_header: &Value,
    esk: &crypto_box::SecretKey,
    wire_path: &std::path::Path,
) -> Result<BackupCatalogEntry, DataError> {
    client
        .data_account_backup_payload_to_file(&header.backup_id, wire_path)
        .await
        .map_err(|e| DataError::StoreUnavailable(format!("payload download: {e:?}")))?;

    // Open the file key with our ephemeral secret.
    let cloud_pk = crypto_box::PublicKey::from(header.cloud_epk);
    let salsa = crypto_box::SalsaBox::new(&cloud_pk, esk);
    let file_key_raw = BoxAead::decrypt(
        &salsa,
        (&header.key_nonce).into(),
        header.wrapped_key.as_slice(),
    )
    .map_err(|_| DataError::Integrity("account-backup file key does not open (wrong ephemeral key or tamper)".into()))?;
    let file_key: [u8; 32] = file_key_raw
        .as_slice()
        .try_into()
        .map_err(|_| DataError::Integrity("account-backup file key has the wrong length".into()))?;
    let wire_cipher = XChaCha20Poly1305::new((&file_key).into());

    // Local at-rest key: NSMK-wrapped per backup (key_store reuses the exact
    // dataset-key wrap machinery under an "acct-…" id).
    let local_key = key_store::get_or_create_dataset_key(
        &svc.node_dir_path(),
        &format!("acct-{}", header.backup_id),
    )?;
    let local_cipher = XChaCha20Poly1305::new((&local_key).into());
    let mut local_base = [0u8; 16];
    getrandom::getrandom(&mut local_base)
        .map_err(|e| DataError::StoreUnavailable(format!("no OS randomness: {e}")))?;

    // Decrypt wire chunks → hash → re-encrypt locally, chunk by chunk; the
    // plaintext zip only ever exists in memory (whole copy kept only when
    // small enough for deep validation).
    let mut wire = std::fs::File::open(wire_path)
        .map_err(|e| DataError::StoreUnavailable(format!("open staged payload: {e}")))?;
    let mut local_payload: Vec<u8> = Vec::new();
    let mut sha = Sha256::new();
    let mut zip_in_memory: Option<Vec<u8>> =
        (header.zip_bytes <= ZIP_VALIDATE_MAX_BYTES).then(Vec::new);
    let mut total_plain = 0u64;
    for i in 0..header.chunk_count {
        let mut len_buf = [0u8; 4];
        wire.read_exact(&mut len_buf)
            .map_err(|_| DataError::Integrity("sealed payload is truncated".into()))?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len < 16 || len > header.chunk_bytes as usize + 16 {
            return Err(DataError::Integrity("sealed payload has an invalid chunk length".into()));
        }
        let mut ct = vec![0u8; len];
        wire.read_exact(&mut ct)
            .map_err(|_| DataError::Integrity("sealed payload is truncated".into()))?;
        let aad = format!(
            "{WIRE_AAD_PREFIX}|{}|{}|{}",
            header.backup_id, i, header.chunk_count
        );
        let pt = wire_cipher
            .decrypt(
                XNonce::from_slice(&chunk_nonce(&header.base_nonce, i)),
                Payload { msg: &ct, aad: aad.as_bytes() },
            )
            .map_err(|_| DataError::Integrity(format!("sealed chunk {i} does not open")))?;
        sha.update(&pt);
        total_plain += pt.len() as u64;
        if let Some(buf) = zip_in_memory.as_mut() {
            buf.extend_from_slice(&pt);
        }
        let local_aad = format!(
            "{LOCAL_AAD_PREFIX}|{}|{}|{}",
            header.backup_id, i, header.chunk_count
        );
        let re_ct = local_cipher
            .encrypt(
                XNonce::from_slice(&chunk_nonce(&local_base, i)),
                Payload { msg: &pt, aad: local_aad.as_bytes() },
            )
            .map_err(|_| DataError::StoreUnavailable("local re-encryption failed".into()))?;
        local_payload.extend_from_slice(&(re_ct.len() as u32).to_be_bytes());
        local_payload.extend_from_slice(&re_ct);
    }
    let mut trailing = [0u8; 1];
    if wire.read(&mut trailing).unwrap_or(0) != 0 {
        return Err(DataError::Integrity("sealed payload has trailing bytes".into()));
    }
    if total_plain != header.zip_bytes {
        return Err(DataError::Integrity("account backup size does not match its header".into()));
    }
    if hex_lower(&sha.finalize()) != header.zip_sha256 {
        return Err(DataError::Integrity("account backup hash does not match its header".into()));
    }
    if let Some(zip_bytes) = zip_in_memory {
        validate_zip(&zip_bytes)?;
    }

    // Assemble the copy-safe .flaccount (staging → fsync → rename). The
    // ORIGINAL signed wire header rides along verbatim so provenance can be
    // re-checked against the pinned signer at any later Test.
    let local_json = json!({
        "v": 1,
        "backupId": header.backup_id,
        "accountId": header.account_id,
        "createdAt": header.created_at,
        "chunkBytes": header.chunk_bytes,
        "chunkCount": header.chunk_count,
        "zipBytes": header.zip_bytes,
        "zipSha256": header.zip_sha256,
        "baseNonce": B64.encode(local_base),
        "cloudHeader": signed_header.clone(),
    });

    let file_name = format!("{}.flaccount", header.backup_id);
    let staged = svc.backups_staging_dir().join(&file_name);
    {
        let file = std::fs::File::create(&staged)
            .map_err(|e| DataError::StoreUnavailable(format!("create staging: {e}")))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("local.json", options)
            .and_then(|()| {
                zip.write_all(serde_json::to_string_pretty(&local_json).unwrap_or_default().as_bytes())
                    .map_err(zip::result::ZipError::Io)
            })
            .and_then(|()| zip.start_file("payload.bin", options))
            .and_then(|()| zip.write_all(&local_payload).map_err(zip::result::ZipError::Io))
            .map_err(|e| DataError::StoreUnavailable(format!("assemble .flaccount: {e}")))?;
        let file = zip
            .finish()
            .map_err(|e| DataError::StoreUnavailable(format!("finish .flaccount: {e}")))?;
        file.sync_all()
            .map_err(|e| DataError::StoreUnavailable(format!("fsync .flaccount: {e}")))?;
    }
    let finished = svc.backups_account_dir().join(&file_name);
    std::fs::rename(&staged, &finished)
        .map_err(|e| DataError::StoreUnavailable(format!("finalize .flaccount: {e}")))?;
    let bytes = std::fs::metadata(&finished).map(|m| m.len()).unwrap_or(0);

    let entry = BackupCatalogEntry {
        kind: "account".to_string(),
        backup_id: header.backup_id.clone(),
        form_id: String::new(),
        dataset_id: String::new(),
        form_title: "Whole account".to_string(),
        created_at: if header.created_at.is_empty() { utc_now_rfc3339() } else { header.created_at.clone() },
        bytes,
        file_name,
        responses: header.responses,
        forms: Some(header.forms),
        source: "cloud".to_string(),
        provenance: "cloud_signed_tofu".to_string(),
        last_test_ok: None,
        last_test_at: None,
    };
    snapshots::catalog_upsert(svc, entry.clone())?;
    Ok(entry)
}

fn validate_zip(bytes: &[u8]) -> Result<(), DataError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| DataError::Integrity(format!("account backup is not a readable archive: {e}")))?;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| DataError::Integrity(format!("archive entry: {e}")))?;
        if entry.name() == "backup.json" {
            return Ok(());
        }
    }
    Err(DataError::Integrity("account backup archive has no backup.json".into()))
}

/// Verify a stored `.flaccount`: local decryptability, hash, structure, and
/// the original Cloud signature (provenance).
pub fn test_account_backup(svc: &DataService, backup_id: &str) -> Result<TestRestoreReport, DataError> {
    let entry = snapshots::catalog(svc)
        .into_iter()
        .find(|b| b.backup_id == backup_id && b.kind == "account")
        .ok_or_else(|| DataError::NotFound(format!("account backup {backup_id} not found")))?;
    let path = svc.backups_account_dir().join(&entry.file_name);
    let file = std::fs::File::open(&path)
        .map_err(|e| DataError::NotFound(format!("backup file missing: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| DataError::Integrity(format!(".flaccount is not readable: {e}")))?;

    let mut issues: Vec<String> = Vec::new();
    let local_json: Value = {
        let mut entry_file = archive
            .by_name("local.json")
            .map_err(|_| DataError::Integrity(".flaccount has no local.json".into()))?;
        let mut raw = String::new();
        entry_file
            .read_to_string(&mut raw)
            .map_err(|e| DataError::Integrity(format!("local.json: {e}")))?;
        serde_json::from_str(&raw).map_err(|_| DataError::Integrity("local.json does not parse".into()))?
    };
    let chunk_count = local_json.get("chunkCount").and_then(Value::as_u64).unwrap_or(0);
    let zip_bytes = local_json.get("zipBytes").and_then(Value::as_u64).unwrap_or(0);
    let zip_sha = local_json.get("zipSha256").and_then(Value::as_str).unwrap_or("");
    let base_nonce: [u8; 16] = B64
        .decode(local_json.get("baseNonce").and_then(Value::as_str).unwrap_or(""))
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| DataError::Integrity("local.json baseNonce is malformed".into()))?;

    // Provenance: the stored ORIGINAL header must still verify.
    let provenance = match snapshots::pinned_signer(svc) {
        Some(pin) => {
            let key = snapshots::pinned_verifying_key(&pin)?;
            let cloud_header = local_json.get("cloudHeader").cloned().unwrap_or(Value::Null);
            if canonical::verify_structure(DOMAIN_BACKUP, &cloud_header, &key) {
                "cloud_signed_tofu".to_string()
            } else {
                issues.push("stored Cloud header signature does not verify against the pinned signer".into());
                "signature_invalid".to_string()
            }
        }
        None => "provenance_unverified".to_string(),
    };

    let local_key = key_store::get_or_create_dataset_key(&svc.node_dir_path(), &format!("acct-{backup_id}"))?;
    let cipher = XChaCha20Poly1305::new((&local_key).into());
    let mut payload = archive
        .by_name("payload.bin")
        .map_err(|_| DataError::Integrity(".flaccount has no payload.bin".into()))?;
    let mut sha = Sha256::new();
    let mut total = 0u64;
    let mut zip_buf: Option<Vec<u8>> = (zip_bytes <= ZIP_VALIDATE_MAX_BYTES).then(Vec::new);
    for i in 0..chunk_count {
        let mut len_buf = [0u8; 4];
        if payload.read_exact(&mut len_buf).is_err() {
            issues.push(format!("payload truncated before chunk {i}"));
            break;
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut ct = vec![0u8; len];
        if payload.read_exact(&mut ct).is_err() {
            issues.push(format!("payload truncated inside chunk {i}"));
            break;
        }
        let aad = format!("{LOCAL_AAD_PREFIX}|{backup_id}|{i}|{chunk_count}");
        match cipher.decrypt(
            XNonce::from_slice(&chunk_nonce(&base_nonce, i)),
            Payload { msg: &ct, aad: aad.as_bytes() },
        ) {
            Ok(pt) => {
                sha.update(&pt);
                total += pt.len() as u64;
                if let Some(buf) = zip_buf.as_mut() {
                    buf.extend_from_slice(&pt);
                }
            }
            Err(_) => issues.push(format!("chunk {i} does not open (tamper or wrong node key)")),
        }
    }
    if issues.is_empty() {
        if total != zip_bytes {
            issues.push("decrypted size does not match local.json".into());
        }
        if hex_lower(&sha.finalize()) != zip_sha {
            issues.push("decrypted hash does not match local.json".into());
        } else if let Some(buf) = zip_buf {
            if let Err(e) = validate_zip(&buf) {
                issues.push(e.message());
            }
        }
    }

    let ok = issues.is_empty() && provenance == "cloud_signed_tofu";
    let report = TestRestoreReport {
        backup_id: backup_id.to_string(),
        ok,
        provenance,
        responses: 0,
        artifacts: 0,
        logical_root: None,
        issues,
    };
    snapshots::catalog_record_test(svc, backup_id, report.ok)?;
    Ok(report)
}

/// USER-INVOKED export of a stored backup to the Downloads folder — the
/// "restore-ready" artifact. A `form` snapshot copies its .flbackup verbatim
/// (its content is E2EE envelopes). An `account` backup DECRYPTS to a plain
/// .zip: that is deliberate and explicit (the plan forbids only AUTOMATIC
/// plaintext export) — the zip is exactly what the web app's
/// Settings → Backup → Import restores.
pub fn export_backup(svc: &DataService, backup_id: &str) -> Result<std::path::PathBuf, DataError> {
    let entry = snapshots::catalog(svc)
        .into_iter()
        .find(|b| b.backup_id == backup_id)
        .ok_or_else(|| DataError::NotFound(format!("backup {backup_id} not found")))?;
    let downloads = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Downloads"))
        .ok()
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| svc.data_root().join("exports"));
    std::fs::create_dir_all(&downloads)
        .map_err(|e| DataError::StoreUnavailable(format!("export dir: {e}")))?;

    if entry.kind != "account" {
        let src = svc.backups_data_only_dir().join(&entry.file_name);
        let dest = downloads.join(&entry.file_name);
        std::fs::copy(&src, &dest)
            .map_err(|e| DataError::StoreUnavailable(format!("export copy: {e}")))?;
        return Ok(dest);
    }

    let path = svc.backups_account_dir().join(&entry.file_name);
    let file = std::fs::File::open(&path)
        .map_err(|e| DataError::NotFound(format!("backup file missing: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| DataError::Integrity(format!(".flaccount is not readable: {e}")))?;
    let local_json: Value = {
        let mut entry_file = archive
            .by_name("local.json")
            .map_err(|_| DataError::Integrity(".flaccount has no local.json".into()))?;
        let mut raw = String::new();
        entry_file
            .read_to_string(&mut raw)
            .map_err(|e| DataError::Integrity(format!("local.json: {e}")))?;
        serde_json::from_str(&raw).map_err(|_| DataError::Integrity("local.json does not parse".into()))?
    };
    let chunk_count = local_json.get("chunkCount").and_then(Value::as_u64).unwrap_or(0);
    let zip_sha = local_json.get("zipSha256").and_then(Value::as_str).unwrap_or("").to_string();
    let base_nonce: [u8; 16] = B64
        .decode(local_json.get("baseNonce").and_then(Value::as_str).unwrap_or(""))
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| DataError::Integrity("local.json baseNonce is malformed".into()))?;
    let local_key = key_store::get_or_create_dataset_key(&svc.node_dir_path(), &format!("acct-{backup_id}"))?;
    let cipher = XChaCha20Poly1305::new((&local_key).into());

    let stamp = entry.created_at.replace([':', 'T'], "-").replace('Z', "");
    let dest = downloads.join(format!("formlogic-account-backup-{stamp}.zip"));
    let mut out = std::fs::File::create(&dest)
        .map_err(|e| DataError::StoreUnavailable(format!("export create: {e}")))?;
    let mut payload = archive
        .by_name("payload.bin")
        .map_err(|_| DataError::Integrity(".flaccount has no payload.bin".into()))?;
    let result = (|| -> Result<(), DataError> {
        let mut sha = Sha256::new();
        for i in 0..chunk_count {
            let mut len_buf = [0u8; 4];
            payload
                .read_exact(&mut len_buf)
                .map_err(|_| DataError::Integrity("payload truncated".into()))?;
            let mut ct = vec![0u8; u32::from_be_bytes(len_buf) as usize];
            payload
                .read_exact(&mut ct)
                .map_err(|_| DataError::Integrity("payload truncated".into()))?;
            let aad = format!("{LOCAL_AAD_PREFIX}|{backup_id}|{i}|{chunk_count}");
            let pt = cipher
                .decrypt(
                    XNonce::from_slice(&chunk_nonce(&base_nonce, i)),
                    Payload { msg: &ct, aad: aad.as_bytes() },
                )
                .map_err(|_| DataError::Integrity(format!("chunk {i} does not open")))?;
            sha.update(&pt);
            out.write_all(&pt)
                .map_err(|e| DataError::StoreUnavailable(format!("export write: {e}")))?;
        }
        if hex_lower(&sha.finalize()) != zip_sha {
            return Err(DataError::Integrity("exported archive hash mismatch".into()));
        }
        out.flush().map_err(|e| DataError::StoreUnavailable(format!("export flush: {e}")))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&dest);
    }
    result.map(|()| dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_nonce_is_base_plus_be_index() {
        let base = [7u8; 16];
        let n = chunk_nonce(&base, 0x0102030405060708);
        assert_eq!(&n[..16], &base);
        assert_eq!(&n[16..], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn header_parser_rejects_wrong_kind_and_bad_fields() {
        let bad = serde_json::json!({"kind": "data_only"});
        assert!(parse_header(&bad).is_err());
        let short_key = serde_json::json!({
            "kind": "account-backup", "backupId": "acct-x", "accountId": "u",
            "createdAt": "t", "chunkBytes": 4, "chunkCount": 1, "zipBytes": 4,
            "zipSha256": "0".repeat(64), "baseNonce": B64.encode([0u8; 16]),
            "cloudEphemeralPk": B64.encode([0u8; 31]),
            "keyNonce": B64.encode([0u8; 24]), "wrappedKey": B64.encode([0u8; 48]),
        });
        assert!(parse_header(&short_key).is_err());
    }
}
