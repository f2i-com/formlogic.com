//! QuickJS sandbox for the desktop flow runner — the Rust twin of the backend
//! `QuickJsRunner.php`.
//!
//! USER CODE inside a flow (condition / logic_block expressions) and the app's
//! `onConnectorEvent` scripts (the headless Aokie path) run in the vendored
//! static `qjs` binary — never in-process eval. We ship the binary + the flow
//! prelude as embedded resources (`include_bytes!` / `include_str!`) so the same
//! sandbox is available in `cargo test`, the GUI, and the packaged app without
//! any external resource-dir plumbing. Each evaluation spawns a fresh `qjs`,
//! feeds one JSON job line on stdin, reads one JSON reply line on stdout, and is
//! bounded by a hard wall-clock deadline (`QJS_TIMEOUT`) + the binary's own
//! `--memory-limit`/`--stack-size` caps; the child is killed on overrun.
//!
//! Protocol (see `resources/qjs/flow-prelude.js`):
//!   in : {"mode":"bool"|"expr"|"applogic", "expr"|"source": "...", "ctx": {…}}
//!   out: {"ok":true,"value":<json>} | {"ok":false,"error":"<message>"}

use serde_json::Value;
use std::io;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Hard wall-clock budget for one evaluation (docs/FORMLOGIC_FLOWS.md §4: 2 s).
pub const QJS_TIMEOUT: Duration = Duration::from_secs(2);
/// `--memory-limit` (KB) + `--stack-size` (KB) — identical to `QuickJsRunner.php`
/// so client / server / desktop share the same VM limits by construction.
const MEMORY_LIMIT_KB: &str = "65536"; // 64 MiB
const STACK_SIZE_KB: &str = "512";

/// The platform `qjs` binary, embedded at compile time. `None` on platforms we
/// don't ship a binary for (the runner then reports QuickJS unavailable and
/// condition/logic_block nodes fail with a typed error rather than panicking).
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const QJS_BIN: Option<&[u8]> = Some(include_bytes!("../../resources/qjs/qjs-windows-x86_64.exe"));
#[cfg(all(unix, target_arch = "x86_64"))]
const QJS_BIN: Option<&[u8]> = Some(include_bytes!("../../resources/qjs/qjs-linux-x86_64"));
#[cfg(not(any(all(target_os = "windows", target_arch = "x86_64"), all(unix, target_arch = "x86_64"))))]
const QJS_BIN: Option<&[u8]> = None;

/// The desktop flow prelude (separate from the canonical browser prelude).
const FLOW_PRELUDE: &str = include_str!("../../resources/qjs/flow-prelude.js");

#[cfg(windows)]
const QJS_NAME: &str = "qjs-flow.exe";
#[cfg(not(windows))]
const QJS_NAME: &str = "qjs-flow";

/// A QuickJS evaluation failure — carries the guest message for `node_failed`.
#[derive(Debug, Clone)]
pub struct QjsError {
    pub message: String,
}

impl QjsError {
    fn new(msg: impl Into<String>) -> Self {
        Self { message: msg.into() }
    }
}

impl std::fmt::Display for QjsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for QjsError {}

/// Materialise the embedded binary + prelude into a stable cache dir once. Both
/// are content-length-checked, so a truncated/older copy is rewritten. Returns
/// `(qjs_path, prelude_path)`.
fn ensure_resources() -> Result<&'static (PathBuf, PathBuf), QjsError> {
    static PATHS: OnceLock<Result<(PathBuf, PathBuf), String>> = OnceLock::new();
    PATHS
        .get_or_init(|| materialise().map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| QjsError::new(e.clone()))
}

fn materialise() -> io::Result<(PathBuf, PathBuf)> {
    let bin = QJS_BIN.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "no bundled qjs binary for this platform",
        )
    })?;
    let dir = std::env::temp_dir().join("formlogic-desktop-flows");
    std::fs::create_dir_all(&dir)?;
    let qjs = dir.join(QJS_NAME);
    write_if_stale(&qjs, bin)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&qjs, std::fs::Permissions::from_mode(0o755))?;
    }
    let prelude = dir.join("flow-prelude.js");
    write_if_stale(&prelude, FLOW_PRELUDE.as_bytes())?;
    Ok((qjs, prelude))
}

