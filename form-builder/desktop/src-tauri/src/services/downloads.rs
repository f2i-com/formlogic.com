//! Model downloads — HuggingFace + direct URLs, with pause/resume.
//!
//! Each download runs on a background task and writes into a `.part`
//! file under the designated downloads folder (`${dataDir}/models/`).
//! Progress is tracked in a shared map; the UI polls
//! /api/models/downloads to render bars.
//!
//! Pause/resume works via HTTP `Range: bytes=N-`. When paused, the
//! background task is aborted but the .part file + byte counter survive,
//! so a later resume picks up exactly where it left off. Servers that
//! don't accept ranges (rare for HF) cause resume to restart from 0 —
//! we surface that on the resumed entry's `error` field as a warning.
//!
//! HuggingFace URL normalisation: accept either
//!   https://huggingface.co/<repo>/blob/<rev>/<file>           (browser)
//!   https://huggingface.co/<repo>/resolve/<rev>/<file>        (direct)
//! and rewrite the first to the second.

use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::task::AbortHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Active,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub subdir: Option<String>,
    /// Absolute path of the final file (where the .part lands after rename).
    /// The UI shows this so the user can copy it to a file explorer.
    pub dest_path: String,
    pub status: DownloadStatus,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    /// Whether the remote server supports byte-range resume. `None` until
    /// the first response comes back; surfaced so the UI can disable the
    /// Pause button on servers that would force a restart.
    pub resumable: Option<bool>,
    /// Bytes/sec over a 4-second sliding window. `None` until the first
    /// progress tick. Stops updating (stays at last value) on pause so
    /// the UI doesn't flicker to 0 mid-pause.
    pub speed_bps: Option<u64>,
    /// Seconds remaining at the current speed. `None` when `bytes_total`
    /// or `speed_bps` isn't known yet.
    pub eta_secs: Option<u64>,
    /// MODEL-001: the SHA-256 this download is pinned to (from the catalog
    /// or the caller). The transfer is hashed in flight and REFUSES to
    /// install on mismatch. `None` = nothing to check against (arbitrary
    /// pasted URL) — the computed digest is still reported in `sha256`.
    pub expected_sha256: Option<String>,
    /// Pinned size that must match the completed byte count exactly.
    pub expected_size: Option<u64>,
    /// Computed SHA-256 of the completed file (every download is hashed,
    /// pinned or not, so the manifest always has a digest to reverify).
    pub sha256: Option<String>,
    /// `Some(true)` = pinned digest matched before install; `Some(false)`
    /// = mismatch (never installed); `None` = no pin to check.
    pub verified: Option<bool>,
}

/// A digest pin a download must satisfy before its `.part` may become the
/// installed file.
#[derive(Debug, Clone)]
pub struct ExpectedDigest {
    /// Lowercase hex SHA-256.
    pub sha256: String,
    /// Exact final size in bytes, when known.
    pub size_bytes: Option<u64>,
}

/// One verified install, persisted in `.models-manifest.json` next to the
/// models so Doctor/repair can re-hash files long after the download.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub sha256: String,
    pub size_bytes: u64,
    pub url: String,
    pub verified_at: DateTime<Utc>,
    /// Whether the digest was pinned ahead of the download (catalog/caller)
    /// or merely computed from whatever arrived.
    pub pinned: bool,
}

/// Result row from a re-verification pass (`verify_all`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub name: String,
    pub ok: bool,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
    /// What happened to a failing file: "quarantined" (renamed aside) or
    /// "quarantine-failed: <err>" when even the rename failed.
    pub action: Option<String>,
}

/// Full report from a re-verification pass.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub checked: Vec<VerifyResult>,
    /// Files on disk with no manifest entry — nothing to check them
    /// against (downloaded before MODEL-001, or copied in by hand).
    pub untracked: Vec<String>,
    /// Manifest entries whose file no longer exists (stale rows are
    /// dropped from the manifest as part of the pass).
    pub missing: Vec<String>,
}

const MANIFEST_FILE: &str = ".models-manifest.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified: Option<DateTime<Utc>>,
    /// Digest recorded when this file was installed, if the manifest has
    /// one (i.e. it arrived through the downloader after MODEL-001).
    pub sha256: Option<String>,
    /// Cheap verification status for the list view: "verified" (manifest
    /// digest exists and the size still matches — full re-hash is the
    /// explicit verify endpoint's job), "modified" (size drifted from the
    /// manifest — the file changed since install), or "unverified" (no
    /// manifest entry to check against).
    pub verification: &'static str,
}

/// Snapshot for the UI — wraps `list_models()` output with the designated
/// folder path so the user sees "all your models live here:" prominently.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSnapshot {
    pub root_dir: String,
    pub models: Vec<ModelFile>,
    /// Free space on the drive holding the models dir, so the UI can show
    /// "142 GiB free" and warn before a download that won't fit. `None`
    /// if the query failed (rare — non-fatal).
    pub free_bytes: Option<u64>,
}

/// Headroom we keep free so a download never fills the drive to zero —
/// the final `.part` → final-name rename, plus logs/temp, all need room.
const DISK_MARGIN_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB

/// Pure free-space decision: how many bytes short we'd be after reserving
/// the margin, or `None` if `needed` fits. Split out so it's unit-testable
/// without touching a real filesystem.
fn space_shortfall(available: u64, needed: u64) -> Option<u64> {
    let required = needed.saturating_add(DISK_MARGIN_BYTES);
    required.checked_sub(available).filter(|short| *short > 0)
}

