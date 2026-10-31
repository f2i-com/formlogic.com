//! The built program, spoken to as OAIY speaks to it: JSON-RPC lines over stdin and stdout, in a
//! folder of its own, with the plugin's windows answered from a file.
//!
//! `cargo test --features scripted-dialogs`. Without the feature there is nobody to answer them.

#![cfg(feature = "scripted-dialogs")]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_WORDS: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";
/// How long a line may take. OAIY allows 10 seconds for init and 5 for health.
const IN_TIME: Duration = Duration::from_secs(5);

static NEXT_FOLDER: AtomicU32 = AtomicU32::new(0);

struct Plugin {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
    held: Vec<Value>,
    next_id: u64,
    next_request: u64,
    folder: PathBuf,
}

fn folder() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fl-backups-protocol-{}-{}", std::process::id(), NEXT_FOLDER.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("data")).unwrap();
    std::fs::create_dir_all(dir.join("windows")).unwrap();
    dir
}

impl Plugin {
    fn start() -> Plugin {
        let folder = folder();
        let mut child = Command::new(env!("CARGO_BIN_EXE_formlogic-backups"))
            .env_clear()
            .env("SystemRoot", std::env::var_os("SystemRoot").unwrap_or_default())
            .env("OAIY_PLUGIN_DATA_DIR", folder.join("data"))
            .env("FORMLOGIC_BACKUPS_SCRIPTED", folder.join("windows"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (send, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let message: Value = serde_json::from_str(&line).expect("every line is JSON");
                if send.send(message).is_err() {
                    return;
                }
            }
        });
        let mut plugin = Plugin { child, stdin, lines, held: Vec::new(), next_id: 0, next_request: 0, folder };
        assert_eq!(plugin.rpc("plugin.init", json!({"desktopVersion": "0.1.11", "pluginApiVersion": 1, "devMode": false}))["result"], json!({"ok": true}));
        plugin
    }

    fn send(&mut self, id: u64, method: &str, params: Value) {
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn wait_for(&mut self, id: u64) -> Value {
        if let Some(at) = self.held.iter().position(|message| message["id"] == id) {
            return self.held.remove(at);
        }
        loop {
            let message = self.lines.recv_timeout(IN_TIME).unwrap_or_else(|_| panic!("no answer to {id} in time"));
            if message["id"] == id {
                return message;
            }
            self.held.push(message);
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(id, method, params);
        self.wait_for(id)
    }

    /// A command as OAIY forwards one, with the request id it sends for a journalled command.
    fn request(&mut self, command: &str, payload: Value, request: &str) -> Value {
        let params = json!({"connectorId": "formlogic-backups", "command": command, "payload": payload, "requestId": request});
        self.rpc("connector.request", params)["result"].clone()
    }

    fn command(&mut self, command: &str, payload: Value) -> Value {
        self.next_request += 1;
        let request = format!("ui-{}", self.next_request);
        self.request(command, payload, &request)
    }

    fn data(&mut self, command: &str, payload: Value) -> Value {
        let answer = self.command(command, payload);
        assert_eq!(answer["ok"], true, "{command}: {answer}");
        answer["data"].clone()
    }

    fn refused(&mut self, command: &str, payload: Value) -> String {
        let answer = self.command(command, payload);
        assert_eq!(answer["ok"], false, "{command}: {answer}");
        answer["error"]["message"].as_str().unwrap().to_string()
    }

    fn wait_for_job(&mut self, id: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let job = self.data("jobs.get", json!({"id": id}));
            if job["state"] != "running" {
                return job;
            }
            assert!(Instant::now() < until, "the job did not finish: {job}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn job(&mut self, command: &str, payload: Value) -> Value {
        let started = self.data(command, payload);
        let id = started["jobId"].as_str().unwrap_or_else(|| panic!("{command} started no job: {started}")).to_string();
        self.wait_for_job(&id)
    }

    fn windows(&self) -> PathBuf {
        self.folder.join("windows")
    }

    fn answer(&self, answers: &[&str]) {
        std::fs::write(self.windows().join("answers.txt"), answers.join("\n")).unwrap();
    }

    fn asked(&self) -> String {
        std::fs::read_to_string(self.windows().join("asked.txt")).unwrap_or_default()
    }

    fn data_dir(&self) -> PathBuf {
        self.folder.join("data")
    }

    /// Whatever goes to OAIY, seen together: nothing below should ever be in it.
    fn stop(mut self) -> (std::process::ExitStatus, PathBuf) {
        drop(self.stdin.take());
        (wait(&mut self.child), self.folder.clone())
    }
}

fn wait(child: &mut Child) -> std::process::ExitStatus {
    let until = Instant::now() + IN_TIME;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < until, "the program did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

fn all_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.path().is_dir() {
            all_files(&entry.path(), found);
        } else {
            found.push(entry.path());
        }
    }
}

#[test]
fn it_answers_init_and_health_and_says_no_to_what_it_does_not_know() {
    let mut plugin = Plugin::start();
    assert_eq!(plugin.rpc("plugin.health", json!({}))["result"], json!({"status": "ok"}));
    assert_eq!(plugin.rpc("plugin.nothing", json!({}))["error"]["code"], -32601);
    assert!(plugin.refused("backup.nothing", json!({})).contains("No command"));
}

#[test]
fn a_command_before_init_is_refused_and_does_not_end_it() {
    let folder = folder();
    let mut child = Command::new(env!("CARGO_BIN_EXE_formlogic-backups"))
        .env("OAIY_PLUGIN_DATA_DIR", folder.join("data"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "id": 1, "method": "connector.request", "params": {"command": "status.get"}})).unwrap();
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "id": 2, "method": "plugin.health"})).unwrap();
    writeln!(stdin, "not json").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["result"]["error"]["code"], "not_ready");
    line.clear();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["result"]["status"], "ok");
    drop(stdin);
    assert!(wait(&mut child).success());
    let _ = std::fs::remove_dir_all(folder);
}

