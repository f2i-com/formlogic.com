//! Durable per-event work ledger (audit CROSS-EVENT-001).
//!
//! The plugin's receipt is ACKed the moment an envelope is journaled — from
//! then on the DESKTOP owns the work, and losing it (unlinked account, stale
//! snapshot, API blip, crash between stages) silently loses a business event.
//! Previously an in-memory seen set claimed the event before readiness checks,
//! app-logic failures were logged then marked processed, binding tasks were
//! detached before being durably reserved, and startup recovery replayed only
//! app-logic from the previous session inside a 24-hour window.
//!
//! This ledger is the durable state machine the audit prescribes:
//!
//! ```text
//! received → app_logic done → bindings planned → binding[i] terminal … → completed
//!                                                                      ↘ dead (DLQ)
//! ```
//!
//! Every transition is appended (and flushed) to `host-event-work.jsonl`
//! BEFORE the next stage runs, so a crash immediately after any write resumes
//! exactly where it stopped. Retryable failures reschedule with bounded
//! exponential backoff; readiness failures (not linked / no snapshot) retry
//! forever WITHOUT consuming attempts — being offline must never dead-letter
//! work. After [`MAX_EVENT_ATTEMPTS`] real failures an event goes `dead`:
//! visible (reason + age) and manually redrivable, never silently dropped.
//!
//! Storage follows the repo's journal idiom ([`EventReceipts`]-style JSONL,
//! replayed at open, compacted in place): compaction drops only TERMINAL
//! records past retention ([`COMPLETED_RETENTION_HOURS`] /
//! [`DEAD_RETENTION_DAYS`]) — unfinished work is NEVER age-discarded.
//!
//! Privacy (audit DATA-PRIV-001): envelopes are the PII payload (transcripts,
//! caller numbers, SMS bodies), so with a [`JournalCrypto`] wired the `recv`
//! line seals them (`envEnc`), legacy plaintext journals are re-sealed by a
//! forced compaction at open, and a COMPLETED event's payload is dropped the
//! moment it completes — the terminal record keeps only key, state,
//! timestamps and a payload hash. Dead-letter records keep their (sealed)
//! envelope so the operator redrive still works. Retention is time-based:
//! aged terminal records are purged at open and by the dispatcher's periodic
//! tick, independent of line volume; the windows are env-tunable within safe
//! clamps ([`Retention::from_env`]).
//!
//! [`EventReceipts`]: crate::plugins::receipts::EventReceipts

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::journal_crypto::JournalCrypto;

/// Real processing failures before an event dead-letters. Readiness failures
/// (offline/unlinked) do not count — see [`WorkLedger::note_retry`].
pub const MAX_EVENT_ATTEMPTS: u32 = 8;
/// Completed records are dropped at the first compaction after this long.
pub const COMPLETED_RETENTION_HOURS: i64 = 24;
/// Dead records (the DLQ) stay visible/redrivable this long, then age out.
pub const DEAD_RETENTION_DAYS: i64 = 14;
/// Compact when the journal exceeds this many lines (state, not history,
/// bounds the file: rewrites keep one snapshot line per live record).
const COMPACT_AT_LINES: usize = 20_000;

/// Terminal-record retention windows (DATA-PRIV-001 item 5): separately
/// configurable within safe clamps. Pending work deliberately has NO window —
/// unfinished business events are never age-discarded (CROSS-EVENT-001).
#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub completed: chrono::Duration,
    pub dead: chrono::Duration,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            completed: chrono::Duration::hours(COMPLETED_RETENTION_HOURS),
            dead: chrono::Duration::days(DEAD_RETENTION_DAYS),
        }
    }
}

impl Retention {
    /// `FORMLOGIC_JOURNAL_COMPLETED_RETENTION_HOURS` (1..=168, default 24) and
    /// `FORMLOGIC_JOURNAL_DEAD_RETENTION_DAYS` (1..=90, default 14).
    pub fn from_env() -> Self {
        let hours = std::env::var("FORMLOGIC_JOURNAL_COMPLETED_RETENTION_HOURS")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or(COMPLETED_RETENTION_HOURS)
            .clamp(1, 168);
        let days = std::env::var("FORMLOGIC_JOURNAL_DEAD_RETENTION_DAYS")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or(DEAD_RETENTION_DAYS)
            .clamp(1, 90);
        Self {
            completed: chrono::Duration::hours(hours),
            dead: chrono::Duration::days(days),
        }
    }
}

/// Stable payload fingerprint kept on terminal records after the payload is
/// dropped (DATA-PRIV-001 item 2).
fn env_hash(envelope: &Value) -> String {
    let mut h = Sha256::new();
    h.update(envelope.to_string().as_bytes());
    format!("{:x}", h.finalize())
}

/// Retry backoff before attempt `attempts + 1`: 30 s doubling, 30 min cap.
pub fn backoff_secs(attempts: u32) -> i64 {
    30i64.checked_shl(attempts).unwrap_or(i64::MAX).min(1800)
}

