//! FormLogic's sandboxed evaluator — the WebAssembly guest.
//!
//! The backend runs author-written JavaScript — field conditions, calculated
//! fields, validation rules, and `onSubmit` scripts — in a child process so that
//! nothing a form author writes can touch the PHP worker. This program is what
//! runs INSIDE that child: it is compiled to `wasm32-wasip1` and executed by the
//! `formlogic-runtime` launcher (../host) under wasmtime, with a hard linear-memory
//! ceiling, a fuel budget, a wall-clock epoch and no WASI capability beyond stdio
//! and the clock. The engine is zipp's `safe-sandbox` profile — interpreter only,
//! `unsafe` forbidden in the VM and regex engine, no host modules to remove — and
//! the wasm boundary is the second, engine-independent layer: even a memory-safety
//! defect somewhere in the guest's dependency tree cannot reach the launcher's
//! address space, let alone PHP's.
//!
//! It replaced a vendored `qjs` build driven by a JavaScript harness that had to
//! capture QuickJS's `std`/`os` host modules and then `delete` them from the
//! global object before letting a guest run.
//!
//! ## Wire protocol (unchanged — `SandboxRunner.php` is the other end)
//!
//! One JSON job arrives on stdin as a single line. Replies are newline-delimited
//! JSON on stdout, strictly turn-based.
//!
//!   in : {"mode":"eval","jobs":[{"id","expression","context"?}],"context":{…}}
//!        {"mode":"script","script":"…","context":{"answers":…,"meta":…}}
//!   out: {"type":"call","id":N,"module":…,"method":…,"args":[…]}   ← script only
//!   in : {"value":…} | {"error":"…"}                               ← the host's reply
//!   out: {"type":"done","results":[…]}                             ← eval
//!        {"type":"done","result":…,"reject"?,"message"?,"store"?}  ← script
//!        {"type":"done","error":"…"}                               ← failure
//!
//! Keeping the protocol identical means PHP keeps owning every side effect: a
//! guest's `ctx.db` / `ctx.http` / `ctx.flows` call becomes a `call` frame that
//! the trusted host answers, so SSRF guards, DNS pinning and authorization stay
//! where they already are.
//!
//! ## Why the host owns the transport
//!
//! Under QuickJS the *guest* performed the RPC itself, via `std.in.getline()` —
//! which is why the harness had to hold a reference to a module that also offered
//! `popen`, `getenv` and arbitrary file reads. Here the RPC is a Rust closure
//! installed with `set_host_call`; the guest can only reach it through one
//! trampoline that takes strings and returns a string. It cannot read stdin, and
//! there is no file or process API to reach for.

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Instruction budget for one job. The wall clock is still owned by PHP (it
/// pauses its watchdog around host calls, which this process cannot see), so this
/// is the deterministic backstop for a guest that never yields.
const DEFAULT_MAX_STEPS: u64 = 200_000_000;

/// Heap ceiling — 64 MiB, matching the browser host and the previous runtime so
/// all three fail at the same point.
const DEFAULT_HEAP_MB: usize = 64;

/// Cap on what one job may hand back.
const OUTPUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;

/// The wall clock, as the engine reads it.
///
/// On wasm32 zipp has no clock of its own: `std::time` is an `unimplemented!()`
/// stub on `wasm32-unknown-unknown`, so the engine keeps a non-panicking default
/// (epoch 0, a counter for the monotonic clock) until the host installs one. This
/// is a WASI guest, where `std::time` IS implemented — through the launcher's
/// clock capability — so hand the engine the real thing. Without this, every
/// `new Date()` in a form expression would be 1970 on the server while the
/// browser and the corpus say otherwise. `Date` reads are UTC, exactly as on the
/// other two runtimes.
fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn mono_ms() -> f64 {
    static BASE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

fn main() {
    zipp_vm::install_clock(epoch_ms, mono_ms);

    let mut prelude_path: Option<String> = None;
    let mut prelude_source: Option<String> = None;
    let mut max_steps = DEFAULT_MAX_STEPS;
    let mut heap_mb = DEFAULT_HEAP_MB;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--prelude" if i + 1 < args.len() => {
                prelude_path = Some(args[i + 1].clone());
                i += 2;
            }
            // The launcher's form. The guest has no filesystem capability — no
            // directory is preopened, on purpose — so the launcher reads the
            // prelude on the trusted side and hands the SOURCE across as an
            // argument. Reading a path here would fail under wasmtime, which is
            // the right outcome for any other path a guest might name.
            "--prelude-source" if i + 1 < args.len() => {
                prelude_source = Some(args[i + 1].clone());
                i += 2;
            }
            "--max-steps" if i + 1 < args.len() => {
                max_steps = args[i + 1].parse().unwrap_or(DEFAULT_MAX_STEPS);
                i += 2;
            }
            "--heap-mb" if i + 1 < args.len() => {
                heap_mb = args[i + 1].parse().unwrap_or(DEFAULT_HEAP_MB);
                i += 2;
            }
            // A positional argument is the prelude, so the call shape stays close
            // to the runner it replaces.
            other if !other.starts_with("--") && prelude_path.is_none() => {
                prelude_path = Some(other.to_string());
                i += 1;
            }
            _ => i += 1,
        }
    }

    let prelude = match (prelude_source, prelude_path) {
        (Some(source), _) => source,
        (None, Some(path)) => match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) => {
                emit_done_error(&format!("cannot read the prelude at {path}: {e}"));
                return;
            }
        },
        (None, None) => {
            emit_done_error("no prelude was supplied");
            return;
        }
    };

    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() || line.trim().is_empty() {
        emit_done_error("no job was received");
        return;
    }
    let job: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(e) => {
            emit_done_error(&format!("malformed job: {e}"));
            return;
        }
    };

    let mode = job.get("mode").and_then(|v| v.as_str()).unwrap_or("eval");
    let result = match mode {
        "script" => run_script(&prelude, &job, max_steps, heap_mb),
        _ => run_eval(&prelude, &job, max_steps, heap_mb),
    };
    if let Err(message) = result {
        emit_done_error(&message);
    }
}

