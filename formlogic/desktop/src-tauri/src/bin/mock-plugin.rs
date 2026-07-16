//! `mock-plugin` — a tiny, protocol-complete FormLogic Desktop plugin.
//!
//! Speaks JSON-RPC 2.0 over newline-delimited stdio per
//! `formlogic-app/docs/DESKTOP_PLUGIN_SDK.md`:
//!   - `plugin.init` → `{ok:true}`
//!   - `plugin.health` → `{status:"ok"}`
//!   - `plugin.shutdown` → `{ok:true}` then exits 0
//!   - `connector.request` for connector "mock":
//!       `echo.ping` → `{ok:true, data:{echo:<payload>}}`
//!       `echo.exit` → exits 3 WITHOUT responding (crash-path test hook)
//!       `call.operatorSpeak` echoes its exact text + durable request id
//!         (used by flow retry/idempotency integration tests)
//!       anything else → JSON-RPC error with `data:{code:"command_failed"}`
//!   - unknown methods → `-32601` (never crashes on them)
//!   - in dev mode (`FORMLOGIC_DEV_MODE=1`) emits a `mock.tick` event every
//!     2 s (first tick fast, so tests aren't slow) with stable
//!     idempotency keys.
//!
//! Deliberately synchronous std-only (plus serde_json/chrono, already deps):
//! it's a test fixture, not a product.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Every stdout line is a whole JSON-RPC message; the mutex keeps the tick
/// thread's notifications from interleaving mid-line with responses.
fn emit(out: &Mutex<std::io::Stdout>, msg: &Value) {
    let mut line = msg.to_string();
    line.push('\n');
    let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = o.write_all(line.as_bytes());
    let _ = o.flush();
}

fn respond(out: &Mutex<std::io::Stdout>, id: &Value, result: Value) {
    emit(out, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn respond_err(out: &Mutex<std::io::Stdout>, id: &Value, code: i64, message: &str, data: Option<Value>) {
    let mut error = json!({ "code": code, "message": message });
    if let Some(d) = data {
        error["data"] = d;
    }
    emit(out, &json!({ "jsonrpc": "2.0", "id": id, "error": error }));
}

fn main() {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let dev_mode = std::env::var("FORMLOGIC_DEV_MODE").is_ok_and(|v| v == "1");
    let plugin_id =
        std::env::var("FORMLOGIC_PLUGIN_ID").unwrap_or_else(|_| "mock".to_string());
    let shutting_down = Arc::new(AtomicBool::new(false));

    // Dev tick: a periodic mock.tick event with a stable idempotency key.
    if dev_mode {
        let out = out.clone();
        let plugin_id = plugin_id.clone();
        let shutting_down = shutting_down.clone();
        std::thread::spawn(move || {
            let correlation = format!("mock-run-{}", std::process::id());
            let mut n: u64 = 0;
            // First tick quickly (200 ms) so integration tests see one fast;
            // then every 2 s per the SDK template contract.
            std::thread::sleep(std::time::Duration::from_millis(200));
            loop {
                if shutting_down.load(Ordering::Relaxed) {
                    return;
                }
                n += 1;
                let envelope = json!({
                    "schemaVersion": 1,
                    "source": plugin_id,
                    "name": "mock.tick",
                    "correlationId": correlation,
                    "idempotencyKey": format!("{plugin_id}:{correlation}:tick:{n}:v1"),
                    "occurredAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    "data": { "n": n }
                });
                emit(
                    &out,
                    &json!({ "jsonrpc": "2.0", "method": "event.emit", "params": { "event": envelope } }),
                );
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // stdin gone: the desktop died — exit
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // not ours to crash over
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "plugin.init" => {
                emit(
                    &out,
                    &json!({ "jsonrpc": "2.0", "method": "log.emit",
                             "params": { "level": "info", "message": "mock plugin initialized" } }),
                );
                respond(&out, &id, json!({ "ok": true }));
            }
            "plugin.health" => {
                respond(&out, &id, json!({ "status": "ok" }));
            }
            "plugin.shutdown" => {
                shutting_down.store(true, Ordering::Relaxed);
                respond(&out, &id, json!({ "ok": true }));
                std::process::exit(0);
            }
            "connector.request" => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let command = params.get("command").and_then(Value::as_str).unwrap_or("");
                match command {
                    "echo.ping" => {
                        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                        let mut result = json!({ "ok": true, "data": { "echo": payload } });
                        if let Some(rid) = params.get("requestId").and_then(Value::as_str) {
                            result["requestId"] = json!(rid);
                        }
                        respond(&out, &id, result);
                    }
                    "call.operatorSpeak" => {
                        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
                            respond_err(
                                &out,
                                &id,
                                -32000,
                                "requestId required",
                                Some(json!({
                                    "code": "command_failed",
                                    "message": "call.operatorSpeak requires requestId for durable idempotency"
                                })),
                            );
                            continue;
                        };
                        let text = payload
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        respond(
                            &out,
                            &id,
                            json!({
                                "ok": true,
                                "requestId": request_id,
                                "data": { "text": text, "payload": payload }
                            }),
                        );
                    }
                    // Crash-path hook: die mid-request, no response — the
                    // host must observe the exit and go crashed → restart.
                    "echo.exit" => {
                        std::process::exit(3);
                    }
                    other => {
                        // Defensive validation the SDK requires even though
                        // the desktop pre-filters undeclared commands.
                        respond_err(
                            &out,
                            &id,
                            -32000,
                            "unknown command",
                            Some(json!({
                                "code": "command_failed",
                                "message": format!("mock plugin has no command {other:?}")
                            })),
                        );
                    }
                }
            }
            _ => {
                // Unknown method: -32601, and NEVER crash (forward compat).
                respond_err(&out, &id, -32601, "method not found", None);
            }
        }
    }
}