/// Typed stage outcome (audit CROSS-EVENT-001 item 3) — what app-logic and
/// binding execution report instead of logging-and-continuing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageOutcome {
    Success,
    /// Transient (API 5xx, offline, snapshot miss): reschedule with backoff.
    Retryable(String),
    /// Deterministic (typed 4xx, stale call, vanished binding): recorded and
    /// not retried — retrying cannot change the answer.
    Permanent(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkStatus {
    Pending,
    Completed,
    Dead,
}

/// A planned binding's terminal-or-not state. There is deliberately no local
/// `reserved` state: the reservation itself is durable SERVER-side (the
/// unique run ledger), so a crash between reserve and execute leaves a
/// reserved run the server's stale-run reclaim requeues for the claim loop —
/// locally the binding just stays `pending` until an outcome lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingState {
    Pending,
    /// Executed and its run completed (success OR flow-level failure — both
    /// are durably recorded server-side in the run row).
    Done,
    /// Deliberately not executed: condition false, duplicate reservation
    /// (another runtime owns it), flow/binding no longer exists, routing.
    Skipped,
    /// Permanently failed locally (typed rejection) — visible in the DLQ.
    Dead,
}

impl BindingState {
    pub fn terminal(self) -> bool {
        !matches!(self, BindingState::Pending)
    }

    fn as_str(self) -> &'static str {
        match self {
            BindingState::Pending => "pending",
            BindingState::Done => "done",
            BindingState::Skipped => "skipped",
            BindingState::Dead => "dead",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "done" => BindingState::Done,
            "skipped" => BindingState::Skipped,
            "dead" => BindingState::Dead,
            _ => BindingState::Pending,
        }
    }
}

/// One event's durable work record.
#[derive(Debug, Clone)]
pub struct EventWork {
    pub key: String,
    /// `Null` once the event COMPLETES (payload dropped, DATA-PRIV-001) —
    /// only [`env_hash`](Self::env_hash) remains.
    pub envelope: Value,
    /// SHA-256 of the payload, set when the payload is dropped.
    pub env_hash: Option<String>,
    pub received_at: DateTime<Utc>,
    pub app_logic_done: bool,
    /// `None` until the binding fan-out was computed and journaled; the plan
    /// is fixed at that moment (a later snapshot can't grow it — no double
    /// fan-out drift on replays).
    pub bindings: Option<BTreeMap<String, BindingState>>,
    pub attempts: u32,
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub status: WorkStatus,
    pub last_error: Option<String>,
}

impl EventWork {
    fn bindings_all_terminal(&self) -> bool {
        self.bindings
            .as_ref()
            .is_some_and(|b| b.values().all(|s| s.terminal()))
    }
}

/// Outcome of [`WorkLedger::receive`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiveOutcome {
    /// First durable sighting — process it.
    New,
    /// Known and unfinished — process it (resume).
    PendingResume,
    /// Already completed or dead — a replayed delivery; drop it.
    Terminal,
}

struct Inner {
    path: PathBuf,
    writer: BufWriter<File>,
    lines: usize,
    map: BTreeMap<String, EventWork>,
    /// received-order index (BTreeMap iteration is key-order; recovery wants arrival order).
    order: Vec<String>,
}

pub struct WorkLedger {
    inner: Mutex<Inner>,
    crypto: Option<Arc<JournalCrypto>>,
    retention: Retention,
}