/// Strict allowlist of `(module, method)` pairs an `onSubmit(ctx)` script may invoke
/// over the host RPC channel. Mirrors `FormLogicRuntime::handleHostCall`.
fn is_allowed_rpc(module: &str, method: &str) -> bool {
    matches!(
        (module, method),
        ("db", "setField" | "getField" | "setStatus" | "addTag")
            | ("utils", "uuid" | "now" | "nowMs" | "hash" | "formatDate")
            | ("http", "get" | "post" | "put" | "patch" | "delete" | "request")
            | ("flows", "run")
    )
}

/// Evaluate a batch of pure expressions. No host calls; one round trip.
fn run_eval(
    prelude: &str,
    job: &serde_json::Value,
    max_steps: u64,
    heap_mb: usize,
) -> Result<(), String> {
    let empty = Vec::new();
    let jobs = job.get("jobs").and_then(|v| v.as_array()).unwrap_or(&empty);
    let shared_context = job
        .get("context")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    // Every expression is evaluated through INDIRECT eval inside its own
    // try/catch. That is what makes one malformed expression a single failed
    // result rather than a failed batch: the engine rejects bad syntax when the
    // program is compiled, so the expressions must not be part of this program's
    // source. It also matches the browser's `evalCode` semantics exactly — the
    // expression runs as a program in global scope, seeing the prelude and the
    // injected context but never this wrapper's locals.
    let mut program = String::with_capacity(prelude.len() + 4096);
    program.push_str(&preamble_start(prelude));
    program.push_str(&format!(
        r#"
  var __jobs = __jsonParse({jobs});
  var __shared = __jsonParse({shared});
  __applyContext(__shared);
  var __resultsOut = "";
  for (var __i = 0; __i < __jobs.length; __i++) {{
    var __j = __jobs[__i];
    var __jobId = __hasOwn(__j, "id") ? __j.id : "";
    var __jobExpr = __hasOwn(__j, "expression") ? __j.expression : "";
    var __jobCtx = __hasOwn(__j, "context") ? __j.context : null;
    if (__resultsOut !== "") {{ __resultsOut += ","; }}
    try {{
      if (__jobCtx) {{ __applyContext(__jobCtx); }}
      var __valJson = __serializeSafe(__eval(__String(__jobExpr)), 0, {{ left: __MAX_NODES }});
      __resultsOut += "{{\"id\":" + __quoteString(__jobId) + ",\"ok\":true,\"value\":" + __valJson + "}}";
    }} catch (e) {{
      var __errMsg = __safeErrorMessage(e);
      __resultsOut += "{{\"id\":" + __quoteString(__jobId) + ",\"ok\":false,\"error\":" + __quoteString(__errMsg) + "}}";
    }}
  }}
  __emitRaw("{{\"type\":\"done\",\"results\":[" + __resultsOut + "]}}");
}})();
"#,
        jobs = json_string_literal(&serde_json::Value::Array(jobs.clone())),
        shared = json_string_literal(&shared_context),
    ));

    let done_frame: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let done_slot = Arc::clone(&done_frame);
    let host = Box::new(move |kind: &str, args: &[String]| -> Result<String, String> {
        if kind != "done" {
            return Err(format!("unsupported host call: {kind}"));
        }
        let payload = args.first().cloned().unwrap_or_default();
        if payload.len() > OUTPUT_LIMIT_BYTES {
            return Err("output limit exceeded".into());
        }
        let mut slot = done_slot.lock().map_err(|_| "host lock poisoned".to_string())?;
        if slot.is_some() {
            return Err("duplicate done frame".into());
        }
        *slot = Some(payload);
        Ok(String::new())
    });

    let mut state = compile(&program, max_steps, heap_mb, Some(host))?;
    let outcome = state.run_init();
    if let Some(limit) = state.resource_limit_error() {
        return Err(limit.to_string());
    }
    outcome.map_err(|e| e.to_string())?;
    emit_done_frame(&done_frame, RunMode::Eval);
    Ok(())
}

