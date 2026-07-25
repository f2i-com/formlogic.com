//! Desktop flow runner — the Rust twin of the browser executor
//! (`ui/src/client-runtime/flows/{flowExecutor,nodes}.ts`, docs
//! FORMLOGIC_FLOWS.md §4). Interprets a WorkflowGraph with the SAME node
//! semantics: topological execution, a 50-node budget, a per-run wall-clock
//! deadline, and the restricted node set. USER CODE (condition / logic_block)
//! runs in QuickJS (`quickjs.rs`); selectors/templates are pure Rust
//! (`selectors.rs`). `formlogic_*` writes go through the authenticated `/api/v1`
//! pipeline (`FormLogicClient`), `connector_request` through the local plugin
//! gateway (`connectors::dispatch`, synthetic internal origin), and
//! `http_request`/`llm_chat` are allow-listed to the FormLogic base + local
//! loopback services only. The run never panics — it always resolves to a
//! [`FlowOutcome`] whose status/error mirror `flow-run-result.schema.json`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::connectors::{self, ConnectorRequestBody};
use crate::flows::quickjs;
use crate::flows::selectors::{
    interpolate_template, resolve_deep, resolve_selector, scope_to_context, SelectorScope,
};
use crate::formlogic_client::FormLogicClient;
use crate::plugins::registry::PluginHost;
use crate::services::registry::RegistryHandle;

/// Hard cap on nodes executed per run (docs §4).
pub const FLOW_NODE_BUDGET: usize = 50;
/// Default per-run wall-clock budget (binding `timeoutMs` overrides).
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Capability a flow must declare before `storage_set` may write KV.
pub const KV_WRITE_CAPABILITY: &str = "formlogic.kv.write";

// ── formlogic_list_responses FROZEN CONTRACT (docs/FORMLOGIC_FLOWS.md §4) ──────
// The Rust twin of `ui/src/client-runtime/flows/nodes.ts`. The node fetches up
// to `limit` rows, normalizes each to `{id, answers, submittedAt?, status?}`,
// applies the ANDed `filters` client-side, and returns the STRUCTURED object
// `{responses, count, first, found}` so downstream selectors resolve identically
// ($nodes.<id>.first.answers.<field> / .count / .found / .responses).

/// Default number of rows `formlogic_list_responses` scans before filtering.
pub const LIST_RESPONSES_DEFAULT_LIMIT: u32 = 200;
/// Hard cap on rows `formlogic_list_responses` will scan.
pub const LIST_RESPONSES_MAX_LIMIT: u32 = 500;

/// Bounds for a `condition`/`logic_block` node's declared `data.timeoutMs` override
/// (docs §4) — mirrors the TS twin's `NODE_TIMEOUT_MIN_MS`/`NODE_TIMEOUT_MAX_MS` in
/// `ui/src/client-runtime/flows/nodes.ts`.
pub const NODE_TIMEOUT_MIN_MS: u64 = 100;
pub const NODE_TIMEOUT_MAX_MS: u64 = 30_000;

/// Typed flow-run-result error code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowErrorCode {
    NodeFailed,
    Timeout,
    Cancelled,
    CapabilityDenied,
    InvalidFlow,
    RunnerUnavailable,
}

impl FlowErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            FlowErrorCode::NodeFailed => "node_failed",
            FlowErrorCode::Timeout => "timeout",
            FlowErrorCode::Cancelled => "cancelled",
            FlowErrorCode::CapabilityDenied => "capability_denied",
            FlowErrorCode::InvalidFlow => "invalid_flow",
            FlowErrorCode::RunnerUnavailable => "runner_unavailable",
        }
    }
}

/// A typed node/run failure.
#[derive(Debug, Clone)]
pub struct FlowError {
    pub code: FlowErrorCode,
    pub message: String,
    pub node_id: Option<String>,
}

impl FlowError {
    fn new(code: FlowErrorCode, message: impl Into<String>, node_id: Option<String>) -> Self {
        Self { code, message: message.into(), node_id }
    }
    /// The `flow-run-result.schema.json` error envelope.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("code".into(), json!(self.code.as_str()));
        m.insert("message".into(), json!(self.message));
        if let Some(n) = &self.node_id {
            m.insert("nodeId".into(), json!(n));
        }
        Value::Object(m)
    }
}

/// Terminal outcome of a run.
#[derive(Debug, Clone)]
pub struct FlowOutcome {
    pub status: &'static str, // done | error | timeout | cancelled
    pub result: Option<Value>,
    pub error: Option<FlowError>,
    pub nodes_executed: usize,
}

impl FlowOutcome {
    fn done(result: Value, nodes: usize) -> Self {
        Self { status: "done", result: Some(result), error: None, nodes_executed: nodes }
    }
    fn err(e: FlowError, nodes: usize) -> Self {
        let status = match e.code {
            FlowErrorCode::Timeout => "timeout",
            FlowErrorCode::Cancelled => "cancelled",
            _ => "error",
        };
        Self { status, result: None, error: Some(e), nodes_executed: nodes }
    }
}

/// Everything a run can reach. Concrete (this IS the desktop runner); tests
/// point `client` at a stub server and pass a real/absent plugin host.
#[derive(Clone)]
pub struct RunDeps {
    /// Authenticated cloud client for formlogic_* + KV. None ⇒ those nodes fail.
    pub client: Option<Arc<FormLogicClient>>,
    /// Local plugin gateway for connector_request / aokie_speak.
    pub host: Option<Arc<PluginHost>>,
    /// The app id for KV scoping (None ⇒ the owner's workspace store).
    pub app_id: Option<String>,
    /// Shared HTTP client for http_request / llm_chat + the desktop-service nodes.
    pub http: reqwest::Client,
    /// A resolved local OpenAI-compatible chat endpoint (loopback), if any.
    pub llm_endpoint: Option<String>,
    /// FormLogic site base URL (http allow-list anchor).
    pub base_url: String,
    /// Local services registry — resolves + (best-effort) auto-starts the loopback service a
    /// desktop-service node drives (browser_action → "playwright-browser", image_gen → "krea2").
    /// None ⇒ those nodes fail with an actionable "install & start it in Desktop" message.
    pub registry: Option<RegistryHandle>,
    /// Explicit service-id → base URL overrides, checked BEFORE the registry (tests point these
    /// at a stub server; also a pre-resolution seam). e.g. {"playwright-browser": "http://127.0.0.1:PORT"}.
    pub service_bases: HashMap<String, String>,
    /// Phase 4 (plan §5.6): the account owner's Default-AI prefs store, consulted when an
    /// llm_chat node's provider is absent/'default'. `None`/never-fetched ⇒ the node fails
    /// with the typed `ai_default_unresolved` error — never a silent source hop.
    pub default_ai_prefs: Option<Arc<crate::ai::default_prefs::DefaultAiPrefsStore>>,
    /// flow_call's desktop FlowInvoker (extensible-flows plan §8.5/§15.6), built by the
    /// dispatcher: resolve the child within the owner's flow snapshot, guard
    /// recursion/depth, reserve a lineage-linked owner run, execute INLINE on this worker
    /// (never re-enqueued behind the parent on the single-flight relay lane), complete
    /// the run. `None` ⇒ flow_call refuses typed (mirrors the browser's absent-dep case).
    pub invoke_child_flow: Option<ChildFlowInvoker>,
}

/// Child-flow invocation request (`flow_call` → the dispatcher's FlowInvoker).
#[derive(Debug, Clone)]
pub struct ChildFlowRequest {
    pub target_flow_id: String,
    pub inputs: Value,
    pub call_node_id: String,
    /// Awaited ancestry INCLUDING the calling flow (stable ids, root first).
    pub call_stack: Vec<String>,
    /// The calling run's log id — recorded as the child's parent (lineage, plan §8.7).
    pub parent_run_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// The invoker's return: the child's outcome + its reserved run-log id.
pub struct ChildFlowEnvelope {
    pub outcome: FlowOutcome,
    pub run_id: Option<String>,
}

/// Dispatcher-provided child invoker. Refusals (dependency_missing / recursion_detected /
/// root_budget_exceeded / transport_failed) return Err with the §6.7 code as the message
/// prefix — the same contract as the browser invoker (childFlowInvoker.ts). The boxed
/// future breaks the recursive-type cycle (execute_flow → node → invoker → execute_flow).
pub type ChildFlowInvoker = Arc<
    dyn Fn(
            ChildFlowRequest,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ChildFlowEnvelope, String>> + Send>>
        + Send
        + Sync,
>;

/// Options for one run.
pub struct RunOptions {
    pub inputs: Value,
    pub event: Option<Value>,
    pub app: Option<Value>,
    pub timeout_ms: u64,
    pub capabilities: Vec<String>,
    pub flow_slug: String,
    /// Stable per-run seed used to derive physical connector request IDs. It
    /// must survive flow retries/recovery so a connector can replay safely.
    pub request_id_seed: String,
    /// Optional node-boundary observer (Phase 5, plan §5.7): fired once after
    /// each node completes and once when a node fails, so the desktop flow
    /// relay lane can stream sealed `flow_progress` frames. Purely additive —
    /// `None` keeps every existing call site byte-identical in behavior.
    pub progress: Option<NodeProgressSink>,
    /// Awaited flow_call ancestry INCLUDING this flow (stable flow ids, root first —
    /// plan §8.8 recursion/depth guard). Empty ⇒ this context cannot host children and
    /// flow_call refuses typed. The dispatcher seeds it with [flowId] where known.
    pub call_stack: Vec<String>,
    /// This run's reserved run-log id — flow_call children name it as parentRunId
    /// (lineage, plan §8.7). None on inline/unreserved executions.
    pub run_id: Option<String>,
}

/// One node-boundary progress event (see [`RunOptions::progress`]).
#[derive(Debug, Clone)]
pub struct NodeProgress {
    pub node_id: String,
    /// `done` after a successful node, `failed` on the node that errored.
    pub status: &'static str,
    pub message: Option<String>,
}

/// The node-progress observer callback shape.
pub type NodeProgressSink = std::sync::Arc<dyn Fn(NodeProgress) + Send + Sync>;

// ── graph model ────────────────────────────────────────────────────────────

struct GraphNode {
    id: String,
    node_type: String,
    data: Value,
}
struct GraphEdge {
    source: String,
    target: String,
    source_handle: Option<String>,
}
struct Graph {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

/// Client-side WorkflowGraph shape check (mirrors validateWorkflowGraph /
/// FlowService::sanitizeFlowJson): unique node ids, string types, edges to
/// existing nodes. Returns the parsed graph or an error message.
fn parse_graph(v: &Value) -> Result<Graph, String> {
    let obj = v.as_object().ok_or("flowJson must be an object of shape { nodes: [], edges: [] }")?;
    let nodes_v = obj.get("nodes").and_then(Value::as_array)
        .ok_or("flowJson must be an object of shape { nodes: [], edges: [] }")?;
    let edges_v = obj.get("edges").and_then(Value::as_array)
        .ok_or("flowJson must be an object of shape { nodes: [], edges: [] }")?;
    let mut ids: HashSet<String> = HashSet::new();
    let mut nodes = Vec::with_capacity(nodes_v.len());
    for (i, n) in nodes_v.iter().enumerate() {
        let id = n.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Flow node at index {i} is missing a valid id"))?;
        let ty = n.get("type").and_then(Value::as_str).filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Flow node '{id}' is missing a type"))?;
        if ids.contains(id) {
            return Err(format!("Duplicate flow node id: '{id}'"));
        }
        ids.insert(id.to_string());
        nodes.push(GraphNode {
            id: id.to_string(),
            node_type: ty.to_string(),
            data: n.get("data").cloned().unwrap_or(Value::Null),
        });
    }
    let mut edges = Vec::with_capacity(edges_v.len());
    let mut edge_ids: HashSet<String> = HashSet::new();
    for (i, e) in edges_v.iter().enumerate() {
        let source = e.get("source").and_then(Value::as_str)
            .ok_or_else(|| format!("Flow edge at index {i} must have string source and target"))?;
        let target = e.get("target").and_then(Value::as_str)
            .ok_or_else(|| format!("Flow edge at index {i} must have string source and target"))?;
        if !ids.contains(source) || !ids.contains(target) {
            return Err(format!("Flow edge at index {i} references a missing node ('{source}' → '{target}')"));
        }
        // Graph v2 (additive): an edge MAY carry a stable id — non-empty string, ≤128
        // chars, unique (mirrors validateWorkflowGraph / FlowService::sanitizeFlowJson).
        if let Some(id_v) = e.get("id") {
            let id = id_v.as_str().filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or_else(|| format!("Flow edge at index {i} has an invalid id"))?;
            if !edge_ids.insert(id.to_string()) {
                return Err(format!("Duplicate flow edge id: '{id}'"));
            }
        }
        edges.push(GraphEdge {
            source: source.to_string(),
            target: target.to_string(),
            source_handle: e.get("sourceHandle").and_then(Value::as_str).map(str::to_string),
        });
    }
    Ok(Graph { nodes, edges })
}

/// Kahn toposort; `None` on a cycle.
fn topological_order(graph: &Graph) -> Option<Vec<usize>> {
    let index: HashMap<&str, usize> =
        graph.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let mut indegree = vec![0usize; graph.nodes.len()];
    for e in &graph.edges {
        if let Some(&t) = index.get(e.target.as_str()) {
            indegree[t] += 1;
        }
    }
    let mut queue: Vec<usize> = (0..graph.nodes.len()).filter(|&i| indegree[i] == 0).collect();
    let mut order = Vec::with_capacity(graph.nodes.len());
    let mut head = 0;
    while head < queue.len() {
        let id = queue[head];
        head += 1;
        order.push(id);
        for e in &graph.edges {
            if e.source != graph.nodes[id].id {
                continue;
            }
            if let Some(&t) = index.get(e.target.as_str()) {
                indegree[t] -= 1;
                if indegree[t] == 0 {
                    queue.push(t);
                }
            }
        }
    }
    if order.len() == graph.nodes.len() {
        Some(order)
    } else {
        None
    }
}

/// Which outgoing edges a finished node activates (condition routes by handle).
fn edge_is_active(node: &GraphNode, output: &Value, source_handle: Option<&str>) -> bool {
    if node.node_type == "condition" {
        let branch = if crate::flows::selectors::js_truthy(Some(output)) { "true" } else { "false" };
        return match source_handle {
            None | Some("") => branch == "true",
            Some(h) => h == branch,
        };
    }
    if node.node_type == "flow_call" {
        // flow_call routes success/failure by handle (plan §8.3). A failed child only
        // reaches routing under failureMode 'route' (fail-parent throws — no edges
        // activate); a handle-less edge follows success. Mirrors the browser executor.
        let branch = if output.get("status").and_then(Value::as_str) == Some("failed") { "failure" } else { "success" };
        return match source_handle {
            None | Some("") => branch == "success",
            Some(h) => h == branch,
        };
    }
    true
}

/// Interpret a WorkflowGraph. Resolves (never rejects) with the run outcome.
pub async fn execute_flow(flow_json: &Value, deps: &RunDeps, opts: &RunOptions) -> FlowOutcome {
    let graph = match parse_graph(flow_json) {
        Ok(g) => g,
        Err(m) => return FlowOutcome::err(FlowError::new(FlowErrorCode::InvalidFlow, m, None), 0),
    };
    if graph.nodes.is_empty() {
        return FlowOutcome::done(json!({}), 0);
    }
    if graph.nodes.len() > FLOW_NODE_BUDGET {
        return FlowOutcome::err(
            FlowError::new(FlowErrorCode::InvalidFlow, format!("Flow exceeds the {FLOW_NODE_BUDGET}-node budget"), None),
            0,
        );
    }
    let order = match topological_order(&graph) {
        Some(o) => o,
        None => return FlowOutcome::err(FlowError::new(FlowErrorCode::InvalidFlow, "Flow graph contains a cycle", None), 0),
    };

    let deadline = Instant::now() + Duration::from_millis(opts.timeout_ms.max(1));

    // incoming[target] = [(source, edge index)]. Activation is keyed by EDGE IDENTITY
    // (index; stable within a stored graph), never `${source}→${target}`: parallel edges
    // between the same two nodes (a condition's true AND false handles wired to one node)
    // must not share one activation key, or the untaken branch is miscounted as activated.
    // The browser executor (flowExecutor.ts) keys identically — keep in lock-step.
    let mut incoming: HashMap<&str, Vec<(&str, usize)>> = HashMap::new();
    for (i, e) in graph.edges.iter().enumerate() {
        incoming.entry(e.target.as_str()).or_default().push((e.source.as_str(), i));
    }

    // RUN-302: typed data ports. The plan rides on the compiled IR when the server produced one
    // (so Desktop, browser and cloud read the SAME wiring); a graph the compiler never saw
    // derives it by the identical rule. No data edges → empty plan → every line below is inert
    // and existing flows behave exactly as before.
    let data_plan = super::data_ports::plan_from(flow_json);
    let mut node_outcomes: HashMap<String, super::data_ports::NodeOutcome> = HashMap::new();

    let mut outputs: HashMap<String, Value> = HashMap::new();
    let mut executed: HashSet<String> = HashSet::new();
    let mut active: HashSet<String> = HashSet::new();
    let mut activated_edges: HashSet<usize> = HashSet::new();
    for n in &graph.nodes {
        if incoming.get(n.id.as_str()).map(|v| v.is_empty()).unwrap_or(true) {
            active.insert(n.id.clone());
        }
    }

    let mut nodes_executed = 0usize;
    let mut saw_output = false;
    let mut output_result = Value::Null;
    let mut last_output = Value::Null;

    for &idx in &order {
        let node = &graph.nodes[idx];
        if !active.contains(&node.id) {
            continue;
        }
        if Instant::now() >= deadline {
            return FlowOutcome::err(
                FlowError::new(FlowErrorCode::Timeout, format!("Flow run exceeded {}ms", opts.timeout_ms), None),
                nodes_executed,
            );
        }
        if nodes_executed >= FLOW_NODE_BUDGET {
            return FlowOutcome::err(
                FlowError::new(FlowErrorCode::InvalidFlow, format!("Flow exceeded the {FLOW_NODE_BUDGET}-node execution budget"), None),
                nodes_executed,
            );
        }

        // Upstream: the single activated predecessor's output, or a map when
        // several branches converge.
        let active_in: Vec<&str> = incoming
            .get(node.id.as_str())
            .map(|list| {
                list.iter()
                    .filter(|(s, edge_idx)| executed.contains(*s) && activated_edges.contains(edge_idx))
                    .map(|(s, _)| *s)
                    .collect()
            })
            .unwrap_or_default();
        let upstream = match active_in.len() {
            0 => None,
            1 => outputs.get(active_in[0]).cloned(),
            _ => {
                let mut m = Map::new();
                for s in &active_in {
                    m.insert((*s).to_string(), outputs.get(*s).cloned().unwrap_or(Value::Null));
                }
                Some(Value::Object(m))
            }
        };

        // RUN-302 readiness, in lock-step with the browser and cloud: a node whose data inputs
        // can never arrive is SKIPPED here rather than run with missing values or left waiting
        // for a producer that has already terminated.
        let readiness = super::data_ports::readiness(&data_plan, &node_outcomes, &node.id);
        if readiness.verdict != super::data_ports::Verdict::Ready {
            let state = if readiness.verdict == super::data_ports::Verdict::Blocked {
                "failed"
            } else {
                "skipped"
            };
            node_outcomes.insert(node.id.clone(), super::data_ports::NodeOutcome::terminal(state));
            if let Some(progress) = &opts.progress {
                progress(NodeProgress {
                    node_id: node.id.clone(),
                    status: "skipped",
                    message: Some(format!(
                        "{}: {}",
                        readiness.reason.as_deref().unwrap_or("data_input_unsatisfied"),
                        readiness.unsatisfied.join(", ")
                    )),
                });
            }
            continue; // outgoing edges stay inactive, so the skip propagates downstream
        }

        let scope = SelectorScope {
            inputs: Some(opts.inputs.clone()),
            event: opts.event.clone(),
            app: opts.app.clone(),
            nodes: Some(nodes_map(&outputs)),
            upstream,
            data: if readiness.inputs.is_empty() {
                None
            } else {
                Some(Value::Object(readiness.inputs.clone()))
            },
            result: None,
        };

        let remaining = deadline.saturating_duration_since(Instant::now());
        let exec = execute_node(node, &scope, deps, opts);
        let output = match tokio::time::timeout(remaining, exec).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                node_outcomes.insert(node.id.clone(), super::data_ports::NodeOutcome::terminal("failed"));
                if let Some(progress) = &opts.progress {
                    progress(NodeProgress {
                        node_id: node.id.clone(),
                        status: "failed",
                        message: Some(e.message.clone()),
                    });
                }
                return FlowOutcome::err(e, nodes_executed);
            }
            Err(_) => {
                return FlowOutcome::err(
                    FlowError::new(FlowErrorCode::Timeout, format!("Flow run exceeded {}ms", opts.timeout_ms), None),
                    nodes_executed,
                )
            }
        };

        nodes_executed += 1;
        executed.insert(node.id.clone());
        node_outcomes.insert(
            node.id.clone(),
            super::data_ports::NodeOutcome::succeeded(super::data_ports::output_ports_of(&output)),
        );
        if let Some(progress) = &opts.progress {
            progress(NodeProgress {
                node_id: node.id.clone(),
                status: "done",
                message: None,
            });
        }
        if node.node_type == "output" {
            saw_output = true;
            output_result = output.clone();
        }
        last_output = output.clone();
        outputs.insert(node.id.clone(), output.clone());

        for (i, e) in graph.edges.iter().enumerate() {
            if e.source != node.id {
                continue;
            }
            if edge_is_active(node, &output, e.source_handle.as_deref()) {
                activated_edges.insert(i);
                active.insert(e.target.clone());
            }
        }
    }

    FlowOutcome::done(if saw_output { output_result } else { last_output }, nodes_executed)
}

fn nodes_map(outputs: &HashMap<String, Value>) -> Value {
    Value::Object(outputs.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn node_data(node: &GraphNode) -> &Value {
    &node.data
}

/// The `{inputs, event, app, nodes, upstream}` JSON context for condition /
/// logic_block (keys become sandbox globals in qjs expr mode).
fn expr_context(scope: &SelectorScope) -> Value {
    json!({
        "inputs": scope.inputs.clone().unwrap_or(json!({})),
        "event": scope.event.clone().unwrap_or(Value::Null),
        "app": scope.app.clone().unwrap_or(Value::Null),
        "nodes": scope.nodes.clone().unwrap_or(json!({})),
        "upstream": scope.upstream.clone().unwrap_or(Value::Null),
        "data": scope.data.clone().unwrap_or(Value::Null),
    })
}

fn require_string(node: &GraphNode, keys: &[&str]) -> Result<String, FlowError> {
    let data = node_data(node);
    for k in keys {
        if let Some(s) = data.get(k).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Ok(s.to_string());
            }
        }
    }
    Err(FlowError::new(
        FlowErrorCode::InvalidFlow,
        format!("Node '{}' ({}) is missing '{}'", node.id, node.node_type, keys[0]),
        Some(node.id.clone()),
    ))
}

fn kv_scope_for(data: &Value, opts: &RunOptions) -> String {
    if let Some(s) = data.get("scope").and_then(Value::as_str) {
        if !s.trim().is_empty() {
            return s.to_string();
        }
    }
    if !opts.flow_slug.is_empty() {
        format!("flow:{}", opts.flow_slug)
    } else {
        "app".to_string()
    }
}

fn resolve_form_ref(node: &GraphNode, scope: &SelectorScope) -> Result<String, FlowError> {
    let raw = require_string(node, &["form", "formId"])?;
    let resolved = resolve_selector(&json!(raw), scope);
    match resolved.as_str() {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}' form reference did not resolve to a form id", node.id),
            Some(node.id.clone()),
        )),
    }
}

