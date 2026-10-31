//! What OAIY can ask the plugin to do. `manifest.json` lists the same commands.
//!
//! OAIY's relay passes a command that isn't journalled to the linked FormLogic, and stores the
//! answer there, so only `status.get` and `settings.get` go without: they say how things stand and
//! name no app, file or person. Everything else is journalled, which keeps the relay out.
//!
//! A flow, an app script or the agent on this computer can still send a journalled command. So
//! anything that could do harm in the wrong hands (showing or setting the key, deleting, saving a
//! plain copy, restoring, changing the server, turning backups down) waits for the person in a
//! window of the plugin's own ([`crate::native`]). Those commands start a job and answer with its
//! id, because nobody knows how long a person takes. The twelve words are never in an answer.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::client::{self, Refusal};
use crate::identity::{self, NodeIdentity};
use crate::jobs::{Jobs, Started};
use crate::link::{self, Account};
use crate::run::{self, Source};
use crate::store::{self, LocalBackup, Settings, Store};
use crate::{keys, native};

/// How often FormLogic is asked about this computer while it waits for the owner's approval. They
/// are usually looking at both screens when they give it.
const WATCH: Duration = Duration::from_secs(45);
/// How often once approved.
const WATCH_APPROVED: Duration = Duration::from_secs(300);
/// How often while the page is open and approval is what it is waiting for.
const WATCH_PAGE: Duration = Duration::from_secs(10);
/// How often FormLogic hears that this computer is still here.
const HEARTBEAT: Duration = Duration::from_secs(3600);
/// The most backups in one answer: a line to OAIY can't be longer than 1 MiB.
const MAX_PAGE: usize = 500;

const NOT_NOW: &str = "Nothing was changed.";

/// How this computer stands with FormLogic, as last heard.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Standing {
    node: Option<client::Node>,
    relink: bool,
    not_offered: bool,
}

pub struct App {
    data: PathBuf,
    jobs: Jobs,
    standing: Mutex<Standing>,
    signing_in: AtomicBool,
    last_asked: Mutex<Option<Instant>>,
}

impl App {
    fn new(data: PathBuf) -> App {
        App { data, jobs: Jobs::default(), standing: Mutex::new(Standing::default()), signing_in: AtomicBool::new(false), last_asked: Mutex::new(None) }
    }

    /// Called once, when OAIY says the plugin may begin.
    pub fn start(data: PathBuf) -> Arc<App> {
        let app = Arc::new(App::new(data.clone()));
        Store::open(&data).sweep();
        run::spawn(data);
        let watching = app.clone();
        std::thread::spawn(move || watching.watch());
        app
    }

    fn store(&self) -> Store {
        Store::open(&self.data)
    }

    fn standing(&self) -> Standing {
        self.standing.lock().map(|standing| standing.clone()).unwrap_or_default()
    }

    fn note(&self, change: impl FnOnce(&mut Standing)) {
        if let Ok(mut standing) = self.standing.lock() {
            change(&mut standing);
        }
    }

    fn watch(&self) {
        let mut last_said = None;
        loop {
            if let Ok(Some(account)) = link::load(&self.data) {
                let heartbeat = last_said.is_none_or(|at: Instant| at.elapsed() >= HEARTBEAT);
                self.ask_formlogic(&account, heartbeat);
                if heartbeat {
                    last_said = Some(Instant::now());
                }
            }
            let approved = self.standing().node.is_some_and(|node| node.approved);
            std::thread::sleep(if approved { WATCH_APPROVED } else { WATCH });
        }
    }

    /// Hears how this computer stands. `register` also says who it is, which is how FormLogic
    /// learns of a new link, and that it is still here.
    fn ask_formlogic(&self, account: &Account, register: bool) {
        let asked = if register {
            NodeIdentity::load_or_create(&self.data).map_err(Refusal::Failed).and_then(|identity| client::register(account, &identity, &display_name()))
        } else {
            client::self_node(account)
        };
        match asked {
            Ok(node) => self.note(|standing| *standing = Standing { node, relink: false, not_offered: false }),
            Err(Refusal::Relink) => self.note(|standing| standing.relink = true),
            Err(Refusal::NotOffered) => self.note(|standing| standing.not_offered = true),
            Err(_) => {}
        }
    }

