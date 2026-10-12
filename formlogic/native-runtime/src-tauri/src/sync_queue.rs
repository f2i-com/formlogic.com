//! NATIVE-SEC-001 — the offline sync queue, partitioned by verified app
//! identity, encrypted at rest, and fail-closed on persistence errors.
//!
//! The old queue was a single global list: any verified origin could
//! enumerate, ack or fail EVERY app's queued submissions, payloads sat in
//! plaintext JSON, and a failed disk write still reported enqueue success.
//! This module fixes all three:
//!
//! * **Partitioning** — every item is stamped with the trust partition of
//!   the verified app that enqueued it (`origin|accountId|appId`, all from
//!   the SIGNED manifest — never from caller-supplied fields), and every
//!   operation is bound to the caller's current partition. App A can never
//!   see, deliver, ack or fail app B's items, even on the same origin.
//! * **Encryption at rest** — the queue file is sealed with
//!   XChaCha20-Poly1305 under a per-install key file in the app-data
//!   sandbox (`sync-queue.key`, 0600 on unix). This is the same
//!   sandbox-tier protection as the desktop journals' key-file fallback:
//!   it defeats plaintext scans, stray backups and accidental cloud sync
//!   of the queue file. If the key can't be provisioned the queue REFUSES
//!   to persist (fail-closed) rather than writing plaintext.
//! * **Fail-closed persistence** — every mutation persists (tmp + fsync +
//!   rename) BEFORE reporting success, and rolls its in-memory change back
//!   on failure. A caller that gets an id back knows the item is on disk;
//!   the web layer falls back to its browser IndexedDB queue on rejection.
//! * **Quotas** — per-partition item + byte caps so one app can't grow the
//!   file without bound.
//! * **Corruption quarantine** — an unreadable queue file is moved aside
//!   to `.corrupt-<ts>` (never silently discarded as an empty parse) and
//!   the recovery is surfaced to the operator via `recovered_corruption`.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Retryable failures an item is given before it is "failed": the same as the browser
/// queue's MAX_ATTEMPTS (offlineQueue.ts), so a submission is tried as often whichever queue
/// holds it. (It was 5; an item already "failed" stays so, a waiting one gets the rest.)
pub const MAX_SYNC_ATTEMPTS: u32 = 8;
/// Per-partition caps: a runaway app can fill its own budget, not the disk.
pub const MAX_ITEMS_PER_PARTITION: usize = 500;
pub const MAX_BYTES_PER_PARTITION: usize = 10 * 1024 * 1024;
pub const MAX_LAST_ERROR_BYTES: usize = 2048;
/// A failed item is never handed out by flush() again; the page lets the
/// person send it again (a fresh enqueue) or discard it (ack). One left
/// alone is removed this long after it failed (30 days, the same period as
/// the web queue's FAILED_RETENTION_MS and the server's idempotency keys),
/// so its answers do not stay on the device for good.
pub const FAILED_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

static QUEUE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Typed failure a queue mutation can surface to the bridge.
#[derive(Debug)]
pub enum QueueError {
    /// The partition hit its item/byte quota — the caller should fall back
    /// to another queue or surface the error; retrying won't help until
    /// items drain.
    Full(String),
    /// The mutation could NOT be persisted — the in-memory state was rolled
    /// back and nothing was recorded. Never reported as success.
    Persist(String),
}

/// The verified trust partition a queue operation is bound to. Built ONLY
/// from the caller's verified signed manifest (lib.rs), never from request
/// payload fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Partition {
    /// Full origin (scheme://host[:port]) the app was verified on.
    pub origin: String,
    /// Signed `accountId` (opaque owner hash); empty on older servers.
    pub account_id: String,
    /// Signed `appId`; falls back to the verified slug on older servers.
    pub app_id: String,
    /// The verified app slug (stamped onto items + used for POST grouping).
    pub app_slug: String,
    /// Signed `manifestVersion` — recorded on items for diagnostics; NOT
    /// part of the partition key (queued answers must survive a manifest
    /// update, or an app edit would orphan offline submissions).
    pub manifest_version: String,
}

impl Partition {
    pub fn key(&self) -> String {
        format!("{}|{}|{}", self.origin, self.account_id, self.app_id)
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub id: String,
    pub app_slug: String,
    pub form_id: String,
    pub idempotency_key: String,
    pub answers: Value,
    /// "pending" (retryable) | "failed" (terminal). Completed items are
    /// removed by ack.
    pub status: String,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub created_at: String,
    /// Trust partition key stamped at enqueue (NATIVE-SEC-001). Empty on
    /// rows that predate partitioning (legacy v1 files) — those are adopted
    /// by the first VERIFIED app whose slug matches (see `adopt_legacy`).
    #[serde(default)]
    pub partition: String,
    /// Signed manifest version of the app at enqueue time (diagnostics).
    #[serde(default)]
    pub manifest_version: String,
    /// When the item became "failed", in unix seconds; 0 while it is not
    /// failed. A failed item is removed FAILED_RETENTION_SECS after it.
    /// Absent (0) on items that failed before this was recorded: `sweep`
    /// stamps those with the time it first sees them.
    #[serde(default)]
    pub failed_at: u64,
    /// The account the page was signed in as when it queued the item, as the page gave it
    /// (`ownerUserId`, as in the browser queue): an account id, or null for a submission
    /// made signed out. The runtime cannot see the session, so the page stamps it and the
    /// page sends an item only while that account is signed in (nativeOfflineQueue.ts).
    /// Absent on items queued before this was recorded, or by a page that does not give
    /// it: those are sent by whichever account is signed in, as before.
    #[serde(
        default,
        rename = "ownerUserId",
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub owner_user_id: Option<Option<String>>,
}

/// Read a field that is there, null included, as `Some`, so a missing field (None, by
/// `default`) and a null one (`Some(None)`) stay apart.
fn present<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(d).map(Some)
}

