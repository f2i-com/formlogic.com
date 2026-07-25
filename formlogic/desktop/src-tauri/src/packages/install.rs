//! DESK-504: the Desktop's install pipeline for a signed distribution.
//!
//! fetch → verify → approve → stage → install → health → activate, with cancel and rollback at
//! every step and an audit line for each transition.
//!
//! The ordering is the design. Three properties fall out of it, and each one is a failure mode
//! this pipeline exists to prevent:
//!
//! **Verification happens before bytes are trusted, not after they are in place.** The declared
//! size is checked before the download, and the digest before anything is unpacked. Verifying
//! after staging leaves a window that only perfect cleanup closes, and cleanup is exactly what
//! does not happen when a process is killed.
//!
//! **Local confirmation is required by default.** A native install is not something to do
//! because a server said so. `RequireConsent::Always` is the default and the pipeline blocks at
//! the approval step until someone on this machine answers. Skipping it is possible, but it is a
//! deliberate, named argument rather than an omission.
//!
//! **A partial install is never healthy.** Staging writes to a temporary directory; the
//! component becomes `Installed` only after the staged payload passes its health check, and
//! `activate` only accepts a component that is already installed AND healthy. A pipeline
//! interrupted anywhere leaves `Staged` or `Failed` — states the ledger reports as unusable —
//! never a half-thing that reads as working.
//!
//! Native privileges are tracked separately from action grants. A package's connector grants say
//! what its FLOWS may reach; they say nothing about whether this machine will run an installer.
//! The two are different questions with different blast radii, and conflating them is how a
//! package that was approved to call an API ends up writing to Program Files.

use super::ledger::{Desired, Ledger, LedgerRefusal, Observed};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Whether this machine will ask before running a native install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequireConsent {
    /// The default. Nothing native happens without a local answer.
    Always,
    /// Only for distributions that actually touch the machine natively.
    NativeOnly,
    /// Explicitly waived by the operator for this call. Never the default, and never implied by
    /// a package's own metadata — a package cannot waive the consent that protects the user
    /// from it.
    Waived,
}

impl Default for RequireConsent {
    fn default() -> Self {
        RequireConsent::Always
    }
}

/// What the pipeline is being asked to install. Every field is checked before it is used.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRequest {
    pub component_key: String,
    pub version: String,
    /// Which installer this is for — the field selects a privilege level, so it is never
    /// advisory: `managed-service` runs in the Desktop's own sandbox, `desktop-plugin` does not.
    pub runtime_kind: String,
    pub sha256: String,
    pub byte_size: u64,
    /// Where the bytes come from. Validated by the CALLER (the backend's DistributionVerifier)
    /// before it ever reaches here; re-checked for shape regardless.
    pub url: String,
    /// True when installing this touches the machine outside the Desktop's own data directory.
    #[serde(default)]
    pub native: bool,
}

/// Largest distribution this Desktop will stage. Checked against the DECLARED size before any
/// download starts, and against the real size after, so a lying manifest cannot get a free
/// download out of us.
pub const MAX_DISTRIBUTION_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Fetch,
    Verify,
    Approve,
    Stage,
    Install,
    Health,
    Activate,
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// The request itself is not installable — refused before anything is fetched.
    Refused { code: &'static str, detail: String },
    /// Local policy said no (consent, pin, still in use).
    Blocked(LedgerRefusal),
    /// The bytes are not what was declared. Never a retry: a digest mismatch is a TAMPER, and
    /// retrying a tamper is how you eventually accept one.
    Tampered { detail: String },
    /// The step failed for an operational reason and may be retried.
    Failed { step: Step, detail: String },
    Cancelled,
}