    fn status(&self) -> Value {
        let store = self.store();
        let account = link::load(&self.data).ok().flatten();
        let standing = self.standing();
        let has_key = keys::exists(&store.key_folder());
        let running = run::running();
        let approved = standing.node.as_ref().is_some_and(|node| node.approved);
        let (state, detail) = match () {
            () if account.is_none() => ("needs-link", "Not connected to FormLogic"),
            () if standing.relink => ("needs-link", "FormLogic no longer accepts this link"),
            () if standing.not_offered => ("not-offered", "This FormLogic doesn't offer backups"),
            () if !approved => ("needs-approval", "Waiting for approval in FormLogic"),
            () if !has_key => ("needs-words", "Twelve words not set up"),
            () if running => ("running", "Backing up"),
            () => ("ready", "Ready"),
        };
        let fingerprint = account.as_ref().and_then(|_| NodeIdentity::load_or_create(&self.data).ok()).map(|identity| identity::display_fingerprint(&identity.fingerprint()));
        let last = store.outcome();
        let last_run = last.as_ref().map(|outcome| {
            json!({
                "at": outcome.get("at"),
                "saved": outcome.get("saved"),
                "failed": outcome.get("failedTotal"),
                "stopped": outcome.get("stopped"),
            })
        });
        json!({
            "state": state,
            "detail": detail,
            "linked": account.is_some(),
            "approved": approved,
            "nodeStatus": standing.node.as_ref().map(|node| node.status.clone()),
            "fingerprint": fingerprint,
            "canAsk": native::can_ask(),
            "hasKey": has_key,
            "keyId": keys::saved_id(&store.key_folder()),
            "running": running,
            "lastRun": last_run,
        })
    }

    /// Who this computer is linked to. Names a person, so it is journalled.
    fn link_details(self: &Arc<Self>) -> Result<Value, String> {
        // A damaged link reads as no link, so the page offers Connect, which replaces it.
        Ok(match link::load(&self.data).ok().flatten() {
            Some(account) => {
                self.look_for_approval(&account);
                json!({"linked": true, "server": account.base_url, "accountEmail": account.account_email})
            }
            None => json!({"linked": false}),
        })
    }

    /// The owner is usually looking at both screens when they approve, so while the page is open
    /// it shouldn't take the watcher's 45 seconds to show. The page asks about the link every few
    /// seconds; FormLogic is asked less often than that.
    fn look_for_approval(self: &Arc<Self>, account: &Account) {
        if self.standing().node.is_some_and(|node| node.approved) {
            return;
        }
        if let Ok(mut last) = self.last_asked.lock() {
            if last.is_some_and(|at| at.elapsed() < WATCH_PAGE) {
                return;
            }
            *last = Some(Instant::now());
        }
        let (app, account) = (self.clone(), account.clone());
        std::thread::spawn(move || app.ask_formlogic(&account, false));
    }

    fn backups(&self, payload: &Value) -> Value {
        let store = self.store();
        let all = store.list();
        let offset = number(payload, "offset").unwrap_or(0) as usize;
        let page: Vec<&LocalBackup> = all.iter().skip(offset).take(page_size(payload)).collect();
        json!({"backups": page, "total": all.len(), "lastRun": store.outcome()})
    }

    /// Starts `work` as a job and answers with its id. A request sent again finds its first job.
    fn job(self: &Arc<Self>, request_id: Option<&str>, command: &str, work: impl FnOnce(&App, &str) -> Result<Value, String> + Send + 'static) -> Result<Value, String> {
        let id = match self.jobs.start(request_id, command)? {
            Started::Again(id) => return Ok(json!({"jobId": id})),
            Started::New(id) => id,
        };
        let (app, running) = (self.clone(), id.clone());
        std::thread::spawn(move || {
            let outcome = work(&app, &running);
            app.jobs.finish(&running, outcome);
        });
        Ok(json!({"jobId": id}))
    }