impl SyncItem {
    /// Normalize an item enqueued from the web into a full queue record.
    /// Identity fields (`app_slug`, `partition`, `manifest_version`) come
    /// from the VERIFIED partition — a caller-supplied `appSlug` is
    /// ignored, so a page can't enqueue into another app's delivery path.
    fn from_incoming(v: &Value, p: &Partition) -> Self {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let id = s("id").filter(|x| !x.is_empty()).unwrap_or_else(gen_id);
        let idempotency_key = s("idempotencyKey")
            .filter(|x| !x.is_empty())
            .unwrap_or_else(|| id.clone());
        SyncItem {
            app_slug: p.app_slug.clone(),
            form_id: s("formId").unwrap_or_default(),
            idempotency_key,
            answers: v.get("answers").cloned().unwrap_or(Value::Null),
            status: "pending".into(),
            // A count past the cap means the same as the cap; `as u32` would wrap it instead.
            attempts: v.get("attempts").and_then(Value::as_u64).unwrap_or(0).min(MAX_SYNC_ATTEMPTS as u64)
                as u32,
            last_error: s("lastError"),
            created_at: s("createdAt").filter(|x| !x.is_empty()).unwrap_or_else(now_iso),
            partition: p.key(),
            manifest_version: p.manifest_version.clone(),
            failed_at: 0,
            owner_user_id: match v.get("ownerUserId") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(Value::String(owner)) => Some(Some(owner.clone())),
                Some(other) => Some(Some(other.to_string())),
            },
            id,
        }
    }
}

/// Current time in unix seconds.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn gen_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = QUEUE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("q_{millis}_{seq}")
}

/// Current UTC time as an RFC3339 string, dependency-free (Howard Hinnant's civil-from-days).
pub fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

// ---------------------------------------------------------------------------
// At-rest encryption
// ---------------------------------------------------------------------------

fn hex_encode(data: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

const KEY_FILE: &str = "sync-queue.key";

/// Write the queue key so that only its owner can read it from the moment the file exists:
/// created with mode 0600 on unix, never written first and narrowed after. A file already
/// there (a malformed key being replaced) is removed first, because a mode given when
/// opening applies only to a file being created. On Windows the file takes the app data
/// folder's permissions, which are the user's own.
fn write_key_file(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

pub struct QueueCrypto {
    cipher: XChaCha20Poly1305,
}

impl QueueCrypto {
    pub fn from_key(key: [u8; 32]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
        }
    }

    /// Load (or mint) the per-install queue key from `<dir>/sync-queue.key`.
    /// `None` = no usable key — the queue then refuses to persist rather
    /// than falling back to plaintext.
    pub fn open(dir: &Path) -> Option<Self> {
        let path = dir.join(KEY_FILE);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Some(bytes) = hex_decode(text.trim()) {
                if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    return Some(Self::from_key(key));
                }
            }
            eprintln!("[formlogic] sync-queue.key is malformed — rotating it");
        }
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).ok()?;
        let _ = std::fs::create_dir_all(dir);
        if let Err(e) = write_key_file(&path, &hex_encode(&key)) {
            eprintln!("[formlogic] sync-queue.key could not be written: {e}");
            return None;
        }
        Some(Self::from_key(key))
    }

    fn seal(&self, plaintext: &[u8]) -> Option<String> {
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).ok()?;
        let ct = self.cipher.encrypt(&XNonce::from(nonce), plaintext).ok()?;
        let mut out = Vec::with_capacity(24 + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Some(hex_encode(&out))
    }

    fn open_sealed(&self, sealed: &str) -> Option<Vec<u8>> {
        let raw = hex_decode(sealed)?;
        if raw.len() <= 24 {
            return None;
        }
        let (nonce, ct) = raw.split_at(24);
        let nonce: [u8; 24] = nonce.try_into().ok()?;
        self.cipher.decrypt(&XNonce::from(nonce), ct).ok()
    }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

pub struct PartitionedSyncQueue {
    path: PathBuf,
    /// `None` = key provisioning failed → every persist fails closed (the
    /// web layer then uses its browser queue).
    crypto: Option<QueueCrypto>,
    items: Mutex<Vec<SyncItem>>,
    /// Set when a corrupt queue file was quarantined at load — surfaced to
    /// the operator via the flush() result.
    pub recovered_corruption: Option<String>,
}

