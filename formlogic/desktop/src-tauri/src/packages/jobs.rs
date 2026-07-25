//! DESK-505: the seam between the backend's install jobs and this machine's install pipeline.
//!
//! The backend coordinates (DESK-502): it owns the job, decides which device may claim it, and
//! records progress and outcome. This Desktop executes (DESK-504) and keeps its own ledger of
//! what actually happened (DESK-503). This module is the part in between, and it exists because
//! the two views disagree in ways that are normal rather than exceptional:
//!
//! - **A device outcome is a device outcome.** A job that succeeded for the backend means "this
//!   device reported success", not "the component is live everywhere". Readiness is per-device,
//!   so the report carries the device.
//! - **A failed update keeps the previous version.** Rollback restores what was there; the job
//!   fails, and the ledger still shows the old version installed and healthy. Reporting a
//!   failure that also wiped the working version would be a far worse outcome than the failure.
//! - **Shared runtimes stay.** Uninstalling a package does not remove a component another
//!   installation still consumes; the removal is refused, named, and reported as such rather
//!   than being silently skipped or forced.
//! - **Pending removal waits for acknowledgement.** A removal requested while this device was
//!   offline stays a tombstone in the ledger's queue until the device does it and says so.
//!   Dropping it would leave the component installed forever with nobody tracking it.

use super::install::{DistributionRequest, InstallError, InstallHost, InstallPipeline, RequireConsent};
use super::ledger::{Desired, Ledger, LedgerRefusal, Observed, OperationKind, PendingOperation};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// What this device reports back about one job. Deliberately a device-scoped statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutcome {
    pub job_id: String,
    pub device_id: String,
    pub component_key: String,
    pub ok: bool,
    /// Typed code on failure — the same vocabulary the backend and UI already speak.
    pub code: Option<String>,
    pub message: Option<String>,
    /// The version this device is left running. On a failed update this is the PREVIOUS version,
    /// which is the single most useful fact in the report.
    pub active_version: Option<String>,
    /// True when the job is not finished and is waiting on something local (a confirmation, a
    /// reboot, a device that is offline). Distinct from a failure.
    pub pending: bool,
}

impl JobOutcome {
    fn failed(job_id: &str, device_id: &str, component_key: &str, error: &InstallError, active: Option<String>) -> Self {
        Self {
            job_id: job_id.to_string(),
            device_id: device_id.to_string(),
            component_key: component_key.to_string(),
            ok: false,
            code: Some(error.code().to_string()),
            message: Some(error.message()),
            active_version: active,
            // Waiting on a local answer is not a failure to retry — it is a state to surface.
            pending: matches!(
                error,
                InstallError::Blocked(LedgerRefusal::ConsentPending)
            ),
        }
    }
}

/// Run one backend-issued install/update job on this device.
///
/// `previous_version` is what the ledger says is installed now — captured BEFORE the pipeline
/// runs, because after a failed update it is the thing the report has to carry.
pub fn run_install_job<H: InstallHost>(
    host: &H,
    ledger: &Ledger,
    staging_root: PathBuf,
    job_id: &str,
    device_id: &str,
    request: &DistributionRequest,
    consent: RequireConsent,
) -> JobOutcome {
    let previous_version = match ledger.component(&request.component_key).map(|c| c.observed) {
        Some(Observed::Installed { version, healthy: true }) => Some(version),
        _ => None,
    };

    let mut pipeline = InstallPipeline::new(host, ledger, staging_root);
    match pipeline.run(request, consent) {
        Ok(()) => JobOutcome {
            job_id: job_id.to_string(),
            device_id: device_id.to_string(),
            component_key: request.component_key.clone(),
            ok: true,
            code: None,
            message: None,
            active_version: Some(request.version.clone()),
            pending: false,
        },
        Err(error) => {
            // A failed update leaves the PREVIOUS version active — rollback restored it, and the
            // report says so rather than implying the machine is now empty.
            let active = match ledger.component(&request.component_key).map(|c| c.observed) {
                Some(Observed::Installed { version, healthy: true }) => Some(version),
                _ => previous_version,
            };
            JobOutcome::failed(job_id, device_id, &request.component_key, &error, active)
        }
    }
}