    fn connect(&self, job: &str, server: &str) -> Result<Value, String> {
        if self.signing_in.swap(true, Ordering::AcqRel) {
            return Err("A sign-in is already waiting in your browser.".to_string());
        }
        let result = self.sign_in(job, server);
        self.signing_in.store(false, Ordering::Release);
        result
    }

    fn sign_in(&self, job: &str, server: &str) -> Result<Value, String> {
        if link::load(&self.data).ok().flatten().is_some() && !self.standing().relink {
            return Err("This computer is linked already. Forget that link first.".to_string());
        }
        let asked = format!(
            "Connect FormLogic Backups to this server?\n\n{server}\n\nYour browser will open so you can sign in. Only go on if you know this server: restoring a backup sends everything in it there."
        );
        if !native::confirm(&asked)? {
            return Err(NOT_NOW.to_string());
        }
        self.jobs.step(job, "Waiting for you to sign in in your browser");
        let account = link::sign_in(server, native::computer_name().as_deref())?;
        link::save(&self.data, &account)?;
        self.note(|standing| *standing = Standing::default());
        self.ask_formlogic(&account, true);
        Ok(json!({"server": account.base_url, "accountEmail": account.account_email}))
    }

    fn forget(&self) -> Result<Value, String> {
        let account = link::load(&self.data)?.ok_or("This computer isn't linked to FormLogic.")?;
        let asked = format!(
            "Forget the link to {} ({})?\n\nThis computer stops taking backups from that account. The backups already here stay.",
            account.base_url, account.account_email
        );
        if !native::confirm(&asked)? {
            return Err(NOT_NOW.to_string());
        }
        // FormLogic is told first, while the key still works. If it can't be reached the key is
        // still forgotten here, and the page says where to finish the job.
        let ended = client::unlink(&account).is_ok();
        link::remove(&self.data)?;
        self.note(|standing| *standing = Standing::default());
        Ok(json!({"endedAtServer": ended}))
    }

    fn set_up_key(&self) -> Result<Value, String> {
        let folder = self.store().key_folder();
        let words = keys::new_words(&folder)?;
        if !native::show_words(words.expose())? {
            return Err(NOT_NOW.to_string());
        }
        let key = keys::recover(&folder, words.expose(), &[])?;
        Ok(json!({"keyId": keys::key_id(&key)}))
    }

    fn recover_key(&self, words: &str) -> Result<Value, String> {
        let store = self.store();
        let new = keys::id_of_words(words)?;
        let asked = match keys::saved_id(&store.key_folder()) {
            Some(now) if now != new => format!(
                "Replace the key on this computer with the one these twelve words make?\n\nNow: {now}\nNew: {new}\n\nNew backups will be sealed to the new key, so anyone who has those words can open them. Backups already here stay as they are."
            ),
            _ => format!("Use the key these twelve words make?\n\nKey: {new}\n\nNew backups will be sealed to it, so anyone who has those words can open them."),
        };
        if !native::confirm(&asked)? {
            return Err(NOT_NOW.to_string());
        }
        let key = keys::recover(&store.key_folder(), words, &store.files())?;
        Ok(json!({"keyId": keys::key_id(&key)}))
    }

    fn set_settings(&self, wanted: Settings) -> Result<Value, String> {
        let store = self.store();
        let current = store.settings();
        let wanted = wanted.sane();
        let mut changes = Vec::new();
        if wanted.enabled != current.enabled {
            changes.push(if wanted.enabled { "Take backups on a schedule." } else { "Stop taking backups on a schedule." }.to_string());
        }
        if wanted.every_hours != current.every_hours {
            changes.push(format!("Back up every {} hours, not every {}. Older backups go sooner the more often this runs.", wanted.every_hours, current.every_hours));
        }
        if wanted.keep != current.keep {
            changes.push(format!("Keep {} of each from the schedule, not {}. Older ones are deleted at the next backup.", wanted.keep, current.keep));
        }
        if !changes.is_empty() && !native::confirm(&format!("Change your backups?\n\n{}", changes.join("\n")))? {
            return Err(NOT_NOW.to_string());
        }
        Ok(json!(store.set_settings(wanted)?))
    }