#[test]
fn closing_stdin_ends_the_program() {
    let (status, folder) = Plugin::start().stop();
    assert!(status.success());
    let _ = std::fs::remove_dir_all(folder);
}

#[test]
fn being_told_to_shut_down_ends_the_program() {
    let mut plugin = Plugin::start();
    let line = json!({"jsonrpc": "2.0", "method": "plugin.shutdown"}).to_string();
    let stdin = plugin.stdin.as_mut().unwrap();
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();
    assert!(wait(&mut plugin.child).success());
}

#[test]
fn a_new_plugin_says_what_comes_first_and_names_nothing() {
    let mut plugin = Plugin::start();
    let status = plugin.data("status.get", json!({}));
    assert_eq!(status["state"], "needs-link");
    assert_eq!(status["linked"], false);
    assert_eq!(status["canAsk"], true);
    assert!(status["fingerprint"].is_null());
    let folder = plugin.data_dir().to_string_lossy().replace('\\', "\\\\");
    assert!(!status.to_string().contains(&folder), "no path in what the relay can read");
    assert_eq!(plugin.data("settings.get", json!({})), json!({"enabled": false, "everyHours": 24, "keep": 7}));
    assert_eq!(plugin.data("link.get", json!({})), json!({"linked": false}));
    assert_eq!(plugin.data("backups.list", json!({}))["total"], 0);
}

#[test]
fn the_twelve_words_appear_in_the_window_and_nowhere_else() {
    let mut plugin = Plugin::start();
    plugin.answer(&["yes"]);
    let started = plugin.data("key.setup", json!({}));
    let job = plugin.wait_for_job(started["jobId"].as_str().unwrap());
    assert_eq!(job["state"], "done", "{job}");

    let asked = plugin.asked();
    let words = asked.lines().find_map(|line| line.strip_prefix("WORDS ")).expect("the window showed them").to_string();
    assert_eq!(words.split_whitespace().count(), 12);
    let first = words.split_whitespace().next().unwrap();
    let everything_said = format!("{started} {job} {}", plugin.data("status.get", json!({})));
    assert!(!everything_said.contains(&words), "the words are never in an answer");
    assert_eq!(job["result"]["keyId"].as_str().unwrap().len(), 16);

    let mut files = Vec::new();
    all_files(&plugin.data_dir(), &mut files);
    assert!(!files.is_empty());
    for file in files {
        let text = String::from_utf8_lossy(&std::fs::read(&file).unwrap()).to_string();
        assert!(!text.contains(&words), "the words are not stored: {}", file.display());
        assert!(!text.split_whitespace().any(|word| word == first && text.split_whitespace().count() > 1), "{}", file.display());
    }
    assert_eq!(plugin.data("status.get", json!({}))["hasKey"], true);
}

