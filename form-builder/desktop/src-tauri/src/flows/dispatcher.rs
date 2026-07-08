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
}

struct Inner {
    config: FormLogicConfig,
    client: Option<Arc<FormLogicClient>>,
}

struct CachedSnapshot {
    flows: Vec<Value>,
    bindings: Vec<Value>,
    applogic: Vec<Value>,
    fetched_at: Instant,
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
    snapshot: Mutex<Option<CachedSnapshot>>,
    /// Per-app in-process logic storage (dedupe markers for onConnectorEvent).
    applogic_storage: Mutex<HashMap<String, Map<String, Value>>>,
    /// In-process event dedupe (idempotencyKey) so one envelope runs once.
    seen: Mutex<(VecDeque<String>, HashSet<String>)>,
    /// Recent run outcomes for `GET /api/flows/runs/{id}` (inline + slug runs).
    run_cache: Mutex<(VecDeque<String>, HashMap<String, Value>)>,
}

impl FlowRuntime {
    pub fn new(
        host: Arc<PluginHost>,
        registry: Option<RegistryHandle>,
        config: FormLogicConfig,
    ) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let client = FormLogicClient::new(&config).map(Arc::new);
        let linked = client.is_some();
        let base_url = if config.base_url.trim().is_empty() { None } else { Some(config.base_url.clone()) };
        let instance_id = format!("desktop-{}", uuid::Uuid::new_v4().simple());
        let device_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "FormLogic Desktop".to_string());
        Arc::new(Self {
            host,
            registry,
            http,
            instance_id,
            device_name,
            inner: RwLock::new(Inner { config, client }),
            status: Mutex::new(FlowRuntimeStatus { linked, base_url, ..Default::default() }),
            snapshot: Mutex::new(None),
            applogic_storage: Mutex::new(HashMap::new()),
            seen: Mutex::new((VecDeque::new(), HashSet::new())),
            run_cache: Mutex::new((VecDeque::new(), HashMap::new())),
        })
    }

    /// Start the event + claim + heartbeat loops and register the plugin
    /// `flow.run` RPC handler. Idempotent-safe to call once at boot.
    pub fn start(self: &Arc<Self>) {
        self.host.set_rpc_handler(Arc::new(RpcBridge(self.clone())));
        // Event loop.
        {
            let rt = self.clone();
            let mut rx = rt.host.events().subscribe();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            let rt = rt.clone();
                            if let Ok(env) = serde_json::from_str::<Value>(&ev.json) {
                                tokio::spawn(async move { rt.on_event(env).await; });
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
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
                r
            }
            None => Err("FormLogic Cloud is not configured (set the base URL + API key)".into()),
        }
    }

    pub fn status(&self) -> FlowRuntimeStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
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
        if let Ok(mut s) = self.status.lock() {
            s.errors += 1;
            s.last_error = Some(msg.into());
            s.last_ok = Some(false);
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
        match (flows, bindings, applogic) {
            (Ok(flows), Ok(bindings), Ok(applogic)) => {
                self.note_ok();
                *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = Some(CachedSnapshot {
                    flows,
                    bindings,
                    applogic,
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

    // ── event loop ──────────────────────────────────────────────────────────────

    /// Handle one desktop event: app-logic record writes + binding fan-out.
    async fn on_event(self: Arc<Self>, envelope: Value) {
        let name = envelope.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let idem = envelope.get("idempotencyKey").and_then(Value::as_str).unwrap_or_default().to_string();
        if name.is_empty() || idem.is_empty() {
            return;
        }
        // In-process dedupe: one envelope drives one dispatch.
        if !self.mark_seen(&idem) {
            return;
        }
        let client = match self.client() {
            Some(c) => c,
            None => return, // no account linked — nothing to do headless
        };
        if !self.ensure_snapshot(&client).await {
            return;
        }
        if let Ok(mut s) = self.status.lock() {
            s.last_event_at = Some(now_iso());
        }

        // (1) App-logic onConnectorEvent — the raw record writes.
        self.run_app_logic(&envelope, &client).await;

        // (2) Binding fan-out.
        let bindings = self.matching_bindings(&envelope);
        for binding in bindings {
            let rt = self.clone();
            let client = client.clone();
            let event = envelope.clone();
            // async/background bindings run detached; sync awaited. Desktop has no
            // caller to block, so run each detached (exactly-once is the ledger's job).
            tokio::spawn(async move {
                rt.run_binding(&binding, &event, &client).await;
            });
        }
    }

    /// Apply every linked app's `onConnectorEvent` scripts to this event.
    async fn run_app_logic(&self, envelope: &Value, client: &FormLogicClient) {
        let apps: Vec<Value> = self.with_snapshot(|s| s.applogic.clone()).unwrap_or_default();
        for entry in &apps {
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
            for e in &report.errors {
                self.note_error(format!("app-logic: {e}"));
            }
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
    async fn run_binding(self: &Arc<Self>, binding: &Value, event: &Value, client: &Arc<FormLogicClient>) {
        // Condition (fail-safe: absent → true; error/false → skip).
        if let Some(expr) = binding.get("condition").and_then(|c| c.get("expr")).and_then(Value::as_str) {
            let ctx = json!({ "event": event });
            match quickjs::eval_bool(expr, &ctx).await {
                Ok(true) => {}
                _ => return,
            }
        }
        let binding_id = binding.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let flow_slug = binding.get("flow").and_then(Value::as_str).unwrap_or_default().to_string();
        let flow_def_id = binding.get("flowDefinitionId").and_then(Value::as_str).map(str::to_string);
        let flow = match self.find_flow(flow_def_id.as_deref(), &flow_slug) {
            Some(f) => f,
            None => return,
        };
        let app_id = flow.get("appId").and_then(Value::as_str).map(str::to_string);
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
                self.note_error(format!("reserve {binding_id}: {e}"));
                return;
            }
        };
        if !created {
            return; // duplicate event — another runtime already owns it
        }
        let run_id = run.get("runId").or_else(|| run.get("id")).and_then(Value::as_str).unwrap_or_default().to_string();
        if run_id.is_empty() {
            return;
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
                for action in actions {
                    if let Err(e) = self.apply_output_action(action, &scope, client, app_id.as_deref(), &flow_slug_for_kv).await {
                        action_errors.push(e);
                    }
                }
            }
        }
        self.complete(client, &run_id, &outcome, &action_errors).await;
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
                    for action in actions {
                        if let Err(e) = self.apply_output_action(action, &scope, client, app_id.as_deref(), &flow_slug_for_kv).await {
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
        let opts = RunOptions {
            inputs: inputs.clone(),
            event,
            app,
            timeout_ms: timeout_ms.unwrap_or(runner::DEFAULT_TIMEOUT_MS),
            capabilities,
            flow_slug,
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
        if let Some(port) = r.service_port("ollama") {
            return Some(format!("http://127.0.0.1:{port}/v1/chat/completions"));
        }
        if let Some(port) = r.service_port("llama-cpp") {
            return Some(format!("http://127.0.0.1:{port}/v1/chat/completions"));
        }
        None
    }

    async fn complete(&self, client: &FormLogicClient, run_id: &str, outcome: &FlowOutcome, action_errors: &[String]) {
        let mut payload = Map::new();
        payload.insert("status".into(), json!(outcome.status));
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
    async fn apply_output_action(
        &self,
        action: &Value,
        scope: &SelectorScope,
        client: &FormLogicClient,
        app_id: Option<&str>,
        flow_slug: &str,
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
                client.submit_response(form, &answers).await.map(|_| self.note_records(1)).map_err(|e| e.to_string())
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
                self.connector(cid, cmd, Some(payload)).await
            }
            "call.speak" => {
                let msg = interpolate_template(action.get("message").and_then(Value::as_str).unwrap_or(""), &tctx);
                self.connector("aokie", "call.operatorSpeak", Some(json!({ "message": msg }))).await
            }
            _ => Ok(()),
        }
    }

    async fn connector(&self, connector_id: &str, command: &str, payload: Option<Value>) -> Result<(), String> {
        let body = crate::connectors::ConnectorRequestBody {
            connector_id: Some(connector_id.to_string()),
            command: command.to_string(),
            payload,
            timeout_ms: None,
            request_id: None,
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
    async fn handle_flow_run_rpc(self: &Arc<Self>, _plugin_id: String, params: Value) -> Result<Value, RpcErrorObj> {
        let flow_slug = params.get("flowSlug").or_else(|| params.get("flowId")).and_then(Value::as_str).map(str::to_string);
        let flow_json = params.get("flowJson").filter(|v| v.is_object()).cloned();
        if flow_slug.is_none() && flow_json.is_none() {
            return Err(RpcErrorObj { code: -32602, message: "flow.run requires flowSlug or flowJson".into(), data: Some(json!({ "code": "invalid_flow" })) });
        }
        let app_slug = params.get("appSlug").and_then(Value::as_str).map(str::to_string);
        let input = params.get("input").cloned().unwrap_or(json!({}));
        let correlation = params.get("correlationId").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("plugin-{}", uuid::Uuid::new_v4().simple()));
        let idem = params.get("idempotencyKey").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("flowrun:{correlation}"));
        let timeout = params.get("timeoutMs").and_then(Value::as_u64);
        match self.run_flow_direct(flow_json, flow_slug, app_slug, input, correlation, idem, timeout, Vec::new()).await {
            Ok(body) => Ok(json!({ "runId": body.get("runId").cloned().unwrap_or(Value::Null), "status": body.get("status").cloned().unwrap_or(json!("error")) })),
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
    fn mark_seen(&self, idem: &str) -> bool {
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
        // exactly-once (the claim is the gate).
        match client.poll_pending_commands(None, 25_000, 50).await {
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
                async move {
                    let body = crate::connectors::ConnectorRequestBody {
                        connector_id: Some(connector_id.clone()),
                        command: cmd,
                        payload: if payload.is_null() { None } else { Some(payload) },
                        timeout_ms: None,
                        request_id: None,
                    };
                    crate::connectors::dispatch(&host, &connector_id, &body)
                        .await
                        .map_err(|f| relay::RelayFailure { code: f.code.to_string(), message: f.message })
                }
            },
            |id, payload| {
                let client = client.clone();
                async move { client.complete_command(&id, &payload).await }
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
        assert!(rt.mark_seen("a"));
        assert!(!rt.mark_seen("a"));
        assert!(rt.mark_seen("b"));
        for i in 0..(SEEN_CAP + 10) {
            rt.mark_seen(&format!("k{i}"));
        }
        let g = rt.seen.lock().unwrap();
        assert!(g.0.len() <= SEEN_CAP);
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
}