/// Run an `onSubmit(ctx)` script, answering its `ctx.*` calls over the wire.
fn run_script(
    prelude: &str,
    job: &serde_json::Value,
    max_steps: u64,
    heap_mb: usize,
) -> Result<(), String> {
    let script = job.get("script").and_then(|v| v.as_str()).unwrap_or("");
    let context = job
        .get("context")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let mut program = String::with_capacity(prelude.len() + 4096);
    program.push_str(&preamble_start(prelude));
    program.push_str(&format!(
        r#"
  var __ctxRaw = __jsonParse({context});
  var __rpcId = 0;
  function __serializeArgs(args, budget) {{
    var out = "[";
    var len = args.length;
    for (var i = 0; i < len && i < 5000; i++) {{
      if (budget.left <= 0) break;
      if (i > 0) out += ",";
      var elem;
      try {{ elem = args[i]; }} catch (_e) {{ elem = null; }}
      out += __serializeSafe(elem, 1, budget);
    }}
    return out + "]";
  }}
  function __hostCall(module, method, args) {{
    __rpcId++;
    var reply = __hostCallRaw("rpc", __String(module), __String(method), __serializeArgs(args, {{ left: __MAX_NODES }}), __String(__rpcId));
    var parsed;
    try {{ parsed = __jsonParse(reply); }} catch (e) {{ throw new __Error("bad host response"); }}
    if (parsed && typeof parsed === "object" && __hasOwn(parsed, "error") && parsed.error) {{ throw new __Error(__String(parsed.error)); }}
    return (parsed && typeof parsed === "object" && __hasOwn(parsed, "value")) ? parsed.value : null;
  }}
  function __module(name, methods) {{
    var o = {{}};
    for (var i = 0; i < methods.length; i++) {{
      (function (m) {{
        o[m] = function () {{ return __hostCall(name, m, arguments); }};
      }})(methods[i]);
    }}
    return o;
  }}
  var ctx = {{
    answers: __ctxRaw.answers || {{}},
    meta: __ctxRaw.meta || {{}},
    db: __module("db", ["setField", "getField", "setStatus", "addTag"]),
    utils: __module("utils", ["uuid", "now", "nowMs", "hash", "formatDate"]),
    http: __module("http", ["get", "post", "put", "patch", "delete", "request"]),
    // ctx.flows.run records a queued-run intent on the PHP side; it is never
    // executed here.
    flows: __module("flows", ["run"])
  }};
  var __doneJson;
  try {{
    // `new Function` compiles the untrusted script in global scope only, so it sees
    // the prelude but none of this wrapper's locals.
    var __onSubmit = new __Function(__String({script}) + "\nreturn typeof onSubmit !== 'undefined' ? onSubmit : null;")();
    if (typeof __onSubmit !== "function") {{
      __doneJson = "{{\"type\":\"done\",\"error\":\"Script did not define onSubmit(ctx)\"}}";
    }} else {{
      var __out = __onSubmit(ctx);
      if (__out && typeof __out === "object" && __hasOwn(__out, "reject") && __out.reject === true) {{
        var __rejMsg = (__hasOwn(__out, "message") && __out.message) ? __out.message : "Submission rejected";
        __doneJson = "{{\"type\":\"done\",\"reject\":true,\"message\":" + __quoteString(__rejMsg) + "}}";
      }} else {{
        var __store = !(__out && typeof __out === "object" && __hasOwn(__out, "store") && __out.store === false);
        __doneJson = "{{\"type\":\"done\",\"result\":" + __serializeSafe(__out, 0, {{ left: __MAX_NODES }}) + ",\"store\":" + (__store ? "true" : "false") + "}}";
      }}
    }}
  }} catch (e) {{
    __doneJson = "{{\"type\":\"done\",\"error\":" + __quoteString("Script execution error: " + __safeErrorMessage(e)) + "}}";
  }}
  __emitRaw(__doneJson);
}})();
"#,
        context = json_string_literal(&context),
        script = json_string_literal_str(script),
    ));

    // The RPC. Each call writes one `call` frame and blocks for exactly one reply
    // line, which is what makes the protocol turn-based: PHP is never expected to
    // interleave, and a guest cannot get ahead of its own answers.
    let failed: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let transport_failed = Arc::clone(&failed);
    let done_frame: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let done_slot = Arc::clone(&done_frame);
    let done_received: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let done_flag = Arc::clone(&done_received);
    let host = Box::new(move |kind: &str, args: &[String]| -> Result<String, String> {
        if kind == "done" {
            let payload = args.first().cloned().unwrap_or_default();
            if payload.len() > OUTPUT_LIMIT_BYTES {
                return Err("output limit exceeded".into());
            }
            let mut slot = done_slot.lock().map_err(|_| "host lock poisoned".to_string())?;
            if slot.is_some() {
                return Err("duplicate done frame".into());
            }
            *slot = Some(payload);
            done_flag.store(true, Ordering::Relaxed);
            return Ok(String::new());
        }
        if kind != "rpc" {
            return Err(format!("unsupported host call: {kind}"));
        }
        if done_flag.load(Ordering::Relaxed) {
            return Err("rpc after completion".into());
        }
        let module = args.first().cloned().unwrap_or_default();
        let method = args.get(1).cloned().unwrap_or_default();
        if !is_allowed_rpc(&module, &method) {
            return Err(format!("disallowed host rpc: {module}.{method}"));
        }
        let raw_args = args.get(2).cloned().unwrap_or_else(|| "[]".into());
        if raw_args.len() > OUTPUT_LIMIT_BYTES {
            return Err("rpc arguments limit exceeded".into());
        }
        let id: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
        let parsed_args: serde_json::Value =
            serde_json::from_str(&raw_args).unwrap_or_else(|_| serde_json::json!([]));

        let frame = serde_json::json!({
            "type": "call", "id": id, "module": module,
            "method": method, "args": parsed_args,
        });
        if writeln!(std::io::stdout(), "{frame}").is_err()
            || std::io::stdout().flush().is_err()
        {
            transport_failed.store(true, Ordering::Relaxed);
            return Err("host channel closed".into());
        }

        let mut reply = String::new();
        match std::io::stdin().lock().read_line(&mut reply) {
            Ok(0) | Err(_) => {
                transport_failed.store(true, Ordering::Relaxed);
                Err("host channel closed".into())
            }
            Ok(_) => Ok(reply.trim().to_string()),
        }
    });

    let mut state = compile(&program, max_steps, heap_mb, Some(host))?;
    let outcome = state.run_init();
    if let Some(limit) = state.resource_limit_error() {
        return Err(limit.to_string());
    }
    if failed.load(Ordering::Relaxed) {
        return Err("host channel closed".into());
    }
    outcome.map_err(|e| e.to_string())?;
    emit_done_frame(&done_frame, RunMode::Script);
    Ok(())
}