    fn save_plain(&self, id: &str) -> Result<Value, String> {
        let store = self.store();
        let backup = store.find(id).ok_or("That backup is not on this computer.")?;
        let key = keys::load(&store.key_folder())?.ok_or("Enter your twelve words first.")?;
        let prompt = "Save a plain copy. Anyone who gets this file can read everything in it.";
        let Some(destination) = native::save_as(prompt, &plain_name(&backup))? else { return Err(NOT_NOW.to_string()) };
        run::open_to(&store, &store.path_of(id)?, &destination, &key)?;
        Ok(json!({"saved": true}))
    }

    fn restore(&self, job: &str, id: &str) -> Result<Value, String> {
        let backup = self.store().find(id).ok_or("That backup is not on this computer.")?;
        let account = link::load(&self.data)?.ok_or("Connect to FormLogic first.")?;
        let asked = format!(
            "Restore \"{}\" from {}?\n\nEverything in this backup goes to {} ({}) as new copies. Nothing there is overwritten.",
            backup.name, backup.created_at, account.base_url, account.account_email
        );
        if !native::confirm(&asked)? {
            return Err(NOT_NOW.to_string());
        }
        if backup.scope != store::scope_of(&account.base_url, &account.account_id) {
            let asked = format!(
                "This backup is from another account: {} ({}).\n\nSend everything in it to {} ({})?",
                backup.server.as_deref().unwrap_or("unknown"),
                backup.account_email.as_deref().unwrap_or("unknown"),
                account.base_url,
                account.account_email
            );
            if !native::confirm(&asked)? {
                return Err(NOT_NOW.to_string());
            }
        }
        self.jobs.step(job, "Restoring");
        run::restore(&self.data, id)
    }

    fn delete(&self, id: &str) -> Result<Value, String> {
        let store = self.store();
        let backup = store.find(id).ok_or("That backup is not on this computer.")?;
        if !native::confirm(&format!("Delete the backup of \"{}\" from {}?\n\nThis can't be undone.", backup.name, backup.created_at))? {
            return Err(NOT_NOW.to_string());
        }
        store.remove(id)?;
        Ok(json!({"deleted": true}))
    }

    fn sources(&self) -> Result<Value, String> {
        let account = link::load(&self.data)?.ok_or("Connect to FormLogic first.")?;
        let listed = client::sources(&account).map_err(|refusal| refusal.words())?;
        Ok(for_the_page(&listed))
    }
}

fn page_size(payload: &Value) -> usize {
    (number(payload, "limit").unwrap_or(MAX_PAGE as u64) as usize).clamp(1, MAX_PAGE)
}

fn number(payload: &Value, field: &str) -> Option<u64> {
    payload.get(field).and_then(Value::as_u64)
}

fn text(payload: &Value, field: &str) -> Result<String, String> {
    payload.get(field).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string).ok_or_else(|| format!("{field} is required."))
}

fn display_name() -> String {
    match native::computer_name() {
        Some(name) => format!("FormLogic Backups on {name}"),
        None => "FormLogic Backups".to_string(),
    }
}

/// A file name for a plain copy: what the backup is of, and when, in characters any system takes.
fn plain_name(backup: &LocalBackup) -> String {
    let name: String = backup.name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).take(60).collect();
    let time = backup.id.rsplit('/').next().unwrap_or_default();
    format!("{name}-{time}.zip")
}

fn backup_id(app: &App, payload: &Value) -> Result<String, String> {
    let id = text(payload, "id")?;
    Store::open(&app.data).path_of(&id)?;
    Ok(id)
}

/// What the page needs of a server's list, short enough to send: a line to OAIY can't be longer
/// than 1 MiB. Anything left out is still in a run of everything.
fn for_the_page(listed: &Value) -> Value {
    let text = |item: &Value, field: &str| run::short(item.get(field).and_then(Value::as_str).unwrap_or_default());
    let flag = |item: &Value, field: &str| item.get(field).and_then(Value::as_bool).unwrap_or(false);
    let items = |field: &str| listed.get(field).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default().iter().take(run::MAX_SOURCES).cloned().collect::<Vec<Value>>();
    let apps: Vec<Value> = items("apps").iter().map(|app| json!({"id": text(app, "id"), "name": text(app, "name"), "softn": flag(app, "softn")})).collect();
    let forms: Vec<Value> = items("forms").iter().map(|form| json!({"id": text(form, "id"), "title": text(form, "title"), "inApp": flag(form, "inApp"), "private": flag(form, "private")})).collect();
    json!({"apps": apps, "forms": forms})
}

