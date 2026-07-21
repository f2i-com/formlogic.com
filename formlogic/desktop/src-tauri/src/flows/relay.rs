//! Remote-command relay executor (docs/API.md §connector:relay). While the
//! desktop is linked with the `connector:relay` scope, a web member can enqueue
//! a connector command (e.g. an Aokie `call.operatorSpeak`) for THIS runtime,
//! which the FlowRuntime long-polls, claims exactly-once, executes through the
//! LOCAL connector gateway (the same path the desktop uses for its own connector
//! calls — full manifest/capability validation), and completes with the result.
//!
//! This module is the pure, transport-agnostic core: `process_one` sequences
//! claim → execute → complete over injected async closures, so the exactly-once
//! (claim-gated), failure, and retry behaviour is unit-tested without a network
//! or a live plugin. The polling loop + wiring to `FlowRuntime` live in
//! `dispatcher.rs` (which owns the client/host/status).
//!
//! Commands whose connector id is the reserved `desktop` (plan §5.3 ops relay)
//! are intercepted BEFORE the connector gateway: validated against the
//! services/plugins allow-list and executed through the shared
//! `desktop_ops.rs` handlers (see `desktop_op_for`).

use std::future::Future;
use std::time::Duration;

use serde_json::{json, Value};

use crate::desktop_ops::DesktopOp;
use crate::formlogic_client::FlResult;

/// A failed local execution — the typed connector error code + message, carried
/// into the `complete` call's `error` blob so the web member sees why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayFailure {
    pub code: String,
    pub message: String,
}

/// The reserved connector id for Desktop self-ops (plan §5.3 — the account-
/// scoped `/api/desktop/ops` route enqueues lifecycle commands for THIS
/// machine with `connector_id='desktop'`). These are intercepted BEFORE the
/// normal connector gateway and run through the shared handlers in
/// `desktop_ops.rs`.
pub const DESKTOP_CONNECTOR_ID: &str = "desktop";

/// Route one claimed command: `Some(Ok(op))` when it targets the reserved
/// `desktop` connector and names an allow-listed op; `Some(Err(_))` when it
/// targets `desktop` but the op is NOT allow-listed (a typed refusal — the
/// command still gets COMPLETED as failed so it doesn't sit claimed forever);
/// `None` for every ordinary connector command (the normal dispatch path).
pub fn desktop_op_for(connector_id: &str, command: &str) -> Option<Result<DesktopOp, RelayFailure>> {
    if connector_id != DESKTOP_CONNECTOR_ID {
        return None;
    }
    Some(DesktopOp::from_command(command).ok_or_else(|| RelayFailure {
        code: "command_failed".into(),
        message: format!(
            "unknown desktop op {command:?} — the 'desktop' connector accepts the SHORT verbs: services.list|start|stop|restart|repair, plugins.list|start|stop|restart|health (the 'desktop.' prefix is the connector id, not part of the command)"
        ),
    }))
}

/// What happened to one command (the loop uses this to bump status counters).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// 409 on claim — another runtime won, or it expired. Not ours.
    Skipped,
    /// Claimed, executed OK, completed `done`.
    Completed,
    /// Claimed, executed with a connector error, completed `failed`.
    Failed,
    /// The claim call itself errored (network/etc.) — retry next poll.
    ClaimError(String),
    /// Execution completed but we couldn't record the outcome server-side.
    CompleteError(String),
}

impl Disposition {
    /// True when the command's lifecycle was driven to a terminal state here.
    pub fn is_handled(&self) -> bool {
        matches!(self, Disposition::Completed | Disposition::Failed)
    }
}

/// The command id (`commandId`) of a pending row, if present.
pub fn command_id(command: &Value) -> Option<String> {
    command.get("commandId").and_then(Value::as_str).map(str::to_string)
}

/// The `(connectorId, command)` pair to dispatch, if both present.
pub fn connector_and_command(command: &Value) -> Option<(String, String)> {
    let cid = command.get("connectorId").and_then(Value::as_str)?;
    let cmd = command.get("command").and_then(Value::as_str)?;
    if cid.is_empty() || cmd.is_empty() {
        return None;
    }
    Some((cid.to_string(), cmd.to_string()))
}

/// The command payload (or `null` when absent).
pub fn payload_of(command: &Value) -> Value {
    command.get("payload").cloned().unwrap_or(Value::Null)
}

/// The `complete` body for a successful execution.
pub fn done_payload(result: Value) -> Value {
    json!({ "status": "done", "result": result })
}

/// The `complete` body for a failed execution.
pub fn failed_payload(code: &str, message: &str) -> Value {
    json!({ "status": "failed", "error": { "code": code, "message": message } })
}

