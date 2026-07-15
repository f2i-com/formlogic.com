//! The FlowRuntime — FormLogic Desktop as the HEADLESS runtime for flows + the
//! Aokie receptionist (mission: "the receptionist runs within the Desktop app;
//! the web app only views state remotely").
//!
//! Two loops, both active only while a FormLogic account is linked:
//!   (a) EVENT loop — subscribes to the internal desktop event bus; on each
//!       plugin event it (1) applies the linked apps' `onConnectorEvent` scripts
//!       headless (`applogic`, the raw record writes the web app does), and (2)
//!       fans out to matching flow BINDINGS: evaluate condition in QuickJS,
//!       reserve the run with the SAME idempotency key the browser uses
//!       (`flow:<binding>:<event key>` — the UNIQUE ledger makes desktop-vs-
//!       browser execution exactly-once), execute, apply outputActions, complete.
//!   (b) CLAIM loop — every 20 s polls queued runs (form.submitted bindings,
//!       ctx.flows.run intents), claims runtime `desktop` exactly-once (409 =
//!       another runtime won → skip), executes from the stored snapshot, completes.
//!
//! Also: registers the `flow.run` plugin-RPC handler, drives the desktop-
//! connection heartbeat (remote-viewer presence, docs §14), and exposes a status
//! snapshot for `GET /api/desktop/info` + the window badge.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::flows::applogic::{self, AppLogicApp};
use crate::flows::quickjs;
use crate::flows::relay;
use crate::flows::runner::{self, FlowOutcome, RunDeps, RunOptions};
use crate::flows::work_ledger::{
    BindingState, ReceiveOutcome, StageOutcome, WorkLedger, WorkStatus,
};
use crate::flows::selectors::{
    build_inputs, interpolate_template, resolve_deep, resolve_selector, scope_to_context,
    when_passes, SelectorScope,
};
use crate::formlogic_client::{FlError, FormLogicClient, FormLogicConfig};
use crate::plugins::registry::{PluginHost, PluginRpcFuture, PluginRpcHandler};
use crate::plugins::rpc::RpcErrorObj;
use crate::services::registry::RegistryHandle;

/// How often the claim loop polls for claimable queued runs (docs §10).
pub const CLAIM_POLL_INTERVAL: Duration = Duration::from_secs(20);
/// Cached flows/bindings/app-logic snapshot TTL.
const SNAPSHOT_TTL: Duration = Duration::from_secs(60);
/// Heartbeat cadence for the desktop-connection registry (docs §14: fresh < 90 s).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(45);
/// How long a per-correlation event queue may sit idle before its worker
/// retires (FL-002) — comfortably past any real call's inter-event gaps.
const EVENT_QUEUE_IDLE: Duration = Duration::from_secs(120);
const CLAIM_BATCH_LIMIT: u32 = 10;
const MAX_RETRY_ATTEMPTS: u32 = 5;
const RETRY_BASE_DELAY_MS: u64 = 500;
/// How many times the relay retries `complete` after a side effect already ran
/// (a transient blip must not strand the enqueuing web member's result).
const RELAY_COMPLETE_ATTEMPTS: u32 = 3;
/// Bound on the in-process event dedupe set + recent-run cache.
const SEEN_CAP: usize = 2048;
const RUN_CACHE_CAP: usize = 256;

/// The runtime's visible state (GET /api/desktop/info extension + window badge).
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRuntimeStatus {
    /// A FormLogic account (base URL + key) is configured.
    pub linked: bool,
    /// The configured base URL (never the key).
    pub base_url: Option<String>,
    /// Result of the last connectivity check / API call (`None` until first use).
    pub last_ok: Option<bool>,
    pub last_event_at: Option<String>,
    pub last_claim_at: Option<String>,
    pub runs_executed: u64,
    pub records_written: u64,
    pub errors: u64,
    pub last_error: Option<String>,
    /// Remote command relay (connector:relay): whether the last long-poll
    /// succeeded (`None` until first poll), how many commands this runtime has
    /// claimed + completed, and when the last one finished.
    pub relay_poll_ok: Option<bool>,
    pub commands_handled: u64,
    pub last_command_at: Option<String>,
    /// Durable event-work ledger (audit CROSS-EVENT-001): events whose
    /// app-logic/binding stages are still unfinished, and dead-lettered
    /// events awaiting operator redrive (`POST /api/flows/event-work/redrive`).
    pub event_work_pending: u64,
    pub event_work_dead: u64,
    /// WORK-DUR-001 item 5: why the ledger's last durable append failed
    /// (disk full / EIO / read-only dir), `None` when healthy. While set,
    /// new events are NOT claimed — receipts hold them for the reconciler.
    pub event_work_blocked: Option<String>,
}

/// One entry in the bounded recent-error ring (`GET /api/flows/runtime-errors`).
/// Consecutive repeats of the SAME message collapse into one entry with a
/// bumped `count` + refreshed timestamps — a flaky relay poll then reads as
/// one line ×N instead of drowning the ring.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorEntry {
    /// RFC3339 instant of the FIRST occurrence in this streak.
    pub first_at: String,
    /// RFC3339 instant of the LATEST occurrence.
    pub last_at: String,
    pub message: String,
    pub count: u64,
}

/// Ring capacity — enough history to diagnose "what were those 380 errors"
/// without growing unbounded (repeats collapse, so this covers a lot).
const RECENT_ERRORS_CAP: usize = 50;

struct Inner {
    config: FormLogicConfig,
    client: Option<Arc<FormLogicClient>>,
}

struct CachedSnapshot {
    flows: Vec<Value>,
    bindings: Vec<Value>,
    applogic: Vec<Value>,
    /// connector id → assigned app id (audit INT-004/C-13). Empty on servers
    /// that predate the endpoint — routing then falls back per-connector to
    /// "single candidate app" / legacy unrestricted.
    assignments: HashMap<String, String>,
    fetched_at: Instant,
}

/// Which app may handle a connector's event (audit INT-004/C-13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectorRouting {
    /// No connector on the envelope (or no routing metadata at all): the
    /// pre-assignment behaviour.
    Unrestricted,
    /// Exactly this app — explicitly assigned, or the single candidate.
    App(String),
    /// A connector event no app holds grants for: app-logic is skipped;
    /// app-less workspace flows may still bind.
    NoCandidates,
    /// Two or more candidate apps and no assignment: the event must be
    /// REJECTED (visibly), never processed by both.
    Ambiguous(Vec<String>),
}

impl ConnectorRouting {
    /// May this app's `onConnectorEvent` bundle run?
    fn allows_app(&self, app_id: Option<&str>) -> bool {
        match self {
            ConnectorRouting::Unrestricted => true,
            ConnectorRouting::App(a) => app_id == Some(a.as_str()),
            ConnectorRouting::NoCandidates | ConnectorRouting::Ambiguous(_) => false,
        }
    }

    /// May a flow with this `appId` fire? App-less (workspace) flows always may.
    fn allows_flow(&self, flow_app_id: Option<&str>) -> bool {
        match (self, flow_app_id) {
            (ConnectorRouting::Unrestricted, _) => true,
            (_, None) => true,
            (ConnectorRouting::App(a), Some(f)) => f == a,
            (ConnectorRouting::NoCandidates | ConnectorRouting::Ambiguous(_), Some(_)) => false,
        }
    }
}

/// Decide the routing for `connector` from the explicit assignments and the
/// app-logic bundles' `connectors` metadata. Legacy servers (no assignments
/// AND no `connectors` field on any bundle) yield [`ConnectorRouting::Unrestricted`]
/// so an old backend keeps the old behaviour.
fn route_connector_event(
    connector: &str,
    assignments: &HashMap<String, String>,
    bundles: &[Value],
) -> ConnectorRouting {
    if let Some(app) = assignments.get(connector) {
        return ConnectorRouting::App(app.clone());
    }
    if assignments.is_empty() && bundles.iter().all(|b| b.get("connectors").is_none()) {
        return ConnectorRouting::Unrestricted;
    }
    let candidates: Vec<String> = bundles
        .iter()
        .filter(|b| {
            b.get("connectors")
                .and_then(Value::as_array)
                .is_some_and(|cs| cs.iter().any(|c| c.as_str() == Some(connector)))
        })
        .filter_map(|b| {
            b.get("app")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    match candidates.len() {
        0 => ConnectorRouting::NoCandidates,
        1 => ConnectorRouting::App(candidates.into_iter().next().unwrap()),
        _ => ConnectorRouting::Ambiguous(candidates),
    }
}

/// Typed outcome of one binding execution (audit CROSS-EVENT-001) — recorded
/// in the durable work ledger instead of being silently dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BindingRunOutcome {
    /// Executed; the run row (success or flow-level failure) is durable server-side.
    Done,
    /// Deliberately not executed (condition false, duplicate reservation,
    /// vanished flow, routing) — terminal, with the reason recorded.
    Skipped(String),
    /// Transient failure before anything durable happened — retry with backoff.
    Retryable(String),
    /// Deterministic rejection — dead-lettered, visible, manually redrivable.
    Permanent(String),
}

/// The desktop flow runtime. Cheaply cloneable via `Arc`.
pub struct FlowRuntime {
    host: Arc<PluginHost>,
    registry: Option<RegistryHandle>,
    http: reqwest::Client,
    instance_id: String,
    device_name: String,
    inner: RwLock<Inner>,
    status: Mutex<FlowRuntimeStatus>,
    /// Bounded, repeat-collapsing history behind the bare `errors` counter,
    /// so the operator can INSPECT what went wrong (and clear it) instead of
    /// staring at "380 errors" + one last-error string.
    recent_errors: Mutex<VecDeque<RuntimeErrorEntry>>,
    snapshot: Mutex<Option<CachedSnapshot>>,
    /// Per-app in-process logic storage (dedupe markers for onConnectorEvent).
    applogic_storage: Mutex<HashMap<String, Map<String, Value>>>,
    /// In-process IN-FLIGHT guard (audit CROSS-EVENT-001): an entry means a
    /// task is driving that key RIGHT NOW (or it reached a terminal state this
    /// session — terminal entries stay as a fast dedupe in front of the
    /// ledger). Non-terminal keys are RELEASED when their drive pass ends, so
    /// the retry pump can re-enter them — the old semantics ("seen once =
    /// never again this session") lost every event that arrived before the
    /// client/snapshot was ready.
    seen: Mutex<(VecDeque<String>, HashSet<String>)>,
    /// Recent run outcomes for `GET /api/flows/runs/{id}` (inline + slug runs).
    run_cache: Mutex<(VecDeque<String>, HashMap<String, Value>)>,
    /// Processing-complete markers (audit FL-001): kept in sync with the work
    /// ledger's terminal states for downgrade compatibility + the one-time
    /// import of pre-ledger receipts.
    processed: Option<Arc<crate::plugins::receipts::EventReceipts>>,
    /// Durable per-event work ledger (audit CROSS-EVENT-001):
    /// received → app-logic → planned bindings → completed | dead, with
    /// bounded retries, a redrivable DLQ, and cross-session recovery.
    work: Option<Arc<WorkLedger>>,
    /// The serial event queues (FL-002 ordering) — stored so the retry pump,
    /// recovery sweep, and redrive re-enter events through the SAME pipeline.
    event_queues: Mutex<Option<Arc<crate::flows::serial_queues::SerialQueues<Value>>>>,
    /// When THIS dispatcher came up — the legacy-receipt import only considers
    /// receipts from earlier sessions (live envelopes enter the ledger directly).
    session_start: chrono::DateTime<chrono::Utc>,
    /// At-rest sealer for the journals' PII payloads (DATA-PRIV-001); `None`
    /// only when every key store failed (loudly logged, plaintext fallback).
    journal_crypto: Option<Arc<crate::journal_crypto::JournalCrypto>>,
}

/// True iff a redirect hop from `origin` (the first URL in the chain — i.e. the URL that was
/// already allow-list-checked by `runner::is_allowed_flow_url`/`is_loopback_url` before the
/// request was sent) to `target` (the next hop reqwest is about to follow) stays within the
/// SAME origin (scheme + host + port). Deliberately does NOT special-case loopback here: the
/// allow-list intentionally treats "bare" nodes (plain `http_request`, `llm_chat`) differently
/// from "service" nodes (`browser_action`/`image_gen`/`stt_transcribe`/`tts_speak`, and the
/// `service`-branch of `http_request`) — the former may only reach the FormLogic base URL, the
/// latter may also reach loopback. That distinction is made once, at the original URL, based on
/// which node handler is calling; a redirect-time check has no way to know which handler
/// initiated the request, so re-granting loopback to every redirect (regardless of origin) would
/// silently undo the split for bare nodes. Requiring the redirect to stay same-origin as
/// whatever was already validated preserves both halves of the split with no extra state.
fn redirect_target_allowed(origin: &reqwest::Url, target: &reqwest::Url) -> bool {
    origin.scheme() == target.scheme()
        && origin.host_str() == target.host_str()
        && origin.port_or_known_default() == target.port_or_known_default()
}

/// Redirect policy for the shared flows HTTP client. Without this, reqwest's default policy
/// (follow up to 10 hops, resending the full body and all headers except `Authorization` on a
/// cross-origin hop) would let an already allow-listed origin — the FormLogic base URL, or a
/// local desktop service the endpoint allow-list resolved to — silently exfiltrate a flow's
/// request body to an attacker-chosen host via a single HTTP redirect response, since
/// `is_allowed_flow_url`/`is_loopback_url` are only ever checked once, against the pre-redirect
/// URL (see every call site in `runner.rs`). Mirrors the re-validate-every-hop defense the team
/// already applies to model downloads (`services/downloads.rs`), narrowed here to "stay on the
/// origin you started on" since that's all the flow allow-list ever legitimately grants.
fn flow_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.stop();
        }
        let allowed = attempt
            .previous()
            .first()
            .is_some_and(|origin| redirect_target_allowed(origin, attempt.url()));
        if allowed {
            attempt.follow()
        } else {
            attempt.error("redirect left the allow-listed origin")
        }
    })
}

/// Which receipt-journal lines the legacy-import pass should adopt into the
/// work ledger (audit CROSS-EVENT-001): journaled in a PREVIOUS session
/// (`receivedAt < session_start` — live envelopes enter the ledger directly)
/// and never marked processed. There is deliberately NO age cutoff — the
/// audit's rule is that unfinished work is never age-discarded; staleness is
/// handled downstream by typed rejections (e.g. call-scoped reservations
/// expire server-side), which land visibly in the ledger instead of a silent
/// drop. Deduped by key, oldest first, so replays land in arrival order.
fn recovery_candidates(
    lines: Vec<Value>,
    is_processed: &dyn Fn(&str) -> bool,
    session_start: chrono::DateTime<chrono::Utc>,
) -> Vec<(String, Value)> {
    let mut seen = HashSet::new();
    let mut out: Vec<(chrono::DateTime<chrono::Utc>, String, Value)> = Vec::new();
    for v in lines {
        let Some(key) = v.get("key").and_then(Value::as_str) else { continue };
        let Some(at) = v
            .get("receivedAt")
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&chrono::Utc))
        else {
            continue;
        };
        if at >= session_start || is_processed(key) || !seen.insert(key.to_string()) {
            continue;
        }
        let Some(event) = v.get("event").filter(|e| e.is_object()).cloned() else { continue };
        out.push((at, key.to_string(), event));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, k, e)| (k, e)).collect()
}