fn sources_to_back_up(payload: &Value) -> Result<Option<Vec<Source>>, String> {
    let Some(only) = payload.get("only").filter(|only| !only.is_null()) else { return Ok(None) };
    let mut sources: Vec<Source> = serde_json::from_value(only.clone()).map_err(|_| "only must list apps and forms.".to_string())?;
    if sources.is_empty() || sources.len() > run::MAX_SOURCES {
        return Err("only must list apps and forms.".to_string());
    }
    for source in &mut sources {
        source.name = run::short(&source.name);
    }
    Ok(Some(sources))
}

fn route(app: &Arc<App>, command: &str, payload: &Value, request: Option<&str>) -> Result<Value, String> {
    match command {
        "status.get" => Ok(app.status()),
        "settings.get" => Ok(json!(app.store().settings())),
        "link.get" => app.link_details(),
        "backups.list" => Ok(app.backups(payload)),
        "jobs.get" => app.jobs.get(&text(payload, "id")?).map(|job| json!(job)).ok_or_else(|| "That job is gone.".to_string()),
        "link.connect" => {
            let server = link::normalise_server(&text(payload, "server")?)?;
            app.job(request, command, move |app, job| app.connect(job, &server))
        }
        "link.forget" => app.job(request, command, |app, _| app.forget()),
        "sources.list" => app.job(request, command, |app, _| app.sources()),
        "backup.run" => {
            let only = sources_to_back_up(payload)?;
            app.job(request, command, move |app, job| {
                let outcome = run::back_up(&app.data, only, run::PACE, run::Started::ByCommand, &|step| app.jobs.step(job, step))?;
                Ok(json!(outcome))
            })
        }
        "settings.set" => {
            let wanted: Settings = serde_json::from_value(payload.clone()).map_err(|_| "Those settings can't be read.".to_string())?;
            app.job(request, command, move |app, _| app.set_settings(wanted))
        }
        "key.setup" => app.job(request, command, |app, _| app.set_up_key()),
        "key.recover" => {
            let words = Zeroizing::new(text(payload, "words")?);
            app.job(request, command, move |app, _| app.recover_key(&words))
        }
        "backup.save" => {
            let id = backup_id(app, payload)?;
            app.job(request, command, move |app, _| app.save_plain(&id))
        }
        "backup.restore" => {
            let id = backup_id(app, payload)?;
            app.job(request, command, move |app, job| app.restore(job, &id))
        }
        "backup.delete" => {
            let id = backup_id(app, payload)?;
            app.job(request, command, move |app, _| app.delete(&id))
        }
        _ => Err(format!("No command {command}.")),
    }
}