/// A comparison operator for a `formlogic_list_responses` filter row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterOp {
    Eq,
    Neq,
    Contains,
    Gt,
    Lt,
    /// Inclusive bounds — the date-window ops (`numeric_compare` falls back
    /// to string comparison, chronological for ISO dates). Pushed down as
    /// `answersGte.<field>` / `answersLte.<field>`.
    Gte,
    Lte,
    In,
    /// Phone-normalized equality: digits-only last-9-suffix match (see
    /// `phone_digits_match`). Pushed down as `answersPhone.<field>`.
    PhoneEq,
}

/// Parse an op token; unknown/absent tokens default to `eq` (mirrors the TS).
fn parse_filter_op(raw: &str) -> FilterOp {
    match raw {
        "neq" => FilterOp::Neq,
        "contains" => FilterOp::Contains,
        "gt" => FilterOp::Gt,
        "lt" => FilterOp::Lt,
        "gte" => FilterOp::Gte,
        "lte" => FilterOp::Lte,
        "in" => FilterOp::In,
        "phone_eq" => FilterOp::PhoneEq,
        _ => FilterOp::Eq,
    }
}

/// One AND-ed filter over a form field: `answers[field] <op> value`.
struct ResponseFilter {
    field: String,
    op: FilterOp,
    /// Literal or a `$` selector — resolved against the run scope before matching.
    value: Value,
}

/// Server-side pushdown (audit AOK-FLOW-001): eq filters whose resolved value
/// is a STRING become `answers.<field>=<value>` query params, so an exact
/// lookup (call_id, phone, …) is answered by the DATABASE — a match beyond
/// the fetch limit is never silently missed. Every filter is still applied
/// client-side afterwards, so the frozen contract is unchanged; pushdown only
/// changes WHICH rows come back.
///
/// Only STRING values push down (review sweep): the client-side filter uses
/// loose (stringified) equality, but the server's json_extract eq is stricter
/// for non-string stored values — a numeric `5` vs `"5"`, `42.0` vs `42`,
/// bool coercions — so pushing a number/bool could fetch a NARROWER set than
/// the client filter would accept, and the client filter can't rescue a row
/// the server never returned. Every eq lookup in practice (call_id, phone) is
/// a string; number/bool eq stays fully client-side, identically in both
/// runners. The field name is also length-bounded to match the server's
/// `{1,64}` machine-key regex (a longer field the server would ignore is not
/// sent). Mirrors the browser executor (nodes.ts).
fn pushdown_eq_filters(filters_raw: Option<&Value>, scope: &SelectorScope) -> Vec<(String, String)> {
    parse_response_filters(filters_raw)
        .iter()
        .filter(|f| {
            matches!(
                f.op,
                FilterOp::Eq | FilterOp::PhoneEq | FilterOp::Gte | FilterOp::Lte
            )
        })
        .filter_map(|f| {
            let scalar = match resolve_selector(&f.value, scope) {
                Value::String(v) => v,
                _ => return None,
            };
            let prefix = match f.op {
                // phone_eq pushes down too: the server runs the SAME
                // digits-suffix rule (coarse LIKE + exact check), so a
                // customer match beyond the fetch limit is found by the
                // database, not scanned for client-side.
                FilterOp::PhoneEq => "answersPhone",
                // Range bounds: the server filters BEFORE the limit, so a
                // date window over a large table can't silently drop
                // in-window rows to the fetch cap.
                FilterOp::Gte => "answersGte",
                FilterOp::Lte => "answersLte",
                _ => "answers",
            };
            (!f.field.is_empty()
                && f.field.len() <= 64
                && f.field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .then(|| (format!("{}.{}", prefix, f.field), scalar))
        })
        .collect()
}

/// Clamp a node's `limit` into `[1, LIST_RESPONSES_MAX_LIMIT]`, defaulting when
/// unset/invalid (mirrors `clampListLimit` in nodes.ts).
fn clamp_list_limit(raw: Option<&Value>) -> u32 {
    let n = match raw.and_then(Value::as_f64) {
        Some(f) if f.is_finite() => f.floor() as i64,
        _ => LIST_RESPONSES_DEFAULT_LIMIT as i64,
    };
    n.clamp(1, LIST_RESPONSES_MAX_LIMIT as i64) as u32
}

/// Clamp a `condition`/`logic_block` node's declared `data.timeoutMs` into
/// `[NODE_TIMEOUT_MIN_MS, NODE_TIMEOUT_MAX_MS]`, or `None` when absent/not a
/// finite number — callers then fall back to `quickjs::QJS_TIMEOUT`, preserving
/// today's behavior for nodes that don't declare an override (mirrors
/// `clampDeclaredTimeoutMs` in nodes.ts).
fn clamp_declared_timeout(data: &Value) -> Option<Duration> {
    let f = data.get("timeoutMs").and_then(Value::as_f64)?;
    if !f.is_finite() {
        return None;
    }
    let ms = (f as i64).clamp(NODE_TIMEOUT_MIN_MS as i64, NODE_TIMEOUT_MAX_MS as i64) as u64;
    Some(Duration::from_millis(ms))
}

/// First defined non-empty STRING among the candidates (tolerant field aliasing).
fn first_string(candidates: &[Option<&Value>]) -> Option<String> {
    for c in candidates {
        if let Some(Value::String(s)) = c {
            if !s.is_empty() {
                return Some(s.clone());
            }
        }
    }
    None
}

/// Normalize a raw response record (snake/camel tolerant) to a
/// `{id, answers, submittedAt?, status?}` row, or `None` (mirrors
/// `normalizeResponseRow` in nodes.ts). Arrays are rejected (not objects).
fn normalize_response_row(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?; // `as_object` is None for arrays/scalars
    let id = match obj.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let answers = match obj.get("answers") {
        Some(v) if v.is_object() => v.clone(),
        _ => json!({}),
    };
    let mut row = Map::new();
    row.insert("id".into(), json!(id));
    row.insert("answers".into(), answers);
    if let Some(sa) = first_string(&[
        obj.get("submittedAt"),
        obj.get("submitted_at"),
        obj.get("createdAt"),
        obj.get("created_at"),
    ]) {
        row.insert("submittedAt".into(), json!(sa));
    }
    if let Some(st) = first_string(&[obj.get("status")]) {
        row.insert("status".into(), json!(st));
    }
    Some(Value::Object(row))
}

/// Parse a node's `data.filters` into typed rows (unknown ops → `eq`; empty
/// fields dropped). Mirrors `parseResponseFilters` in nodes.ts.
fn parse_response_filters(raw: Option<&Value>) -> Vec<ResponseFilter> {
    let arr = match raw.and_then(Value::as_array) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for item in arr {
        let obj = match item.as_object() {
            Some(o) => o,
            None => continue,
        };
        let field = obj.get("field").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if field.is_empty() {
            continue;
        }
        let op = obj.get("op").and_then(Value::as_str).map(parse_filter_op).unwrap_or(FilterOp::Eq);
        out.push(ResponseFilter {
            field: field.to_string(),
            op,
            value: obj.get("value").cloned().unwrap_or(Value::Null),
        });
    }
    out
}

/// JS `String(v)` for scalars (null → "null"); arrays comma-join with
/// null/undefined → "" per the JS join, objects → "[object Object]".
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS `String(v ?? '')` — null/undefined coerce to the empty string.
fn js_string_nullish(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        js_string(v)
    }
}

/// JS `Number(v)` for the values a stored field holds; `None` == `NaN`.
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

/// Loose equality consistent with stored field values: identity, else
/// `String()`-compare (mirrors `looseEquals` in nodes.ts).
fn loose_equals(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    if a.is_null() || b.is_null() {
        return false;
    }
    js_string(a) == js_string(b)
}

/// Numeric compare with a string fallback when either side is non-numeric
/// (mirrors `numericCompare` in nodes.ts; the fallback is lexicographic rather
/// than locale-aware, which agrees with `localeCompare` for the ASCII values
/// stored fields hold).
fn numeric_compare(a: &Value, b: &Value) -> f64 {
    match (js_number(a), js_number(b)) {
        (Some(na), Some(nb)) if !na.is_nan() && !nb.is_nan() => na - nb,
        _ => match js_string_nullish(a).cmp(&js_string_nullish(b)) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        },
    }
}

/// `one of` membership: the filter value is an array or a comma list; loose-
/// equals membership (mirrors `inList` in nodes.ts).
fn in_list(field_value: &Value, filter_value: &Value) -> bool {
    let list: Vec<Value> = match filter_value {
        Value::Array(a) => a.clone(),
        _ => js_string_nullish(filter_value)
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| json!(s))
            .collect(),
    };
    list.iter().any(|item| loose_equals(field_value, item))
}

/// Evaluate one filter op against a field value (docs §4 op semantics).
fn matches_filter_op(field_value: &Value, op: FilterOp, filter_value: &Value) -> bool {
    match op {
        FilterOp::Eq => loose_equals(field_value, filter_value),
        FilterOp::Neq => !loose_equals(field_value, filter_value),
        FilterOp::Contains => js_string_nullish(field_value)
            .to_lowercase()
            .contains(&js_string_nullish(filter_value).to_lowercase()),
        FilterOp::Gt => numeric_compare(field_value, filter_value) > 0.0,
        FilterOp::Lt => numeric_compare(field_value, filter_value) < 0.0,
        FilterOp::Gte => numeric_compare(field_value, filter_value) >= 0.0,
        FilterOp::Lte => numeric_compare(field_value, filter_value) <= 0.0,
        FilterOp::In => in_list(field_value, filter_value),
        FilterOp::PhoneEq => {
            phone_digits_match(&js_string_nullish(field_value), &js_string_nullish(filter_value))
        }
    }
}