#[test]
fn closing_the_words_window_keeps_nothing() {
    let mut plugin = Plugin::start();
    plugin.answer(&["no"]);
    let job = plugin.job("key.setup", json!({}));
    assert_eq!(job["state"], "failed");
    assert_eq!(job["message"], "Nothing was changed.");
    assert_eq!(plugin.data("status.get", json!({}))["hasKey"], false);
}

#[test]
fn a_second_key_is_refused_while_one_is_here() {
    let mut plugin = Plugin::start();
    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("key.setup", json!({}))["state"], "done");
    let job = plugin.job("key.setup", json!({}));
    assert_eq!(job["state"], "failed");
    assert!(job["message"].as_str().unwrap().contains("already"));
}

#[test]
fn a_request_sent_twice_is_one_job_and_one_window() {
    let mut plugin = Plugin::start();
    plugin.answer(&["slow 300", "no"]);
    let first = plugin.request("key.setup", json!({}), "retried");
    let second = plugin.request("key.setup", json!({}), "retried");
    assert_eq!(first["data"]["jobId"], second["data"]["jobId"]);
    let id = first["data"]["jobId"].as_str().unwrap().to_string();
    assert_eq!(plugin.wait_for_job(&id)["state"], "done");
    assert_eq!(plugin.asked().matches("WORDS").count(), 1, "{}", plugin.asked());
}

#[test]
fn health_is_answered_while_a_window_waits_and_a_second_window_is_refused() {
    let mut plugin = Plugin::start();
    plugin.answer(&["slow 1500", "yes"]);
    let started = plugin.data("key.setup", json!({}));
    std::thread::sleep(Duration::from_millis(100));

    let began = Instant::now();
    assert_eq!(plugin.rpc("plugin.health", json!({}))["result"]["status"], "ok");
    assert!(began.elapsed() < Duration::from_secs(1), "health must not wait for a person");

    let second = plugin.job("key.recover", json!({"words": WORDS}));
    assert_eq!(second["state"], "failed");
    assert!(second["message"].as_str().unwrap().contains("already asking"), "{second}");
    assert_eq!(plugin.wait_for_job(started["jobId"].as_str().unwrap())["state"], "done");
}