/// Answers one `connector.request`.
pub fn handle(app: &Arc<App>, params: Value) -> Value {
    let command = params.get("command").and_then(Value::as_str).unwrap_or_default();
    let request = params.get("requestId").and_then(Value::as_str);
    let payload = params.get("payload").cloned().unwrap_or(Value::Null);
    match route(app, command, &payload, request) {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(message) => json!({"ok": false, "error": {"code": "failed", "message": message}}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_copys_name_is_safe_anywhere() {
        let backup = LocalBackup {
            id: "0123456789abcdef/app-a1-00000000/20261031T000000000Z".into(),
            scope: "0123456789abcdef".into(),
            kind: "app".into(),
            source_id: "a1".into(),
            name: "../Bookings: 2026/*".into(),
            created_at: "2026-10-31T00:00:00Z".into(),
            bytes: 1,
            counts: Value::Null,
            key_id: None,
            server: None,
            account_email: None,
            scheduled: false,
        };
        assert_eq!(plain_name(&backup), "---Bookings--2026---20261031T000000000Z.zip");
    }

    #[test]
    fn a_page_of_backups_can_be_asked_for_but_not_a_longer_one() {
        assert_eq!(page_size(&json!({"limit": 10})), 10);
        assert_eq!(page_size(&json!({"limit": 0})), 1);
        assert_eq!(page_size(&json!({"limit": 100_000})), MAX_PAGE);
        assert_eq!(page_size(&json!({})), MAX_PAGE);
    }

    #[test]
    fn only_lists_what_it_should() {
        assert_eq!(sources_to_back_up(&json!({})).unwrap(), None);
        assert_eq!(sources_to_back_up(&json!({"only": null})).unwrap(), None);
        assert_eq!(sources_to_back_up(&json!({"only": [{"kind": "app", "id": "a1", "name": "A"}]})).unwrap().unwrap().len(), 1);
        assert!(sources_to_back_up(&json!({"only": []})).is_err());
        assert!(sources_to_back_up(&json!({"only": "everything"})).is_err());
    }

    #[test]
    fn a_servers_list_is_cut_down_to_what_can_be_sent() {
        let listed = json!({
            "apps": vec![json!({"id": "a", "name": "n".repeat(5000), "softn": true, "extra": "y".repeat(5000)}); run::MAX_SOURCES + 5],
            "forms": [{"id": "f", "title": "Feedback", "inApp": false, "private": true}],
        });
        let page = for_the_page(&listed);
        assert_eq!(page["apps"].as_array().unwrap().len(), run::MAX_SOURCES);
        assert_eq!(page["apps"][0]["softn"], true);
        assert_eq!(page["forms"][0], json!({"id": "f", "title": "Feedback", "inApp": false, "private": true}));
        assert!(page.to_string().len() < 1_000_000);
    }

    fn manifest() -> Value {
        serde_json::from_str(include_str!("../manifest.json")).unwrap()
    }

    /// The relay can reach what isn't journalled, and FormLogic stores the answer.
    #[test]
    fn only_the_two_reads_are_left_unjournalled() {
        let manifest = manifest();
        let declared: Vec<&str> = manifest["connectors"][0]["commands"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        let journalled: Vec<&str> = manifest["commands"]["journalled"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        let open: Vec<&str> = declared.iter().filter(|command| !journalled.contains(command)).copied().collect();
        assert_eq!(open, ["status.get", "settings.get"]);
    }

    #[test]
    fn every_command_has_its_capability_and_no_event_is_declared() {
        let manifest = manifest();
        let capabilities: Vec<&str> = manifest["capabilities"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        for command in manifest["connectors"][0]["commands"].as_array().unwrap() {
            assert!(capabilities.contains(&format!("connector.formlogic-backups.{}", command.as_str().unwrap()).as_str()), "{command}");
        }
        assert!(manifest.get("events").is_none(), "events are kept on disk and sent to the linked account");
    }

    #[test]
    fn this_binary_answers_every_command_the_manifest_declares() {
        let dir = std::env::temp_dir().join(format!("fl-backups-commands-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let app = Arc::new(App::new(dir.clone()));
        for command in manifest()["connectors"][0]["commands"].as_array().unwrap() {
            let command = command.as_str().unwrap();
            // Bad payloads, so nothing opens a window or starts a job that matters.
            let answer = route(&app, command, &json!({"id": "", "server": "ftp://x", "only": "x", "enabled": "x"}), None);
            assert!(!answer.as_ref().is_err_and(|message| message.starts_with("No command")), "{command}");
        }
        assert!(route(&app, "backup.nothing", &Value::Null, None).unwrap_err().starts_with("No command"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_new_folder_says_what_comes_first() {
        let dir = std::env::temp_dir().join(format!("fl-backups-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let status = App::new(dir.clone()).status();
        assert_eq!(status["state"], "needs-link");
        assert_eq!(status["hasKey"], false);
        assert!(status.to_string().find(dir.to_string_lossy().as_ref()).is_none(), "no path in an answer the relay can read");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The other way to reach a path: a page never hands one in.
    #[test]
    fn nothing_takes_a_path_from_a_caller() {
        let source = include_str!("commands.rs");
        let routes = &source[source.find("fn route(").unwrap()..source.find("/// Answers one `connector.request`").unwrap()];
        assert!(!routes.contains("PathBuf"), "paths come from the person, in a native window");
        assert!(!routes.contains("\"path\""));
    }
}