/// Phone-normalized equality (filter op `phone_eq`): both sides reduced to
/// digits, compared on the last-9-digit suffix — the rule the Aokie caller
/// lookups have always used, so '+61 491 570 156' matches '0491570156'.
/// Fewer than 6 digits on either side never matches. Mirrors
/// `phoneDigitsMatch` in nodes.ts and `ResponseService::phoneDigitsMatch`.
fn phone_digits_match(stored: &str, wanted: &str) -> bool {
    let a: String = stored.chars().filter(|c| c.is_ascii_digit()).collect();
    let b: String = wanted.chars().filter(|c| c.is_ascii_digit()).collect();
    if a.len() < 6 || b.len() < 6 {
        return false;
    }
    let suf = |s: &str| s.chars().rev().take(9).collect::<Vec<_>>();
    suf(&a) == suf(&b)
}

/// Normalize + filter fetched rows into the frozen structured result
/// `{responses, count, first, found}` (mirrors the `formlogic_list_responses`
/// case body in nodes.ts). Filter values are resolved against `scope`.
fn apply_list_responses(raw: &[Value], filters_raw: Option<&Value>, scope: &SelectorScope) -> Value {
    let mut rows: Vec<Value> = Vec::new();
    for item in raw {
        if let Some(row) = normalize_response_row(item) {
            rows.push(row);
        }
    }
    let filters = parse_response_filters(filters_raw);
    let matched: Vec<Value> = if filters.is_empty() {
        rows
    } else {
        rows.into_iter()
            .filter(|row| {
                filters.iter().all(|f| {
                    let field_value = row
                        .get("answers")
                        .and_then(|a| a.get(&f.field))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let resolved = resolve_selector(&f.value, scope);
                    matches_filter_op(&field_value, f.op, &resolved)
                })
            })
            .collect()
    };
    let count = matched.len();
    let first = matched.first().cloned().unwrap_or(Value::Null);
    json!({
        "responses": matched,
        "count": count,
        "first": first,
        "found": count > 0,
    })
}

fn require_client<'a>(node: &GraphNode, deps: &'a RunDeps) -> Result<&'a Arc<FormLogicClient>, FlowError> {
    deps.client.as_ref().ok_or_else(|| {
        FlowError::new(
            FlowErrorCode::RunnerUnavailable,
            format!("Node '{}' needs a linked FormLogic account (none configured)", node.id),
            Some(node.id.clone()),
        )
    })
}

fn client_err(node: &GraphNode, e: impl std::fmt::Display) -> FlowError {
    FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': {e}", node.id), Some(node.id.clone()))
}

/// HTTP allow-list (docs §4): the FormLogic base URL ONLY. Deliberately does NOT fall through
/// to loopback — mirrors the browser executor's `isAllowedFlowUrl` (ui/src/client-runtime/flows/
/// nodes.ts), which likewise never treats loopback as implicitly allowed. Call sites that
/// legitimately need a local desktop service (the `service`-branch of `http_request`, and the
/// `browser_action`/`image_gen`/`stt_transcribe`/`tts_speak` node handlers) OR this explicitly
/// with `is_loopback_url` at the call site — exactly like their TS twins do.
fn is_allowed_flow_url(url: &str, base: &str) -> bool {
    let base = base.trim_end_matches('/');
    !base.is_empty() && (url == base || url.starts_with(&format!("{base}/")))
}

/// True for loopback-only http(s) URLs (127.0.0.1 / localhost / ::1). Uses REAL URL parsing
/// (`url::Url`, WHATWG URL Standard) rather than hand-rolled string splitting: a naive splitter
/// that only knows `/` and `@` as boundaries can be fooled by a fragment, e.g.
/// `http://attacker.example.com#@127.0.0.1/` — the `#` starts the fragment, so the actual host
/// (what `reqwest` resolves and connects to) is `attacker.example.com`, but a splitter ignorant
/// of `#` sees `@127.0.0.1` after its "first `/`" and misreads it as loopback. Matches the
/// browser executor's `isLoopbackUrl` (nodes.ts) semantics exactly, including checking the
/// bracketed form of an IPv6 literal (`Url::host_str()` keeps the brackets, same as
/// `URL.hostname` in JS) and treating an unparseable URL as not-loopback.
fn is_loopback_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    match parsed.host_str() {
        Some(h) => h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]",
        None => false,
    }
}

/// Execute one node. Returns its output value or a typed FlowError.
async fn execute_node(
    node: &GraphNode,
    scope: &SelectorScope,
    deps: &RunDeps,
    opts: &RunOptions,
) -> Result<Value, FlowError> {
    let data = node_data(node).clone();
    match node.node_type.as_str() {
        "input" => Ok(scope.inputs.clone().unwrap_or(json!({}))),

        "output" => Ok(if data.get("value").is_some() {
            resolve_deep(&data["value"], scope)
        } else {
            scope.upstream.clone().unwrap_or(Value::Null)
        }),

        "condition" => {
            let expr = require_string(node, &["expr", "expression", "condition"])?;
            // A declared data.timeoutMs (100ms..30s, docs §4) becomes the sandbox's real
            // deadline; when absent, eval_bool's QJS_TIMEOUT default applies, exactly as
            // before.
            let result = match clamp_declared_timeout(&data) {
                Some(timeout) => quickjs::eval_bool_with_timeout(&expr, &expr_context(scope), timeout).await,
                None => quickjs::eval_bool(&expr, &expr_context(scope)).await,
            };
            result
                .map(Value::Bool)
                .map_err(|e| FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': {e}", node.id), Some(node.id.clone())))
        }

        "template" => {
            let template = require_string(node, &["template", "text"])?;
            Ok(json!(interpolate_template(&template, &scope_to_context(scope))))
        }

        "logic_block" => {
            let expr = require_string(node, &["expr", "code", "expression"])?;
            // Read-only KV snapshot of the node's scope, best-effort.
            let mut ctx = expr_context(scope);
            let mut kv = json!({});
            if let Some(client) = &deps.client {
                if let Ok(map) = client.flow_kv_list(&kv_scope_for(&data, opts), deps.app_id.as_deref()).await {
                    kv = map;
                }
            }
            if let Value::Object(m) = &mut ctx {
                m.insert("kv".into(), kv);
            }
            // Same clamped-timeoutMs threading as `condition` above — the sandbox's real
            // deadline now matches the node's declared budget instead of always the fixed
            // QJS_TIMEOUT default.
            let result = match clamp_declared_timeout(&data) {
                Some(timeout) => quickjs::eval_expr_with_timeout(&expr, &ctx, timeout).await,
                None => quickjs::eval_expr(&expr, &ctx).await,
            };
            result.map_err(|e| FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': {e}", node.id), Some(node.id.clone())))
        }

        "llm_chat" => run_llm_chat(node, scope, deps).await,

        // Generic ServiceDefinition action (extensible-flows plan §7, slice 2): stable
        // definitionId/actionId/connection refs only — resolution, §6.5 schema validation,
        // credential injection and transport live in services::invocation (the
        // ServiceActionHost). §6.7 codes ride the message as `code: detail`.
        "service_action" => run_service_action(node, scope, deps).await,

        // Awaited flow-to-flow composition (extensible-flows plan §8): the dispatcher's
        // FlowInvoker executes the child INLINE on this worker (§15.6 — never re-enqueued
        // behind the parent on the single-flight relay lane).
        "flow_call" => run_flow_call(node, scope, deps, opts).await,

        "http_request" => run_http_request(node, scope, deps).await,

        // Desktop-service-backed nodes (docs §4) — drive a local loopback service.
        "browser_action" => run_browser_action(node, scope, deps).await,

        "image_gen" => run_image_gen(node, scope, deps).await,

        "stt_transcribe" => run_stt_transcribe(node, scope, deps).await,

        "tts_speak" => run_tts_speak(node, scope, deps).await,

        "desktop_services" => {
            // Read-only listing of the managed services (id/status/port +
            // loopback url when running) — lets a logic block resolve a
            // `service:<id>` source pick to a live endpoint at configure
            // time. Mirrors the browser executor: no registry → an empty
            // list, never an error (flows fall back to their legacy
            // custom-endpoint fields).
            let mut services: Vec<Value> = Vec::new();
            if let Some(reg) = deps.registry.as_ref() {
                if let Ok(reg) = reg.lock() {
                    for s in reg.snapshot().services {
                        let running = s.status == crate::services::registry::ServiceStatus::Running;
                        services.push(serde_json::json!({
                            "id": s.id,
                            "name": s.name,
                            "category": s.category,
                            "status": s.status,
                            "port": s.port,
                            "url": if running && s.port > 0 {
                                format!("http://127.0.0.1:{}", s.port)
                            } else {
                                String::new()
                            },
                        }));
                    }
                }
            }
            Ok(serde_json::json!({ "services": services }))
        }

        "formlogic_list_responses" => {
            // FROZEN CONTRACT (docs §4): resolve the form (invalid_flow when missing),
            // fetch up to a clamped `limit`, normalize, apply ANDed filters client-side,
            // and return { responses, count, first, found }.
            let form_id = resolve_form_ref(node, scope)?;
            let limit = clamp_list_limit(data.get("limit"));
            let client = require_client(node, deps)?;
            let pushdown = pushdown_eq_filters(data.get("filters"), scope);
            let raw = client
                .list_responses(&form_id, limit, &pushdown)
                .await
                .map_err(|e| client_err(node, e))?;
            Ok(apply_list_responses(&raw, data.get("filters"), scope))
        }

        "formlogic_submit_response" => {
            let form_id = resolve_form_ref(node, scope)?;
            let answers = resolve_deep(&data["answers"], scope);
            require_object(node, &answers)?;
            let client = require_client(node, deps)?;
            client.submit_response(&form_id, &answers, None).await.map_err(|e| client_err(node, e))
        }

        "formlogic_update_response" => {
            let form_id = resolve_form_ref(node, scope)?;
            let response_id = resolve_selector(&data["responseId"], scope);
            let rid = response_id.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
                FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}' responseId did not resolve", node.id), Some(node.id.clone()))
            })?;
            let answers = resolve_deep(&data["answers"], scope);
            require_object(node, &answers)?;
            let client = require_client(node, deps)?;
            client.update_response(&form_id, rid, &answers).await.map_err(|e| client_err(node, e))
        }

        "connector_request" => {
            let connector_id = require_string(node, &["connectorId", "connector"])?;
            let command = require_string(node, &["command"])?;
            let payload = if data.get("payload").is_some() {
                Some(resolve_deep(&data["payload"], scope))
            } else {
                None
            };
            let request_id = flow_connector_request_id(node, opts, deps, &connector_id, &command);
            connector_request(
                node,
                deps,
                &opts.capabilities,
                &connector_id,
                &command,
                payload,
                request_id,
            )
            .await
        }

        "aokie_speak" => {
            let text = if let Some(from) = data.get("textFrom").and_then(Value::as_str) {
                resolve_selector(&json!(from), scope)
            } else {
                json!(interpolate_template(&require_string(node, &["text", "message"])?, &scope_to_context(scope)))
            };
            let text = text.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
                FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}' aokie_speak text did not resolve to a string", node.id), Some(node.id.clone()))
            })?;
            // Phase 0 (cross-call safety): carry the call identity — the node's
            // explicit callIdFrom/callId, else the flow's own `callId` input — so
            // the plugin can refuse speech aimed at a call that already ended
            // (typed stale_call) instead of speaking it into the NEXT call.
            let call_id = if let Some(from) = data.get("callIdFrom").and_then(Value::as_str) {
                resolve_selector(&json!(from), scope)
            } else if let Some(lit) = data.get("callId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                json!(interpolate_template(lit, &scope_to_context(scope)))
            } else {
                resolve_selector(&json!("$inputs.callId"), scope)
            };
            let mut payload = json!({ "text": text });
            if let Some(cid) = call_id.as_str().filter(|s| !s.is_empty()) {
                payload["callId"] = json!(cid);
            }
            // §9.2 within-call staleness: carry the caller turn NUMBER this
            // reply answers — explicit inResponseToFrom/inResponseTo, else the
            // flow's own `turn` input (live-reply's binding seeds it).
            let in_response_to = if let Some(from) = data.get("inResponseToFrom").and_then(Value::as_str) {
                resolve_selector(&json!(from), scope)
            } else if let Some(n) = data.get("inResponseTo").and_then(Value::as_u64) {
                json!(n)
            } else {
                resolve_selector(&json!("$inputs.turn"), scope)
            };
            let turn_no = in_response_to
                .as_u64()
                .or_else(|| in_response_to.as_str().and_then(|s| s.parse::<u64>().ok()));
            if let Some(n) = turn_no {
                payload["inResponseTo"] = json!(n);
            }
            // Routed through the connector_request_allowing() helper: the same
            // capability gate as the "connector_request" node, plus typed
            // stale refusals (stale_call/stale_turn) resolve as a BENIGN SKIP —
            // the conversation moved on, and erroring would trip the binding's
            // fallback reply (another stale answer) (§9.1/§9.2).
            connector_request_allowing(
                node,
                deps,
                &opts.capabilities,
                "aokie",
                "call.operatorSpeak",
                Some(payload),
                flow_connector_request_id(node, opts, deps, "aokie", "call.operatorSpeak"),
                &["stale_call", "stale_turn"],
            )
            .await
        }

        "storage_get" => {
            let client = require_client(node, deps)?;
            let key = resolve_kv_key(node, scope)?;
            let v = client.flow_kv_get(&kv_scope_for(&data, opts), &key, deps.app_id.as_deref()).await
                .map_err(|e| client_err(node, e))?;
            Ok(v.unwrap_or(Value::Null))
        }

        "storage_set" => {
            if !opts.capabilities.iter().any(|c| c == KV_WRITE_CAPABILITY) {
                return Err(FlowError::new(
                    FlowErrorCode::CapabilityDenied,
                    format!("Node '{}' storage_set requires the '{KV_WRITE_CAPABILITY}' capability", node.id),
                    Some(node.id.clone()),
                ));
            }
            let client = require_client(node, deps)?;
            let key = resolve_kv_key(node, scope)?;
            let value = if let Some(vf) = data.get("valueFrom").and_then(Value::as_str) {
                resolve_selector(&json!(vf), scope)
            } else {
                resolve_deep(&data["value"], scope)
            };
            let sc = kv_scope_for(&data, opts);
            client.flow_kv_set(&sc, &key, &value, deps.app_id.as_deref()).await.map_err(|e| client_err(node, e))?;
            Ok(json!({ "stored": true, "scope": sc, "key": key }))
        }

        other => Err(FlowError::new(
            FlowErrorCode::InvalidFlow,
            format!("Unsupported node type '{other}' (node '{}')", node.id),
            Some(node.id.clone()),
        )),
    }
}

fn require_object(node: &GraphNode, v: &Value) -> Result<(), FlowError> {
    if v.is_object() {
        Ok(())
    } else {
        Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}' answers did not resolve to an object", node.id),
            Some(node.id.clone()),
        ))
    }
}

fn resolve_kv_key(node: &GraphNode, scope: &SelectorScope) -> Result<String, FlowError> {
    let raw = require_string(node, &["key", "k"])?;
    let resolved = resolve_selector(&json!(raw), scope);
    resolved.as_str().filter(|s| !s.is_empty()).map(str::to_string).ok_or_else(|| {
        FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}' key did not resolve to a string", node.id), Some(node.id.clone()))
    })
}

/// Shared by the "connector_request" and "aokie_speak" node types (the latter is sugar for
/// aokie/call.operatorSpeak) — gated by the SAME declare-then-grant capability model as
/// KV_WRITE_CAPABILITY: the flow must declare either the exact `connector.<id>.<command>`
/// capability or the connector-wide wildcard `connector.<id>.*` before it may dispatch here.
async fn connector_request(
    node: &GraphNode,
    deps: &RunDeps,
    capabilities: &[String],
    connector_id: &str,
    command: &str,
    payload: Option<Value>,
    request_id: Option<String>,
) -> Result<Value, FlowError> {
    connector_request_allowing(
        node,
        deps,
        capabilities,
        connector_id,
        command,
        payload,
        request_id,
        &[],
    )
    .await
}

