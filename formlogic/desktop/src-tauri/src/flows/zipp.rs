//! The desktop flow runner's JavaScript sandbox — zipp, embedded in-process.
//!
//! USER CODE inside a flow (`condition` / `logic_block` expressions) and an app's
//! `onConnectorEvent` scripts (the headless Aokie path) run here. This replaces a
//! vendored `qjs` binary that was embedded with `include_bytes!`, written to a
//! temp file on first use, and spawned as a child process per evaluation.
//!
//! Embedding the engine as a library instead removes all of that: no ~1.8 MB
//! binary in the bundle, no temp-file extraction, no process spawn per
//! expression, and no `--std` host modules to delete after the fact. zipp's
//! interpreter-only `safe-sandbox` profile ships no filesystem, process or
//! network surface at all, so the guest has nothing to reach for.
//!
//! Two limits bound a guest, and they are different things:
//!   * an INSTRUCTION budget, checked inside the interpreter loop, which stops a
//!     runaway deterministically; and
//!   * the caller's wall clock, honoured through zipp's cooperative abort flag —
//!     a timer thread flips an `AtomicBool` that the VM polls every few thousand
//!     instructions. That keeps the existing `Duration` contract without leaving
//!     an orphaned blocking thread behind, which a bare `tokio::time::timeout`
//!     around `spawn_blocking` would do.
//!
//! The prelude is now the CANONICAL one, shared byte-for-byte with the browser
//! and the backend (`ui/scripts/sync-prelude.mjs` writes all three). Previously
//! the desktop loaded only a protocol shim and no standard library, so any flow
//! condition calling `validators.*`, `finance.*`, `sum(...)` and friends threw
//! "is not defined" — and `eval_bool`'s `unwrap_or(false)` turned that into a
//! silently-false branch rather than a visible error.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Hard wall-clock budget for one evaluation (docs/FORMLOGIC_FLOWS.md §4: 2 s).
pub const QJS_TIMEOUT: Duration = Duration::from_secs(2);

/// Heap ceiling for one evaluation — 64 MiB, matching `QuickJsRunner.php` and the
/// browser host so the three runtimes fail at the same point.
const HEAP_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// Cap on what a guest may hand back. Flow values are small; anything larger is a
/// bug or an attack, and a bounded reply keeps a guest from exhausting the host
/// while "succeeding".
const OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;

/// Instruction budget for one evaluation. Generous enough for real expressions
/// (the whole shipped corpus runs in a tiny fraction of it) and far below what a
/// deliberate spin loop needs to matter.
const MAX_STEPS: u64 = 50_000_000;

/// The canonical FormLogic standard library, shared with the browser and backend.
const PRELUDE: &str = include_str!("../../resources/formlogic-prelude.js");

/// An evaluation failure — carries the guest message for `node_failed`.
#[derive(Debug, Clone)]
pub struct QjsError {
    pub message: String,
}

impl QjsError {
    fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
        }
    }
}

impl std::fmt::Display for QjsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for QjsError {}

/// Whether the sandbox can run. The engine is compiled in, so unlike the old
/// binary-extraction path this cannot fail at runtime — kept so callers and the
/// `flowRuntime.lastError` surface do not have to change shape.
pub fn is_available() -> bool {
    true
}

/// Evaluate a boolean condition expression against `ctx` (its keys become sandbox
/// globals), using the default [`QJS_TIMEOUT`] deadline.
pub async fn eval_bool(expr: &str, ctx: &Value) -> Result<bool, QjsError> {
    eval_bool_with_timeout(expr, ctx, QJS_TIMEOUT).await
}

