//! A backup run, and the schedule that starts one.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use oaiy_crypto::x25519::SecretKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::client::{self, Refusal};
use crate::identity::NodeIdentity;
use crate::link::{self, Account};
use crate::store::{self, About, LocalBackup, Store};
use crate::{envelope, keys};

/// FormLogic takes 12 of these a minute from an account.
pub const PACE: Duration = Duration::from_secs(6);
/// After being told to wait.
const BACK_OFF: Duration = Duration::from_secs(65);
/// How often the schedule looks.
const LOOK_EVERY: Duration = Duration::from_secs(60);
/// A run that couldn't start waits this long for its next try, not a whole interval.
const RETRY_HOURS: i64 = 1;
/// More than any account should have. Each is a build on the server and files here.
pub const MAX_SOURCES: usize = 2000;
/// Failures kept word for word. A line to OAIY can't be longer than 1 MiB, and these go in one.
const MAX_FAILURES: usize = 50;
/// The longest name kept. FormLogic's are shorter; a caller's needn't be.
const MAX_NAME: usize = 200;

static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

/// One at a time, the schedule's or a person's.
struct OneRun;

impl OneRun {
    fn claim() -> Option<OneRun> {
        RUNNING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).ok().map(|_| OneRun)
    }
}

impl Drop for OneRun {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

/// Does `work` with no run going, for something that moves the files a run writes.
pub fn alone<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _one = OneRun::claim().ok_or("A backup is running. Try again when it finishes.")?;
    work()
}

/// One app or form to back up, with its name for saying what failed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Source {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub name: String,
    pub reason: String,
}

/// What a run came to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub at: String,
    pub saved: u32,
    /// The first few.
    pub failed: Vec<Failure>,
    pub failed_total: u32,
    /// Why it stopped early, when the words mean the person has something to do.
    pub stopped: Option<String>,
}

impl Outcome {
    fn note_failure(&mut self, name: &str, reason: String) {
        self.failed_total += 1;
        if self.failed.len() < MAX_FAILURES {
            self.failed.push(Failure { name: short(name), reason });
        }
    }
}

pub fn short(name: &str) -> String {
    name.chars().take(MAX_NAME).collect()
}

/// Every app, and every form that isn't in one: an app's backup carries its forms.
pub fn everything(sources: &Value) -> Vec<Source> {
    let mut all = Vec::new();
    for app in sources.get("apps").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = app.get("id").and_then(Value::as_str) {
            all.push(Source { kind: "app".into(), id: id.into(), name: app.get("name").and_then(Value::as_str).unwrap_or(id).to_string() });
        }
    }
    for form in sources.get("forms").and_then(Value::as_array).into_iter().flatten() {
        let in_app = form.get("inApp").and_then(Value::as_bool).unwrap_or(false);
        if let (false, Some(id)) = (in_app, form.get("id").and_then(Value::as_str)) {
            all.push(Source { kind: "form".into(), id: id.into(), name: form.get("title").and_then(Value::as_str).unwrap_or(id).to_string() });
        }
    }
    all
}

/// Cuts a list down to what one run takes, and says so: a run that quietly left apps out would
/// look like a backup of everything.
fn within_limit(mut sources: Vec<Source>, outcome: &mut Outcome) -> Vec<Source> {
    if sources.len() > MAX_SOURCES {
        outcome.note_failure("Everything else", format!("One run takes {MAX_SOURCES} apps and forms, and this account has {}.", sources.len()));
        sources.truncate(MAX_SOURCES);
    }
    sources
}

/// Whether the schedule should run now.
pub fn due(enabled: bool, every_hours: u32, last: Option<&Value>, now: DateTime<Utc>) -> bool {
    if !enabled {
        return false;
    }
    let Some(last) = last else { return true };
    let at = last.get("at").and_then(Value::as_str).and_then(|at| DateTime::parse_from_rfc3339(at).ok());
    let Some(at) = at else { return true };
    // A time ahead of now is a clock that was put right: don't wait for it to come round.
    if at.with_timezone(&Utc) > now {
        return true;
    }
    let wait = if last.get("stopped").is_some_and(|stopped| !stopped.is_null()) { RETRY_HOURS } else { i64::from(every_hours) };
    now.signed_duration_since(at.with_timezone(&Utc)) >= chrono::Duration::hours(wait)
}