/// A stable id for a connector command the owning plugin journals, so a retried
/// flow replays the same physical effect instead of repeating it. AOK-303: the
/// journalled surface comes from that plugin's manifest, which is why this now
/// needs `deps` — with no plugin gateway there is nothing to declare it (and
/// nothing to dispatch to either).
fn flow_connector_request_id(
    node: &GraphNode,
    opts: &RunOptions,
    deps: &RunDeps,
    connector_id: &str,
    command: &str,
) -> Option<String> {
    deps.host
        .as_ref()
        .is_some_and(|host| host.command_is_journalled(connector_id, command))
        .then(|| {
            connectors::stable_request_id(
                "flow-command",
                &[&opts.request_id_seed, &opts.flow_slug, &node.id, command],
            )
        })
}

/// Like [`connector_request`], but the listed typed connector error codes
/// resolve as a BENIGN SKIP (`{skipped: true, reason}`) instead of a node
/// failure. Used by speech nodes for stale refusals (§9.1/§9.2): a
/// stale_call/stale_turn means the conversation moved on — silence is the
/// correct outcome, and a node error would trip the binding's fallback
/// reply, speaking ANOTHER stale answer.
async fn connector_request_allowing(
    node: &GraphNode,
    deps: &RunDeps,
    capabilities: &[String],
    connector_id: &str,
    command: &str,
    payload: Option<Value>,
    request_id: Option<String>,
    benign_codes: &[&str],
) -> Result<Value, FlowError> {
    let exact = format!("connector.{connector_id}.{command}");
    let wildcard = format!("connector.{connector_id}.*");
    if !capabilities.iter().any(|c| c == &exact || c == &wildcard) {
        return Err(FlowError::new(
            FlowErrorCode::CapabilityDenied,
            format!("Node '{}' requires the '{exact}' capability — add `{exact}` or `{wildcard}` to the flow's nodeCapabilities", node.id),
            Some(node.id.clone()),
        ));
    }
    let host = deps.host.as_ref().ok_or_else(|| {
        FlowError::new(FlowErrorCode::RunnerUnavailable, format!("Node '{}': no local connector gateway", node.id), Some(node.id.clone()))
    })?;
    let body = ConnectorRequestBody {
        connector_id: Some(connector_id.to_string()),
        command: command.to_string(),
        payload,
        timeout_ms: None,
        request_id,
        ..Default::default()
    };
    match connectors::dispatch(host, connector_id, &body).await {
        Ok(v) => Ok(v),
        Err(f) if benign_codes.iter().any(|b| f.code == *b) => {
            Ok(json!({ "skipped": true, "reason": f.code }))
        }
        Err(f) => {
            let code = if f.code == "capability_denied" {
                FlowErrorCode::CapabilityDenied
            } else {
                FlowErrorCode::NodeFailed
            };
            Err(FlowError::new(code, format!("Node '{}' connector {connector_id}.{command}: {}", node.id, f.message), Some(node.id.clone())))
        }
    }
}

async fn run_http_request(node: &GraphNode, scope: &SelectorScope, deps: &RunDeps) -> Result<Value, FlowError> {
    let data = node_data(node);
    let raw_url = require_string(node, &["url"])?;
    let interpolated_url = interpolate_template(&raw_url, &scope_to_context(scope));
    // `data.service`, if set, is a STATIC, author-chosen service id — read directly off the
    // node's data, NEVER templated/selector-resolved. It pins WHICH desktop service is hit;
    // the (templatable) `url` becomes a PATH appended to that service's resolved loopback base
    // instead of being used as an absolute URL. This is what keeps the feature safe when
    // trigger/event data flows into `url`: an attacker who controls the trigger can influence
    // the PATH but never the host, because `service` is fixed at flow-authoring time. The
    // allow-list check below is skipped entirely in this branch — the service resolution IS
    // the trust boundary now, not the URL allow-list.
    // `.trim()` matches the browser runtime's `data.service.trim() !== ''` check (nodes.ts) so a
    // whitespace-only value is treated as absent in both runtimes, not just as absent-per-language.
    let url = if let Some(service) = data.get("service").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        // bundled=true: unlike stt_transcribe/tts_speak, http_request has no 'endpoint' property
        // to fall back to — the only fix is to start the named service (or fix `service`).
        let base = resolve_service_base(deps, service)
            .filter(|b| is_loopback_url(b))
            .ok_or_else(|| desktop_service_unavailable(node, service, true))?;
        format!("{}/{}", base.trim_end_matches('/'), interpolated_url.trim_start_matches('/'))
    } else {
        if !is_allowed_flow_url(&interpolated_url, &deps.base_url) {
            return Err(FlowError::new(
                FlowErrorCode::CapabilityDenied,
                format!("Node '{}' http_request URL is not allow-listed (FormLogic base or local services only)", node.id),
                Some(node.id.clone()),
            ));
        }
        interpolated_url
    };
    let method = data.get("method").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("GET").to_uppercase();
    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' bad method", node.id), Some(node.id.clone())))?;
    let mut req = deps.http.request(m.clone(), &url).header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(Value::Object(headers)) = data.get("headers") {
        for (k, v) in headers {
            if let Some(s) = v.as_str() {
                req = req.header(k.as_str(), s);
            }
        }
    }
    if data.get("body").is_some() && m != reqwest::Method::GET && m != reqwest::Method::HEAD {
        let b = resolve_deep(&data["body"], scope);
        req = req.body(serde_json::to_vec(&b).unwrap_or_default());
    }
    let resp = req.send().await.map_err(|e| client_err(node, format!("http_request failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
    Ok(json!({ "status": status.as_u16(), "ok": status.is_success(), "body": body }))
}

/// Best-effort: the first model id the OpenAI-compatible service at
/// `chat_endpoint` advertises (`…/v1/models`). Returns None on any failure, so a
/// server that serves a single model without needing the field (llama.cpp) is
/// unaffected, while Ollama — which rejects a model-less request — gets a model.
async fn discover_default_model(chat_endpoint: &str, http: &reqwest::Client) -> Option<String> {
    let models_url = chat_endpoint.replace("/chat/completions", "/models");
    let resp = http.get(&models_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let v = serde_json::from_str::<Value>(&text).ok()?;
    let data = v.get("data")?.as_array()?;
    for m in data {
        if let Some(id) = m.get("id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    None
}

/// Generic `service_action` node (extensible-flows plan §7, slice 2 v1). The node stores
/// ONLY stable references (§7.3): `definitionId`/`actionId` into the Desktop's v3 catalog
/// and an opaque `connection` (AI provider profile id). `input` is an object whose values
/// pass through the normal selector resolution; `timeoutMs` overrides the action's
/// declared budget within the standard node bounds.
async fn run_service_action(
    node: &GraphNode,
    scope: &SelectorScope,
    deps: &RunDeps,
) -> Result<Value, FlowError> {
    let definition_id = require_string(node, &["definitionId", "definition"])?;
    let action_id = require_string(node, &["actionId", "action"])?;
    let connection = require_string(node, &["connection", "provider"])?;
    let data = node_data(node);
    let input = data
        .get("input")
        .map(|raw| crate::flows::selectors::resolve_deep(raw, scope))
        .unwrap_or_else(|| json!({}));
    let timeout_override = clamp_declared_timeout(data).map(|d| d.as_millis() as u64);

    let node_err = |e: crate::services::invocation::InvokeError| {
        FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}': {}", node.id, e.to_message()),
            Some(node.id.clone()),
        )
    };
    let action = crate::services::invocation::resolve_action(&definition_id, &action_id).map_err(node_err)?;
    crate::services::invocation::invoke(&deps.http, &action, &connection, &input, timeout_override)
        .await
        .map_err(node_err)
}

/// `flow_call` (extensible-flows plan §8, desktop leg). data: flowId (STABLE id, §8.1),
/// input (selector-resolved object), failureMode ('fail-parent' default | 'route'),
/// timeoutMs. Output { status: 'succeeded'|'failed', result?, error?, runId } — the
/// executor routes Success/Failure handles by `status` (edge_is_active); fail-parent
/// fails the parent `child_flow_failed` so an unwired failure is loud. Resolution,
/// guards, reservation and inline execution live in the dispatcher's invoker
/// (RunDeps::invoke_child_flow) — identical contract to the browser's childFlowInvoker.
async fn run_flow_call(
    node: &GraphNode,
    scope: &SelectorScope,
    deps: &RunDeps,
    opts: &RunOptions,
) -> Result<Value, FlowError> {
    let target_flow_id = require_string(node, &["flowId", "flow"])?;
    let data = node_data(node);
    let failure_mode = data.get("failureMode").and_then(Value::as_str).unwrap_or("fail-parent");
    let input = data
        .get("input")
        .map(|raw| crate::flows::selectors::resolve_deep(raw, scope))
        .unwrap_or_else(|| json!({}));
    let timeout_override = clamp_declared_timeout(data).map(|d| d.as_millis() as u64);
    let refusal = |msg: String| {
        FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': {msg}", node.id), Some(node.id.clone()))
    };

    let Some(invoker) = deps.invoke_child_flow.as_ref() else {
        return Err(refusal("flow_call is not available in this context (no flow invoker)".into()));
    };
    if opts.call_stack.is_empty() {
        return Err(refusal("flow_call is not available in this context (no ancestry seed)".into()));
    }

    let envelope = invoker(ChildFlowRequest {
        target_flow_id: target_flow_id.clone(),
        inputs: input,
        call_node_id: node.id.clone(),
        call_stack: opts.call_stack.clone(),
        parent_run_id: opts.run_id.clone(),
        timeout_ms: timeout_override,
    })
    .await
    .map_err(refusal)?;

    let outcome = envelope.outcome;
    if outcome.status == "done" {
        return Ok(json!({
            "status": "succeeded",
            "result": outcome.result.unwrap_or(Value::Null),
            "runId": envelope.run_id,
        }));
    }
    let (code, message) = outcome
        .error
        .as_ref()
        .map(|e| (e.code.as_str().to_string(), e.message.clone()))
        .unwrap_or_else(|| (outcome.status.to_string(), format!("Child flow {}", outcome.status)));
    if failure_mode == "route" {
        return Ok(json!({
            "status": "failed",
            "error": { "code": code, "message": message },
            "runId": envelope.run_id,
        }));
    }
    Err(FlowError::new(
        FlowErrorCode::NodeFailed,
        format!("Node '{}': child_flow_failed: flow '{target_flow_id}' {code}: {message}", node.id),
        Some(node.id.clone()),
    ))
}

fn named_ai_provider_endpoint(provider: &str) -> Result<String, String> {
    let provider = provider
        .trim()
        .strip_prefix("provider:")
        .unwrap_or(provider.trim());
    if provider.is_empty()
        || provider.len() > 64
        || !provider
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(
            "llm_chat provider must be a provider id (lowercase letters, digits, and dashes)"
                .into(),
        );
    }
    Ok(format!(
        "http://127.0.0.1:{}/api/ai/providers/{provider}/v1/chat/completions",
        crate::COMPANION_PORT
    ))
}

const CODEX_BUSY_MAX_ATTEMPTS: usize = 7;
const CODEX_BUSY_BACKOFF_MS: [u64; CODEX_BUSY_MAX_ATTEMPTS - 1] =
    [250, 500, 750, 1_000, 1_250, 1_500];
const MAX_PROVIDER_ERROR_BODY_BYTES: usize = 8 * 1024;

fn is_typed_codex_busy(using_provider_gateway: bool, status: u16, body: &[u8]) -> bool {
    if !using_provider_gateway || status != 429 || body.len() > MAX_PROVIDER_ERROR_BODY_BYTES {
        return false;
    }
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|payload| {
            payload
                .pointer("/error/code")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some("codex_busy")
}

/// The system/messages/prompt assembly shared by the gateway and hosted-chat
/// paths (order + interpolation identical on both).
fn build_llm_messages(node: &GraphNode, data: &Value, tctx: &Value) -> Result<Vec<Value>, FlowError> {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = data.get("system").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": interpolate_template(sys, tctx) }));
    }
    if let Some(arr) = data.get("messages").and_then(Value::as_array) {
        for m in arr {
            if let (Some(role), Some(content)) = (m.get("role").and_then(Value::as_str), m.get("content").and_then(Value::as_str)) {
                messages.push(json!({ "role": role, "content": interpolate_template(content, tctx) }));
            }
        }
    }
    if let Some(prompt) = data.get("prompt").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "user", "content": interpolate_template(prompt, tctx) }));
    }
    if messages.is_empty() {
        return Err(FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' llm_chat has no prompt/messages", node.id), Some(node.id.clone())));
    }
    Ok(messages)
}

/// Phase 4 (plan §5.6): resolution of a provider-less/'default' llm_chat node
/// through the account owner's cached AI preferences.
#[derive(Debug)]
struct DefaultAiResolution {
    /// Desktop source: the owner's named local provider — the existing
    /// gateway path takes it from here.
    provider: Option<String>,
    /// Desktop source: the owner's pinned model, applied when the node set none.
    model: Option<String>,
    /// Site/custom source: POST {base}/api/ai/chat over the flk_ key.
    backend_chat: bool,
}

fn resolve_default_ai(deps: &RunDeps, node_id: &str) -> Result<DefaultAiResolution, FlowError> {
    use crate::ai::default_prefs::AiSource;
    let prefs = deps.default_ai_prefs.as_ref().and_then(|store| store.resolve());
    let Some(prefs) = prefs else {
        return Err(ai_default_unresolved(
            node_id,
            "the account owner's AI preferences have not been fetched yet — link FormLogic Desktop to the account and let it sync once, or pick an explicit provider on this node",
        ));
    };
    match prefs.ai_source {
        AiSource::Desktop => {
            let provider = prefs
                .desktop_provider_id
                .map(|id| id.trim().to_owned())
                .filter(|id| !id.is_empty());
            let Some(provider) = provider else {
                return Err(ai_default_unresolved(
                    node_id,
                    "the account's Default AI source is 'desktop' but no desktop provider is chosen in Settings → AI",
                ));
            };
            Ok(DefaultAiResolution {
                provider: Some(provider),
                model: prefs
                    .desktop_model
                    .map(|m| m.trim().to_owned())
                    .filter(|m| !m.is_empty()),
                backend_chat: false,
            })
        }
        AiSource::Site | AiSource::Custom => Ok(DefaultAiResolution {
            provider: None,
            model: None,
            backend_chat: true,
        }),
    }
}

/// The plan §5.8 typed code for an unresolvable Default source. The
/// flow-run-result schema's closed `code` enum has no member for it, so the
/// envelope stays `node_failed` and the typed code leads the message — the UI
/// keys off the token (same honesty, schema-compatible).
fn ai_default_unresolved(node_id: &str, detail: &str) -> FlowError {
    FlowError::new(
        FlowErrorCode::NodeFailed,
        format!("ai_default_unresolved — Node '{node_id}' llm_chat: {detail}"),
        Some(node_id.to_string()),
    )
}

/// Site/custom Default source (plan §5.6): the backend's hosted chat route
/// over the desktop's flk_ key — `{messages, stream:false}` → `{data:{content}}`,
/// metered to the account owner. No tools, no streaming (v1).
async fn run_site_default_chat(
    node: &GraphNode,
    deps: &RunDeps,
    data: &Value,
    tctx: &Value,
) -> Result<Value, FlowError> {
    let messages = build_llm_messages(node, data, tctx)?;
    let Some(client) = deps.client.as_ref() else {
        return Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!(
                "Node '{}' llm_chat cannot use the Default AI source because FormLogic Desktop is not linked to a FormLogic account",
                node.id
            ),
            Some(node.id.clone()),
        ));
    };
    let body = json!({ "messages": messages, "stream": false });
    let payload = client
        .site_ai_chat(&body)
        .await
        .map_err(|e| client_err(node, format!("llm_chat Default (site AI) request failed: {e}")))?;
    let content = payload.pointer("/data/content").and_then(Value::as_str);
    let Some(content) = content.filter(|c| !c.trim().is_empty()) else {
        return Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}' llm_chat Default (site AI) returned no content", node.id),
            Some(node.id.clone()),
        ));
    };
    Ok(json!({ "content": content, "raw": payload }))
}

