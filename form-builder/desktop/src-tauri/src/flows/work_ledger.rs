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
//! [`EventReceipts`]: crate::plugins::receipts::EventReceipts

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

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
    pub envelope: Value,
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
}

impl WorkLedger {
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let mut map: BTreeMap<String, EventWork> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut lines = 0usize;
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                lines += 1;
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                Self::apply_line(&mut map, &mut order, &v);
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
        };
        // Oversized journal from a busy prior run: compact immediately.
        if lines > COMPACT_AT_LINES {
            ledger.compact(Utc::now());
        }
        Ok(ledger)
    }

    /// Replay one journaled transition into the in-memory state. Unknown ops
    /// and transitions for unknown keys are ignored (forward compatibility).
    fn apply_line(map: &mut BTreeMap<String, EventWork>, order: &mut Vec<String>, v: &Value) {
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
            map.insert(
                key.to_string(),
                EventWork {
                    key: key.to_string(),
                    envelope: v.get("env").cloned().unwrap_or(Value::Null),
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
    /// before the next stage runs.
    fn append(inner: &mut Inner, v: Value) {
        if let Err(e) = writeln!(inner.writer, "{v}").and_then(|()| inner.writer.flush()) {
            eprintln!("[flows] work-ledger append failed: {e}");
            return;
        }
        inner.lines += 1;
        let mut order_sink = Vec::new();
        Self::apply_line(&mut inner.map, &mut order_sink, &v);
        inner.order.extend(order_sink);
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
        Self::append(
            &mut inner,
            json!({"op": "recv", "key": key, "at": Utc::now().to_rfc3339(), "env": envelope}),
        );
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
    /// dropping completed records older than [`COMPLETED_RETENTION_HOURS`]
    /// and dead records older than [`DEAD_RETENTION_DAYS`]. Unfinished work
    /// is never dropped, whatever its age.
    pub fn compact(&self, now: DateTime<Utc>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let completed_cutoff = now - chrono::Duration::hours(COMPLETED_RETENTION_HOURS);
        let dead_cutoff = now - chrono::Duration::days(DEAD_RETENTION_DAYS);
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

        // Serialise each surviving record as its transition lines.
        let mut out = String::new();
        for k in &inner.order {
            let Some(w) = inner.map.get(k) else { continue };
            out.push_str(
                &json!({"op": "recv", "key": w.key, "at": w.received_at.to_rfc3339(), "env": w.envelope})
                    .to_string(),
            );
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

    /// Compact when the journal has grown past the threshold.
    pub fn maybe_compact(&self, now: DateTime<Utc>) {
        let oversized = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.lines > COMPACT_AT_LINES
        };
        if oversized {
            self.compact(now);
        }
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
