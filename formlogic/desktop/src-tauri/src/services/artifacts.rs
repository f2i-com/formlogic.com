//! SRV-404/SRV-407 (Desktop leg): device-local artifact storage.
//!
//! A service action can return something too big to travel in-band — a generated image, a
//! rendered audio file. Inlining it would put the bytes into the flow's node payloads and run
//! logs, where they bloat every persisted record and get read by people debugging something
//! else. So the bytes stay here and the flow carries an
//! [ArtifactRef](../../../../../docs/contracts/artifact-ref.v1.schema.json): an opaque handle
//! with `locality: "device"`, which is an honest statement about where the content actually is.
//!
//! Deliberately NOT uploaded anywhere on the way out. A device artifact that silently shipped
//! itself to the cloud would move a user's content across a boundary they never approved; a
//! consumer elsewhere gets a typed `artifact_wrong_device` instead, which they can act on.
//!
//! Storage layout is derived from the generated id alone — never from a media type, a filename,
//! or anything else the service supplied — so a hostile response cannot steer a write.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/// Artifacts are working values between nodes, not durable records.
pub const TTL: Duration = Duration::from_secs(7 * 24 * 3600);

/// Largest artifact this store will accept. Bigger content belongs in a form upload.
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Point the store at the app data directory. Called once at startup; a second call is ignored
/// so a test harness cannot be silently redirected mid-run.
pub fn init(data_dir: &Path) {
    let _ = ROOT.set(data_dir.join("artifacts"));
}

fn root() -> PathBuf {
    ROOT.get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("formlogic-artifacts"))
}

/// Store bytes and return the ArtifactRef the flow will carry.
///
/// `kind` is the coarse family (`image`/`audio`/`video`/`text`/`file`) that a port's
/// `x-artifactKinds` is matched against, so a node accepting images cannot be wired audio.
pub fn store(bytes: &[u8], media_type: &str, device_id: &str) -> Result<Value, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!("artifact exceeds the {MAX_BYTES}-byte device store limit"));
    }
    let id = new_id();
    let dir = root();
    fs::create_dir_all(&dir).map_err(|e| format!("could not create the artifact directory: {e}"))?;
    let mut file = fs::File::create(dir.join(format!("{id}.bin")))
        .map_err(|e| format!("could not write the artifact: {e}"))?;
    file.write_all(bytes).map_err(|e| format!("could not write the artifact: {e}"))?;

    let expires_at = SystemTime::now() + TTL;
    let expires_secs = expires_at
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(json!({
        "$artifact": id,
        "kind": kind_of(media_type),
        "mediaType": sanitize_media_type(media_type),
        "byteSize": bytes.len(),
        "digest": sha256_hex(bytes),
        // The bytes are HERE. Saying so is what lets a consumer elsewhere fail honestly
        // instead of resolving a handle to nothing.
        "locality": "device",
        "deviceId": device_id,
        "expiresAt": rfc3339(expires_secs),
    }))
}

/// Read an artifact's bytes back. Ids are validated by shape, so a crafted id cannot walk out
/// of the artifact directory.
pub fn read(artifact_id: &str) -> Option<Vec<u8>> {
    if !is_valid_id(artifact_id) {
        return None;
    }
    fs::read(root().join(format!("{artifact_id}.bin"))).ok()
}

/// Remove artifacts past their TTL. Deterministic: the same on-disk state always removes the
/// same set, and a second run immediately after removes nothing.
pub fn sweep() -> usize {
    let Ok(entries) = fs::read_dir(root()) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| now.duration_since(modified).map(|age| age > TTL).unwrap_or(false))
            .unwrap_or(false);
        if expired && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn is_valid_id(id: &str) -> bool {
    id.len() == 28
        && id.starts_with("art_")
        && id[4..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Which coarse family a media type belongs to. Unknown types are `file` rather than a guess —
/// a wrong kind would let a port accept content it cannot handle.
fn kind_of(media_type: &str) -> &'static str {
    let base = media_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if base.starts_with("image/") {
        "image"
    } else if base.starts_with("audio/") {
        "audio"
    } else if base.starts_with("video/") {
        "video"
    } else if base.starts_with("text/") {
        "text"
    } else {
        "file"
    }
}

/// Keep only a well-formed `type/subtype`. A service controls this header, and it ends up in a
/// stored ref and eventually a Content-Type — an unbounded or malformed value has no business
/// travelling that far.
fn sanitize_media_type(media_type: &str) -> String {
    let base = media_type.split(';').next().unwrap_or("").trim();
    let ok = base.len() <= 190
        && base.matches('/').count() == 1
        && base
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'+' | b'-' | b'_'));
    if ok && !base.is_empty() {
        base.to_ascii_lowercase()
    } else {
        "application/octet-stream".to_string()
    }
}