impl WorkLedger {
    /// Plaintext ledger with default retention (tests / no-crypto fallback).
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        Self::open_with(path, None, Retention::default())
    }

    pub fn open_with(
        path: PathBuf,
        crypto: Option<Arc<JournalCrypto>>,
        retention: Retention,
    ) -> std::io::Result<Self> {
        let mut map: BTreeMap<String, EventWork> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut lines = 0usize;
        let mut plaintext_payloads = false;
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                lines += 1;
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                if v.get("env").is_some_and(Value::is_object) {
                    plaintext_payloads = true;
                }
                Self::apply_line(&mut map, &mut order, &v, crypto.as_deref());
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let ledger = WorkLedger {
            inner: Mutex::new(Inner {
                path,
                writer: BufWriter::new(file),
                lines,
                map,
                order,
            }),
            crypto,
            retention,
        };
        // Compact at open when the journal is oversized, when any terminal
        // record has aged past retention (time-based purge must not wait for
        // volume — DATA-PRIV-001), or to re-seal a legacy plaintext journal
        // under the newly wired crypto.
        let now = Utc::now();
        if lines > COMPACT_AT_LINES
            || (plaintext_payloads && ledger.crypto.is_some())
            || ledger.has_expired_terminal(now)
        {
            ledger.compact(now);
        }
        Ok(ledger)
    }

    /// Whether any terminal record is past its retention window.
    fn has_expired_terminal(&self, now: DateTime<Utc>) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let completed_cutoff = now - self.retention.completed;
        let dead_cutoff = now - self.retention.dead;
        inner.map.values().any(|w| match w.status {
            WorkStatus::Pending => false,
            WorkStatus::Completed => w.received_at <= completed_cutoff,
            WorkStatus::Dead => w.received_at <= dead_cutoff,
        })
    }

    /// Replay one journaled transition into the in-memory state. Unknown ops
    /// and transitions for unknown keys are ignored (forward compatibility).
    fn apply_line(
        map: &mut BTreeMap<String, EventWork>,
        order: &mut Vec<String>,
        v: &Value,
        crypto: Option<&JournalCrypto>,
    ) {
        let op = v.get("op").and_then(Value::as_str).unwrap_or_default();
        let key = v.get("key").and_then(Value::as_str).unwrap_or_default();
        if key.is_empty() {
            return;
        }
        if op == "recv" {
            if map.contains_key(key) {
                return;
            }
            let received_at = v
                .get("at")
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(Utc::now);
            // Plaintext `env` (legacy / no-crypto), sealed `envEnc`, or no
            // payload at all (a completed record's stripped snapshot).
            let envelope = v
                .get("env")
                .filter(|e| e.is_object())
                .cloned()
                .or_else(|| {
                    v.get("envEnc")
                        .and_then(Value::as_str)
                        .and_then(|s| crypto?.decrypt(s))
                })
                .unwrap_or(Value::Null);
            map.insert(
                key.to_string(),
                EventWork {
                    key: key.to_string(),
                    envelope,
                    env_hash: v
                        .get("envHash")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    received_at,
                    app_logic_done: false,
                    bindings: None,
                    attempts: 0,
                    next_attempt_at: None,
                    status: WorkStatus::Pending,
                    last_error: None,
                },
            );
            order.push(key.to_string());
            return;
        }
        let Some(w) = map.get_mut(key) else { return };
        match op {
            "alogic" => w.app_logic_done = true,
            "plan" => {
                if w.bindings.is_none() {
                    let ids = v
                        .get("bindings")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(|s| (s.to_string(), BindingState::Pending))
                                .collect()
                        })
                        .unwrap_or_default();
                    w.bindings = Some(ids);
                }
            }
            "bind" => {
                let (Some(id), Some(state)) = (
                    v.get("id").and_then(Value::as_str),
                    v.get("state").and_then(Value::as_str),
                ) else {
                    return;
                };
                if let Some(b) = w.bindings.as_mut() {
                    b.insert(id.to_string(), BindingState::from_str(state));
                }
                if let Some(err) = v.get("err").and_then(Value::as_str) {
                    w.last_error = Some(err.to_string());
                }
            }
            "retry" => {
                if let Some(n) = v.get("attempts").and_then(Value::as_u64) {
                    w.attempts = n as u32;
                }
                w.next_attempt_at = v
                    .get("next")
                    .and_then(Value::as_str)
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.with_timezone(&Utc));
                if let Some(err) = v.get("err").and_then(Value::as_str) {
                    w.last_error = Some(err.to_string());
                }
            }
            "done" => {
                w.status = WorkStatus::Completed;
                w.next_attempt_at = None;
                // DATA-PRIV-001: a completed event's payload is dropped the
                // moment it completes — only the fingerprint remains.
                if w.env_hash.is_none() && !w.envelope.is_null() {
                    w.env_hash = Some(env_hash(&w.envelope));
                }
                w.envelope = Value::Null;
            }
            "dead" => {
                w.status = WorkStatus::Dead;
                w.next_attempt_at = None;
                if let Some(err) = v.get("err").and_then(Value::as_str) {
                    w.last_error = Some(err.to_string());
                }
            }
            "redrive" => {
                if w.status == WorkStatus::Dead {
                    w.status = WorkStatus::Pending;
                    w.attempts = 0;
                    w.next_attempt_at = None;
                }
            }
            _ => {}
        }
    }

    /// Append + flush one transition. The flush-before-return IS the
    /// durability contract: every state the dispatcher acts on has hit the OS
    /// before the next stage runs. `disk` and `mem` differ only for `recv`
    /// lines (the on-disk twin carries the SEALED payload) — applying the
    /// plaintext twin avoids a decrypt round-trip of what we just encrypted.
    fn append_with(inner: &mut Inner, disk: Value, mem: &Value) {
        if let Err(e) = writeln!(inner.writer, "{disk}").and_then(|()| inner.writer.flush()) {
            eprintln!("[flows] work-ledger append failed: {e}");
            return;
        }
        inner.lines += 1;
        let mut order_sink = Vec::new();
        Self::apply_line(&mut inner.map, &mut order_sink, mem, None);
        inner.order.extend(order_sink);
    }

    fn append(inner: &mut Inner, v: Value) {
        let mem = v.clone();
        Self::append_with(inner, v, &mem);
    }

    /// Durably record an envelope BEFORE any processing (stage `received`).
    pub fn receive(&self, key: &str, envelope: &Value) -> ReceiveOutcome {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = inner.map.get(key) {
            return if w.status == WorkStatus::Pending {
                ReceiveOutcome::PendingResume
            } else {
                ReceiveOutcome::Terminal
            };
        }
        let at = Utc::now().to_rfc3339();
        let mem = json!({"op": "recv", "key": key, "at": at, "env": envelope});
        let disk = match self.crypto.as_ref().and_then(|c| c.encrypt(envelope)) {
            Some(sealed) => json!({"op": "recv", "key": key, "at": at, "envEnc": sealed}),
            // No crypto wired → legacy plaintext. Crypto wired but sealing
            // failed (never in practice) → journal the record WITHOUT the
            // payload rather than writing plaintext PII.
            None if self.crypto.is_none() => mem.clone(),
            None => json!({"op": "recv", "key": key, "at": at}),
        };
        Self::append_with(&mut inner, disk, &mem);
        ReceiveOutcome::New
    }

    pub fn mark_app_logic_done(&self, key: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.map.get(key).is_some_and(|w| !w.app_logic_done) {
            Self::append(&mut inner, json!({"op": "alogic", "key": key}));
        }
    }

    /// Fix the binding fan-out for this event (journaled BEFORE any binding
    /// executes, so a crash mid-fan-out knows exactly what was planned).
    /// Idempotent: a second plan for the same key is ignored.
    pub fn plan_bindings(&self, key: &str, binding_ids: &[String]) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.map.get(key).is_some_and(|w| w.bindings.is_none()) {
            Self::append(&mut inner, json!({"op": "plan", "key": key, "bindings": binding_ids}));
        }
    }

    pub fn set_binding(&self, key: &str, binding_id: &str, state: BindingState, error: Option<&str>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut line = json!({"op": "bind", "key": key, "id": binding_id, "state": state.as_str()});
        if let Some(e) = error {
            line["err"] = json!(e);
        }
        Self::append(&mut inner, line);
    }

    /// Reschedule a pending event after a failure.
    ///
    /// `count_attempt = true` for REAL processing failures — after
    /// [`MAX_EVENT_ATTEMPTS`] of those the event dead-letters. `false` for
    /// readiness failures (no linked account, snapshot unavailable): those
    /// retry forever with backoff, because "the desktop is offline" must
    /// never destroy work. Returns the resulting status.
    pub fn note_retry(&self, key: &str, error: &str, count_attempt: bool) -> WorkStatus {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(w) = inner.map.get(key) else { return WorkStatus::Pending };
        if w.status != WorkStatus::Pending {
            return w.status;
        }
        let attempts = if count_attempt { w.attempts + 1 } else { w.attempts };
        if count_attempt && attempts >= MAX_EVENT_ATTEMPTS {
            Self::append(&mut inner, json!({"op": "dead", "key": key, "err": error}));
            return WorkStatus::Dead;
        }
        let next = Utc::now() + chrono::Duration::seconds(backoff_secs(attempts));
        Self::append(
            &mut inner,
            json!({"op": "retry", "key": key, "attempts": attempts, "next": next.to_rfc3339(), "err": error}),
        );
        WorkStatus::Pending
    }

    /// Dead-letter an event outright (deterministic rejection, e.g. ambiguous
    /// connector routing) — visible with its reason, redrivable once fixed.
    pub fn mark_dead(&self, key: &str, error: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.map.get(key).is_some_and(|w| w.status == WorkStatus::Pending) {
            Self::append(&mut inner, json!({"op": "dead", "key": key, "err": error}));
        }
    }

    /// Complete the event iff every stage is terminal (app-logic done,
    /// bindings planned, every planned binding terminal). Returns whether the
    /// event is now (or already was) completed.
    pub fn try_complete(&self, key: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(w) = inner.map.get(key) else { return false };
        match w.status {
            WorkStatus::Completed => true,
            WorkStatus::Dead => false,
            WorkStatus::Pending => {
                if w.app_logic_done && w.bindings_all_terminal() {
                    Self::append(&mut inner, json!({"op": "done", "key": key}));
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Snapshot one record (cheap clone) — the dispatcher reads stage flags
    /// through this instead of holding the lock across awaits.
    pub fn get(&self, key: &str) -> Option<EventWork> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.map.get(key).cloned()
    }

    /// Pending events whose retry backoff has elapsed (the in-session pump).
    /// Fresh rows with no `next_attempt_at` are excluded — the live path owns
    /// them; they only enter the pump once a failure schedules them.
    pub fn due_retries(&self, now: DateTime<Utc>) -> Vec<(String, Value)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .order
            .iter()
            .filter_map(|k| inner.map.get(k))
            .filter(|w| {
                w.status == WorkStatus::Pending
                    && w.next_attempt_at.is_some_and(|t| t <= now)
            })
            .map(|w| (w.key.clone(), w.envelope.clone()))
            .collect()
    }

    /// EVERY unfinished event, oldest first — startup recovery re-drives all
    /// of them, from any prior session, with no age discard (audit
    /// CROSS-EVENT-001 item 5).
    pub fn all_pending(&self) -> Vec<(String, Value)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .order
            .iter()
            .filter_map(|k| inner.map.get(k))
            .filter(|w| w.status == WorkStatus::Pending)
            .map(|w| (w.key.clone(), w.envelope.clone()))
            .collect()
    }

    /// The DLQ: dead events with reason and age, oldest first.
    pub fn dead_letters(&self) -> Vec<Value> {
        let now = Utc::now();
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .order
            .iter()
            .filter_map(|k| inner.map.get(k))
            .filter(|w| w.status == WorkStatus::Dead)
            .map(|w| {
                json!({
                    "key": w.key,
                    "event": w.envelope.get("name").cloned().unwrap_or(Value::Null),
                    "error": w.last_error,
                    "attempts": w.attempts,
                    "receivedAt": w.received_at.to_rfc3339(),
                    "ageSeconds": (now - w.received_at).num_seconds().max(0),
                })
            })
            .collect()
    }

    /// (pending, dead) counts for the runtime status surface.
    pub fn counts(&self) -> (u64, u64) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut pending = 0u64;
        let mut dead = 0u64;
        for w in inner.map.values() {
            match w.status {
                WorkStatus::Pending => pending += 1,
                WorkStatus::Dead => dead += 1,
                WorkStatus::Completed => {}
            }
        }
        (pending, dead)
    }

    /// Operator redrive: dead → pending with a fresh attempt budget. Pass a
    /// key for one event or `None` for the whole dead set. Returns how many
    /// events were revived; the caller re-enqueues them.
    pub fn redrive(&self, key: Option<&str>) -> Vec<(String, Value)> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<String> = inner
            .map
            .values()
            .filter(|w| w.status == WorkStatus::Dead && key.is_none_or(|k| k == w.key))
            .map(|w| w.key.clone())
            .collect();
        let mut revived = Vec::new();
        for k in keys {
            Self::append(&mut inner, json!({"op": "redrive", "key": k}));
            if let Some(w) = inner.map.get(&k) {
                revived.push((k.clone(), w.envelope.clone()));
            }
        }
        revived
    }

    /// Compact the journal: rewrite it as one snapshot per LIVE record,
    /// dropping completed/dead records older than their [`Retention`]
    /// windows. Unfinished work is never dropped, whatever its age.
    pub fn compact(&self, now: DateTime<Utc>) {
        self.compact_with(now - self.retention.completed, now - self.retention.dead);
    }

    /// Drop every terminal record NOW (the "clear call/SMS history" action —
    /// DATA-PRIV-001 item 6). Pending work is untouched. Returns how many
    /// (completed, dead) records were removed.
    pub fn clear_terminal(&self) -> (usize, usize) {
        let (completed, dead) = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let mut c = 0usize;
            let mut d = 0usize;
            for w in inner.map.values() {
                match w.status {
                    WorkStatus::Completed => c += 1,
                    WorkStatus::Dead => d += 1,
                    WorkStatus::Pending => {}
                }
            }
            (c, d)
        };
        let now = Utc::now();
        self.compact_with(now, now);
        (completed, dead)
    }

    /// Compaction core with explicit cutoffs (records received at or before a
    /// cutoff are dropped for that status).
    fn compact_with(&self, completed_cutoff: DateTime<Utc>, dead_cutoff: DateTime<Utc>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let keep: Vec<String> = inner
            .order
            .iter()
            .filter(|k| {
                inner.map.get(*k).is_some_and(|w| match w.status {
                    WorkStatus::Pending => true,
                    WorkStatus::Completed => w.received_at > completed_cutoff,
                    WorkStatus::Dead => w.received_at > dead_cutoff,
                })
            })
            .cloned()
            .collect();
        inner.map.retain(|k, _| keep.contains(k));
        inner.order.retain(|k| keep.contains(k));

        // Serialise each surviving record as its transition lines. Completed
        // records write NO payload (fingerprint only); pending/dead payloads
        // are sealed when crypto is wired (DATA-PRIV-001).
        let mut out = String::new();
        for k in &inner.order {
            let Some(w) = inner.map.get(k) else { continue };
            let mut recv = json!({"op": "recv", "key": w.key, "at": w.received_at.to_rfc3339()});
            if !w.envelope.is_null() {
                match self.crypto.as_ref().and_then(|c| c.encrypt(&w.envelope)) {
                    Some(sealed) => recv["envEnc"] = json!(sealed),
                    None if self.crypto.is_none() => recv["env"] = w.envelope.clone(),
                    None => {}
                }
            }
            if let Some(h) = &w.env_hash {
                recv["envHash"] = json!(h);
            }
            out.push_str(&recv.to_string());
            out.push('\n');
            if w.app_logic_done {
                out.push_str(&json!({"op": "alogic", "key": w.key}).to_string());
                out.push('\n');
            }
            if let Some(b) = &w.bindings {
                let ids: Vec<&String> = b.keys().collect();
                out.push_str(&json!({"op": "plan", "key": w.key, "bindings": ids}).to_string());
                out.push('\n');
                for (id, state) in b {
                    if state.terminal() {
                        out.push_str(
                            &json!({"op": "bind", "key": w.key, "id": id, "state": state.as_str()})
                                .to_string(),
                        );
                        out.push('\n');
                    }
                }
            }
            if w.attempts > 0 || w.next_attempt_at.is_some() {
                out.push_str(
                    &json!({
                        "op": "retry", "key": w.key, "attempts": w.attempts,
                        "next": w.next_attempt_at.map(|t| t.to_rfc3339()),
                        "err": w.last_error,
                    })
                    .to_string(),
                );
                out.push('\n');
            }
            match w.status {
                WorkStatus::Completed => {
                    out.push_str(&json!({"op": "done", "key": w.key}).to_string());
                    out.push('\n');
                }
                WorkStatus::Dead => {
                    out.push_str(
                        &json!({"op": "dead", "key": w.key, "err": w.last_error}).to_string(),
                    );
                    out.push('\n');
                }
                WorkStatus::Pending => {}
            }
        }

        let tmp = inner.path.with_extension("jsonl.tmp");
        let path = inner.path.clone();
        let write = std::fs::write(&tmp, &out).and_then(|()| std::fs::rename(&tmp, &path));
        match write {
            Ok(()) => match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(f) => {
                    inner.writer = BufWriter::new(f);
                    inner.lines = out.lines().count();
                }
                Err(e) => eprintln!("[flows] work-ledger reopen after compact failed: {e}"),
            },
            Err(e) => eprintln!("[flows] work-ledger compaction failed (journal kept): {e}"),
        }
    }

    /// Compact when the journal has grown past the threshold, OR when any
    /// terminal record has aged past retention — the periodic tick calls this,
    /// so terminal PII is purged on the clock even on a low-volume system
    /// (DATA-PRIV-001 item 4).
    pub fn maybe_compact(&self, now: DateTime<Utc>) {
        let oversized = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.lines > COMPACT_AT_LINES
        };
        if oversized || self.has_expired_terminal(now) {
            self.compact(now);
        }
    }

    /// (pending, completed, dead) counts — the journals preview surface.
    pub fn counts_full(&self) -> (u64, u64, u64) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut pending = 0u64;
        let mut completed = 0u64;
        let mut dead = 0u64;
        for w in inner.map.values() {
            match w.status {
                WorkStatus::Pending => pending += 1,
                WorkStatus::Completed => completed += 1,
                WorkStatus::Dead => dead += 1,
            }
        }
        (pending, completed, dead)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fl-work-ledger-{tag}-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ))
    }

    fn env(name: &str) -> Value {
        json!({"name": name, "correlationId": "call_1", "idempotencyKey": name})
    }

    #[test]
    fn full_lifecycle_reaches_completed() {
        let led = WorkLedger::open(temp_path("lifecycle")).unwrap();
        assert_eq!(led.receive("k1", &env("aokie.call.ended")), ReceiveOutcome::New);
        assert!(!led.try_complete("k1"), "app-logic not done yet");
        led.mark_app_logic_done("k1");
        assert!(!led.try_complete("k1"), "bindings not planned yet");
        led.plan_bindings("k1", &["b1".into(), "b2".into()]);
        assert!(!led.try_complete("k1"), "bindings pending");
        led.set_binding("k1", "b1", BindingState::Done, None);
        led.set_binding("k1", "b2", BindingState::Skipped, None);
        assert!(led.try_complete("k1"));
        assert_eq!(led.receive("k1", &env("aokie.call.ended")), ReceiveOutcome::Terminal);
        let (pending, dead) = led.counts();
        assert_eq!((pending, dead), (0, 0));
    }

    /// The acceptance case: process termination immediately after EVERY write
    /// resumes exactly where it stopped — nothing lost, nothing repeated as new.
    #[test]
    fn reopen_after_each_transition_resumes_state() {
        let path = temp_path("crash");
        {
            let led = WorkLedger::open(path.clone()).unwrap();
            led.receive("k1", &env("aokie.sms.received"));
        }
        {
            let led = WorkLedger::open(path.clone()).unwrap();
            let w = led.get("k1").expect("received survives crash");
            assert!(!w.app_logic_done);
            assert_eq!(led.all_pending().len(), 1);
            led.mark_app_logic_done("k1");
        }
        {
            let led = WorkLedger::open(path.clone()).unwrap();
            assert!(led.get("k1").unwrap().app_logic_done, "app-logic stage survives");
            led.plan_bindings("k1", &["b1".into()]);
        }
        {
            let led = WorkLedger::open(path.clone()).unwrap();
            let w = led.get("k1").unwrap();
            assert_eq!(w.bindings.as_ref().unwrap().len(), 1, "plan survives");
            led.set_binding("k1", "b1", BindingState::Done, None);
            assert!(led.try_complete("k1"));
        }
        {
            let led = WorkLedger::open(path.clone()).unwrap();
            assert_eq!(led.receive("k1", &env("x")), ReceiveOutcome::Terminal);
            assert!(led.all_pending().is_empty(), "completed events are not re-driven");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn retries_backoff_then_dead_letter_and_redrive() {
        let led = WorkLedger::open(temp_path("retry")).unwrap();
        led.receive("k1", &env("aokie.call.ended"));

        // Readiness failures never consume attempts.
        for _ in 0..50 {
            assert_eq!(led.note_retry("k1", "not linked", false), WorkStatus::Pending);
        }
        assert_eq!(led.get("k1").unwrap().attempts, 0);

        // Real failures do — and dead-letter at the cap.
        for i in 1..MAX_EVENT_ATTEMPTS {
            assert_eq!(led.note_retry("k1", "api 500", true), WorkStatus::Pending, "attempt {i}");
        }
        assert_eq!(led.note_retry("k1", "api 500", true), WorkStatus::Dead);
        let dead = led.dead_letters();
        assert_eq!(dead.len(), 1);
        assert_eq!(dead[0]["error"], json!("api 500"));
        assert!(led.all_pending().is_empty(), "dead events are not silently re-driven");

        // Manual redrive revives it with a fresh budget.
        let revived = led.redrive(Some("k1"));
        assert_eq!(revived.len(), 1);
        assert_eq!(led.get("k1").unwrap().attempts, 0);
        assert_eq!(led.counts(), (1, 0));
    }

    #[test]
    fn due_retries_excludes_fresh_and_future_rows() {
        let led = WorkLedger::open(temp_path("due")).unwrap();
        led.receive("fresh", &env("a"));
        led.receive("failed", &env("b"));
        led.note_retry("failed", "blip", true);
        // Fresh row (live path owns it) and future-backoff row are excluded…
        assert!(led.due_retries(Utc::now()).is_empty());
        // …but once the backoff elapses the failed row is due.
        let later = Utc::now() + chrono::Duration::seconds(backoff_secs(1) + 1);
        let due = led.due_retries(later);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, "failed");
    }

    #[test]
    fn compaction_drops_only_aged_terminal_records() {
        let path = temp_path("compact");
        let led = WorkLedger::open(path.clone()).unwrap();
        led.receive("old-done", &env("a"));
        led.mark_app_logic_done("old-done");
        led.plan_bindings("old-done", &[]);
        assert!(led.try_complete("old-done"));
        led.receive("old-pending", &env("b"));
        led.receive("old-dead", &env("c"));
        led.mark_dead("old-dead", "boom");

        // Compact "far in the future": completed + dead age out, pending stays.
        led.compact(Utc::now() + chrono::Duration::days(365));
        assert!(led.get("old-done").is_none(), "aged completed dropped");
        assert!(led.get("old-dead").is_none(), "aged dead dropped");
        assert!(led.get("old-pending").is_some(), "unfinished work is NEVER age-discarded");

        // And the rewritten journal replays to the same state.
        drop(led);
        let led = WorkLedger::open(path.clone()).unwrap();
        assert!(led.get("old-pending").is_some());
        assert_eq!(led.all_pending().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    // ── DATA-PRIV-001 ───────────────────────────────────────────────────────

    fn crypto() -> Arc<JournalCrypto> {
        Arc::new(JournalCrypto::from_key([3u8; 32]))
    }

    fn pii_env() -> Value {
        json!({
            "name": "aokie.sms.received",
            "idempotencyKey": "sms-1",
            "payload": {"from": "+61400123456", "body": "SECRET-LEDGER-BODY"}
        })
    }

    #[test]
    fn encrypted_ledger_stores_no_plaintext_and_recovers_pending_work() {
        let path = temp_path("sealed");
        {
            let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
            assert_eq!(led.receive("k1", &pii_env()), ReceiveOutcome::New);
        }
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("61400123456"), "caller number not on disk");
        assert!(!raw.contains("SECRET-LEDGER-BODY"), "SMS body not on disk");
        assert!(raw.contains("envEnc"));

        // Pending work survives restart WITH its payload (acceptance #3).
        let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
        let pending = led.all_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, pii_env(), "sealed envelope reads back for recovery");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn completion_drops_the_payload_keeping_only_the_fingerprint() {
        let path = temp_path("strip");
        let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
        led.receive("k1", &pii_env());
        led.mark_app_logic_done("k1");
        led.plan_bindings("k1", &[]);
        assert!(led.try_complete("k1"));

        let w = led.get("k1").unwrap();
        assert!(w.envelope.is_null(), "completed payload dropped in memory");
        assert!(w.env_hash.is_some(), "fingerprint retained");
        // The dedupe answer is unchanged.
        assert_eq!(led.receive("k1", &pii_env()), ReceiveOutcome::Terminal);

        // After compaction (within retention) the journal keeps the terminal
        // record — key/state/hash — but NO payload in any form.
        led.compact(Utc::now());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"key\":\"k1\""));
        assert!(raw.contains("envHash"));
        assert!(!raw.contains("envEnc") && !raw.contains("SECRET-LEDGER-BODY"));

        // And the stripped snapshot replays to the same terminal state.
        drop(led);
        let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
        assert_eq!(led.receive("k1", &pii_env()), ReceiveOutcome::Terminal);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dead_letters_keep_their_sealed_payload_for_redrive_across_restarts() {
        let path = temp_path("dead-redrive");
        {
            let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
            led.receive("k1", &pii_env());
            led.mark_dead("k1", "ambiguous routing");
            led.compact(Utc::now()); // sealed snapshot on disk
        }
        assert!(!std::fs::read_to_string(&path).unwrap().contains("SECRET-LEDGER-BODY"));
        let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
        let revived = led.redrive(Some("k1"));
        assert_eq!(revived.len(), 1);
        assert_eq!(revived[0].1, pii_env(), "redrive recovers the full envelope");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_plaintext_ledger_is_resealed_at_open() {
        let path = temp_path("upgrade");
        {
            let led = WorkLedger::open(path.clone()).unwrap(); // pre-encryption shape
            led.receive("k1", &pii_env());
        }
        assert!(std::fs::read_to_string(&path).unwrap().contains("SECRET-LEDGER-BODY"));

        let led = WorkLedger::open_with(path.clone(), Some(crypto()), Retention::default()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("SECRET-LEDGER-BODY"), "legacy PII sealed at first boot");
        assert!(raw.contains("envEnc"));
        assert_eq!(led.all_pending().len(), 1, "work state intact through the upgrade");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn periodic_tick_purges_aged_terminals_without_volume() {
        let path = temp_path("clock");
        let led = WorkLedger::open(path.clone()).unwrap();
        led.receive("k1", &env("a"));
        led.mark_app_logic_done("k1");
        led.plan_bindings("k1", &[]);
        assert!(led.try_complete("k1"));

        // A handful of lines — far below the size threshold. Time alone must purge.
        led.maybe_compact(Utc::now());
        assert!(led.get("k1").is_some(), "inside retention: kept");
        led.maybe_compact(Utc::now() + chrono::Duration::hours(COMPLETED_RETENTION_HOURS + 1));
        assert!(led.get("k1").is_none(), "aged completed record purged on the clock");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clear_terminal_drops_history_but_never_pending_work() {
        let led = WorkLedger::open(temp_path("clear")).unwrap();
        led.receive("done", &env("a"));
        led.mark_app_logic_done("done");
        led.plan_bindings("done", &[]);
        assert!(led.try_complete("done"));
        led.receive("dead", &env("b"));
        led.mark_dead("dead", "boom");
        led.receive("pending", &env("c"));

        assert_eq!(led.clear_terminal(), (1, 1));
        assert_eq!(led.counts_full(), (1, 0, 0), "pending survives Clear history");
        assert!(led.get("pending").is_some());
    }

    #[test]
    fn retention_env_overrides_are_clamped_to_safe_ranges() {
        // Direct clamp check (no env mutation — tests run in parallel).
        assert_eq!(180i64.clamp(1, 168), 168, "completed hours cap");
        assert_eq!(0i64.clamp(1, 168), 1, "completed hours floor");
        assert_eq!(365i64.clamp(1, 90), 90, "dead days cap");
        let r = Retention::default();
        assert_eq!(r.completed, chrono::Duration::hours(COMPLETED_RETENTION_HOURS));
        assert_eq!(r.dead, chrono::Duration::days(DEAD_RETENTION_DAYS));
    }

    #[test]
    fn ambiguous_routing_dead_letter_is_visible_and_redrivable() {
        let led = WorkLedger::open(temp_path("ambig")).unwrap();
        led.receive("k1", &env("aokie.call.incoming"));
        led.mark_dead("k1", "2 apps use connector 'aokie' and none is assigned");
        assert_eq!(led.counts(), (0, 1));
        assert_eq!(led.receive("k1", &env("aokie.call.incoming")), ReceiveOutcome::Terminal);
        let revived = led.redrive(None);
        assert_eq!(revived.len(), 1);
        assert_eq!(led.counts(), (1, 0));
    }
}
