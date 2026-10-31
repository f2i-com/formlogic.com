//! The files on this computer, under the folder OAIY gives the plugin:
//!
//! ```text
//! backups/<account>/<kind>-<id>/<time>.flbk    a sealed backup, with what FormLogic said about it in .json
//! backup-key/                                  the key, apart from the backups
//! staging/                                     a backup on its way in, or a plain one on its way to FormLogic
//! settings.json, last-run.json, schedule.json
//! backups-folder.txt                           the folder the person chose instead, if they did
//! ```
//!
//! OAIY deletes that folder when the plugin is uninstalled, so the person can choose a folder of
//! their own for the backups: `<chosen>/FormLogic Backups/<account>/...`. The key stays here.
//!
//! `<account>` stands for one server and one account, so two accounts' backups of an app with the
//! same id can't be mistaken for each other. A backup's id comes back from the page as
//! `<account>/<kind>-<id>/<time>`, so it is checked before it becomes a path. The names in it came
//! from FormLogic, and are checked the same way.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::secret_file;

const SETTINGS: &str = "settings.json";
const OUTCOME: &str = "last-run.json";
const SCHEDULE: &str = "schedule.json";
const EXTENSION: &str = "flbk";
const OPENING: &str = "opening";
const LOCATION: &str = "backups-folder.txt";
/// What is made inside the folder the person chooses, so their folder stays tidy.
const CHOSEN_FOLDER: &str = "FormLogic Backups";

/// How the schedule runs. Off until the person turns it on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub every_hours: u32,
    /// How many backups of each app or form are kept.
    pub keep: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: false, every_hours: 24, keep: 7 }
    }
}

impl Settings {
    /// A value out of range is brought into it, so a damaged file can't delete every backup.
    pub fn sane(mut self) -> Self {
        self.every_hours = self.every_hours.clamp(1, 24 * 30);
        self.keep = self.keep.clamp(1, 365);
        self
    }
}

/// One backup, as the page shows it. No paths: where a file is stays in here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackup {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub source_id: String,
    pub name: String,
    pub created_at: String,
    pub bytes: u64,
    pub counts: Value,
    /// Which key opens it. Copied in from elsewhere, it can be one this computer doesn't have.
    pub key_id: Option<String>,
    pub server: Option<String>,
    pub account_email: Option<String>,
    /// Made by the schedule, which keeps its newest few. One started any other way stays until
    /// the person deletes it.
    pub scheduled: bool,
}

/// What a backup is of, and whose it is.
pub struct About<'a> {
    pub scope: &'a str,
    pub server: &'a str,
    pub account_email: &'a str,
    pub kind: &'a str,
    pub source_id: &'a str,
    pub name: &'a str,
    pub counts: &'a Value,
    pub key_id: &'a str,
    pub scheduled: bool,
}

pub struct Store {
    root: PathBuf,
    chosen: Option<PathBuf>,
}

/// The folder for one server and one account.
pub fn scope_of(base_url: &str, account_id: &str) -> String {
    Sha256::digest(format!("{base_url}|{account_id}").as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// A source id FormLogic sent: the same rule FormLogic has for one.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn safe_kind(kind: &str) -> bool {
    kind == "app" || kind == "form"
}

fn safe_time(time: &str) -> bool {
    !time.is_empty() && time.len() <= 24 && time.chars().all(|c| c.is_ascii_alphanumeric())
}

fn safe_scope(scope: &str) -> bool {
    scope.len() == 16 && scope.chars().all(|c| c.is_ascii_hexdigit())
}

/// `<kind>-<id>`, lower case: Windows and macOS would take ids that differ only in case for the
/// same folder anyway. What a backup is of comes from its details, so they still stay apart.
fn source_folder(kind: &str, source_id: &str) -> String {
    format!("{kind}-{}", source_id.to_ascii_lowercase())
}

/// `.<16 hex>.opening`, the only name [`crate::run::open_to`] writes.
pub fn is_opening_file(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_prefix('.')).and_then(|name| name.strip_suffix(".opening")).is_some_and(|name| name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit()))
}