impl InstallError {
    pub fn code(&self) -> &'static str {
        match self {
            InstallError::Refused { code, .. } => code,
            InstallError::Blocked(refusal) => refusal.code(),
            InstallError::Tampered { .. } => "distribution_tampered",
            InstallError::Failed { .. } => "install_failed",
            InstallError::Cancelled => "install_cancelled",
        }
    }

    pub fn message(&self) -> String {
        match self {
            InstallError::Refused { detail, .. } => detail.clone(),
            InstallError::Blocked(refusal) => refusal.message(),
            InstallError::Tampered { detail } => detail.clone(),
            InstallError::Failed { step, detail } => format!("{step:?} failed: {detail}"),
            InstallError::Cancelled => "cancelled".to_string(),
        }
    }

    /// Is retrying this sensible? A tamper and a refusal are not; an operational failure is.
    pub fn retriable(&self) -> bool {
        matches!(self, InstallError::Failed { .. })
    }
}

/// One audit line. Written for every transition, including the ones that refused — an install
/// that did NOT happen is exactly what someone reading this later wants to know about.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub component_key: String,
    pub version: String,
    pub step: Step,
    pub ok: bool,
    pub detail: Option<String>,
}

/// The side effects the pipeline needs, injected so the ordering can be tested without a network
/// or a real installer.
pub trait InstallHost {
    /// Download the distribution. Implementations must honour the declared size.
    fn fetch(&self, request: &DistributionRequest) -> Result<Vec<u8>, String>;
    /// Unpack verified bytes into a staging directory. Never the final location.
    fn stage(&self, request: &DistributionRequest, bytes: &[u8], staging: &Path) -> Result<(), String>;
    /// Move a staged payload into place and run whatever native installer it needs.
    fn install(&self, request: &DistributionRequest, staging: &Path) -> Result<(), String>;
    /// Is the installed component actually working?
    fn health(&self, request: &DistributionRequest) -> Result<(), String>;
    /// Undo an install. Called on any failure AFTER install began.
    fn rollback(&self, request: &DistributionRequest) -> Result<(), String>;
    /// Has the caller cancelled? Polled between steps.
    fn cancelled(&self) -> bool {
        false
    }
}

pub struct InstallPipeline<'a, H: InstallHost> {
    host: &'a H,
    ledger: &'a Ledger,
    staging_root: PathBuf,
    audit: Vec<AuditEntry>,
}

impl<'a, H: InstallHost> InstallPipeline<'a, H> {
    pub fn new(host: &'a H, ledger: &'a Ledger, staging_root: PathBuf) -> Self {
        Self { host, ledger, staging_root, audit: Vec::new() }
    }

    pub fn audit(&self) -> &[AuditEntry] {
        &self.audit
    }

    fn record(&mut self, request: &DistributionRequest, step: Step, ok: bool, detail: Option<String>) {
        self.audit.push(AuditEntry {
            component_key: request.component_key.clone(),
            version: request.version.clone(),
            step,
            ok,
            detail,
        });
    }

