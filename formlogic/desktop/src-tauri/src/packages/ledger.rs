//! DESK-503: the Desktop's own record of what it has, what it should have, and what it has been
//! asked to do.
//!
//! The backend knows what an owner INSTALLED. It cannot know what this machine actually managed
//! to do about it: a laptop can be offline when an install is requested, a component can be
//! shared by two packages, a user can pin something they do not want touched, and a native
//! install can be waiting on a confirmation nobody has answered yet. Treating the backend's view
//! as the truth would make every one of those look like a defect to be corrected — and the
//! correction would be wrong.
//!
//! So the Desktop keeps a ledger with two separate columns:
//!
//!   - **desired** — what the backend (or the user) has asked this machine to have.
//!   - **observed** — what is actually here, and whether it is healthy.
//!
//! Reconciliation is the gap between them, and the whole point of writing them down separately
//! is that the gap is legible rather than inferred. Three things then protect the machine from a
//! reconciler that would otherwise happily do damage:
//!
//!   - **Consumers** — reference counts. A component two installations use is not removed
//!     because one of them went away. Removal is refused, and the refusal names who still needs
//!     it, rather than being silently skipped.
//!   - **Pins** — a user's explicit "leave this alone". A pinned component survives even at zero
//!     consumers. The user outranks the reconciler; otherwise a pin is decoration.
//!   - **Consent** — a native install is not something to do because a server said so. A
//!     component that requires local confirmation stays blocked until someone answers, and a
//!     denial is recorded rather than retried.
//!
//! Pending operations queue while offline and are keyed by a caller-supplied id, so replaying
//! the same request after a reconnect does not enqueue it twice.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// What this machine should have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Desired {
    /// Installed, at this version.
    Present { version: String },
    /// Not installed. Distinct from "no record": an explicit absence is a decision.
    Absent,
}

/// What is actually here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Observed {
    NotInstalled,
    /// Staged on disk but not yet proven — never treated as usable.
    Staged { version: String },
    Installed { version: String, healthy: bool },
    /// A previous attempt failed. Kept (rather than reset to NotInstalled) so a retry loop is
    /// visible and a repeated failure can stop being retried.
    Failed { detail: String },
}

