//! TRUST-001 — verification of first-party-signed plugin packages.
//!
//! A release bundle ships a `package-manifest.json` written by the aokie
//! repo's `package-signer`: an Ed25519 signature (by a publisher key whose
//! PUBLIC half is pinned here, in the shipped binary) over a payload that
//! lists every bundle file with its SHA-256 + size. The host verifies:
//!
//!   * at **scan** ("before staging") — a tampered directory is quarantined
//!     (Disabled, with the exact reason) before anything could select it;
//!   * again at **launch** — closing the scan→start TOCTOU window, so bytes
//!     swapped after the scan still cannot execute.
//!
//! Verification checks the signature, then that every LISTED file matches
//! its digest and size, then that no UNLISTED executable/loadable file is
//! present (`.exe`, `.dll`, scripts…) — a dropped extra binary next to a
//! signed plugin is DLL-search-order/hijack surface, so it is a tamper, not
//! an extra. Non-loadable stragglers (deploy `.bak-*` copies, notes) don't
//! fail a signed package, and they can never be executed: `manifest.json`
//! itself must be listed, which pins the entry command.
//!
//! Directories WITHOUT a package manifest are "unsigned": allowed for
//! development sideloading, surfaced as such in the UI/API, and refused
//! outright when `FORMLOGIC_REQUIRE_SIGNED_PLUGINS=1` (the production
//! posture for public installs). Key rotation = several pinned keys;
//! emergency revocation = `FORMLOGIC_REVOKED_PUBKEY_IDS=id1,id2`.

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const PACKAGE_MANIFEST_FILE: &str = "package-manifest.json";

/// Pinned first-party publisher keys: (keyId, standard-base64 Ed25519 public
/// key). Add a new entry to rotate; remove (or revoke via env) to retire.
/// The PRIVATE halves live in the release pipeline's secret store only.
const TRUSTED_PUBLISHER_KEYS: &[(&str, &str)] = &[
    // Aokie release bundles, minted 2026-07-12 (seed: operator key file /
    // AOKIE_PACKAGE_SIGNING_KEY CI secret — never in a repository).
    ("fl-aokie-2026a", "n832sELL2yC6UksKhiz4C4UY7P9//mf8JfeFJRcuk5s="),
];

/// Extra trusted keys for tests/lab setups: `id=base64,id2=base64`.
const EXTRA_KEYS_ENV: &str = "FORMLOGIC_EXTRA_TRUSTED_PUBKEYS";
/// Comma-separated keyIds to refuse even though they are compiled in.
const REVOKED_IDS_ENV: &str = "FORMLOGIC_REVOKED_PUBKEY_IDS";
/// When "1": a plugin directory WITHOUT a valid signed package manifest may
/// not start at all (production posture; dev sideloading leaves it unset).
const REQUIRE_SIGNED_ENV: &str = "FORMLOGIC_REQUIRE_SIGNED_PLUGINS";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageTrust {
    /// No package manifest present — a dev sideload. Allowed unless
    /// [`require_signed`] is on; always surfaced as unsigned.
    Unsigned,
    /// Signed by a pinned publisher key and every digest checks out.
    Verified { key_id: String, name: String, version: String },
    /// A package manifest exists but does NOT verify — quarantine.
    Tampered(String),
}

impl PackageTrust {
    /// Wire label for snapshots/UI.
    pub fn label(&self) -> &'static str {
        match self {
            PackageTrust::Unsigned => "unsigned",
            PackageTrust::Verified { .. } => "verified",
            PackageTrust::Tampered(_) => "tampered",
        }
    }
}

pub fn require_signed() -> bool {
    std::env::var(REQUIRE_SIGNED_ENV).map(|v| v == "1").unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    #[allow(dead_code)]
    format: u32,
    alg: String,
    key_id: String,
    payload_b64: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    name: String,
    version: String,
    #[allow(dead_code)]
    created_at: String,
    files: Vec<FileEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    path: String,
    sha256: String,
    size: u64,
}