#[test]
fn the_words_make_the_known_key_and_saying_no_changes_nothing() {
    let mut plugin = Plugin::start();
    plugin.answer(&["no"]);
    assert_eq!(plugin.job("key.recover", json!({"words": WORDS}))["message"], "Nothing was changed.");
    assert_eq!(plugin.data("status.get", json!({}))["hasKey"], false);

    plugin.answer(&["yes"]);
    let job = plugin.job("key.recover", json!({"words": WORDS}));
    assert_eq!(job["state"], "done", "{job}");
    let key_id = job["result"]["keyId"].as_str().unwrap().to_string();
    assert_eq!(plugin.data("status.get", json!({}))["keyId"], key_id);

    plugin.answer(&["yes"]);
    let wrong = plugin.job("key.recover", json!({"words": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"}));
    assert_eq!(wrong["state"], "failed");
    assert_eq!(plugin.data("status.get", json!({}))["keyId"], key_id);

    plugin.answer(&["no"]);
    assert_eq!(plugin.job("key.recover", json!({"words": OTHER_WORDS}))["message"], "Nothing was changed.");
    let asked = plugin.asked();
    assert!(asked.contains("Replace the key") && asked.contains(&format!("Now: {key_id}")), "the window says what it replaces: {asked}");
    assert!(asked.contains("If you didn't ask for this, cancel it."), "{asked}");

    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("key.recover", json!({"words": OTHER_WORDS}))["state"], "done", "with no backups here, any valid words are taken");
    assert_ne!(plugin.data("status.get", json!({}))["keyId"], key_id);
}

#[test]
fn words_that_are_not_words_open_no_window() {
    let mut plugin = Plugin::start();
    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("key.recover", json!({"words": "not twelve words"}))["state"], "failed");
    assert_eq!(plugin.asked(), "");
}

#[test]
fn a_damaged_link_offers_connect_again() {
    let mut plugin = Plugin::start();
    std::fs::write(plugin.data_dir().join("link.json"), "not json").unwrap();
    assert_eq!(plugin.data("link.get", json!({})), json!({"linked": false}));
    assert_eq!(plugin.data("status.get", json!({}))["state"], "needs-link");
}

#[test]
fn a_server_that_could_not_be_meant_opens_no_window() {
    let mut plugin = Plugin::start();
    assert!(plugin.refused("link.connect", json!({"server": "http://forms.example.com"})).contains("https"));
    assert!(plugin.refused("link.connect", json!({"server": "https://user@forms.example.com"})).contains("server address"));
    assert!(plugin.refused("link.connect", json!({})).contains("required"));
    assert_eq!(plugin.asked(), "");
}

#[test]
fn saying_no_to_a_server_opens_no_browser() {
    let mut plugin = Plugin::start();
    plugin.answer(&["no"]);
    let job = plugin.job("link.connect", json!({"server": "https://forms.example.com"}));
    assert_eq!(job["message"], "Nothing was changed.");
    assert!(plugin.asked().contains("https://forms.example.com"), "the window names the server: {}", plugin.asked());
    assert!(!plugin.windows().join("opened.txt").exists());
}

#[test]
fn the_browser_opens_and_the_sign_in_comes_back_through_the_plugin() {
    let mut plugin = Plugin::start();
    plugin.answer(&["yes"]);
    let started = plugin.data("link.connect", json!({"server": "http://127.0.0.1:9"}));
    let opened = plugin.windows().join("opened.txt");
    let until = Instant::now() + IN_TIME;
    while !opened.exists() {
        assert!(Instant::now() < until, "the browser never opened");
        std::thread::sleep(Duration::from_millis(20));
    }
    let url = std::fs::read_to_string(&opened).unwrap();
    assert!(url.starts_with("http://127.0.0.1:9/oauth/authorize?"), "{url}");
    assert!(url.contains("device=Test%20Computer"), "{url}");
    assert!(!started.to_string().contains("oauth/authorize"), "the address is not in an answer");

    // The browser says no: this is the answer that ends the wait.
    let field = |name: &str| url.trim().split(['?', '&']).find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string)).unwrap();
    let port: u16 = field("redirect_uri").split("%3A").nth(2).unwrap().split('%').next().unwrap().parse().unwrap();
    let mut browser = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(browser, "GET /callback?error=access_denied&state={} HTTP/1.1\r\nHost: x\r\n\r\n", field("state")).unwrap();
    let job = plugin.wait_for_job(started["jobId"].as_str().unwrap());
    assert_eq!(job["state"], "failed");
    assert!(job["message"].as_str().unwrap().contains("refused"), "{job}");
    assert_eq!(plugin.data("link.get", json!({})), json!({"linked": false}));
}

#[test]
fn a_backup_this_computer_does_not_have_opens_no_window() {
    let mut plugin = Plugin::start();
    for command in ["backup.save", "backup.restore", "backup.delete"] {
        assert!(plugin.refused(command, json!({"id": "../../link"})).contains("not on this computer"), "{command}");
    }
    assert_eq!(plugin.asked(), "");
}