/// Shared guest-side helpers: the standard library in global scope, followed by an
/// IIFE that captures all intrinsics and the host-call trampoline before removing
/// `globalThis.__zippHostCall`, so untrusted code cannot forge replies, bypass
/// module allowlists, or poison serializer prototypes.
///
/// `print` and `console` are stubbed to no-ops on purpose. The host reads this
/// process's stdout as the protocol, so a guest that could write a line there
/// could forge a `{"type":"done"}` frame and have the trusted side accept a
/// fabricated result. Guest output has no destination, so it gets none.
fn preamble_start(prelude: &str) -> String {
    format!(
        r#"{prelude}
(function () {{
  var __hostCallRaw = typeof globalThis.__zippHostCall === "function" ? globalThis.__zippHostCall : null;
  try {{ delete globalThis.__zippHostCall; }} catch (e) {{ globalThis.__zippHostCall = undefined; }}
  globalThis.print = function () {{}};
  globalThis.console = {{ log: function () {{}}, warn: function () {{}}, error: function () {{}}, info: function () {{}}, debug: function () {{}} }};
  var __jsonParse = JSON.parse;
  var __eval = eval;
  // Pre-bind every prototype method with the original Function.prototype.bind/call BEFORE
  // untrusted code executes, so mutating Function.prototype.call or *.prototype.toJSON can
  // never hijack serialization or frame framing.
  var __bind = Function.prototype.bind;
  var __call = Function.prototype.call;
  var __hasOwn = __bind.call(__call, Object.prototype.hasOwnProperty);
  var __objToString = __bind.call(__call, Object.prototype.toString);
  var __dateToIso = __bind.call(__call, Date.prototype.toISOString);
  var __regExpTest = __bind.call(__call, RegExp.prototype.test);
  var __stringIndexOf = __bind.call(__call, String.prototype.indexOf);
  var __charCodeAt = __bind.call(__call, String.prototype.charCodeAt);
  var __fromCharCode = String.fromCharCode;
  var __String = String;
  var __isFinite = isFinite;
  var __Error = Error;
  var __Function = Function;
  var __isArray = Array.isArray;
  var __HEX = "0123456789abcdef";
  var __MAX_DEPTH = 8;
  var __MAX_NODES = 50000;
  var __IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  var __BLOCKED_GLOBALS = {{
    "eval": true, "Function": true, "Object": true, "Array": true, "String": true,
    "Number": true, "Boolean": true, "JSON": true, "Date": true, "RegExp": true,
    "Error": true, "TypeError": true, "RangeError": true, "SyntaxError": true,
    "ReferenceError": true, "URIError": true, "EvalError": true, "Promise": true,
    "Proxy": true, "Reflect": true, "Math": true, "Symbol": true, "Map": true,
    "Set": true, "WeakMap": true, "WeakSet": true, "globalThis": true,
    "print": true, "console": true, "undefined": true, "NaN": true, "Infinity": true,
    "isFinite": true, "isNaN": true, "parseInt": true, "parseFloat": true,
    "encodeURI": true, "decodeURI": true, "encodeURIComponent": true, "decodeURIComponent": true
  }};
  function __isDangerous(k) {{
    return k === "__proto__" || k === "constructor" || k === "prototype";
  }}
  function __hex4(code) {{
    return "\\u" + __fromCharCode(
      __charCodeAt(__HEX, (code >> 12) & 15),
      __charCodeAt(__HEX, (code >> 8) & 15),
      __charCodeAt(__HEX, (code >> 4) & 15),
      __charCodeAt(__HEX, code & 15)
    );
  }}
  function __quoteString(raw) {{
    var s = __String(raw);
    var out = "\"";
    for (var i = 0; i < s.length; i++) {{
      var c = __charCodeAt(s, i);
      if (c === 34) out += "\\\"";
      else if (c === 92) out += "\\\\";
      else if (c === 8) out += "\\b";
      else if (c === 12) out += "\\f";
      else if (c === 10) out += "\\n";
      else if (c === 13) out += "\\r";
      else if (c === 9) out += "\\t";
      else if (c < 32) out += __hex4(c);
      else if (c >= 0xd800 && c <= 0xdbff) {{
        var next = (i + 1 < s.length) ? __charCodeAt(s, i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {{
          out += __fromCharCode(c, next);
          i++;
        }} else {{
          out += __hex4(c);
        }}
      }} else if (c >= 0xdc00 && c <= 0xdfff) {{
        out += __hex4(c);
      }} else out += __fromCharCode(c);
    }}
    return out + "\"";
  }}
  function __safeErrorMessage(e) {{
    try {{
      if (e && typeof e === "object") {{
        var m = e.message;
        if (m !== undefined && m !== null && m !== "") return __String(m);
      }}
      return __String(e);
    }} catch (_inner) {{
      return "error";
    }}
  }}
  function __serializeSafe(value, depth, budget) {{
    if (budget.left <= 0) return "null";
    budget.left--;
    if (value === null || value === undefined) return "null";
    var t = typeof value;
    if (t === "number") return __isFinite(value) ? __String(value) : "null";
    if (t === "boolean") return value ? "true" : "false";
    if (t === "string") return __quoteString(value);
    if (depth >= __MAX_DEPTH) return "null";
    if (__isArray(value)) {{
      var arrOut = "[";
      var len = value.length;
      for (var i = 0; i < len && i < 5000; i++) {{
        if (budget.left <= 0) break;
        if (i > 0) arrOut += ",";
        var elem;
        try {{ elem = value[i]; }} catch (_e) {{ elem = null; }}
        arrOut += __serializeSafe(elem, depth + 1, budget);
      }}
      return arrOut + "]";
    }}
    if (t === "object") {{
      if (__objToString(value) === "[object Date]") {{
        try {{
          return __quoteString(__dateToIso(value));
        }} catch (_d) {{
          return "null";
        }}
      }}
      var objOut = "{{";
      var first = true;
      for (var k in value) {{
        if (!__hasOwn(value, k)) continue;
        if (__isDangerous(k)) continue;
        if (budget.left <= 0) break;
        var prop;
        try {{ prop = value[k]; }} catch (_e) {{ prop = null; }}
        var pt = typeof prop;
        if (prop === undefined || pt === "function" || pt === "symbol") continue;
        if (!first) objOut += ",";
        first = false;
        objOut += __quoteString(k) + ":" + __serializeSafe(prop, depth + 1, budget);
      }}
      return objOut + "}}";
    }}
    return "null";
  }}
  function __applyContext(ctx) {{
    if (!ctx || typeof ctx !== "object") return;
    for (var k in ctx) {{
      if (!__hasOwn(ctx, k)) continue;
      if (!__regExpTest(__IDENT, k) || __isDangerous(k) || __hasOwn(__BLOCKED_GLOBALS, k) || __stringIndexOf(k, "__") === 0) continue;
      globalThis[k] = ctx[k];
    }}
  }}
  function __emitRaw(jsonText) {{
    if (__hostCallRaw) {{
      __hostCallRaw("done", __String(jsonText));
    }}
  }}
"#,
        prelude = prelude,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunMode {
    Eval,
    Script,
}

fn compile(
    program: &str,
    max_steps: u64,
    heap_mb: usize,
    host: Option<zipp_vm::embed::HostCall>,
) -> Result<zipp_vm::embed::ScriptState, String> {
    let mut state = zipp_vm::embed::compile_script(program)?;
    state.set_limits(max_steps, None);
    state.set_heap_limit(heap_mb.saturating_mul(1024 * 1024));
    state.set_output_limit(OUTPUT_LIMIT_BYTES);
    if let Some(host) = host {
        state.set_host_call(host);
    }
    Ok(state)
}

fn valid_done_payload(obj: &serde_json::Map<String, serde_json::Value>, mode: RunMode) -> bool {
    if obj.get("type").and_then(|v| v.as_str()) != Some("done") {
        return false;
    }
    if obj.len() == 2 && obj.get("error").is_some_and(|v| v.is_string()) {
        return true;
    }
    match mode {
        RunMode::Eval => {
            if obj.len() != 2 {
                return false;
            }
            let Some(results) = obj.get("results").and_then(|v| v.as_array()) else {
                return false;
            };
            results.iter().all(|item| {
                let Some(entry) = item.as_object() else {
                    return false;
                };
                if !entry.get("id").is_some_and(|v| v.is_string()) {
                    return false;
                }
                match entry.get("ok").and_then(|v| v.as_bool()) {
                    Some(true) => entry.len() == 3 && entry.contains_key("value"),
                    Some(false) => {
                        entry.len() == 3 && entry.get("error").is_some_and(|v| v.is_string())
                    }
                    None => false,
                }
            })
        }
        RunMode::Script => {
            let is_result = obj.len() == 3
                && obj.contains_key("result")
                && obj.get("store").is_some_and(|v| v.is_boolean());
            let is_reject = obj.len() == 3
                && obj.get("reject").and_then(|v| v.as_bool()) == Some(true)
                && obj.get("message").is_some_and(|v| v.is_string());
            is_result || is_reject
        }
    }
}

/// Write the single validated `done` frame delivered through the private host callback.
/// Parse and mode-specific schema-validate in Rust before emitting so untrusted guest mutations
/// can never smuggle raw JSON syntax or unexpected top-level protocol keys onto stdout.
fn emit_done_frame(done_frame: &Arc<Mutex<Option<String>>>, mode: RunMode) {
    let frame = done_frame
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .unwrap_or_default();
    if frame.is_empty()
        || frame.len() > OUTPUT_LIMIT_BYTES
        || frame.contains('\n')
        || frame.contains('\r')
    {
        emit_done_error("the sandbox produced no result");
        return;
    }
    let parsed: serde_json::Value = match serde_json::from_str(&frame) {
        Ok(v) => v,
        Err(_) => {
            emit_done_error("the sandbox produced malformed output");
            return;
        }
    };
    let Some(obj) = parsed.as_object() else {
        emit_done_error("the sandbox produced malformed output");
        return;
    };
    if !valid_done_payload(obj, mode) {
        emit_done_error("the sandbox produced malformed output");
        return;
    }
    let canonical = match serde_json::to_string(&parsed) {
        Ok(s) if s.len() <= OUTPUT_LIMIT_BYTES => s,
        _ => {
            emit_done_error("output limit exceeded");
            return;
        }
    };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{canonical}");
    let _ = out.flush();
}

fn emit_done_error(message: &str) {
    let frame = serde_json::json!({ "type": "done", "error": message });
    let _ = writeln!(std::io::stdout(), "{frame}");
    let _ = std::io::stdout().flush();
}

/// A JSON document embedded as a JS *string literal*, so the guest gets it via
/// `JSON.parse`. Data never becomes program source — that is what stops a hostile
/// field name or answer value from being executed.
fn json_string_literal(value: &serde_json::Value) -> String {
    let doc = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
    serde_json::to_string(&doc).unwrap_or_else(|_| "\"null\"".into())
}

fn json_string_literal_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_payload_schema_is_enforced_per_mode() {
        let eval_ok = serde_json::json!({
            "type": "done",
            "results": [
                { "id": "a", "ok": true, "value": 42 },
                { "id": "b", "ok": false, "error": "boom" }
            ]
        });
        assert!(valid_done_payload(eval_ok.as_object().unwrap(), RunMode::Eval));
        assert!(!valid_done_payload(eval_ok.as_object().unwrap(), RunMode::Script));

        let script_ok = serde_json::json!({
            "type": "done",
            "result": { "ok": true },
            "store": true
        });
        assert!(valid_done_payload(script_ok.as_object().unwrap(), RunMode::Script));
        assert!(!valid_done_payload(script_ok.as_object().unwrap(), RunMode::Eval));

        let script_reject = serde_json::json!({
            "type": "done",
            "reject": true,
            "message": "nope"
        });
        assert!(valid_done_payload(script_reject.as_object().unwrap(), RunMode::Script));
        assert!(!valid_done_payload(script_reject.as_object().unwrap(), RunMode::Eval));

        let script_false_reject = serde_json::json!({
            "type": "done",
            "reject": false,
            "message": "nope"
        });
        assert!(!valid_done_payload(script_false_reject.as_object().unwrap(), RunMode::Script));

        let err_frame = serde_json::json!({ "type": "done", "error": "failed" });
        assert!(valid_done_payload(err_frame.as_object().unwrap(), RunMode::Eval));
        assert!(valid_done_payload(err_frame.as_object().unwrap(), RunMode::Script));

        let extra_key = serde_json::json!({
            "type": "done",
            "result": null,
            "store": true,
            "reject": true
        });
        assert!(!valid_done_payload(extra_key.as_object().unwrap(), RunMode::Script));
    }
}