/// Resolve the effective trusted key set: pinned + env extras − revoked.
fn trusted_keys() -> Vec<(String, String)> {
    let revoked: Vec<String> = std::env::var(REVOKED_IDS_ENV)
        .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let mut keys: Vec<(String, String)> = TRUSTED_PUBLISHER_KEYS
        .iter()
        .map(|(id, k)| (id.to_string(), k.to_string()))
        .collect();
    if let Ok(extra) = std::env::var(EXTRA_KEYS_ENV) {
        for pair in extra.split(',') {
            if let Some((id, key)) = pair.split_once('=') {
                let (id, key) = (id.trim(), key.trim());
                if !id.is_empty() && !key.is_empty() {
                    keys.push((id.to_string(), key.to_string()));
                }
            }
        }
    }
    keys.retain(|(id, _)| !revoked.contains(id));
    keys
}

fn hex_encode(b: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        let _ = write!(s, "{x:02x}");
    }
    s
}

fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((hex_encode(&hasher.finalize()), size))
}

/// Extensions Windows/scripting will happily execute or implicitly load from
/// the plugin directory. An UNLISTED file with one of these beside a signed
/// plugin is treated as tampering (hijack surface), not as a harmless extra.
const LOADABLE_EXTS: &[&str] = &[
    "exe", "dll", "com", "cmd", "bat", "ps1", "js", "mjs", "cjs", "py", "sh", "node",
];

fn is_loadable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| LOADABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Assess a plugin directory. Never panics; any IO/parse problem on a
/// PRESENT manifest is `Tampered` (fail closed), a MISSING manifest is
/// `Unsigned` (the sideload case).
pub fn assess(dir: &Path) -> PackageTrust {
    let manifest_path = dir.join(PACKAGE_MANIFEST_FILE);
    if !manifest_path.is_file() {
        return PackageTrust::Unsigned;
    }
    match verify(dir, &manifest_path) {
        Ok(p) => p,
        Err(e) => PackageTrust::Tampered(e),
    }
}