impl PartitionedSyncQueue {
    /// Load the queue: v2 sealed file → decrypt; legacy v1 plaintext array
    /// → migrate (re-persisted sealed on the next successful mutation);
    /// anything unreadable → quarantine aside and start empty.
    pub fn load(path: PathBuf, key_dir: &Path) -> Self {
        let crypto = QueueCrypto::open(key_dir);
        let mut recovered = None;
        let items: Vec<SyncItem> = match std::fs::read_to_string(&path) {
            Err(_) => Vec::new(), // missing = first run
            Ok(text) => {
                let parsed: Option<Vec<SyncItem>> = (|| {
                    let v: Value = serde_json::from_str(&text).ok()?;
                    if v.get("v").and_then(Value::as_u64) == Some(2) {
                        let sealed = v.get("sealed")?.as_str()?;
                        let pt = crypto.as_ref()?.open_sealed(sealed)?;
                        serde_json::from_slice(&pt).ok()
                    } else if v.is_array() {
                        // Legacy v1 plaintext queue — adopt as-is; rows have
                        // no partition and are adopted by slug on first use.
                        serde_json::from_value(v).ok()
                    } else {
                        None
                    }
                })();
                match parsed {
                    Some(items) => items,
                    None => {
                        // Unreadable ≠ empty: quarantine the bytes for the
                        // operator instead of silently discarding them.
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let mut q = path.as_os_str().to_owned();
                        q.push(format!(".corrupt-{ts}"));
                        let q = PathBuf::from(q);
                        let note = match std::fs::rename(&path, &q) {
                            Ok(()) => format!("corrupt queue quarantined to {}", q.display()),
                            Err(e) => format!("corrupt queue could not be quarantined: {e}"),
                        };
                        eprintln!("[formlogic] {note}");
                        recovered = Some(note);
                        Vec::new()
                    }
                }
            }
        };
        let queue = PartitionedSyncQueue {
            path,
            crypto,
            items: Mutex::new(items),
            recovered_corruption: recovered,
        };
        queue.sweep(&mut queue.items.lock().unwrap());
        queue
    }

    /// Retention, applied at load and on every read, across every partition
    /// (it is the runtime's own housekeeping, not something a page asks
    /// for): a failed item is removed FAILED_RETENTION_SECS after it failed.
    /// One that failed before `failed_at` was recorded is stamped now
    /// instead, so an upgrade never deletes an item nobody has been shown.
    /// Pending items are never removed for their age. Persisting is
    /// best-effort, as for `adopt_legacy`: a later write carries it.
    fn sweep(&self, items: &mut Vec<SyncItem>) {
        let now = now_secs();
        let mut changed = false;
        for it in items
            .iter_mut()
            .filter(|i| i.status == "failed" && i.failed_at == 0)
        {
            it.failed_at = now;
            changed = true;
        }
        let before = items.len();
        items.retain(|i| {
            !(i.status == "failed" && now.saturating_sub(i.failed_at) > FAILED_RETENTION_SECS)
        });
        if changed || items.len() != before {
            let _ = self.persist(items);
        }
    }

    /// Test constructor: a queue whose persistence always fails (no key).
    #[cfg(test)]
    pub fn without_crypto(path: PathBuf) -> Self {
        PartitionedSyncQueue {
            path,
            crypto: None,
            items: Mutex::new(Vec::new()),
            recovered_corruption: None,
        }
    }