/// 24 lowercase base-36 characters from a v4 UUID's randomness. The id is OPAQUE by design:
/// not a path, not a hash of the content, not derived from anything the service supplied.
fn new_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut suffix = String::with_capacity(24);
    for byte in bytes.iter().take(24) {
        suffix.push(ALPHABET[(*byte as usize) % ALPHABET.len()] as char);
    }
    // A v4 UUID is 16 bytes; top the id up from a second one so the length is always 24.
    let extra = *uuid::Uuid::new_v4().as_bytes();
    for byte in extra.iter().take(24 - suffix.len()) {
        suffix.push(ALPHABET[(*byte as usize) % ALPHABET.len()] as char);
    }
    format!("art_{suffix}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Minimal RFC 3339 in UTC from a unix timestamp — the ref's `expiresAt` shape.
fn rfc3339(unix_seconds: u64) -> String {
    let secs = unix_seconds as i64;
    let mut days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let mut year = 1970;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for len in lengths {
        if days < len {
            break;
        }
        days -= len;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}Z",
        days + 1,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_artifact_is_a_handle_not_the_bytes() {
        let dir = std::env::temp_dir().join(format!("fl-art-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let _ = ROOT.set(dir.clone());

        let ref_value = store(b"PNGDATA", "image/png", "desk-A").expect("stored");
        assert!(is_valid_id(ref_value["$artifact"].as_str().unwrap()));
        assert_eq!(ref_value["kind"], "image");
        assert_eq!(ref_value["byteSize"], 7);
        assert_eq!(ref_value["locality"], "device");
        assert_eq!(ref_value["deviceId"], "desk-A");

        // The ref carries no path, and nothing that could be used to reach the bytes directly.
        let json = ref_value.to_string();
        for needle in ["\\\\", ".bin", dir.to_string_lossy().as_ref()] {
            assert!(!json.contains(needle), "the ref must not leak '{needle}'");
        }

        let bytes = read(ref_value["$artifact"].as_str().unwrap()).expect("readable");
        assert_eq!(bytes, b"PNGDATA");
    }

    #[test]
    fn a_crafted_id_cannot_walk_out_of_the_artifact_directory() {
        for bad in ["", "art_short", "../../secrets", "art_ABCDEFGHIJKLMNOPQRSTUVWX"] {
            assert!(!is_valid_id(bad), "'{bad}' must not be a valid id");
            assert!(read(bad).is_none());
        }
    }

    #[test]
    fn a_hostile_media_type_cannot_travel() {
        assert_eq!(sanitize_media_type("image/png"), "image/png");
        assert_eq!(sanitize_media_type("IMAGE/PNG; charset=utf-8"), "image/png");
        // Injection attempts and nonsense both fall back rather than being carried forward.
        for hostile in ["image/png\r\nX-Evil: 1", "not a media type", "", "a/b/c"] {
            assert_eq!(sanitize_media_type(hostile), "application/octet-stream");
        }
    }

    #[test]
    fn kinds_come_from_the_media_type_and_default_to_file() {
        assert_eq!(kind_of("image/webp"), "image");
        assert_eq!(kind_of("audio/wav"), "audio");
        assert_eq!(kind_of("video/mp4"), "video");
        assert_eq!(kind_of("text/plain; charset=utf-8"), "text");
        assert_eq!(kind_of("application/pdf"), "file");
    }
}