    /// Run the whole pipeline. On any failure after `install` began, rollback runs and the
    /// component is left `Failed` — visibly not usable — rather than in an ambiguous state.
    pub fn run(&mut self, request: &DistributionRequest, consent: RequireConsent) -> Result<(), InstallError> {
        self.precheck(request)?;

        // What this machine had before we touched anything. A rollback that succeeds restores
        // this, so an update that fails leaves the previous working version reported as working.
        let previous = self.ledger.component(&request.component_key).map(|c| c.observed);

        // ── approve ────────────────────────────────────────────────────────────────────────
        // BEFORE fetching: asking for confirmation after downloading half a gigabyte wastes the
        // user's bandwidth on something they may be about to decline.
        let needs_consent = match consent {
            RequireConsent::Always => true,
            RequireConsent::NativeOnly => request.native,
            RequireConsent::Waived => false,
        };
        // What this machine SHOULD have is recorded either way. Recording it only on the
        // consent path left a waived install with desired=Absent, so the very next drift()
        // reported the component that had just been installed as something to remove.
        self.ledger.set_desired(
            &request.component_key,
            Desired::Present { version: request.version.clone() },
            needs_consent,
        );
        if needs_consent {
            if let Err(refusal) = self.ledger.can_install(&request.component_key) {
                self.record(request, Step::Approve, false, Some(refusal.message()));
                return Err(InstallError::Blocked(refusal));
            }
        }
        self.record(request, Step::Approve, true, None);
        self.check_cancelled(request)?;

        // ── fetch ──────────────────────────────────────────────────────────────────────────
        let bytes = match self.host.fetch(request) {
            Ok(bytes) => bytes,
            Err(detail) => {
                self.record(request, Step::Fetch, false, Some(detail.clone()));
                self.ledger.set_observed(&request.component_key, Observed::Failed { detail: detail.clone() });
                return Err(InstallError::Failed { step: Step::Fetch, detail });
            }
        };
        self.record(request, Step::Fetch, true, None);

        // ── verify ─────────────────────────────────────────────────────────────────────────
        // Size THEN digest, before anything is written anywhere: a mismatch must be caught while
        // the bytes are still only in memory.
        if bytes.len() as u64 != request.byte_size {
            let detail = format!("expected {} bytes, received {}", request.byte_size, bytes.len());
            self.record(request, Step::Verify, false, Some(detail.clone()));
            self.ledger.set_observed(&request.component_key, Observed::Failed { detail: detail.clone() });
            return Err(InstallError::Tampered { detail });
        }
        let digest = sha256_hex(&bytes);
        if !digest.eq_ignore_ascii_case(&request.sha256) {
            // Deliberately NOT retriable and deliberately not "stage pending investigation":
            // content that does not match its digest is content nobody vouched for.
            let detail = "the downloaded bytes do not match the signed digest".to_string();
            self.record(request, Step::Verify, false, Some(detail.clone()));
            self.ledger.set_observed(&request.component_key, Observed::Failed { detail: detail.clone() });
            return Err(InstallError::Tampered { detail });
        }
        self.record(request, Step::Verify, true, None);
        self.check_cancelled(request)?;

        // ── stage ──────────────────────────────────────────────────────────────────────────
        let staging = self.staging_root.join(format!("{}-{}", request.component_key, request.version));
        if let Err(detail) = self.host.stage(request, &bytes, &staging) {
            self.record(request, Step::Stage, false, Some(detail.clone()));
            self.ledger.set_observed(&request.component_key, Observed::Failed { detail: detail.clone() });
            return Err(InstallError::Failed { step: Step::Stage, detail });
        }
        // Staged is recorded as its own state, and the ledger reports it as NOT usable. An
        // interrupted pipeline stops here rather than looking installed.
        self.ledger.set_observed(&request.component_key, Observed::Staged { version: request.version.clone() });
        self.record(request, Step::Stage, true, None);
        self.check_cancelled(request)?;

        // ── install ────────────────────────────────────────────────────────────────────────
        if let Err(detail) = self.host.install(request, &staging) {
            self.record(request, Step::Install, false, Some(detail.clone()));
            self.rollback(request, &detail, previous.clone());
            return Err(InstallError::Failed { step: Step::Install, detail });
        }
        self.record(request, Step::Install, true, None);

        // ── health ─────────────────────────────────────────────────────────────────────────
        // Installed-but-unhealthy is recorded as exactly that, then rolled back. Recording it
        // first means an operator reading the ledger after a crash sees what happened.
        if let Err(detail) = self.host.health(request) {
            self.ledger.set_observed(
                &request.component_key,
                Observed::Installed { version: request.version.clone(), healthy: false },
            );
            self.record(request, Step::Health, false, Some(detail.clone()));
            self.rollback(request, &detail, previous.clone());
            return Err(InstallError::Failed { step: Step::Health, detail });
        }
        self.record(request, Step::Health, true, None);

        // ── activate ───────────────────────────────────────────────────────────────────────
        self.ledger.set_observed(
            &request.component_key,
            Observed::Installed { version: request.version.clone(), healthy: true },
        );
        self.record(request, Step::Activate, true, None);
        Ok(())
    }