/// Whether this machine's owner has agreed to a native install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Consent {
    /// No confirmation needed (nothing native happens).
    NotRequired,
    /// Waiting on a local confirmation. Nothing proceeds from here.
    Required,
    Granted { at: String },
    /// Refused. Recorded rather than forgotten, so it is not asked again on a loop.
    Denied { at: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRecord {
    pub key: String,
    pub desired: Desired,
    pub observed: Observed,
    /// Installation ids that reference this component. A shared component has several.
    #[serde(default)]
    pub consumers: BTreeSet<String>,
    /// A user's explicit "leave this alone". Survives zero consumers.
    #[serde(default)]
    pub pinned: bool,
    pub consent: Consent,
}

impl ComponentRecord {
    fn new(key: &str) -> Self {
        Self {
            key: key.to_string(),
            desired: Desired::Absent,
            observed: Observed::NotInstalled,
            consumers: BTreeSet::new(),
            pinned: false,
            consent: Consent::NotRequired,
        }
    }

    /// Is this component usable right now? Staged is deliberately NOT usable: a partial install
    /// must never read as healthy.
    pub fn is_usable(&self) -> bool {
        matches!(&self.observed, Observed::Installed { healthy: true, .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    Install,
    Update,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    /// Caller-supplied id. Re-enqueueing the same id after a reconnect is a no-op, so a retrying
    /// client cannot queue the same work twice.
    pub id: String,
    pub kind: OperationKind,
    pub component_key: String,
    pub version: Option<String>,
    pub requested_at: String,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// Why a reconciler refused to act. Every variant names something the caller can do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerRefusal {
    /// Other installations still reference this component.
    StillInUse { consumers: Vec<String> },
    /// The user pinned it.
    Pinned,
    /// A native install is waiting on (or was refused) local confirmation.
    ConsentPending,
    ConsentDenied,
}

impl LedgerRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            LedgerRefusal::StillInUse { .. } => "component_still_in_use",
            LedgerRefusal::Pinned => "component_pinned",
            LedgerRefusal::ConsentPending => "consent_pending",
            LedgerRefusal::ConsentDenied => "consent_denied",
        }
    }

    pub fn message(&self) -> String {
        match self {
            LedgerRefusal::StillInUse { consumers } => format!(
                "still required by {} — remove {} first",
                consumers.join(", "),
                if consumers.len() == 1 { "it" } else { "those" }
            ),
            LedgerRefusal::Pinned => "pinned on this device — unpin it first".to_string(),
            LedgerRefusal::ConsentPending => "waiting for local confirmation on this device".to_string(),
            LedgerRefusal::ConsentDenied => "local confirmation was declined on this device".to_string(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LedgerFile {
    #[serde(default)]
    components: BTreeMap<String, ComponentRecord>,
    #[serde(default)]
    pending: Vec<PendingOperation>,
}

/// Monotonic suffix so two concurrent persists never share a temp path.
static NEXT_TMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub struct Ledger {
    path: PathBuf,
    state: Mutex<LedgerFile>,
}

impl Ledger {
    /// Open (or create) the ledger under the app data directory. A corrupt file starts EMPTY
    /// rather than refusing to boot: a machine that cannot record what it has is still better
    /// than a machine that will not start.
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("package-ledger.json");
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<LedgerFile>(&text).ok())
            .unwrap_or_default();
        Self { path, state: Mutex::new(state) }
    }

    fn lock(&self) -> MutexGuard<'_, LedgerFile> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(&self, state: &LedgerFile) {
        let Ok(text) = serde_json::to_string_pretty(state) else {
            return;
        };
        // tmp + rename: a crash mid-write must not leave a half-written ledger, which would read
        // as "this machine has nothing" on the next boot.
        //
        // The tmp name is UNIQUE per write. A single shared `.json.tmp` meant two concurrent
        // writers wrote over each other's temp file and then both renamed it — so one of them
        // could rename a file containing the other's partial bytes straight onto the ledger.
        let unique = format!(
            "json.tmp-{:x}-{}",
            std::process::id(),
            NEXT_TMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let tmp = self.path.with_extension(unique);
        if std::fs::write(&tmp, text).is_ok() {
            if std::fs::rename(&tmp, &self.path).is_err() {
                let _ = std::fs::remove_file(&tmp); // never leave the scratch file behind
            }
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    pub fn component(&self, key: &str) -> Option<ComponentRecord> {
        self.lock().components.get(key).cloned()
    }

    pub fn components(&self) -> Vec<ComponentRecord> {
        self.lock().components.values().cloned().collect()
    }

    /// Record what the backend says this machine should have, WITHOUT touching anything local
    /// that represents a decision made here.
    ///
    /// This is the reconcile seam, and the care is deliberate: consumers, pins and consent are
    /// local facts. A backend that does not know about them must not be able to erase them by
    /// restating what it wants.
    pub fn set_desired(&self, key: &str, desired: Desired, requires_consent: bool) {
        let mut state = self.lock();
        let record = state.components.entry(key.to_string()).or_insert_with(|| ComponentRecord::new(key));
        record.desired = desired;
        if requires_consent && matches!(record.consent, Consent::NotRequired) {
            record.consent = Consent::Required;
        }
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
    }

    /// Record what is actually here now.
    pub fn set_observed(&self, key: &str, observed: Observed) {
        let mut state = self.lock();
        let record = state.components.entry(key.to_string()).or_insert_with(|| ComponentRecord::new(key));
        record.observed = observed;
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
    }

    /// An installation now needs this component.
    pub fn add_consumer(&self, key: &str, installation_id: &str) {
        let mut state = self.lock();
        let record = state.components.entry(key.to_string()).or_insert_with(|| ComponentRecord::new(key));
        record.consumers.insert(installation_id.to_string());
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
    }

    /// An installation no longer needs this component. Returns the remaining consumer count —
    /// the caller decides whether to attempt removal, and {@see can_remove} decides whether it
    /// may.
    pub fn remove_consumer(&self, key: &str, installation_id: &str) -> usize {
        let mut state = self.lock();
        let remaining = match state.components.get_mut(key) {
            Some(record) => {
                record.consumers.remove(installation_id);
                record.consumers.len()
            }
            None => 0,
        };
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
        remaining
    }

    /// May this component be removed from this machine?
    ///
    /// Order matters: a shared component is reported as shared even if it is also pinned,
    /// because "two packages need this" is the more useful thing to tell someone than "you
    /// pinned it".
    pub fn can_remove(&self, key: &str) -> Result<(), LedgerRefusal> {
        let state = self.lock();
        let Some(record) = state.components.get(key) else {
            return Ok(()); // nothing recorded, nothing to protect
        };
        if !record.consumers.is_empty() {
            return Err(LedgerRefusal::StillInUse {
                consumers: record.consumers.iter().cloned().collect(),
            });
        }
        if record.pinned {
            return Err(LedgerRefusal::Pinned);
        }
        Ok(())
    }

    /// May this component be installed on this machine right now?
    pub fn can_install(&self, key: &str) -> Result<(), LedgerRefusal> {
        let state = self.lock();
        let Some(record) = state.components.get(key) else {
            return Ok(());
        };
        match &record.consent {
            Consent::Required => Err(LedgerRefusal::ConsentPending),
            Consent::Denied { .. } => Err(LedgerRefusal::ConsentDenied),
            Consent::NotRequired | Consent::Granted { .. } => Ok(()),
        }
    }

    /// The user's explicit "leave this alone" (or its removal).
    pub fn set_pinned(&self, key: &str, pinned: bool) {
        let mut state = self.lock();
        let record = state.components.entry(key.to_string()).or_insert_with(|| ComponentRecord::new(key));
        record.pinned = pinned;
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
    }

    /// Answer a pending consent. `at` is supplied by the caller (an RFC 3339 stamp) so this stays
    /// deterministic and testable.
    pub fn set_consent(&self, key: &str, granted: bool, at: &str) {
        let mut state = self.lock();
        let record = state.components.entry(key.to_string()).or_insert_with(|| ComponentRecord::new(key));
        record.consent = if granted {
            Consent::Granted { at: at.to_string() }
        } else {
            Consent::Denied { at: at.to_string() }
        };
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
    }

    /// Queue work for when this machine can do it. Idempotent by operation id: a client that
    /// retries after a dropped connection does not queue the same work twice.
    pub fn enqueue(&self, operation: PendingOperation) -> bool {
        let mut state = self.lock();
        if state.pending.iter().any(|p| p.id == operation.id) {
            return false;
        }
        state.pending.push(operation);
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
        true
    }

    pub fn pending(&self) -> Vec<PendingOperation> {
        self.lock().pending.clone()
    }

    /// Remove a completed operation. Returns false when it was already gone — a completion
    /// replayed after a reconnect must not be an error.
    pub fn complete(&self, operation_id: &str) -> bool {
        let mut state = self.lock();
        let before = state.pending.len();
        state.pending.retain(|p| p.id != operation_id);
        let removed = state.pending.len() != before;
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
        removed
    }

    /// Record a failed attempt. The operation STAYS queued — a transient failure should be
    /// retried — but the attempt count and reason are visible, so a permanently failing
    /// operation can be recognised instead of retried forever.
    pub fn record_failure(&self, operation_id: &str, detail: &str) {
        let mut state = self.lock();
        if let Some(operation) = state.pending.iter_mut().find(|p| p.id == operation_id) {
            operation.attempts += 1;
            operation.last_error = Some(detail.chars().take(500).collect());
        }
        let snapshot = LedgerFile {
            components: state.components.clone(),
            pending: state.pending.clone(),
        };
        drop(state);
        self.persist(&snapshot);
    }

    /// What reconciliation would DO, without doing it: every component whose observed state does
    /// not match what is desired, paired with why it cannot be acted on yet (if anything).
    pub fn drift(&self) -> Vec<(ComponentRecord, Option<LedgerRefusal>)> {
        let state = self.lock();
        let mut out = Vec::new();
        for record in state.components.values() {
            let matched = match (&record.desired, &record.observed) {
                (Desired::Present { version }, Observed::Installed { version: have, healthy: true }) => version == have,
                (Desired::Absent, Observed::NotInstalled) => true,
                _ => false,
            };
            if matched {
                continue;
            }
            let refusal = match &record.desired {
                Desired::Present { .. } => match &record.consent {
                    Consent::Required => Some(LedgerRefusal::ConsentPending),
                    Consent::Denied { .. } => Some(LedgerRefusal::ConsentDenied),
                    _ => None,
                },
                Desired::Absent => {
                    if !record.consumers.is_empty() {
                        Some(LedgerRefusal::StillInUse {
                            consumers: record.consumers.iter().cloned().collect(),
                        })
                    } else if record.pinned {
                        Some(LedgerRefusal::Pinned)
                    } else {
                        None
                    }
                }
            };
            out.push((record.clone(), refusal));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger() -> (Ledger, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-ledger-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        (Ledger::open(&dir), dir)
    }

    fn operation(id: &str, key: &str) -> PendingOperation {
        PendingOperation {
            id: id.to_string(),
            kind: OperationKind::Install,
            component_key: key.to_string(),
            version: Some("1.0.0".into()),
            requested_at: "2026-07-25T00:00:00Z".into(),
            attempts: 0,
            last_error: None,
        }
    }

    #[test]
    fn a_shared_component_is_not_removed_because_one_consumer_went_away() {
        let (ledger, _dir) = ledger();
        ledger.add_consumer("runtime", "install-a");
        ledger.add_consumer("runtime", "install-b");

        assert_eq!(ledger.remove_consumer("runtime", "install-a"), 1);
        let refusal = ledger.can_remove("runtime").unwrap_err();
        assert_eq!(refusal.code(), "component_still_in_use");
        // The refusal NAMES who still needs it — a silent skip would leave the user hunting.
        assert!(refusal.message().contains("install-b"));

        assert_eq!(ledger.remove_consumer("runtime", "install-b"), 0);
        assert!(ledger.can_remove("runtime").is_ok(), "the last consumer leaving releases it");
    }

    #[test]
    fn a_user_pin_outranks_the_reconciler() {
        let (ledger, _dir) = ledger();
        ledger.set_pinned("runtime", true);
        assert_eq!(ledger.can_remove("runtime").unwrap_err(), LedgerRefusal::Pinned);

        // Even with nothing referencing it: a pin that yields at zero consumers is decoration.
        ledger.add_consumer("runtime", "install-a");
        ledger.remove_consumer("runtime", "install-a");
        assert_eq!(ledger.can_remove("runtime").unwrap_err(), LedgerRefusal::Pinned);

        ledger.set_pinned("runtime", false);
        assert!(ledger.can_remove("runtime").is_ok());
    }

    #[test]
    fn a_native_install_waits_for_local_confirmation() {
        let (ledger, _dir) = ledger();
        ledger.set_desired("runtime", Desired::Present { version: "1.0.0".into() }, true);
        assert_eq!(ledger.can_install("runtime").unwrap_err(), LedgerRefusal::ConsentPending);

        ledger.set_consent("runtime", true, "2026-07-25T00:00:00Z");
        assert!(ledger.can_install("runtime").is_ok());
    }

    #[test]
    fn a_denial_is_recorded_rather_than_retried() {
        let (ledger, _dir) = ledger();
        ledger.set_desired("runtime", Desired::Present { version: "1.0.0".into() }, true);
        ledger.set_consent("runtime", false, "2026-07-25T00:00:00Z");
        assert_eq!(ledger.can_install("runtime").unwrap_err(), LedgerRefusal::ConsentDenied);

        // Restating the desired state does NOT re-ask: a backend that does not know about the
        // denial must not be able to erase it by repeating itself.
        ledger.set_desired("runtime", Desired::Present { version: "1.0.0".into() }, true);
        assert_eq!(ledger.can_install("runtime").unwrap_err(), LedgerRefusal::ConsentDenied);
    }

    #[test]
    fn restating_desired_state_never_clobbers_local_decisions() {
        let (ledger, _dir) = ledger();
        ledger.add_consumer("runtime", "install-a");
        ledger.set_pinned("runtime", true);
        ledger.set_consent("runtime", true, "2026-07-25T00:00:00Z");

        // The backend restates what it wants; consumers, pin and consent are LOCAL facts it does
        // not know about and must not be able to reset.
        ledger.set_desired("runtime", Desired::Present { version: "2.0.0".into() }, true);

        let record = ledger.component("runtime").expect("record");
        assert!(record.pinned);
        assert_eq!(record.consumers.iter().cloned().collect::<Vec<_>>(), vec!["install-a"]);
        assert!(matches!(record.consent, Consent::Granted { .. }));
        assert_eq!(record.desired, Desired::Present { version: "2.0.0".into() });
    }

    #[test]
    fn staged_is_never_usable() {
        let (ledger, _dir) = ledger();
        ledger.set_observed("runtime", Observed::Staged { version: "1.0.0".into() });
        assert!(!ledger.component("runtime").unwrap().is_usable(), "a partial install is not healthy");

        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: false });
        assert!(!ledger.component("runtime").unwrap().is_usable(), "installed but unhealthy is not usable");

        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: true });
        assert!(ledger.component("runtime").unwrap().is_usable());
    }

    #[test]
    fn queued_work_is_idempotent_and_survives_a_restart() {
        let (ledger, dir) = ledger();
        assert!(ledger.enqueue(operation("op-1", "runtime")));
        // A client retrying after a dropped connection must not queue the same work twice.
        assert!(!ledger.enqueue(operation("op-1", "runtime")));
        assert_eq!(ledger.pending().len(), 1);

        // Reopen: the queue is on disk, so an offline request is not lost to a restart.
        let reopened = Ledger::open(&dir);
        assert_eq!(reopened.pending().len(), 1);
        assert_eq!(reopened.pending()[0].id, "op-1");

        assert!(reopened.complete("op-1"));
        // A completion replayed after a reconnect is not an error.
        assert!(!reopened.complete("op-1"));
        assert!(reopened.pending().is_empty());
    }

    #[test]
    fn a_failed_attempt_stays_queued_but_becomes_visible() {
        let (ledger, _dir) = ledger();
        ledger.enqueue(operation("op-1", "runtime"));
        ledger.record_failure("op-1", "the download was interrupted");
        ledger.record_failure("op-1", "the download was interrupted");

        let pending = ledger.pending();
        assert_eq!(pending.len(), 1, "a transient failure is retried, not dropped");
        assert_eq!(pending[0].attempts, 2, "a permanently failing operation is recognisable");
        assert_eq!(pending[0].last_error.as_deref(), Some("the download was interrupted"));
    }

    #[test]
    fn drift_reports_the_gap_and_why_it_cannot_be_closed() {
        let (ledger, _dir) = ledger();
        // Wanted but not here, awaiting confirmation.
        ledger.set_desired("runtime", Desired::Present { version: "1.0.0".into() }, true);
        // Unwanted but still shared.
        ledger.set_desired("shared", Desired::Absent, false);
        ledger.set_observed("shared", Observed::Installed { version: "1.0.0".into(), healthy: true });
        ledger.add_consumer("shared", "install-b");
        // Matching: reported as no drift at all.
        ledger.set_desired("settled", Desired::Present { version: "2.0.0".into() }, false);
        ledger.set_observed("settled", Observed::Installed { version: "2.0.0".into(), healthy: true });

        let drift = ledger.drift();
        let keys: Vec<&str> = drift.iter().map(|(record, _)| record.key.as_str()).collect();
        assert_eq!(keys, vec!["runtime", "shared"], "a settled component is not drift");

        assert_eq!(drift[0].1, Some(LedgerRefusal::ConsentPending));
        assert!(matches!(drift[1].1, Some(LedgerRefusal::StillInUse { .. })));
    }

    #[test]
    fn a_corrupt_ledger_starts_empty_rather_than_refusing_to_boot() {
        let dir = std::env::temp_dir().join(format!("fl-ledger-bad-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("package-ledger.json"), "{ not json").expect("write");

        let ledger = Ledger::open(&dir);
        assert!(ledger.components().is_empty());
        assert!(ledger.pending().is_empty());
        // And it is writable again — a machine that cannot record what it has still boots.
        ledger.add_consumer("runtime", "install-a");
        assert_eq!(ledger.components().len(), 1);
    }
}