fn safe_folder(folder: &str) -> bool {
    folder.split_once('-').is_some_and(|(kind, rest)| safe_kind(kind) && safe_id(rest))
}

impl Store {
    pub fn open(data_dir: &Path) -> Store {
        let chosen = std::fs::read_to_string(data_dir.join(LOCATION)).ok().map(|text| PathBuf::from(text.trim())).filter(|folder| folder.is_absolute());
        Store { root: data_dir.to_path_buf(), chosen }
    }

    fn backups(&self) -> PathBuf {
        self.chosen.as_ref().map_or_else(|| self.root.join("backups"), |folder| folder.join(CHOSEN_FOLDER))
    }

    /// The folder the person chose for the backups, if they did.
    pub fn chosen_folder(&self) -> Option<&Path> {
        self.chosen.as_deref()
    }

    /// Whether the chosen folder has gone: a drive can be unplugged.
    pub fn folder_missing(&self) -> bool {
        self.chosen.as_ref().is_some_and(|folder| !folder.is_dir())
    }

    /// The backup files as they lie, each with its details, relative to the backups folder.
    fn backup_files(&self) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for scope in std::fs::read_dir(self.backups()).into_iter().flatten().flatten().filter(|entry| safe_scope(&entry.file_name().to_string_lossy())) {
            for folder in std::fs::read_dir(scope.path()).into_iter().flatten().flatten().filter(|entry| safe_folder(&entry.file_name().to_string_lossy())) {
                for file in std::fs::read_dir(folder.path()).into_iter().flatten().flatten() {
                    let path = file.path();
                    let ours = path.extension().is_some_and(|extension| extension == EXTENSION || extension == "json");
                    if ours && path.file_stem().and_then(|stem| stem.to_str()).is_some_and(safe_time) {
                        found.push(PathBuf::from(scope.file_name()).join(folder.file_name()).join(file.file_name()));
                    }
                }
            }
        }
        found
    }

    /// Moves every backup into `to`, or back into the plugin's own folder, and keeps them there
    /// from now on. Backups already in `to` stay, which is how a folder is picked up again after a
    /// reinstall. The old copies go only once every new one is in place and the choice is saved,
    /// so a failure half way leaves things as they were, with some spare copies in `to`.
    pub fn move_backups(&self, to: Option<&Path>) -> Result<usize, String> {
        if self.folder_missing() {
            return Err("The folder your backups are in isn't there. Connect its drive first.".to_string());
        }
        let target = match to {
            Some(folder) => {
                self.check_folder(folder)?;
                folder.join(CHOSEN_FOLDER)
            }
            None => self.root.join("backups"),
        };
        let from = self.backups();
        let same = std::fs::canonicalize(&from).ok().zip(std::fs::canonicalize(&target).ok()).is_some_and(|(from, target)| from == target);
        if from == target || same {
            return Ok(0);
        }
        let files = self.backup_files();
        for relative in &files {
            let (source, destination) = (from.join(relative), target.join(relative));
            let parent = destination.parent().ok_or("That folder can't be used.")?;
            secret_file::create_private_dir(parent).map_err(|e| format!("Could not make a folder for your backups: {e}"))?;
            match std::fs::metadata(&destination) {
                Ok(there) if std::fs::metadata(&source).is_ok_and(|here| here.len() == there.len()) => {}
                Ok(_) => return Err("That folder already holds a different backup under the same name. Nothing was moved.".to_string()),
                Err(_) => secret_file::copy_over(&source, &destination).map_err(|e| format!("Could not copy your backups there: {e}. Nothing was moved."))?,
            }
        }
        match to {
            Some(folder) => secret_file::write(&self.root.join(LOCATION), folder.to_string_lossy().as_bytes()).map_err(|e| format!("Could not save the folder: {e}"))?,
            None => std::fs::remove_file(self.root.join(LOCATION)).map_err(|e| format!("Could not save the folder: {e}"))?,
        }
        for relative in &files {
            let _ = std::fs::remove_file(from.join(relative));
            let mut empty = relative.parent();
            while let Some(folder) = empty.filter(|folder| !folder.as_os_str().is_empty()) {
                let _ = std::fs::remove_dir(from.join(folder));
                empty = folder.parent();
            }
        }
        Ok(files.len())
    }

    /// A folder inside the plugin's own would go with an uninstall, which is what this is to avoid.
    fn check_folder(&self, folder: &Path) -> Result<(), String> {
        let chosen = std::fs::canonicalize(folder).map_err(|_| "That folder can't be used.".to_string())?;
        let own = std::fs::canonicalize(&self.root).map_err(|e| e.to_string())?;
        if chosen.starts_with(&own) {
            return Err("That folder is inside the plugin's own, which goes when the plugin is uninstalled. Choose another.".to_string());
        }
        Ok(())
    }

    /// Where the key is: apart from the backups, so a copy of them doesn't carry what opens them.
    pub fn key_folder(&self) -> PathBuf {
        self.root.join("backup-key")
    }

    fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn settings(&self) -> Settings {
        std::fs::read(self.root.join(SETTINGS)).ok().and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok()).unwrap_or_default().sane()
    }

    pub fn set_settings(&self, settings: Settings) -> Result<Settings, String> {
        let settings = settings.sane();
        self.write_json(SETTINGS, &serde_json::to_value(&settings).map_err(|e| e.to_string())?)?;
        Ok(settings)
    }

    /// What the last run came to.
    pub fn outcome(&self) -> Option<Value> {
        std::fs::read(self.root.join(OUTCOME)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub fn note_outcome(&self, outcome: &Value) -> Result<(), String> {
        self.write_json(OUTCOME, outcome)
    }

    /// When the schedule last ran. Kept apart from the last run, so that a run of one app started
    /// by something else can't put off the next full one.
    pub fn schedule_outcome(&self) -> Option<Value> {
        std::fs::read(self.root.join(SCHEDULE)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub fn note_schedule(&self, outcome: &Value) -> Result<(), String> {
        self.write_json(SCHEDULE, outcome)
    }

    fn write_json(&self, name: &str, value: &Value) -> Result<(), String> {
        secret_file::write(&self.root.join(name), serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| format!("Could not save {name}: {e}"))
    }

    /// A new name in the staging folder.
    pub fn staging_path(&self) -> Result<PathBuf, String> {
        let folder = self.staging();
        secret_file::create_private_dir(&folder).map_err(|e| format!("Could not make the staging folder: {e}"))?;
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        Ok(folder.join(format!("{}.tmp", random.iter().map(|b| format!("{b:02x}")).collect::<String>())))
    }

    /// Says a plain copy is being written at `path`, which can be anywhere the person chose, so
    /// that a run killed half way can be cleaned up after. Gives back the note, to drop afterwards.
    pub fn note_opening(&self, path: &Path) -> Result<PathBuf, String> {
        let note = self.staging_path()?.with_extension(OPENING);
        secret_file::write(&note, path.to_string_lossy().as_bytes()).map_err(|e| format!("Could not save the backup: {e}"))?;
        Ok(note)
    }

    /// What a killed run left behind: a sealed file on its way in, or a plain one on its way out.
    pub fn sweep(&self) {
        for entry in std::fs::read_dir(self.staging()).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some(OPENING) {
                if let Some(left) = std::fs::read_to_string(&path).ok().map(PathBuf::from).filter(|left| is_opening_file(left)) {
                    let _ = std::fs::remove_file(left);
                }
            }
            let _ = std::fs::remove_file(path);
        }
    }

    /// Files a checked backup. `time` is the moment it was made, to the millisecond.
    pub fn keep(&self, staged: &Path, about: &About, time: &str, created_at: &str) -> Result<LocalBackup, String> {
        if !safe_kind(about.kind) || !safe_id(about.source_id) || !safe_time(time) || !safe_scope(about.scope) {
            return Err("FormLogic named a backup this computer can't file.".to_string());
        }
        let folder_name = source_folder(about.kind, about.source_id);
        let folder = self.backups().join(about.scope).join(&folder_name);
        secret_file::create_private_dir(&folder).map_err(|e| format!("Could not make the backup's folder: {e}"))?;
        let bytes = std::fs::metadata(staged).map(|m| m.len()).map_err(|e| e.to_string())?;
        let path = folder.join(format!("{time}.{EXTENSION}"));
        let details = json!({
            "kind": about.kind, "sourceId": about.source_id, "name": about.name, "createdAt": created_at,
            "counts": about.counts, "keyId": about.key_id, "server": about.server, "accountEmail": about.account_email, "scheduled": about.scheduled,
        });
        secret_file::write(&path.with_extension("json"), serde_json::to_vec_pretty(&details).map_err(|e| e.to_string())?).map_err(|e| format!("Could not save the backup's details: {e}"))?;
        secret_file::move_file(staged, &path).map_err(|e| format!("Could not file the backup: {e}"))?;
        Ok(LocalBackup {
            id: format!("{}/{folder_name}/{time}", about.scope),
            scope: about.scope.to_string(),
            kind: about.kind.to_string(),
            source_id: about.source_id.to_string(),
            name: about.name.to_string(),
            created_at: created_at.to_string(),
            bytes,
            counts: about.counts.clone(),
            key_id: Some(about.key_id.to_string()),
            server: Some(about.server.to_string()),
            account_email: Some(about.account_email.to_string()),
            scheduled: about.scheduled,
        })
    }

    /// Every backup here, newest first. A file with no details is still listed: it can still be opened.
    pub fn list(&self) -> Vec<LocalBackup> {
        let mut found = Vec::new();
        for scope in std::fs::read_dir(self.backups()).into_iter().flatten().flatten() {
            let scope_name = scope.file_name().to_string_lossy().to_string();
            if !safe_scope(&scope_name) {
                continue;
            }
            for folder in std::fs::read_dir(scope.path()).into_iter().flatten().flatten() {
                let folder_name = folder.file_name().to_string_lossy().to_string();
                if !safe_folder(&folder_name) {
                    continue;
                }
                let kind = folder_name.split('-').next().unwrap_or_default().to_string();
                for file in std::fs::read_dir(folder.path()).into_iter().flatten().flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
                        continue;
                    }
                    let Some(time) = path.file_stem().and_then(|s| s.to_str()).filter(|t| safe_time(t)) else { continue };
                    let about: Value = std::fs::read(path.with_extension("json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
                    let text = |field: &str| about.get(field).and_then(Value::as_str).map(str::to_string);
                    found.push(LocalBackup {
                        id: format!("{scope_name}/{folder_name}/{time}"),
                        scope: scope_name.clone(),
                        kind: kind.clone(),
                        source_id: text("sourceId").unwrap_or_else(|| folder_name.clone()),
                        name: text("name").unwrap_or_else(|| folder_name.clone()),
                        created_at: text("createdAt").unwrap_or_else(|| time.to_string()),
                        bytes: file.metadata().map(|m| m.len()).unwrap_or(0),
                        counts: about.get("counts").cloned().unwrap_or(Value::Null),
                        key_id: text("keyId"),
                        server: text("server"),
                        account_email: text("accountEmail"),
                        scheduled: about.get("scheduled").and_then(Value::as_bool).unwrap_or(false),
                    });
                }
            }
        }
        let time = |backup: &LocalBackup| backup.id.rsplit('/').next().unwrap_or_default().to_string();
        found.sort_by(|a, b| time(b).cmp(&time(a)).then_with(|| a.id.cmp(&b.id)));
        found
    }

    /// The one backup with this id, if there is one.
    pub fn find(&self, id: &str) -> Option<LocalBackup> {
        self.path_of(id).ok()?;
        self.list().into_iter().find(|backup| backup.id == id)
    }

    /// The file of a backup the page named, if there is one.
    pub fn path_of(&self, id: &str) -> Result<PathBuf, String> {
        let not_found = || "That backup is not on this computer.".to_string();
        let mut parts = id.split('/');
        let (Some(scope), Some(folder), Some(time), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err(not_found()) };
        if !safe_scope(scope) || !safe_folder(folder) || !safe_time(time) {
            return Err(not_found());
        }
        let path = self.backups().join(scope).join(folder).join(format!("{time}.{EXTENSION}"));
        if path.is_file() {
            Ok(path)
        } else {
            Err(not_found())
        }
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.path_of(id)?;
        std::fs::remove_file(&path).map_err(|e| format!("Could not delete the backup: {e}"))?;
        let _ = std::fs::remove_file(path.with_extension("json"));
        Ok(())
    }

    /// Every backup file here, for telling whether words open them.
    pub fn files(&self) -> Vec<PathBuf> {
        self.list().iter().filter_map(|backup| self.path_of(&backup.id).ok()).collect()
    }

    /// After the schedule files `newest`, keeps the `keep` latest of what it made of that app or
    /// form for that account under that key.
    ///
    /// Only the schedule's own. A backup started any other way could come from a flow as easily as
    /// from the person, and enough of those must not push a good old copy out. And backups sealed
    /// to another key are left alone: new ones are no replacement for them, because different
    /// words are what open them. `newest` stays whatever the clock says.
    pub fn prune(&self, newest: &LocalBackup, keep: u32) {
        let same = |b: &LocalBackup| b.scope == newest.scope && b.kind == newest.kind && b.source_id == newest.source_id && b.key_id == newest.key_id;
        let mut mine: Vec<LocalBackup> = self.list().into_iter().filter(|b| b.scheduled && b.id != newest.id && same(b)).collect();
        mine.sort_by(|a, b| b.id.cmp(&a.id));
        for old in mine.into_iter().skip(keep.max(1) as usize - 1) {
            let _ = self.remove(&old.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCOPE: &str = "0123456789abcdef";

    fn store(name: &str) -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-backups-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Store::open(&dir), dir)
    }

    fn file_in(store: &Store, scope: &str, kind: &str, id: &str, time: &str) -> Result<LocalBackup, String> {
        let staged = store.staging_path().unwrap();
        std::fs::write(&staged, b"sealed").unwrap();
        filed_as(store, &staged, scope, kind, id, time, true)
    }

    fn filed_as(store: &Store, staged: &Path, scope: &str, kind: &str, id: &str, time: &str, scheduled: bool) -> Result<LocalBackup, String> {
        let about = About { scope, server: "https://example.test", account_email: "a@example.test", kind, source_id: id, name: "Bookings", counts: &json!({"forms": 1}), key_id: "key-one", scheduled };
        store.keep(staged, &about, time, "2026-10-31T00:00:00Z")
    }

    fn by_hand(store: &Store, id: &str, time: &str) -> LocalBackup {
        let staged = store.staging_path().unwrap();
        std::fs::write(&staged, b"sealed").unwrap();
        filed_as(store, &staged, SCOPE, "app", id, time, false).unwrap()
    }

    fn file(store: &Store, kind: &str, id: &str, time: &str) -> Result<LocalBackup, String> {
        file_in(store, SCOPE, kind, id, time)
    }

    fn times(store: &Store) -> Vec<String> {
        store.list().into_iter().map(|b| format!("{}:{}", b.source_id, b.id.rsplit('/').next().unwrap())).collect()
    }

    #[test]
    fn a_kept_backup_is_listed_and_found() {
        let (store, dir) = store("kept");
        let backup = file(&store, "app", "a1", "20261031T000000000Z").unwrap();

        assert_eq!(store.list(), vec![backup.clone()]);
        assert!(store.path_of(&backup.id).unwrap().is_file());
        assert_eq!(store.find(&backup.id), Some(backup.clone()));
        assert_eq!(backup.bytes, 6);
        assert_eq!(backup.server.as_deref(), Some("https://example.test"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn newest_comes_first_across_sources() {
        let (store, dir) = store("order");
        file(&store, "app", "a1", "20261030T000000000Z").unwrap();
        file(&store, "form", "f1", "20261031T000000000Z").unwrap();
        file(&store, "app", "a2", "20261029T000000000Z").unwrap();
        assert_eq!(times(&store), ["f1:20261031T000000000Z", "a1:20261030T000000000Z", "a2:20261029T000000000Z"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_newest_are_kept_and_only_of_that_source() {
        let (store, dir) = store("prune");
        let mut newest = None;
        for day in 1..=4 {
            newest = Some(file(&store, "app", "a1", &format!("2026100{day}T000000000Z")).unwrap());
        }
        file(&store, "app", "a2", "20261001T000000000Z").unwrap();

        store.prune(&newest.unwrap(), 2);

        assert_eq!(times(&store), ["a1:20261004T000000000Z", "a1:20261003T000000000Z", "a2:20261001T000000000Z"]);
        let gone = store.backups().join(SCOPE).join(source_folder("app", "a1")).join("20261001T000000000Z.json");
        assert!(!gone.exists(), "its details go too");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn backups_sealed_to_another_key_are_never_pruned() {
        let (store, dir) = store("other-key");
        for day in 1..=3 {
            file(&store, "app", "a1", &format!("2026100{day}T000000000Z")).unwrap();
        }
        let mut newest = file(&store, "app", "a1", "20261004T000000000Z").unwrap();
        newest.key_id = Some("key-two".to_string());

        store.prune(&newest, 1);

        assert_eq!(store.list().len(), 4, "new words must not cost the backups the old words open");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A flow can start as many backups as it likes. A good old copy must not be pushed out by them.
    #[test]
    fn backups_started_by_anything_but_the_schedule_are_not_pruned_and_do_not_count() {
        let (store, dir) = store("by-hand");
        let good = file(&store, "app", "a1", "20261001T000000000Z").unwrap();
        for day in 2..=9 {
            by_hand(&store, "a1", &format!("2026100{day}T000000000Z"));
        }
        let newest = file(&store, "app", "a1", "20261010T000000000Z").unwrap();

        store.prune(&newest, 2);

        assert!(store.path_of(&good.id).is_ok(), "only one other backup of the schedule's: within its two");
        assert_eq!(store.list().len(), 10);
        assert!(!store.list().iter().find(|b| b.id.ends_with("20261002T000000000Z")).unwrap().scheduled);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_backup_just_filed_stays_whatever_the_clock_says() {
        let (store, dir) = store("clock");
        file(&store, "app", "a1", "20301001T000000000Z").unwrap();
        file(&store, "app", "a1", "20301002T000000000Z").unwrap();
        let newest = file(&store, "app", "a1", "20200101T000000000Z").unwrap();

        store.prune(&newest, 1);

        assert_eq!(store.list().iter().map(|b| b.id.clone()).collect::<Vec<_>>(), [newest.id.clone()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn one_accounts_backups_are_not_pruned_for_anothers() {
        let (store, dir) = store("accounts");
        let other = "fedcba9876543210";
        file_in(&store, other, "app", "a1", "20261001T000000000Z").unwrap();
        file(&store, "app", "a1", "20261002T000000000Z").unwrap();
        let newest = file(&store, "app", "a1", "20261003T000000000Z").unwrap();

        store.prune(&newest, 1);

        assert_eq!(store.list().iter().filter(|b| b.scope == other).count(), 1);
        assert_eq!(store.list().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_servers_never_share_a_folder() {
        assert_ne!(scope_of("https://one.test", "u1"), scope_of("https://two.test", "u1"));
        assert_ne!(scope_of("https://one.test", "u1"), scope_of("https://one.test", "u2"));
        assert!(safe_scope(&scope_of("https://one.test", "u1")));
    }

    #[test]
    fn ids_that_differ_only_in_case_keep_their_own_backups() {
        let (store, dir) = store("case");
        file(&store, "app", "AbC", "20261001T000000000Z").unwrap();
        file(&store, "app", "abc", "20261002T000000000Z").unwrap();
        let newest = file(&store, "app", "abc", "20261003T000000000Z").unwrap();

        store.prune(&newest, 1);

        assert_eq!(times(&store), ["abc:20261003T000000000Z", "AbC:20261001T000000000Z"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn what_a_killed_run_left_is_swept_and_nothing_else() {
        let (store, dir) = store("sweep");
        let kept = file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let staged = store.staging_path().unwrap();
        std::fs::write(&staged, b"plain").unwrap();
        store.set_settings(Settings::default()).unwrap();

        store.sweep();

        assert!(!staged.exists());
        assert!(store.path_of(&kept.id).is_ok());
        assert!(dir.join(SETTINGS).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_plain_copy_a_killed_run_left_where_the_person_chose_goes_too() {
        let (store, dir) = store("opening");
        let chosen = dir.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let left = chosen.join(".0123456789abcdef.opening");
        std::fs::write(&left, b"plain").unwrap();
        let theirs = chosen.join("their-file.zip");
        std::fs::write(&theirs, b"theirs").unwrap();
        store.note_opening(&left).unwrap();
        store.note_opening(&theirs).unwrap();

        store.sweep();

        assert!(!left.exists());
        assert!(theirs.exists(), "a note can only remove what a run writes");
        assert_eq!(std::fs::read_dir(store.staging()).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_name_from_formlogic_cannot_leave_the_folder() {
        let (store, dir) = store("names");
        assert!(file(&store, "app", "../../evil", "20261031T000000000Z").is_err());
        assert!(file(&store, "app\\x", "a1", "20261031T000000000Z").is_err());
        assert!(file(&store, "app", "a1", "..").is_err());
        assert!(file(&store, "other", "a1", "20261031T000000000Z").is_err());
        assert!(file_in(&store, "../..", "app", "a1", "20261031T000000000Z").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_id_from_the_page_cannot_leave_the_folder() {
        let (store, dir) = store("ids");
        let backup = file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let folder = backup.id.split('/').nth(1).unwrap().to_string();
        let long = format!("{SCOPE}/{folder}/20261031T000000000Z/extra");
        let upward = format!("{SCOPE}/{folder}/..");
        for id in ["../settings", "/etc/passwd", "", "a/b", SCOPE, "../../x/y/z", long.as_str(), upward.as_str()] {
            assert!(store.path_of(id).is_err(), "{id}");
            assert!(store.remove(id).is_err(), "{id}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Each part is checked, so a real file outside can't be reached by climbing out to it.
    #[test]
    fn an_id_cannot_reach_a_backup_file_outside_the_folder() {
        let (_, dir) = store("climb");
        let data = dir.join("data");
        std::fs::create_dir_all(data.join("backups")).unwrap();
        std::fs::write(dir.join("outside.flbk"), b"not yours").unwrap();
        let store = Store::open(&data);

        assert!(store.path_of("../../outside").is_err());
        assert!(store.remove("../../outside").is_err());
        assert!(dir.join("outside.flbk").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn outside(dir: &Path) -> PathBuf {
        let folder = dir.parent().unwrap().join(format!("{}-chosen", dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn backups_move_to_a_chosen_folder_and_stay_there() {
        let (store, dir) = store("chosen");
        let kept = file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let chosen = outside(&dir);

        assert_eq!(store.move_backups(Some(&chosen)).unwrap(), 2, "the backup and its details");

        let moved = Store::open(&dir);
        assert_eq!(moved.chosen_folder(), Some(chosen.as_path()));
        assert_eq!(moved.list(), vec![kept.clone()], "the same backup, under the same id");
        assert!(moved.path_of(&kept.id).unwrap().starts_with(chosen.join(CHOSEN_FOLDER)));
        assert!(!dir.join("backups").join(SCOPE).exists(), "nothing is left behind");

        let next = file(&moved, "app", "a1", "20261101T000000000Z").unwrap();
        assert!(moved.path_of(&next.id).unwrap().starts_with(&chosen), "new backups go there too");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(chosen);
    }

    #[test]
    fn backups_come_back_to_the_plugins_own_folder() {
        let (store, dir) = store("back");
        let kept = file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let chosen = outside(&dir);
        store.move_backups(Some(&chosen)).unwrap();

        Store::open(&dir).move_backups(None).unwrap();

        let back = Store::open(&dir);
        assert_eq!(back.chosen_folder(), None);
        assert!(back.path_of(&kept.id).unwrap().starts_with(dir.join("backups")));
        assert!(!chosen.join(CHOSEN_FOLDER).join(SCOPE).exists());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(chosen);
    }

    /// What an uninstall and a reinstall come to: an empty plugin folder, and the same folder chosen.
    #[test]
    fn a_folder_chosen_again_after_a_reinstall_brings_its_backups_back() {
        let (store, dir) = store("reinstall");
        let kept = file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let chosen = outside(&dir);
        store.move_backups(Some(&chosen)).unwrap();
        let (fresh, fresh_dir) = self::store("reinstall-fresh");
        assert!(fresh.list().is_empty());

        assert_eq!(fresh.move_backups(Some(&chosen)).unwrap(), 0);

        assert_eq!(Store::open(&fresh_dir).list(), vec![kept]);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(fresh_dir);
        let _ = std::fs::remove_dir_all(chosen);
    }

    #[test]
    fn a_folder_inside_the_plugins_own_is_refused() {
        let (store, dir) = store("inside");
        let inside = dir.join("mine");
        std::fs::create_dir_all(&inside).unwrap();

        assert!(store.move_backups(Some(&inside)).unwrap_err().contains("uninstalled"));
        assert!(store.move_backups(Some(&dir)).unwrap_err().contains("uninstalled"));
        assert_eq!(Store::open(&dir).chosen_folder(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_move_that_cannot_finish_leaves_the_backups_where_they_were() {
        let (store, dir) = store("clash");
        let kept = file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let chosen = outside(&dir);
        let clash = chosen.join(CHOSEN_FOLDER).join(SCOPE).join(source_folder("app", "a1"));
        std::fs::create_dir_all(&clash).unwrap();
        std::fs::write(clash.join("20261031T000000000Z.flbk"), b"something else").unwrap();

        assert!(store.move_backups(Some(&chosen)).unwrap_err().contains("Nothing was moved"));

        let same = Store::open(&dir);
        assert_eq!(same.chosen_folder(), None);
        assert_eq!(same.list(), vec![kept]);
        assert_eq!(std::fs::read(clash.join("20261031T000000000Z.flbk")).unwrap(), b"something else");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(chosen);
    }

    #[test]
    fn moving_to_where_they_already_are_does_nothing() {
        let (store, dir) = store("same");
        file(&store, "app", "a1", "20261031T000000000Z").unwrap();
        let chosen = outside(&dir);
        store.move_backups(Some(&chosen)).unwrap();
        let moved = Store::open(&dir);

        assert_eq!(moved.move_backups(Some(&chosen)).unwrap(), 0);

        assert_eq!(Store::open(&dir).list().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(chosen);
    }

    #[test]
    fn a_drive_that_has_gone_is_noticed_and_nothing_moves() {
        let (store, dir) = store("gone");
        let chosen = outside(&dir);
        store.move_backups(Some(&chosen)).unwrap();
        std::fs::remove_dir_all(&chosen).unwrap();

        let gone = Store::open(&dir);
        assert!(gone.folder_missing());
        assert!(gone.list().is_empty());
        assert!(gone.move_backups(None).unwrap_err().contains("isn't there"));
        assert_eq!(Store::open(&dir).chosen_folder(), Some(chosen.as_path()), "the choice stands for when it comes back");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_location_means_the_plugins_own_folder() {
        let (_, dir) = store("location");
        std::fs::write(dir.join(LOCATION), "not/absolute").unwrap();
        assert_eq!(Store::open(&dir).chosen_folder(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_schedule_is_off_until_turned_on() {
        let (store, dir) = store("off");
        assert_eq!(store.settings(), Settings::default());
        assert!(!store.settings().enabled);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_out_of_range_are_brought_into_it() {
        let (store, dir) = store("range");
        let saved = store.set_settings(Settings { enabled: true, every_hours: 0, keep: 0 }).unwrap();
        assert_eq!(saved, Settings { enabled: true, every_hours: 1, keep: 1 });
        assert_eq!(store.settings(), saved);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_settings_file_means_the_defaults() {
        let (store, dir) = store("damaged");
        std::fs::write(dir.join(SETTINGS), "not json").unwrap();
        assert_eq!(store.settings(), Settings::default());
        let _ = std::fs::remove_dir_all(dir);
    }
}
