//! Asking OAIY for something: a request of the plugin's own, on the same lines OAIY's requests come
//! in on, and OAIY's answer to it, a line with the request's id and no method, handed back to
//! whoever asked ([`Host::take_answer`]). Only what OAIY says it answers (`hostCalls` in
//! `plugin.init`) is asked: an OAIY from before a call announces nothing of it, and the plugin
//! keeps its own way there.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

/// The request that has OAIY open a web page in the person's browser, from OAIY's own process.
/// Asked on Windows alone (`native::open_url`): elsewhere a browser the plugin opens is not ended
/// with OAIY, and the plugin keeps its own way.
#[cfg_attr(not(windows), allow(dead_code))]
pub const BROWSER_OPEN: &str = "oaiy.browser.open";

/// Writes one line to OAIY.
pub type Writer = Arc<dyn Fn(&Value) + Send + Sync>;

/// What answers one request, once it comes.
type Waiting = Sender<Result<Value, String>>;

/// The plugin's side of asking OAIY: where a request goes, what OAIY answers, and who is waiting.
pub struct Host {
    write: Mutex<Option<Writer>>,
    answered: Mutex<Vec<String>>,
    waiting: Mutex<BTreeMap<String, Waiting>>,
    next: AtomicU64,
}

/// The OAIY that started this program.
pub static OAIY: Host = Host::new();

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Host {
    pub const fn new() -> Host {
        Host { write: Mutex::new(None), answered: Mutex::new(Vec::new()), waiting: Mutex::new(BTreeMap::new()), next: AtomicU64::new(0) }
    }

    /// What `plugin.init` said: the requests this OAIY answers. `write` is how a request reaches it.
    pub fn connect(&self, write: Writer, init: &Value) {
        let answered = init
            .get("hostCalls")
            .and_then(Value::as_array)
            .map(|calls| calls.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        *locked(&self.answered) = answered;
        *locked(&self.write) = Some(write);
    }

    /// Whether OAIY said it answers `method`.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn answers(&self, method: &str) -> bool {
        locked(&self.answered).iter().any(|call| call == method)
    }

    /// Asks OAIY `method` and waits up to `within` for the answer: what it answered, or why it did
    /// not, in its words.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn ask(&self, method: &str, params: Value, within: Duration) -> Result<Value, String> {
        let write = locked(&self.write).clone().ok_or_else(|| "OAIY has not started the plugin yet".to_string())?;
        let id = format!("plugin-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (answer, answered) = channel();
        locked(&self.waiting).insert(id.clone(), answer);
        write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let outcome = answered.recv_timeout(within);
        locked(&self.waiting).remove(&id);
        outcome.unwrap_or_else(|_| Err(format!("OAIY did not answer {method} in time")))
    }

    /// Hands a line from OAIY that answers one of the plugin's requests to whoever asked. `false`
    /// for any other line (one of OAIY's own requests, which has a method).
    pub fn take_answer(&self, message: &Value) -> bool {
        if message.get("method").is_some() {
            return false;
        }
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some(waiting) = locked(&self.waiting).remove(id) else {
            // (asked too long ago: nobody is waiting for it any more)
            return true;
        };
        let outcome = match (message.get("result"), message.get("error")) {
            (Some(result), _) => Ok(result.clone()),
            (None, Some(error)) => {
                let said = error.get("message").and_then(Value::as_str).unwrap_or("OAIY refused it");
                Err(match error.pointer("/data/code").and_then(Value::as_str) {
                    Some(code) => format!("{said} ({code})"),
                    None => said.to_string(),
                })
            }
            _ => Err("OAIY's answer said nothing".to_string()),
        };
        let _ = waiting.send(outcome);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host whose requests are kept for the test to answer.
    fn host_keeping(asked: Arc<Mutex<Vec<Value>>>, calls: Value) -> Arc<Host> {
        let host = Arc::new(Host::new());
        host.connect(Arc::new(move |line: &Value| asked.lock().unwrap().push(line.clone())), &json!({"hostCalls": calls}));
        host
    }

    #[test]
    fn a_request_goes_to_oaiy_and_its_answer_comes_back_to_whoever_asked() {
        let asked: Arc<Mutex<Vec<Value>>> = Arc::default();
        let host = host_keeping(asked.clone(), json!([BROWSER_OPEN, 7]));
        assert!(host.answers(BROWSER_OPEN) && !host.answers("flow.run"));

        let answering = {
            let (host, asked) = (host.clone(), asked.clone());
            std::thread::spawn(move || {
                let request = loop {
                    if let Some(request) = asked.lock().unwrap().first().cloned() {
                        break request;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                };
                assert_eq!(request["method"], BROWSER_OPEN);
                assert_eq!(request["params"], json!({"url": "https://x.example/"}));
                // OAIY's own requests are not answers, and are left to the loop that serves them.
                assert!(!host.take_answer(&json!({"jsonrpc": "2.0", "id": request["id"], "method": "plugin.health"})));
                assert!(host.take_answer(&json!({"jsonrpc": "2.0", "id": request["id"], "result": {"ok": true}})));
            })
        };
        let answer = host.ask(BROWSER_OPEN, json!({"url": "https://x.example/"}), Duration::from_secs(5));
        answering.join().unwrap();
        assert_eq!(answer, Ok(json!({"ok": true})));
    }

    #[test]
    fn a_refusal_says_why_and_an_answer_that_never_comes_ends_the_wait() {
        let asked: Arc<Mutex<Vec<Value>>> = Arc::default();
        let host = host_keeping(asked.clone(), json!([BROWSER_OPEN]));
        let refusing = {
            let (host, asked) = (host.clone(), asked.clone());
            std::thread::spawn(move || {
                let id = loop {
                    if let Some(request) = asked.lock().unwrap().first() {
                        break request["id"].clone();
                    }
                    std::thread::sleep(Duration::from_millis(5));
                };
                let error = json!({"code": -32601, "message": "plugin does not declare the capability", "data": {"code": "capability_denied"}});
                host.take_answer(&json!({"jsonrpc": "2.0", "id": id, "error": error}));
            })
        };
        let refused = host.ask(BROWSER_OPEN, json!({}), Duration::from_secs(5));
        refusing.join().unwrap();
        assert_eq!(refused, Err("plugin does not declare the capability (capability_denied)".to_string()));

        assert_eq!(host.ask(BROWSER_OPEN, json!({}), Duration::from_millis(50)), Err(format!("OAIY did not answer {BROWSER_OPEN} in time")));
        // Its answer, late, is nobody's.
        assert!(host.take_answer(&json!({"jsonrpc": "2.0", "id": "plugin-2", "result": {}})));
    }

    #[test]
    fn the_manifest_declares_the_capability_oaiy_holds_the_browser_to_by_name() {
        // OAIY answers `oaiy.browser.open` only for a plugin that declares it by that name; an OAIY
        // from before it keeps the name as one it does not know, and loads the plugin all the same.
        let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
        assert!(manifest["capabilities"].as_array().unwrap().iter().any(|c| c == BROWSER_OPEN), "{manifest}");
    }

    #[test]
    fn an_oaiy_that_announces_nothing_is_asked_nothing() {
        let host = Host::new();
        assert!(!host.answers(BROWSER_OPEN), "not started");
        assert!(host.ask(BROWSER_OPEN, json!({}), Duration::from_millis(10)).is_err());
        host.connect(Arc::new(|_: &Value| {}), &json!({"desktopVersion": "0.1.0", "features": ["eventAck"]}));
        assert!(!host.answers(BROWSER_OPEN), "an OAIY from before the call");
    }
}