/// Run one backend-issued uninstall job.
///
/// Reference counting happens HERE rather than at the backend: the backend knows which
/// installation was removed, but only this device knows what else on this machine still consumes
/// the component.
pub fn run_uninstall_job<F>(
    ledger: &Ledger,
    job_id: &str,
    device_id: &str,
    component_key: &str,
    installation_id: &str,
    remove: F,
) -> JobOutcome
where
    F: FnOnce() -> Result<(), String>,
{
    ledger.remove_consumer(component_key, installation_id);
    ledger.set_desired(component_key, Desired::Absent, false);

    if let Err(refusal) = ledger.can_remove(component_key) {
        // Shared or pinned: the component STAYS, and the report names why. Silently skipping
        // would leave the owner believing it was removed.
        return JobOutcome {
            job_id: job_id.to_string(),
            device_id: device_id.to_string(),
            component_key: component_key.to_string(),
            ok: false,
            code: Some(refusal.code().to_string()),
            message: Some(refusal.message()),
            active_version: ledger.component(component_key).and_then(|c| match c.observed {
                Observed::Installed { version, .. } => Some(version),
                _ => None,
            }),
            pending: false,
        };
    }

    match remove() {
        Ok(()) => {
            ledger.set_observed(component_key, Observed::NotInstalled);
            JobOutcome {
                job_id: job_id.to_string(),
                device_id: device_id.to_string(),
                component_key: component_key.to_string(),
                ok: true,
                code: None,
                message: None,
                active_version: None,
                pending: false,
            }
        }
        Err(detail) => {
            ledger.set_observed(component_key, Observed::Failed { detail: detail.clone() });
            JobOutcome {
                job_id: job_id.to_string(),
                device_id: device_id.to_string(),
                component_key: component_key.to_string(),
                ok: false,
                code: Some("uninstall_failed".to_string()),
                message: Some(detail),
                active_version: None,
                pending: false,
            }
        }
    }
}

/// Record a removal this device could not do yet (it was offline, or a confirmation is pending).
///
/// The tombstone is a QUEUED OPERATION rather than a flag: it survives a restart, it is
/// idempotent by job id, and it stays until the device does the work and says so. Dropping it
/// would leave the component installed forever with nobody tracking that it should not be.
pub fn queue_offline_removal(ledger: &Ledger, job_id: &str, component_key: &str, requested_at: &str) -> bool {
    ledger.set_desired(component_key, Desired::Absent, false);
    ledger.enqueue(PendingOperation {
        id: job_id.to_string(),
        kind: OperationKind::Remove,
        component_key: component_key.to_string(),
        version: None,
        requested_at: requested_at.to_string(),
        attempts: 0,
        last_error: None,
    })
}