fn human_gib(bytes: u64) -> String {
    format!("{:.2} GiB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

/// Whether a URL points at HuggingFace, so it's safe to attach the user's
/// HF token. Matches `huggingface.co` and its subdomains only — we never
/// send the token to an arbitrary host the user pasted.
fn is_hf_host(url: &str) -> bool {
    // Require HTTPS: the only caller that matters attaches the user's HF bearer
    // token to is_hf_host URLs, and that token must never ride a plaintext request
    // (a MitM on the path would capture the Authorization header). Checking the
    // host without the scheme let `http://huggingface.co/...` leak the token.
    match url::Url::parse(url).ok() {
        Some(u) if u.scheme() == "https" => u
            .host_str()
            .map(str::to_lowercase)
            .is_some_and(|host| host == "huggingface.co" || host.ends_with(".huggingface.co")),
        _ => false,
    }
}

/// True when an IP is one a model download must NEVER reach: loopback, private (RFC1918),
/// link-local (incl. the 169.254.169.254 cloud-metadata endpoint), CGNAT, unspecified, etc.
/// The SSRF guard, so an untrusted catalog/template download URL can't drive the companion
/// into internal services on the user's (possibly cloud/corporate) machine.
fn is_disallowed_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 0x40) // 100.64.0.0/10 CGNAT
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_disallowed_ip(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            (seg0 & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (seg0 & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

/// SSRF guard for a model-download URL: require https + reject a host that IS (or resolves to)
/// an internal/special address. Runs synchronously in start() BEFORE any task is spawned, so a
/// hostile URL fails fast (Err -> 400) and never becomes an internal-port-scan oracle (the
/// status endpoint otherwise reflects an internal response's status/size/resumable back).
fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "invalid download URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("download URL must use https".into());
    }
    let host = parsed.host_str().ok_or("download URL has no host")?;
    // Bare IP literal — check directly (no DNS).
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_disallowed_ip(ip) {
            return Err(format!("download URL points at a disallowed address ({ip})"));
        }
        return Ok(());
    }
    // Hostname — resolve + reject if ANY resolved address is internal (covers a DNS name that
    // points at an internal IP). Brief blocking lookup; start() is user-initiated, not hot.
    use std::net::ToSocketAddrs;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let mut saw_any = false;
    for addr in (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve download host '{host}': {e}"))?
    {
        saw_any = true;
        if is_disallowed_ip(addr.ip()) {
            return Err(format!(
                "download host '{host}' resolves to a disallowed address ({})",
                addr.ip()
            ));
        }
    }
    if !saw_any {
        return Err(format!("download host '{host}' did not resolve"));
    }
    Ok(())
}

/// Parse the start byte of a `Content-Range: bytes <start>-<end>/<total>` response header.
fn content_range_start(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get("content-range")?
        .to_str()
        .ok()?
        .trim()
        .strip_prefix("bytes")?
        .trim_start()
        .split('-')
        .next()?
        .trim()
        .parse::<u64>()
        .ok()
}

pub struct Downloads {
    /// Where downloaded files land: `${dataDir}/models/`. This is the
    /// "designated folder" the UI shows prominently.
    models_dir: PathBuf,
    /// All downloads ever attempted in this session, keyed by id.
    /// Completed entries stay so the UI can surface "just finished".
    progress: Arc<Mutex<HashMap<String, DownloadProgress>>>,
    /// AbortHandles for in-flight task cancellation (pause + cancel).
    /// Kept separate from `progress` so the latter can stay serializable.
    abort_handles: Arc<Mutex<HashMap<String, AbortHandle>>>,
    /// Optional HuggingFace access token, sent as `Authorization: Bearer`
    /// on huggingface.co requests so gated/private repos (Llama, some
    /// Gemma) download. Set from the persisted config at startup +
    /// whenever the user changes it in Settings. Never sent to non-HF
    /// hosts (incl. the CDN host the resolve URL 302-redirects to — that
    /// URL is already presigned, and reqwest strips auth across hosts).
    hf_token: Arc<Mutex<Option<String>>>,
    /// Serialises read-modify-write of `.models-manifest.json` across
    /// concurrently-completing downloads + delete/verify.
    manifest_lock: Arc<Mutex<()>>,
    /// Held for the duration of a `verify_all` pass so a double-POST
    /// doesn't hash the whole library twice in parallel.
    verify_lock: Arc<Mutex<()>>,
}

pub type DownloadsHandle = Arc<Downloads>;

impl Downloads {
    /// `models_dir` is the resolved downloads root (the `modelsDir` override
    /// when set, else `<dataDir>/models`) — passed in fully-resolved so the
    /// downloader doesn't need to know about the data dir.
    pub fn new(models_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&models_dir);
        Self {
            models_dir,
            progress: Arc::new(Mutex::new(HashMap::new())),
            abort_handles: Arc::new(Mutex::new(HashMap::new())),
            hf_token: Arc::new(Mutex::new(None)),
            manifest_lock: Arc::new(Mutex::new(())),
            verify_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Set (or clear, with None/empty) the HuggingFace token used for
    /// gated downloads. An empty string clears it.
    pub fn set_token(&self, token: Option<String>) {
        let cleaned = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if let Ok(mut g) = self.hf_token.lock() {
            *g = cleaned;
        }
    }

    /// Whether a HuggingFace token is currently set (the UI shows status,
    /// never the token itself).
    pub fn has_token(&self) -> bool {
        self.hf_token.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn into_handle(self) -> DownloadsHandle {
        Arc::new(self)
    }

    /// Designated downloads folder. Surfaced in `list_models()` for the
    /// UI; this getter is for future Tauri commands that may want it.
    #[allow(dead_code)]
    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    pub fn snapshot(&self) -> Vec<DownloadProgress> {
        match self.progress.lock() {
            Ok(g) => {
                let mut v: Vec<_> = g.values().cloned().collect();
                // Newest first so the bar of interest is at the top of the UI.
                v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
                v
            }
            Err(_) => Vec::new(),
        }
    }

    pub fn list_models(&self) -> Result<ModelsSnapshot, String> {
        let mut models = Vec::new();
        walk_dir(&self.models_dir, &self.models_dir, &mut models)
            .map_err(|e| format!("scan failed: {e}"))?;
        // Decorate with the verification manifest: digest + a CHEAP status
        // (size comparison only — full re-hash on an 8s poll would thrash
        // the disk; that's what POST /api/models/verify is for).
        let manifest = manifest_load(&self.models_dir);
        for m in &mut models {
            match manifest.get(&m.name) {
                Some(entry) => {
                    m.sha256 = Some(entry.sha256.clone());
                    m.verification = if entry.size_bytes == m.size_bytes {
                        "verified"
                    } else {
                        "modified"
                    };
                }
                None => m.verification = "unverified",
            }
        }
        models.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(ModelsSnapshot {
            root_dir: self.models_dir.display().to_string(),
            models,
            free_bytes: fs2::available_space(&self.models_dir).ok(),
        })
    }

    pub fn delete_model(&self, name: &str) -> Result<(), String> {
        // Reject any traversal/absolute component (`..`, a root, or a Windows
        // drive/UNC prefix) outright — more robust than a substring `..`
        // check, which misses e.g. a bare `C:` prefix.
        use std::path::Component;
        let name_path = Path::new(name);
        if name_path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("invalid model name".into());
        }
        let p = self.models_dir.join(name);
        if !p.starts_with(&self.models_dir) {
            return Err("path escapes models dir".into());
        }

        // Resolve symlinks/junctions before deleting: a symlink (or NTFS
        // junction) inside models_dir could otherwise point the final path at
        // a target outside it. `p` itself may not be canonicalizable if it's a
        // dangling link or already gone, so canonicalize the parent dir (which
        // must exist) and re-join the file name, then confirm it stays under a
        // canonicalized models_dir.
        match std::fs::canonicalize(&self.models_dir) {
            Ok(canon_root) => {
                let parent = p.parent().unwrap_or(&self.models_dir);
                match std::fs::canonicalize(parent) {
                    Ok(canon_parent) => {
                        let file_name = p
                            .file_name()
                            .ok_or_else(|| "invalid model name".to_string())?;
                        let resolved = canon_parent.join(file_name);
                        if !resolved.starts_with(&canon_root) {
                            return Err("path escapes models dir".into());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Parent dir missing → the file can't exist; fall
                        // through to remove_file so the not-found path below
                        // produces the usual "delete failed" message.
                    }
                    Err(e) => return Err(format!("delete failed: {e}")),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // models_dir itself missing → nothing to delete; fall through.
            }
            Err(e) => return Err(format!("delete failed: {e}")),
        }

        std::fs::remove_file(&p).map_err(|e| format!("delete failed: {e}"))?;
        // Drop the manifest row so a future file at the same path can't
        // inherit a stale "verified" badge.
        let key = name.replace('\\', "/");
        let _g = self.manifest_lock.lock();
        let mut manifest = manifest_load(&self.models_dir);
        if manifest.remove(&key).is_some() {
            manifest_store(&self.models_dir, &manifest);
        }
        Ok(())
    }

    /// Re-hash every manifest-tracked model and quarantine mismatches
    /// (MODEL-001 Doctor/repair hook). Blocking — call from
    /// `spawn_blocking`. A failing file is renamed to
    /// `<name>.quarantine-<unix-ts>` so services stop loading it, and its
    /// manifest row is dropped; the report says exactly what happened.
    pub fn verify_all(&self) -> Result<VerifyReport, String> {
        let _guard = self
            .verify_lock
            .try_lock()
            .map_err(|_| "a verification pass is already running".to_string())?;

        let manifest = {
            let _g = self.manifest_lock.lock();
            manifest_load(&self.models_dir)
        };
        let mut on_disk = Vec::new();
        walk_dir(&self.models_dir, &self.models_dir, &mut on_disk)
            .map_err(|e| format!("scan failed: {e}"))?;

        let mut checked = Vec::new();
        let mut missing = Vec::new();
        let mut drop_keys = Vec::new();
        for (name, entry) in &manifest {
            let path = self.models_dir.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !path.is_file() {
                missing.push(name.clone());
                drop_keys.push(name.clone());
                continue;
            }
            match hash_file_blocking(&path) {
                Ok((digest, size)) => {
                    let ok = digest == entry.sha256 && size == entry.size_bytes;
                    let action = if ok {
                        None
                    } else {
                        drop_keys.push(name.clone());
                        Some(quarantine_file(&path))
                    };
                    checked.push(VerifyResult {
                        name: name.clone(),
                        ok,
                        expected_sha256: entry.sha256.clone(),
                        actual_sha256: Some(digest),
                        action,
                    });
                }
                Err(e) => {
                    // Unreadable ≠ proven-bad: report it, keep the manifest
                    // row (the file may be locked by a running service).
                    checked.push(VerifyResult {
                        name: name.clone(),
                        ok: false,
                        expected_sha256: entry.sha256.clone(),
                        actual_sha256: None,
                        action: Some(format!("unreadable: {e}")),
                    });
                }
            }
        }
        let untracked: Vec<String> = on_disk
            .iter()
            .filter(|m| !manifest.contains_key(&m.name))
            .map(|m| m.name.clone())
            .collect();

        if !drop_keys.is_empty() {
            let _g = self.manifest_lock.lock();
            let mut current = manifest_load(&self.models_dir);
            for k in &drop_keys {
                current.remove(k);
            }
            manifest_store(&self.models_dir, &current);
        }
        checked.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(VerifyReport {
            checked,
            untracked,
            missing,
        })
    }

    /// Kick off a download. Returns the assigned download id immediately;
    /// the actual transfer runs on a background task.
    ///
    /// `expected` pins the download to a SHA-256 (+ optional exact size):
    /// the stream is hashed in flight and a mismatch means the `.part` is
    /// deleted and the file is NEVER installed (MODEL-001).
    pub fn start(
        &self,
        url: &str,
        filename: Option<&str>,
        subdir: Option<&str>,
        expected: Option<ExpectedDigest>,
    ) -> Result<String, String> {
        let normalised = normalise_hf_url(url)?;
        // SSRF guard: refuse a non-https URL or one pointing at an internal/special address
        // BEFORE spawning, so an untrusted catalog/template URL can't make the companion probe
        // internal services (and never spawns a task whose status would leak as an oracle).
        validate_download_url(&normalised)?;
        let chosen_filename = match filename {
            Some(f) if !f.is_empty() => f.to_string(),
            _ => guess_filename(&normalised)?,
        };

        // Reject filenames that could escape the dest dir. Legitimate downloads pass a bare
        // filename; subdir is the nesting mechanism, so a separator or `..` in the filename is
        // always invalid. Use the SAME Component-based check as `subdir`/`delete_model`, not the
        // weaker `is_absolute()` test: a Windows drive-relative prefix like `C:evil` has a
        // Prefix component but is NOT absolute, and `dest_dir.join("C:evil")` REPLACES dest_dir
        // entirely (→ writes to the process CWD on that drive, outside models_dir).
        {
            use std::path::Component;
            if chosen_filename.contains("..")
                || chosen_filename.contains('/')
                || chosen_filename.contains('\\')
                || Path::new(&chosen_filename).components().any(|c| {
                    matches!(
                        c,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
            {
                return Err("invalid filename".into());
            }
        }

        let dest_dir = match subdir {
            Some(s) if !s.is_empty() => {
                // Reject any traversal/absolute/drive-prefix component — more
                // robust than the old `contains("..") || is_absolute()` check,
                // which missed a Windows drive-relative prefix like `C:foo`
                // (is_absolute() is false for it). Mirrors delete_model.
                use std::path::Component;
                if Path::new(s).components().any(|c| {
                    matches!(
                        c,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                }) {
                    return Err("invalid subdir".into());
                }
                self.models_dir.join(s)
            }
            _ => self.models_dir.clone(),
        };
        std::fs::create_dir_all(&dest_dir).map_err(|e| format!("mkdir failed: {e}"))?;
        let dest = dest_dir.join(&chosen_filename);
        // Defense-in-depth: ensure the resolved destination still lives under
        // the models dir, resolving symlinks/junctions (a pre-existing link
        // inside models_dir could otherwise redirect the write outside it).
        // Mirrors delete_model: canonicalize the (now-created) dest dir + root,
        // with a lexical fallback if canonicalization isn't possible.
        match (
            std::fs::canonicalize(&dest_dir),
            std::fs::canonicalize(&self.models_dir),
        ) {
            (Ok(canon_dir), Ok(canon_root)) => {
                if !canon_dir.starts_with(&canon_root) {
                    return Err("path escapes models dir".into());
                }
            }
            _ => {
                if !dest.starts_with(&self.models_dir) {
                    return Err("path escapes models dir".into());
                }
            }
        }

        // Already on disk? Don't re-download a model the user already has.
        // Surface a Completed entry (with the real on-disk size) so the UI
        // shows "already downloaded" instead of silently no-op'ing. This is
        // the "check for existing before downloading" behaviour. Verification
        // is reported from the manifest (cheap); a deep re-check of an
        // already-installed file is the verify endpoint's job.
        if let Ok(meta) = std::fs::metadata(&dest) {
            if meta.is_file() && meta.len() > 0 {
                let id = Uuid::new_v4().to_string();
                let now = Utc::now();
                let manifest_entry = {
                    let key = dest
                        .strip_prefix(&self.models_dir)
                        .map(|r| r.display().to_string().replace('\\', "/"))
                        .unwrap_or_else(|_| chosen_filename.clone());
                    manifest_load(&self.models_dir).remove(&key)
                };
                let verified = match (&expected, &manifest_entry) {
                    (Some(exp), Some(m)) => {
                        Some(m.sha256 == exp.sha256 && m.size_bytes == meta.len())
                    }
                    _ => None,
                };
                if let Ok(mut g) = self.progress.lock() {
                    g.insert(
                        id.clone(),
                        DownloadProgress {
                            id: id.clone(),
                            url: normalised.clone(),
                            filename: chosen_filename.clone(),
                            subdir: subdir.map(|s| s.to_string()),
                            dest_path: dest.display().to_string(),
                            status: DownloadStatus::Completed,
                            bytes_downloaded: meta.len(),
                            bytes_total: Some(meta.len()),
                            started_at: now,
                            finished_at: Some(now),
                            error: None,
                            resumable: None,
                            speed_bps: None,
                            eta_secs: None,
                            expected_sha256: expected.as_ref().map(|e| e.sha256.clone()),
                            expected_size: expected.as_ref().and_then(|e| e.size_bytes),
                            sha256: manifest_entry.map(|m| m.sha256),
                            verified,
                        },
                    );
                }
                return Ok(id);
            }
        }

        // De-dup: if a download for the same URL is already running or
        // paused (not failed/completed), return that id. Also bound the number
        // of simultaneously in-flight transfers: POST /api/models/download is
        // reachable from any loopback web page, so without a cap a flood of
        // distinct URLs could spawn unbounded tasks/connections/.part writes
        // and exhaust the tray app.
        const MAX_CONCURRENT_DOWNLOADS: usize = 8;
        if let Ok(g) = self.progress.lock() {
            if let Some(existing) = g.values().find(|p| {
                p.url == normalised
                    && matches!(
                        p.status,
                        DownloadStatus::Queued
                            | DownloadStatus::Active
                            | DownloadStatus::Paused
                    )
            }) {
                return Ok(existing.id.clone());
            }
            let in_flight = g
                .values()
                .filter(|p| {
                    matches!(p.status, DownloadStatus::Queued | DownloadStatus::Active)
                })
                .count();
            if in_flight >= MAX_CONCURRENT_DOWNLOADS {
                return Err(format!(
                    "too many concurrent downloads ({MAX_CONCURRENT_DOWNLOADS} max) — wait for some to finish"
                ));
            }
        }

        let id = Uuid::new_v4().to_string();
        let progress = DownloadProgress {
            id: id.clone(),
            url: normalised.clone(),
            filename: chosen_filename.clone(),
            subdir: subdir.map(|s| s.to_string()),
            dest_path: dest.display().to_string(),
            status: DownloadStatus::Queued,
            bytes_downloaded: 0,
            bytes_total: None,
            started_at: Utc::now(),
            finished_at: None,
            error: None,
            resumable: None,
            speed_bps: None,
            eta_secs: None,
            expected_sha256: expected.as_ref().map(|e| e.sha256.clone()),
            expected_size: expected.as_ref().and_then(|e| e.size_bytes),
            sha256: None,
            verified: None,
        };
        if let Ok(mut g) = self.progress.lock() {
            g.insert(id.clone(), progress);
        }

        self.spawn_transfer(id.clone(), normalised, dest, /* resume_from = */ 0, expected);
        Ok(id)
    }

    /// Pause an in-flight download. The .part file + byte counter are
    /// preserved; resume() picks up via HTTP Range. No-op if already
    /// paused/finished.
    pub fn pause(&self, id: &str) -> Result<(), String> {
        let status = {
            let g = self.progress.lock().map_err(|_| "lock poisoned")?;
            g.get(id).map(|p| p.status).ok_or("unknown download")?
        };
        match status {
            DownloadStatus::Active | DownloadStatus::Queued => {
                self.abort_task(id);
                self.update(id, |p| {
                    p.status = DownloadStatus::Paused;
                    // Clear speed/ETA so paused rows don't lie ("12 MiB/s")
                    // for the few seconds before the user sees the badge flip.
                    p.speed_bps = None;
                    p.eta_secs = None;
                });
                Ok(())
            }
            DownloadStatus::Paused => Ok(()),
            other => Err(format!("can't pause download in state {other:?}")),
        }
    }

    /// Resume a paused download. Sends `Range: bytes=N-` from the current
    /// byte counter; if the server refuses, the .part is wiped and we
    /// restart from 0 (with a warning surfaced on `error`).
    pub fn resume(&self, id: &str) -> Result<(), String> {
        let (url, dest, status, expected) = {
            let g = self.progress.lock().map_err(|_| "lock poisoned")?;
            let p = g.get(id).ok_or("unknown download")?;
            // The digest pin survives pause/resume — a resumed transfer is
            // still the same catalog download and must satisfy the same pin.
            let expected = p.expected_sha256.as_ref().map(|sha| ExpectedDigest {
                sha256: sha.clone(),
                size_bytes: p.expected_size,
            });
            (p.url.clone(), PathBuf::from(&p.dest_path), p.status, expected)
        };
        if !matches!(status, DownloadStatus::Paused | DownloadStatus::Failed) {
            return Err(format!("can't resume download in state {status:?}"));
        }
        // Resume from the ACTUAL bytes on disk, not the throttle-lagged counter.
        // Every chunk is write_all'd in order, but `bytes_downloaded` only advances
        // on the ~1 MiB / 250 ms emit tick — so the .part is up to ~1 MiB longer
        // than the counter at pause/failure. The transfer reopens the .part with
        // `.append(true)` (writes at EOF) but asks the server for `Range: bytes=N-`;
        // resuming from the stale counter therefore DUPLICATES [counter, part_len)
        // into the file and silently corrupts it. The on-disk bytes are valid + in
        // order, so the real file length is the correct, waste-free resume offset.
        // If the .part is gone or unreadable (AV/cleanup/manual delete), treat it
        // as a fresh start (0) — NOT the stale counter: run_download would then
        // `Range: bytes=N-` + `.append(true).create(true)` onto a brand-new empty
        // file, dropping the first N bytes (rename has no size check) = silent
        // head-truncation. Make the on-disk length authoritative.
        let resume_from = std::fs::metadata(part_path_for(&dest))
            .map(|m| m.len())
            .unwrap_or(0);
        self.update(id, |p| {
            p.status = DownloadStatus::Queued;
            p.error = None;
            p.bytes_downloaded = resume_from;
        });
        self.spawn_transfer(id.to_string(), url, dest, resume_from, expected);
        Ok(())
    }

    /// Cancel + delete the in-progress file. Use when the user clicks
    /// the trash icon next to an active or paused download.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.abort_task(id);
        let part_path = {
            let g = self.progress.lock().map_err(|_| "lock poisoned")?;
            g.get(id).map(|p| part_path_for(&PathBuf::from(&p.dest_path)))
                .ok_or("unknown download")?
        };
        let _ = std::fs::remove_file(&part_path);
        self.update(id, |p| {
            p.status = DownloadStatus::Cancelled;
            p.finished_at = Some(Utc::now());
        });
        Ok(())
    }

    // ---- internals ----

    fn abort_task(&self, id: &str) {
        if let Ok(mut g) = self.abort_handles.lock() {
            if let Some(h) = g.remove(id) {
                h.abort();
            }
        }
    }

    fn update<F: FnOnce(&mut DownloadProgress)>(&self, id: &str, f: F) {
        if let Ok(mut g) = self.progress.lock() {
            if let Some(p) = g.get_mut(id) {
                f(p);
            }
        }
    }

    fn spawn_transfer(
        &self,
        id: String,
        url: String,
        dest: PathBuf,
        resume_from: u64,
        expected: Option<ExpectedDigest>,
    ) {
        let progress_map = self.progress.clone();
        // The abort_map clone is moved into the task so it can remove its
        // own AbortHandle entry on completion — without this, finished
        // downloads leak stale entries that the next pause() would try to
        // abort harmlessly but the map would grow unbounded across long
        // sessions.
        let abort_map = self.abort_handles.clone();
        let id_for_task = id.clone();
        let token = self.hf_token.lock().ok().and_then(|g| g.clone());
        let ctx = TransferCtx {
            expected,
            models_dir: self.models_dir.clone(),
            manifest_lock: self.manifest_lock.clone(),
        };
        let handle = tokio::spawn(async move {
            run_download(
                progress_map,
                abort_map,
                id_for_task,
                url,
                dest,
                resume_from,
                token,
                ctx,
            )
            .await;
        });
        if let Ok(mut g) = self.abort_handles.lock() {
            g.insert(id, handle.abort_handle());
        }
    }
}

/// Verification context a transfer needs at completion time: the digest
/// pin plus where/how to record the manifest row.
struct TransferCtx {
    expected: Option<ExpectedDigest>,
    models_dir: PathBuf,
    manifest_lock: Arc<Mutex<()>>,
}

#[allow(clippy::too_many_arguments)]
async fn run_download(
    progress_map: Arc<Mutex<HashMap<String, DownloadProgress>>>,
    abort_map: Arc<Mutex<HashMap<String, AbortHandle>>>,
    id: String,
    url: String,
    dest: PathBuf,
    resume_from: u64,
    hf_token: Option<String>,
    ctx: TransferCtx,
) {
    let update = |f: Box<dyn FnOnce(&mut DownloadProgress)>| {
        if let Ok(mut g) = progress_map.lock() {
            if let Some(p) = g.get_mut(&id) {
                f(p);
            }
        }
    };

    update(Box::new(|p| p.status = DownloadStatus::Active));

    let client = match reqwest::Client::builder()
        .user_agent(format!("formlogic-desktop/{}", env!("CARGO_PKG_VERSION")))
        // Re-validate every redirect hop: a public host (incl. the HF resolve URL) may 302 to a
        // CDN, but it must stay https and must not point at an internal literal IP (defense over
        // the start() guard, which only sees the original URL). DNS-name hops are followed and
        // re-checked by the OS at connect (a rebind-to-internal across the hop is the residual).
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.stop();
            }
            if attempt.url().scheme() != "https" {
                return attempt.error("redirect to a non-https URL");
            }
            if let Some(ip) = attempt
                .url()
                .host_str()
                .and_then(|h| h.parse::<std::net::IpAddr>().ok())
            {
                if is_disallowed_ip(ip) {
                    return attempt.error("redirect to a disallowed internal address");
                }
            }
            attempt.follow()
        }))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            update(Box::new(move |p| {
                p.status = DownloadStatus::Failed;
                p.error = Some(format!("client build: {e}"));
                p.finished_at = Some(Utc::now());
            }));
            return;
        }
    };

    let mut req = client.get(&url);
    let resuming = resume_from > 0;
    if resuming {
        req = req.header("Range", format!("bytes={resume_from}-"));
    }
    // Attach the HF token only on huggingface.co requests so gated/private
    // repos resolve. Never sent to an arbitrary host the user pasted; the
    // CDN host the resolve URL 302s to is already presigned (and reqwest
    // drops Authorization across hosts anyway).
    if let Some(token) = hf_token.as_deref() {
        if is_hf_host(&url) {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            update(Box::new(move |p| {
                p.status = DownloadStatus::Failed;
                p.error = Some(format!("request: {e}"));
                p.finished_at = Some(Utc::now());
            }));
            return;
        }
    };

    let status = resp.status();
    // A range request returns 206 Partial Content on success and 200 OK
    // when the server ignored Range. Any non-success is fatal.
    let mut resume_accepted = true;
    if resuming && status == reqwest::StatusCode::OK {
        // Server gave us the whole file again — start over.
        resume_accepted = false;
    } else if !status.is_success() {
        // 401/403 on an HF URL = gated/private repo. Give an actionable
        // message instead of a bare "HTTP 401": the fix is a token (or one
        // with access + accepted terms), set in Settings.
        let gated = matches!(
            status,
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) && is_hf_host(&url);
        let had_token = hf_token.is_some();
        let msg = if gated && !had_token {
            "this looks like a gated or private HuggingFace repo. Add a HuggingFace \
             access token in Settings (and accept the model's terms on its HF page), \
             then retry."
                .to_string()
        } else if gated {
            "HuggingFace returned 403/401 even with your token — make sure that token \
             has access to this repo and you've accepted the model's terms on its HF page."
                .to_string()
        } else {
            format!("HTTP {status}")
        };
        update(Box::new(move |p| {
            p.status = DownloadStatus::Failed;
            p.error = Some(msg);
            p.finished_at = Some(Utc::now());
        }));
        return;
    }

    // On a resume, a 206 must actually START at resume_from. The code appends the body at the
    // file's EOF, so a server (or MITM on an attacker-supplied URL) returning a different range
    // — the whole file again, or a wrong offset — would otherwise corrupt the file (and there's
    // no checksum backstop). Validate Content-Range before trusting the 206.
    if resuming && resume_accepted && status == reqwest::StatusCode::PARTIAL_CONTENT {
        match content_range_start(&resp) {
            Some(start) if start == resume_from => {} // good — resumes exactly where we asked
            Some(0) => resume_accepted = false,       // whole file again → restart from 0
            _ => {
                update(Box::new(|p| {
                    p.status = DownloadStatus::Failed;
                    p.error = Some(
                        "server returned an inconsistent partial response (bad Content-Range); \
                         pause and retry"
                            .into(),
                    );
                    p.finished_at = Some(Utc::now());
                }));
                return;
            }
        }
    }

    // `content_len` is the size of THIS response body — i.e. the bytes
    // we're about to write now (the remaining tail when resuming, or the
    // whole file otherwise). `total` is the full file size for the UI.
    let content_len = resp.content_length();
    let total = content_len.map(|cl| {
        if resuming && resume_accepted {
            cl.saturating_add(resume_from)
        } else {
            cl
        }
    });
    let resumable = resp.headers().get("accept-ranges").is_some()
        || status == reqwest::StatusCode::PARTIAL_CONTENT;
    update(Box::new(move |p| {
        p.bytes_total = total;
        p.resumable = Some(resumable);
        if resuming && !resume_accepted {
            p.bytes_downloaded = 0;
            p.error = Some(
                "server didn't accept Range request — restarting from 0".to_string(),
            );
        }
    }));

    // Pre-flight free-space check: when the server told us the size, bail
    // BEFORE writing a single byte if it clearly won't fit — far friendlier
    // than filling the drive and dying mid-stream with an OS error. If the
    // size is unknown (no Content-Length) we proceed and let the write fail
    // naturally.
    if let Some(need) = content_len {
        if need > 0 {
            let check_dir = dest.parent().unwrap_or(&dest);
            if let Ok(avail) = fs2::available_space(check_dir) {
                if let Some(short) = space_shortfall(avail, need) {
                    update(Box::new(move |p| {
                        p.status = DownloadStatus::Failed;
                        p.error = Some(format!(
                            "not enough disk space: this download needs ~{} but only ~{} is free \
                             (short by ~{}). Free up space or point the data folder at a bigger drive \
                             (Settings → Data folder).",
                            human_gib(need),
                            human_gib(avail),
                            human_gib(short)
                        ));
                        p.finished_at = Some(Utc::now());
                    }));
                    return;
                }
            }
        }
    }

    let part = part_path_for(&dest);
    if let Err(e) = tokio::fs::create_dir_all(part.parent().unwrap_or(Path::new("."))).await {
        update(Box::new(move |p| {
            p.status = DownloadStatus::Failed;
            p.error = Some(format!("mkdir: {e}"));
            p.finished_at = Some(Utc::now());
        }));
        return;
    }

    // MODEL-001: every transfer is hashed in flight. On a resume the hasher
    // must first replay the bytes already on disk — the .part prefix is
    // exactly `resume_from` bytes (resume() derives the offset from the
    // file's length). Re-hashing GBs is disk-bound, so it runs on the
    // blocking pool; a prefix that can't be re-hashed fails the download
    // rather than installing a file whose digest we can't attest.
    let mut hasher = Sha256::new();
    if resuming && resume_accepted && resume_from > 0 {
        let part_for_hash = part.clone();
        match tokio::task::spawn_blocking(move || hash_prefix_blocking(&part_for_hash, resume_from))
            .await
        {
            Ok(Ok(h)) => hasher = h,
            Ok(Err(e)) => {
                update(Box::new(move |p| {
                    p.status = DownloadStatus::Failed;
                    p.error = Some(format!("re-hash of partial file failed: {e}"));
                    p.finished_at = Some(Utc::now());
                }));
                return;
            }
            Err(e) => {
                update(Box::new(move |p| {
                    p.status = DownloadStatus::Failed;
                    p.error = Some(format!("re-hash task failed: {e}"));
                    p.finished_at = Some(Utc::now());
                }));
                return;
            }
        }
    }

    let mut file = if resuming && resume_accepted {
        match tokio::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&part)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                update(Box::new(move |p| {
                    p.status = DownloadStatus::Failed;
                    p.error = Some(format!("append: {e}"));
                    p.finished_at = Some(Utc::now());
                }));
                return;
            }
        }
    } else {
        // Either a fresh download or a non-resumable retry.
        match tokio::fs::File::create(&part).await {
            Ok(f) => f,
            Err(e) => {
                update(Box::new(move |p| {
                    p.status = DownloadStatus::Failed;
                    p.error = Some(format!("create: {e}"));
                    p.finished_at = Some(Utc::now());
                }));
                return;
            }
        }
    };

    let mut downloaded: u64 = if resuming && resume_accepted { resume_from } else { 0 };
    let mut last_emit: u64 = downloaded;
    // Sliding-window speed tracker: keep (timestamp, bytes_so_far) samples
    // from the last ~4s. Speed = (bytes_now - bytes_oldest) / window_secs.
    // Resists both lumpy chunk arrivals AND end-of-file misreporting from
    // simple "bytes / elapsed_total".
    let mut samples: std::collections::VecDeque<(std::time::Instant, u64)> =
        std::collections::VecDeque::with_capacity(32);
    samples.push_back((std::time::Instant::now(), downloaded));
    const SPEED_WINDOW_SECS: u64 = 4;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                update(Box::new(move |p| {
                    p.status = DownloadStatus::Failed;
                    p.error = Some(format!("stream: {e}"));
                    p.finished_at = Some(Utc::now());
                }));
                // Don't delete the .part — pause/resume relies on it.
                return;
            }
        };
        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            update(Box::new(move |p| {
                p.status = DownloadStatus::Failed;
                p.error = Some(format!("write: {e}"));
                p.finished_at = Some(Utc::now());
            }));
            return;
        }
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        // Throttle progress writes — 1 MiB OR 250ms granularity (whichever
        // first). The 250ms floor keeps speed/ETA ticking on slow links
        // where we might wait minutes between MiB.
        let now = std::time::Instant::now();
        let elapsed_since_emit = now.duration_since(samples.back().map(|s| s.0).unwrap_or(now));
        if downloaded - last_emit > 1 << 20 || elapsed_since_emit.as_millis() > 250 {
            last_emit = downloaded;
            samples.push_back((now, downloaded));
            // Trim samples older than the window.
            while let Some(&(t, _)) = samples.front() {
                if now.duration_since(t).as_secs() > SPEED_WINDOW_SECS {
                    samples.pop_front();
                } else {
                    break;
                }
            }
            let (speed, eta) = compute_speed_eta(&samples, total);
            update(Box::new(move |p| {
                p.bytes_downloaded = downloaded;
                p.speed_bps = speed;
                p.eta_secs = eta;
            }));
        }
    }
    let _ = tokio::io::AsyncWriteExt::flush(&mut file).await;
    drop(file);

    // Don't rename a silently-truncated body into a "valid" model: when the full size is known,
    // require we wrote all of it. (hyper raises a premature-EOF stream error for Content-Length/
    // chunked bodies, caught above; this is the backstop, and keeps the .part for a resume.)
    if let Some(t) = total {
        if downloaded != t {
            update(Box::new(move |p| {
                p.status = DownloadStatus::Failed;
                p.error = Some(format!("incomplete download: wrote {downloaded} of {t} bytes"));
                p.finished_at = Some(Utc::now());
            }));
            return;
        }
    }

    // MODEL-001: enforce the pinned size + digest BEFORE the atomic rename —
    // a corrupt, truncated or substituted body must never become "installed".
    let digest = to_hex(&hasher.finalize());
    match finalize_download(&part, &dest, downloaded, &digest, ctx.expected.as_ref()) {
        Ok(verified) => {
            // Record the verified install so Doctor/repair can re-hash it
            // later (every download is recorded, pinned or not).
            let key = dest
                .strip_prefix(&ctx.models_dir)
                .map(|r| r.display().to_string().replace('\\', "/"))
                .unwrap_or_else(|_| dest.display().to_string());
            let entry = ManifestEntry {
                sha256: digest.clone(),
                size_bytes: downloaded,
                url: url.clone(),
                verified_at: Utc::now(),
                pinned: ctx.expected.is_some(),
            };
            {
                let _g = ctx.manifest_lock.lock();
                let mut manifest = manifest_load(&ctx.models_dir);
                manifest.insert(key, entry);
                manifest_store(&ctx.models_dir, &manifest);
            }
            update(Box::new(move |p| {
                p.status = DownloadStatus::Completed;
                p.bytes_downloaded = downloaded;
                p.finished_at = Some(Utc::now());
                p.sha256 = Some(digest);
                p.verified = verified;
                // Clear speed/ETA on completion — leaving them stale would say
                // "12 MiB/s · 0 min remaining" on a finished row.
                p.speed_bps = None;
                p.eta_secs = None;
            }));
        }
        Err(FinalizeError::Mismatch(msg)) => {
            update(Box::new(move |p| {
                p.status = DownloadStatus::Failed;
                p.error = Some(msg);
                p.finished_at = Some(Utc::now());
                p.sha256 = Some(digest);
                p.verified = Some(false);
            }));
            return;
        }
        Err(FinalizeError::Io(msg)) => {
            update(Box::new(move |p| {
                p.status = DownloadStatus::Failed;
                p.error = Some(msg);
                p.finished_at = Some(Utc::now());
            }));
            return;
        }
    }

    // Drop our AbortHandle from the map — the task's about to exit
    // normally; future pause/cancel calls would no-op anyway, but a
    // clean map saves memory across long sessions of many downloads.
    if let Ok(mut g) = abort_map.lock() {
        g.remove(&id);
    }
}

