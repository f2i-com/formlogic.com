//! Speaking to OAIY: one JSON-RPC message per line, over stdin and stdout.
//!
//! `plugin.init` must be answered in 10 seconds and `plugin.health` in 5, so this thread never does
//! the work itself: a command gets a thread of its own, and anything slow becomes a job the page
//! polls ([`crate::jobs`]). OAIY kills a plugin for a line over 1 MiB, so nothing longer is sent.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::commands::App;

/// OAIY's limit is 1 MiB. A little under, for what goes round the answer.
const MAX_LINE_BYTES: usize = 1_000_000;
/// Maximum incoming JSON-RPC line length accepted on stdin before dropping the line.
const MAX_IN_LINE_BYTES: usize = 2 * 1024 * 1024;
/// Commands answered at once. More than the page ever sends: this is for a caller gone wrong.
const MAX_AT_ONCE: usize = 16;

/// One writer at a time: a line must reach OAIY whole.
#[derive(Clone)]
struct Out(Arc<Mutex<std::io::Stdout>>);

impl Out {
    fn line(&self, message: &Value) {
        let text = fitted(message);
        if let Ok(mut out) = self.0.lock() {
            // Nobody left to tell if this fails: stdin closes next, and that ends the program.
            let _ = writeln!(out, "{text}").and_then(|_| out.flush());
        }
    }

    fn reply(&self, id: Value, result: Value) {
        self.line(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }
}

/// The line to send: the message, or a refusal of it if it is too long to send.
fn fitted(message: &Value) -> String {
    let text = message.to_string();
    if text.len() <= MAX_LINE_BYTES {
        return text;
    }
    let id = message
        .get("id")
        .filter(|id| id.to_string().len() <= 256)
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {"ok": false, "error": {"code": "failed", "message": "That answer is too long to send."}},
    })
    .to_string()
}

enum ReadLine {
    Line,
    TooLong,
    Eof,
}

/// Reads a single newline-delimited frame bounded by `max_bytes`. If a line exceeds the bound,
/// the remainder up to the next `\n` (or EOF) is drained without allocating unbounded memory.
fn read_bounded_line(reader: &mut impl BufRead, out: &mut Zeroizing<String>, max_bytes: usize) -> ReadLine {
    out.clear();
    let mut raw = Zeroizing::new(Vec::<u8>::new());
    let mut too_long = false;
    loop {
        let available = match reader.fill_buf() {
            Ok([]) => {
                if raw.is_empty() && !too_long {
                    return ReadLine::Eof;
                }
                break;
            }
            Ok(buf) => buf,
            Err(_) => return ReadLine::Eof,
        };
        let newline = available.iter().position(|&b| b == b'\n');
        let take = newline.map(|pos| pos + 1).unwrap_or(available.len());
        if !too_long {
            if raw.len().saturating_add(take) > max_bytes {
                too_long = true;
                raw.clear();
            } else {
                raw.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    if too_long {
        return ReadLine::TooLong;
    }
    match String::from_utf8(std::mem::take(&mut *raw)) {
        Ok(text) => {
            *out = Zeroizing::new(text);
            ReadLine::Line
        }
        Err(_) => ReadLine::TooLong,
    }
}

/// The folder OAIY gave the plugin. Nothing is kept anywhere else.
fn data_dir(params: &Value) -> Option<PathBuf> {
    let from_host = std::env::var_os("OAIY_PLUGIN_DATA_DIR").map(PathBuf::from);
    from_host.or_else(|| params.get("dataDir").and_then(Value::as_str).map(PathBuf::from)).filter(|dir| !dir.as_os_str().is_empty())
}

/// Reads until OAIY says to stop or closes stdin: either ends the program. A backup caught half way
/// leaves a file in staging, swept next time, and nothing filed.
pub fn serve() {
    let out = Out(Arc::new(Mutex::new(std::io::stdout())));
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut app: Option<Arc<App>> = None;
    let busy = Arc::new(AtomicUsize::new(0));
    // Recovery words pass through here, so the line doesn't stay in memory after it is read.
    let mut line = Zeroizing::new(String::new());
    loop {
        match read_bounded_line(&mut reader, &mut line, MAX_IN_LINE_BYTES) {
            ReadLine::Eof => break,
            ReadLine::TooLong => continue,
            ReadLine::Line => {}
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let id = message.get("id").cloned();
        match (message.get("method").and_then(Value::as_str), id) {
            (Some("plugin.shutdown"), _) => break,
            (Some("plugin.init"), Some(id)) => {
                if app.is_some() {
                    out.reply(id, json!({"ok": true}));
                    continue;
                }
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                match data_dir(&params) {
                    Some(dir) => {
                        let started = App::start(dir);
                        app = Some(started);
                        out.reply(id, json!({"ok": true}));
                    }
                    None => out.line(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": "OAIY gave the plugin no folder", "data": {"code": "no_data_dir"}}})),
                }
            }
            (Some("plugin.health"), Some(id)) => out.reply(id, json!({"status": "ok"})),
            (Some("connector.request"), Some(id)) => {
                let Some(app) = app.clone() else {
                    out.reply(id, json!({"ok": false, "error": {"code": "not_ready", "message": "The plugin has not finished starting."}}));
                    continue;
                };
                if busy.fetch_add(1, Ordering::AcqRel) >= MAX_AT_ONCE {
                    busy.fetch_sub(1, Ordering::AcqRel);
                    out.reply(id, json!({"ok": false, "error": {"code": "busy", "message": "The plugin is busy. Try again in a moment."}}));
                    continue;
                }
                let (out, busy) = (out.clone(), busy.clone());
                std::thread::spawn(move || {
                    struct BusyGuard(Arc<AtomicUsize>);
                    impl Drop for BusyGuard {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, Ordering::AcqRel);
                        }
                    }
                    let _guard = BusyGuard(busy);
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let reply = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        crate::commands::handle(&app, params)
                    })) {
                        Ok(result) => result,
                        Err(_) => json!({"ok": false, "error": {"code": "failed", "message": "The request stopped unexpectedly."}}),
                    };
                    out.reply(id, reply);
                });
            }
            (Some(method), Some(id)) => {
                out.line(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("no method {method}")}}));
            }
            _ => {}
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_too_long_for_oaiy_is_refused_and_not_sent() {
        let line = fitted(&json!({"jsonrpc": "2.0", "id": 7, "result": {"ok": true, "data": "x".repeat(MAX_LINE_BYTES)}}));
        assert!(line.len() < 1000);
        let refused: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(refused["id"], 7, "OAIY still hears which request it was");
        assert_eq!(refused["result"]["ok"], false);
    }

    #[test]
    fn an_answer_that_fits_goes_as_it_is() {
        let message = json!({"id": 1, "result": {"ok": true}});
        assert_eq!(fitted(&message), message.to_string());
    }
}