/// Decrypts a sealed file through a hash, writing nothing: this is how a backup is known to be
/// whole and openable with the key here, before it is filed as one.
pub fn sha256_of_opened(path: &Path, key: &SecretKey) -> Result<String, String> {
    struct Hashing(Sha256);
    impl Write for Hashing {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut reader = std::io::BufReader::new(std::fs::File::open(path).map_err(|e| format!("Could not read the backup: {e}"))?);
    let mut hashing = Hashing(Sha256::new());
    envelope::open(&mut reader, &mut hashing, key)?;
    Ok(hashing.0.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Opens a backup into a new file at `destination`. On any failure nothing is left there, and if
/// the program is killed half way, [`Store::sweep`] clears up next time.
pub fn open_to(store: &Store, sealed: &Path, destination: &Path, key: &SecretKey) -> Result<(), String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let staged: PathBuf = destination.with_file_name(format!(".{}.opening", random.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let note = store.note_opening(&staged)?;
    let result = (|| {
        let mut reader = std::io::BufReader::new(std::fs::File::open(sealed).map_err(|e| format!("Could not read the backup: {e}"))?);
        let file = crate::secret_file::create_new_owner_only(&staged).map_err(|e| format!("Could not save the backup: {e}"))?;
        let mut out = std::io::BufWriter::new(file);
        envelope::open(&mut reader, &mut out, key)?;
        out.flush().map_err(|e| format!("Could not save the backup: {e}"))?;
        drop(out);
        crate::secret_file::rename_over(&staged, destination).map_err(|e| format!("Could not save the backup: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    let _ = std::fs::remove_file(note);
    result
}

/// One source: asked for, fetched, checked and filed. Only a checked file is filed. `keep` is how
/// many the schedule keeps, for a run the schedule started.
fn one(account: &Account, identity: &NodeIdentity, key: &SecretKey, store: &Store, source: &Source, keep: Option<u32>) -> Result<LocalBackup, Refusal> {
    let (backup_id, header) = client::create(account, identity, &source.kind, &source.id, &keys::public_b64(key))?;
    let staged = store.staging_path().map_err(Refusal::Failed)?;
    let scope = store::scope_of(&account.base_url, &account.account_id);
    let key_id = keys::key_id(key);
    let filed = (|| {
        client::fetch(account, &backup_id, &staged)?;
        let sha256 = sha256_of_opened(&staged, key).map_err(Refusal::Failed)?;
        if Some(sha256.as_str()) != header.get("zipSha256").and_then(Value::as_str) {
            return Err(Refusal::Failed("The backup that arrived is not the one FormLogic made.".to_string()));
        }
        let now = Utc::now();
        let about = About {
            scope: &scope,
            server: &account.base_url,
            account_email: &account.account_email,
            kind: &source.kind,
            source_id: &source.id,
            name: &short(header.pointer("/source/name").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or(&source.id)),
            counts: header.get("counts").unwrap_or(&Value::Null),
            key_id: &key_id,
            scheduled: keep.is_some(),
        };
        store.keep(&staged, &about, &now.format("%Y%m%dT%H%M%S%3fZ").to_string(), &now.to_rfc3339_opts(SecondsFormat::Secs, true)).map_err(Refusal::Failed)
    })();
    let _ = std::fs::remove_file(&staged);
    client::discard(account, &backup_id);
    let filed = filed?;
    if let Some(keep) = keep {
        store.prune(&filed, keep);
    }
    Ok(filed)
}

/// Who started a run. Only the schedule's backups are ever pruned, and only its runs count for
/// when the next one is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Started {
    BySchedule,
    ByCommand,
}

/// How many of each the run keeps: only the schedule's backups are ever pruned.
fn kept_by(started: Started, store: &Store) -> Option<u32> {
    (started == Started::BySchedule).then(|| store.settings().keep)
}

/// Backs up `only`, or everything. Refuses to start a second run alongside the first. `progress`
/// hears how far it has got, in words with no names in them.
pub fn back_up(data: &Path, only: Option<Vec<Source>>, pace: Duration, started: Started, progress: &dyn Fn(&str)) -> Result<Outcome, String> {
    let _one = OneRun::claim().ok_or("A backup is already running.")?;
    let store = Store::open(data);
    let mut outcome = Outcome { at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true), saved: 0, failed: Vec::new(), failed_total: 0, stopped: None };
    // Whatever stops it is said on the page: a run that left no word would be tried again a minute later.
    if let Err(words) = run_sources(data, &store, only, pace, started, &mut outcome, progress) {
        outcome.stopped = Some(words);
    }
    store.note_outcome(&json!(outcome))?;
    if started == Started::BySchedule {
        store.note_schedule(&json!({"at": outcome.at, "stopped": outcome.stopped}))?;
    }
    Ok(outcome)
}

fn run_sources(data: &Path, store: &Store, only: Option<Vec<Source>>, pace: Duration, started: Started, outcome: &mut Outcome, progress: &dyn Fn(&str)) -> Result<(), String> {
    let account = link::load(data)?.ok_or("Connect to FormLogic first.")?;
    let key = keys::load(&store.key_folder())?.ok_or("Set up your twelve words first.")?;
    if store.folder_missing() {
        return Err("The folder your backups go to isn't there. Connect its drive, or choose another.".to_string());
    }
    let identity = NodeIdentity::load_or_create(data)?;
    let keep = kept_by(started, store);
    let sources = match only {
        Some(sources) => sources,
        None => client::sources(&account).map(|sources| everything(&sources)).map_err(|refusal| refusal.words())?,
    };
    let sources = within_limit(sources, outcome);
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            std::thread::sleep(pace);
        }
        progress(&format!("Backing up {} of {}", index + 1, sources.len()));
        let mut result = one(&account, &identity, &key, store, source, keep);
        if result == Err(Refusal::Busy) {
            std::thread::sleep(BACK_OFF);
            result = one(&account, &identity, &key, store, source, keep);
        }
        match result {
            Ok(_) => outcome.saved += 1,
            Err(refusal) if refusal.stops_a_run() => return Err(refusal.words()),
            Err(refusal) => outcome.note_failure(&source.name, refusal.words()),
        }
    }
    Ok(())
}

/// Puts a backup on this computer back in FormLogic, as new copies.
pub fn restore(data: &Path, id: &str) -> Result<Value, String> {
    let store = Store::open(data);
    let account = link::load(data)?.ok_or("Connect to FormLogic first.")?;
    let key = keys::load(&store.key_folder())?.ok_or("Set up your twelve words first.")?;
    let identity = NodeIdentity::load_or_create(data)?;
    let sealed = store.path_of(id)?;
    let plain = store.staging_path()?;
    let result = (|| {
        open_to(&store, &sealed, &plain, &key)?;
        let sha256 = sha256_of_file(&plain)?;
        client::restore(&account, &identity, &plain, &sha256).map_err(|refusal| refusal.words())
    })();
    let _ = std::fs::remove_file(&plain);
    result
}

fn sha256_of_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("Could not read the backup: {e}"))?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|e| format!("Could not read the backup: {e}"))?;
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The schedule. It reads the link and the settings each time, so nothing need start or stop it.
pub fn spawn(data: PathBuf) {
    std::thread::spawn(move || {
        // A run that couldn't even say how it went (a full disk) has left `due` true.
        let mut not_before = None;
        loop {
            std::thread::sleep(LOOK_EVERY);
            let store = Store::open(&data);
            let settings = store.settings();
            let waiting = not_before.is_some_and(|until| std::time::Instant::now() < until);
            let linked = matches!(link::load(&data), Ok(Some(_)));
            if waiting || !keys::exists(&store.key_folder()) || !linked || !due(settings.enabled, settings.every_hours, store.schedule_outcome().as_ref(), Utc::now()) {
                continue;
            }
            match back_up(&data, None, PACE, Started::BySchedule, &|_| {}) {
                Ok(_) => not_before = None,
                Err(_) => not_before = Some(std::time::Instant::now() + Duration::from_secs(RETRY_HOURS as u64 * 3600)),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 31, hour, 0, 0).unwrap()
    }

    #[test]
    fn nothing_runs_while_the_schedule_is_off() {
        assert!(!due(false, 24, None, at(12)));
    }

    #[test]
    fn the_first_run_is_due_at_once() {
        assert!(due(true, 24, None, at(12)));
    }

    #[test]
    fn a_run_waits_its_interval() {
        let last = json!({"at": "2026-10-31T00:00:00Z", "stopped": null});
        assert!(!due(true, 24, Some(&last), at(23)));
        assert!(due(true, 12, Some(&last), at(12)));
    }

    #[test]
    fn a_run_that_could_not_start_tries_again_soon() {
        let last = json!({"at": "2026-10-31T00:00:00Z", "stopped": "Connect again"});
        assert!(!due(true, 24, Some(&last), Utc.with_ymd_and_hms(2026, 10, 31, 0, 30, 0).unwrap()));
        assert!(due(true, 24, Some(&last), at(1)));
    }

    #[test]
    fn a_clock_put_right_does_not_stop_the_schedule() {
        assert!(due(true, 24, Some(&json!({"at": "2027-01-01T00:00:00Z", "stopped": null})), at(12)));
    }

    #[test]
    fn a_time_that_cannot_be_read_does_not_stop_backups_for_good() {
        assert!(due(true, 24, Some(&json!({"at": "yesterday"})), at(12)));
    }

    #[test]
    fn everything_is_every_app_and_the_forms_outside_them() {
        let sources = json!({
            "apps": [{"id": "a1", "name": "Bookings"}],
            "forms": [{"id": "f1", "title": "In the app", "inApp": true}, {"id": "f2", "title": "Alone", "inApp": false}],
        });
        let names: Vec<String> = everything(&sources).into_iter().map(|source| format!("{}:{}:{}", source.kind, source.id, source.name)).collect();
        assert_eq!(names, ["app:a1:Bookings", "form:f2:Alone"]);
    }

    fn outcome() -> Outcome {
        Outcome { at: String::new(), saved: 0, failed: Vec::new(), failed_total: 0, stopped: None }
    }

    #[test]
    fn only_a_scheduled_run_prunes() {
        let store = Store::open(&std::env::temp_dir().join("fl-backups-no-such-folder"));
        assert_eq!(kept_by(Started::BySchedule, &store), Some(7));
        assert_eq!(kept_by(Started::ByCommand, &store), None);
    }

    #[test]
    fn a_run_that_has_to_leave_apps_out_says_so() {
        let mut said = outcome();
        let source = Source { kind: "app".into(), id: "a".into(), name: String::new() };
        let kept = within_limit(vec![source; MAX_SOURCES + 1], &mut said);
        assert_eq!(kept.len(), MAX_SOURCES);
        assert_eq!(said.failed_total, 1);
    }

    #[test]
    fn what_a_run_says_stays_short_enough_to_send() {
        let mut said = outcome();
        for _ in 0..(MAX_FAILURES * 2) {
            said.note_failure(&"n".repeat(100_000), "reason".to_string());
        }
        assert_eq!(said.failed_total as usize, MAX_FAILURES * 2);
        assert_eq!(said.failed.len(), MAX_FAILURES);
        assert!(json!(said).to_string().len() < 20_000);
    }

    #[test]
    fn a_failed_open_leaves_nothing_where_the_person_chose() {
        let dir = std::env::temp_dir().join(format!("fl-backups-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sealed = dir.join("sealed.flbk");
        std::fs::write(&sealed, b"not a backup").unwrap();
        let destination = dir.join("out.zip");

        assert!(open_to(&Store::open(&dir), &sealed, &destination, &SecretKey::generate().unwrap()).is_err());

        assert!(!destination.exists());
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().ends_with(".opening")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn opening_writes_the_plain_file_where_the_person_chose() {
        let dir = std::env::temp_dir().join(format!("fl-backups-run-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let key = SecretKey::generate().unwrap();
        let sealed = dir.join("sealed.flbk");
        std::fs::write(&sealed, envelope::sealed_for_tests(&key)).unwrap();
        let destination = dir.join("out.zip");

        open_to(&Store::open(&dir), &sealed, &destination, &key).unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"sealed");
        assert_eq!(sha256_of_opened(&sealed, &key).unwrap(), sha256_of_file(&destination).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_second_run_is_refused_while_the_first_holds_its_place() {
        let first = OneRun::claim().expect("nothing is running");
        assert!(OneRun::claim().is_none());
        assert!(alone(|| Ok(())).is_err(), "nor can the files be moved from under it");
        drop(first);
        assert!(alone(|| Ok(())).is_ok());
        assert!(OneRun::claim().is_some());
    }
}