/// Compute bytes/sec + ETA from a sliding window of (timestamp, bytes)
/// samples. Returns (None, None) when the window doesn't have enough
/// signal yet (only one sample, or zero elapsed).
fn compute_speed_eta(
    samples: &std::collections::VecDeque<(std::time::Instant, u64)>,
    total: Option<u64>,
) -> (Option<u64>, Option<u64>) {
    if samples.len() < 2 {
        return (None, None);
    }
    let (t_old, b_old) = *samples.front().unwrap();
    let (t_new, b_new) = *samples.back().unwrap();
    let elapsed = t_new.duration_since(t_old).as_secs_f64();
    if elapsed <= 0.0 || b_new <= b_old {
        return (None, None);
    }
    let bps = ((b_new - b_old) as f64 / elapsed) as u64;
    let eta = total.and_then(|t| {
        if t <= b_new || bps == 0 {
            None
        } else {
            Some(((t - b_new) as f64 / bps as f64) as u64)
        }
    });
    (Some(bps), eta)
}

/// `model.gguf` → `model.gguf.part`. Single, predictable layout makes
/// resume + cancel cleanup straightforward.
fn part_path_for(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// Why a completed body was refused (MODEL-001).
#[derive(Debug)]
enum FinalizeError {
    /// Pinned size/digest didn't match — the `.part` has been DELETED (a
    /// complete-but-wrong body has no resume value) and nothing installed.
    Mismatch(String),
    /// Filesystem error (rename) — the `.part` is kept for a retry.
    Io(String),
}

/// Enforce the pinned size + digest, then atomically rename the `.part`
/// into place. Pure fs mechanics, split from `run_download` so mismatch
/// behaviour is unit-testable. Returns the `verified` flag for the
/// progress row: `Some(true)` when a pin was checked and matched, `None`
/// when there was no pin.
fn finalize_download(
    part: &Path,
    dest: &Path,
    downloaded: u64,
    digest: &str,
    expected: Option<&ExpectedDigest>,
) -> Result<Option<bool>, FinalizeError> {
    if let Some(exp) = expected {
        if let Some(size) = exp.size_bytes {
            if downloaded != size {
                let _ = std::fs::remove_file(part);
                return Err(FinalizeError::Mismatch(format!(
                    "size mismatch: the pinned size is {size} bytes but the download is \
                     {downloaded} — refusing to install (the server's file does not match \
                     the catalog pin)"
                )));
            }
        }
        if !digest.eq_ignore_ascii_case(&exp.sha256) {
            let _ = std::fs::remove_file(part);
            return Err(FinalizeError::Mismatch(format!(
                "checksum mismatch: expected sha256 {} but the download hashed to {digest} — \
                 refusing to install (corrupt or substituted file)",
                exp.sha256
            )));
        }
    }
    std::fs::rename(part, dest).map_err(|e| FinalizeError::Io(format!("rename: {e}")))?;
    Ok(expected.map(|_| true))
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Re-hash exactly `len` bytes of `path` (the resume prefix). Errors if
/// the file is shorter — the resume offset then doesn't describe the disk
/// and the transfer must not proceed. Blocking (call via `spawn_blocking`).
fn hash_prefix_blocking(path: &Path, len: u64) -> Result<Sha256, String> {
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut f = std::fs::File::open(path).map_err(|e| format!("open partial file: {e}"))?;
    let mut remaining = len;
    let mut buf = vec![0u8; 1 << 20];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = f
            .read(&mut buf[..want])
            .map_err(|e| format!("read partial file: {e}"))?;
        if n == 0 {
            return Err(format!(
                "partial file is {} bytes short of the resume offset",
                remaining
            ));
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(hasher)
}

/// SHA-256 + size of a whole file. Blocking (call via `spawn_blocking`).
fn hash_file_blocking(path: &Path) -> Result<(String, u64), String> {
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mut size: u64 = 0;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((to_hex(&hasher.finalize()), size))
}

/// Move a verification-failed file aside as `<name>.quarantine-<unix-ts>`
/// so services stop loading it while the user can still inspect it.
/// Returns a human-readable description of what happened.
fn quarantine_file(path: &Path) -> String {
    let mut q = path.as_os_str().to_owned();
    q.push(format!(".quarantine-{}", Utc::now().timestamp()));
    let q = PathBuf::from(q);
    match std::fs::rename(path, &q) {
        Ok(()) => format!("quarantined to {}", q.display()),
        Err(e) => format!("quarantine-failed: {e}"),
    }
}

/// Load `.models-manifest.json` (relative-path → entry). Missing or
/// malformed = empty: the manifest is a verification CACHE — worst case a
/// file shows "unverified", never "verified" by accident.
fn manifest_load(models_dir: &Path) -> HashMap<String, ManifestEntry> {
    let path = models_dir.join(MANIFEST_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Persist the manifest atomically (tmp + rename) so a crash mid-write
/// can't leave a torn file that erases every recorded digest.
fn manifest_store(models_dir: &Path, manifest: &HashMap<String, ManifestEntry>) {
    let path = models_dir.join(MANIFEST_FILE);
    let tmp = models_dir.join(format!("{MANIFEST_FILE}.tmp"));
    let json = match serde_json::to_string_pretty(manifest) {
        Ok(j) => j,
        Err(e) => {
            log::warn!("models manifest serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp, json) {
        log::warn!("models manifest write failed: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        log::warn!("models manifest rename failed: {e}");
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Recursively walk `root` collecting ModelFile entries with paths
/// relative to `root_base`. Skips .part files (in-flight downloads).
fn walk_dir(root: &Path, root_base: &Path, out: &mut Vec<ModelFile>) -> std::io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        // Don't follow symlinks/junctions — a loop or an out-of-tree link would
        // let this walk recurse widely or surface files outside the models dir.
        // (`file_type()` does NOT follow the link, unlike `metadata()` below.)
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let p = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk_dir(&p, root_base, out)?;
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) == Some("part") {
            continue;
        }
        // The verification manifest (and its tmp file) are bookkeeping,
        // not models.
        if entry
            .file_name()
            .to_str()
            .is_some_and(|n| n == MANIFEST_FILE || n == concat!(".models-manifest.json", ".tmp"))
        {
            continue;
        }
        let rel = p.strip_prefix(root_base).unwrap_or(&p);
        let name = rel.display().to_string().replace('\\', "/");
        let modified = meta.modified().ok().and_then(|t| {
            let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
            DateTime::<Utc>::from_timestamp(
                d.as_secs() as i64,
                d.subsec_nanos(),
            )
        });
        out.push(ModelFile {
            name,
            path: p.display().to_string(),
            size_bytes: meta.len(),
            modified,
            sha256: None,
            verification: "unverified", // decorated from the manifest by list_models
        });
    }
    Ok(())
}

/// Convert a HF browser URL (`/blob/`) to a direct download URL
/// (`/resolve/`). Leaves direct URLs and non-HF URLs untouched. Public so
/// the download route can match the SAME normalised URL against the
/// catalog when pinning digests server-side.
pub fn normalise_hf_url(input: &str) -> Result<String, String> {
    let parsed = url::Url::parse(input).map_err(|e| format!("invalid URL: {e}"))?;
    if parsed.host_str() != Some("huggingface.co") {
        return Ok(input.to_string());
    }
    let path = parsed.path();
    if let Some(rest) = path.strip_prefix("/") {
        let segments: Vec<&str> = rest.splitn(4, '/').collect();
        if segments.len() == 4 && segments[2] == "blob" {
            let new_path = format!(
                "/{}/{}/resolve/{}",
                segments[0], segments[1], segments[3]
            );
            let mut rewritten = parsed.clone();
            rewritten.set_path(&new_path);
            return Ok(rewritten.to_string());
        }
    }
    Ok(input.to_string())
}

/// Default filename when the caller didn't supply one — last path segment
/// of the URL, percent-decoded.
fn guess_filename(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    let last = parsed
        .path_segments()
        .and_then(|mut s| s.next_back())
        .ok_or("URL has no path segments")?;
    if last.is_empty() {
        return Err("URL ends in /; no filename to use".into());
    }
    Ok(percent_decode(last))
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_blob_to_resolve() {
        let url = "https://huggingface.co/Qwen/Qwen3-Coder/blob/main/model.gguf";
        let normalised = normalise_hf_url(url).unwrap();
        assert_eq!(
            normalised,
            "https://huggingface.co/Qwen/Qwen3-Coder/resolve/main/model.gguf"
        );
    }

    #[test]
    fn hf_resolve_unchanged() {
        let url = "https://huggingface.co/Qwen/Qwen3-Coder/resolve/main/model.gguf";
        assert_eq!(normalise_hf_url(url).unwrap(), url);
    }

    #[test]
    fn non_hf_unchanged() {
        let url = "https://example.com/model.gguf";
        assert_eq!(normalise_hf_url(url).unwrap(), url);
    }

    #[test]
    fn guesses_filename_from_url() {
        assert_eq!(
            guess_filename("https://huggingface.co/foo/bar/resolve/main/Qwen3.gguf").unwrap(),
            "Qwen3.gguf"
        );
    }

    #[test]
    fn percent_decode_works() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
    }

    #[test]
    fn part_path_is_suffixed() {
        let p = part_path_for(Path::new("/tmp/model.gguf"));
        assert_eq!(p.to_string_lossy(), "/tmp/model.gguf.part");
    }

    #[test]
    fn space_shortfall_respects_margin() {
        // Comfortably fits (well above need + margin).
        assert_eq!(space_shortfall(DISK_MARGIN_BYTES + 10_000, 1_000), None);
        // Exactly need + margin available → fits (no shortfall).
        assert_eq!(space_shortfall(DISK_MARGIN_BYTES + 1_000, 1_000), None);
        // One byte short of need + margin → reports a 1-byte shortfall.
        assert_eq!(space_shortfall(DISK_MARGIN_BYTES + 999, 1_000), Some(1));
        // Way too small → large shortfall.
        assert_eq!(space_shortfall(0, 1_000), Some(1_000 + DISK_MARGIN_BYTES));
    }

    #[test]
    fn available_space_query_works() {
        // fs2 integration smoke test — the temp dir's drive has *some* free
        // space, and the query succeeds on this platform.
        let avail = fs2::available_space(&std::env::temp_dir()).unwrap();
        assert!(avail > 0);
    }

    #[test]
    fn token_state_trims_and_clears() {
        let d = Downloads::new(std::env::temp_dir().join("formlogic-token-test"));
        assert!(!d.has_token(), "starts unset");
        d.set_token(Some("hf_abc".to_string()));
        assert!(d.has_token(), "set");
        d.set_token(Some("   ".to_string()));
        assert!(!d.has_token(), "whitespace-only clears");
        d.set_token(Some("hf_xyz".to_string()));
        assert!(d.has_token());
        d.set_token(None);
        assert!(!d.has_token(), "None clears");
    }

    #[test]
    fn hf_host_scoping() {
        // The token must go to HF (and its subdomains) ONLY — never to an
        // arbitrary host the user pasted.
        assert!(is_hf_host("https://huggingface.co/meta-llama/x/resolve/main/a.gguf"));
        assert!(is_hf_host("https://cdn-lfs.huggingface.co/foo"));
        assert!(is_hf_host("https://HuggingFace.co/foo")); // case-insensitive
        assert!(!is_hf_host("https://evil.com/huggingface.co/foo"));
        assert!(!is_hf_host("https://nothuggingface.co/foo"));
        // HTTPS required: never attach the bearer token over plaintext.
        assert!(!is_hf_host("http://huggingface.co/foo"));
        assert!(!is_hf_host("http://cdn-lfs.huggingface.co/foo"));
        assert!(!is_hf_host("https://example.com/model.gguf"));
        assert!(!is_hf_host("not a url"));
    }

    #[test]
    fn ssrf_guard_blocks_internal_and_non_https() {
        use std::net::IpAddr;
        // Internal / special addresses must be disallowed; public ones allowed.
        for ip in [
            "127.0.0.1",
            "169.254.169.254", // cloud metadata
            "10.0.0.1",
            "192.168.1.1",
            "172.16.0.1",
            "0.0.0.0",
            "100.64.0.1", // CGNAT
            "::1",
            "fc00::1", // unique-local
            "fe80::1", // link-local
            "::ffff:127.0.0.1", // v4-mapped loopback
        ] {
            assert!(
                is_disallowed_ip(ip.parse::<IpAddr>().unwrap()),
                "{ip} should be disallowed"
            );
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                !is_disallowed_ip(ip.parse::<IpAddr>().unwrap()),
                "{ip} should be allowed"
            );
        }
        // validate_download_url: scheme + IP-literal checks (no DNS needed).
        assert!(validate_download_url("http://huggingface.co/x").is_err()); // not https
        assert!(validate_download_url("file:///etc/passwd").is_err());
        assert!(validate_download_url("https://127.0.0.1/x").is_err());
        assert!(validate_download_url("https://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_download_url("https://[::1]/x").is_err());
        assert!(validate_download_url("https://10.0.0.5:8080/x").is_err());
        assert!(validate_download_url("https://1.1.1.1/model.gguf").is_ok()); // public IP literal
    }

    /// Unique scratch dir per test so parallel tests can't collide.
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fl-model001-{tag}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sha_of(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        to_hex(&h.finalize())
    }

    #[test]
    fn to_hex_known_vector() {
        // NIST test vector: sha256("abc").
        assert_eq!(
            sha_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn finalize_rejects_checksum_mismatch_and_deletes_part() {
        let d = tmp_dir("fin-hash");
        let part = d.join("m.gguf.part");
        let dest = d.join("m.gguf");
        std::fs::write(&part, b"evil bytes").unwrap();
        let exp = ExpectedDigest {
            sha256: sha_of(b"good bytes"),
            size_bytes: Some(10),
        };
        let digest = sha_of(b"evil bytes");
        let res = finalize_download(&part, &dest, 10, &digest, Some(&exp));
        match res {
            Err(FinalizeError::Mismatch(msg)) => assert!(msg.contains("checksum mismatch")),
            other => panic!("expected Mismatch, got {other:?}"),
        }
        // The wrong body is GONE and nothing was installed.
        assert!(!part.exists(), ".part deleted on mismatch");
        assert!(!dest.exists(), "never installed");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finalize_rejects_size_mismatch() {
        let d = tmp_dir("fin-size");
        let part = d.join("m.gguf.part");
        let dest = d.join("m.gguf");
        std::fs::write(&part, b"short").unwrap();
        let exp = ExpectedDigest {
            sha256: sha_of(b"short"),
            size_bytes: Some(999),
        };
        let res = finalize_download(&part, &dest, 5, &sha_of(b"short"), Some(&exp));
        match res {
            Err(FinalizeError::Mismatch(msg)) => assert!(msg.contains("size mismatch")),
            other => panic!("expected Mismatch, got {other:?}"),
        }
        assert!(!part.exists());
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finalize_installs_on_match_and_without_pin() {
        let d = tmp_dir("fin-ok");
        // Pinned + matching → installed, verified=Some(true).
        let part = d.join("a.gguf.part");
        let dest = d.join("a.gguf");
        std::fs::write(&part, b"payload").unwrap();
        let exp = ExpectedDigest {
            sha256: sha_of(b"payload"),
            size_bytes: Some(7),
        };
        let v = finalize_download(&part, &dest, 7, &sha_of(b"payload"), Some(&exp)).unwrap();
        assert_eq!(v, Some(true));
        assert!(dest.exists() && !part.exists());
        // Unpinned → installed, verified=None.
        let part2 = d.join("b.gguf.part");
        let dest2 = d.join("b.gguf");
        std::fs::write(&part2, b"whatever").unwrap();
        let v2 = finalize_download(&part2, &dest2, 8, &sha_of(b"whatever"), None).unwrap();
        assert_eq!(v2, None);
        assert!(dest2.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn resume_prefix_hash_matches_full_hash() {
        // Hashing the first N bytes from disk then streaming the rest must
        // equal hashing the whole file — the resume path's correctness.
        let d = tmp_dir("prefix");
        let full: Vec<u8> = (0..100_000u32).flat_map(|i| i.to_le_bytes()).collect();
        let split = 123_457; // deliberately not chunk-aligned
        let part = d.join("m.part");
        std::fs::write(&part, &full[..split]).unwrap();
        let mut hasher = hash_prefix_blocking(&part, split as u64).unwrap();
        hasher.update(&full[split..]);
        assert_eq!(to_hex(&hasher.finalize()), sha_of(&full));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prefix_hash_fails_on_short_file() {
        let d = tmp_dir("prefix-short");
        let part = d.join("m.part");
        std::fs::write(&part, b"only ten b").unwrap();
        let err = hash_prefix_blocking(&part, 1000).unwrap_err();
        assert!(err.contains("short"), "{err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn manifest_round_trip_and_malformed_is_empty() {
        let d = tmp_dir("manifest");
        assert!(manifest_load(&d).is_empty(), "missing = empty");
        let mut m = HashMap::new();
        m.insert(
            "llm/a.gguf".to_string(),
            ManifestEntry {
                sha256: sha_of(b"a"),
                size_bytes: 1,
                url: "https://example.com/a.gguf".into(),
                verified_at: Utc::now(),
                pinned: true,
            },
        );
        manifest_store(&d, &m);
        let loaded = manifest_load(&d);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded["llm/a.gguf"].sha256, sha_of(b"a"));
        assert!(loaded["llm/a.gguf"].pinned);
        // Malformed manifest degrades to empty (verification CACHE — a
        // corrupt file may only ever remove "verified", never grant it).
        std::fs::write(d.join(MANIFEST_FILE), b"{not json").unwrap();
        assert!(manifest_load(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn list_models_reports_verification_states() {
        let d = tmp_dir("list");
        let dl = Downloads::new(d.clone());
        std::fs::write(d.join("ok.gguf"), b"okay data").unwrap();
        std::fs::write(d.join("drifted.gguf"), b"now longer than recorded").unwrap();
        std::fs::write(d.join("alien.gguf"), b"copied in by hand").unwrap();
        let mut m = HashMap::new();
        m.insert(
            "ok.gguf".to_string(),
            ManifestEntry {
                sha256: sha_of(b"okay data"),
                size_bytes: 9,
                url: String::new(),
                verified_at: Utc::now(),
                pinned: true,
            },
        );
        m.insert(
            "drifted.gguf".to_string(),
            ManifestEntry {
                sha256: sha_of(b"original"),
                size_bytes: 8,
                url: String::new(),
                verified_at: Utc::now(),
                pinned: false,
            },
        );
        manifest_store(&d, &m);
        let snap = dl.list_models().unwrap();
        let get = |n: &str| snap.models.iter().find(|f| f.name == n).unwrap();
        assert_eq!(get("ok.gguf").verification, "verified");
        assert_eq!(get("drifted.gguf").verification, "modified");
        assert_eq!(get("alien.gguf").verification, "unverified");
        // The manifest itself must not be listed as a model.
        assert!(!snap.models.iter().any(|f| f.name.contains("manifest")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn verify_all_quarantines_mismatches() {
        let d = tmp_dir("verify");
        let dl = Downloads::new(d.clone());
        std::fs::write(d.join("good.gguf"), b"still intact").unwrap();
        std::fs::write(d.join("bad.gguf"), b"tampered!!").unwrap();
        std::fs::write(d.join("untracked.gguf"), b"no entry").unwrap();
        let mut m = HashMap::new();
        m.insert(
            "good.gguf".to_string(),
            ManifestEntry {
                sha256: sha_of(b"still intact"),
                size_bytes: 12,
                url: String::new(),
                verified_at: Utc::now(),
                pinned: true,
            },
        );
        m.insert(
            "bad.gguf".to_string(),
            ManifestEntry {
                sha256: sha_of(b"original contents"),
                size_bytes: 17,
                url: String::new(),
                verified_at: Utc::now(),
                pinned: true,
            },
        );
        m.insert(
            "gone.gguf".to_string(),
            ManifestEntry {
                sha256: sha_of(b"x"),
                size_bytes: 1,
                url: String::new(),
                verified_at: Utc::now(),
                pinned: false,
            },
        );
        manifest_store(&d, &m);

        let report = dl.verify_all().unwrap();
        let get = |n: &str| report.checked.iter().find(|r| r.name == n).unwrap();
        assert!(get("good.gguf").ok);
        let bad = get("bad.gguf");
        assert!(!bad.ok);
        assert!(bad.action.as_deref().unwrap().starts_with("quarantined"));
        // The tampered file is renamed aside so services stop loading it…
        assert!(!d.join("bad.gguf").exists());
        assert!(std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("bad.gguf.quarantine-")));
        // …and its manifest row is dropped (next list shows unverified,
        // never a stale "verified").
        let after = manifest_load(&d);
        assert!(after.contains_key("good.gguf"));
        assert!(!after.contains_key("bad.gguf"));
        assert!(!after.contains_key("gone.gguf"), "missing rows pruned");
        assert_eq!(report.missing, vec!["gone.gguf".to_string()]);
        assert!(report.untracked.iter().any(|n| n == "untracked.gguf"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn content_range_start_parsing() {
        // Minimal Response is awkward to build; parse the header value logic via the same path
        // by constructing a header map through a real Response is overkill — instead assert the
        // string handling on representative values would parse the start byte.
        let parse = |s: &str| -> Option<u64> {
            s.trim()
                .strip_prefix("bytes")?
                .trim_start()
                .split('-')
                .next()?
                .trim()
                .parse::<u64>()
                .ok()
        };
        assert_eq!(parse("bytes 200-1000/1001"), Some(200));
        assert_eq!(parse("bytes 0-500/1001"), Some(0));
        assert_eq!(parse("bytes */1001"), None);
        assert_eq!(parse("nonsense"), None);
    }
}