#[test]
fn forgetting_needs_a_link_and_running_needs_one_too() {
    let mut plugin = Plugin::start();
    assert_eq!(plugin.job("link.forget", json!({}))["state"], "failed");
    let run = plugin.job("backup.run", json!({}));
    assert_eq!(run["state"], "done", "a run that can't start says why, and is kept as the last run");
    assert!(run["result"]["stopped"].as_str().unwrap().contains("Connect"), "{run}");
    let status = plugin.data("status.get", json!({}));
    assert!(status["lastRun"]["stopped"].as_str().unwrap().contains("Connect"));
}

#[test]
fn any_change_to_the_schedule_is_asked_and_saving_the_same_again_is_not() {
    let mut plugin = Plugin::start();
    plugin.answer(&["no"]);
    assert_eq!(plugin.job("settings.set", json!({"enabled": true, "everyHours": 1, "keep": 7}))["message"], "Nothing was changed.");
    assert!(plugin.asked().contains("every 1 hours"), "more often pushes old backups out sooner: {}", plugin.asked());
    assert_eq!(plugin.data("settings.get", json!({})), json!({"enabled": false, "everyHours": 24, "keep": 7}));

    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("settings.set", json!({"enabled": true, "everyHours": 12, "keep": 10}))["state"], "done");
    assert_eq!(plugin.data("settings.get", json!({})), json!({"enabled": true, "everyHours": 12, "keep": 10}));

    plugin.answer(&["no"]);
    assert_eq!(plugin.job("settings.set", json!({"enabled": true, "everyHours": 12, "keep": 2}))["message"], "Nothing was changed.");
    assert_eq!(plugin.data("settings.get", json!({}))["keep"], 10);
    assert!(plugin.asked().contains("Keep 2 of each"), "{}", plugin.asked());

    plugin.answer(&["no"]);
    assert_eq!(plugin.job("settings.set", json!({"enabled": false, "everyHours": 12, "keep": 10}))["state"], "failed");
    assert_eq!(plugin.data("settings.get", json!({}))["enabled"], true);

    let asked = plugin.asked();
    assert_eq!(plugin.job("settings.set", json!({"enabled": true, "everyHours": 12, "keep": 10}))["state"], "done");
    assert_eq!(plugin.asked(), asked, "nothing changed, so nothing to ask");
}

#[test]
fn a_list_of_backups_comes_in_pages() {
    let mut plugin = Plugin::start();
    let data = plugin.data_dir();
    let scope = data.join("backups").join("0123456789abcdef").join("app-a1-00000000");
    std::fs::create_dir_all(&scope).unwrap();
    for n in 0..3 {
        std::fs::write(scope.join(format!("2026103{n}T000000000Z.flbk")), b"sealed").unwrap();
    }
    let page = plugin.data("backups.list", json!({"offset": 1, "limit": 1}));
    assert_eq!(page["total"], 3);
    assert_eq!(page["backups"].as_array().unwrap().len(), 1);
    assert!(page["backups"][0]["id"].as_str().unwrap().ends_with("20261031T000000000Z"));
    assert!(!page.to_string().contains(".flbk"), "no path in the answer");
}

#[test]
fn deleting_is_asked_and_names_what_goes() {
    let mut plugin = Plugin::start();
    let id = "0123456789abcdef/app-a1-00000000/20261031T000000000Z";
    let folder = plugin.data_dir().join("backups").join("0123456789abcdef").join("app-a1-00000000");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("20261031T000000000Z.flbk"), b"sealed").unwrap();
    std::fs::write(folder.join("20261031T000000000Z.json"), json!({"name": "Bookings", "sourceId": "a1"}).to_string()).unwrap();

    plugin.answer(&["no"]);
    assert_eq!(plugin.job("backup.delete", json!({"id": id}))["message"], "Nothing was changed.");
    assert!(plugin.asked().contains("Bookings"), "{}", plugin.asked());
    assert_eq!(plugin.data("backups.list", json!({}))["total"], 1);

    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("backup.delete", json!({"id": id}))["state"], "done");
    assert_eq!(plugin.data("backups.list", json!({}))["total"], 0);
    assert!(!folder.join("20261031T000000000Z.json").exists());
}