    /// Seal + durably write the full item list (tmp + fsync + rename).
    /// An error means NOTHING was recorded — callers roll back memory.
    fn persist(&self, items: &[SyncItem]) -> Result<(), String> {
        let crypto = self
            .crypto
            .as_ref()
            .ok_or("queue encryption key unavailable — refusing to write plaintext")?;
        let plaintext =
            serde_json::to_vec(items).map_err(|e| format!("queue serialize failed: {e}"))?;
        let sealed = crypto.seal(&plaintext).ok_or("queue seal failed")?;
        let body = json!({ "v": 2, "sealed": sealed }).to_string();
        let tmp = self.path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)
                .map_err(|e| format!("queue write failed (create): {e}"))?;
            f.write_all(body.as_bytes())
                .map_err(|e| format!("queue write failed: {e}"))?;
            f.sync_data().map_err(|e| format!("queue fsync failed: {e}"))?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("queue rename failed: {e}")
        })
    }

    /// One-time adoption of legacy (pre-partitioning) rows: the first
    /// VERIFIED app whose slug matches claims them into its partition. The
    /// verification bar is the same one the old global queue's delivery
    /// path required; unclaimed rows stay inert (never cross-delivered).
    fn adopt_legacy(&self, items: &mut [SyncItem], p: &Partition) -> bool {
        let mut changed = false;
        for it in items
            .iter_mut()
            .filter(|i| i.partition.is_empty() && i.app_slug == p.app_slug)
        {
            it.partition = p.key();
            changed = true;
        }
        changed
    }

    /// Append an item for the caller's verified partition. Quota-checked;
    /// persisted (fail-closed) before the id is returned.
    pub fn enqueue(&self, p: &Partition, incoming: &Value) -> Result<String, QueueError> {
        let mut items = self.items.lock().unwrap();
        let item = SyncItem::from_incoming(incoming, p);

        let pkey = p.key();
        let mine: Vec<&SyncItem> = items.iter().filter(|i| i.partition == pkey).collect();
        if mine.len() >= MAX_ITEMS_PER_PARTITION {
            return Err(QueueError::Full(format!(
                "offline queue is full for this app ({MAX_ITEMS_PER_PARTITION} items) — sync or clear it first"
            )));
        }
        let bytes: usize = mine
            .iter()
            .map(|i| serde_json::to_string(i).map(|s| s.len()).unwrap_or(0))
            .sum::<usize>()
            + serde_json::to_string(&item).map(|s| s.len()).unwrap_or(0);
        if bytes > MAX_BYTES_PER_PARTITION {
            return Err(QueueError::Full(format!(
                "offline queue byte budget exhausted for this app ({MAX_BYTES_PER_PARTITION} bytes) — sync or clear it first"
            )));
        }

        let id = item.id.clone();
        items.push(item);
        if let Err(e) = self.persist(&items) {
            items.pop(); // fail-closed: never report an id the disk doesn't hold
            return Err(QueueError::Persist(e));
        }
        Ok(id)
    }

    /// The caller's partition view (legacy rows adopted first).
    pub fn get_queue(&self, p: &Partition) -> Vec<SyncItem> {
        let mut items = self.items.lock().unwrap();
        if self.adopt_legacy(&mut items, p) {
            let _ = self.persist(&items); // adoption is re-derivable — best-effort
        }
        self.sweep(&mut items);
        let pkey = p.key();
        items.iter().filter(|i| i.partition == pkey).cloned().collect()
    }

    /// Pending items of the caller's partition, grouped by appSlug (single
    /// group in practice — the shape predates partitioning). Read-only:
    /// never mutates attempts, never removes items.
    pub fn flush(&self, p: &Partition) -> Value {
        let mut items = self.items.lock().unwrap();
        if self.adopt_legacy(&mut items, p) {
            let _ = self.persist(&items);
        }
        self.sweep(&mut items);
        let pkey = p.key();
        let mut by_slug: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for it in items
            .iter()
            .filter(|i| i.partition == pkey && i.status == "pending")
        {
            by_slug
                .entry(it.app_slug.clone())
                .or_default()
                .push(serde_json::to_value(it).unwrap_or(Value::Null));
        }
        let pending: Vec<Value> = by_slug
            .into_iter()
            .map(|(slug, group)| json!({ "appSlug": slug, "items": group }))
            .collect();
        let mut out = json!({ "pending": pending });
        if let Some(note) = &self.recovered_corruption {
            out["corruptionRecovered"] = Value::String(note.clone());
        }
        out
    }

    /// Remove the given ids — but ONLY within the caller's partition. Ids
    /// belonging to other apps are untouched (and not counted).
    pub fn ack(&self, p: &Partition, ids: &[String]) -> Result<Value, QueueError> {
        let mut items = self.items.lock().unwrap();
        let snapshot = items.clone();
        let set: HashSet<&String> = ids.iter().collect();
        let pkey = p.key();
        let before = items.len();
        items.retain(|i| !(i.partition == pkey && set.contains(&i.id)));
        let removed = before - items.len();
        if removed > 0 {
            if let Err(e) = self.persist(&items) {
                *items = snapshot; // fail-closed: an unpersisted ack never reports success
                return Err(QueueError::Persist(e));
            }
        }
        let remaining = items.iter().filter(|i| i.partition == pkey).count();
        Ok(json!({ "acked": removed, "remaining": remaining }))
    }

    /// Record a failure for the given ids — ONLY within the caller's
    /// partition. Non-terminal failures burn one attempt (terminal at
    /// MAX_SYNC_ATTEMPTS); `terminal` marks "failed" immediately.
    pub fn fail(
        &self,
        p: &Partition,
        ids: &[String],
        error: &str,
        terminal: bool,
    ) -> Result<Value, QueueError> {
        let mut items = self.items.lock().unwrap();
        let snapshot = items.clone();
        let set: HashSet<&String> = ids.iter().collect();
        let pkey = p.key();
        // The message is the page's text and is written onto every named item, after the
        // byte quota was judged at enqueue: keep its start, cut on a character boundary.
        let mut cut = error.len().min(MAX_LAST_ERROR_BYTES);
        while !error.is_char_boundary(cut) {
            cut -= 1;
        }
        let error = &error[..cut];
        let mut n = 0;
        for it in items
            .iter_mut()
            .filter(|i| i.partition == pkey && set.contains(&i.id))
        {
            it.last_error = Some(error.to_string());
            let was_failed = it.status == "failed";
            if terminal {
                it.status = "failed".into();
            } else {
                it.attempts = it.attempts.saturating_add(1);
                if it.attempts >= MAX_SYNC_ATTEMPTS {
                    it.status = "failed".into();
                }
            }
            if it.status == "failed" && !was_failed {
                it.failed_at = now_secs();
            }
            n += 1;
        }
        if n > 0 {
            if let Err(e) = self.persist(&items) {
                *items = snapshot;
                return Err(QueueError::Persist(e));
            }
        }
        Ok(json!({ "failed": n }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fl-squeue-{tag}-{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn part(origin: &str, account: &str, app: &str, slug: &str) -> Partition {
        Partition {
            origin: origin.into(),
            account_id: account.into(),
            app_id: app.into(),
            app_slug: slug.into(),
            manifest_version: "v1".into(),
        }
    }

    fn load(dir: &Path) -> PartitionedSyncQueue {
        PartitionedSyncQueue::load(dir.join("sync-queue.json"), dir)
    }

    fn legacy_crypto_fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/sync-queue-v2-libsodium.json")).unwrap()
    }

    #[test]
    fn xchacha20poly1305_preserves_the_existing_libsodium_wire_format() {
        // This ciphertext comes from PHP libsodium, not from the upgraded
        // Rust implementation. The format remains nonce || ciphertext || tag,
        // hex encoded, with a 32-byte key and no additional authenticated data.
        let fixture = legacy_crypto_fixture();
        let key: [u8; 32] = hex_decode(fixture["key"].as_str().unwrap()).unwrap().try_into().unwrap();
        let nonce: [u8; 24] = hex_decode(fixture["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
        let plaintext = fixture["plaintext"].as_str().unwrap().as_bytes();
        let sealed = fixture["queue"]["sealed"].as_str().unwrap();
        let crypto = QueueCrypto::from_key(key);
        assert_eq!(crypto.open_sealed(sealed).unwrap(), plaintext);
        let encrypted = crypto.cipher.encrypt(&XNonce::from(nonce), plaintext).unwrap();
        assert_eq!(hex_encode(&[nonce.as_slice(), encrypted.as_slice()].concat()), sealed);

        let mut damaged = hex_decode(sealed).unwrap();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(crypto.open_sealed(&hex_encode(&damaged)).is_none());
        assert!(QueueCrypto::from_key([8u8; 32]).open_sealed(sealed).is_none());
    }

    #[test]
    fn existing_v2_queue_reopens_and_resaves_without_rotating_its_key() {
        let fixture = legacy_crypto_fixture();
        let dir = tmp("crypto-upgrade");
        let key = fixture["key"].as_str().unwrap();
        std::fs::write(dir.join(KEY_FILE), key).unwrap();
        std::fs::write(dir.join("sync-queue.json"), fixture["queue"].to_string()).unwrap();
        let partition = part("https://example.test", "account", "app", "demo");
        let queue = load(&dir);
        assert!(queue.recovered_corruption.is_none());
        let items = queue.get_queue(&partition);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "legacy-item");
        assert_eq!(items[0].answers["message"], "Saved before dependency upgrade");
        queue.enqueue(&partition, &json!({"id": "after-upgrade", "answers": {"quantity": 2}})).unwrap();
        let reopened = load(&dir);
        assert!(reopened.recovered_corruption.is_none());
        assert_eq!(reopened.get_queue(&partition).len(), 2);
        assert_eq!(std::fs::read_to_string(dir.join(KEY_FILE)).unwrap(), key);
        let persisted: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("sync-queue.json")).unwrap()).unwrap();
        assert_eq!(persisted["v"], 2);
        assert!(persisted["sealed"].is_string());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn partitions_isolate_apps_even_on_one_origin() {
        let dir = tmp("iso");
        let q = load(&dir);
        let a = part("https://formlogic.com", "acct1", "app-a", "alpha");
        let b = part("https://formlogic.com", "acct1", "app-b", "beta");

        let id_a = q
            .enqueue(&a, &json!({ "formId": "f1", "answers": { "secret": "alpha data" } }))
            .unwrap();
        q.enqueue(&b, &json!({ "formId": "f2", "answers": { "x": 1 } })).unwrap();

        // App B cannot SEE app A's items…
        assert_eq!(q.get_queue(&b).len(), 1);
        assert!(q.get_queue(&b).iter().all(|i| i.app_slug == "beta"));
        let flushed_b = q.flush(&b);
        assert_eq!(flushed_b["pending"].as_array().unwrap().len(), 1);
        assert_eq!(flushed_b["pending"][0]["appSlug"], "beta");

        // …cannot ACK them (steal-complete)…
        let res = q.ack(&b, &[id_a.clone()]).unwrap();
        assert_eq!(res["acked"], 0);
        assert_eq!(q.get_queue(&a).len(), 1, "app A's item survives app B's ack");

        // …and cannot FAIL them (burn attempts / terminal-kill).
        q.fail(&b, &[id_a.clone()], "sabotage", true).unwrap();
        let a_items = q.get_queue(&a);
        assert_eq!(a_items[0].status, "pending");
        assert_eq!(a_items[0].attempts, 0);

        // The owner still can.
        let res = q.ack(&a, &[id_a]).unwrap();
        assert_eq!(res["acked"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enqueue_stamps_verified_identity_ignoring_caller_slug() {
        let dir = tmp("stamp");
        let q = load(&dir);
        let p = part("https://x.example", "acct", "app-1", "real-slug");
        // The caller claims another app's slug — the VERIFIED slug wins.
        q.enqueue(&p, &json!({ "appSlug": "someone-elses-app", "formId": "f", "answers": {} }))
            .unwrap();
        let items = q.get_queue(&p);
        assert_eq!(items[0].app_slug, "real-slug");
        assert_eq!(items[0].partition, p.key());
        assert_eq!(items[0].manifest_version, "v1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persist_failure_rolls_back_and_reports_error() {
        // No crypto key → every persist fails. The mutation must NOT be
        // observable afterwards (fail-closed: no id without a durable row).
        let dir = tmp("failclosed");
        let q = PartitionedSyncQueue::without_crypto(dir.join("sync-queue.json"));
        let p = part("https://x.example", "a", "app", "slug");
        match q.enqueue(&p, &json!({ "formId": "f", "answers": { "v": 1 } })) {
            Err(QueueError::Persist(e)) => assert!(e.contains("key unavailable"), "{e}"),
            other => panic!("expected Persist error, got {other:?}"),
        }
        assert_eq!(q.get_queue(&p).len(), 0, "rolled back");
        assert!(!dir.join("sync-queue.json").exists(), "nothing written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quotas_bound_the_partition() {
        let dir = tmp("quota");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        // Byte quota: one huge item blows the byte budget.
        let huge = "x".repeat(MAX_BYTES_PER_PARTITION);
        match q.enqueue(&p, &json!({ "formId": "f", "answers": { "blob": huge } })) {
            Err(QueueError::Full(e)) => assert!(e.contains("byte budget"), "{e}"),
            other => panic!("expected Full, got {other:?}"),
        }
        // Another partition is unaffected by a full one.
        let other = part("https://x.example", "a", "other-app", "other");
        assert!(q.enqueue(&other, &json!({ "formId": "f", "answers": {} })).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_message_cannot_outgrow_the_byte_quota() {
        // The byte quota is judged when an item is queued. What a later `fail` writes onto
        // the item is the page's text too, and is held to a size of its own.
        let dir = tmp("lasterror");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        let id = q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();
        let long = "é".repeat(1024 * 1024);
        q.fail(&p, &[id.clone()], &long, false).unwrap();
        let kept = q.get_queue(&p)[0].last_error.clone().unwrap();
        assert!(kept.len() <= MAX_LAST_ERROR_BYTES, "kept {} bytes", kept.len());
        assert!(kept.starts_with("ééé"));
        // A short message is kept whole.
        q.fail(&p, &[id], "HTTP 503", false).unwrap();
        assert_eq!(q.get_queue(&p)[0].last_error.as_deref(), Some("HTTP 503"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_attempt_count_from_the_page_cannot_overflow() {
        let dir = tmp("attempts-max");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        for claimed in [json!(u32::MAX), json!(u64::MAX), json!(4_294_967_296u64)] {
            let id = q
                .enqueue(&p, &json!({ "formId": "f", "answers": {}, "attempts": claimed }))
                .unwrap();
            // One more failure ends the item; it does not wrap round to a fresh one.
            q.fail(&p, &[id.clone()], "boom", false).unwrap();
            let item = q.get_queue(&p).into_iter().find(|i| i.id == id).unwrap();
            assert_eq!(item.status, "failed", "attempts claimed as {claimed}");
            assert!(item.attempts >= MAX_SYNC_ATTEMPTS, "attempts claimed as {claimed}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn item_count_quota() {
        let dir = tmp("count");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        for _ in 0..MAX_ITEMS_PER_PARTITION {
            q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();
        }
        match q.enqueue(&p, &json!({ "formId": "f", "answers": {} })) {
            Err(QueueError::Full(_)) => {}
            other => panic!("expected Full, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn queue_file_is_sealed_at_rest_and_round_trips() {
        let dir = tmp("sealed");
        let q = load(&dir);
        let p = part("https://x.example", "acct", "app", "slug");
        q.enqueue(
            &p,
            &json!({ "formId": "f", "answers": { "phone": "0400-SECRET-123" } }),
        )
        .unwrap();
        // The raw file must not contain the plaintext answer.
        let raw = std::fs::read_to_string(dir.join("sync-queue.json")).unwrap();
        assert!(!raw.contains("SECRET"), "answers must be sealed at rest");
        assert!(raw.contains("\"v\":2"));
        // A fresh load (same key dir) recovers the items.
        drop(q);
        let q2 = load(&dir);
        let items = q2.get_queue(&p);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].answers["phone"], "0400-SECRET-123");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_queue_is_quarantined_not_discarded() {
        let dir = tmp("corrupt");
        std::fs::write(dir.join("sync-queue.json"), b"{ not json at all").unwrap();
        let q = load(&dir);
        assert!(q.recovered_corruption.is_some());
        // The bytes were preserved aside…
        let quarantined = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined, "corrupt file moved aside");
        // …and flush surfaces the recovery to the caller.
        let p = part("https://x.example", "a", "app", "slug");
        let out = q.flush(&p);
        assert!(out["corruptionRecovered"].as_str().unwrap().contains("quarantined"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_v1_rows_adopted_only_by_matching_verified_slug() {
        let dir = tmp("legacy");
        // A pre-partitioning plaintext queue with rows for two apps.
        let legacy = json!([
            { "id": "L1", "appSlug": "alpha", "formId": "f", "idempotencyKey": "k1",
              "answers": { "a": 1 }, "status": "pending", "attempts": 0,
              "lastError": null, "createdAt": "2026-01-01T00:00:00Z" },
            { "id": "L2", "appSlug": "beta", "formId": "f", "idempotencyKey": "k2",
              "answers": { "b": 2 }, "status": "pending", "attempts": 0,
              "lastError": null, "createdAt": "2026-01-01T00:00:00Z" }
        ]);
        std::fs::write(dir.join("sync-queue.json"), legacy.to_string()).unwrap();
        let q = load(&dir);
        let alpha = part("https://x.example", "acct", "app-alpha", "alpha");
        // Verified 'alpha' adopts ONLY its own legacy row.
        let mine = q.get_queue(&alpha);
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].id, "L1");
        assert_eq!(mine[0].partition, alpha.key());
        // The beta row stays unadopted (invisible to alpha), preserved on disk.
        drop(q);
        let q2 = load(&dir);
        let beta = part("https://x.example", "acct", "app-beta", "beta");
        let theirs = q2.get_queue(&beta);
        assert_eq!(theirs.len(), 1);
        assert_eq!(theirs[0].id, "L2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_item_records_when_it_failed() {
        let dir = tmp("failed-at");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        let id = q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();
        q.fail(&p, &[id.clone()], "boom", false).unwrap();
        assert_eq!(q.get_queue(&p)[0].failed_at, 0, "still pending: no failure time");
        let before = now_secs();
        q.fail(&p, &[id.clone()], "conflict", true).unwrap();
        let item = q.get_queue(&p).remove(0);
        assert_eq!(item.status, "failed");
        assert!(item.failed_at >= before, "stamped when it failed");
        // The page reads it as `failedAt`.
        assert_eq!(serde_json::to_value(&item).unwrap()["failedAt"], json!(item.failed_at));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_item_is_removed_after_the_retention_period_and_a_pending_one_never() {
        let dir = tmp("retention");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        let other = part("https://x.example", "a", "other-app", "other");
        let old = q.enqueue(&p, &json!({ "formId": "f", "answers": { "v": 1 } })).unwrap();
        let young = q.enqueue(&p, &json!({ "formId": "f", "answers": { "v": 2 } })).unwrap();
        let waiting = q.enqueue(&p, &json!({ "formId": "f", "answers": { "v": 3 }, "createdAt": "2020-01-01T00:00:00Z" })).unwrap();
        let elsewhere = q.enqueue(&other, &json!({ "formId": "f", "answers": { "v": 4 } })).unwrap();
        q.fail(&p, &[old.clone(), young.clone()], "conflict", true).unwrap();
        q.fail(&other, &[elsewhere.clone()], "conflict", true).unwrap();
        {
            let mut items = q.items.lock().unwrap();
            let now = now_secs();
            for it in items.iter_mut() {
                if it.id == old || it.id == elsewhere {
                    it.failed_at = now - FAILED_RETENTION_SECS - 1;
                }
                if it.id == young {
                    it.failed_at = now - FAILED_RETENTION_SECS + 3600;
                }
            }
            q.persist(&items).unwrap();
        }
        // Swept on every read, and from every app's partition, not only the caller's.
        let ids: Vec<String> = q.get_queue(&p).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![young.clone(), waiting.clone()]);
        assert!(q.get_queue(&other).is_empty());
        // And for good: a fresh load of the file does not bring them back.
        drop(q);
        let reopened = load(&dir);
        let ids: Vec<String> = reopened.get_queue(&p).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![young, waiting]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_item_stored_before_failure_times_were_kept_gets_the_whole_period_from_now() {
        let dir = tmp("legacy-failed");
        // Today's shape: no failedAt, created long ago.
        let legacy = json!([
            { "id": "L1", "appSlug": "slug", "formId": "f", "idempotencyKey": "k1",
              "answers": { "a": 1 }, "status": "failed", "attempts": 5,
              "lastError": "Server error (500)", "createdAt": "2025-01-01T00:00:00Z" },
            { "id": "L2", "appSlug": "slug", "formId": "f", "idempotencyKey": "k2",
              "answers": { "b": 2 }, "status": "pending", "attempts": 1,
              "lastError": null, "createdAt": "2025-01-01T00:00:00Z" }
        ]);
        std::fs::write(dir.join("sync-queue.json"), legacy.to_string()).unwrap();
        let before = now_secs();
        let q = load(&dir);
        let p = part("https://x.example", "acct", "app", "slug");
        let items = q.get_queue(&p);
        assert_eq!(items.len(), 2, "neither is removed by the upgrade");
        let failed = items.iter().find(|i| i.id == "L1").unwrap();
        assert!(failed.failed_at >= before, "its retention starts now");
        assert_eq!(items.iter().find(|i| i.id == "L2").unwrap().failed_at, 0);
        // The stamp is kept, so the clock does not restart on every launch.
        drop(q);
        let reopened = load(&dir);
        let again = reopened.get_queue(&p).into_iter().find(|i| i.id == "L1").unwrap();
        assert!(again.failed_at >= before && again.failed_at <= now_secs());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_item_queued_again_by_the_page_is_a_new_pending_item_with_its_key_and_time() {
        // What the page's "Send again" does (nativeOfflineQueue.ts retryNativeSubmission): queue it
        // afresh with no id, then ack the failed one.
        let dir = tmp("requeue");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        let id = q
            .enqueue(&p, &json!({ "formId": "f", "idempotencyKey": "k1", "answers": { "v": 1 }, "createdAt": "2026-10-01T09:30:00Z" }))
            .unwrap();
        q.fail(&p, &[id.clone()], "conflict", true).unwrap();
        let fresh = q
            .enqueue(&p, &json!({ "formId": "f", "idempotencyKey": "k1", "answers": { "v": 1 }, "attempts": 0, "createdAt": "2026-10-01T09:30:00Z" }))
            .unwrap();
        assert_ne!(fresh, id);
        assert_eq!(q.ack(&p, &[id]).unwrap()["acked"], 1);
        let items = q.get_queue(&p);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, fresh);
        assert_eq!(items[0].status, "pending");
        assert_eq!(items[0].attempts, 0);
        assert_eq!(items[0].failed_at, 0);
        assert_eq!(items[0].idempotency_key, "k1");
        assert_eq!(items[0].created_at, "2026-10-01T09:30:00Z");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_item_keeps_the_account_the_page_stamped_on_it_and_an_older_item_keeps_having_none() {
        // The browser queue's three shapes (offlineQueue.ts QueuedSubmission.ownerUserId): an
        // account, null for a submission made signed out, and absent on items from before
        // items carried an owner, which any account may send, as today.
        let dir = tmp("owner");
        let legacy = json!([
            { "id": "L1", "appSlug": "slug", "formId": "f", "idempotencyKey": "k0",
              "answers": { "a": 1 }, "status": "pending", "attempts": 0,
              "lastError": null, "createdAt": "2026-01-01T00:00:00Z" }
        ]);
        std::fs::write(dir.join("sync-queue.json"), legacy.to_string()).unwrap();
        let q = load(&dir);
        let p = part("https://x.example", "acct", "app", "slug");
        let mine = q.enqueue(&p, &json!({ "formId": "f", "answers": {}, "ownerUserId": "u1" })).unwrap();
        let anonymous = q.enqueue(&p, &json!({ "formId": "f", "answers": {}, "ownerUserId": null })).unwrap();
        let unstamped = q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();
        drop(q);
        let reopened = load(&dir);
        let shapes: BTreeMap<String, Value> = reopened
            .get_queue(&p)
            .into_iter()
            .map(|i| {
                let v = serde_json::to_value(&i).unwrap();
                (i.id.clone(), v.get("ownerUserId").cloned().unwrap_or(json!("(absent)")))
            })
            .collect();
        assert_eq!(shapes[&mine], json!("u1"));
        assert_eq!(shapes[&anonymous], Value::Null);
        assert_eq!(shapes[&unstamped], json!("(absent)"));
        assert_eq!(shapes["L1"], json!("(absent)"));
        // flush() hands the owner to the page with the item, which sends it only under that account.
        let flushed = reopened.flush(&p);
        let owners: Vec<Value> = flushed["pending"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i.get("ownerUserId").cloned().unwrap_or(json!("(absent)")))
            .collect();
        assert!(owners.contains(&json!("u1")) && owners.contains(&Value::Null));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_item_is_given_as_many_attempts_as_the_browser_queue_gives_one() {
        // offlineQueue.ts MAX_ATTEMPTS: 8.
        let dir = tmp("attempts-8");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        let id = q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();
        for _ in 0..7 {
            q.fail(&p, &[id.clone()], "HTTP 500", false).unwrap();
        }
        assert_eq!(q.get_queue(&p)[0].status, "pending", "seven failures leave it waiting");
        q.fail(&p, &[id], "HTTP 500", false).unwrap();
        assert_eq!(q.get_queue(&p)[0].status, "failed");
        assert_eq!(q.get_queue(&p)[0].attempts, 8);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_queue_key_is_only_ever_readable_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("key-mode");
        let path = dir.join(KEY_FILE);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        // Created owner-only: the file is never there with wider permissions to be narrowed later.
        write_key_file(&path, "00").unwrap();
        assert_eq!(mode(&path), 0o600);
        // A malformed key left readable by others is replaced by a new owner-only file: a mode
        // given when opening applies only to a file being created.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(&path, "not a key").unwrap();
        assert!(QueueCrypto::open(&dir).is_some());
        assert_eq!(mode(&path), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_queue_key_is_replaced_by_a_working_one() {
        let dir = tmp("key-rotate");
        std::fs::write(dir.join(KEY_FILE), "not a key").unwrap();
        assert!(QueueCrypto::open(&dir).is_some());
        let text = std::fs::read_to_string(dir.join(KEY_FILE)).unwrap();
        assert_eq!(hex_decode(text.trim()).map(|k| k.len()), Some(32));
        // And it is the key the next start reads.
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();
        drop(q);
        assert_eq!(load(&dir).get_queue(&p).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attempt_and_terminal_semantics_preserved() {
        let dir = tmp("attempts");
        let q = load(&dir);
        let p = part("https://x.example", "a", "app", "slug");
        let id = q.enqueue(&p, &json!({ "formId": "f", "answers": {} })).unwrap();

        // flush is attempt-neutral.
        for _ in 0..(MAX_SYNC_ATTEMPTS * 2) {
            q.flush(&p);
        }
        assert_eq!(q.get_queue(&p)[0].attempts, 0);

        // Retryable failures burn attempts; the cap promotes to terminal.
        for i in 1..MAX_SYNC_ATTEMPTS {
            q.fail(&p, &[id.clone()], "boom", false).unwrap();
            assert_eq!(q.get_queue(&p)[0].attempts, i);
            assert_eq!(q.get_queue(&p)[0].status, "pending");
        }
        q.fail(&p, &[id.clone()], "boom", false).unwrap();
        assert_eq!(q.get_queue(&p)[0].status, "failed");
        assert_eq!(q.flush(&p)["pending"].as_array().unwrap().len(), 0);

        // Terminal fail marks immediately.
        let id2 = q.enqueue(&p, &json!({ "formId": "f2", "answers": {} })).unwrap();
        q.fail(&p, &[id2.clone()], "conflict", true).unwrap();
        let it = q.get_queue(&p).into_iter().find(|i| i.id == id2).unwrap();
        assert_eq!(it.status, "failed");
        assert_eq!(it.attempts, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
