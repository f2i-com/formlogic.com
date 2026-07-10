//! Durable per-plugin event receipts (audit INT-003).
//!
//! The host's half of the `eventAck` feature: every `event.emit` envelope
//! carrying an `idempotencyKey` is journaled to an append-only JSONL file —
//! flushed and fsynced — BEFORE the `event.ack` notification tells the plugin
//! it may stop re-delivering. The in-memory key set doubles as the dedupe
//! index, so a replayed envelope (plugin crash recovery, a lost ack) is
//! acknowledged again but never re-published to the event bus.
//!
//! The journal is a bounded window, not an archive: past
//! [`ROTATE_AT_LINES`] it is rewritten keeping the newest
//! [`ROTATE_KEEP_LINES`] entries. That bounds both disk use and PII
//! retention (transcript/SMS payloads — audit C-06); the plugin's own
//! outbox stops re-delivering an event after its retry budget anyway, so a
//! bounded dedupe window is safe.

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

pub const ROTATE_AT_LINES: usize = 20_000;
pub const ROTATE_KEEP_LINES: usize = 10_000;

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

pub struct EventReceipts {
    path: PathBuf,
    rotate_at: usize,
    rotate_keep: usize,
    inner: Mutex<Inner>,
}

impl EventReceipts {
    /// Open (creating if needed) the receipts journal, loading the seen-key
    /// set. A corrupt tail line (crash mid-append) is skipped, not fatal.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        Self::open_with_limits(path, ROTATE_AT_LINES, ROTATE_KEEP_LINES)
    }

    /// [`open`](Self::open) with explicit rotation thresholds (tests).
    pub fn open_with_limits(
        path: PathBuf,
        rotate_at: usize,
        rotate_keep: usize,
    ) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut seen = HashSet::new();
        let mut lines = 0usize;
        if path.is_file() {
            let reader = BufReader::new(File::open(&path)?);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                lines += 1;
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(k) = v.get("key").and_then(Value::as_str) {
                        seen.insert(k.to_string());
                    }
                }
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let receipts = EventReceipts {
            path,
            rotate_at,
            rotate_keep,
            inner: Mutex::new(Inner { file, seen, lines }),
        };
        {
            let mut inner = receipts.inner.lock().expect("receipts lock");
            if inner.lines >= receipts.rotate_at {
                receipts.rotate(&mut inner)?;
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
        let line = serde_json::json!({
            "key": key,
            "receivedAt": chrono::Utc::now().to_rfc3339(),
            "event": envelope,
        })
        .to_string();
        inner.file.write_all(line.as_bytes())?;
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

    /// How many receipts are currently journaled (diagnostics/tests).
    pub fn len(&self) -> usize {
        self.inner.lock().map(|i| i.seen.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Rewrite the journal keeping the newest `rotate_keep` lines
    /// (atomic tmp+rename), rebuilding the seen set from what remains.
    fn rotate(&self, inner: &mut Inner) -> std::io::Result<()> {
        inner.file.flush()?;
        let all: Vec<String> = match File::open(&self.path) {
            Ok(f) => BufReader::new(f).lines().map_while(Result::ok).collect(),
            Err(e) => return Err(e),
        };
        let keep_from = all.len().saturating_sub(self.rotate_keep);
        let kept = &all[keep_from..];
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
}