/// ROUTE-001: the per-install desktop instance id, persisted at
/// `<dir>/desktop-instance.json`. Loaded when present and well-formed
/// (the server's `^[A-Za-z0-9._-]+$` ≤128 shape); otherwise a fresh
/// `desktop-<uuid>` is generated and written atomically (tmp + rename).
/// A write failure degrades to the generated id for this session only —
/// loudly, since an unstable id makes this machine untargetable.
fn load_or_create_instance_id(dir: &std::path::Path) -> String {
    let path = dir.join("desktop-instance.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Some(id) = serde_json::from_str::<Value>(&text)
            .ok()
            .as_ref()
            .and_then(|v| v.get("instanceId"))
            .and_then(Value::as_str)
        {
            if !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            {
                return id.to_string();
            }
        }
        eprintln!("[flows] desktop-instance.json is malformed — minting a fresh instance id");
    }
    let id = format!("desktop-{}", uuid::Uuid::new_v4().simple());
    let body = serde_json::to_string_pretty(&json!({
        "instanceId": id,
        "createdAt": chrono::Utc::now().to_rfc3339(),
    }))
    .unwrap_or_default();
    let tmp = dir.join("desktop-instance.json.tmp");
    let persisted = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&tmp, body.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(e) = persisted {
        eprintln!(
            "[flows] could not persist the desktop instance id ({e}) — this machine's id \
             will CHANGE on restart, which breaks command targeting until fixed"
        );
    }
    id
}