/// Drive one pending command through its lifecycle:
///
///   claim(id) → (409 ⇒ Skipped) → execute(connectorId, command, payload)
///             → complete(id, done|failed) with bounded retry on network error.
///
/// The `claim` gate is the exactly-once boundary (mirrors flow-run claim); we
/// only ever execute a command we won. `complete` is retried up to
/// `max_complete_attempts` because we've already run the side effect — losing
/// the result to a transient blip would strand the web member.
///
/// Commands whose connector id is the reserved `desktop` (plan §5.3) are
/// intercepted BEFORE `execute`: the op is validated against the
/// services/plugins allow-list (unknown op ⇒ completed failed, typed) and run
/// through `desktop_execute` (the shared `desktop_ops.rs` handlers) instead of
/// the connector gateway.
pub async fn process_one<FC, FCf, FE, FEf, FD, FDf, FK, FKf>(
    command: &Value,
    max_complete_attempts: u32,
    claim: FC,
    execute: FE,
    desktop_execute: FD,
    complete: FK,
) -> Disposition
where
    FC: Fn(String) -> FCf,
    FCf: Future<Output = FlResult<bool>>,
    FE: Fn(String, String, Value) -> FEf,
    FEf: Future<Output = Result<Value, RelayFailure>>,
    FD: Fn(DesktopOp, Value) -> FDf,
    FDf: Future<Output = Result<Value, RelayFailure>>,
    FK: Fn(String, Value) -> FKf,
    FKf: Future<Output = FlResult<()>>,
{
    let id = match command_id(command) {
        Some(i) => i,
        None => return Disposition::ClaimError("command missing commandId".into()),
    };

    match claim(id.clone()).await {
        Ok(true) => {}
        Ok(false) => return Disposition::Skipped,
        Err(e) => return Disposition::ClaimError(e.to_string()),
    }

    // Resolve the target; a malformed command still gets COMPLETED (failed) so it
    // doesn't sit claimed forever.
    let (complete_payload, disposition) = match connector_and_command(command) {
        Some((cid, cmd)) => {
            let outcome = match desktop_op_for(&cid, &cmd) {
                Some(Ok(op)) => desktop_execute(op, payload_of(command)).await,
                Some(Err(failure)) => Err(failure),
                None => execute(cid, cmd, payload_of(command)).await,
            };
            match outcome {
                Ok(result) => (done_payload(result), Disposition::Completed),
                Err(f) => (failed_payload(&f.code, &f.message), Disposition::Failed),
            }
        }
        None => (
            failed_payload("command_failed", "command missing connectorId/command"),
            Disposition::Failed,
        ),
    };

    match complete_with_retry(&complete, &id, complete_payload, max_complete_attempts).await {
        Ok(()) => disposition,
        Err(e) => Disposition::CompleteError(e),
    }
}

