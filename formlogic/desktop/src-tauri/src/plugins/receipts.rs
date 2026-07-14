//! Durable per-plugin event receipts (audit INT-003).
//!
//! The host's half of the `eventAck` feature: every `event.emit` envelope
//! carrying an `idempotencyKey` is journaled to an append-only JSONL file —
//! flushed and fsynced — BEFORE the `event.ack` notification tells the plugin
//! it may stop re-delivering. The in-memory key set doubles as the dedupe
//! index, so a replayed envelope (plugin crash recovery, a lost ack) is
//! acknowledged again but never re-published to the event bus.
//!
//! Privacy (audit DATA-PRIV-001): envelopes carry transcripts, caller numbers
//! and SMS bodies, so with a [`JournalCrypto`] wired the payload is sealed
//! (`envEnc`) — a plaintext scan of the data dir recovers keys and
//! timestamps, never conversation content. Legacy plaintext lines are
//! re-sealed in place at open. Retention is TIME-based on top of the line
//! bound: entries older than [`default_retention`] (env-tunable, clamped) are
//! swept at open and by the dispatcher's periodic sweep — a low-volume
//! install ages out PII on the clock, not on line count. The rotation window
//! still caps disk use; the plugin's own outbox stops re-delivering an event
//! after its retry budget anyway, so a bounded dedupe window is safe.

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::journal_crypto::JournalCrypto;

pub const ROTATE_AT_LINES: usize = 20_000;
pub const ROTATE_KEEP_LINES: usize = 10_000;

/// Days a receipt stays journaled (dedupe + crash-recovery window). Must
/// exceed the plugin outbox's re-delivery horizon (7 days) so an unacked
/// replay is still recognised. Env `FORMLOGIC_JOURNAL_RECEIPTS_RETENTION_DAYS`
/// (clamped 1..=90).
pub const RECEIPTS_RETENTION_DAYS: i64 = 14;