impl FlowRuntime {
    pub fn new(
        host: Arc<PluginHost>,
        registry: Option<RegistryHandle>,
        config: FormLogicConfig,
    ) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(flow_redirect_policy())
            .build()
            .unwrap_or_default();
        let client = FormLogicClient::new(&config).map(Arc::new);
        let linked = client.is_some();
        let base_url = if config.base_url.trim().is_empty() { None } else { Some(config.base_url.clone()) };
        // ROUTE-001: the instance id is STABLE per install (persisted beside the
        // journals), not per process. It names this machine in the desktop-connection
        // registry, in relay claims/completions, and as the TARGET of routed commands
        // — a fresh id every launch would make the machine untargetable and litter
        // the registry with one ghost row per restart.
        let instance_id = load_or_create_instance_id(&host.plugin_data_root);
        let device_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "FormLogic Desktop".to_string());
        // Audit FL-001: the processed-marker journal lives beside the per-plugin
        // receipt journals. If it can't open, recovery is disabled (logged), but
        // live processing continues — the marker is an extra, not a gate.
        let processed = match crate::plugins::receipts::EventReceipts::open(
            host.plugin_data_root.join("host-event-processed.jsonl"),
        ) {
            Ok(p) => {
                // First run with markers (migration): grandfather every receipt
                // journaled before the feature existed — those events were
                // handled by the pre-marker code, and replaying them would
                // predate their effect keys (i.e. duplicate real records).
                if p.is_empty() {
                    let mut grandfathered = 0usize;
                    if let Ok(dirs) = std::fs::read_dir(&host.plugin_data_root) {
                        for entry in dirs.flatten() {
                            let path = entry.path().join("host-event-receipts.jsonl");
                            let Ok(text) = std::fs::read_to_string(&path) else { continue };
                            for line in text.lines() {
                                if let Some(key) = serde_json::from_str::<Value>(line)
                                    .ok()
                                    .as_ref()
                                    .and_then(|v| v.get("key"))
                                    .and_then(Value::as_str)
                                {
                                    if matches!(
                                        p.record(key, &Value::Null),
                                        Ok(crate::plugins::receipts::ReceiptOutcome::New)
                                    ) {
                                        grandfathered += 1;
                                    }
                                }
                            }
                        }
                    }
                    if grandfathered > 0 {
                        eprintln!("[flows] crash recovery: grandfathered {grandfathered} pre-marker receipt(s) as processed");
                    }
                }
                Some(Arc::new(p))
            }
            Err(e) => {
                eprintln!("[flows] processed-marker journal unavailable ({e}) — crash recovery disabled");
                None
            }
        };
        // The durable work ledger (audit CROSS-EVENT-001). If it can't open,
        // live processing continues with the legacy best-effort semantics
        // (in-session dedupe only) — loudly, because durability is off.
        // Payloads sealed at rest + env-tunable terminal retention (DATA-PRIV-001).
        let journal_crypto = crate::journal_crypto::shared(&host.plugin_data_root);
        let work = match WorkLedger::open_with(
            host.plugin_data_root.join("host-event-work.jsonl"),
            journal_crypto.clone(),
            crate::flows::work_ledger::Retention::from_env(),
        ) {
            Ok(w) => Some(Arc::new(w)),
            Err(e) => {
                eprintln!("[flows] event work ledger unavailable ({e}) — durable event recovery disabled");
                None
            }
        };
        Arc::new(Self {
            host,
            registry,
            http,
            instance_id,
            device_name,
            inner: RwLock::new(Inner { config, client }),
            status: Mutex::new(FlowRuntimeStatus { linked, base_url, ..Default::default() }),
            recent_errors: Mutex::new(VecDeque::new()),
            snapshot: Mutex::new(None),
            applogic_storage: Mutex::new(HashMap::new()),
            seen: Mutex::new((VecDeque::new(), HashSet::new())),
            run_cache: Mutex::new((VecDeque::new(), HashMap::new())),
            processed,
            work,
            event_queues: Mutex::new(None),
            session_start: chrono::Utc::now(),
            journal_crypto,
        })
    }

    /// Start the event + claim + heartbeat loops and register the plugin
    /// `flow.run` RPC handler. Idempotent-safe to call once at boot.
    pub fn start(self: &Arc<Self>) {
        self.host.set_rpc_handler(Arc::new(RpcBridge(self.clone())));
        // Event loop. FL-002 (audit C-04): events sharing a correlationId —
        // one phone call — are processed strictly in arrival order through a
        // per-key serial queue; separate correlations run concurrently. The
        // subscriber's loop body is now just an enqueue, so the broadcast
        // receiver realistically never lags — and when it does, it is LOGGED,
        // not silently skipped.
        {
            let rt = self.clone();
            let mut rx = rt.host.events().subscribe();
            let handler_rt = self.clone();
            let queues = crate::flows::serial_queues::SerialQueues::new(
                EVENT_QUEUE_IDLE,
                Arc::new(move |env: Value| {
                    let rt = handler_rt.clone();
                    Box::pin(async move { rt.on_event(env).await })
                        as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
                }),
            );
            // The retry pump / recovery sweep / DLQ redrive re-enter events
            // through these SAME per-correlation queues (FL-002 ordering).
            *self.event_queues.lock().unwrap_or_else(|e| e.into_inner()) = Some(queues.clone());
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            if let Ok(env) = serde_json::from_str::<Value>(&ev.json) {
                                let key = env
                                    .get("correlationId")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("__uncorrelated__")
                                    .to_string();
                                queues.enqueue(&key, env);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            rt.note_error(format!(
                                "event bus lagged — the dispatcher missed {n} event(s)"
                            ));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        // Claim loop.
        {
            let rt = self.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(CLAIM_POLL_INTERVAL);
                loop {
                    tick.tick().await;
                    rt.claim_sweep().await;
                }
            });
        }
        // Heartbeat loop (best-effort remote-viewer presence).
        {
            let rt = self.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(HEARTBEAT_INTERVAL);
                loop {
                    tick.tick().await;
                    rt.heartbeat().await;
                }
            });
        }
        // Remote command-relay loop (long-poll → claim → execute → complete).
        {
            let rt = self.clone();
            tokio::spawn(async move { rt.relay_loop().await });
        }
        // Crash-recovery sweep (audit CROSS-EVENT-001): import pre-ledger
        // receipts once, then re-drive EVERY unfinished ledger event from any
        // prior session — app-logic AND bindings, no age discard.
        {
            let rt = self.clone();
            tokio::spawn(async move { rt.recovery_sweep().await });
        }
        // Retry pump (audit CROSS-EVENT-001): re-drives events whose retry
        // backoff has elapsed (transient API/snapshot/link failures), and
        // compacts the ledger's journal when it grows past its threshold OR
        // when terminal records age past retention. Hourly, the receipt +
        // processed-marker journals are retention-swept too, so a low-volume
        // install purges PII on the clock (DATA-PRIV-001 item 4).
        // Receipt accountability guard (WORK-DUR-001 item 6): rotation and
        // retention may only drop a receipt once the work ledger owns its
        // event (any status) or a processed marker exists — a receipt can be
        // the ONLY durable copy of an event we already acked to the plugin.
        if let Some(work) = self.work.clone() {
            let processed = self.processed.clone();
            self.host.set_receipts_guard(Arc::new(move |key: &str| {
                work.get(key).is_some()
                    || processed.as_ref().is_some_and(|p| p.contains(key))
            }));
        }
        {
            let rt = self.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(30));
                let mut last_receipt_sweep = std::time::Instant::now();
                let mut ticks: u64 = 0;
                loop {
                    tick.tick().await;
                    ticks += 1;
                    let now = chrono::Utc::now();
                    if let Some(work) = rt.work.clone() {
                        for (_key, envelope) in work.due_retries(now) {
                            rt.enqueue_envelope(envelope);
                        }
                        work.maybe_compact(now);
                    }
                    // Continuous reconciliation (WORK-DUR-001 item 6), every
                    // 5 minutes: import unaccounted receipts + re-drive
                    // stalled pending rows — the startup sweep, kept live.
                    if ticks % 10 == 0 {
                        rt.reconcile_pass();
                    }
                    if last_receipt_sweep.elapsed() >= Duration::from_secs(3600) {
                        last_receipt_sweep = std::time::Instant::now();
                        let cutoff = now - crate::plugins::receipts::default_retention();
                        let removed = rt.host.sweep_receipts(cutoff);
                        if let Some(p) = &rt.processed {
                            if let Err(e) = p.retain_since(cutoff) {
                                eprintln!("[flows] processed-marker sweep failed: {e}");
                            }
                        }
                        if removed > 0 {
                            eprintln!("[flows] retention sweep aged out {removed} receipt(s)");
                        }
                    }
                }
            });
        }
    }

    /// Re-enter an envelope through the per-correlation serial queues (the
    /// same pipeline live events use), falling back to a direct task when the
    /// queues aren't up yet.
    fn enqueue_envelope(self: &Arc<Self>, envelope: Value) {
        let key = envelope
            .get("correlationId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("__uncorrelated__")
            .to_string();
        let queues = self
            .event_queues
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        match queues {
            Some(q) => q.enqueue(&key, envelope),
            None => {
                let rt = self.clone();
                tokio::spawn(async move { rt.on_event(envelope).await });
            }
        }
    }

    // ── crash recovery (audit CROSS-EVENT-001) ─────────────────────────────────

    /// Recover ALL unfinished event work across every prior session.
    ///
    /// 1. One-time import: receipts journaled (and acked to the plugin) before
    ///    the work ledger existed, but never marked processed, become pending
    ///    ledger rows. No age discard — staleness is handled by typed
    ///    downstream rejections, not silent drops.
    /// 2. Every pending ledger event (any prior session, any stage) is
    ///    re-driven through the SAME serial pipeline as live events — the
    ///    ledger's stage flags skip whatever already finished, so app-logic
    ///    AND every planned binding recover exactly once. There is no need to
    ///    wait for a linked client here: readiness failures reschedule with
    ///    backoff (without consuming attempts) and the retry pump re-drives.
    async fn recovery_sweep(self: Arc<Self>) {
        let Some(work) = self.work.clone() else { return };
        let imported = self.import_unaccounted_receipts(self.session_start).len();
        if imported > 0 {
            eprintln!("[flows] crash recovery: imported {imported} unaccounted receipt(s) as pending event work");
        }

        let pending = work.all_pending();
        if pending.is_empty() {
            return;
        }
        eprintln!(
            "[flows] crash recovery: re-driving {} unfinished event(s) from prior sessions (app-logic + planned bindings)",
            pending.len()
        );
        for (_key, envelope) in pending {
            self.enqueue_envelope(envelope);
        }
    }

    /// Import receipts journaled (and acked to the plugin) but not yet owned
    /// by the work ledger — the ack→ledger crash window, a lagged bus
    /// delivery, or a `receive()` that failed on a blocked ledger. Only
    /// receipts older than `cutoff` are considered (live deliveries are
    /// racing the bus; the startup sweep passes session start, the periodic
    /// reconciler a short grace). Returns the newly imported events.
    fn import_unaccounted_receipts(&self, cutoff: chrono::DateTime<chrono::Utc>) -> Vec<(String, Value)> {
        let Some(work) = self.work.clone() else { return Vec::new() };
        let Some(processed) = self.processed.clone() else { return Vec::new() };
        // Normalise each receipt line to {key, receivedAt, event}: sealed
        // payloads (`envEnc`, DATA-PRIV-001) are opened here — recovery is
        // exactly the read path the sealed copy exists for.
        let crypto = self.journal_crypto.as_deref();
        let mut lines: Vec<Value> = Vec::new();
        if let Ok(dirs) = std::fs::read_dir(&self.host.plugin_data_root) {
            for entry in dirs.flatten() {
                let path = entry.path().join("host-event-receipts.jsonl");
                let Ok(raw) = std::fs::read(&path) else { continue };
                let text = String::from_utf8_lossy(&raw);
                lines.extend(text.lines().filter_map(|l| {
                    let mut v = serde_json::from_str::<Value>(l).ok()?;
                    if let Some(env) = crate::plugins::receipts::line_envelope(&v, crypto) {
                        v["event"] = env;
                    }
                    Some(v)
                }));
            }
        }
        let mut imported = Vec::new();
        for (key, envelope) in recovery_candidates(
            lines,
            &|k| processed.contains(k) || work.get(k).is_some(),
            cutoff,
        ) {
            if matches!(work.receive(&key, &envelope), Ok(ReceiveOutcome::New)) {
                imported.push((key, envelope));
            }
        }
        imported
    }

    /// Continuous reconciliation (WORK-DUR-001 item 6): the startup sweep's
    /// guarantees, kept LIVE. Unaccounted receipts past a short grace are
    /// imported and driven; pending rows with no retry schedule that have sat
    /// past the grace (crash after claim, failed retry append, dropped bus
    /// delivery) are re-driven. The in-flight guard and durable stage flags
    /// make every re-drive idempotent.
    fn reconcile_pass(self: &Arc<Self>) {
        let now = chrono::Utc::now();
        for (key, envelope) in self.import_unaccounted_receipts(now - chrono::Duration::seconds(120)) {
            eprintln!("[flows] reconciler: imported unaccounted receipt {key}");
            self.enqueue_envelope(envelope);
        }
        if let Some(work) = self.work.clone() {
            for (key, envelope) in work.stale_pending(now, chrono::Duration::seconds(300)) {
                if !self.is_inflight(&key) {
                    eprintln!("[flows] reconciler: re-driving stalled pending event {key}");
                    self.enqueue_envelope(envelope);
                }
            }
        }
    }

    // ── config ────────────────────────────────────────────────────────────────

    /// Live client, if an account is linked.
    fn client(&self) -> Option<Arc<FormLogicClient>> {
        self.inner.read().ok().and_then(|i| i.client.clone())
    }

    pub fn config(&self) -> FormLogicConfig {
        self.inner.read().map(|i| i.config.clone()).unwrap_or(FormLogicConfig { base_url: String::new(), api_key: String::new() })
    }

    /// Reconfigure the linked account (SettingsPanel "Save"). Rebuilds the client
    /// and invalidates the cache so the next sweep uses the new key.
    pub fn reconfigure(&self, config: FormLogicConfig) {
        let client = FormLogicClient::new(&config).map(Arc::new);
        let linked = client.is_some();
        let base = if config.base_url.trim().is_empty() { None } else { Some(config.base_url.clone()) };
        if let Ok(mut i) = self.inner.write() {
            i.config = config;
            i.client = client;
        }
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if let Ok(mut s) = self.status.lock() {
            s.linked = linked;
            s.base_url = base;
            s.last_ok = None;
        }
    }

    /// Cheap authenticated connectivity probe for the "Test connection" button.
    pub async fn test_connection(&self) -> Result<(), String> {
        match self.client() {
            Some(c) => {
                let r = c.test_connection().await.map_err(|e| e.to_string());
                if let Ok(mut s) = self.status.lock() {
                    s.last_ok = Some(r.is_ok());
                    if let Err(e) = &r {
                        s.last_error = Some(e.clone());
                    }
                }
                if let Err(e) = &r {
                    self.record_recent_error(e.clone());
                }
                r
            }
            None => Err("FormLogic Cloud is not configured (set the base URL + API key)".into()),
        }
    }

    pub fn status(&self) -> FlowRuntimeStatus {
        let mut s = self.status.lock().map(|s| s.clone()).unwrap_or_default();
        if let Some(work) = &self.work {
            let (pending, dead) = work.counts();
            s.event_work_pending = pending;
            s.event_work_dead = dead;
            s.event_work_blocked = work.blocked();
        }
        s
    }

    /// The event-work DLQ + counts (`GET /api/flows/event-work`).
    pub fn event_work_debug(&self) -> Value {
        match &self.work {
            Some(work) => {
                let (pending, dead) = work.counts();
                json!({
                    "available": true,
                    "pending": pending,
                    "dead": dead,
                    "deadLetters": work.dead_letters(),
                })
            }
            None => json!({ "available": false }),
        }
    }

    /// Operator redrive (`POST /api/flows/event-work/redrive`): dead → pending
    /// with a fresh attempt budget, re-entered through the live pipeline.
    /// `None` redrives the whole dead set. Returns how many events revived.
    pub fn redrive_event_work(self: &Arc<Self>, key: Option<&str>) -> usize {
        let Some(work) = &self.work else { return 0 };
        let revived = work.redrive(key);
        let n = revived.len();
        for (k, envelope) in revived {
            self.release_inflight(&k); // drop the terminal dedupe entry
            self.enqueue_envelope(envelope);
        }
        n
    }

    fn base_url(&self) -> String {
        self.inner.read().map(|i| i.config.base_url.clone()).unwrap_or_default()
    }

    fn note_ok(&self) {
        if let Ok(mut s) = self.status.lock() {
            s.last_ok = Some(true);
        }
    }
    fn note_error(&self, msg: impl Into<String>) {
        let msg = msg.into();
        if let Ok(mut s) = self.status.lock() {
            s.errors += 1;
            s.last_error = Some(msg.clone());
            s.last_ok = Some(false);
        }
        self.record_recent_error(msg);
    }

    /// Append to the bounded inspect ring, collapsing consecutive repeats of
    /// the same message into one entry with a bumped count.
    fn record_recent_error(&self, msg: String) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        if let Ok(mut ring) = self.recent_errors.lock() {
            if let Some(last) = ring.back_mut() {
                if last.message == msg {
                    last.count += 1;
                    last.last_at = now;
                    return;
                }
            }
            ring.push_back(RuntimeErrorEntry {
                first_at: now.clone(),
                last_at: now,
                message: msg,
                count: 1,
            });
            while ring.len() > RECENT_ERRORS_CAP {
                ring.pop_front();
            }
        }
    }

    /// The inspectable error history (newest last), for the desktop UI.
    pub fn recent_errors(&self) -> Vec<RuntimeErrorEntry> {
        self.recent_errors
            .lock()
            .map(|r| r.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Operator "Clear errors": zero the counter, drop last_error and the
    /// history ring. Purely diagnostic state — nothing operational resets.
    pub fn clear_errors(&self) {
        if let Ok(mut s) = self.status.lock() {
            s.errors = 0;
            s.last_error = None;
        }
        if let Ok(mut ring) = self.recent_errors.lock() {
            ring.clear();
        }
    }
    fn note_records(&self, n: u64) {
        if n == 0 {
            return;
        }
        if let Ok(mut s) = self.status.lock() {
            s.records_written += n;
        }
    }
    fn note_run(&self) {
        if let Ok(mut s) = self.status.lock() {
            s.runs_executed += 1;
        }
    }
    fn note_relay_poll(&self, ok: bool) {
        if let Ok(mut s) = self.status.lock() {
            s.relay_poll_ok = Some(ok);
        }
    }
    fn note_command(&self) {
        if let Ok(mut s) = self.status.lock() {
            s.commands_handled += 1;
            s.last_command_at = Some(now_iso());
        }
    }

    // ── snapshot cache ──────────────────────────────────────────────────────────

    /// Fetch (cached, 60 s TTL) the owner's flows + bindings + app-logic bundles.
    async fn ensure_snapshot(&self, client: &FormLogicClient) -> bool {
        let fresh = self
            .snapshot
            .lock()
            .map(|g| g.as_ref().map(|s| s.fetched_at.elapsed() < SNAPSHOT_TTL).unwrap_or(false))
            .unwrap_or(false);
        if fresh {
            return true;
        }
        let flows = client.list_flows(None, false).await;
        let bindings = client.list_bindings(None).await;
        let applogic = client.app_logic(None).await;
        // Best-effort (audit INT-004): a server without the endpoint just
        // means no explicit assignments — never fail the whole snapshot.
        let assignments = client
            .connector_assignments()
            .await
            .unwrap_or_default();
        match (flows, bindings, applogic) {
            (Ok(flows), Ok(bindings), Ok(applogic)) => {
                self.note_ok();
                *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = Some(CachedSnapshot {
                    flows,
                    bindings,
                    applogic,
                    assignments,
                    fetched_at: Instant::now(),
                });
                true
            }
            (a, b, c) => {
                let e = a.err().or(b.err()).or(c.err()).map(|e| e.to_string()).unwrap_or_default();
                self.note_error(format!("snapshot fetch failed: {e}"));
                // Serve a stale snapshot if we have one.
                self.snapshot.lock().map(|g| g.is_some()).unwrap_or(false)
            }
        }
    }

    fn with_snapshot<T>(&self, f: impl FnOnce(&CachedSnapshot) -> T) -> Option<T> {
        self.snapshot.lock().ok().and_then(|g| g.as_ref().map(f))
    }

    /// The last recorded health report for a plugin (audit INT-006): lets
    /// `/api/desktop/info` surface the aokie plugin's TRUTHFUL health so the
    /// web UI's "Listening" state can reflect a degraded receptionist.
    pub fn plugin_health(&self, id: &str) -> Option<crate::plugins::registry::HealthReport> {
        self.host.last_health(id).flatten()
    }

    /// The linked API client, if any — for host features that need server
    /// verification (connector-capability introspection, audit SEC-001).
    pub fn api_client(&self) -> Option<Arc<FormLogicClient>> {
        self.client()
    }

    /// Privacy-safe diagnostics snapshot (audit OBS-001) for
    /// `GET /api/desktop/support-bundle`: per-plugin computed health plus the
    /// durable-delivery journal counts. Composes surfaces other endpoints
    /// already expose — no tokens, no conversation content, no user paths.
    pub fn support_snapshot(&self) -> Value {
        let plugins: Vec<Value> = self
            .host
            .plugin_ids()
            .into_iter()
            .map(|id| {
                json!({
                    "id": id,
                    "health": self.host.last_health(&id).flatten(),
                })
            })
            .collect();

        let count_lines = |p: &std::path::Path| -> Option<usize> {
            std::fs::read_to_string(p).ok().map(|t| t.lines().count())
        };
        let root = &self.host.plugin_data_root;
        let mut journals = serde_json::Map::new();
        if let Ok(dirs) = std::fs::read_dir(root) {
            for entry in dirs.flatten() {
                let receipts = entry.path().join("host-event-receipts.jsonl");
                if let Some(n) = count_lines(&receipts) {
                    journals.insert(
                        format!("{}.receipts", entry.file_name().to_string_lossy()),
                        json!(n),
                    );
                }
            }
        }
        journals.insert(
            "processedMarkers".to_string(),
            json!(count_lines(&root.join("host-event-processed.jsonl"))),
        );
        if let Some(work) = &self.work {
            let (pending, dead) = work.counts();
            journals.insert("eventWork.pending".to_string(), json!(pending));
            journals.insert("eventWork.dead".to_string(), json!(dead));
        }

        json!({ "plugins": plugins, "journals": journals })
    }

    /// Preview of the local operational journals (DATA-PRIV-001 item 6):
    /// counts + retention windows, so "Clear history" can say exactly what it
    /// would remove. Never includes payload content.
    pub fn journals_snapshot(&self) -> Value {
        let receipts: serde_json::Map<String, Value> = self
            .host
            .receipt_counts()
            .into_iter()
            .map(|(id, n)| (id, json!(n)))
            .collect();
        let (pending, completed, dead) = self
            .work
            .as_ref()
            .map(|w| w.counts_full())
            .unwrap_or_default();
        let retention = crate::flows::work_ledger::Retention::from_env();
        // WORK-DUR-001 item 5: durability health — the ledger's blocked
        // state, corruption-recovery note, and a live writability probe of
        // the journal directory (permissions / disk space).
        let probe = self.journal_dir_writable_error();
        json!({
            "receipts": receipts,
            "eventWork": {
                "pending": pending,
                "completed": completed,
                "dead": dead,
                "blocked": self.work.as_ref().and_then(|w| w.blocked()),
                "recoveredCorruption": self.work.as_ref().and_then(|w| w.recovered_corruption().map(str::to_owned)),
            },
            "journalDirWritable": probe.is_none(),
            "journalDirError": probe,
            "retention": {
                "receiptsDays": crate::plugins::receipts::default_retention().num_days(),
                "completedHours": retention.completed.num_hours(),
                "deadDays": retention.dead.num_days(),
            },
            "encrypted": self.journal_crypto.is_some(),
        })
    }

    /// Probe the journal directory for writability (permissions/free space —
    /// WORK-DUR-001 item 5): create+sync+delete a tiny file. `Some(reason)`
    /// on failure, `None` when healthy.
    fn journal_dir_writable_error(&self) -> Option<String> {
        let probe = self.host.plugin_data_root.join(".write-probe");
        let attempt = (|| -> std::io::Result<()> {
            {
                use std::io::Write as _;
                let mut f = std::fs::File::create(&probe)?;
                f.write_all(b"ok")?;
                f.sync_data()?;
            }
            std::fs::remove_file(&probe)
        })();
        attempt.err().map(|e| e.to_string())
    }

    /// "Clear call/SMS history" for the LOCAL operational journals
    /// (DATA-PRIV-001 item 6): drops every terminal work record and every
    /// receipt/marker older than one hour. The last hour of receipts is kept
    /// as the replay-dedupe guard (an in-flight plugin redelivery must still
    /// be recognised); pending work is never touched — clearing history must
    /// not lose unfinished business events. Cloud records are deliberately
    /// NOT in scope: they belong to FormLogic's per-form retention settings.
    pub fn clear_history(&self) -> Value {
        let cutoff = chrono::Utc::now() - chrono::Duration::hours(1);
        let (completed, dead) = self
            .work
            .as_ref()
            .map(|w| w.clear_terminal())
            .unwrap_or_default();
        let receipts = self.host.sweep_receipts(cutoff);
        let markers = self
            .processed
            .as_ref()
            .and_then(|p| p.retain_since(cutoff).ok())
            .unwrap_or(0);
        json!({
            "cleared": {
                "completed": completed,
                "dead": dead,
                "receipts": receipts,
                "processedMarkers": markers,
            }
        })
    }

    /// Route a connector's events to ONE app (audit INT-004/C-13): the
    /// assigned app wins; with no assignment, exactly one candidate app
    /// (holding `connector.<id>.*` grants) is implicitly it; two or more is
    /// ambiguous and must be REJECTED, never double-processed.
    fn route_for(&self, connector: Option<&str>) -> ConnectorRouting {
        let Some(connector) = connector.filter(|c| !c.is_empty()) else {
            return ConnectorRouting::Unrestricted;
        };
        self.with_snapshot(|s| route_connector_event(connector, &s.assignments, &s.applogic))
            .unwrap_or(ConnectorRouting::Unrestricted)
    }

    // ── event loop ──────────────────────────────────────────────────────────────

    /// Handle one desktop event: app-logic record writes + binding fan-out,
    /// driven through the durable work ledger (audit CROSS-EVENT-001). The
    /// envelope is journaled BEFORE any readiness check — the plugin's receipt
    /// is already acked, so from here nothing may lose the event: failures
    /// reschedule (bounded backoff via the retry pump), deterministic
    /// rejections dead-letter visibly, and only a fully-terminal ledger state
    /// stops re-delivery.
    async fn on_event(self: Arc<Self>, envelope: Value) {
        let name = envelope.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let idem = envelope.get("idempotencyKey").and_then(Value::as_str).unwrap_or_default().to_string();
        if name.is_empty() || idem.is_empty() {
            return;
        }
        let Some(work) = self.work.clone() else {
            // Ledger unavailable (logged at boot): legacy best-effort — the
            // in-process set is then the only dedupe, and nothing recovers.
            if !self.begin_inflight(&idem) {
                return;
            }
            self.drive_event_legacy(&name, &idem, &envelope).await;
            return;
        };
        // Durable FIRST. A replayed delivery of a terminal event stops here.
        // WORK-DUR-001: a claim that could not be durably journaled is NOT a
        // claim — the event is not processed now. Its receipt (fsynced before
        // the plugin ack) stays the durable copy, protected from rotation by
        // the accountability guard, and the continuous reconciler re-imports
        // it once the ledger unblocks.
        match work.receive(&idem, &envelope) {
            Ok(ReceiveOutcome::Terminal) => return,
            Ok(_) => {}
            Err(e) => {
                self.note_error(format!("event {idem} not claimed (ledger blocked): {e}"));
                return;
            }
        }
        // In-process guard: one task drives a key at a time.
        if !self.begin_inflight(&idem) {
            return;
        }
        let terminal = self.drive_event(&work, &name, &idem, &envelope).await;
        if !terminal {
            // Still pending (retry scheduled / async bindings in flight):
            // release the key so the pump's re-entry can process it.
            self.release_inflight(&idem);
        }
    }

    /// One drive pass over the event's remaining stages. Returns whether the
    /// event reached a terminal state (completed/dead) during this pass.
    async fn drive_event(
        self: &Arc<Self>,
        work: &Arc<WorkLedger>,
        name: &str,
        idem: &str,
        envelope: &Value,
    ) -> bool {
        // Readiness failures reschedule WITHOUT consuming attempts — being
        // offline/unlinked must never dead-letter acked work. A failed retry
        // append leaves the row pending with no schedule; the reconciler's
        // stale-pending sweep re-drives it (WORK-DUR-001).
        let Some(client) = self.client() else {
            let _ = work.note_retry(idem, "no FormLogic account linked", false);
            return false;
        };
        if !self.ensure_snapshot(&client).await {
            let _ = work.note_retry(idem, "flows/bindings snapshot unavailable", false);
            return false;
        }
        if let Ok(mut s) = self.status.lock() {
            s.last_event_at = Some(now_iso());
        }

        // App/connector routing (audit INT-004/C-13): one connector's events
        // belong to ONE app. Ambiguity is a deterministic rejection → the DLQ
        // (visible with its reason; redrivable once an assignment is set).
        let connector = envelope
            .get("connectorId")
            .and_then(Value::as_str)
            .or_else(|| envelope.get("source").and_then(Value::as_str))
            .map(str::to_string);
        let routing = self.route_for(connector.as_deref());
        if let ConnectorRouting::Ambiguous(apps) = &routing {
            let msg = format!(
                "event {name} rejected: {} apps use connector '{}' and none is assigned — set an assignment (PUT /api/v1/connector-assignments)",
                apps.len(),
                connector.as_deref().unwrap_or("?"),
            );
            self.note_error(msg.clone());
            // Fail closed (WORK-DUR-001): the dead state must be durable
            // before the processed marker — otherwise a crash forgets WHY the
            // event stopped. On a blocked ledger the event stays pending and
            // the same deterministic rejection recurs on the re-drive.
            if work.mark_dead(idem, &msg).is_err() {
                return false;
            }
            self.mark_processed(idem);
            return true;
        }

        // Stage 1 — app-logic onConnectorEvent (the raw record writes). Its
        // effect keys make re-runs idempotent; skipped once durably done.
        // WORK-DUR-001: if the stage FLAG cannot be journaled, abort the pass
        // — the stage already ran, and its effect keys make the re-run on the
        // next drive idempotent, which is the same boundary as a crash
        // immediately after the stage.
        if !work.get(idem).is_some_and(|w| w.app_logic_done) {
            match self.run_app_logic(envelope, &client, &routing).await {
                StageOutcome::Success => {
                    if work.mark_app_logic_done(idem).is_err() {
                        return false;
                    }
                }
                StageOutcome::Permanent(e) => {
                    // Deterministic failure: recorded, not retried — the
                    // record-write gap is visible in status/last_error.
                    self.note_error(format!("app-logic (permanent): {e}"));
                    if work.mark_app_logic_done(idem).is_err() {
                        return false;
                    }
                }
                StageOutcome::Retryable(e) => {
                    self.note_error(format!("app-logic: {e}"));
                    return work
                        .note_retry(idem, &e, true)
                        .map(|s| s != WorkStatus::Pending)
                        .unwrap_or(false);
                }
            }
        }

        // Stage 2 — plan the binding fan-out ONCE, durably, before anything
        // executes: a crash mid-fan-out knows exactly which bindings were
        // owed. The plan is fixed at this moment; later snapshot changes
        // can't grow it (no double-fan-out drift on replays).
        let mut bindings = self.matching_bindings(envelope);
        bindings.sort_by_key(|b| b.get("sortOrder").and_then(Value::as_i64).unwrap_or(0));
        if !work.get(idem).is_some_and(|w| w.bindings.is_some()) {
            let ids: Vec<String> = bindings
                .iter()
                .filter_map(|b| b.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            // WORK-DUR-001: no binding may execute before the plan is
            // durable — a crash mid-fan-out must know exactly what was owed.
            if work.plan_bindings(idem, &ids).is_err() {
                return false;
            }
        }
        let planned = work.get(idem).and_then(|w| w.bindings).unwrap_or_default();

        // Stage 3 — execute the planned-but-unfinished bindings in sortOrder
        // (browser parity, FL-002/audit C-04): `sync` bindings are AWAITED in
        // order, `async`/`background` spawn at their slot; each records a
        // typed outcome in the ledger, and the LAST one to finish completes
        // the event.
        for binding in &bindings {
            let Some(binding_id) = binding.get("id").and_then(Value::as_str) else { continue };
            if planned.get(binding_id).map(|s| s.terminal()).unwrap_or(true) {
                continue; // done in a prior pass, or not part of this event's plan
            }
            let inflight_key = format!("bind:{idem}:{binding_id}");
            if !self.begin_inflight(&inflight_key) {
                continue; // a previous pass's async task is still executing it
            }
            if binding.get("mode").and_then(Value::as_str) == Some("sync") {
                let outcome = self.run_binding(binding, envelope, &client, &routing).await;
                self.settle_binding(work, idem, binding_id, outcome);
                self.release_inflight(&inflight_key);
            } else {
                let rt = self.clone();
                let client = client.clone();
                let event = envelope.clone();
                let routing = routing.clone();
                let binding = binding.clone();
                let work = work.clone();
                let idem = idem.to_string();
                let binding_id = binding_id.to_string();
                tokio::spawn(async move {
                    let outcome = rt.run_binding(&binding, &event, &client, &routing).await;
                    rt.settle_binding(&work, &idem, &binding_id, outcome);
                    rt.release_inflight(&inflight_key);
                    // The last async binding to finish completes the event.
                    // A completion that couldn't persist leaves it pending —
                    // the reconciler's stale-pending sweep re-drives it.
                    if work.try_complete(&idem).unwrap_or(false) {
                        rt.mark_processed(&idem);
                        rt.begin_inflight(&idem); // terminal: keep the fast dedupe entry
                    }
                });
            }
        }
        // Planned bindings that no longer exist in the snapshot can never
        // execute — settle them as skipped so the event can complete. A
        // failed settle leaves the binding pending for the next drive pass.
        for (binding_id, state) in &planned {
            if !state.terminal() && !bindings.iter().any(|b| b.get("id").and_then(Value::as_str) == Some(binding_id)) {
                let _ = work.set_binding(idem, binding_id, BindingState::Skipped, Some("binding no longer exists in the snapshot"));
            }
        }

        if work.try_complete(idem).unwrap_or(false) {
            self.mark_processed(idem);
            return true;
        }
        // Not complete: either async bindings are still in flight (their last
        // task completes the event), or a binding outcome scheduled a retry.
        false
    }

    /// Record one binding's typed outcome in the ledger. Retryable outcomes
    /// leave the binding pending and schedule the EVENT for a re-drive.
    fn settle_binding(
        &self,
        work: &Arc<WorkLedger>,
        idem: &str,
        binding_id: &str,
        outcome: BindingRunOutcome,
    ) {
        // A settle that cannot be journaled (ledger blocked) leaves the
        // binding pending: the next drive pass re-runs it, and the SERVER's
        // claimant-bound run reservation (INT-005) dedupes the re-execution —
        // so failing closed here cannot double-run a flow.
        match outcome {
            BindingRunOutcome::Done => {
                let _ = work.set_binding(idem, binding_id, BindingState::Done, None);
            }
            BindingRunOutcome::Skipped(reason) => {
                let _ = work.set_binding(idem, binding_id, BindingState::Skipped, Some(&reason));
            }
            BindingRunOutcome::Permanent(e) => {
                self.note_error(format!("binding {binding_id}: {e}"));
                let _ = work.set_binding(idem, binding_id, BindingState::Dead, Some(&e));
            }
            BindingRunOutcome::Retryable(e) => {
                self.note_error(format!("binding {binding_id}: {e}"));
                if work.note_retry(idem, &format!("binding {binding_id}: {e}"), true)
                    == Ok(WorkStatus::Dead)
                {
                    // Attempt budget exhausted: the event is dead — settle the
                    // binding so the DLQ row tells the whole story.
                    let _ = work.set_binding(idem, binding_id, BindingState::Dead, Some(&e));
                    self.mark_processed(idem);
                }
            }
        }
    }

    /// The pre-ledger event path, used only when the work ledger failed to
    /// open: process best-effort with in-session dedupe (old semantics).
    async fn drive_event_legacy(self: &Arc<Self>, name: &str, idem: &str, envelope: &Value) {
        let Some(client) = self.client() else { return };
        if !self.ensure_snapshot(&client).await {
            return;
        }
        if let Ok(mut s) = self.status.lock() {
            s.last_event_at = Some(now_iso());
        }
        let connector = envelope
            .get("connectorId")
            .and_then(Value::as_str)
            .or_else(|| envelope.get("source").and_then(Value::as_str))
            .map(str::to_string);
        let routing = self.route_for(connector.as_deref());
        if let ConnectorRouting::Ambiguous(apps) = &routing {
            self.note_error(format!(
                "event {name} rejected: {} apps use connector '{}' and none is assigned — set an assignment (PUT /api/v1/connector-assignments)",
                apps.len(),
                connector.as_deref().unwrap_or("?"),
            ));
            self.mark_processed(idem);
            return;
        }
        let _ = self.run_app_logic(envelope, &client, &routing).await;
        let mut bindings = self.matching_bindings(envelope);
        bindings.sort_by_key(|b| b.get("sortOrder").and_then(Value::as_i64).unwrap_or(0));
        for binding in bindings {
            if binding.get("mode").and_then(Value::as_str) == Some("sync") {
                let _ = self.run_binding(&binding, envelope, &client, &routing).await;
            } else {
                let rt = self.clone();
                let client = client.clone();
                let event = envelope.clone();
                let routing = routing.clone();
                tokio::spawn(async move {
                    let _ = rt.run_binding(&binding, &event, &client, &routing).await;
                });
            }
        }
        self.mark_processed(idem);
    }

    /// Journal an idempotencyKey as fully processed (best-effort — a write
    /// failure only means a possible duplicate REPLAY next boot, which the
    /// app-logic effect ledger already dedupes).
    fn mark_processed(&self, idem: &str) {
        if let Some(p) = &self.processed {
            if let Err(e) = p.record(idem, &Value::Null) {
                self.note_error(format!("processed-marker write failed for {idem}: {e}"));
            }
        }
    }

    /// Apply the ROUTED app's `onConnectorEvent` scripts to this event
    /// (audit INT-004: never every linked app's).
    ///
    /// Typed outcome (audit CROSS-EVENT-001): any script/API error is
    /// `Retryable` — the record writes carry effect keys, so a re-run is
    /// idempotent, and a deterministic script bug simply exhausts its attempt
    /// budget into the visible DLQ instead of being logged-and-forgotten.
    async fn run_app_logic(
        &self,
        envelope: &Value,
        client: &FormLogicClient,
        routing: &ConnectorRouting,
    ) -> StageOutcome {
        let apps: Vec<Value> = self.with_snapshot(|s| s.applogic.clone()).unwrap_or_default();
        let mut errors: Vec<String> = Vec::new();
        for entry in &apps {
            let entry_app_id = entry
                .get("app")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str);
            if !routing.allows_app(entry_app_id) {
                continue;
            }
            let Some(app) = AppLogicApp::from_bundle(entry) else { continue };
            let app_id = app.app_id.clone();
            // Own each app's in-process storage map for the duration of the call.
            let storage = Mutex::new(
                self.applogic_storage
                    .lock()
                    .map(|g| g.get(&app_id).cloned().unwrap_or_default())
                    .unwrap_or_default(),
            );
            let report = applogic::run_onconnector_event(&app, envelope, client, &storage).await;
            // Persist the (in-process) storage back.
            if let (Ok(mut all), Ok(g)) = (self.applogic_storage.lock(), storage.lock()) {
                all.insert(app_id, g.clone());
            }
            self.note_records((report.submitted + report.updated) as u64);
            errors.extend(report.errors.iter().cloned());
        }
        if errors.is_empty() {
            StageOutcome::Success
        } else {
            StageOutcome::Retryable(errors.join("; "))
        }
    }

    /// Bindings whose event/connector/form match this envelope (browser parity).
    fn matching_bindings(&self, envelope: &Value) -> Vec<Value> {
        let name = envelope.get("name").and_then(Value::as_str).unwrap_or_default();
        let connector = envelope
            .get("connectorId")
            .and_then(Value::as_str)
            .or_else(|| envelope.get("source").and_then(Value::as_str));
        let source = envelope.get("source").and_then(Value::as_str);
        let form_id = envelope.get("data").and_then(|d| d.get("formId")).and_then(Value::as_str);
        self.with_snapshot(|s| {
            s.bindings
                .iter()
                .filter(|b| {
                    // Defense-in-depth: the server (`FlowService::listOwnerBindings`) already
                    // excludes disabled bindings from the snapshot, but the dispatcher's core
                    // match must never fire one that slips through regardless (absent field =
                    // enabled, matching the DB default — same convention as find_flow above).
                    if b.get("enabled").and_then(Value::as_bool) == Some(false) {
                        return false;
                    }
                    let mode = b.get("mode").and_then(Value::as_str).unwrap_or("");
                    if mode == "manual" {
                        return false;
                    }
                    if b.get("event").and_then(Value::as_str) != Some(name) {
                        return false;
                    }
                    if let Some(bf) = b.get("formId").and_then(Value::as_str) {
                        if Some(bf) != form_id {
                            return false;
                        }
                    }
                    if let Some(bc) = b.get("connectorId").and_then(Value::as_str) {
                        if Some(bc) != connector && Some(bc) != source {
                            return false;
                        }
                    }
                    true
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
    }

    /// One binding: condition → reserve (idempotent) → execute → outputActions → complete.
    ///
    /// Returns a typed outcome (audit CROSS-EVENT-001) instead of silently
    /// returning: the caller records it in the durable work ledger.
    async fn run_binding(
        self: &Arc<Self>,
        binding: &Value,
        event: &Value,
        client: &Arc<FormLogicClient>,
        routing: &ConnectorRouting,
    ) -> BindingRunOutcome {
        // Condition (fail-safe: absent → true; error/false → skip).
        if let Some(expr) = binding.get("condition").and_then(|c| c.get("expr")).and_then(Value::as_str) {
            let ctx = json!({ "event": event });
            match quickjs::eval_bool(expr, &ctx).await {
                Ok(true) => {}
                _ => return BindingRunOutcome::Skipped("condition not met".into()),
            }
        }
        let binding_id = binding.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let flow_slug = binding.get("flow").and_then(Value::as_str).unwrap_or_default().to_string();
        let flow_def_id = binding.get("flowDefinitionId").and_then(Value::as_str).map(str::to_string);
        let flow = match self.find_flow(flow_def_id.as_deref(), &flow_slug) {
            Some(f) => f,
            None => return BindingRunOutcome::Skipped(format!("flow '{flow_slug}' not found in the snapshot")),
        };
        let app_id = flow.get("appId").and_then(Value::as_str).map(str::to_string);
        // INT-004/C-13: a flow belonging to an app OTHER than the connector's
        // routed app must not fire for this event (app-less workspace flows
        // stay unrestricted).
        if !routing.allows_flow(app_id.as_deref()) {
            return BindingRunOutcome::Skipped("connector routed to another app".into());
        }
        let app_ctx = self.app_context(app_id.as_deref());

        let scope = SelectorScope { event: Some(event.clone()), app: app_ctx.clone(), ..Default::default() };
        let inputs = Value::Object(build_inputs(binding.get("inputMap"), &scope));

        let event_idem = event.get("idempotencyKey").and_then(Value::as_str).unwrap_or_default();
        let correlation = event.get("correlationId").and_then(Value::as_str).unwrap_or(event_idem);
        let idempotency_key = format!("flow:{binding_id}:{event_idem}");
        let mut reserve = json!({
            "flowSlug": flow_slug,
            "bindingId": binding_id,
            "triggerEvent": event.get("name").cloned().unwrap_or(json!("event")),
            "correlationId": correlation,
            "idempotencyKey": idempotency_key,
            "inputSnapshot": { "event": event },
        });
        if let Some(a) = &app_id {
            reserve["appId"] = json!(a);
        }
        let (run, created) = match client.reserve_run(&reserve).await {
            Ok(v) => v,
            Err(e) => {
                return match &e {
                    // Transport / server-side trouble: the reservation may
                    // simply not have happened — retry with backoff.
                    FlError::Network(_) | FlError::NotConfigured => {
                        BindingRunOutcome::Retryable(format!("reserve {binding_id}: {e}"))
                    }
                    FlError::Unauthorized(_) => {
                        BindingRunOutcome::Retryable(format!("reserve {binding_id}: {e}"))
                    }
                    FlError::Conflict => BindingRunOutcome::Skipped(
                        "reservation already finalized elsewhere".into(),
                    ),
                    FlError::Http { status, .. } if *status >= 500 || *status == 408 || *status == 429 => {
                        BindingRunOutcome::Retryable(format!("reserve {binding_id}: {e}"))
                    }
                    // Typed 4xx (e.g. a stale call-scoped trigger past its
                    // TTL): deterministic — retrying cannot change the answer.
                    FlError::Http { .. } => {
                        BindingRunOutcome::Permanent(format!("reserve {binding_id}: {e}"))
                    }
                };
            }
        };
        if !created {
            // Duplicate: another runtime owns it — or OUR OWN reservation from
            // a crashed pass; the server's stale-run reclaim requeues that for
            // the claim loop, so the work is not lost either way.
            return BindingRunOutcome::Skipped("already reserved (another runtime, or recovered via the claim loop)".into());
        }
        let run_id = run.get("runId").or_else(|| run.get("id")).and_then(Value::as_str).unwrap_or_default().to_string();
        if run_id.is_empty() {
            return BindingRunOutcome::Permanent("reserve returned no run id".into());
        }

        let outcome = self
            .execute_with_retry(&flow, &inputs, Some(event.clone()), app_ctx.clone(), binding_id_opt(binding), binding.get("timeoutMs").and_then(Value::as_u64), binding.get("retryPolicy"), client)
            .await;

        // outputActions (browser parity) on success.
        let mut action_errors: Vec<String> = Vec::new();
        if outcome.status == "done" {
            let result = outcome.result.clone().unwrap_or(Value::Null);
            let scope = SelectorScope { event: Some(event.clone()), app: app_ctx.clone(), result: Some(result), inputs: Some(inputs.clone()), ..Default::default() };
            if let Some(actions) = binding.get("outputActions").and_then(Value::as_array) {
                let flow_slug_for_kv = flow.get("slug").and_then(Value::as_str).unwrap_or(&flow_slug).to_string();
                for (action_idx, action) in actions.iter().enumerate() {
                    let ekey = Self::output_effect_key(Some(&event), &binding_id, action_idx);
                    if let Err(e) = self.apply_output_action(action, &scope, client, app_id.as_deref(), &flow_slug_for_kv, ekey.as_deref()).await {
                        action_errors.push(e);
                    }
                }
            }
        }
        self.complete(client, &run_id, &outcome, &action_errors).await;

        // fallbackPolicy (browser `applyFallback` parity, docs/FORMLOGIC_FLOWS.md
        // §fallbackPolicy): fires when the flow graph itself failed OR it succeeded but a
        // downstream output action threw — either way the caller may be left with no reply.
        // `status` is exactly what was just persisted above via self.complete(); this is a
        // purely in-memory follow-up decision, same as the browser dispatcher's runBinding.
        // Live-call (sync) bindings are ALWAYS dispatched through this event path (never the
        // claim loop below), so this is the only place fallbackPolicy needs to apply.
        if outcome.status != "done" || !action_errors.is_empty() {
            self.apply_fallback(binding, event, &outcome, &action_errors).await;
        }

        // Executed to a durable server-side run row (success OR flow-level
        // failure — both are recorded; flow retryPolicy already ran inside
        // execute_with_retry). From the ledger's perspective this binding is
        // done: re-running it could double the flow's side effects.
        BindingRunOutcome::Done
    }

    /// The Rust twin of the browser dispatcher's `applyFallback` — same trigger, same
    /// `fallbackPolicy` fields (`mode`/`fallbackReply`/`onError`), but a different delivery
    /// channel: this runtime drives LIVE CALLS and has no toast/UI surface, so where the
    /// browser toasts a sync binding's `fallbackReply`, Desktop instead SPEAKS it back down
    /// the same call. It resolves which connector the triggering event came in on the same
    /// way `matching_bindings` does (a binding-scoped `connectorId` wins; otherwise whatever
    /// connector the event itself carries), then drives it through the exact same connector
    /// path the "call.speak" output action above already uses (`connectors::dispatch` →
    /// `call.operatorSpeak`). That means it inherits whatever gating the aokie plugin already
    /// applies there — e.g. it silently drops operatorSpeak while its own in-plugin AI
    /// receptionist owns replies — by design; working around that gate is out of scope here.
    ///
    /// `onError: 'surface_error'` (non-sync, or sync with no `fallbackReply` configured) has
    /// no toast equivalent on this runtime either; the closest existing channel for "tell the
    /// desktop UI something went wrong" is `note_error`, which already feeds `status()`
    /// (`GET /api/desktop/info`) and the window badge, so that's what's used. The documented
    /// default (no policy, or `onError: 'log_and_continue'`) is a deliberate no-op beyond
    /// that: the failed/partial run is already durably recorded via `self.complete()` above —
    /// the run-history row IS the log, mirroring the browser comment ("already logged;
    /// nothing surfaces to the viewer").
    async fn apply_fallback(&self, binding: &Value, event: &Value, outcome: &FlowOutcome, action_errors: &[String]) {
        let binding_id = binding.get("id").and_then(Value::as_str).unwrap_or("?");
        let mode = binding.get("mode").and_then(Value::as_str).unwrap_or("");
        let policy = binding.get("fallbackPolicy");
        let fallback_reply = policy
            .and_then(|p| p.get("fallbackReply"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        if mode == "sync" {
            if let Some(reply) = fallback_reply {
                match Self::fallback_connector_id(binding, event) {
                    Some(connector_id) => {
                        // Phase 0: the fallback reply names the call it answers —
                        // a stale event's fallback can't speak into the next call.
                        let mut payload = json!({ "text": reply });
                        if let Some(cid) = event
                            .get("data")
                            .and_then(|d| d.get("callId"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            payload["callId"] = json!(cid);
                        }
                        // §9.2: name the caller turn too — a fallback that lost
                        // the race to a newer caller turn is refused typed
                        // (stale_turn) instead of speaking a stale apology.
                        if event
                            .get("data")
                            .and_then(|d| d.get("speaker"))
                            .and_then(Value::as_str)
                            == Some("caller")
                        {
                            if let Some(turn) = event
                                .get("data")
                                .and_then(|d| d.get("turn"))
                                .and_then(Value::as_u64)
                            {
                                payload["inResponseTo"] = json!(turn);
                            }
                        }
                        let request_id = Self::output_effect_key(Some(event), binding_id, usize::MAX);
                        if let Err(e) = self
                            .connector(
                                &connector_id,
                                "call.operatorSpeak",
                                Some(payload),
                                request_id.as_deref(),
                            )
                            .await
                        {
                            self.note_error(format!("binding {binding_id} fallback speak via {connector_id}: {e}"));
                        }
                    }
                    None => {
                        self.note_error(format!(
                            "binding {binding_id} fallback: could not resolve which connector to speak the fallbackReply through"
                        ));
                    }
                }
                return;
            }
        }

        let on_error = policy.and_then(|p| p.get("onError")).and_then(Value::as_str).unwrap_or("log_and_continue");
        if on_error == "surface_error" {
            let msg = outcome.error.as_ref().map(|e| e.message.clone()).unwrap_or_else(|| {
                if action_errors.is_empty() {
                    format!("Flow binding '{binding_id}' failed")
                } else {
                    format!("Flow binding '{binding_id}' output action(s) failed: {}", action_errors.join("; "))
                }
            });
            self.note_error(format!("binding {binding_id} surfaced: {msg}"));
        }
        // Default log_and_continue: the run is already durably recorded via self.complete() above.
    }

    /// Which connector a fallback speak should target: a binding-scoped `connectorId` wins
    /// (it already gated which events could match this binding — see `matching_bindings`
    /// above); otherwise the incoming event's own `connectorId`/`source`, read the same way
    /// `matching_bindings` reads it for a binding with no connector-side filter.
    fn fallback_connector_id(binding: &Value, event: &Value) -> Option<String> {
        binding
            .get("connectorId")
            .and_then(Value::as_str)
            .or_else(|| event.get("connectorId").and_then(Value::as_str))
            .or_else(|| event.get("source").and_then(Value::as_str))
            .map(str::to_string)
    }

    // ── claim loop ───────────────────────────────────────────────────────────────

    async fn claim_sweep(self: &Arc<Self>) {
        let client = match self.client() {
            Some(c) => c,
            None => return,
        };
        if !self.ensure_snapshot(&client).await {
            return;
        }
        if let Ok(mut s) = self.status.lock() {
            s.last_claim_at = Some(now_iso());
        }
        let runs = match client.list_queued_runs(CLAIM_BATCH_LIMIT).await {
            Ok(r) => {
                self.note_ok();
                r
            }
            Err(e) => {
                self.note_error(format!("queued list: {e}"));
                return;
            }
        };
        for run in runs {
            let run_id = run.get("runId").or_else(|| run.get("id")).and_then(Value::as_str).unwrap_or_default().to_string();
            if run_id.is_empty() {
                continue;
            }
            let claimed = match client.claim_run(&run_id, &self.instance_id).await {
                Ok(c) => c,
                Err(e) => {
                    self.note_error(format!("claim {run_id}: {e}"));
                    continue;
                }
            };
            if !claimed {
                continue; // 409 — another runtime won
            }
            self.execute_claimed(&run, &run_id, &client).await;
        }
    }

    async fn execute_claimed(self: &Arc<Self>, run: &Value, run_id: &str, client: &Arc<FormLogicClient>) {
        let flow_def_id = run.get("flowDefinitionId").and_then(Value::as_str).map(str::to_string);
        let flow_slug = run.get("flow").and_then(Value::as_str).unwrap_or_default().to_string();
        let flow = match self.find_flow(flow_def_id.as_deref(), &flow_slug) {
            Some(f) => f,
            None => {
                // The flow may have been created or updated since our last snapshot fetch (TTL 60s).
                // Force ONE refresh before giving up, so a freshly-created flow's first run isn't
                // failed spuriously (previously it errored terminally within that window).
                *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = None;
                self.ensure_snapshot(client).await;
                match self.find_flow(flow_def_id.as_deref(), &flow_slug) {
                    Some(f) => f,
                    None => {
                        let e = runner::FlowError { code: runner::FlowErrorCode::RunnerUnavailable, message: format!("Flow '{flow_slug}' not loaded in this runtime"), node_id: None };
                        self.complete(client, run_id, &FlowOutcome { status: "error", result: None, error: Some(e), nodes_executed: 0 }, &[]).await;
                        return;
                    }
                }
            }
        };
        let app_id = flow.get("appId").and_then(Value::as_str).map(str::to_string);
        let app_ctx = self.app_context(app_id.as_deref());
        let binding = run.get("bindingId").and_then(Value::as_str).and_then(|bid| self.find_binding(bid));
        let event = run.get("inputSnapshot").and_then(|s| s.get("event")).cloned();

        // Condition re-check at claim time (it never ran server-side).
        if let (Some(b), Some(ev)) = (&binding, &event) {
            if let Some(expr) = b.get("condition").and_then(|c| c.get("expr")).and_then(Value::as_str) {
                let passes = matches!(quickjs::eval_bool(expr, &json!({ "event": ev })).await, Ok(true));
                if !passes {
                    let e = runner::FlowError { code: runner::FlowErrorCode::Cancelled, message: "Binding condition evaluated false at claim time".into(), node_id: None };
                    self.complete(client, run_id, &FlowOutcome { status: "cancelled", result: None, error: Some(e), nodes_executed: 0 }, &[]).await;
                    return;
                }
            }
        }

        // Inputs: binding+event → inputMap; event only → {}; else snapshot IS inputs.
        let inputs = match (&binding, &event) {
            (Some(b), Some(ev)) => {
                let scope = SelectorScope { event: Some(ev.clone()), app: app_ctx.clone(), ..Default::default() };
                Value::Object(build_inputs(b.get("inputMap"), &scope))
            }
            (None, Some(_)) => json!({}),
            _ => run.get("inputSnapshot").cloned().unwrap_or(json!({})),
        };

        let timeout = binding.as_ref().and_then(|b| b.get("timeoutMs").and_then(Value::as_u64));
        let retry = binding.as_ref().and_then(|b| b.get("retryPolicy"));
        let outcome = self.execute_with_retry(&flow, &inputs, event.clone(), app_ctx.clone(), None, timeout, retry, client).await;

        let mut action_errors = Vec::new();
        if outcome.status == "done" {
            if let Some(b) = &binding {
                let result = outcome.result.clone().unwrap_or(Value::Null);
                let scope = SelectorScope { event: event.clone(), app: app_ctx.clone(), result: Some(result), inputs: Some(inputs.clone()), ..Default::default() };
                if let Some(actions) = b.get("outputActions").and_then(Value::as_array) {
                    let flow_slug_for_kv = flow.get("slug").and_then(Value::as_str).unwrap_or(&flow_slug).to_string();
                    for (action_idx, action) in actions.iter().enumerate() {
                        let binding_id = b.get("id").and_then(Value::as_str).unwrap_or("binding");
                        let ekey = Self::output_effect_key(event.as_ref(), binding_id, action_idx);
                        if let Err(e) = self.apply_output_action(action, &scope, client, app_id.as_deref(), &flow_slug_for_kv, ekey.as_deref()).await {
                            action_errors.push(e);
                        }
                    }
                }
            }
        }
        self.complete(client, run_id, &outcome, &action_errors).await;
    }

    // ── execution helpers ────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    async fn execute_with_retry(
        self: &Arc<Self>,
        flow: &Value,
        inputs: &Value,
        event: Option<Value>,
        app: Option<Value>,
        _binding_id: Option<String>,
        timeout_ms: Option<u64>,
        retry_policy: Option<&Value>,
        client: &Arc<FormLogicClient>,
    ) -> FlowOutcome {
        let max_attempts = retry_policy
            .and_then(|p| p.get("maxAttempts"))
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, MAX_RETRY_ATTEMPTS as u64);
        let flow_json = flow.get("flowJson").cloned().unwrap_or(json!({}));
        let capabilities = flow
            .get("nodeCapabilities")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let flow_slug = flow.get("slug").and_then(Value::as_str).unwrap_or_default().to_string();
        let app_id = flow.get("appId").and_then(Value::as_str).map(str::to_string);
        let deps = self.build_deps(app_id, Some(client.clone()));
        let request_id_seed = event
            .as_ref()
            .and_then(|e| e.get("idempotencyKey"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("flowrun:{}", uuid::Uuid::new_v4().simple()));
        let opts = RunOptions {
            inputs: inputs.clone(),
            event,
            app,
            timeout_ms: timeout_ms.unwrap_or(runner::DEFAULT_TIMEOUT_MS),
            capabilities,
            flow_slug,
            request_id_seed,
        };

        let mut outcome = FlowOutcome { status: "error", result: None, error: None, nodes_executed: 0 };
        for attempt in 1..=max_attempts {
            outcome = runner::execute_flow(&flow_json, &deps, &opts).await;
            if outcome.status == "done" {
                break;
            }
            if attempt < max_attempts {
                let backoff = retry_policy.and_then(|p| p.get("backoff")).and_then(Value::as_str).unwrap_or("exponential");
                let wait = match backoff {
                    "none" => 0,
                    "fixed" => RETRY_BASE_DELAY_MS,
                    _ => RETRY_BASE_DELAY_MS * (1u64 << (attempt - 1)),
                };
                if wait > 0 {
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                }
            }
        }
        self.note_run();
        outcome
    }

    fn build_deps(&self, app_id: Option<String>, client: Option<Arc<FormLogicClient>>) -> RunDeps {
        RunDeps {
            client: client.or_else(|| self.client()),
            host: Some(self.host.clone()),
            app_id,
            http: self.http.clone(),
            llm_endpoint: self.resolve_llm_endpoint(),
            base_url: self.base_url(),
            // The services registry backs the desktop-service nodes (browser_action → the
            // "playwright-browser" service, image_gen → "krea2"); the runner resolves + (best-
            // effort) auto-starts them by id. No overrides in production — the registry is the source.
            registry: self.registry.clone(),
            service_bases: std::collections::HashMap::new(),
        }
    }

    /// A running local OpenAI-compatible chat endpoint (loopback), if any — from
    /// the services registry (reused, docs §4). Best-effort; `None` when absent.
    fn resolve_llm_endpoint(&self) -> Option<String> {
        let reg = self.registry.as_ref()?;
        let r = reg.lock().ok()?;
        // Prefer whatever LLM service the desktop currently has RUNNING, so the
        // flow reuses the already-loaded model (e.g. llama.cpp with the user's
        // gguf) instead of a fixed choice. The node's model is auto-discovered
        // from that endpoint's /v1/models, so no model needs pinning.
        if let Some(port) = r.running_llm_port() {
            return Some(format!("http://127.0.0.1:{port}/v1/chat/completions"));
        }
        // Fallback: the known local LLM ports even if the registry marks them
        // stopped (e.g. an externally-started Ollama the desktop didn't launch).
        for id in ["ollama", "llama-cpp"] {
            if let Some(port) = r.service_port(id) {
                return Some(format!("http://127.0.0.1:{port}/v1/chat/completions"));
            }
        }
        None
    }

    async fn complete(&self, client: &FormLogicClient, run_id: &str, outcome: &FlowOutcome, action_errors: &[String]) {
        let mut payload = Map::new();
        payload.insert("status".into(), json!(outcome.status));
        // Claimant binding (FL-AUTH-001): the server only accepts a claimed run's completion
        // from the instance that claimed it. Harmless on unclaimed (direct-reserved) runs.
        payload.insert("instanceId".into(), json!(self.instance_id));
        if outcome.status == "done" {
            let mut result = match &outcome.result {
                Some(Value::Object(m)) => m.clone(),
                Some(other) => {
                    let mut m = Map::new();
                    m.insert("value".into(), other.clone());
                    m
                }
                None => Map::new(),
            };
            if !action_errors.is_empty() {
                result.insert("outputActionErrors".into(), json!(action_errors));
            }
            payload.insert("result".into(), Value::Object(result));
        } else if let Some(e) = &outcome.error {
            payload.insert("error".into(), e.to_json());
        }
        self.cache_run(run_id, &Value::Object(payload.clone()));
        if let Err(e) = client.complete_run(run_id, &Value::Object(payload)).await {
            self.note_error(format!("complete {run_id}: {e}"));
        }
    }

    /// Apply one binding outputAction (browser `applyOutputAction` parity).
    /// Deterministic idempotency key for a binding output action (audit
    /// AOK-FLOW-002 / FL-001): `flowout:<event idem>:<binding>:<action idx>`.
    /// A crash between the submit and the run's completion retries with the
    /// SAME key, so the server returns the original row instead of writing a
    /// duplicate booking/task. Bounded to the ledger's 128-char column by
    /// hashing the event key when oversized (mirrors applogic::effect_key_for).
    fn output_effect_key(event: Option<&Value>, binding_id: &str, action_idx: usize) -> Option<String> {
        let idem = event?.get("idempotencyKey")?.as_str().filter(|k| !k.is_empty())?;
        let key = format!("flowout:{idem}:{binding_id}:{action_idx}");
        if key.len() <= 128 {
            return Some(key);
        }
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        idem.hash(&mut h);
        Some(format!("flowout:h{:016x}:{binding_id}:{action_idx}", h.finish()))
    }

    async fn apply_output_action(
        &self,
        action: &Value,
        scope: &SelectorScope,
        client: &FormLogicClient,
        app_id: Option<&str>,
        flow_slug: &str,
        effect_key: Option<&str>,
    ) -> Result<(), String> {
        let ty = action.get("type").and_then(Value::as_str).unwrap_or("");
        let when = action.get("when").and_then(Value::as_str);
        if !when_passes(when, scope) {
            return Ok(());
        }
        let tctx = scope_to_context(scope);
        match ty {
            "formlogic.store" => {
                let key = resolve_selector(action.get("key").unwrap_or(&Value::Null), scope);
                let key = key.as_str().filter(|s| !s.is_empty()).ok_or("store key did not resolve")?;
                let sc = action.get("scope").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
                    .unwrap_or_else(|| format!("flow:{flow_slug}"));
                let value = resolve_deep(action.get("value").unwrap_or(&Value::Null), scope);
                client.flow_kv_set(&sc, key, &value, app_id).await.map_err(|e| e.to_string())
            }
            "formlogic.toast" => Ok(()), // headless: no UI (logged via status only)
            "formlogic.submitResponse" => {
                let form = action.get("form").and_then(Value::as_str).ok_or("submitResponse missing form")?;
                let answers = resolve_deep(action.get("answers").unwrap_or(&Value::Null), scope);
                if !answers.is_object() {
                    return Err("answers did not resolve to an object".into());
                }
                client.submit_response(form, &answers, effect_key).await.map(|_| self.note_records(1)).map_err(|e| e.to_string())
            }
            "formlogic.updateResponse" => {
                let form = action.get("form").and_then(Value::as_str).ok_or("updateResponse missing form")?;
                let rid = resolve_selector(action.get("responseId").unwrap_or(&Value::Null), scope);
                let rid = rid.as_str().filter(|s| !s.is_empty()).ok_or("responseId did not resolve")?;
                let answers = resolve_deep(action.get("answers").unwrap_or(&Value::Null), scope);
                if !answers.is_object() {
                    return Err("answers did not resolve to an object".into());
                }
                client.update_response(form, rid, &answers).await.map(|_| self.note_records(1)).map_err(|e| e.to_string())
            }
            "connector.request" => {
                let cid = action.get("connectorId").and_then(Value::as_str).ok_or("connector.request missing connectorId")?;
                let cmd = action.get("command").and_then(Value::as_str).ok_or("connector.request missing command")?;
                let payload = resolve_deep(action.get("payload").unwrap_or(&Value::Null), scope);
                self.connector(cid, cmd, Some(payload), effect_key).await
            }
            "call.speak" => {
                let msg = interpolate_template(action.get("message").and_then(Value::as_str).unwrap_or(""), &tctx);
                // Phase 0: the triggering event's callId rides along so the plugin
                // can refuse a stale action (typed stale_call) instead of speaking
                // it into the NEXT call.
                let mut payload = json!({ "text": msg });
                let cid = resolve_deep(&json!("$event.data.callId"), scope);
                if let Some(c) = cid.as_str().filter(|s| !s.is_empty()) {
                    payload["callId"] = json!(c);
                }
                // §9.2: when the triggering event IS a caller turn, name it —
                // a newer caller turn makes this action stale (typed refusal).
                if resolve_deep(&json!("$event.data.speaker"), scope).as_str() == Some("caller") {
                    if let Some(turn) = resolve_deep(&json!("$event.data.turn"), scope).as_u64() {
                        payload["inResponseTo"] = json!(turn);
                    }
                }
                self.connector(
                    "aokie",
                    "call.operatorSpeak",
                    Some(payload),
                    effect_key,
                )
                .await
            }
            _ => Ok(()),
        }
    }

    async fn connector(
        &self,
        connector_id: &str,
        command: &str,
        payload: Option<Value>,
        request_id: Option<&str>,
    ) -> Result<(), String> {
        let body = crate::connectors::ConnectorRequestBody {
            connector_id: Some(connector_id.to_string()),
            command: command.to_string(),
            payload,
            timeout_ms: None,
            request_id: request_id.map(str::to_string),
        };
        crate::connectors::dispatch(&self.host, connector_id, &body).await.map(|_| ()).map_err(|f| f.message)
    }

    // ── flow.run (plugin RPC + HTTP /api/flows/run) ──────────────────────────────

    /// Run a flow by slug (reserved server-side) or inline flowJson (local only).
    /// Returns the `flow-run-result`-ish `{runId, status, result?, error?}`.
    pub async fn run_flow_direct(
        self: &Arc<Self>,
        flow_json: Option<Value>,
        flow_slug: Option<String>,
        app_slug: Option<String>,
        input: Value,
        correlation_id: String,
        idempotency_key: String,
        timeout_ms: Option<u64>,
        capabilities: Vec<String>,
    ) -> Result<Value, String> {
        let client = self.client();
        // Inline flowJson: execute locally (no server flow_definition to reserve).
        if let Some(fj) = flow_json {
            let run_id = format!("inline-{}", uuid::Uuid::new_v4().simple());
            let deps = self.build_deps(None, client.clone());
            let opts = RunOptions {
                inputs: input,
                event: None,
                app: None,
                timeout_ms: timeout_ms.unwrap_or(runner::DEFAULT_TIMEOUT_MS),
                capabilities,
                flow_slug: flow_slug.unwrap_or_default(),
                request_id_seed: idempotency_key.clone(),
            };
            let outcome = runner::execute_flow(&fj, &deps, &opts).await;
            self.note_run();
            let body = self.outcome_body(&run_id, &outcome);
            self.cache_run(&run_id, &body);
            return Ok(body);
        }
        // Slug: resolve + reserve + execute + complete.
        let slug = flow_slug.ok_or("flowId (slug) or flowJson is required")?;
        let client = client.ok_or("FormLogic Cloud is not configured")?;
        self.ensure_snapshot(&client).await;
        // Resolve the app id from the app slug (via the app-logic bundle map).
        let app_id = app_slug.as_deref().and_then(|s| self.app_id_for_slug(s));
        let flow = self.find_flow_by_slug(&slug, app_id.as_deref()).ok_or_else(|| format!("Unknown or disabled flow '{slug}'"))?;
        let mut reserve = json!({
            "flowSlug": slug,
            "triggerEvent": "manual",
            "correlationId": correlation_id,
            "idempotencyKey": idempotency_key,
            "inputSnapshot": input,
        });
        if let Some(a) = &app_id {
            reserve["appId"] = json!(a);
        }
        let (run, _created) = client.reserve_run(&reserve).await.map_err(|e| e.to_string())?;
        let run_id = run.get("runId").or_else(|| run.get("id")).and_then(Value::as_str).unwrap_or_default().to_string();
        let outcome = self.execute_with_retry(&flow, &reserve["inputSnapshot"], None, self.app_context(app_id.as_deref()), None, timeout_ms, None, &client).await;
        self.complete(&client, &run_id, &outcome, &[]).await;
        Ok(self.outcome_body(&run_id, &outcome))
    }

    fn outcome_body(&self, run_id: &str, outcome: &FlowOutcome) -> Value {
        let mut m = Map::new();
        m.insert("runId".into(), json!(run_id));
        m.insert("status".into(), json!(outcome.status));
        if let Some(r) = &outcome.result {
            m.insert("result".into(), r.clone());
        }
        if let Some(e) = &outcome.error {
            m.insert("error".into(), e.to_json());
        }
        Value::Object(m)
    }

    /// Handle the plugin `flow.run` RPC ({flowSlug, appSlug?, input, correlationId, idempotencyKey}).
    async fn handle_flow_run_rpc(self: &Arc<Self>, plugin_id: String, params: Value) -> Result<Value, RpcErrorObj> {
        let flow_slug = params.get("flowSlug").or_else(|| params.get("flowId")).and_then(Value::as_str).map(str::to_string);
        let flow_json = params.get("flowJson").filter(|v| v.is_object()).cloned();
        if flow_slug.is_none() && flow_json.is_none() {
            return Err(RpcErrorObj { code: -32602, message: "flow.run requires flowSlug or flowJson".into(), data: Some(json!({ "code": "invalid_flow" })) });
        }
        // P1-16 (mid-call business lookups): a plugin's flow.run WITHOUT an
        // appSlug defaults to the app its CONNECTOR is assigned to (INT-004
        // routing; plugin id == connector id for builtin plugins) — the aokie
        // plugin can invoke its own pack's flows with zero configuration.
        let app_slug = params
            .get("appSlug")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.assigned_app_slug(&plugin_id));
        let input = params.get("input").cloned().unwrap_or(json!({}));
        let correlation = params.get("correlationId").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("plugin-{}", uuid::Uuid::new_v4().simple()));
        let idem = params.get("idempotencyKey").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("flowrun:{correlation}"));
        let timeout = params.get("timeoutMs").and_then(Value::as_u64);
        match self.run_flow_direct(flow_json, flow_slug, app_slug, input, correlation, idem, timeout, Vec::new()).await {
            // The whole outcome body ({runId, status, result?, error?}) goes
            // back to the plugin. The previous shape re-built {runId, status}
            // only — DROPPING the flow's result — so every mid-call business
            // lookup the aokie plugin ever ran came back result-less and the
            // agent answered "the team will confirm" from its notes while the
            // digest sat unread in flow_run_logs.
            Ok(body) => Ok(body),
            Err(e) => Err(RpcErrorObj { code: -32000, message: e, data: Some(json!({ "code": "node_failed" })) }),
        }
    }

    /// Look up a cached run outcome (GET /api/flows/runs/{id}).
    pub fn cached_run(&self, run_id: &str) -> Option<Value> {
        self.run_cache.lock().ok().and_then(|g| g.1.get(run_id).cloned())
    }

    // ── lookups + small state ────────────────────────────────────────────────────

    fn find_flow(&self, flow_def_id: Option<&str>, slug: &str) -> Option<Value> {
        self.with_snapshot(|s| {
            if let Some(id) = flow_def_id {
                if let Some(f) = s.flows.iter().find(|f| f.get("id").and_then(Value::as_str) == Some(id)) {
                    return Some(f.clone());
                }
            }
            s.flows
                .iter()
                .find(|f| f.get("slug").and_then(Value::as_str) == Some(slug) && f.get("enabled").and_then(Value::as_bool) != Some(false))
                .cloned()
        })
        .flatten()
    }

    fn find_flow_by_slug(&self, slug: &str, app_id: Option<&str>) -> Option<Value> {
        self.with_snapshot(|s| {
            s.flows
                .iter()
                .find(|f| {
                    f.get("slug").and_then(Value::as_str) == Some(slug)
                        && f.get("enabled").and_then(Value::as_bool) != Some(false)
                        && match app_id {
                            Some(a) => f.get("appId").and_then(Value::as_str) == Some(a),
                            None => true,
                        }
                })
                .cloned()
        })
        .flatten()
    }

    fn find_binding(&self, binding_id: &str) -> Option<Value> {
        self.with_snapshot(|s| s.bindings.iter().find(|b| b.get("id").and_then(Value::as_str) == Some(binding_id)).cloned()).flatten()
    }

    /// The slug of the app the given CONNECTOR is explicitly assigned to
    /// (INT-004). None when unassigned/ambiguous — the caller then needs an
    /// explicit appSlug, exactly as before.
    fn assigned_app_slug(&self, connector_id: &str) -> Option<String> {
        self.with_snapshot(|s| {
            let app_id = s.assignments.get(connector_id)?.clone();
            s.applogic.iter().find_map(|e| {
                let app = e.get("app")?;
                if app.get("id").and_then(Value::as_str) == Some(app_id.as_str()) {
                    app.get("slug").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
        })
        .flatten()
    }

    fn app_id_for_slug(&self, slug: &str) -> Option<String> {
        self.with_snapshot(|s| {
            s.applogic.iter().find_map(|e| {
                let app = e.get("app")?;
                if app.get("slug").and_then(Value::as_str) == Some(slug) {
                    app.get("id").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
        })
        .flatten()
    }

    /// The `$app` context for a flow's app id (from the app-logic bundle if known).
    fn app_context(&self, app_id: Option<&str>) -> Option<Value> {
        let id = app_id?;
        let from_bundle = self.with_snapshot(|s| {
            s.applogic.iter().find_map(|e| {
                let app = e.get("app")?;
                if app.get("id").and_then(Value::as_str) == Some(id) {
                    Some(app.clone())
                } else {
                    None
                }
            })
        })
        .flatten();
        Some(from_bundle.unwrap_or_else(|| json!({ "id": id })))
    }

    /// Record `idem` as seen; returns `false` if it was already present.
    /// Claim a key for in-process work; `false` = another task holds it (or a
    /// terminal entry is deduping replays). Terminal keys stay claimed; keys
    /// whose work is still pending are released via [`release_inflight`](Self::release_inflight)
    /// so the retry pump can re-enter them.
    fn begin_inflight(&self, idem: &str) -> bool {
        let mut g = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if g.1.contains(idem) {
            return false;
        }
        g.1.insert(idem.to_string());
        g.0.push_back(idem.to_string());
        while g.0.len() > SEEN_CAP {
            if let Some(old) = g.0.pop_front() {
                g.1.remove(&old);
            }
        }
        true
    }

    /// Whether a key is currently claimed in-process (or terminally deduped).
    fn is_inflight(&self, idem: &str) -> bool {
        let g = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        g.1.contains(idem)
    }

    /// Release a non-terminal key so a later pass (retry pump, plugin replay)
    /// can drive it again. Also drops the queue entry so a stale duplicate in
    /// the eviction deque can never evict a live claim of the same key.
    fn release_inflight(&self, idem: &str) {
        let mut g = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        g.1.remove(idem);
        if let Some(pos) = g.0.iter().position(|k| k == idem) {
            g.0.remove(pos);
        }
    }

    fn cache_run(&self, run_id: &str, body: &Value) {
        let mut g = self.run_cache.lock().unwrap_or_else(|e| e.into_inner());
        if g.1.insert(run_id.to_string(), body.clone()).is_none() {
            g.0.push_back(run_id.to_string());
        }
        while g.0.len() > RUN_CACHE_CAP {
            if let Some(old) = g.0.pop_front() {
                g.1.remove(&old);
            }
        }
    }

    async fn heartbeat(&self) {
        let client = match self.client() {
            Some(c) => c,
            None => return,
        };
        let payload = json!({
            "desktopInstanceId": self.instance_id,
            "deviceName": self.device_name,
            "capabilities": ["flows", "aokie"],
        });
        if let Err(FlError::Unauthorized(e)) = client.upsert_desktop_connection(&payload).await {
            self.note_error(format!("heartbeat: {e}"));
        }
    }

    // ── remote command relay loop (docs/API.md §connector:relay) ──────────────────

    /// The long-poll relay loop: while linked, block on `connector-commands/pending`
    /// (25 s server-side), then claim + execute + complete each returned command.
    /// The long-poll self-throttles when idle; errors back off. Runs forever.
    async fn relay_loop(self: Arc<Self>) {
        loop {
            if self.client().is_none() {
                // Not linked yet — check again shortly (the user may link mid-session).
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
            let backoff = self.relay_poll_once().await;
            if !backoff.is_zero() {
                tokio::time::sleep(backoff).await;
            }
        }
    }

    /// One relay long-poll cycle. Returns how long to wait before the next poll:
    /// zero to re-poll immediately (commands were handled), a short floor when
    /// idle, or a longer back-off on error. Never panics.
    async fn relay_poll_once(self: &Arc<Self>) -> Duration {
        let client = match self.client() {
            Some(c) => c,
            None => return Duration::from_secs(10),
        };
        // `since=None`: pending only ever returns still-`pending` rows, and our
        // claim removes each from that set, so no cursor is needed for
        // exactly-once (the claim is the gate). ROUTE-001: identifying ourselves
        // is what surfaces commands TARGETED at this machine.
        match client
            .poll_pending_commands(None, 25_000, 50, Some(&self.instance_id))
            .await
        {
            Ok(commands) => {
                self.note_relay_poll(true);
                if commands.is_empty() {
                    // The 25 s long-poll already elapsed server-side; a small floor
                    // guards against a server that doesn't honour `wait`.
                    return Duration::from_secs(1);
                }
                for command in &commands {
                    self.handle_command(&client, command).await;
                }
                Duration::ZERO
            }
            Err(FlError::Unauthorized(e)) => {
                // The linked key lacks `connector:relay` (or was revoked) — this
                // won't fix itself soon, so back off hard to avoid hammering.
                self.note_relay_poll(false);
                self.note_error(format!("relay poll: {e}"));
                Duration::from_secs(60)
            }
            Err(e) => {
                self.note_relay_poll(false);
                self.note_error(format!("relay poll: {e}"));
                Duration::from_secs(5)
            }
        }
    }

    /// Claim + execute + complete one pending command via the pure relay core,
    /// wiring the FormLogic client (claim/complete) and the LOCAL connector
    /// gateway (execute) as its closures, then fold the outcome into status.
    async fn handle_command(self: &Arc<Self>, client: &Arc<FormLogicClient>, command: &Value) {
        let instance = self.instance_id.clone();
        let host = self.host.clone();
        let request_id = relay::command_id(command);
        let disposition = relay::process_one(
            command,
            RELAY_COMPLETE_ATTEMPTS,
            |id| {
                let client = client.clone();
                let instance = instance.clone();
                async move { client.claim_command(&id, &instance).await }
            },
            |connector_id, cmd, payload| {
                let host = host.clone();
                let request_id = request_id.clone();
                async move {
                    let body = crate::connectors::ConnectorRequestBody {
                        connector_id: Some(connector_id.clone()),
                        command: cmd,
                        payload: if payload.is_null() { None } else { Some(payload) },
                        timeout_ms: None,
                        request_id,
                    };
                    crate::connectors::dispatch(&host, &connector_id, &body)
                        .await
                        .map_err(|f| relay::RelayFailure { code: f.code.to_string(), message: f.message })
                }
            },
            |id, payload| {
                let client = client.clone();
                let instance = instance.clone();
                async move { client.complete_command(&id, &payload, &instance).await }
            },
        )
        .await;

        match disposition {
            relay::Disposition::Completed | relay::Disposition::Failed => {
                self.note_command();
                self.note_ok();
            }
            relay::Disposition::Skipped => {} // another runtime won — not ours
            relay::Disposition::ClaimError(e) | relay::Disposition::CompleteError(e) => {
                self.note_error(format!("relay: {e}"));
            }
        }
    }
}

/// Small adapter so `PluginHost` can hold `Arc<dyn PluginRpcHandler>` while the
/// runtime keeps its `Arc<Self>` (the handler future is `'static`).
struct RpcBridge(Arc<FlowRuntime>);

impl PluginRpcHandler for RpcBridge {
    fn handle(&self, plugin_id: String, _method: String, params: Value) -> PluginRpcFuture {
        let rt = self.0.clone();
        Box::pin(async move { rt.handle_flow_run_rpc(plugin_id, params).await })
    }
}

fn binding_id_opt(binding: &Value) -> Option<String> {
    binding.get("id").and_then(Value::as_str).map(str::to_string)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> Arc<FlowRuntime> {
        let host = PluginHost::new(&std::env::temp_dir().join(format!("flrt-{}", uuid::Uuid::new_v4().simple())), false, crate::events::EventBus::new());
        FlowRuntime::new(host, None, FormLogicConfig { base_url: String::new(), api_key: String::new() })
    }

    // ── Stable per-install instance identity (ROUTE-001) ────────────────────

    #[test]
    fn instance_id_is_persisted_and_stable_across_loads() {
        let dir = std::env::temp_dir().join(format!("fl-instid-{}", uuid::Uuid::new_v4().simple()));
        let first = load_or_create_instance_id(&dir);
        assert!(first.starts_with("desktop-"), "got: {first}");
        // A second "process start" reads the SAME id back — targeting depends on it.
        let second = load_or_create_instance_id(&dir);
        assert_eq!(first, second, "instance id must be stable per install");
        // The file is the persistence, not process state.
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("desktop-instance.json")).unwrap()).unwrap();
        assert_eq!(on_disk["instanceId"], json!(first));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_instance_file_is_replaced_not_trusted() {
        let dir = std::env::temp_dir().join(format!("fl-instid-bad-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop-instance.json");
        // Shapes the server would reject (spaces / over-long / non-string) must
        // never be adopted — a poisoned file can't smuggle an invalid identity.
        std::fs::write(&path, r#"{"instanceId": "evil id with spaces"}"#).unwrap();
        let id = load_or_create_instance_id(&dir);
        assert!(id.starts_with("desktop-"), "got: {id}");
        assert!(!id.contains(' '));
        // And the fresh id was persisted over the malformed file.
        let again = load_or_create_instance_id(&dir);
        assert_eq!(id, again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Crash-recovery candidate planning (audit FL-001) ────────────────────

    #[test]
    fn recovery_replays_only_pre_session_unprocessed_receipts_oldest_first() {
        let start = chrono::Utc::now();
        let at = |mins_ago: i64| (start - chrono::Duration::minutes(mins_ago)).to_rfc3339();
        let line = |key: &str, received: String| {
            json!({ "key": key, "receivedAt": received, "event": { "name": "aokie.call.incoming", "idempotencyKey": key } })
        };
        let lines = vec![
            line("newer-unprocessed", at(5)),
            line("older-unprocessed", at(90)),
            line("already-processed", at(10)),
            line("this-session", (start + chrono::Duration::seconds(1)).to_rfc3339()),
            // Audit CROSS-EVENT-001: unfinished work is NEVER age-discarded —
            // a days-old unprocessed receipt is still recovered.
            line("days-old-unprocessed", at(60 * 25)),
            line("newer-unprocessed", at(5)), // duplicate journal line
            json!({ "key": "no-envelope", "receivedAt": at(3) }),
            json!({ "receivedAt": at(2), "event": {} }), // no key
        ];
        let picked = recovery_candidates(lines, &|k| k == "already-processed", start);
        let keys: Vec<&str> = picked.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec!["days-old-unprocessed", "older-unprocessed", "newer-unprocessed"],
            "pre-session unprocessed only, no age discard, deduped, oldest first"
        );
        assert_eq!(
            picked[0].1.get("name").and_then(Value::as_str),
            Some("aokie.call.incoming"),
            "the journaled envelope itself is what replays"
        );
    }

    #[test]
    fn recovery_ignores_unparseable_timestamps() {
        let start = chrono::Utc::now();
        let lines = vec![
            json!({ "key": "bad-ts", "receivedAt": "yesterday-ish", "event": {} }),
            json!({ "key": "no-ts", "event": {} }),
        ];
        assert!(recovery_candidates(lines, &|_| false, start).is_empty());
    }

    // ── Connector→app routing (audit INT-004/C-13) ─────────────────────────

    fn bundle(app_id: &str, connectors: Option<Vec<&str>>) -> Value {
        let mut b = json!({ "app": { "id": app_id, "slug": app_id, "name": app_id } });
        if let Some(cs) = connectors {
            b["connectors"] = json!(cs);
        }
        b
    }

    #[test]
    fn routing_prefers_the_explicit_assignment() {
        let mut assignments = HashMap::new();
        assignments.insert("aokie".to_string(), "app-b".to_string());
        // Even with app-a as a candidate, the assignment wins.
        let bundles = vec![bundle("app-a", Some(vec!["aokie"])), bundle("app-b", Some(vec!["aokie"]))];
        assert_eq!(
            route_connector_event("aokie", &assignments, &bundles),
            ConnectorRouting::App("app-b".to_string())
        );
    }

    #[test]
    fn routing_single_candidate_is_implicitly_assigned() {
        let bundles = vec![bundle("app-a", Some(vec!["aokie"])), bundle("app-x", Some(vec!["vehicle"]))];
        assert_eq!(
            route_connector_event("aokie", &HashMap::new(), &bundles),
            ConnectorRouting::App("app-a".to_string())
        );
        assert_eq!(
            route_connector_event("printer", &HashMap::new(), &bundles),
            ConnectorRouting::NoCandidates
        );
    }

    #[test]
    fn routing_two_candidates_without_assignment_is_ambiguous_never_both() {
        let bundles = vec![bundle("app-a", Some(vec!["aokie"])), bundle("app-b", Some(vec!["aokie"]))];
        let routing = route_connector_event("aokie", &HashMap::new(), &bundles);
        assert_eq!(
            routing,
            ConnectorRouting::Ambiguous(vec!["app-a".to_string(), "app-b".to_string()])
        );
        // Neither app-logic nor either app's flows may run; app-less flows may.
        assert!(!routing.allows_app(Some("app-a")));
        assert!(!routing.allows_app(Some("app-b")));
        assert!(!routing.allows_flow(Some("app-a")));
        assert!(routing.allows_flow(None));
    }

    #[test]
    fn routing_legacy_server_without_metadata_stays_unrestricted() {
        // No assignments AND no `connectors` field on any bundle → pre-INT-004
        // server: keep the old run-everything behaviour.
        let bundles = vec![bundle("app-a", None), bundle("app-b", None)];
        assert_eq!(
            route_connector_event("aokie", &HashMap::new(), &bundles),
            ConnectorRouting::Unrestricted
        );
    }

    #[test]
    fn routing_filters_apps_and_flows() {
        let routing = ConnectorRouting::App("app-a".to_string());
        assert!(routing.allows_app(Some("app-a")));
        assert!(!routing.allows_app(Some("app-b")));
        assert!(routing.allows_flow(Some("app-a")));
        assert!(!routing.allows_flow(Some("app-b")));
        assert!(routing.allows_flow(None), "workspace flows are app-less");
        assert!(!ConnectorRouting::NoCandidates.allows_app(Some("app-a")));
        assert!(ConnectorRouting::NoCandidates.allows_flow(None));
    }

    // Redirect-hop re-validation (see `flow_redirect_policy`): a redirect must stay on the same
    // origin as the request that was already allow-list-checked. Without this, reqwest's default
    // policy would follow a redirect from an already-allowed origin to an arbitrary third-party
    // host, resending the body/headers — closing exactly the class of gap the loopback-URL fix
    // (runner.rs `is_loopback_url`) closed for the initial request, but at the redirect hop.
    #[test]
    fn redirect_target_allowed_rejects_cross_origin_hop() {
        let origin = reqwest::Url::parse("http://formlogic.local/api/v1/flows").unwrap();
        let evil = reqwest::Url::parse("http://attacker.example.com/steal").unwrap();
        assert!(!redirect_target_allowed(&origin, &evil));
    }

    #[test]
    fn redirect_target_allowed_rejects_loopback_from_non_loopback_origin() {
        // A bare http_request/llm_chat node only ever starts at the FormLogic base URL (never
        // loopback — see `is_allowed_flow_url`'s removed fallthrough). A redirect from there to a
        // local service must NOT be silently granted at the redirect hop; that would undo the
        // bare/service split under redirect.
        let origin = reqwest::Url::parse("http://formlogic.local/api/v1/flows").unwrap();
        let internal = reqwest::Url::parse("http://127.0.0.1:9999/admin").unwrap();
        assert!(!redirect_target_allowed(&origin, &internal));
    }

    #[test]
    fn redirect_target_allowed_permits_same_origin_path_change() {
        let origin = reqwest::Url::parse("http://formlogic.local/api/v1/flows").unwrap();
        let same_origin_other_path = reqwest::Url::parse("http://formlogic.local/api/v1/flows/2").unwrap();
        assert!(redirect_target_allowed(&origin, &same_origin_other_path));
    }

    #[test]
    fn redirect_target_allowed_rejects_scheme_or_port_downgrade() {
        let origin = reqwest::Url::parse("https://formlogic.local/api").unwrap();
        let http_downgrade = reqwest::Url::parse("http://formlogic.local/api").unwrap();
        assert!(!redirect_target_allowed(&origin, &http_downgrade));

        let origin = reqwest::Url::parse("http://127.0.0.1:5000/x").unwrap();
        let other_port = reqwest::Url::parse("http://127.0.0.1:5001/x").unwrap();
        assert!(!redirect_target_allowed(&origin, &other_port));
    }

    #[test]
    fn unlinked_runtime_reports_not_linked() {
        let rt = runtime();
        let st = rt.status();
        assert!(!st.linked);
        assert!(rt.client().is_none());
    }

    #[test]
    fn seen_dedup_is_bounded_and_dedupes() {
        let rt = runtime();
        assert!(rt.begin_inflight("a"));
        assert!(!rt.begin_inflight("a"));
        assert!(rt.begin_inflight("b"));
        // Releasing a non-terminal key lets a later pass re-claim it (the
        // retry pump's re-entry — audit CROSS-EVENT-001).
        rt.release_inflight("a");
        assert!(rt.begin_inflight("a"));
        for i in 0..(SEEN_CAP + 10) {
            rt.begin_inflight(&format!("k{i}"));
        }
        let g = rt.seen.lock().unwrap();
        assert!(g.0.len() <= SEEN_CAP);
    }

    /// A disabled binding must never fire, even if it slips into the local snapshot (e.g. a
    /// future server-side regression, or the window between an owner disabling a binding and the
    /// next snapshot refresh) — this is the defense-in-depth half of the binding-enabled kill
    /// switch (server side: `FlowService::listOwnerBindings` now excludes `enabled = 0` rows).
    /// Absent `enabled` (the DB default / pre-field snapshots) must still match, same convention
    /// as `find_flow`'s existing `!= Some(false)` check a few lines above.
    #[test]
    fn matching_bindings_excludes_disabled_binding() {
        let rt = runtime();
        let enabled = json!({ "id": "b-enabled", "mode": "async", "event": "aokie.call.incoming", "enabled": true });
        let default_enabled = json!({ "id": "b-default", "mode": "async", "event": "aokie.call.incoming" });
        let disabled = json!({ "id": "b-disabled", "mode": "async", "event": "aokie.call.incoming", "enabled": false });
        *rt.snapshot.lock().unwrap() = Some(CachedSnapshot {
                assignments: HashMap::new(),
            flows: vec![],
            bindings: vec![enabled, default_enabled, disabled],
            applogic: vec![],
            fetched_at: Instant::now(),
        });

        let envelope = json!({ "name": "aokie.call.incoming", "data": {} });
        let matched = rt.matching_bindings(&envelope);
        let ids: Vec<&str> = matched.iter().filter_map(|b| b.get("id").and_then(Value::as_str)).collect();

        assert!(ids.contains(&"b-enabled"), "enabled binding must still match");
        assert!(ids.contains(&"b-default"), "binding with no enabled field defaults to enabled");
        assert!(!ids.contains(&"b-disabled"), "disabled binding must never be dispatched");
        assert_eq!(matched.len(), 2);
    }

    #[tokio::test]
    async fn test_connection_without_config_errors() {
        let rt = runtime();
        assert!(rt.test_connection().await.is_err());
    }

    #[tokio::test]
    async fn flow_run_rpc_requires_slug_or_json() {
        let rt = runtime();
        let err = rt.handle_flow_run_rpc("aokie".into(), json!({ "input": {} })).await.unwrap_err();
        assert_eq!(err.data.unwrap()["code"], "invalid_flow");
    }

    #[tokio::test]
    async fn inline_flow_run_executes_locally_and_caches() {
        let rt = runtime();
        let flow_json = json!({
            "nodes": [ { "id": "in", "type": "input" }, { "id": "t", "type": "template", "data": { "template": "hi {{inputs.who}}" } }, { "id": "out", "type": "output", "data": { "value": "$upstream" } } ],
            "edges": [ { "source": "in", "target": "t" }, { "source": "t", "target": "out" } ]
        });
        let body = rt
            .run_flow_direct(Some(flow_json), None, None, json!({ "who": "ada" }), "c1".into(), "k1".into(), None, vec![])
            .await
            .unwrap();
        assert_eq!(body["status"], "done");
        assert_eq!(body["result"], json!("hi ada"));
        let run_id = body["runId"].as_str().unwrap();
        assert_eq!(rt.cached_run(run_id).unwrap()["status"], "done");
    }

    /// fallbackPolicy (docs/FORMLOGIC_FLOWS.md §fallbackPolicy) — integration-style: exercises
    /// the WHOLE `run_binding` path (reserve → execute → outputActions → complete → fallback)
    /// against a real (stub) FormLogic Cloud server + a real, plugin-less `PluginHost` — the
    /// same combination production wires together. No earlier test in this file needed a live
    /// `FormLogicClient` (the others either skip it entirely or use the inline `flow.run`
    /// branch), so this spins up a tiny in-process axum stub of `/api/v1/flow-runs*`.
    mod fallback_policy {
        use super::*;
        use axum::{
            extract::{Path, State},
            routing::{patch, post},
            Json, Router,
        };

        /// Captures every `PATCH /flow-runs/{id}` body (i.e. every `complete_run` call), so a
        /// test can assert what was actually PERSISTED separately from the in-memory fallback
        /// decision (the whole point of this fix: the two must be allowed to disagree).
        struct RunLogStub {
            completed: Mutex<Vec<Value>>,
        }

        async fn stub_reserve(Json(_body): Json<Value>) -> Json<Value> {
            // Always "creates" — no idempotent-replay path is exercised by these tests.
            Json(json!({ "run": { "runId": "run-1" }, "created": true }))
        }

        async fn stub_complete(
            State(stub): State<Arc<RunLogStub>>,
            Path(_run_id): Path<String>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            stub.completed.lock().unwrap().push(body);
            Json(json!({}))
        }

        /// Binds an ephemeral loopback port serving just enough of `/api/v1/flow-runs*` for
        /// `run_binding`'s reserve/complete calls, seeds the runtime's snapshot with one flow
        /// (slug "echo") built from `flow_json`, and returns the runtime + a client pointed at
        /// the stub + a handle to the captured `complete_run` payloads.
        async fn harness(flow_json: Value) -> (Arc<FlowRuntime>, Arc<FormLogicClient>, Arc<RunLogStub>) {
            let stub = Arc::new(RunLogStub { completed: Mutex::new(Vec::new()) });
            let app = Router::new()
                .route("/api/v1/flow-runs", post(stub_reserve))
                .route("/api/v1/flow-runs/:run_id", patch(stub_complete))
                .with_state(stub.clone());
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });

            let rt = runtime();
            *rt.snapshot.lock().unwrap() = Some(CachedSnapshot {
                assignments: HashMap::new(),
                flows: vec![json!({ "slug": "echo", "flowJson": flow_json, "enabled": true })],
                bindings: vec![],
                applogic: vec![],
                fetched_at: Instant::now(),
            });
            let client = Arc::new(FormLogicClient::new(&FormLogicConfig { base_url, api_key: "test-key".into() }).unwrap());
            (rt, client, stub)
        }

        /// A trivially successful flow graph (mirrors the browser dispatcher tests' passthrough
        /// fixture): input straight to a fixed-value output.
        fn passthrough_flow() -> Value {
            json!({
                "nodes": [ { "id": "in", "type": "input" }, { "id": "out", "type": "output", "data": { "value": "ok" } } ],
                "edges": [ { "source": "in", "target": "out" } ]
            })
        }

        /// A flow that fails outright (unknown node type → `invalid_flow`, same fixture shape
        /// as `runner.rs`'s `unknown_node_type_fails_loudly`).
        fn broken_flow() -> Value {
            json!({
                "nodes": [ { "id": "a", "type": "input" }, { "id": "b", "type": "quantum_flux" } ],
                "edges": [ { "source": "a", "target": "b" } ]
            })
        }

        /// The triggering event a real incoming Aokie call would carry (the desktop event bus
        /// stamps `connectorId`/`source` — see `matching_bindings` above, which this fallback
        /// path's connector resolution mirrors).
        fn call_event() -> Value {
            json!({
                "name": "aokie.call.incoming",
                "correlationId": "corr-1",
                "idempotencyKey": "idem-1",
                "connectorId": "aokie",
                "data": {},
            })
        }

        /// Trigger path 1 (NEW in this fix, both runtimes): the flow graph SUCCEEDS but its only
        /// outputAction — `call.speak`, the same "speak the reply" action a live-call binding
        /// would configure — throws. Here it throws because no aokie plugin is registered in
        /// this test's `PluginHost`, which naturally reproduces "plugin busy/disconnected" in
        /// production without any extra mocking. The persisted status must STILL read 'done'
        /// (constraint: don't change what gets logged) while the fallback fires anyway.
        #[tokio::test]
        async fn output_action_failure_still_attempts_the_fallback_speak() {
            let (rt, client, stub) = harness(passthrough_flow()).await;
            let binding = json!({
                "id": "b-live-call",
                "flow": "echo",
                "mode": "sync",
                "outputActions": [ { "type": "call.speak", "message": "Thanks, connecting you now." } ],
                "fallbackPolicy": { "onError": "log_and_continue", "fallbackReply": "One moment please." },
            });

            rt.run_binding(&binding, &call_event(), &client, &ConnectorRouting::Unrestricted).await;

            // Persisted status is untouched: the flow graph itself succeeded.
            {
                let completed = stub.completed.lock().unwrap();
                assert_eq!(completed.len(), 1);
                assert_eq!(completed[0]["status"], "done");
                let action_errors = completed[0]["result"]["outputActionErrors"].as_array().cloned().unwrap_or_default();
                assert_eq!(action_errors.len(), 1);
                // `apply_output_action`'s "call.speak" arm surfaces the raw connector failure
                // (no action-type prefix — unlike the browser's `${action.type}: ${msg}`; not
                // something this fix touches).
                assert!(action_errors[0].as_str().unwrap().contains("no plugin exposes connector"));
            }

            // ...but the fallback speak was actually attempted anyway, down the SAME connector
            // ("aokie") the triggering event carried — proven by the dispatch reaching the real
            // (plugin-less) connector gateway and failing there (connector_missing), not by
            // some earlier logic short-circuit.
            let status = rt.status();
            assert_eq!(status.errors, 1);
            assert!(status
                .last_error
                .as_deref()
                .unwrap_or_default()
                .contains("binding b-live-call fallback speak via aokie"));
        }

        /// Trigger path 2: the flow graph itself fails outright, never reaching outputActions.
        /// Before this fix Rust had NO fallbackPolicy implementation at all (confirmed by a
        /// full-text search turning up zero `fallback`/`fallbackReply` references in this
        /// file) — this is the first time this trigger path does anything on this runtime.
        #[tokio::test]
        async fn flow_failure_still_attempts_the_fallback_speak() {
            let (rt, client, stub) = harness(broken_flow()).await;
            let binding = json!({
                "id": "b-live-call-2",
                "flow": "echo",
                "mode": "sync",
                "fallbackPolicy": { "fallbackReply": "Sorry, please hold." },
            });

            rt.run_binding(&binding, &call_event(), &client, &ConnectorRouting::Unrestricted).await;

            {
                let completed = stub.completed.lock().unwrap();
                assert_eq!(completed.len(), 1);
                assert_eq!(completed[0]["status"], "error");
            }

            let status = rt.status();
            assert_eq!(status.errors, 1);
            assert!(status
                .last_error
                .as_deref()
                .unwrap_or_default()
                .contains("binding b-live-call-2 fallback speak via aokie"));
        }

        /// No `fallbackPolicy` at all: the documented default (`log_and_continue`) stays a
        /// silent no-op even though the flow failed outright — no connector dispatch is
        /// attempted (there is nothing configured to speak).
        #[tokio::test]
        async fn no_fallback_policy_configured_is_a_silent_no_op() {
            let (rt, client, stub) = harness(broken_flow()).await;
            let binding = json!({ "id": "b-no-policy", "flow": "echo", "mode": "sync" });

            rt.run_binding(&binding, &call_event(), &client, &ConnectorRouting::Unrestricted).await;

            assert_eq!(stub.completed.lock().unwrap().len(), 1);
            assert_eq!(rt.status().errors, 0);
        }

        /// An ASYNC binding (not a live call) with `onError: 'surface_error'` and no
        /// `fallbackReply`: no connector speak is attempted (that branch is sync-only), but the
        /// failure is surfaced through this runtime's closest equivalent to a toast — the
        /// `note_error`/`status()` channel the window badge already reads.
        #[tokio::test]
        async fn surface_error_on_non_sync_binding_uses_the_status_channel_not_a_speak() {
            let (rt, client, stub) = harness(broken_flow()).await;
            let binding = json!({
                "id": "b-async",
                "flow": "echo",
                "mode": "async",
                "fallbackPolicy": { "onError": "surface_error" },
            });

            rt.run_binding(&binding, &call_event(), &client, &ConnectorRouting::Unrestricted).await;

            assert_eq!(stub.completed.lock().unwrap().len(), 1);
            let status = rt.status();
            assert_eq!(status.errors, 1);
            assert!(status.last_error.as_deref().unwrap_or_default().contains("binding b-async surfaced"));
        }
    }
}