async fn run_llm_chat(node: &GraphNode, scope: &SelectorScope, deps: &RunDeps) -> Result<Value, FlowError> {
    let data = node_data(node);
    let tctx = scope_to_context(scope);
    // A provider is an opaque Desktop reference, never a URL or credential.
    // It takes precedence over a legacy endpoint so the Background AI picker
    // has deterministic effect on an older saved flow.
    let provider = data
        .get("provider")
        .and_then(Value::as_str)
        .map(|value| interpolate_template(value, &tctx).trim().to_owned())
        .filter(|value| !value.is_empty());
    // Phase 4 (plan §5.6): absent/'default' resolves through the account
    // owner's AI preferences — NEVER a silent fallback to another source.
    // Explicit provider selections keep the historical path byte-for-byte.
    let mut prefs_model: Option<String> = None;
    let is_default = provider.as_deref().map_or(true, |p| p == "default");
    let (provider, backend_default) = if is_default {
        let resolved = resolve_default_ai(deps, &node.id)?;
        prefs_model = resolved.model;
        (resolved.provider, resolved.backend_chat)
    } else {
        (provider, false)
    };
    if backend_default {
        return run_site_default_chat(node, deps, data, &tctx).await;
    }
    let using_provider_gateway = provider.is_some();
    // Endpoint resolution: node.data.endpoint (allow-listed) → resolved local service.
    let endpoint = if let Some(provider) = provider.as_deref() {
        named_ai_provider_endpoint(provider).map_err(|message| {
            FlowError::new(
                FlowErrorCode::InvalidFlow,
                format!("Node '{}' {message}", node.id),
                Some(node.id.clone()),
            )
        })?
    } else if let Some(ep) = data.get("endpoint").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        if !is_allowed_flow_url(ep, &deps.base_url) {
            return Err(FlowError::new(
                FlowErrorCode::CapabilityDenied,
                format!("Node '{}' llm_chat endpoint is not allow-listed", node.id),
                Some(node.id.clone()),
            ));
        }
        ep.to_string()
    } else if let Some(local) = deps.llm_endpoint.as_deref().filter(|e| is_loopback_url(e)) {
        local.to_string()
    } else {
        return Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}' llm_chat has no AI endpoint — set the node's 'endpoint' or start a local AI service in FormLogic Desktop", node.id),
            Some(node.id.clone()),
        ));
    };
    let messages = build_llm_messages(node, data, &tctx)?;
    let mut body = json!({ "messages": messages });
    // Model may be templated ({{...}}) so a config record / upstream node can drive it.
    let model_str = data
        .get("model")
        .and_then(Value::as_str)
        .map(|m| interpolate_template(m, &tctx).trim().to_string())
        .filter(|m| !m.is_empty());
    if let Some(model) = model_str {
        body["model"] = json!(model);
    } else if let Some(model) = prefs_model {
        // The owner's Settings → AI model for the desktop Default source. The
        // gateway validates it fail-closed; nothing is substituted (plan §5.5).
        body["model"] = json!(model);
    } else if !using_provider_gateway {
        if let Some(m) = discover_default_model(&endpoint, &deps.http).await {
            // Ollama (and other strict OpenAI-compatible servers) reject a
            // model-less request. Named providers use their configured model.
            body["model"] = json!(m);
        }
    }
    if let Some(t) = data.get("temperature").and_then(Value::as_f64) {
        body["temperature"] = json!(t);
    }
    if let Some(mt) = data.get("maxTokens").and_then(Value::as_u64) {
        body["max_tokens"] = json!(mt);
    }
    // Pass-through extra request params (e.g. Qwen3's
    // `chat_template_kwargs: {enable_thinking: false}` to skip the reasoning
    // block for fast, direct replies). Merged last so it can override.
    if let (Some(extra), Some(obj)) = (
        data.get("extraBody").and_then(Value::as_object),
        body.as_object_mut(),
    ) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    // One bounded retry remains the default for transport errors, non-2xx and
    // empty replies. The Desktop Codex provider has a single-flight lane, so
    // its typed `codex_busy` response gets a separate bounded 5.25 s backoff
    // window. Generic 429s and arbitrary endpoints never enter that lane.
    let mut failure: Option<FlowError> = None;
    let mut extended_busy_lane = false;
    let mut next_delay_ms = 0;
    let mut busy_retry_count = 0;
    for attempt in 0..CODEX_BUSY_MAX_ATTEMPTS {
        if attempt >= 2 && !extended_busy_lane {
            break;
        }
        if next_delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(next_delay_ms)).await;
        }
        next_delay_ms = 750;
        let mut request = deps
            .http
            .post(&endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&body).unwrap_or_default());
        if using_provider_gateway {
            let token = crate::ai::gateway_token::token().ok_or_else(|| {
                FlowError::new(
                    FlowErrorCode::NodeFailed,
                    format!(
                        "Node '{}' cannot use the Desktop AI provider because the internal gateway credential is unavailable",
                        node.id
                    ),
                    Some(node.id.clone()),
                )
            })?;
            request = request.bearer_auth(token);
        }
        let resp = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                failure = Some(client_err(node, format!("llm_chat endpoint unreachable: {e}")));
                extended_busy_lane = false;
                if attempt > 0 {
                    break;
                }
                continue;
            }
        };
        if !resp.status().is_success() {
            let s = resp.status();
            let mut resp = resp;
            let mut error_body = Vec::new();
            while error_body.len() <= MAX_PROVIDER_ERROR_BODY_BYTES {
                match resp.chunk().await {
                    Ok(Some(chunk))
                        if error_body.len().saturating_add(chunk.len())
                            <= MAX_PROVIDER_ERROR_BODY_BYTES =>
                    {
                        error_body.extend_from_slice(&chunk);
                    }
                    Ok(Some(_)) | Err(_) => {
                        error_body.clear();
                        break;
                    }
                    Ok(None) => break,
                }
            }
            failure = Some(FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}' llm_chat responded {}", node.id, s.as_u16()), Some(node.id.clone())));
            if is_typed_codex_busy(using_provider_gateway, s.as_u16(), &error_body)
                && attempt + 1 < CODEX_BUSY_MAX_ATTEMPTS
            {
                extended_busy_lane = true;
                next_delay_ms = CODEX_BUSY_BACKOFF_MS[busy_retry_count];
                busy_retry_count += 1;
                continue;
            }
            extended_busy_lane = false;
            if attempt > 0 {
                break;
            }
            continue;
        }
        extended_busy_lane = false;
        let text = resp.text().await.unwrap_or_default();
        let payload: Value = match serde_json::from_str(&text) {
            Ok(p) => p,
            Err(_) => {
                failure = Some(FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}' llm_chat returned a non-JSON body", node.id), Some(node.id.clone())));
                continue;
            }
        };
        let content = payload.get("choices").and_then(Value::as_array).and_then(|a| a.first())
            .and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(Value::as_str);
        if attempt == 0 && content.map(str::trim).unwrap_or("").is_empty() {
            eprintln!("[flows] llm_chat node '{}' returned an empty completion — retrying once", node.id);
            continue;
        }
        return Ok(json!({ "content": content, "raw": payload }));
    }
    Err(failure.unwrap_or_else(|| {
        FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}' llm_chat failed", node.id), Some(node.id.clone()))
    }))
}

// ── Desktop-service-backed nodes (docs §4) ─────────────────────────────────────────────────
// browser_action / image_gen / stt_transcribe / tts_speak drive a LOCAL loopback service. The
// desktop runner resolves the service base from `service_bases` (test/pre-resolution seam) or the
// services registry (with a best-effort auto-start), then HTTP calls it. Unreachable → an
// ACTIONABLE node_failed (never "coming soon"). Byte-for-byte the browser executor's semantics
// (ui/src/client-runtime/flows/nodes.ts) so a flow runs identically here or in the browser.

/// The actionable failure raised when a desktop service can't be resolved/reached.
fn desktop_service_unavailable(node: &GraphNode, service: &str, bundled: bool) -> FlowError {
    let msg = if bundled {
        format!("This step runs on FormLogic Desktop. Install and start the {service} service in FormLogic Desktop → Services, then run the flow there.")
    } else {
        format!("This step needs a {service} service. Set the step's 'endpoint' to a running {service} endpoint (or start one in FormLogic Desktop → Services), then run the flow there.")
    };
    FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': {msg}", node.id), Some(node.id.clone()))
}

/// Resolve a service's loopback base URL: an explicit `service_bases` override (checked first,
/// used by tests/pre-resolution), else the services registry (`service_port` + best-effort
/// `ensure_by_port` auto-start). Only ever returns a loopback URL.
fn resolve_service_base(deps: &RunDeps, id: &str) -> Option<String> {
    if let Some(base) = deps.service_bases.get(id) {
        let b = base.trim_end_matches('/');
        return is_loopback_url(b).then(|| b.to_string());
    }
    let reg = deps.registry.as_ref()?;
    // Hold the std Mutex only for the sync resolve+ensure (never across an await).
    let mut r = reg.lock().ok()?;
    let port = r.service_port(id)?;
    // Kick a spawn if it's stopped — the HTTP call below already tolerates a warming server via
    // its transport-failure → actionable path, so we don't wait for readiness here.
    let _ = r.ensure_by_port(port);
    Some(format!("http://127.0.0.1:{port}"))
}

/// Parse a desktop service's JSON response, mapping a non-2xx / non-JSON body to node_failed.
async fn service_json_body(node: &GraphNode, human: &str, resp: reqwest::Response) -> Result<Value, FlowError> {
    if !resp.status().is_success() {
        return Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}': {human} service responded {}", node.id, resp.status().as_u16()),
            Some(node.id.clone()),
        ));
    }
    let text = resp.text().await.unwrap_or_default();
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|_| {
        FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': {human} service returned a non-JSON body", node.id), Some(node.id.clone()))
    })
}

/// POST JSON to a loopback service; transport failure → the actionable message.
async fn service_post_json(deps: &RunDeps, node: &GraphNode, url: &str, body: &Value, human: &str, bundled: bool) -> Result<Value, FlowError> {
    let resp = deps
        .http
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(body).unwrap_or_default())
        .send()
        .await
        .map_err(|_| desktop_service_unavailable(node, human, bundled))?;
    service_json_body(node, human, resp).await
}

/// GET JSON from a loopback service; transport failure → the actionable message.
async fn service_get_json(deps: &RunDeps, node: &GraphNode, url: &str, human: &str, bundled: bool) -> Result<Value, FlowError> {
    let resp = deps.http.get(url).send().await.map_err(|_| desktop_service_unavailable(node, human, bundled))?;
    service_json_body(node, human, resp).await
}

/// Standard-alphabet base64 (no deps) — for turning tts audio bytes into a data: URL.
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

const BROWSER_SERVICE: &str = "playwright-browser";
const BROWSER_HUMAN: &str = "Playwright Browser";
const IMAGE_SERVICE: &str = "krea2";
const IMAGE_HUMAN: &str = "Krea-2 Turbo (Text-to-Image)";
const SPEECH_SERVICE: &str = "aokie-voice";
const SPEECH_STT_SERVICE: &str = "aokie-stt";
const SPEECH_TTS_SERVICE: &str = "aokie-tts";

/// Default speech-service base for stt/tts when the node names NO endpoint and
/// NO service: prefer the dedicated split service (aokie-stt / aokie-tts) when
/// it's ALREADY RUNNING (or explicitly overridden via `service_bases`) — never
/// auto-started just because its template exists — else the combined
/// 'aokie-voice' service. The combined template is RETIRED (no longer seeded;
/// pristine copies are swept), so this fallback only fires for a user's
/// hand-edited copy — with neither present the caller gets the actionable
/// `desktop_service_unavailable` failure, never a silent substitution.
/// Mirrored in the browser executor (ui/src/client-runtime/flows/nodes.ts).
fn resolve_default_speech_base(deps: &RunDeps, preferred: &str) -> Option<String> {
    let preferred_available = deps.service_bases.contains_key(preferred)
        || deps
            .registry
            .as_ref()
            .and_then(|reg| reg.lock().ok().map(|r| r.service_running(preferred)))
            .unwrap_or(false);
    if preferred_available {
        if let Some(base) = resolve_service_base(deps, preferred) {
            return Some(base);
        }
    }
    resolve_service_base(deps, SPEECH_SERVICE)
}

/// Resolve the browser service BASE: node `endpoint` override (allow-listed) or the registry.
fn resolve_browser_base(node: &GraphNode, deps: &RunDeps) -> Result<String, FlowError> {
    let data = node_data(node);
    if let Some(ep) = data.get("endpoint").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let base = ep.trim_end_matches('/');
        if !is_allowed_flow_url(base, &deps.base_url) && !is_loopback_url(base) {
            return Err(FlowError::new(
                FlowErrorCode::CapabilityDenied,
                format!("Node '{}' endpoint is not allow-listed (a local loopback service or the FormLogic API only)", node.id),
                Some(node.id.clone()),
            ));
        }
        return Ok(base.to_string());
    }
    resolve_service_base(deps, BROWSER_SERVICE).ok_or_else(|| desktop_service_unavailable(node, BROWSER_HUMAN, true))
}

/// browser_action — drive the local Playwright Browser service (default port 17880).
async fn run_browser_action(node: &GraphNode, scope: &SelectorScope, deps: &RunDeps) -> Result<Value, FlowError> {
    let data = node_data(node).clone();
    let base = resolve_browser_base(node, deps)?;
    let action = data.get("action").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("goto");
    let tctx = scope_to_context(scope);

    // 1. Session — reuse a threaded sessionId, else create one.
    let session_ref = resolve_selector(data.get("sessionId").unwrap_or(&Value::Null), scope);
    let mut session_id = session_ref.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let mut created = false;
    if session_id.is_none() {
        let config = match data.get("config") {
            Some(v) if v.is_object() => v.clone(),
            _ => json!({}),
        };
        let r = service_post_json(deps, node, &format!("{base}/session"), &json!({ "config": config }), BROWSER_HUMAN, true).await?;
        let sid = r.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| {
            FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': browser session was not created", node.id), Some(node.id.clone()))
        })?;
        session_id = Some(sid.to_string());
        created = true;
    }
    let sid = session_id.unwrap();
    let s_path = format!("{base}/session/{sid}");
    let mut out = Map::new();
    out.insert("sessionId".into(), json!(sid));

    // 2. Navigate (when a url is provided).
    let url = data.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|u| interpolate_template(u, &tctx));
    if let Some(u) = &url {
        let mut nav = json!({ "url": u });
        if let Some(wu) = data.get("waitUntil").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            nav["waitUntil"] = json!(wu);
        }
        let r = service_post_json(deps, node, &format!("{s_path}/goto"), &nav, BROWSER_HUMAN, true).await?;
        out.insert("url".into(), r.get("url").cloned().unwrap_or(Value::Null));
        out.insert("title".into(), r.get("title").cloned().unwrap_or(Value::Null));
        out.insert("status".into(), r.get("status").cloned().unwrap_or(Value::Null));
    }

    // 3. Wait for a selector (when provided).
    if let Some(wf) = data.get("waitFor").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let mut w = json!({ "selector": wf });
        if let Some(t) = data.get("waitTimeoutMs").and_then(Value::as_u64) {
            w["timeoutMs"] = json!(t);
        }
        service_post_json(deps, node, &format!("{s_path}/wait"), &w, BROWSER_HUMAN, true).await?;
    }

    // 4. Perform the action.
    let selector = data.get("selector").and_then(Value::as_str).filter(|s| !s.is_empty());
    match action {
        "goto" => {
            if url.is_none() {
                return Err(FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' browser_action 'goto' needs a url", node.id), Some(node.id.clone())));
            }
        }
        "click" => {
            let sel = selector.ok_or_else(|| FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' browser_action 'click' needs a selector", node.id), Some(node.id.clone())))?;
            service_post_json(deps, node, &format!("{s_path}/action"), &json!({ "action": "click", "selector": sel }), BROWSER_HUMAN, true).await?;
        }
        "type" => {
            let sel = selector.ok_or_else(|| FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' browser_action 'type' needs a selector", node.id), Some(node.id.clone())))?;
            let text = data.get("text").and_then(Value::as_str).map(|t| interpolate_template(t, &tctx)).unwrap_or_default();
            service_post_json(deps, node, &format!("{s_path}/action"), &json!({ "action": "type", "selector": sel, "text": text }), BROWSER_HUMAN, true).await?;
        }
        "extract_text" => {
            let script = match selector {
                Some(s) => format!("(document.querySelector({})||{{}}).innerText||''", serde_json::to_string(s).unwrap_or_default()),
                None => "document.body?document.body.innerText:''".to_string(),
            };
            let r = service_post_json(deps, node, &format!("{s_path}/evaluate"), &json!({ "script": script }), BROWSER_HUMAN, true).await?;
            out.insert("text".into(), r.get("result").cloned().unwrap_or(Value::Null));
        }
        "extract_html" => {
            let r = service_get_json(deps, node, &format!("{s_path}/html"), BROWSER_HUMAN, true).await?;
            out.insert("html".into(), r.get("html").cloned().unwrap_or(Value::Null));
        }
        "screenshot" => {
            let full = crate::flows::selectors::js_truthy(data.get("fullPage"));
            let r = service_post_json(deps, node, &format!("{s_path}/screenshot"), &json!({ "fullPage": full }), BROWSER_HUMAN, true).await?;
            out.insert("dataUrl".into(), r.get("dataUrl").cloned().unwrap_or(Value::Null));
        }
        "evaluate" => {
            let script = require_string(node, &["script"])?;
            let r = service_post_json(deps, node, &format!("{s_path}/evaluate"), &json!({ "script": script }), BROWSER_HUMAN, true).await?;
            out.insert("result".into(), r.get("result").cloned().unwrap_or(Value::Null));
        }
        other => {
            return Err(FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' browser_action has an unknown action '{other}'", node.id), Some(node.id.clone())))
        }
    }

    // 5. Close a session we created only when asked (else keep it for threading).
    if created && crate::flows::selectors::js_truthy(data.get("closeSession")) {
        let _ = deps.http.delete(&s_path).send().await;
    }
    Ok(Value::Object(out))
}

/// image_gen — local Krea-2 (POST /generate → {imageUrl}) or an OpenAI-compatible images endpoint.
async fn run_image_gen(node: &GraphNode, scope: &SelectorScope, deps: &RunDeps) -> Result<Value, FlowError> {
    let data = node_data(node).clone();
    let service_id = data.get("service").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(IMAGE_SERVICE);
    let endpoint = if let Some(ep) = data.get("endpoint").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        if !is_allowed_flow_url(ep, &deps.base_url) && !is_loopback_url(ep) {
            return Err(FlowError::new(
                FlowErrorCode::CapabilityDenied,
                format!("Node '{}' image_gen endpoint is not allow-listed (a local loopback service or the FormLogic API only)", node.id),
                Some(node.id.clone()),
            ));
        }
        ep.to_string()
    } else {
        let base = resolve_service_base(deps, service_id).ok_or_else(|| desktop_service_unavailable(node, IMAGE_HUMAN, true))?;
        format!("{base}/generate")
    };
    let prompt = interpolate_template(&require_string(node, &["prompt"])?, &scope_to_context(scope));
    let width = data.get("width").and_then(Value::as_i64).unwrap_or(1024);
    let height = data.get("height").and_then(Value::as_i64).unwrap_or(1024);
    let mut body = json!({ "prompt": prompt, "width": width, "height": height, "size": format!("{width}x{height}") });
    if let Some(steps) = data.get("steps").and_then(Value::as_i64) {
        body["steps"] = json!(steps);
    }
    if let Some(model) = data.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        body["model"] = json!(model);
    }
    let r = service_post_json(deps, node, &endpoint, &body, IMAGE_HUMAN, true).await?;
    // krea2 native shape.
    if let Some(u) = r.get("imageUrl").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Ok(json!({ "imageUrl": u }));
    }
    // OpenAI-compatible images shape.
    if let Some(first) = r.get("data").and_then(Value::as_array).and_then(|a| a.first()) {
        if let Some(u) = first.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Ok(json!({ "imageUrl": u }));
        }
        if let Some(b) = first.get("b64_json").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Ok(json!({ "dataUrl": format!("data:image/png;base64,{b}") }));
        }
    }
    if let Some(u) = r.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Ok(json!({ "imageUrl": u }));
    }
    Err(FlowError::new(
        FlowErrorCode::NodeFailed,
        format!("Node '{}': image_gen response had no image (expected imageUrl or data[].url / data[].b64_json)", node.id),
        Some(node.id.clone()),
    ))
}

