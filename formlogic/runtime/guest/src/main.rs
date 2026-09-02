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
use std::sync::Arc;

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
    program.push_str(&preamble(prelude));
    program.push_str(&format!(
        r#"
var __jobs = JSON.parse({jobs});
var __shared = JSON.parse({shared});
__applyContext(__shared);
var __results = [];
for (var __i = 0; __i < __jobs.length; __i++) {{
  var __j = __jobs[__i];
  if (__j.context) {{ __applyContext(__j.context); }}
  try {{
    __results.push({{ id: __j.id, ok: true, value: __sanitize((0, eval)(String(__j.expression)), 0) }});
  }} catch (e) {{
    __results.push({{ id: __j.id, ok: false, error: String((e && e.message) || e) }});
  }}
}}
__emit({{ type: "done", results: __results }});
"#,
        jobs = json_string_literal(&serde_json::Value::Array(jobs.clone())),
        shared = json_string_literal(&shared_context),
    ));

    let mut state = compile(&program, max_steps, heap_mb, None)?;
    state.run_init().map_err(|e| e.to_string())?;
    if let Some(limit) = state.resource_limit_error() {
        return Err(limit.to_string());
    }
    flush_replies(&mut state);
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
    program.push_str(&preamble(prelude));
    program.push_str(&format!(
        r#"
var __ctxRaw = JSON.parse({context});
var __rpcId = 0;
function __hostCall(module, method, args) {{
  __rpcId++;
  var reply = __zippHostCall("rpc", String(module), String(method), JSON.stringify(__sanitize(args, 0)), String(__rpcId));
  var parsed;
  try {{ parsed = JSON.parse(reply); }} catch (e) {{ throw new Error("bad host response"); }}
  if (parsed && parsed.error) {{ throw new Error(String(parsed.error)); }}
  return parsed ? parsed.value : null;
}}
function __module(name, methods) {{
  var o = {{}};
  methods.forEach(function (m) {{
    o[m] = function () {{ return __hostCall(name, m, Array.prototype.slice.call(arguments)); }};
  }});
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
var __done;
try {{
  // `new Function` compiles the untrusted script in global scope only, so it sees
  // the prelude but none of this wrapper's locals.
  var __onSubmit = new Function(String({script}) + "\nreturn typeof onSubmit !== 'undefined' ? onSubmit : null;")();
  if (typeof __onSubmit !== "function") {{
    __done = {{ type: "done", error: "Script did not define onSubmit(ctx)" }};
  }} else {{
    var __out = __onSubmit(ctx);
    if (__out && typeof __out === "object" && __out.reject === true) {{
      __done = {{ type: "done", reject: true, message: String(__out.message || "Submission rejected") }};
    }} else {{
      __done = {{ type: "done", result: __sanitize(__out, 0), store: !(__out && __out.store === false) }};
    }}
  }}
}} catch (e) {{
  __done = {{ type: "done", error: "Script execution error: " + String((e && e.message) || e) }};
}}
__emit(__done);
"#,
        context = json_string_literal(&context),
        script = json_string_literal_str(script),
    ));

    // The RPC. Each call writes one `call` frame and blocks for exactly one reply
    // line, which is what makes the protocol turn-based: PHP is never expected to
    // interleave, and a guest cannot get ahead of its own answers.
    let failed: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let transport_failed = Arc::clone(&failed);
    let host = Box::new(move |kind: &str, args: &[String]| -> Result<String, String> {
        if kind != "rpc" {
            return Err(format!("unsupported host call: {kind}"));
        }
        let module = args.first().cloned().unwrap_or_default();
        let method = args.get(1).cloned().unwrap_or_default();
        let raw_args = args.get(2).cloned().unwrap_or_else(|| "[]".into());
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
    outcome.map_err(|e| e.to_string())?;
    flush_replies(&mut state);
    Ok(())
}

/// Shared guest-side helpers: the standard library, the sanitizer, the reply
/// channel, and the context installer.
///
/// `print` and `console` are stubbed to no-ops on purpose. The host reads this
/// process's stdout as the protocol, so a guest that could write a line there
/// could forge a `{"type":"done"}` frame and have the trusted side accept a
/// fabricated result. Guest output has no destination, so it gets none.
fn preamble(prelude: &str) -> String {
    format!(
        r#"{prelude}
var __MAX_DEPTH = 8;
var __DANGEROUS = {{ "__proto__": true, "constructor": true, "prototype": true }};
function __sanitize(value, depth) {{
  if (value === null || value === undefined) return null;
  var t = typeof value;
  if (t === "number") return isFinite(value) ? value : null;
  if (t === "string" || t === "boolean") return value;
  if (depth >= __MAX_DEPTH) return null;
  if (t === "object" && typeof value.length === "number" && !(value instanceof String)) {{
    var arr = [];
    for (var i = 0; i < value.length && i < 5000; i++) arr.push(__sanitize(value[i], depth + 1));
    return arr;
  }}
  if (t === "object") {{
    var out = {{}};
    for (var k in value) {{
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (__DANGEROUS[k]) continue;
      out[k] = __sanitize(value[k], depth + 1);
    }}
    return out;
  }}
  return null;
}}
var __IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
function __applyContext(ctx) {{
  if (!ctx || typeof ctx !== "object") return;
  for (var k in ctx) {{
    if (!Object.prototype.hasOwnProperty.call(ctx, k)) continue;
    // `__`-prefixed names are the wrapper's own (__jobs, __replies, __emit …);
    // a context key that spelled one would replace it, and every caller's
    // sanitiser is the only thing that stops that today. Refuse them here too.
    if (!__IDENT.test(k) || __DANGEROUS[k] || k.indexOf("__") === 0) continue;
    globalThis[k] = ctx[k];
  }}
}}
var __replies = [];
function __emit(obj) {{ __replies.push(JSON.stringify(obj)); }}
globalThis.print = function () {{}};
globalThis.console = {{ log: function () {{}}, warn: function () {{}}, error: function () {{}}, info: function () {{}}, debug: function () {{}} }};
"#,
        prelude = prelude,
    )
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

/// Write whatever the guest queued on the reply channel.
fn flush_replies(state: &mut zipp_vm::embed::ScriptState) {
    let joined = state
        .eval_in_context("__replies.join(\"\\n\")")
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    if joined.is_empty() {
        emit_done_error("the sandbox produced no result");
        return;
    }
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in joined.lines() {
        let _ = writeln!(out, "{line}");
    }
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