    /// Everything that can be judged from the request alone, before any bytes move.
    fn precheck(&mut self, request: &DistributionRequest) -> Result<(), InstallError> {
        let refuse = |code: &'static str, detail: String| InstallError::Refused { code, detail };

        if !matches!(request.runtime_kind.as_str(), "managed-service" | "desktop-plugin") {
            // runtime_kind SELECTS the installer, and the two have different privileges — an
            // unknown value must never fall through to whichever one happens to be first.
            let detail = format!("unsupported runtime kind '{}'", request.runtime_kind);
            self.record(request, Step::Verify, false, Some(detail.clone()));
            return Err(refuse("unsupported_runtime_kind", detail));
        }
        if request.sha256.len() != 64 || !request.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            let detail = "the distribution digest is not a sha256".to_string();
            self.record(request, Step::Verify, false, Some(detail.clone()));
            return Err(refuse("invalid_digest", detail));
        }
        if request.byte_size == 0 || request.byte_size > MAX_DISTRIBUTION_BYTES {
            // Checked against the DECLARED size, before the download: refusing after a 2 GiB
            // transfer protects nothing.
            let detail = format!("declared size {} is outside the accepted range", request.byte_size);
            self.record(request, Step::Verify, false, Some(detail.clone()));
            return Err(refuse("invalid_size", detail));
        }
        // `starts_with("http://127.0.0.1")` also matched http://127.0.0.1.attacker.test — a
        // prefix is not a host. Only real loopback authorities are exempt from https.
        let loopback_http = request.url.starts_with("http://127.0.0.1/")
            || request.url.starts_with("http://127.0.0.1:")
            || request.url == "http://127.0.0.1";
        if !(request.url.starts_with("https://") || loopback_http) {
            let detail = "a distribution must be fetched over https".to_string();
            self.record(request, Step::Fetch, false, Some(detail.clone()));
            return Err(refuse("insecure_source", detail));
        }
        if request.component_key.is_empty()
            || request.component_key.len() > 64
            || request.component_key.contains("..")
            || request.component_key.contains('/')
            || request.component_key.contains('\\')
        {
            // The key becomes a staging DIRECTORY NAME. A traversal here would write outside the
            // staging root.
            let detail = "the component key is not a safe identifier".to_string();
            self.record(request, Step::Stage, false, Some(detail.clone()));
            return Err(refuse("invalid_component_key", detail));
        }
        Ok(())
    }

    fn check_cancelled(&mut self, request: &DistributionRequest) -> Result<(), InstallError> {
        if self.host.cancelled() {
            self.record(request, Step::Rollback, true, Some("cancelled before this step".into()));
            // Nothing is installed yet at any cancel point, so there is nothing to undo —
            // but the component must not be left looking staged-and-fine.
            self.ledger.set_observed(
                &request.component_key,
                Observed::Failed { detail: "cancelled".into() },
            );
            return Err(InstallError::Cancelled);
        }
        Ok(())
    }

    /// `previous` is what the ledger observed BEFORE this attempt — captured by the caller, so a
    /// successful rollback can restore it rather than overwriting it with a failure.
    fn rollback(&mut self, request: &DistributionRequest, cause: &str, previous: Option<Observed>) {
        match self.host.rollback(request) {
            Ok(()) => {
                // Rollback SUCCEEDED: the machine is back to what it had. Recording Failed here
                // marked a perfectly good restored version as unusable, so device readiness
                // reported an outage that had already been undone.
                match previous {
                    Some(state @ Observed::Installed { .. }) => {
                        self.ledger.set_observed(&request.component_key, state);
                    }
                    _ => {
                        self.ledger.set_observed(
                            &request.component_key,
                            Observed::Failed { detail: cause.to_string() },
                        );
                    }
                }
                self.record(request, Step::Rollback, true, None);
            }
            Err(detail) => {
                // A failed rollback is the worst case: something is on this machine and we do not
                // know what state it is in. Say so loudly rather than recording a tidy failure.
                self.ledger.set_observed(
                    &request.component_key,
                    Observed::Failed { detail: format!("rollback failed after {cause}: {detail}") },
                );
                self.record(request, Step::Rollback, false, Some(detail));
            }
        }
    }
}