/// Write `contents` to `path` only when it's missing or a different length
/// (atomic via a sibling temp + rename), so concurrent starts converge and we
/// never re-write ~2 MB on every launch.
fn write_if_stale(path: &std::path::Path, contents: &[u8]) -> io::Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() == contents.len() as u64 {
            return Ok(());
        }
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // On Windows a rename over a file another process holds open can
            // fail; if the target now exists with the right size, accept it.
            let _ = std::fs::remove_file(&tmp);
            if std::fs::metadata(path).map(|m| m.len() == contents.len() as u64).unwrap_or(false) {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// Whether the QuickJS sandbox is usable on this platform/build.
pub fn is_available() -> bool {
    ensure_resources().is_ok()
}

/// Evaluate a boolean condition expression against `ctx` (keys become sandbox
/// globals), using the default `QJS_TIMEOUT` deadline. Errors
/// (syntax/runtime/timeout) surface as `QjsError`.
pub async fn eval_bool(expr: &str, ctx: &Value) -> Result<bool, QjsError> {
    eval_bool_with_timeout(expr, ctx, QJS_TIMEOUT).await
}

/// Same as [`eval_bool`], but with an explicit wall-clock budget instead of the
/// fixed `QJS_TIMEOUT` default. The flow runner's `condition` node handler uses
/// this to make a node's declared (clamped) `data.timeoutMs` the REAL deadline
/// instead of always falling back to the hardcoded 2s.
pub async fn eval_bool_with_timeout(expr: &str, ctx: &Value, timeout: Duration) -> Result<bool, QjsError> {
    let job = serde_json::json!({ "mode": "bool", "expr": expr, "ctx": ctx });
    let v = run_job(&job, timeout).await?;
    Ok(v.as_bool().unwrap_or(false))
}

/// Evaluate a value expression against `ctx` (keys become sandbox globals),
/// using the default `QJS_TIMEOUT` deadline.
pub async fn eval_expr(expr: &str, ctx: &Value) -> Result<Value, QjsError> {
    eval_expr_with_timeout(expr, ctx, QJS_TIMEOUT).await
}

/// Same as [`eval_expr`], but with an explicit wall-clock budget — see
/// [`eval_bool_with_timeout`]. Used by the flow runner's `logic_block` node
/// handler so its declared `data.timeoutMs` actually governs the sandbox.
pub async fn eval_expr_with_timeout(expr: &str, ctx: &Value, timeout: Duration) -> Result<Value, QjsError> {
    let job = serde_json::json!({ "mode": "expr", "expr": expr, "ctx": ctx });
    run_job(&job, timeout).await
}

/// Run a custom app-logic hook `source` (declares `function run(ctx){…}`) and
/// return its result object. The whole `ctx` is passed to `run` — mirrors the
/// browser `quickjs-host.ts` 'applogic' wrapper. Always uses the default
/// `QJS_TIMEOUT` (app-logic hooks have no per-call declared timeout).
pub async fn run_applogic(source: &str, ctx: &Value) -> Result<Value, QjsError> {
    let job = serde_json::json!({ "mode": "applogic", "source": source, "ctx": ctx });
    run_job(&job, QJS_TIMEOUT).await
}

/// Spawn one `qjs`, feed the job line, read the single reply line, enforce the
/// given deadline, and unwrap `{ok,value}` / `{ok:false,error}`.
async fn run_job(job: &Value, timeout: Duration) -> Result<Value, QjsError> {
    let (qjs, prelude) = ensure_resources()?;
    let mut line = serde_json::to_string(job).map_err(|e| QjsError::new(e.to_string()))?;
    line.push('\n');

    let mut cmd = tokio::process::Command::new(qjs);
    cmd.arg("--std")
        .arg("--memory-limit")
        .arg(MEMORY_LIMIT_KB)
        .arg("--stack-size")
        .arg(STACK_SIZE_KB)
        .arg(prelude)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd.env_remove("AOKIE_COMPANION_DESKTOP_TOKEN");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| QjsError::new(format!("failed to start qjs: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.flush().await;
        drop(stdin); // EOF so the guest's getline() returns
    }
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| QjsError::new("qjs child has no stdout"))?;

    let mut buf = Vec::with_capacity(256);
    let read = stdout.read_to_end(&mut buf);
    match tokio::time::timeout(timeout, read).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(QjsError::new(format!("qjs read failed: {e}")));
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(QjsError::new(format!("evaluation exceeded {}ms", timeout.as_millis())));
        }
    }
    let _ = child.wait().await;

    let text = String::from_utf8_lossy(&buf);
    let reply_line = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| QjsError::new("qjs produced no output"))?;
    let reply: Value = serde_json::from_str(reply_line.trim())
        .map_err(|e| QjsError::new(format!("qjs reply was not JSON: {e}")))?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("value").cloned().unwrap_or(Value::Null))
    } else {
        let msg = reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("expression evaluation failed")
            .to_string();
        Err(QjsError::new(msg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn eval_bool_true_and_false() {
        assert!(eval_bool("event.n > 3", &json!({ "event": { "n": 5 } })).await.unwrap());
        assert!(!eval_bool("event.n > 3", &json!({ "event": { "n": 1 } })).await.unwrap());
    }

    #[tokio::test]
    async fn eval_expr_echoes_value() {
        let v = eval_expr("({ doubled: inputs.x * 2 })", &json!({ "inputs": { "x": 21 } }))
            .await
            .unwrap();
        assert_eq!(v["doubled"], json!(42));
    }

    #[tokio::test]
    async fn syntax_error_is_reported_not_panicked() {
        let err = eval_bool("this is (not js", &json!({})).await.unwrap_err();
        assert!(!err.message.is_empty());
    }

    #[tokio::test]
    async fn infinite_loop_is_killed_by_the_deadline() {
        // A wedged guest must be hard-killed within the 2 s budget, not hang.
        let started = std::time::Instant::now();
        let err = eval_bool("while (true) {}", &json!({})).await.unwrap_err();
        assert!(err.message.contains("2000ms") || !err.message.is_empty());
        assert!(started.elapsed() < Duration::from_secs(6), "must not hang past the deadline");
    }

    /// A busy-wait expression that blocks for roughly `ms` milliseconds (deterministic
    /// CPU spin, not an OS sleep — the qjs prelude's guest environment has no timer API).
    fn busy_wait_expr(ms: u64, return_value: &str) -> String {
        format!(
            "(function(){{ var s = Date.now(); while (Date.now() - s < {ms}) {{}} return {return_value}; }})()"
        )
    }

    #[tokio::test]
    async fn eval_expr_with_timeout_honors_a_longer_declared_budget() {
        // A script that legitimately takes ~2.6s: past the fixed QJS_TIMEOUT (2s) default,
        // but comfortably inside a node's own longer declared timeoutMs (6s). Proves the
        // REAL deadline used is now the caller-supplied one, not always the hardcoded 2s.
        let expr = busy_wait_expr(2600, "42");

        // Control: against the unmodified default, this must still time out exactly as
        // before (nothing regressed for callers that don't pass an override).
        let default_err = eval_expr(&expr, &json!({})).await.unwrap_err();
        assert!(default_err.message.contains("2000ms"), "default budget message: {}", default_err.message);

        // With an explicit longer budget, the same slow script now succeeds.
        let v = eval_expr_with_timeout(&expr, &json!({}), Duration::from_secs(6)).await.unwrap();
        assert_eq!(v, json!(42));
    }

    #[tokio::test]
    async fn eval_bool_with_timeout_honors_a_longer_declared_budget() {
        let expr = busy_wait_expr(2600, "true");
        let default_err = eval_bool(&expr, &json!({})).await.unwrap_err();
        assert!(default_err.message.contains("2000ms"), "default budget message: {}", default_err.message);
        assert!(eval_bool_with_timeout(&expr, &json!({}), Duration::from_secs(6)).await.unwrap());
    }

    #[tokio::test]
    async fn eval_expr_with_timeout_still_fails_when_the_declared_budget_is_also_exceeded() {
        // A genuinely wedged guest must still hard-fail the node (Rust already fails the
        // whole flow on a QuickJS timeout for both node types) — only the ACTUAL deadline
        // value changes, not the fail-the-run behavior.
        let started = std::time::Instant::now();
        // "expr" mode wraps the guest text as `return (<expr>)`, so it must be a single
        // expression, not a `while` statement — an IIFE containing the infinite loop.
        let err = eval_expr_with_timeout("(function(){ while (true) {} })()", &json!({}), Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(err.message.contains("500ms"), "message: {}", err.message);
        assert!(started.elapsed() < Duration::from_secs(4), "must not hang past its own deadline");
    }

    /// SECURITY REGRESSION GUARD — QuickJS sandbox-escape defense (see flow-prelude.js's
    /// header + `reply()`). The prelude deletes `std`/`os`/`bjson`/`scriptArgs` from the
    /// global object before running untrusted code, specifically because a deferred
    /// `.then()` callback could otherwise re-acquire the host module via dynamic
    /// `import('qjs:std')` (the lock-down only deletes the global property, not the
    /// module loader's registration) and use it for a host-privileged action (arbitrary
    /// FS write here — real-world equivalents: std.popen exec, getenv, urlGet SSRF) AFTER
    /// the harness's own synchronous "done" reply. The defense is `reply()` calling
    /// `std.exit(0)` synchronously right after writing the reply, so the interpreter's
    /// job queue is NEVER pumped and that deferred callback can never run.
    ///
    /// This test schedules exactly that attack (a microtask that tries to re-import
    /// `qjs:std` and write a marker file) against the REAL sandbox and asserts the file
    /// is never created — i.e. either the deferred job never runs (the intended defense)
    /// or the guest's attempt to reach it is rejected outright. Either is an acceptable
    /// PASS; the only FAIL condition is the marker file actually appearing, which would
    /// mean the sandbox is genuinely escapable.
    #[tokio::test]
    async fn deferred_promise_cannot_reacquire_std_after_reply() {
        let dir = std::env::temp_dir().join(format!("formlogic-qjs-escape-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create test scratch dir");
        let marker = dir.join("pwned.txt");
        let _ = std::fs::remove_file(&marker); // clean slate if a previous run left it

        // JSON-escape the path (Windows backslashes) for embedding as a JS string literal.
        let marker_json = serde_json::to_string(&marker.to_string_lossy().to_string()).unwrap();

        let expr = format!(
            r#"(function() {{
                try {{
                    Promise.resolve().then(function() {{
                        try {{
                            var modPromise = import('qjs:std');
                            modPromise.then(function(std) {{
                                try {{
                                    var f = std.open({marker}, 'w');
                                    f.puts('pwned');
                                    f.close();
                                }} catch (e) {{}}
                            }});
                        }} catch (e) {{}}
                    }});
                }} catch (e) {{}}
                return 'sentinel-done';
            }})()"#,
            marker = marker_json
        );

        let result = eval_expr(&expr, &json!({})).await;
        // Whichever way the guest's import() attempt resolves (scheduled-but-never-run,
        // or rejected outright as unsupported in this evaluation context), the harness's
        // own synchronous reply must still complete normally.
        match &result {
            Ok(v) => assert_eq!(v, &json!("sentinel-done"), "main synchronous expression must evaluate normally"),
            Err(e) => {
                // Acceptable only if the guest's own scheduling attempt itself failed
                // synchronously (e.g. import() unsupported here) — not a timeout/crash.
                assert!(!e.message.contains("exceeded"), "must not time out: {}", e.message);
            }
        }

        assert!(
            !marker.exists(),
            "SANDBOX ESCAPE: a deferred Promise re-imported qjs:std and wrote a file with \
             host privileges after the reply — flow-prelude.js's exit-before-drain defense \
             is broken"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn applogic_runs_hook_and_returns_effects() {
        let source = r#"function run(ctx) {
          var ev = ctx.event || {};
          if (ev.name !== 'aokie.call.incoming') return {};
          return { effects: [ { type: 'formlogic.submitResponse', formKey: 'Calls',
            answers: { caller_phone: String((ev.data||{}).from||'') } } ] };
        }"#;
        let ctx = json!({ "event": { "name": "aokie.call.incoming", "data": { "from": "+15551212" } }, "storage": {} });
        let out = run_applogic(source, &ctx).await.unwrap();
        let effects = out["effects"].as_array().expect("effects array");
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0]["type"], "formlogic.submitResponse");
        assert_eq!(effects[0]["answers"]["caller_phone"], "+15551212");
    }

    #[tokio::test]
    async fn applogic_guard_returns_empty_for_other_events() {
        let source = "function run(ctx){ if((ctx.event||{}).name!=='x') return {}; return {effects:[1]}; }";
        let out = run_applogic(source, &json!({ "event": { "name": "y" } })).await.unwrap();
        assert!(out.get("effects").is_none() || out["effects"].is_null());
    }
}