/// Same as [`eval_bool`], with an explicit wall-clock budget. The flow runner's
/// `condition` node uses this so a node's declared (clamped) `data.timeoutMs` is
/// the real deadline rather than the fixed default.
pub async fn eval_bool_with_timeout(
    expr: &str,
    ctx: &Value,
    timeout: Duration,
) -> Result<bool, QjsError> {
    let value = eval_expr_with_timeout(expr, ctx, timeout).await?;
    // Mirrors the browser and backend: a condition coerces with JS truthiness
    // rather than demanding a literal boolean, so `count > 0` and `"yes"` behave
    // the way an author expects.
    Ok(match value {
        Value::Bool(b) => b,
        Value::Null => false,
        Value::Number(ref n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(ref s) => !s.is_empty(),
        _ => true,
    })
}

/// Evaluate a value expression against `ctx`, using the default deadline.
pub async fn eval_expr(expr: &str, ctx: &Value) -> Result<Value, QjsError> {
    eval_expr_with_timeout(expr, ctx, QJS_TIMEOUT).await
}

/// Same as [`eval_expr`], with an explicit wall-clock budget — used by the flow
/// runner's `logic_block` node so its declared `data.timeoutMs` governs.
pub async fn eval_expr_with_timeout(
    expr: &str,
    ctx: &Value,
    timeout: Duration,
) -> Result<Value, QjsError> {
    let program = build_expression_program(expr, ctx)?;
    run(program, timeout).await
}

/// Run a custom app-logic hook (`source` declares `function run(ctx){…}`) and
/// return its result. The whole `ctx` is passed to `run` — mirroring the browser
/// host's 'applogic' wrapper. Always uses the default deadline; app-logic hooks
/// carry no per-call declared timeout.
pub async fn run_applogic(source: &str, ctx: &Value) -> Result<Value, QjsError> {
    let program = build_applogic_program(source, ctx)?;
    run(program, QJS_TIMEOUT).await
}

/// Build the program for an expression evaluation.
///
/// The context crosses as a JSON *value* parsed inside the sandbox, never
/// concatenated into program source — the same rule the browser host and the
/// backend harness follow, and the reason a hostile field name or value cannot
/// become code. Only identifier-shaped keys are installed, and the three
/// prototype-pollution keys are refused.
fn build_expression_program(expr: &str, ctx: &Value) -> Result<String, QjsError> {
    let ctx_json = serde_json::to_string(ctx).map_err(|e| QjsError::new(e.to_string()))?;
    let ctx_literal =
        serde_json::to_string(&ctx_json).map_err(|e| QjsError::new(e.to_string()))?;
    Ok(format!(
        r#"{prelude}
(function () {{
  var __ctx;
  try {{ __ctx = JSON.parse({ctx_literal}); }} catch (e) {{ __ctx = {{}}; }}
  for (var __k in __ctx) {{
    if (Object.prototype.hasOwnProperty.call(__ctx, __k)
        && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(__k)
        && __k !== "__proto__" && __k !== "constructor" && __k !== "prototype") {{
      globalThis[__k] = __ctx[__k];
    }}
  }}
}})();
var __result;
try {{
  __result = {{ ok: true, value: __sanitize((0, eval)({expr_literal}), 0) }};
}} catch (e) {{
  __result = {{ ok: false, error: String((e && e.message) || e) }};
}}
__emit(__result);
"#,
        prelude = sandbox_preamble(),
        ctx_literal = ctx_literal,
        // Indirect eval runs the expression as a full PROGRAM in global scope, so
        // it sees the prelude and the injected context but never this wrapper's
        // locals — matching the browser's `evalCode` semantics exactly, including
        // how multi-statement and trailing-semicolon expressions behave.
        expr_literal = serde_json::to_string(expr).map_err(|e| QjsError::new(e.to_string()))?,
    ))
}

/// Build the program for an app-logic hook.
fn build_applogic_program(source: &str, ctx: &Value) -> Result<String, QjsError> {
    let ctx_json = serde_json::to_string(ctx).map_err(|e| QjsError::new(e.to_string()))?;
    let ctx_literal =
        serde_json::to_string(&ctx_json).map_err(|e| QjsError::new(e.to_string()))?;
    Ok(format!(
        r#"{prelude}
var __result;
try {{
  var __ctx;
  try {{ __ctx = JSON.parse({ctx_literal}); }} catch (e) {{ __ctx = {{}}; }}
  // `new Function` compiles the untrusted hook in global scope only — it can see
  // the prelude and its own ctx argument, never this wrapper's locals.
  var __run = new Function({source_literal} + "\nreturn typeof run === 'function' ? run : null;")();
  if (typeof __run !== "function") {{
    __result = {{ ok: false, error: "script did not define run(ctx)" }};
  }} else {{
    __result = {{ ok: true, value: __sanitize(__run(__ctx), 0) }};
  }}
}} catch (e) {{
  __result = {{ ok: false, error: String((e && e.message) || e) }};
}}
__emit(__result);
"#,
        prelude = sandbox_preamble(),
        ctx_literal = ctx_literal,
        source_literal = serde_json::to_string(source).unwrap_or_else(|_| "\"\"".into()),
    ))
}

/// The canonical prelude plus the two helpers the wrapper needs.
///
/// `__sanitize` reproduces the browser host's `sanitizeOut` and the backend
/// harness's `sanitize`: JSON-ish values only, bounded depth, and the
/// prototype-polluting keys dropped, so nothing structural crosses back into the
/// host. `__emit` is the single reply channel; `print`/`console` are stubbed so a
/// guest cannot inject a second line that the host would read as the result.
fn sandbox_preamble() -> String {
    format!(
        r#"{PRELUDE}
var __MAX_DEPTH = 8;
var __DANGEROUS = {{ "__proto__": true, "constructor": true, "prototype": true }};
function __sanitize(value, depth) {{
  if (value === null || value === undefined) return null;
  var t = typeof value;
  if (t === "number") return isFinite(value) ? value : null;
  if (t === "string" || t === "boolean") return value;
  if (depth >= __MAX_DEPTH) return null;
  if (typeof value === "object" && typeof value.length === "number" && !(value instanceof String)) {{
    var arr = [];
    for (var i = 0; i < value.length && i < 1000; i++) arr.push(__sanitize(value[i], depth + 1));
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
var __replies = [];
function __emit(obj) {{ __replies.push(JSON.stringify(obj)); }}
// A guest must not be able to write on the reply channel.
globalThis.print = function () {{}};
globalThis.console = {{ log: function () {{}}, warn: function () {{}}, error: function () {{}}, info: function () {{}}, debug: function () {{}} }};
"#,
        PRELUDE = PRELUDE,
    )
}

/// Compile and run one program under both budgets, off the async runtime.
///
/// The engine is synchronous and CPU-bound, so it runs on a blocking thread. The
/// wall clock is enforced through zipp's cooperative abort flag rather than by
/// abandoning the task: a `tokio::time::timeout` around `spawn_blocking` returns
/// early but leaves the thread spinning, which is exactly the resource leak the
/// deadline exists to prevent.
async fn run(program: String, timeout: Duration) -> Result<Value, QjsError> {
    let abort = Arc::new(AtomicBool::new(false));
    let timer_flag = Arc::clone(&abort);
    let observed = Arc::clone(&abort);

    let handle = tokio::task::spawn_blocking(move || run_blocking(&program, abort));

    let timer = tokio::spawn(async move {
        tokio::time::sleep(timeout).await;
        timer_flag.store(true, Ordering::Relaxed);
    });

    let outcome = handle
        .await
        .map_err(|e| QjsError::new(format!("sandbox task failed: {e}")))?;
    timer.abort();

    // The engine reports a host abort generically ("aborted by the host"), but the
    // only thing that raises the flag here is the deadline — and a flow author
    // debugging a failed node needs to know WHICH budget was exceeded, not that
    // something stopped. Node error messages have always named it.
    match outcome {
        Err(e) if observed.load(Ordering::Relaxed) => Err(QjsError::new(format!(
            "evaluation timed out after {}ms",
            timeout.as_millis()
        ))),
        other => other,
    }
}

fn run_blocking(program: &str, abort: Arc<AtomicBool>) -> Result<Value, QjsError> {
    let mut state = zipp_vm::embed::compile_script(program).map_err(QjsError::new)?;
    state.set_limits(MAX_STEPS, Some(abort));
    state.set_heap_limit(HEAP_LIMIT_BYTES);
    state.set_output_limit(OUTPUT_LIMIT_BYTES);

    state.run_init().map_err(QjsError::new)?;
    // A guest can turn some failures into a rejected promise, so the recorder's
    // sticky typed status is authoritative and must be consulted even when the
    // direct return looked fine.
    if let Some(limit) = state.resource_limit_error() {
        return Err(QjsError::new(limit));
    }

    let reply = state
        .eval_in_context("__replies.length ? __replies[__replies.length - 1] : \"\"")
        .map_err(QjsError::new)?;
    let raw = reply.as_str().unwrap_or("");
    if raw.is_empty() {
        return Err(QjsError::new("sandbox produced no result"));
    }

    let parsed: Value =
        serde_json::from_str(raw).map_err(|e| QjsError::new(format!("bad sandbox reply: {e}")))?;
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(parsed.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(QjsError::new(
            parsed
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("evaluation failed")
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn evaluates_a_plain_expression() {
        let v = eval_expr("1 + 1", &json!({})).await.unwrap();
        assert_eq!(v, json!(2));
    }

    #[tokio::test]
    async fn context_keys_become_globals() {
        let v = eval_expr("amount * 2", &json!({ "amount": 21 })).await.unwrap();
        assert_eq!(v, json!(42));
    }

    /// The regression this port exists to fix: the desktop shipped no standard
    /// library, so every prelude helper threw "is not defined" and `eval_bool`
    /// turned that into a silently-false branch.
    #[tokio::test]
    async fn the_canonical_prelude_is_available() {
        assert_eq!(
            eval_expr("validators.email(\"a@b.co\")", &json!({})).await.unwrap(),
            json!(true)
        );
        assert_eq!(eval_expr("sum([1,2,3])", &json!({})).await.unwrap(), json!(6));
        assert_eq!(
            eval_expr("finance.compoundInterest(1000, 0.05, 10)", &json!({}))
                .await
                .is_ok(),
            true
        );
    }

    #[tokio::test]
    async fn conditions_use_js_truthiness() {
        assert!(eval_bool("count > 0", &json!({ "count": 3 })).await.unwrap());
        assert!(!eval_bool("count > 0", &json!({ "count": 0 })).await.unwrap());
        assert!(eval_bool("name", &json!({ "name": "x" })).await.unwrap());
        assert!(!eval_bool("name", &json!({ "name": "" })).await.unwrap());
    }

    #[tokio::test]
    async fn a_guest_error_surfaces_rather_than_becoming_false() {
        let err = eval_expr("nope.nope", &json!({})).await.unwrap_err();
        assert!(err.message.contains("not defined"), "got: {}", err.message);
    }

    /// A stopped guest must say WHICH deadline it blew — the flow runner puts this
    /// straight into the node-failure message an author reads.
    #[tokio::test]
    async fn a_runaway_loop_is_stopped_and_names_the_deadline() {
        let err = eval_expr_with_timeout("while (true) {}", &json!({}), Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(
            err.message.contains("300ms"),
            "message should cite the deadline: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn the_guest_cannot_reach_the_host() {
        for probe in ["typeof require", "typeof std", "typeof os", "typeof process"] {
            let v = eval_expr(probe, &json!({})).await.unwrap();
            assert_eq!(v, json!("undefined"), "{probe} should be unreachable");
        }
    }

    #[tokio::test]
    async fn applogic_runs_and_returns_its_object() {
        let v = run_applogic(
            "function run(ctx) { return { doubled: ctx.n * 2 }; }",
            &json!({ "n": 21 }),
        )
        .await
        .unwrap();
        assert_eq!(v, json!({ "doubled": 42 }));
    }

    /// A guest must not be able to write a second reply the host would read.
    #[tokio::test]
    async fn a_guest_cannot_forge_the_reply_channel() {
        let v = eval_expr(
            "(function(){ try { console.log('x'); print('y'); } catch (e) {} return 7; })()",
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(v, json!(7));
    }
}