/// Is this component ready to use ON THIS DEVICE? Readiness is per-device by definition: the same
/// package can be live on a desktop and still staging on a laptop, and answering globally would
/// be wrong on one of them.
pub fn device_readiness(ledger: &Ledger, component_key: &str) -> bool {
    ledger.component(component_key).is_some_and(|c| c.is_usable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::Path;

    #[derive(Default)]
    struct FakeHost {
        bytes: Vec<u8>,
        health_error: Option<String>,
    }

    impl InstallHost for FakeHost {
        fn fetch(&self, _r: &DistributionRequest) -> Result<Vec<u8>, String> {
            Ok(self.bytes.clone())
        }
        fn stage(&self, _r: &DistributionRequest, _b: &[u8], _s: &Path) -> Result<(), String> {
            Ok(())
        }
        fn install(&self, _r: &DistributionRequest, _s: &Path) -> Result<(), String> {
            Ok(())
        }
        fn health(&self, _r: &DistributionRequest) -> Result<(), String> {
            match &self.health_error {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        fn rollback(&self, _r: &DistributionRequest) -> Result<(), String> {
            Ok(())
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn request(version: &str, bytes: &[u8]) -> DistributionRequest {
        DistributionRequest {
            component_key: "runtime".into(),
            version: version.into(),
            runtime_kind: "managed-service".into(),
            sha256: sha256_hex(bytes),
            byte_size: bytes.len() as u64,
            url: "https://example.test/runtime.zip".into(),
            native: false,
        }
    }

    fn fixture() -> (Ledger, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-jobs-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        (Ledger::open(&dir), dir)
    }

    #[test]
    fn a_successful_job_reports_the_device_and_the_active_version() {
        let (ledger, dir) = fixture();
        let payload = b"v1".to_vec();
        let host = FakeHost { bytes: payload.clone(), ..Default::default() };

        let outcome = run_install_job(
            &host, &ledger, dir, "job-1", "desk-A", &request("1.0.0", &payload), RequireConsent::Waived,
        );

        assert!(outcome.ok);
        assert_eq!(outcome.device_id, "desk-A", "an outcome is a DEVICE outcome, not a global one");
        assert_eq!(outcome.active_version.as_deref(), Some("1.0.0"));
        assert!(device_readiness(&ledger, "runtime"));
    }

    #[test]
    fn a_failed_update_keeps_the_previous_version_and_says_so() {
        let (ledger, dir) = fixture();
        let payload = b"v1".to_vec();

        // Install 1.0.0 successfully.
        let good = FakeHost { bytes: payload.clone(), ..Default::default() };
        run_install_job(&good, &ledger, dir.clone(), "job-1", "desk-A", &request("1.0.0", &payload), RequireConsent::Waived);
        assert!(device_readiness(&ledger, "runtime"));

        // Update to 2.0.0 fails health; rollback restores what was there.
        let next = b"v2".to_vec();
        let bad = FakeHost { bytes: next.clone(), health_error: Some("the new build crashes on start".into()) };
        // Rollback in this fake restores the previous healthy state, as a real one would.
        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: true });
        let outcome = run_install_job(
            &bad, &ledger, dir, "job-2", "desk-A", &request("2.0.0", &next), RequireConsent::Waived,
        );

        assert!(!outcome.ok);
        // The single most useful fact in the report: what this device is actually running now.
        assert_eq!(outcome.active_version.as_deref(), Some("1.0.0"));
        assert!(outcome.message.unwrap().contains("crashes on start"));
    }

    #[test]
    fn uninstalling_a_shared_runtime_refuses_and_names_who_still_needs_it() {
        let (ledger, _dir) = fixture();
        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: true });
        ledger.add_consumer("runtime", "install-a");
        ledger.add_consumer("runtime", "install-b");

        let removed = RefCell::new(false);
        let outcome = run_uninstall_job(&ledger, "job-3", "desk-A", "runtime", "install-a", || {
            *removed.borrow_mut() = true;
            Ok(())
        });

        assert!(!outcome.ok);
        assert_eq!(outcome.code.as_deref(), Some("component_still_in_use"));
        assert!(outcome.message.unwrap().contains("install-b"));
        assert!(!*removed.borrow(), "a shared runtime is not removed");
        // And it is still usable for the package that does need it.
        assert!(device_readiness(&ledger, "runtime"));
        assert_eq!(outcome.active_version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn the_last_consumer_leaving_does_remove_it() {
        let (ledger, _dir) = fixture();
        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: true });
        ledger.add_consumer("runtime", "install-a");

        let outcome = run_uninstall_job(&ledger, "job-4", "desk-A", "runtime", "install-a", || Ok(()));

        assert!(outcome.ok);
        assert!(!device_readiness(&ledger, "runtime"));
        assert_eq!(ledger.component("runtime").unwrap().observed, Observed::NotInstalled);
    }

    #[test]
    fn a_user_pin_survives_an_uninstall_job() {
        // The owner removed the package, but pinned the shared runtime on this machine. The pin
        // is a local decision and outranks a job issued elsewhere.
        let (ledger, _dir) = fixture();
        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: true });
        ledger.add_consumer("runtime", "install-a");
        ledger.set_pinned("runtime", true);

        let outcome = run_uninstall_job(&ledger, "job-5", "desk-A", "runtime", "install-a", || Ok(()));

        assert!(!outcome.ok);
        assert_eq!(outcome.code.as_deref(), Some("component_pinned"));
        assert!(device_readiness(&ledger, "runtime"));
    }

    #[test]
    fn an_offline_removal_waits_as_a_tombstone_rather_than_being_dropped() {
        let (ledger, dir) = fixture();
        ledger.set_observed("runtime", Observed::Installed { version: "1.0.0".into(), healthy: true });

        assert!(queue_offline_removal(&ledger, "job-6", "runtime", "2026-07-25T00:00:00Z"));
        // Re-issuing the same job after a reconnect must not queue it twice.
        assert!(!queue_offline_removal(&ledger, "job-6", "runtime", "2026-07-25T00:00:00Z"));

        // It survives a restart — a tombstone that evaporates leaves the component installed
        // forever with nobody tracking that it should not be.
        let reopened = Ledger::open(&dir);
        let pending = reopened.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].kind, OperationKind::Remove);
        assert_eq!(reopened.component("runtime").unwrap().desired, Desired::Absent);

        // And it stays until the device actually does the work and says so.
        reopened.complete("job-6");
        assert!(reopened.pending().is_empty());
    }

    #[test]
    fn awaiting_local_confirmation_is_reported_as_pending_not_failed() {
        let (ledger, dir) = fixture();
        let payload = b"v1".to_vec();
        let host = FakeHost { bytes: payload.clone(), ..Default::default() };

        let outcome = run_install_job(
            &host, &ledger, dir, "job-7", "desk-A", &request("1.0.0", &payload), RequireConsent::Always,
        );

        assert!(!outcome.ok);
        assert!(outcome.pending, "waiting on a person is a state to surface, not a failure to retry");
        assert_eq!(outcome.code.as_deref(), Some("consent_pending"));
    }

    #[test]
    fn a_tamper_is_reported_as_failed_and_not_pending() {
        let (ledger, dir) = fixture();
        let host = FakeHost { bytes: b"different bytes".to_vec(), ..Default::default() };
        let mut req = request("1.0.0", b"declared bytes");
        req.byte_size = "different bytes".len() as u64;

        let outcome = run_install_job(&host, &ledger, dir, "job-8", "desk-A", &req, RequireConsent::Waived);

        assert!(!outcome.ok);
        assert!(!outcome.pending);
        assert_eq!(outcome.code.as_deref(), Some("distribution_tampered"));
    }
}