fn verify(dir: &Path, manifest_path: &Path) -> Result<PackageTrust, String> {
    let text = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("cannot read {PACKAGE_MANIFEST_FILE}: {e}"))?;
    let envelope: Envelope =
        serde_json::from_str(&text).map_err(|e| format!("malformed envelope: {e}"))?;
    if envelope.alg != "Ed25519" {
        return Err(format!("unsupported alg {:?}", envelope.alg));
    }
    let keys = trusted_keys();
    let Some((key_id, pub_b64)) = keys.iter().find(|(id, _)| *id == envelope.key_id) else {
        return Err(format!(
            "publisher key {:?} is not trusted (or has been revoked)",
            envelope.key_id
        ));
    };

    let payload_bytes = base64::engine::general_purpose::STANDARD
        .decode(envelope.payload_b64.trim())
        .map_err(|e| format!("payload base64: {e}"))?;
    let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(envelope.signature.trim().trim_end_matches('='))
        .map_err(|e| format!("signature base64: {e}"))?;
    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(pub_b64.trim())
        .map_err(|e| format!("pinned key base64: {e}"))?;
    let pk = VerifyingKey::from_bytes(
        &<[u8; 32]>::try_from(pk_bytes.as_slice()).map_err(|_| "pinned key must be 32 bytes")?,
    )
    .map_err(|e| format!("pinned key invalid: {e}"))?;
    let sig = Signature::from_bytes(
        &<[u8; 64]>::try_from(sig_bytes.as_slice()).map_err(|_| "signature must be 64 bytes")?,
    );
    pk.verify(&payload_bytes, &sig)
        .map_err(|_| "package signature verification failed".to_string())?;

    let payload: Payload =
        serde_json::from_slice(&payload_bytes).map_err(|e| format!("malformed payload: {e}"))?;

    // 1. Every LISTED file must exist with the exact digest + size.
    for f in &payload.files {
        if f.path.contains("..") || f.path.starts_with('/') || f.path.contains(':') {
            return Err(format!("manifest lists an unsafe path {:?}", f.path));
        }
        let disk = dir.join(&f.path);
        let (sha, size) =
            sha256_file(&disk).map_err(|_| format!("listed file missing/unreadable: {}", f.path))?;
        if sha != f.sha256.to_lowercase() || size != f.size {
            return Err(format!("digest mismatch: {}", f.path));
        }
    }
    // 2. manifest.json (the entry command) must be COVERED by the signature.
    if !payload.files.iter().any(|f| f.path == "manifest.json") {
        return Err("package manifest does not cover manifest.json (entry command unpinned)".into());
    }
    // 3. No UNLISTED loadable file may be present.
    let listed = |rel: &str| payload.files.iter().any(|f| f.path == rel);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = std::fs::read_dir(&d).map_err(|e| format!("read_dir: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                return Err(format!("symlink present in signed package: {}", path.display()));
            }
            if ft.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(dir)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if rel == PACKAGE_MANIFEST_FILE {
                continue;
            }
            if is_loadable(&path) && !listed(&rel) {
                return Err(format!("unlisted executable/loadable file present: {rel}"));
            }
        }
    }

    Ok(PackageTrust::Verified {
        key_id: key_id.clone(),
        name: payload.name,
        version: payload.version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    /// Env-var tests must not interleave (set_var is process-global).
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    const SEED: [u8; 32] = [42u8; 32];

    fn test_pubkey() -> String {
        base64::engine::general_purpose::STANDARD
            .encode(SigningKey::from_bytes(&SEED).verifying_key().to_bytes())
    }

    fn tmp(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("fl-pkgtrust-{tag}-{n}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex_encode(&Sha256::digest(bytes))
    }

    /// Sign a directory the same way package-signer does (kept in lockstep by
    /// the shared format assertions below).
    fn sign_dir(dir: &Path, key_id: &str, files: &[(&str, &[u8])]) {
        let entries: Vec<serde_json::Value> = files
            .iter()
            .map(|(p, b)| json!({ "path": p, "sha256": sha_of(b), "size": b.len() }))
            .collect();
        let payload = json!({
            "name": "test-plugin",
            "version": "1.0.0",
            "createdAt": "t0",
            "files": entries,
        });
        let payload_bytes = serde_json::to_vec(&payload).unwrap();
        let sig = SigningKey::from_bytes(&SEED).sign(&payload_bytes);
        let envelope = json!({
            "format": 1,
            "alg": "Ed25519",
            "keyId": key_id,
            "payloadB64": base64::engine::general_purpose::STANDARD.encode(&payload_bytes),
            "signature": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        });
        std::fs::write(dir.join(PACKAGE_MANIFEST_FILE), envelope.to_string()).unwrap();
    }

    fn write_files(dir: &Path, files: &[(&str, &[u8])]) {
        for (p, b) in files {
            let full = dir.join(p);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, b).unwrap();
        }
    }

    const FILES: &[(&str, &[u8])] = &[
        ("manifest.json", b"{\"id\":\"test\"}"),
        ("plugin.exe", b"binary bytes"),
        ("runtime.dll", b"dll bytes"),
    ];

    #[test]
    fn missing_manifest_is_unsigned() {
        let d = tmp("unsigned");
        write_files(&d, FILES);
        assert_eq!(assess(&d), PackageTrust::Unsigned);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn valid_signed_package_verifies_via_env_key() {
        let _g = env_lock();
        let d = tmp("ok");
        write_files(&d, FILES);
        sign_dir(&d, "test-2026", FILES);
        std::env::set_var(EXTRA_KEYS_ENV, format!("test-2026={}", test_pubkey()));
        let out = assess(&d);
        std::env::remove_var(EXTRA_KEYS_ENV);
        match out {
            PackageTrust::Verified { key_id, name, version } => {
                assert_eq!(key_id, "test-2026");
                assert_eq!(name, "test-plugin");
                assert_eq!(version, "1.0.0");
            }
            other => panic!("expected Verified, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tampered_binary_quarantines() {
        let _g = env_lock();
        let d = tmp("tamper");
        write_files(&d, FILES);
        sign_dir(&d, "test-2026", FILES);
        std::fs::write(d.join("plugin.exe"), b"EVIL bytes!!").unwrap();
        std::env::set_var(EXTRA_KEYS_ENV, format!("test-2026={}", test_pubkey()));
        let out = assess(&d);
        std::env::remove_var(EXTRA_KEYS_ENV);
        match out {
            PackageTrust::Tampered(r) => assert!(r.contains("digest mismatch"), "{r}"),
            other => panic!("expected Tampered, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn dropped_extra_dll_quarantines_but_inert_extras_pass() {
        let _g = env_lock();
        let d = tmp("extra");
        write_files(&d, FILES);
        sign_dir(&d, "test-2026", FILES);
        std::env::set_var(EXTRA_KEYS_ENV, format!("test-2026={}", test_pubkey()));
        // An inert extra (deploy backup, notes) does not fail a signed package…
        std::fs::write(d.join("plugin.exe.bak-predeploy"), b"old exe").unwrap();
        std::fs::write(d.join("NOTES.txt"), b"hello").unwrap();
        assert!(matches!(assess(&d), PackageTrust::Verified { .. }));
        // …but an unlisted LOADABLE file is hijack surface → tampered.
        std::fs::write(d.join("evil.dll"), b"hijack").unwrap();
        let out = assess(&d);
        std::env::remove_var(EXTRA_KEYS_ENV);
        match out {
            PackageTrust::Tampered(r) => assert!(r.contains("unlisted"), "{r}"),
            other => panic!("expected Tampered, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_or_revoked_key_quarantines() {
        let _g = env_lock();
        let d = tmp("keys");
        write_files(&d, FILES);
        sign_dir(&d, "test-2026", FILES);
        // Unknown key (not pinned, no env extra) → tampered.
        match assess(&d) {
            PackageTrust::Tampered(r) => assert!(r.contains("not trusted"), "{r}"),
            other => panic!("expected Tampered, got {other:?}"),
        }
        // Known via env but REVOKED → tampered.
        std::env::set_var(EXTRA_KEYS_ENV, format!("test-2026={}", test_pubkey()));
        std::env::set_var(REVOKED_IDS_ENV, "test-2026");
        let out = assess(&d);
        std::env::remove_var(REVOKED_IDS_ENV);
        std::env::remove_var(EXTRA_KEYS_ENV);
        assert!(matches!(out, PackageTrust::Tampered(_)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn manifest_json_must_be_covered() {
        let _g = env_lock();
        let d = tmp("cover");
        // Signed payload that omits manifest.json — the entry command would be
        // unpinned, so it must not verify.
        let partial: &[(&str, &[u8])] = &[("plugin.exe", b"binary bytes")];
        write_files(&d, FILES);
        sign_dir(&d, "test-2026", partial);
        std::env::set_var(EXTRA_KEYS_ENV, format!("test-2026={}", test_pubkey()));
        let out = assess(&d);
        std::env::remove_var(EXTRA_KEYS_ENV);
        match out {
            PackageTrust::Tampered(r) => assert!(r.contains("manifest.json"), "{r}"),
            other => panic!("expected Tampered, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn signer_format_interop_vector() {
        // Byte-for-byte fixture of the aokie package-signer output shape —
        // guards against either side drifting the wire format.
        let _g = env_lock();
        let d = tmp("interop");
        let files: &[(&str, &[u8])] = &[("manifest.json", b"{}"), ("a.exe", b"aaa")];
        write_files(&d, files);
        sign_dir(&d, "vector", files);
        let text = std::fs::read_to_string(d.join(PACKAGE_MANIFEST_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        for key in ["format", "alg", "keyId", "payloadB64", "signature"] {
            assert!(v.get(key).is_some(), "envelope key {key} missing");
        }
        std::env::set_var(EXTRA_KEYS_ENV, format!("vector={}", test_pubkey()));
        assert!(matches!(assess(&d), PackageTrust::Verified { .. }));
        std::env::remove_var(EXTRA_KEYS_ENV);
        let _ = std::fs::remove_dir_all(&d);
    }
}