#[test]
fn a_plain_copy_goes_where_the_window_says() {
    let mut plugin = Plugin::start();
    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("key.recover", json!({"words": WORDS}))["state"], "done");

    // Not sealed to this key, so nothing is written where the person chose.
    let id = "0123456789abcdef/app-a1-00000000/20261031T000000000Z";
    let folder = plugin.data_dir().join("backups").join("0123456789abcdef").join("app-a1-00000000");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("20261031T000000000Z.flbk"), b"not a backup").unwrap();
    let chosen = plugin.folder.join("chosen.zip");

    plugin.answer(&[&format!("save {}", chosen.display())]);
    assert_eq!(plugin.job("backup.save", json!({"id": id}))["state"], "failed");
    assert!(!chosen.exists());
    assert!(plugin.asked().contains("Anyone who gets this file can read everything in it"), "{}", plugin.asked());

    plugin.answer(&["cancel"]);
    assert_eq!(plugin.job("backup.save", json!({"id": id}))["message"], "Nothing was changed.");
}

/// A link as the sign-in leaves one, to a server nothing is listening on.
fn linked(plugin: &Plugin) {
    let link = json!({
        "baseUrl": "http://127.0.0.1:9", "credential": "flk_test", "accountId": "u1", "accountEmail": "owner@example.test",
        "apiKeyId": "k1", "linkedAt": "2026-10-31T00:00:00Z",
    });
    std::fs::write(plugin.data_dir().join("link.json"), link.to_string()).unwrap();
}

#[test]
fn forgetting_is_asked_and_still_forgets_when_the_server_is_gone() {
    let mut plugin = Plugin::start();
    linked(&plugin);

    plugin.answer(&["no"]);
    assert_eq!(plugin.job("link.forget", json!({}))["message"], "Nothing was changed.");
    assert!(plugin.asked().contains("http://127.0.0.1:9 (owner@example.test)"), "{}", plugin.asked());
    assert_eq!(plugin.data("link.get", json!({}))["linked"], true);

    plugin.answer(&["yes"]);
    let job = plugin.job("link.forget", json!({}));
    assert_eq!(job["result"]["endedAtServer"], false, "the page then says where to finish the job: {job}");
    assert_eq!(plugin.data("link.get", json!({})), json!({"linked": false}));
    assert!(!plugin.data_dir().join("link.json").exists());
}

#[test]
fn a_second_link_is_refused_until_the_first_is_forgotten() {
    let mut plugin = Plugin::start();
    linked(&plugin);
    let job = plugin.job("link.connect", json!({"server": "https://forms.example.com"}));
    assert_eq!(job["state"], "failed");
    assert!(job["message"].as_str().unwrap().contains("linked already"), "{job}");
    assert_eq!(plugin.asked(), "");
}

#[test]
fn restoring_names_where_it_goes_and_another_accounts_backup_is_asked_about_twice() {
    let mut plugin = Plugin::start();
    linked(&plugin);
    plugin.answer(&["yes"]);
    assert_eq!(plugin.job("key.recover", json!({"words": WORDS}))["state"], "done");
    let id = "0123456789abcdef/app-a1-00000000/20261031T000000000Z";
    let folder = plugin.data_dir().join("backups").join("0123456789abcdef").join("app-a1-00000000");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("20261031T000000000Z.flbk"), b"sealed").unwrap();
    std::fs::write(folder.join("20261031T000000000Z.json"), json!({"name": "Bookings", "sourceId": "a1", "server": "https://other.example", "accountEmail": "else@example.test"}).to_string()).unwrap();

    plugin.answer(&["no"]);
    assert_eq!(plugin.job("backup.restore", json!({"id": id}))["message"], "Nothing was changed.");
    assert!(plugin.asked().contains("http://127.0.0.1:9 (owner@example.test)"), "{}", plugin.asked());
    assert!(!plugin.asked().contains("another account"), "no second window after a no");

    plugin.answer(&["yes", "no"]);
    assert_eq!(plugin.job("backup.restore", json!({"id": id}))["message"], "Nothing was changed.");
    assert!(plugin.asked().contains("https://other.example (else@example.test)"), "{}", plugin.asked());
}