/// Does this component have native privileges? Deliberately separate from a package's connector
/// grants: those say what its FLOWS may reach, and say nothing about whether this machine will
/// run an installer.
pub fn requires_native_privileges(request: &DistributionRequest) -> bool {
    request.native || request.runtime_kind == "desktop-plugin"
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    // Consent is only referenced from the tests — the pipeline itself asks the ledger rather
    // than reading the variant.
    use super::super::ledger::Consent;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeHost {
        bytes: Vec<u8>,
        fetch_error: Option<String>,
        install_error: Option<String>,
        health_error: Option<String>,
        rollback_error: Option<String>,
        cancel_after: Option<usize>,
        calls: RefCell<Vec<&'static str>>,
        polls: RefCell<usize>,
    }

    impl InstallHost for FakeHost {
        fn fetch(&self, _request: &DistributionRequest) -> Result<Vec<u8>, String> {
            self.calls.borrow_mut().push("fetch");
            match &self.fetch_error {
                Some(e) => Err(e.clone()),
                None => Ok(self.bytes.clone()),
            }
        }
        fn stage(&self, _request: &DistributionRequest, _bytes: &[u8], _staging: &Path) -> Result<(), String> {
            self.calls.borrow_mut().push("stage");
            Ok(())
        }
        fn install(&self, _request: &DistributionRequest, _staging: &Path) -> Result<(), String> {
            self.calls.borrow_mut().push("install");
            match &self.install_error {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        fn health(&self, _request: &DistributionRequest) -> Result<(), String> {
            self.calls.borrow_mut().push("health");
            match &self.health_error {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        fn rollback(&self, _request: &DistributionRequest) -> Result<(), String> {
            self.calls.borrow_mut().push("rollback");
            match &self.rollback_error {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        fn cancelled(&self) -> bool {
            let mut polls = self.polls.borrow_mut();
            *polls += 1;
            self.cancel_after.is_some_and(|after| *polls > after)
        }
    }

    fn request(bytes: &[u8]) -> DistributionRequest {
        DistributionRequest {
            component_key: "runtime".into(),
            version: "1.0.0".into(),
            runtime_kind: "managed-service".into(),
            sha256: sha256_hex(bytes),
            byte_size: bytes.len() as u64,
            url: "https://example.test/runtime.zip".into(),
            native: false,
        }
    }

    fn fixture() -> (Ledger, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-install-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        (Ledger::open(&dir), dir)
    }

    #[test]
    fn a_clean_install_walks_every_step_in_order_and_ends_healthy() {
        let (ledger, dir) = fixture();
        let payload = b"runtime payload".to_vec();
        let host = FakeHost { bytes: payload.clone(), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        pipeline.run(&request(&payload), RequireConsent::Waived).expect("installs");

        assert_eq!(*host.calls.borrow(), vec!["fetch", "stage", "install", "health"]);
        let steps: Vec<Step> = pipeline.audit().iter().map(|e| e.step.clone()).collect();
        assert_eq!(
            steps,
            vec![Step::Approve, Step::Fetch, Step::Verify, Step::Stage, Step::Install, Step::Health, Step::Activate]
        );
        assert!(pipeline.audit().iter().all(|e| e.ok), "every step is audited, and all succeeded");
        assert!(ledger.component("runtime").unwrap().is_usable());
    }

    #[test]
    fn local_confirmation_is_required_by_default() {
        // The default is Always, not "whatever the package asked for" — a package cannot waive
        // the consent that protects the user from it.
        assert_eq!(RequireConsent::default(), RequireConsent::Always);

        let (ledger, dir) = fixture();
        let payload = b"runtime payload".to_vec();
        let host = FakeHost { bytes: payload.clone(), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir.clone());

        let error = pipeline.run(&request(&payload), RequireConsent::default()).unwrap_err();
        assert_eq!(error.code(), "consent_pending");
        assert!(host.calls.borrow().is_empty(), "nothing is downloaded before the user answers");
        assert!(!ledger.component("runtime").unwrap().is_usable());

        // Once granted, the same request proceeds.
        ledger.set_consent("runtime", true, "2026-07-25T00:00:00Z");
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);
        pipeline.run(&request(&payload), RequireConsent::default()).expect("installs after consent");
        assert!(ledger.component("runtime").unwrap().is_usable());
    }

    #[test]
    fn a_digest_mismatch_is_a_tamper_and_never_a_retry() {
        let (ledger, dir) = fixture();
        let host = FakeHost { bytes: b"something else entirely".to_vec(), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let mut req = request(b"the declared payload");
        req.byte_size = "something else entirely".len() as u64; // size agrees; content does not
        let error = pipeline.run(&req, RequireConsent::Waived).unwrap_err();

        assert_eq!(error.code(), "distribution_tampered");
        assert!(!error.retriable(), "retrying a tamper is how you eventually accept one");
        // Nothing was staged or installed — verification happens before bytes are trusted.
        assert_eq!(*host.calls.borrow(), vec!["fetch"]);
        assert!(!ledger.component("runtime").unwrap().is_usable());
    }

    #[test]
    fn a_size_mismatch_is_caught_before_anything_is_written() {
        let (ledger, dir) = fixture();
        let host = FakeHost { bytes: b"short".to_vec(), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let mut req = request(b"short");
        req.byte_size = 9_999;
        let error = pipeline.run(&req, RequireConsent::Waived).unwrap_err();

        assert_eq!(error.code(), "distribution_tampered");
        assert_eq!(*host.calls.borrow(), vec!["fetch"], "nothing is staged");
    }

    #[test]
    fn an_oversize_declaration_is_refused_before_the_download() {
        let (ledger, dir) = fixture();
        let host = FakeHost::default();
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let mut req = request(b"payload");
        req.byte_size = MAX_DISTRIBUTION_BYTES + 1;
        let error = pipeline.run(&req, RequireConsent::Waived).unwrap_err();

        assert_eq!(error.code(), "invalid_size");
        assert!(host.calls.borrow().is_empty(), "refusing after the transfer protects nothing");
    }

    #[test]
    fn an_unknown_runtime_kind_never_falls_through_to_an_installer() {
        // runtime_kind SELECTS the installer and the two have different privileges.
        let (ledger, dir) = fixture();
        let host = FakeHost::default();
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let mut req = request(b"payload");
        req.runtime_kind = "something-new".into();
        assert_eq!(pipeline.run(&req, RequireConsent::Waived).unwrap_err().code(), "unsupported_runtime_kind");
        assert!(host.calls.borrow().is_empty());
    }

    #[test]
    fn a_component_key_cannot_escape_the_staging_directory() {
        let (ledger, dir) = fixture();
        let host = FakeHost::default();
        for hostile in ["../escape", "a/b", "a\\b", ""] {
            let mut pipeline = InstallPipeline::new(&host, &ledger, dir.clone());
            let mut req = request(b"payload");
            req.component_key = hostile.into();
            assert_eq!(
                pipeline.run(&req, RequireConsent::Waived).unwrap_err().code(),
                "invalid_component_key",
                "'{hostile}' must not become a directory name"
            );
        }
    }

    #[test]
    fn an_unhealthy_install_rolls_back_and_is_never_left_looking_healthy() {
        let (ledger, dir) = fixture();
        let payload = b"runtime payload".to_vec();
        let host = FakeHost {
            bytes: payload.clone(),
            health_error: Some("the service never came up".into()),
            ..Default::default()
        };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let error = pipeline.run(&request(&payload), RequireConsent::Waived).unwrap_err();
        assert_eq!(error.code(), "install_failed");
        assert!(error.retriable(), "an operational failure may be retried");
        assert!(host.calls.borrow().contains(&"rollback"));

        let record = ledger.component("runtime").unwrap();
        assert!(!record.is_usable(), "a partial install is never healthy");
        assert!(matches!(record.observed, Observed::Failed { .. }));
    }

    #[test]
    fn a_failed_rollback_says_so_rather_than_recording_a_tidy_failure() {
        // The worst case: something is on this machine and nobody knows what state it is in.
        let (ledger, dir) = fixture();
        let payload = b"runtime payload".to_vec();
        let host = FakeHost {
            bytes: payload.clone(),
            install_error: Some("the installer exited 1".into()),
            rollback_error: Some("could not remove the staged files".into()),
            ..Default::default()
        };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        pipeline.run(&request(&payload), RequireConsent::Waived).unwrap_err();

        let record = ledger.component("runtime").unwrap();
        match record.observed {
            Observed::Failed { detail } => {
                assert!(detail.contains("rollback failed"), "the ambiguity is stated, not hidden");
                assert!(detail.contains("could not remove the staged files"));
            }
            other => panic!("expected a failed state, got {other:?}"),
        }
        let rollback = pipeline.audit().iter().find(|e| e.step == Step::Rollback).expect("audited");
        assert!(!rollback.ok);
    }

    #[test]
    fn cancelling_stops_the_pipeline_and_leaves_nothing_usable() {
        let (ledger, dir) = fixture();
        let payload = b"runtime payload".to_vec();
        // Cancel after the first poll (which happens right after approve).
        let host = FakeHost { bytes: payload.clone(), cancel_after: Some(0), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let error = pipeline.run(&request(&payload), RequireConsent::Waived).unwrap_err();
        assert_eq!(error.code(), "install_cancelled");
        assert!(host.calls.borrow().is_empty(), "nothing was fetched after the cancel");
        assert!(!ledger.component("runtime").unwrap().is_usable());
    }

    #[test]
    fn every_step_is_audited_including_the_refusals() {
        // An install that did NOT happen is exactly what someone reading the audit later wants.
        let (ledger, dir) = fixture();
        let host = FakeHost::default();
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let mut req = request(b"payload");
        req.sha256 = "not-a-digest".into();
        pipeline.run(&req, RequireConsent::Waived).unwrap_err();

        assert_eq!(pipeline.audit().len(), 1);
        assert_eq!(pipeline.audit()[0].step, Step::Verify);
        assert!(!pipeline.audit()[0].ok);
        assert!(pipeline.audit()[0].detail.as_deref().unwrap().contains("sha256"));
    }

    #[test]
    fn a_waived_install_records_what_the_machine_should_have() {
        // Recording `desired` only on the consent path left a waived install at desired=Absent,
        // so the very next drift() reported the component that had just been installed as
        // something to remove.
        let (ledger, dir) = fixture();
        let payload = b"runtime payload".to_vec();
        let host = FakeHost { bytes: payload.clone(), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        pipeline.run(&request(&payload), RequireConsent::Waived).expect("installs");

        let record = ledger.component("runtime").expect("recorded");
        assert_eq!(record.desired, Desired::Present { version: "1.0.0".into() });
        assert!(ledger.drift().is_empty(), "a freshly installed component is not drift");
    }

    #[test]
    fn a_successful_rollback_restores_the_previous_working_version() {
        // Recording Failed after a SUCCESSFUL rollback marked a perfectly good restored version
        // as unusable, so device readiness reported an outage that had already been undone.
        let (ledger, dir) = fixture();
        let payload = b"v1".to_vec();

        let good = FakeHost { bytes: payload.clone(), ..Default::default() };
        InstallPipeline::new(&good, &ledger, dir.clone())
            .run(&request(&payload), RequireConsent::Waived)
            .expect("first install");
        assert!(ledger.component("runtime").unwrap().is_usable());

        // An update fails health; rollback succeeds and puts v1.0.0 back.
        let next = b"v2".to_vec();
        let bad = FakeHost {
            bytes: next.clone(),
            health_error: Some("the new build crashes".into()),
            ..Default::default()
        };
        let mut req = request(&next);
        req.version = "2.0.0".into();
        let error = InstallPipeline::new(&bad, &ledger, dir)
            .run(&req, RequireConsent::Waived)
            .unwrap_err();
        assert_eq!(error.code(), "install_failed");

        let record = ledger.component("runtime").expect("recorded");
        assert!(record.is_usable(), "the restored version is working, and says so");
        assert_eq!(record.observed, Observed::Installed { version: "1.0.0".into(), healthy: true });
    }

    #[test]
    fn a_failed_rollback_still_reports_the_component_as_unusable() {
        // The restore path must not paper over the case where nothing was restored.
        let (ledger, dir) = fixture();
        let payload = b"v1".to_vec();
        let host = FakeHost {
            bytes: payload.clone(),
            install_error: Some("installer exited 1".into()),
            rollback_error: Some("could not remove staged files".into()),
            ..Default::default()
        };
        InstallPipeline::new(&host, &ledger, dir)
            .run(&request(&payload), RequireConsent::Waived)
            .unwrap_err();

        assert!(!ledger.component("runtime").unwrap().is_usable());
    }

    #[test]
    fn a_host_that_merely_starts_with_the_loopback_address_is_not_loopback() {
        // `starts_with("http://127.0.0.1")` also matched http://127.0.0.1.attacker.test, letting
        // a plain-http distribution past the https requirement.
        let (ledger, dir) = fixture();
        let host = FakeHost::default();
        for hostile in [
            "http://127.0.0.1.attacker.test/payload.zip",
            "http://127.0.0.1evil.test/payload.zip",
            "http://localhost/payload.zip",
        ] {
            let mut req = request(b"payload");
            req.url = hostile.into();
            let error = InstallPipeline::new(&host, &ledger, dir.clone())
                .run(&req, RequireConsent::Waived)
                .unwrap_err();
            assert_eq!(error.code(), "insecure_source", "{hostile} must be refused");
        }

        // Real loopback is still allowed (a locally-served distribution).
        for ok in ["http://127.0.0.1:8080/payload.zip", "http://127.0.0.1/payload.zip"] {
            let mut req = request(b"payload");
            req.url = ok.into();
            let mut pipeline = InstallPipeline::new(&host, &ledger, dir.clone());
            let outcome = pipeline.run(&req, RequireConsent::Waived);
            // It fails LATER (the fake host returns no bytes), never at the source check.
            if let Err(e) = outcome {
                assert_ne!(e.code(), "insecure_source", "{ok} is real loopback");
            }
        }
    }

    #[test]
    fn native_privileges_are_a_separate_question_from_action_grants() {
        // A package approved to CALL something has not thereby been approved to install
        // something. The two have different blast radii.
        let mut req = request(b"payload");
        assert!(!requires_native_privileges(&req), "a managed service runs in our own sandbox");

        req.runtime_kind = "desktop-plugin".into();
        assert!(requires_native_privileges(&req), "a desktop plugin is native by kind");

        let mut req = request(b"payload");
        req.native = true;
        assert!(requires_native_privileges(&req), "or by explicit declaration");
    }

    #[test]
    fn a_denied_consent_blocks_without_touching_the_network() {
        let (ledger, dir) = fixture();
        ledger.set_desired("runtime", Desired::Present { version: "1.0.0".into() }, true);
        ledger.set_consent("runtime", false, "2026-07-25T00:00:00Z");

        let payload = b"runtime payload".to_vec();
        let host = FakeHost { bytes: payload.clone(), ..Default::default() };
        let mut pipeline = InstallPipeline::new(&host, &ledger, dir);

        let error = pipeline.run(&request(&payload), RequireConsent::Always).unwrap_err();
        assert_eq!(error.code(), "consent_denied");
        assert!(host.calls.borrow().is_empty());
        assert!(matches!(ledger.component("runtime").unwrap().consent, Consent::Denied { .. }));
    }
}