/// Retry `complete` on a soft (network) failure. A 409 is already swallowed as
/// success inside `complete_command`, so any error here is worth a retry.
async fn complete_with_retry<FK, FKf>(
    complete: &FK,
    id: &str,
    payload: Value,
    max_attempts: u32,
) -> Result<(), String>
where
    FK: Fn(String, Value) -> FKf,
    FKf: Future<Output = FlResult<()>>,
{
    let attempts = max_attempts.max(1);
    let mut last = String::new();
    for attempt in 1..=attempts {
        match complete(id.to_string(), payload.clone()).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                if attempt < attempts {
                    tokio::time::sleep(Duration::from_millis(200 * attempt as u64)).await;
                }
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formlogic_client::FlError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn cmd() -> Value {
        json!({
            "commandId": "c1",
            "connectorId": "aokie",
            "command": "call.operatorSpeak",
            "payload": { "message": "hello" }
        })
    }

    /// A `desktop_execute` stand-in for non-desktop tests: must never fire.
    fn refuse_desktop_ops(
        _op: DesktopOp,
        _payload: Value,
    ) -> impl Future<Output = Result<Value, RelayFailure>> {
        async { unreachable!("not a desktop op") }
    }

    #[test]
    fn helpers_extract_and_shape() {
        assert_eq!(command_id(&cmd()).as_deref(), Some("c1"));
        assert_eq!(connector_and_command(&cmd()), Some(("aokie".into(), "call.operatorSpeak".into())));
        assert_eq!(payload_of(&cmd()), json!({ "message": "hello" }));
        assert!(connector_and_command(&json!({ "connectorId": "" , "command": "x" })).is_none());
        assert_eq!(done_payload(json!({ "ok": true })), json!({ "status": "done", "result": { "ok": true } }));
        assert_eq!(
            failed_payload("connector_unavailable", "down"),
            json!({ "status": "failed", "error": { "code": "connector_unavailable", "message": "down" } })
        );
    }

    #[tokio::test]
    async fn claim_execute_complete_happy_path() {
        let claimed = Arc::new(AtomicUsize::new(0));
        let executed = Arc::new(AtomicUsize::new(0));
        let completed: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));

        let (c1, e1, k1) = (claimed.clone(), executed.clone(), completed.clone());
        let disp = process_one(
            &cmd(),
            3,
            move |id| {
                let c = c1.clone();
                async move {
                    assert_eq!(id, "c1");
                    c.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            move |cid, command, payload| {
                let e = e1.clone();
                async move {
                    assert_eq!(cid, "aokie");
                    assert_eq!(command, "call.operatorSpeak");
                    assert_eq!(payload, json!({ "message": "hello" }));
                    e.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({ "ok": true, "data": { "spoken": true } }))
                }
            },
            refuse_desktop_ops,
            move |id, payload| {
                let k = k1.clone();
                async move {
                    assert_eq!(id, "c1");
                    *k.lock().unwrap() = Some(payload);
                    Ok(())
                }
            },
        )
        .await;

        assert_eq!(disp, Disposition::Completed);
        assert!(disp.is_handled());
        assert_eq!(claimed.load(Ordering::SeqCst), 1);
        assert_eq!(executed.load(Ordering::SeqCst), 1);
        let body = completed.lock().unwrap().clone().unwrap();
        assert_eq!(body["status"], "done");
        assert_eq!(body["result"]["data"]["spoken"], json!(true));
    }

    #[tokio::test]
    async fn claim_409_skips_without_executing() {
        let executed = Arc::new(AtomicUsize::new(0));
        let e1 = executed.clone();
        let disp = process_one(
            &cmd(),
            3,
            |_id| async { Ok(false) }, // 409 → not ours
            move |_c, _cmd, _p| {
                let e = e1.clone();
                async move {
                    e.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
            refuse_desktop_ops,
            |_id, _p| async { Ok(()) },
        )
        .await;
        assert_eq!(disp, Disposition::Skipped);
        assert!(!disp.is_handled());
        assert_eq!(executed.load(Ordering::SeqCst), 0, "execute must not run when claim is lost");
    }

    #[tokio::test]
    async fn execution_failure_completes_as_failed() {
        let completed: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let k1 = completed.clone();
        let disp = process_one(
            &cmd(),
            3,
            |_id| async { Ok(true) },
            |_c, _cmd, _p| async {
                Err(RelayFailure { code: "connector_unavailable".into(), message: "plugin not running".into() })
            },
            refuse_desktop_ops,
            move |_id, payload| {
                let k = k1.clone();
                async move {
                    *k.lock().unwrap() = Some(payload);
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(disp, Disposition::Failed);
        assert!(disp.is_handled());
        let body = completed.lock().unwrap().clone().unwrap();
        assert_eq!(body["status"], "failed");
        assert_eq!(body["error"]["code"], "connector_unavailable");
    }

    #[tokio::test]
    async fn complete_retries_on_network_error_then_succeeds() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let a1 = attempts.clone();
        let disp = process_one(
            &cmd(),
            3,
            |_id| async { Ok(true) },
            |_c, _cmd, _p| async { Ok(json!({ "ok": true })) },
            refuse_desktop_ops,
            move |_id, _payload| {
                let a = a1.clone();
                async move {
                    // Fail the first two attempts (transient), succeed on the third.
                    let n = a.fetch_add(1, Ordering::SeqCst) + 1;
                    if n < 3 {
                        Err(FlError::Network("connection reset".into()))
                    } else {
                        Ok(())
                    }
                }
            },
        )
        .await;
        assert_eq!(disp, Disposition::Completed);
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn complete_gives_up_after_max_attempts() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let a1 = attempts.clone();
        let disp = process_one(
            &cmd(),
            2,
            |_id| async { Ok(true) },
            |_c, _cmd, _p| async { Ok(json!({ "ok": true })) },
            refuse_desktop_ops,
            move |_id, _payload| {
                let a = a1.clone();
                async move {
                    a.fetch_add(1, Ordering::SeqCst);
                    Err(FlError::Network("still down".into()))
                }
            },
        )
        .await;
        assert!(matches!(disp, Disposition::CompleteError(_)));
        assert_eq!(attempts.load(Ordering::SeqCst), 2, "exactly max_complete_attempts tries");
    }

    #[tokio::test]
    async fn claim_network_error_is_reported() {
        let disp = process_one(
            &cmd(),
            3,
            |_id| async { Err(FlError::Network("dns".into())) },
            |_c, _cmd, _p| async { Ok(Value::Null) },
            refuse_desktop_ops,
            |_id, _p| async { Ok(()) },
        )
        .await;
        assert!(matches!(disp, Disposition::ClaimError(_)));
    }

    #[tokio::test]
    async fn missing_id_is_a_claim_error() {
        let disp = process_one(
            &json!({ "connectorId": "aokie", "command": "call.hangup" }),
            3,
            |_id| async { Ok(true) },
            |_c, _cmd, _p| async { Ok(Value::Null) },
            refuse_desktop_ops,
            |_id, _p| async { Ok(()) },
        )
        .await;
        assert!(matches!(disp, Disposition::ClaimError(_)));
    }

    // ── Desktop-ops interception (plan §5.3) ─────────────────────────────────

    fn desktop_cmd(command: &str) -> Value {
        json!({
            "commandId": "ops-1",
            "connectorId": "desktop",
            "command": command,
            "payload": { "id": "llama-cpp" }
        })
    }

    #[test]
    fn desktop_op_for_routes_only_the_reserved_connector() {
        assert!(matches!(
            desktop_op_for("desktop", "services.list"),
            Some(Ok(DesktopOp::ServicesList))
        ));
        assert!(matches!(
            desktop_op_for("desktop", "plugins.health"),
            Some(Ok(DesktopOp::PluginsHealth))
        ));
        assert!(desktop_op_for("aokie", "services.list").is_none());
        assert!(desktop_op_for("desktop", "services.nuke").is_some_and(|r| r.is_err()));
    }

    #[tokio::test]
    async fn desktop_connector_intercepts_to_desktop_ops_not_the_gateway() {
        let gateway_calls = Arc::new(AtomicUsize::new(0));
        let ops_calls: Arc<std::sync::Mutex<Vec<(DesktopOp, Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let completed: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));

        let (g1, o1, k1) = (gateway_calls.clone(), ops_calls.clone(), completed.clone());
        let disp = process_one(
            &desktop_cmd("services.restart"),
            3,
            |_id| async { Ok(true) },
            move |_c, _cmd, _p| {
                let g = g1.clone();
                async move {
                    g.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
            move |op, payload| {
                let o = o1.clone();
                async move {
                    o.lock().unwrap().push((op, payload));
                    Ok(json!({ "ok": true }))
                }
            },
            move |_id, payload| {
                let k = k1.clone();
                async move {
                    *k.lock().unwrap() = Some(payload);
                    Ok(())
                }
            },
        )
        .await;

        assert_eq!(disp, Disposition::Completed);
        assert_eq!(gateway_calls.load(Ordering::SeqCst), 0, "the connector gateway must be bypassed");
        let ops = ops_calls.lock().unwrap().clone();
        assert_eq!(ops, vec![(DesktopOp::ServicesRestart, json!({ "id": "llama-cpp" }))]);
        let body = completed.lock().unwrap().clone().unwrap();
        assert_eq!(body["status"], "done");
        assert_eq!(body["result"], json!({ "ok": true }));
    }

    #[tokio::test]
    async fn unknown_desktop_op_is_a_typed_failure_without_side_effects() {
        let gateway_calls = Arc::new(AtomicUsize::new(0));
        let ops_calls = Arc::new(AtomicUsize::new(0));
        let completed: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));

        let (g1, o1, k1) = (gateway_calls.clone(), ops_calls.clone(), completed.clone());
        let disp = process_one(
            &desktop_cmd("plugins.uninstall"),
            3,
            |_id| async { Ok(true) },
            move |_c, _cmd, _p| {
                let g = g1.clone();
                async move {
                    g.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
            move |_op, _p| {
                let o = o1.clone();
                async move {
                    o.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
            move |_id, payload| {
                let k = k1.clone();
                async move {
                    *k.lock().unwrap() = Some(payload);
                    Ok(())
                }
            },
        )
        .await;

        assert_eq!(disp, Disposition::Failed, "the command is still completed — failed — so it doesn't sit claimed");
        assert_eq!(gateway_calls.load(Ordering::SeqCst), 0);
        assert_eq!(ops_calls.load(Ordering::SeqCst), 0, "no side effect for an unlisted op");
        let body = completed.lock().unwrap().clone().unwrap();
        assert_eq!(body["status"], "failed");
        assert_eq!(body["error"]["code"], "command_failed");
        assert!(
            body["error"]["message"].as_str().unwrap_or("").contains("unknown desktop op"),
            "got: {}",
            body["error"]["message"]
        );
    }
}