/// Resolve an OpenAI-compatible endpoint for stt/tts: node `endpoint` (allow-listed), a
/// `service` id resolved on the registry + `default_path`, else the default speech service —
/// a RUNNING dedicated split service (`preferred`: aokie-stt / aokie-tts) ahead of the
/// bundled combined 'aokie-voice'. No candidate → actionable failure.
fn resolve_configured_endpoint(node: &GraphNode, deps: &RunDeps, default_path: &str, human: &str, preferred: &str) -> Result<String, FlowError> {
    let data = node_data(node);
    if let Some(ep) = data.get("endpoint").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        if !is_allowed_flow_url(ep, &deps.base_url) && !is_loopback_url(ep) {
            return Err(FlowError::new(
                FlowErrorCode::CapabilityDenied,
                format!("Node '{}' endpoint is not allow-listed (a local loopback service or the FormLogic API only)", node.id),
                Some(node.id.clone()),
            ));
        }
        return Ok(ep.to_string());
    }
    if let Some(service) = data.get("service").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        if let Some(base) = resolve_service_base(deps, service) {
            return Ok(format!("{base}{default_path}"));
        }
    } else if let Some(base) = resolve_default_speech_base(deps, preferred) {
        // No endpoint/service configured: prefer the RUNNING dedicated split
        // service (aokie-stt / aokie-tts), else fall back to the bundled
        // 'aokie-voice' speech service — the same default-service pattern as
        // browser_action (playwright-browser) / image_gen (krea2). Mirrored in
        // the browser executor (ui/src/client-runtime/flows/nodes.ts). An
        // explicitly named service that fails to resolve still errors (no
        // silent substitution).
        return Ok(format!("{base}{default_path}"));
    }
    Err(desktop_service_unavailable(node, human, false))
}

/// stt_transcribe — speech → text via a configured OpenAI-compatible transcription endpoint.
async fn run_stt_transcribe(node: &GraphNode, scope: &SelectorScope, deps: &RunDeps) -> Result<Value, FlowError> {
    let data = node_data(node).clone();
    let endpoint = resolve_configured_endpoint(node, deps, "/v1/audio/transcriptions", "speech-to-text", SPEECH_STT_SERVICE)?;
    let audio_ref = resolve_selector(data.get("audio").unwrap_or(&Value::Null), scope);
    let audio = audio_ref.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
        FlowError::new(FlowErrorCode::InvalidFlow, format!("Node '{}' stt_transcribe needs 'audio' (a data URL / URL / base64)", node.id), Some(node.id.clone()))
    })?;
    let mut body = json!({ "audio": audio, "file": audio });
    if let Some(model) = data.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        body["model"] = json!(model);
    }
    let r = service_post_json(deps, node, &endpoint, &body, "speech-to-text", false).await?;
    let text = r.get("text").and_then(Value::as_str).or_else(|| r.get("result").and_then(Value::as_str)).unwrap_or("");
    Ok(json!({ "text": text }))
}