/// The configured receipts retention as a duration.
pub fn default_retention() -> chrono::Duration {
    let days = std::env::var("FORMLOGIC_JOURNAL_RECEIPTS_RETENTION_DAYS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(RECEIPTS_RETENTION_DAYS)
        .clamp(1, 90);
    chrono::Duration::days(days)
}

/// The (possibly sealed) envelope carried by one journal line: plaintext
/// `event` (legacy / no-crypto) or sealed `envEnc`. `None` when the line has
/// no recoverable payload (markers, decryption failure, stripped records).
pub fn line_envelope(v: &Value, crypto: Option<&JournalCrypto>) -> Option<Value> {
    if let Some(e) = v.get("event").filter(|e| e.is_object()) {
        return Some(e.clone());
    }
    let sealed = v.get("envEnc").and_then(Value::as_str)?;
    crypto?.decrypt(sealed).filter(Value::is_object)
}

fn line_received_at(v: &Value) -> Option<DateTime<Utc>> {
    v.get("receivedAt")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptOutcome {
    /// First sighting: journaled durably — publish it, then ack.
    New,
    /// Already journaled (a replay): ack again, do NOT re-publish.
    Duplicate,
}

struct Inner {
    file: File,
    seen: HashSet<String>,
    lines: usize,
}

/// "Is this key's event durably accounted for elsewhere?" (WORK-DUR-001
/// item 6). True = the work ledger owns it (any status) or a processed
/// marker exists, so the receipt is droppable; false = this receipt is the
/// ONLY durable copy and every rotation/retention/clear pass must keep it.
pub type AccountedFn = dyn Fn(&str) -> bool + Send + Sync;

pub struct EventReceipts {
    path: PathBuf,
    rotate_at: usize,
    rotate_keep: usize,
    retention: chrono::Duration,
    crypto: Option<Arc<JournalCrypto>>,
    accounted: Mutex<Option<Arc<AccountedFn>>>,
    inner: Mutex<Inner>,
}

impl EventReceipts {
    /// Open (creating if needed) a PLAINTEXT journal — used for the
    /// processed-marker journal (keys only, no payloads) and legacy tests.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        Self::open_full(path, ROTATE_AT_LINES, ROTATE_KEEP_LINES, None)
    }

    /// Open a journal whose envelope payloads are sealed with `crypto`
    /// (`None` = the key stores failed; plaintext with a loud caller log).
    pub fn open_encrypted(
        path: PathBuf,
        crypto: Option<Arc<JournalCrypto>>,
    ) -> std::io::Result<Self> {
        Self::open_full(path, ROTATE_AT_LINES, ROTATE_KEEP_LINES, crypto)
    }

    /// [`open`](Self::open) with explicit rotation thresholds (tests).
    pub fn open_with_limits(
        path: PathBuf,
        rotate_at: usize,
        rotate_keep: usize,
    ) -> std::io::Result<Self> {
        Self::open_full(path, rotate_at, rotate_keep, None)
    }

    pub fn open_full(
        path: PathBuf,
        rotate_at: usize,
        rotate_keep: usize,
        crypto: Option<Arc<JournalCrypto>>,
    ) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut seen = HashSet::new();
        let mut lines = 0usize;
        let mut plaintext_payloads = false;
        if path.is_file() {
            let reader = BufReader::new(File::open(&path)?);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                lines += 1;
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(k) = v.get("key").and_then(Value::as_str) {
                        seen.insert(k.to_string());
                    }
                    if v.get("event").is_some_and(Value::is_object) {
                        plaintext_payloads = true;
                    }
                }
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let receipts = EventReceipts {
            path,
            rotate_at,
            rotate_keep,
            retention: default_retention(),
            crypto,
            accounted: Mutex::new(None),
            inner: Mutex::new(Inner { file, seen, lines }),
        };
        {
            let mut inner = receipts.inner.lock().expect("receipts lock");
            if inner.lines >= receipts.rotate_at {
                receipts.rotate(&mut inner)?;
            }
            // DATA-PRIV-001: age out expired entries at every open (time-based,
            // volume-independent) and re-seal any legacy plaintext payloads.
            let cutoff = Utc::now() - receipts.retention;
            if plaintext_payloads && receipts.crypto.is_some() {
                receipts.rewrite_retained(&mut inner, cutoff)?;
            } else {
                receipts.retain_since_locked(&mut inner, cutoff)?;
            }
        }
        Ok(receipts)
    }

    /// Durably journal one envelope. Returns [`ReceiptOutcome::Duplicate`]
    /// (without writing) when the key was already journaled. On `New`, the
    /// line is flushed AND fsynced before returning — only then may the
    /// caller acknowledge receipt to the plugin.
    pub fn record(&self, key: &str, envelope: &Value) -> std::io::Result<ReceiptOutcome> {
        let mut inner = self.inner.lock().expect("receipts lock");
        if inner.seen.contains(key) {
            return Ok(ReceiptOutcome::Duplicate);
        }
        let mut line = serde_json::json!({
            "key": key,
            "receivedAt": chrono::Utc::now().to_rfc3339(),
        });
        if envelope.is_object() {
            match self.crypto.as_ref().and_then(|c| c.encrypt(envelope)) {
                Some(sealed) => line["envEnc"] = Value::String(sealed),
                None if self.crypto.is_none() => line["event"] = envelope.clone(),
                // Crypto wired but sealing failed (exhausted entropy — never in
                // practice): journal the receipt WITHOUT the payload rather than
                // writing plaintext PII. Dedupe/ack still work; only the
                // crash-window recovery of this one envelope is lost.
                None => {}
            }
        }
        inner.file.write_all(line.to_string().as_bytes())?;
        inner.file.write_all(b"\n")?;
        inner.file.flush()?;
        inner.file.sync_data()?;
        inner.seen.insert(key.to_string());
        inner.lines += 1;
        if inner.lines >= self.rotate_at {
            self.rotate(&mut inner)?;
        }
        Ok(ReceiptOutcome::New)
    }

    /// Whether a key is already journaled (crash-recovery diff, audit FL-001).
    pub fn contains(&self, key: &str) -> bool {
        self.inner
            .lock()
            .map(|i| i.seen.contains(key))
            .unwrap_or(false)
    }

    /// How many receipts are currently journaled (diagnostics/tests).
    pub fn len(&self) -> usize {
        self.inner.lock().map(|i| i.seen.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Register the accountability guard (WORK-DUR-001 item 6): once set,
    /// rotation, retention and clear-history keep any entry that is NOT yet
    /// durably accounted for elsewhere, whatever its age or position — a
    /// receipt may be the only durable copy of an acked event.
    pub fn set_accounted_guard(&self, guard: Arc<AccountedFn>) {
        *self.accounted.lock().unwrap_or_else(|e| e.into_inner()) = Some(guard);
    }

    fn accounted_guard(&self) -> Option<Arc<AccountedFn>> {
        self.accounted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// True when the entry may be dropped: no guard registered (markers /
    /// standalone journals), or the guard confirms the key is accounted for.
    fn droppable(&self, key: Option<&str>) -> bool {
        match (self.accounted_guard(), key) {
            (Some(guard), Some(k)) => guard(k),
            (Some(_), None) => true, // keyless line: nothing to account
            (None, _) => true,
        }
    }

    /// Drop every ACCOUNTED entry older than `cutoff` (DATA-PRIV-001
    /// retention sweep / "clear history"). Entries that are the only durable
    /// copy of their event are kept regardless of age (WORK-DUR-001).
    /// Returns how many lines were removed.
    pub fn retain_since(&self, cutoff: DateTime<Utc>) -> std::io::Result<usize> {
        let mut inner = self.inner.lock().expect("receipts lock");
        self.retain_since_locked(&mut inner, cutoff)
    }

    fn retain_since_locked(
        &self,
        inner: &mut Inner,
        cutoff: DateTime<Utc>,
    ) -> std::io::Result<usize> {
        let all = self.read_lines()?;
        let kept: Vec<String> = all
            .iter()
            .filter(|l| {
                let Ok(v) = serde_json::from_str::<Value>(l) else {
                    return false; // unparsable lines can't be aged or replayed
                };
                let expired = line_received_at(&v).map_or(true, |at| at < cutoff);
                if !expired {
                    return true;
                }
                !self.droppable(v.get("key").and_then(Value::as_str))
            })
            .cloned()
            .collect();
        let removed = all.len().saturating_sub(kept.len());
        if removed > 0 {
            self.replace_journal(inner, &kept)?;
        }
        Ok(removed)
    }

    /// Full rewrite applying retention AND re-sealing legacy plaintext
    /// payloads under the wired crypto (one-time upgrade of pre-encryption
    /// journals — the live install's existing PII gets sealed at first boot).
    fn rewrite_retained(&self, inner: &mut Inner, cutoff: DateTime<Utc>) -> std::io::Result<()> {
        let all = self.read_lines()?;
        let mut kept: Vec<String> = Vec::with_capacity(all.len());
        for l in &all {
            let Ok(mut v) = serde_json::from_str::<Value>(l) else { continue };
            let Some(at) = line_received_at(&v) else { continue };
            if at < cutoff {
                continue;
            }
            if let (Some(crypto), Some(event)) = (
                self.crypto.as_deref(),
                v.get("event").filter(|e| e.is_object()).cloned(),
            ) {
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("event");
                    match crypto.encrypt(&event) {
                        Some(sealed) => {
                            obj.insert("envEnc".into(), Value::String(sealed));
                        }
                        None => { /* payload dropped rather than kept plaintext */ }
                    }
                }
                kept.push(v.to_string());
            } else {
                kept.push(l.clone());
            }
        }
        self.replace_journal(inner, &kept)
    }

    fn read_lines(&self) -> std::io::Result<Vec<String>> {
        match File::open(&self.path) {
            Ok(f) => Ok(BufReader::new(f).lines().map_while(Result::ok).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// Atomically replace the journal with `kept` lines (tmp+rename),
    /// rebuilding the seen set and reopening the append handle.
    fn replace_journal(&self, inner: &mut Inner, kept: &[String]) -> std::io::Result<()> {
        inner.file.flush()?;
        let tmp = self.path.with_extension("jsonl.tmp");
        {
            let mut out = File::create(&tmp)?;
            for line in kept {
                out.write_all(line.as_bytes())?;
                out.write_all(b"\n")?;
            }
            out.sync_data()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        let mut seen = HashSet::new();
        for line in kept {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(k) = v.get("key").and_then(Value::as_str) {
                    seen.insert(k.to_string());
                }
            }
        }
        inner.seen = seen;
        inner.lines = kept.len();
        inner.file = OpenOptions::new().append(true).open(&self.path)?;
        Ok(())
    }

    /// Rewrite the journal keeping the newest `rotate_keep` lines — PLUS
    /// every older entry that is not yet accounted for elsewhere
    /// (WORK-DUR-001 item 6: a backlog past the rotation window must never
    /// rotate away the only durable copy of an acked event).
    fn rotate(&self, inner: &mut Inner) -> std::io::Result<()> {
        inner.file.flush()?;
        let all = self.read_lines()?;
        let keep_from = all.len().saturating_sub(self.rotate_keep);
        let mut kept: Vec<String> = Vec::with_capacity(self.rotate_keep);
        for (i, line) in all.iter().enumerate() {
            if i >= keep_from {
                kept.push(line.clone());
                continue;
            }
            let key = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| v.get("key").and_then(Value::as_str).map(str::to_owned));
            if !self.droppable(key.as_deref()) {
                kept.push(line.clone());
            }
        }
        self.replace_journal(inner, &kept)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fl-receipts-{tag}-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    #[test]
    fn new_then_duplicate_then_survives_reopen() {
        let path = temp_path("dedupe");
        let r = EventReceipts::open(path.clone()).unwrap();
        let env = json!({"name": "aokie.call.incoming", "idempotencyKey": "k1"});
        assert_eq!(r.record("k1", &env).unwrap(), ReceiptOutcome::New);
        assert_eq!(r.record("k1", &env).unwrap(), ReceiptOutcome::Duplicate);
        assert_eq!(r.record("k2", &env).unwrap(), ReceiptOutcome::New);
        assert_eq!(r.len(), 2);
        drop(r);

        // A restarted desktop must still recognise the replayed keys —
        // that's the "crash after ACK" boundary: the plugin may re-deliver,
        // and the event must not be double-published.
        let r = EventReceipts::open(path.clone()).unwrap();
        assert_eq!(r.record("k1", &env).unwrap(), ReceiptOutcome::Duplicate);
        assert_eq!(r.record("k3", &env).unwrap(), ReceiptOutcome::New);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_tail_line_is_skipped_not_fatal() {
        let path = temp_path("corrupt");
        {
            let r = EventReceipts::open(path.clone()).unwrap();
            r.record("k1", &json!({"n": 1})).unwrap();
        }
        // Simulate a crash mid-append: a partial line at the tail.
        {
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{\"key\":\"half").unwrap();
        }
        let r = EventReceipts::open(path.clone()).unwrap();
        assert_eq!(
            r.record("k1", &json!({})).unwrap(),
            ReceiptOutcome::Duplicate
        );
        assert_eq!(r.record("k2", &json!({})).unwrap(), ReceiptOutcome::New);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rotation_bounds_the_journal_and_keeps_recent_keys() {
        let path = temp_path("rotate");
        let r = EventReceipts::open_with_limits(path.clone(), 10, 5).unwrap();
        for i in 0..10 {
            r.record(&format!("k{i}"), &json!({"i": i})).unwrap();
        }
        // Rotation happened at 10: newest 5 retained, oldest aged out.
        assert_eq!(
            r.record("k9", &json!({})).unwrap(),
            ReceiptOutcome::Duplicate,
            "newest key survives rotation"
        );
        assert_eq!(
            r.record("k0", &json!({})).unwrap(),
            ReceiptOutcome::New,
            "oldest key aged out of the dedupe window"
        );
        // And the window survives a reopen with the same limits.
        drop(r);
        let r = EventReceipts::open_with_limits(path.clone(), 10, 5).unwrap();
        assert_eq!(
            r.record("k9", &json!({})).unwrap(),
            ReceiptOutcome::Duplicate
        );
        let _ = std::fs::remove_file(&path);
    }

    // ── DATA-PRIV-001 ───────────────────────────────────────────────────────

    fn crypto() -> Arc<JournalCrypto> {
        Arc::new(JournalCrypto::from_key([9u8; 32]))
    }

    #[test]
    fn encrypted_journal_never_stores_plaintext_payloads() {
        let path = temp_path("sealed");
        let c = crypto();
        let r = EventReceipts::open_encrypted(path.clone(), Some(c.clone())).unwrap();
        let env = json!({
            "name": "aokie.sms.received",
            "payload": {"from": "+61400111222", "body": "the plumber said DISTINCTIVE-SECRET"}
        });
        r.record("k1", &env).unwrap();
        drop(r);

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("61400111222"), "phone number not on disk");
        assert!(!raw.contains("DISTINCTIVE-SECRET"), "SMS body not on disk");
        assert!(raw.contains("envEnc"), "payload is sealed");
        assert!(raw.contains("\"key\":\"k1\""), "dedupe key stays queryable");

        // The sealed payload reads back for crash recovery.
        let v: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(line_envelope(&v, Some(&c)).unwrap(), env);
        // Without the key there is no payload (and no crash).
        assert!(line_envelope(&v, None).is_none());

        // Dedupe survives a reopen of the encrypted journal.
        let r = EventReceipts::open_encrypted(path.clone(), Some(c)).unwrap();
        assert_eq!(r.record("k1", &env).unwrap(), ReceiptOutcome::Duplicate);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_plaintext_journal_is_resealed_at_open() {
        let path = temp_path("upgrade");
        {
            // A pre-encryption journal (the live install's shape).
            let r = EventReceipts::open(path.clone()).unwrap();
            r.record("old", &json!({"name": "aokie.call.ended", "payload": {"from": "+61400999888"}}))
                .unwrap();
        }
        assert!(std::fs::read_to_string(&path).unwrap().contains("61400999888"));

        let c = crypto();
        let r = EventReceipts::open_encrypted(path.clone(), Some(c.clone())).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("61400999888"), "legacy PII sealed at first boot");
        assert!(raw.contains("envEnc"));
        // Key survives the upgrade (dedupe intact), payload still recoverable.
        assert_eq!(r.record("old", &json!({})).unwrap(), ReceiptOutcome::Duplicate);
        let v: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(
            line_envelope(&v, Some(&c)).unwrap()["payload"]["from"],
            json!("+61400999888")
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn retention_sweep_ages_out_old_entries_on_the_clock() {
        let path = temp_path("ttl");
        let r = EventReceipts::open(path.clone()).unwrap();
        r.record("old", &json!({"n": 1})).unwrap();
        r.record("fresh", &json!({"n": 2})).unwrap();

        // Nothing expires "now"…
        assert_eq!(r.retain_since(Utc::now() - chrono::Duration::days(1)).unwrap(), 0);
        assert_eq!(r.len(), 2);
        // …but a cutoff in the future ages both out (time-based, no volume needed).
        assert_eq!(r.retain_since(Utc::now() + chrono::Duration::seconds(1)).unwrap(), 2);
        assert_eq!(r.len(), 0);
        assert_eq!(r.record("old", &json!({})).unwrap(), ReceiptOutcome::New, "aged key reusable");
        let _ = std::fs::remove_file(&path);
    }

    // ── WORK-DUR-001 ────────────────────────────────────────────────────────

    /// Item 6 acceptance: a backlog past the rotation window must never
    /// rotate away the only durable copy of an acked event — with the
    /// accountability guard set, unaccounted entries survive rotation
    /// whatever their age; accounted ones still age out.
    #[test]
    fn rotation_never_drops_unaccounted_entries() {
        let path = temp_path("guarded-rotate");
        let r = EventReceipts::open_with_limits(path.clone(), 10, 5).unwrap();
        // k0/k1 are NOT yet accounted for anywhere else.
        r.set_accounted_guard(Arc::new(|key: &str| key != "k0" && key != "k1"));
        for i in 0..10 {
            r.record(&format!("k{i}"), &json!({"i": i})).unwrap();
        }
        // Rotation ran at 10 lines. The newest 5 survive as usual…
        assert_eq!(r.record("k9", &json!({})).unwrap(), ReceiptOutcome::Duplicate);
        // …accounted old entries aged out…
        assert_eq!(r.record("k2", &json!({})).unwrap(), ReceiptOutcome::New);
        // …but the UNACCOUNTED old entries were kept: they are the only
        // durable copy of their events.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"key\":\"k0\""), "unaccounted k0 survives rotation");
        assert!(raw.contains("\"key\":\"k1\""), "unaccounted k1 survives rotation");
        let _ = std::fs::remove_file(&path);
    }

    /// Retention and clear-history honour the same guard: an expired entry
    /// that is not yet accounted for is kept, not aged out.
    #[test]
    fn retention_keeps_unaccounted_entries_whatever_their_age() {
        let path = temp_path("guarded-ttl");
        let r = EventReceipts::open(path.clone()).unwrap();
        r.record("accounted", &json!({"n": 1})).unwrap();
        r.record("unaccounted", &json!({"n": 2})).unwrap();
        r.set_accounted_guard(Arc::new(|key: &str| key == "accounted"));

        // A cutoff in the future expires BOTH — only the accounted one goes.
        let removed = r.retain_since(Utc::now() + chrono::Duration::seconds(1)).unwrap();
        assert_eq!(removed, 1);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"key\":\"accounted\""));
        assert!(raw.contains("\"key\":\"unaccounted\""), "sole durable copy kept");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn markers_journal_keeps_null_envelopes_lean() {
        // The processed-marker journal records (key, Null) — no payload field
        // at all, whatever the crypto wiring.
        let path = temp_path("markers");
        let r = EventReceipts::open_encrypted(path.clone(), Some(crypto())).unwrap();
        r.record("m1", &Value::Null).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("envEnc") && !raw.contains("\"event\""));
        assert!(raw.contains("\"key\":\"m1\""));
        let _ = std::fs::remove_file(&path);
    }
}