/// tts_speak — text → speech via a configured OpenAI-compatible endpoint (audio bytes → data URL).
async fn run_tts_speak(node: &GraphNode, scope: &SelectorScope, deps: &RunDeps) -> Result<Value, FlowError> {
    let data = node_data(node).clone();
    let endpoint = resolve_configured_endpoint(node, deps, "/v1/audio/speech", "text-to-speech", SPEECH_TTS_SERVICE)?;
    let input = interpolate_template(&require_string(node, &["text", "input"])?, &scope_to_context(scope));
    let mut body = json!({ "input": input });
    if let Some(model) = data.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        body["model"] = json!(model);
    }
    if let Some(voice) = data.get("voice").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        body["voice"] = json!(voice);
    }
    let resp = deps
        .http
        .post(&endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .send()
        .await
        .map_err(|_| desktop_service_unavailable(node, "text-to-speech", false))?;
    if !resp.status().is_success() {
        let s = resp.status();
        return Err(FlowError::new(FlowErrorCode::NodeFailed, format!("Node '{}': text-to-speech service responded {}", node.id, s.as_u16()), Some(node.id.clone())));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if content_type.contains("application/json") {
        let text = resp.text().await.unwrap_or_default();
        let j: Value = serde_json::from_str(&text).unwrap_or(json!({}));
        let url = j
            .get("audioUrl")
            .and_then(Value::as_str)
            .or_else(|| j.get("url").and_then(Value::as_str))
            .or_else(|| j.get("dataUrl").and_then(Value::as_str))
            .filter(|s| !s.is_empty());
        if let Some(u) = url {
            return Ok(if u.starts_with("data:") {
                json!({ "audioUrl": u, "dataUrl": u })
            } else {
                json!({ "audioUrl": u })
            });
        }
        let b64 = j
            .get("b64_json")
            .and_then(Value::as_str)
            .or_else(|| j.get("audio").and_then(Value::as_str))
            .filter(|s| !s.is_empty());
        if let Some(b) = b64 {
            let data_url = format!("data:audio/mpeg;base64,{b}");
            return Ok(json!({ "audioUrl": data_url, "dataUrl": data_url }));
        }
        return Err(FlowError::new(
            FlowErrorCode::NodeFailed,
            format!("Node '{}': text-to-speech response had no audio (expected audio bytes, audioUrl or b64_json)", node.id),
            Some(node.id.clone()),
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| client_err(node, format!("text-to-speech read failed: {e}")))?;
    let ct = if content_type.is_empty() { "audio/mpeg".to_string() } else { content_type };
    let data_url = format!("data:{ct};base64,{}", base64_encode(&bytes));
    Ok(json!({ "audioUrl": data_url, "dataUrl": data_url }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deps() -> RunDeps {
        RunDeps {
            client: None,
            host: None,
            app_id: None,
            http: reqwest::Client::new(),
            llm_endpoint: None,
            base_url: "http://formlogic.local".into(),
            registry: None,
            service_bases: HashMap::new(),
            default_ai_prefs: None,
            invoke_child_flow: None,
        }
    }

    fn opts() -> RunOptions {
        RunOptions {
            inputs: json!({ "x": 21 }),
            event: None,
            app: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            capabilities: vec![],
            flow_slug: "t".into(),
            request_id_seed: "test-run-1".into(),
            progress: None,
            call_stack: vec!["test-root-flow".into()],
            run_id: None,
        }
    }

    #[test]
    fn named_provider_endpoint_accepts_opaque_refs_and_rejects_url_shapes() {
        assert_eq!(
            named_ai_provider_endpoint("provider:openai-codex-agent").unwrap(),
            format!(
                "http://127.0.0.1:{}/api/ai/providers/openai-codex-agent/v1/chat/completions",
                crate::COMPANION_PORT
            )
        );
        assert!(named_ai_provider_endpoint("openai-platform-audio").is_ok());
        for invalid in ["", "Provider:openai", "https://example.com", "../openai", "open_ai"] {
            assert!(named_ai_provider_endpoint(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn only_typed_desktop_codex_busy_gets_the_extended_retry_lane() {
        let typed = br#"{"error":{"code":"codex_busy","message":"busy"}}"#;
        assert!(is_typed_codex_busy(true, 429, typed));
        assert!(!is_typed_codex_busy(false, 429, typed));
        assert!(!is_typed_codex_busy(true, 503, typed));
        assert!(!is_typed_codex_busy(
            true,
            429,
            br#"{"error":{"code":"rate_limited"}}"#
        ));
        assert!(!is_typed_codex_busy(true, 429, b"not-json"));
        assert!(!is_typed_codex_busy(
            true,
            429,
            &vec![b'x'; MAX_PROVIDER_ERROR_BODY_BYTES + 1]
        ));
    }

    /// `deps` carrying the real bundled Aokie manifest, so the journalled
    /// surface under test is the one the live phone line runs on.
    fn deps_with_aokie() -> RunDeps {
        let data = std::env::temp_dir().join(format!(
            "fl-runner-journalled-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let host = PluginHost::new(&data, false, crate::events::EventBus::new());
        host.install_builtin("aokie").expect("install aokie");
        RunDeps {
            host: Some(host),
            ..deps()
        }
    }

    // ── Phase 4 (plan §5.6): llm_chat "Default (from Settings)" resolution ────

    use crate::ai::default_prefs::{AiSource, DefaultAiPrefs, DefaultAiPrefsStore};

    fn prefs(source: AiSource) -> DefaultAiPrefs {
        DefaultAiPrefs {
            ai_source: source,
            desktop_provider_id: Some("local-llm".into()),
            desktop_model: Some("qwen3-9b".into()),
            custom_provider_id: Some("my-custom".into()),
            chat_tool_mode: Some("auto".into()),
        }
    }

    fn store_with(prefs: Option<DefaultAiPrefs>) -> Arc<DefaultAiPrefsStore> {
        let dir = std::env::temp_dir().join(format!("fl-runner-prefs-{}", uuid::Uuid::new_v4().simple()));
        let store = DefaultAiPrefsStore::new(&dir);
        if let Some(p) = prefs {
            store.seed_for_test(p);
        }
        store
    }

    fn llm_node(data: Value) -> GraphNode {
        GraphNode { id: "ai".into(), node_type: "llm_chat".into(), data }
    }

    fn empty_scope() -> SelectorScope {
        SelectorScope {
            inputs: None,
            event: None,
            app: None,
            nodes: None,
            upstream: None,
            data: None,
            result: None,
        }
    }

    #[test]
    fn default_resolution_needs_fetched_prefs() {
        // No store at all, and a store that never fetched: both fail closed.
        for deps in [
            RunDeps { default_ai_prefs: None, ..deps() },
            RunDeps { default_ai_prefs: Some(store_with(None)), ..deps() },
        ] {
            let err = resolve_default_ai(&deps, "ai").expect_err("unresolved prefs fail closed");
            assert_eq!(err.code, FlowErrorCode::NodeFailed);
            assert!(err.message.contains("ai_default_unresolved"), "got: {}", err.message);
        }
    }

    #[test]
    fn default_resolution_matrix_per_source() {
        // Desktop source → the owner's named local provider + model.
        let desktop_deps = RunDeps {
            default_ai_prefs: Some(store_with(Some(prefs(AiSource::Desktop)))),
            ..deps()
        };
        let resolved = resolve_default_ai(&desktop_deps, "ai").expect("desktop prefs resolve");
        assert_eq!(resolved.provider.as_deref(), Some("local-llm"));
        assert_eq!(resolved.model.as_deref(), Some("qwen3-9b"));
        assert!(!resolved.backend_chat);

        // Site + custom → the hosted backend chat route.
        for source in [AiSource::Site, AiSource::Custom] {
            let hosted_deps = RunDeps {
                default_ai_prefs: Some(store_with(Some(prefs(source)))),
                ..deps()
            };
            let resolved = resolve_default_ai(&hosted_deps, "ai").expect("site/custom prefs resolve");
            assert!(resolved.backend_chat, "{source:?} must ride the hosted route");
            assert!(resolved.provider.is_none());
        }

        // Desktop source without a chosen provider → typed unresolved, never a hop.
        let mut broken = prefs(AiSource::Desktop);
        broken.desktop_provider_id = None;
        let broken_deps = RunDeps {
            default_ai_prefs: Some(store_with(Some(broken))),
            ..deps()
        };
        let err = resolve_default_ai(&broken_deps, "ai").expect_err("missing provider id fails closed");
        assert!(err.message.contains("ai_default_unresolved"), "got: {}", err.message);
    }

    #[tokio::test]
    async fn llm_chat_absent_provider_without_prefs_is_typed_unresolved() {
        let node = llm_node(json!({ "prompt": "hi" }));
        let err = run_llm_chat(&node, &empty_scope(), &deps())
            .await
            .expect_err("absent provider + no prefs must not fall back anywhere");
        assert_eq!(err.code, FlowErrorCode::NodeFailed);
        assert!(err.message.contains("ai_default_unresolved"), "got: {}", err.message);
        assert_eq!(err.node_id.as_deref(), Some("ai"));
    }

    #[tokio::test]
    async fn llm_chat_default_site_source_posts_to_the_hosted_chat_route() {
        // The stub asserts the exact §5.6 contract: POST /api/ai/chat (NOT
        // /api/v1), flk_ bearer, {messages, stream:false} → {data:{content}}.
        let seen: Arc<std::sync::Mutex<Vec<(Option<String>, Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_in_handler = seen.clone();
        let app = axum::Router::new().route(
            "/api/ai/chat",
            axum::routing::post(move |headers: axum::http::HeaderMap, body: axum::Json<Value>| {
                let seen = seen_in_handler.clone();
                async move {
                    let auth = headers
                        .get(axum::http::header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    seen.lock().unwrap().push((auth, body.0));
                    axum::Json(json!({ "data": { "content": "pong from site" } }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind chat stub");
        let base = format!("http://{}", listener.local_addr().expect("stub address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = FormLogicClient::new(&crate::formlogic_client::FormLogicConfig {
            base_url: base,
            api_key: "flk_owner".into(),
        })
        .map(Arc::new);
        let deps = RunDeps {
            client,
            default_ai_prefs: Some(store_with(Some(prefs(AiSource::Site)))),
            ..deps()
        };
        let node = llm_node(json!({ "provider": "default", "system": "be terse", "prompt": "say hi" }));
        let out = run_llm_chat(&node, &empty_scope(), &deps)
            .await
            .expect("site source resolves through the hosted route");
        assert_eq!(out["content"], json!("pong from site"));
        assert_eq!(out["raw"]["data"]["content"], json!("pong from site"));

        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        let (auth, body) = &calls[0];
        assert_eq!(auth.as_deref(), Some("Bearer flk_owner"));
        assert_eq!(body["stream"], json!(false));
        assert_eq!(
            body["messages"],
            json!([
                { "role": "system", "content": "be terse" },
                { "role": "user", "content": "say hi" }
            ])
        );
    }

    #[tokio::test]
    async fn llm_chat_default_custom_source_also_uses_the_hosted_route() {
        let app = axum::Router::new().route(
            "/api/ai/chat",
            axum::routing::post(|| async { axum::Json(json!({ "data": { "content": "pong" } })) }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind chat stub");
        let base = format!("http://{}", listener.local_addr().expect("stub address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let client = FormLogicClient::new(&crate::formlogic_client::FormLogicConfig {
            base_url: base,
            api_key: "flk_owner".into(),
        })
        .map(Arc::new);
        // A provider-LESS node with custom source resolves the same way.
        let deps = RunDeps {
            client,
            default_ai_prefs: Some(store_with(Some(prefs(AiSource::Custom)))),
            ..deps()
        };
        let node = llm_node(json!({ "prompt": "hi" }));
        let out = run_llm_chat(&node, &empty_scope(), &deps)
            .await
            .expect("custom source resolves through the hosted route");
        assert_eq!(out["content"], json!("pong"));
    }

    #[tokio::test]
    async fn llm_chat_default_desktop_source_routes_to_the_local_gateway() {
        // The desktop source's provider id is handed to named_ai_provider_endpoint
        // (the local-gateway URL builder): an id it rejects surfaces as ITS typed
        // validation error — proving the node took the gateway path, never the
        // hosted route and never ai_default_unresolved. (Tests must not actually
        // reach the live loopback gateway, so the id is deliberately invalid.)
        let mut desktop = prefs(AiSource::Desktop);
        desktop.desktop_provider_id = Some("local_llm".into()); // '_' is rejected
        let deps = RunDeps {
            default_ai_prefs: Some(store_with(Some(desktop))),
            ..deps()
        };
        let node = llm_node(json!({ "provider": "default", "prompt": "hi" }));
        let err = run_llm_chat(&node, &empty_scope(), &deps)
            .await
            .expect_err("invalid owner provider id fails closed");
        assert_eq!(err.code, FlowErrorCode::InvalidFlow);
        assert!(
            err.message.contains("must be a provider id"),
            "the named-provider gateway path must see the owner's id, got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn llm_chat_explicit_provider_ignores_prefs_byte_for_byte() {
        // An explicit selection must behave exactly as before — prefs are not
        // consulted (an unresolved store would otherwise change the outcome to
        // ai_default_unresolved). The invalid id proves the request went into
        // named_ai_provider_endpoint, the historical explicit-provider path.
        let deps = RunDeps {
            default_ai_prefs: Some(store_with(None)), // unresolved on purpose
            ..deps()
        };
        let node = llm_node(json!({ "provider": "provider:local_llm", "prompt": "hi" }));
        let err = run_llm_chat(&node, &empty_scope(), &deps)
            .await
            .expect_err("invalid explicit provider id fails closed");
        assert_eq!(err.code, FlowErrorCode::InvalidFlow);
        assert!(
            err.message.contains("must be a provider id"),
            "explicit provider must keep the named-gateway path, got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn llm_chat_default_site_source_without_a_link_is_honest() {
        let deps = RunDeps {
            client: None, // unlinked desktop
            default_ai_prefs: Some(store_with(Some(prefs(AiSource::Site)))),
            ..deps()
        };
        let node = llm_node(json!({ "provider": "default", "prompt": "hi" }));
        let err = run_llm_chat(&node, &empty_scope(), &deps)
            .await
            .expect_err("no flk_ client → honest refusal, never a silent local hop");
        assert!(err.message.contains("not linked"), "got: {}", err.message);
    }

    #[test]
    fn physical_connector_effect_reuses_request_id_per_logical_flow_execution() {
        let deps = deps_with_aokie();
        let node = GraphNode {
            id: "reconnect-phone".into(),
            node_type: "connector_request".into(),
            data: Value::Null,
        };
        let first = flow_connector_request_id(&node, &opts(), &deps, "aokie", "phone.connect");
        let retry = flow_connector_request_id(&node, &opts(), &deps, "aokie", "phone.connect");
        assert_eq!(first, retry);
        assert!(first.as_deref().is_some_and(|id| id.len() <= 128));

        let mut next_execution = opts();
        next_execution.request_id_seed = "test-run-2".into();
        assert_ne!(
            first,
            flow_connector_request_id(&node, &next_execution, &deps, "aokie", "phone.connect")
        );
        assert_eq!(
            flow_connector_request_id(&node, &opts(), &deps, "aokie", "phone.status"),
            None,
            "a read command is not journalled"
        );
    }

    /// The id is minted from the plugin's declaration, so an unknown connector
    /// (and a run with no plugin gateway at all) mints nothing — matching the
    /// dispatch that would fail with `connector_missing` anyway.
    #[test]
    fn only_a_declaring_plugin_makes_a_command_journalled() {
        let node = GraphNode {
            id: "n".into(),
            node_type: "connector_request".into(),
            data: Value::Null,
        };
        assert_eq!(
            flow_connector_request_id(&node, &opts(), &deps_with_aokie(), "widget", "phone.connect"),
            None,
            "no plugin exposes the 'widget' connector"
        );
        assert_eq!(
            flow_connector_request_id(&node, &opts(), &deps(), "aokie", "phone.connect"),
            None,
            "no plugin gateway ⇒ nothing declares anything"
        );
    }

    #[tokio::test]
    async fn linear_input_template_output() {
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "t", "type": "template", "data": { "template": "x={{inputs.x}}" } },
                { "id": "out", "type": "output", "data": { "value": "$upstream" } }
            ],
            "edges": [ { "source": "in", "target": "t" }, { "source": "t", "target": "out" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "done");
        assert_eq!(out.result, Some(json!("x=21")));
        assert_eq!(out.nodes_executed, 3);
    }

    #[tokio::test]
    async fn condition_routes_true_branch() {
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "c", "type": "condition", "data": { "expr": "inputs.x > 10" } },
                { "id": "yes", "type": "output", "data": { "value": "big" } },
                { "id": "no", "type": "output", "data": { "value": "small" } }
            ],
            "edges": [
                { "source": "in", "target": "c" },
                { "source": "c", "target": "yes", "sourceHandle": "true" },
                { "source": "c", "target": "no", "sourceHandle": "false" }
            ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "done");
        assert_eq!(out.result, Some(json!("big")));
    }

    #[tokio::test]
    async fn condition_with_both_branches_to_one_node_passes_a_plain_upstream() {
        // Regression (extensible-flows plan §3.1): activation used to be keyed
        // `${source}→${target}`, so the UNTAKEN branch shared the taken branch's key and
        // the join node saw a merged {"c": value} map instead of the plain value. Keyed by
        // edge index now — identical to the browser executor's fix (flowExecutor.test.ts).
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "c", "type": "condition", "data": { "expr": "inputs.x > 10" } },
                { "id": "join", "type": "output" }
            ],
            "edges": [
                { "source": "in", "target": "c" },
                { "source": "c", "target": "join", "sourceHandle": "true" },
                { "source": "c", "target": "join", "sourceHandle": "false" }
            ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "done");
        assert_eq!(out.result, Some(json!(true))); // plain condition output, NOT {"c": true}
        assert_eq!(out.nodes_executed, 3);
    }

    #[tokio::test]
    async fn graph_v2_edge_ids_are_validated_when_present() {
        let base = json!({
            "nodes": [ { "id": "a", "type": "input" }, { "id": "b", "type": "output" } ]
        });
        let with_edges = |edges: Value| {
            let mut f = base.clone();
            f["edges"] = edges;
            f
        };
        // Valid: unique string ids (mixed with id-less legacy edges).
        let ok = execute_flow(
            &with_edges(json!([{ "id": "e1", "source": "a", "target": "b" }, { "source": "a", "target": "b" }])),
            &deps(),
            &opts(),
        )
        .await;
        assert_eq!(ok.status, "done");
        // Invalid: empty id.
        let bad = execute_flow(
            &with_edges(json!([{ "id": "", "source": "a", "target": "b" }])),
            &deps(),
            &opts(),
        )
        .await;
        assert_eq!(bad.status, "error");
        assert!(bad.error.as_ref().unwrap().message.contains("invalid id"), "got: {:?}", bad.error);
        // Invalid: duplicate ids.
        let dup = execute_flow(
            &with_edges(json!([
                { "id": "dup", "source": "a", "target": "b" },
                { "id": "dup", "source": "a", "target": "b", "sourceHandle": "x" }
            ])),
            &deps(),
            &opts(),
        )
        .await;
        assert_eq!(dup.status, "error");
        assert!(dup.error.as_ref().unwrap().message.contains("Duplicate flow edge id"), "got: {:?}", dup.error);
    }

    #[tokio::test]
    async fn service_action_surfaces_typed_invocation_codes() {
        // Unknown definition → service_unavailable, attributed to the node (§6.7 taxonomy
        // rides the message as `code: detail`).
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "svc", "type": "service_action", "data": {
                    "definitionId": "nope", "actionId": "x", "connection": "openai-platform" } }
            ],
            "edges": [ { "source": "in", "target": "svc" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        let err = out.error.expect("error envelope");
        assert!(err.message.contains("service_unavailable"), "got: {}", err.message);
        assert_eq!(err.node_id.as_deref(), Some("svc"));
    }

    #[tokio::test]
    async fn service_action_validates_input_before_any_transport() {
        // chat.complete requires `messages`; the §6.5 subset validator refuses BEFORE any
        // gateway/credential work — no provider profile exists in this test environment.
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "svc", "type": "service_action", "data": {
                    "definitionId": "openai-api", "actionId": "chat.complete",
                    "connection": "openai-platform", "input": { "model": "gpt-x" } } }
            ],
            "edges": [ { "source": "in", "target": "svc" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        let err = out.error.expect("error envelope");
        assert!(err.message.contains("input_invalid"), "got: {}", err.message);
        assert!(err.message.contains("messages"), "names the missing property: {}", err.message);
    }

    /// RunDeps with a canned flow_call invoker (no dispatcher/server needed).
    fn deps_with_child_invoker(envelope: fn() -> Result<ChildFlowEnvelope, String>) -> RunDeps {
        RunDeps {
            invoke_child_flow: Some(Arc::new(move |_req| Box::pin(async move { envelope() }))),
            ..deps()
        }
    }

    #[tokio::test]
    async fn flow_call_routes_success_and_failure_handles_like_the_browser() {
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "call", "type": "flow_call", "data": { "flowId": "child-1", "failureMode": "route" } },
                { "id": "ok", "type": "output", "data": { "value": "took success" } },
                { "id": "bad", "type": "output", "data": { "value": "took failure" } }
            ],
            "edges": [
                { "source": "in", "target": "call" },
                { "source": "call", "target": "ok", "sourceHandle": "success" },
                { "source": "call", "target": "bad", "sourceHandle": "failure" }
            ]
        });
        let ok_deps = deps_with_child_invoker(|| {
            Ok(ChildFlowEnvelope {
                outcome: FlowOutcome::done(json!({ "msg": "hi" }), 1),
                run_id: Some("run-child".into()),
            })
        });
        let out = execute_flow(&flow, &ok_deps, &opts()).await;
        assert_eq!(out.status, "done");
        assert_eq!(out.result, Some(json!("took success")));

        let fail_deps = deps_with_child_invoker(|| {
            Ok(ChildFlowEnvelope {
                outcome: FlowOutcome::err(
                    FlowError::new(FlowErrorCode::Timeout, "child ran out of time", None),
                    1,
                ),
                run_id: Some("run-child".into()),
            })
        });
        let out = execute_flow(&flow, &fail_deps, &opts()).await;
        assert_eq!(out.status, "done"); // the PARENT succeeds — the failure path handled it
        assert_eq!(out.result, Some(json!("took failure")));
    }

    #[tokio::test]
    async fn flow_call_fail_parent_default_and_invoker_refusals_are_typed() {
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "call", "type": "flow_call", "data": { "flowId": "child-1" } }
            ],
            "edges": [ { "source": "in", "target": "call" } ]
        });
        // fail-parent (default): the child's typed error fails the parent loudly.
        let fail_deps = deps_with_child_invoker(|| {
            Ok(ChildFlowEnvelope {
                outcome: FlowOutcome::err(FlowError::new(FlowErrorCode::NodeFailed, "boom", None), 1),
                run_id: None,
            })
        });
        let out = execute_flow(&flow, &fail_deps, &opts()).await;
        assert_eq!(out.status, "error");
        let err = out.error.expect("error envelope");
        assert!(err.message.contains("child_flow_failed"), "got: {}", err.message);
        assert_eq!(err.node_id.as_deref(), Some("call"));

        // Invoker refusal (guards live in the dispatcher) surfaces its §6.7 code prefix.
        let refused = deps_with_child_invoker(|| Err("recursion_detected: flow 'x' is already running".into()));
        let out = execute_flow(&flow, &refused, &opts()).await;
        assert!(out.error.expect("error").message.contains("recursion_detected"));

        // No invoker at all (deps()) → typed refusal, mirroring the browser's absent dep.
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert!(out.error.expect("error").message.contains("not available in this context"));

        // Invoker present but no ancestry seed (inline runs) → typed refusal too.
        let mut bare = opts();
        bare.call_stack = vec![];
        let ok_deps = deps_with_child_invoker(|| {
            Ok(ChildFlowEnvelope { outcome: FlowOutcome::done(json!({}), 1), run_id: None })
        });
        let out = execute_flow(&flow, &ok_deps, &bare).await;
        assert!(out.error.expect("error").message.contains("no ancestry seed"));
    }

    /// A busy-wait expression that blocks for roughly `ms` milliseconds (deterministic CPU
    /// spin — the qjs guest environment has no timer API).
    fn busy_wait_expr(ms: u64, return_value: &str) -> String {
        format!(
            "(function(){{ var s = Date.now(); while (Date.now() - s < {ms}) {{}} return {return_value}; }})()"
        )
    }

    #[tokio::test]
    async fn logic_block_honors_a_longer_declared_timeout_than_the_default() {
        // 1.2s of real work: past a tight declared budget but well inside a longer one —
        // proves data.timeoutMs, not the fixed QJS_TIMEOUT default, is the real deadline.
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "lb", "type": "logic_block", "data": { "expr": busy_wait_expr(1200, "99"), "timeoutMs": 6000 } },
                { "id": "out", "type": "output", "data": { "value": "$upstream" } }
            ],
            "edges": [ { "source": "in", "target": "lb" }, { "source": "lb", "target": "out" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "done");
        assert_eq!(out.result, Some(json!(99)));
    }

    #[tokio::test]
    async fn logic_block_fails_the_flow_using_its_own_declared_timeout_value() {
        // A genuinely-too-slow script (800ms) against a SHORT declared budget (300ms) —
        // well UNDER the fixed 2s default, so this only fails if the node's own value is
        // actually threaded through (not the hardcoded default). Rust already fails the
        // whole flow on a QuickJS timeout for both node types; only the deadline value
        // used is new.
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "lb", "type": "logic_block", "data": { "expr": busy_wait_expr(800, "1"), "timeoutMs": 300 } }
            ],
            "edges": [ { "source": "in", "target": "lb" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        let err = out.error.unwrap();
        assert_eq!(err.code, FlowErrorCode::NodeFailed);
        assert!(err.message.contains("300ms"), "message should cite the declared 300ms deadline: {}", err.message);
    }

    #[tokio::test]
    async fn condition_honors_a_longer_declared_timeout_than_the_default() {
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "c", "type": "condition", "data": { "expr": busy_wait_expr(1200, "true"), "timeoutMs": 6000 } },
                { "id": "yes", "type": "output", "data": { "value": "big" } },
                { "id": "no", "type": "output", "data": { "value": "small" } }
            ],
            "edges": [
                { "source": "in", "target": "c" },
                { "source": "c", "target": "yes", "sourceHandle": "true" },
                { "source": "c", "target": "no", "sourceHandle": "false" }
            ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "done");
        assert_eq!(out.result, Some(json!("big")));
    }

    #[tokio::test]
    async fn condition_fails_the_flow_using_its_own_declared_timeout_value() {
        let flow = json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "c", "type": "condition", "data": { "expr": busy_wait_expr(800, "true"), "timeoutMs": 300 } }
            ],
            "edges": [ { "source": "in", "target": "c" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        let err = out.error.unwrap();
        assert_eq!(err.code, FlowErrorCode::NodeFailed);
        assert!(err.message.contains("300ms"), "message should cite the declared 300ms deadline: {}", err.message);
    }

    #[tokio::test]
    async fn cycle_is_invalid_flow() {
        let flow = json!({
            "nodes": [ { "id": "a", "type": "template", "data": { "template": "x" } }, { "id": "b", "type": "template", "data": { "template": "y" } } ],
            "edges": [ { "source": "a", "target": "b" }, { "source": "b", "target": "a" } ]
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        assert_eq!(out.error.unwrap().code, FlowErrorCode::InvalidFlow);
    }

    #[tokio::test]
    async fn unknown_node_type_fails_loudly() {
        let flow = json!({ "nodes": [ { "id": "a", "type": "input" }, { "id": "b", "type": "quantum_flux" } ], "edges": [ { "source": "a", "target": "b" } ] });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        let e = out.error.unwrap();
        assert_eq!(e.code, FlowErrorCode::InvalidFlow);
        assert_eq!(e.node_id.as_deref(), Some("b"));
    }

    #[tokio::test]
    async fn node_budget_is_enforced() {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for i in 0..(FLOW_NODE_BUDGET + 5) {
            nodes.push(json!({ "id": format!("n{i}"), "type": "template", "data": { "template": "x" } }));
            if i > 0 {
                edges.push(json!({ "source": format!("n{}", i - 1), "target": format!("n{i}") }));
            }
        }
        let flow = json!({ "nodes": nodes, "edges": edges });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        assert_eq!(out.error.unwrap().code, FlowErrorCode::InvalidFlow);
    }

    #[tokio::test]
    async fn storage_set_requires_capability() {
        let flow = json!({
            "nodes": [ { "id": "s", "type": "storage_set", "data": { "key": "k", "value": 1 } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
    }

    // ── connector_request / aokie_speak capability gate ─────────────────────
    // `deps().host` is None, so a request that clears the capability gate falls through to
    // RunnerUnavailable (no real plugin gateway) rather than actually dispatching — that's
    // the "stub" for these tests: it proves the gate was passed without needing a real plugin.

    fn opts_with_capabilities(caps: &[&str]) -> RunOptions {
        RunOptions { capabilities: caps.iter().map(|s| s.to_string()).collect(), ..opts() }
    }

    #[tokio::test]
    async fn connector_request_requires_capability_when_none_declared() {
        let flow = json!({
            "nodes": [ { "id": "c", "type": "connector_request", "data": { "connectorId": "aokie", "command": "call.operatorSpeak" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts_with_capabilities(&[])).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
    }

    #[tokio::test]
    async fn aokie_speak_requires_capability_when_none_declared() {
        // Proves the aokie_speak sugar path is gated too, not just the raw connector_request node.
        let flow = json!({
            "nodes": [ { "id": "a", "type": "aokie_speak", "data": { "text": "hi" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts_with_capabilities(&[])).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
    }

    #[tokio::test]
    async fn connector_request_exact_capability_clears_the_gate() {
        let flow = json!({
            "nodes": [ { "id": "c", "type": "connector_request", "data": { "connectorId": "aokie", "command": "call.operatorSpeak" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts_with_capabilities(&["connector.aokie.call.operatorSpeak"])).await;
        // Not capability_denied: it got past the gate and failed for the unrelated reason
        // that this test's deps() has no plugin host.
        assert_eq!(out.error.unwrap().code, FlowErrorCode::RunnerUnavailable);
    }

    #[tokio::test]
    async fn connector_request_wildcard_capability_clears_the_gate() {
        let flow = json!({
            "nodes": [ { "id": "c", "type": "connector_request", "data": { "connectorId": "aokie", "command": "call.operatorSpeak" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts_with_capabilities(&["connector.aokie.*"])).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::RunnerUnavailable);
    }

    #[tokio::test]
    async fn aokie_speak_wildcard_capability_clears_the_gate() {
        let flow = json!({
            "nodes": [ { "id": "a", "type": "aokie_speak", "data": { "text": "hi" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts_with_capabilities(&["connector.aokie.*"])).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::RunnerUnavailable);
    }

    #[tokio::test]
    async fn connector_request_other_connectors_capability_does_not_grant_aokie() {
        let flow = json!({
            "nodes": [ { "id": "c", "type": "connector_request", "data": { "connectorId": "aokie", "command": "call.operatorSpeak" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts_with_capabilities(&["connector.other.*"])).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
    }

    #[tokio::test]
    async fn http_request_rejects_non_allowlisted_url() {
        let flow = json!({
            "nodes": [ { "id": "h", "type": "http_request", "data": { "url": "https://evil.example/x" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
    }

    // (f) The bare (non-`service`) http_request branch must NOT reach loopback — only the
    // FormLogic base URL. Before the fix, `is_allowed_flow_url`'s fallthrough silently allowed
    // this for every caller, including this one.
    #[tokio::test]
    async fn http_request_bare_branch_rejects_plain_loopback() {
        let flow = json!({
            "nodes": [ { "id": "h", "type": "http_request", "data": { "url": "http://127.0.0.1:5000/" } } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.error.unwrap().code, FlowErrorCode::CapabilityDenied);
    }

    // (e) Base-URL matching (the sole remaining branch of `is_allowed_flow_url`) is unaffected
    // by the loopback split, and a non-base host is still rejected.
    #[test]
    fn allow_list_matches_base_but_not_bare_loopback() {
        assert!(is_allowed_flow_url("http://formlogic.local/api/v1/flows", "http://formlogic.local"));
        assert!(!is_allowed_flow_url("https://evil.example/api", "http://formlogic.local"));
        // Loopback is real (`is_loopback_url` says so)...
        assert!(is_loopback_url("http://127.0.0.1:11434/v1/chat/completions"));
        // ...but `is_allowed_flow_url` alone no longer grants it (this is the second bug's
        // fix): only call sites that explicitly OR it with `is_loopback_url` — the
        // service-backed node handlers — get loopback access.
        assert!(!is_allowed_flow_url("http://127.0.0.1:11434/v1/chat/completions", "http://formlogic.local"));
    }

    // (c), (d) Genuinely loopback URLs — including a port, bare localhost, and a bracketed IPv6
    // literal — are still correctly identified after the rewrite to real URL parsing.
    #[test]
    fn is_loopback_url_accepts_real_loopback() {
        assert!(is_loopback_url("http://127.0.0.1:8080/foo"));
        assert!(is_loopback_url("http://localhost/"));
        assert!(is_loopback_url("http://localhost:8080/x"));
        assert!(is_loopback_url("http://[::1]/"));
    }

    // (a) The confirmed adversarial PoC: a fragment (`#`) is never part of the authority per the
    // WHATWG URL Standard, so the real (and only) host here is `attacker.example.com` — exactly
    // what `reqwest` resolves and connects to. The old hand-rolled splitter didn't know about
    // `#` and misread the `@127.0.0.1/` trailing the fragment as loopback.
    #[test]
    fn is_loopback_url_rejects_fragment_userinfo_spoof() {
        let url = "http://attacker.example.com#@127.0.0.1/";
        assert_eq!(url::Url::parse(url).unwrap().host_str(), Some("attacker.example.com"));
        assert!(!is_loopback_url(url));
        assert!(!is_allowed_flow_url(url, "http://formlogic.local"));
    }

    // (b) The same class of bug via literal userinfo syntax instead of a fragment: `user@host`
    // means `127.0.0.1` is discarded as userinfo and `attacker.example.com` is the real host.
    #[test]
    fn is_loopback_url_rejects_userinfo_spoof() {
        let url = "http://127.0.0.1@attacker.example.com/";
        assert_eq!(url::Url::parse(url).unwrap().host_str(), Some("attacker.example.com"));
        assert!(!is_loopback_url(url));
        assert!(!is_allowed_flow_url(url, "http://formlogic.local"));
    }

    // ── formlogic_list_responses FROZEN CONTRACT parity ───────────────────────
    // These vectors are copied verbatim from the browser executor's unit test
    // (ui/src/client-runtime/flows/nodes.test.ts) — same canned rows in, same
    // { count, first, found, filtered rows } out. The node handler is a thin
    // wrapper (resolve form → FormLogicClient::list_responses → apply_list_
    // responses); the client fetch is integration-tested separately, so here we
    // exercise the frozen normalize/filter contract directly with canned rows,
    // the missing-form error (through execute_flow), and the limit clamp.

    fn customers() -> Vec<Value> {
        vec![
            json!({ "id": "r1", "answers": { "name": "Alex", "phone": "+61400111222", "age": 30, "tag": "vip" }, "submittedAt": "2026-01-01T00:00:00Z", "status": "submitted" }),
            json!({ "id": "r2", "answers": { "name": "Blair", "phone": "+61400999888", "age": 52, "tag": "lead" } }),
            json!({ "id": "r3", "answers": { "name": "Casey", "phone": "+61400111222", "age": 41, "tag": "vip" } }),
        ]
    }

    #[test]
    fn list_responses_no_filters_structured_output() {
        let out = apply_list_responses(&customers(), None, &SelectorScope::default());
        assert_eq!(out["count"], json!(3));
        assert_eq!(out["found"], json!(true));
        assert_eq!(out["first"]["id"], json!("r1"));
        assert_eq!(out["responses"].as_array().unwrap().len(), 3);
        // Rows are normalized to { id, answers, submittedAt?, status? }.
        assert_eq!(out["responses"][0]["id"], json!("r1"));
        assert_eq!(out["responses"][0]["answers"]["name"], json!("Alex"));
        assert_eq!(out["responses"][0]["submittedAt"], json!("2026-01-01T00:00:00Z"));
        assert_eq!(out["responses"][0]["status"], json!("submitted"));
        // Rows without submittedAt/status omit those keys.
        assert!(out["responses"][1].get("submittedAt").is_none());
        assert!(out["responses"][1].get("status").is_none());
    }

    #[test]
    fn list_responses_eq_filter() {
        let filters = json!([{ "field": "phone", "op": "eq", "value": "+61400111222" }]);
        let out = apply_list_responses(&customers(), Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(2));
        assert_eq!(out["found"], json!(true));
        assert_eq!(out["first"]["id"], json!("r1"));
    }

    #[test]
    fn list_responses_phone_eq_matches_across_formats() {
        // Digits-only last-9 suffix: '0400 111-222' matches '+61400111222'.
        let filters = json!([{ "field": "phone", "op": "phone_eq", "value": "0400 111-222" }]);
        let out = apply_list_responses(&customers(), Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(2)); // r1 + r3 share the number
        assert_eq!(out["first"]["id"], json!("r1"));
        // Short fragments never match (would otherwise match everything).
        assert!(!phone_digits_match("222", "0400111222"));
        assert!(phone_digits_match("+61 491 570 156", "0491570156"));
    }

    #[test]
    fn pushdown_covers_eq_and_phone_eq_with_distinct_prefixes() {
        let filters = json!([
            { "field": "tag", "op": "eq", "value": "vip" },
            { "field": "phone", "op": "phone_eq", "value": "+61400111222" },
            { "field": "age", "op": "gt", "value": 40 }
        ]);
        let pairs = pushdown_eq_filters(Some(&filters), &SelectorScope::default());
        assert_eq!(
            pairs,
            vec![
                ("answers.tag".to_string(), "vip".to_string()),
                ("answersPhone.phone".to_string(), "+61400111222".to_string()),
            ]
        );
    }

    #[test]
    fn pushdown_covers_gte_lte_range_bounds() {
        let filters = json!([
            { "field": "date", "op": "gte", "value": "2026-07-14" },
            { "field": "date", "op": "lte", "value": "2026-10-12" },
            { "field": "age", "op": "gte", "value": 40 }
        ]);
        let pairs = pushdown_eq_filters(Some(&filters), &SelectorScope::default());
        assert_eq!(
            pairs,
            vec![
                ("answersGte.date".to_string(), "2026-07-14".to_string()),
                ("answersLte.date".to_string(), "2026-10-12".to_string()),
            ]
        );
    }

    #[test]
    fn list_responses_gte_lte_window_iso_dates_inclusive() {
        let rows = vec![
            json!({ "id": "d1", "answers": { "name": "Past", "date": "2026-01-05" } }),
            json!({ "id": "d2", "answers": { "name": "InWindow", "date": "2026-07-20" } }),
            json!({ "id": "d3", "answers": { "name": "Boundary", "date": "2026-10-12" } }),
            json!({ "id": "d4", "answers": { "name": "Beyond", "date": "2026-12-01" } }),
            json!({ "id": "d5", "answers": { "name": "NoDate" } }),
        ];
        let filters = json!([
            { "field": "date", "op": "gte", "value": "2026-07-14" },
            { "field": "date", "op": "lte", "value": "2026-10-12" }
        ]);
        let out = apply_list_responses(&rows, Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(2)); // inclusive boundary; missing date fails gte
        assert_eq!(out["responses"][0]["answers"]["name"], json!("InWindow"));
        assert_eq!(out["responses"][1]["answers"]["name"], json!("Boundary"));
    }

    #[test]
    fn list_responses_contains_is_case_insensitive_substring() {
        let filters = json!([{ "field": "name", "op": "contains", "value": "la" }]);
        let out = apply_list_responses(&customers(), Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(1)); // 'Blair'
        assert_eq!(out["first"]["id"], json!("r2"));
    }

    #[test]
    fn list_responses_gt_compares_numerically() {
        let filters = json!([{ "field": "age", "op": "gt", "value": 40 }]);
        let out = apply_list_responses(&customers(), Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(2)); // Blair 52, Casey 41
    }

    #[test]
    fn list_responses_in_tests_membership_over_comma_list() {
        let filters = json!([{ "field": "tag", "op": "in", "value": "vip, gold" }]);
        let out = apply_list_responses(&customers(), Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(2)); // Alex + Casey are vip
    }

    #[test]
    fn list_responses_ands_filters_and_reports_no_match() {
        let filters = json!([
            { "field": "tag", "op": "eq", "value": "vip" },
            { "field": "age", "op": "gt", "value": 100 }
        ]);
        let out = apply_list_responses(&customers(), Some(&filters), &SelectorScope::default());
        assert_eq!(out["count"], json!(0));
        assert_eq!(out["found"], json!(false));
        assert_eq!(out["first"], Value::Null);
    }

    #[test]
    fn list_responses_resolves_selector_filter_value() {
        let scope = SelectorScope {
            event: Some(json!({ "data": { "callerPhone": "+61400999888" } })),
            ..Default::default()
        };
        let filters = json!([{ "field": "phone", "op": "eq", "value": "$event.data.callerPhone" }]);
        let out = apply_list_responses(&customers(), Some(&filters), &scope);
        assert_eq!(out["count"], json!(1));
        assert_eq!(out["first"]["answers"]["name"], json!("Blair"));
    }

    #[test]
    fn list_responses_limit_is_clamped() {
        assert_eq!(clamp_list_limit(Some(&json!(100000))), LIST_RESPONSES_MAX_LIMIT); // hard cap 500
        assert_eq!(clamp_list_limit(None), LIST_RESPONSES_DEFAULT_LIMIT); // default 200
        assert_eq!(clamp_list_limit(Some(&json!(0))), 1); // floored to a min of 1
        assert_eq!(clamp_list_limit(Some(&json!(5))), 5);
        assert_eq!(clamp_list_limit(Some(&json!("nope"))), LIST_RESPONSES_DEFAULT_LIMIT); // non-number → default
    }

    #[tokio::test]
    async fn list_responses_missing_form_is_invalid_flow() {
        let flow = json!({
            "nodes": [ { "id": "lookup", "type": "formlogic_list_responses", "data": {} } ],
            "edges": []
        });
        let out = execute_flow(&flow, &deps(), &opts()).await;
        assert_eq!(out.status, "error");
        let e = out.error.unwrap();
        assert_eq!(e.code, FlowErrorCode::InvalidFlow);
        assert_eq!(e.node_id.as_deref(), Some("lookup"));
    }

    #[test]
    fn list_responses_skips_non_object_and_array_rows() {
        // Non-object rows are dropped (parity with normalizeResponseRow → null).
        let raw = vec![json!("scalar"), json!([1, 2]), json!({ "id": 7, "answers": { "k": "v" } })];
        let out = apply_list_responses(&raw, None, &SelectorScope::default());
        assert_eq!(out["count"], json!(1));
        assert_eq!(out["first"]["id"], json!("7")); // numeric id String()-coerced
        assert_eq!(out["first"]["answers"]["k"], json!("v"));
    }
}
