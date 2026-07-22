// FormLogic Flows v0 browser executor (docs/FORMLOGIC_FLOWS.md §4).
//
// A small, well-tested interpreter over the WorkflowGraph JSON: topological execution
// from input to output over the restricted node set in nodes.ts, with the binding's
// timeoutMs enforced via AbortController and a hard total-node budget. It never throws —
// every run resolves to a FlowRunOutcome whose status/error mirror
// docs/contracts/flow-run-result.schema.json, so the dispatcher can PATCH the run log
// verbatim. Graph problems (cycles, unknown node types, dangling edges) are `invalid_flow`;
// a node crash is `node_failed` naming the node; the deadline is `timeout`; an external
// abort is `cancelled`.
import type { FlowRunError, WorkflowGraph, WorkflowGraphNode } from '../../types/flows';
import { executeNode, FlowExecError, FLOW_NODE_BUDGET, type FlowExecutorDeps } from './nodes';
import type { SelectorScope } from './selectors';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Node types whose single call can legitimately take minutes in the browser — a local
 * LLM generating tokens, speech synthesis/transcription, image generation, or a driven
 * browser session. A flow containing any of these gets the longer default deadline.
 */
const LONG_RUNNING_NODE_TYPES = new Set(['llm_chat', 'stt_transcribe', 'tts_speak', 'image_gen', 'browser_action']);

/** Default run deadline when the graph contains a long-running (AI/service) node. */
const AI_DEFAULT_TIMEOUT_MS = 180000;

/**
 * The default wall-clock deadline for a run with NO explicit timeoutMs: 30s for plain
 * data/logic flows, 3 minutes when the graph contains an AI/service node (an LLM reply
 * on a local model alone can take well over 30s in the browser). An explicit binding /
 * caller timeoutMs always wins — e.g. the Aokie call bindings stay on their tight
 * budgets. (The desktop Rust runner keeps its flat 30s default: desktop runs arrive via
 * bindings, which declare explicit timeouts — this is a browser-run default, not a node
 * semantics change, so runner parity is unaffected.)
 */
export function defaultRunTimeoutMs(graph: WorkflowGraph | null | undefined): number {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.some((n) => n && typeof n.type === 'string' && LONG_RUNNING_NODE_TYPES.has(n.type))
    ? AI_DEFAULT_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
}

export interface FlowRunOutcome {
  status: 'done' | 'error' | 'timeout' | 'cancelled';
  /** Present when status === 'done'. */
  result?: unknown;
  /** Present on any non-done status (flow-run-result error envelope). */
  error?: FlowRunError;
  /** How many nodes actually executed (diagnostics). */
  nodesExecuted: number;
  /**
   * BROWSER-DISPATCHER-ONLY, ADDITIVE. `executeFlow` itself never sets this — it is populated
   * by `flowDispatcher.ts`'s `executeRun` when status === 'done' but one or more binding
   * outputActions threw. The terminal `status` PERSISTED to the run log stays 'done' (the flow
   * graph genuinely succeeded); this field only lets `runBinding` decide, in-memory, whether a
   * downstream side-effect failure should still trigger `fallbackPolicy` (docs/FORMLOGIC_FLOWS.md
   * §fallbackPolicy) — e.g. a sync/live-call binding whose only outputAction (speaking the reply)
   * threw must not look identical to a clean success.
   */
  actionErrors?: string[];
}

export interface ExecuteFlowOptions {
  inputs?: Record<string, unknown>;
  /** The triggering event (available to selectors as $event and expressions as `event`). */
  event?: unknown;
  /** App context ({slug, id, name}) for $app selectors. */
  app?: Record<string, unknown>;
  /** Per-run wall-clock deadline (binding timeoutMs); default 30s. */
  timeoutMs?: number;
  deps: FlowExecutorDeps;
  /** Optional external cancellation (aborting here yields status 'cancelled'). */
  signal?: AbortSignal;
  /** The flow's declared nodeCapabilities (gates storage_set — see nodes.ts). */
  capabilities?: string[] | null;
  /** The flow's slug — default KV scope 'flow:<slug>' for storage nodes / logic_block ctx.kv. */
  flowSlug?: string;
  /**
   * Awaited-call ancestry INCLUDING this flow (stable flow ids, root first) — flow_call's
   * recursion/depth guard (extensible-flows plan §8.8). Callers that can host child flows
   * (the dispatcher, Test Run) seed it with [thisFlowId]; the child invoker extends it.
   * Absent = a context that cannot invoke children (guards then refuse in the dep).
   */
  callStack?: readonly string[];
  /**
   * This run's reserved run-log id — flow_call's child reservations name it as
   * `parentRunId` so the server records lineage (plan §8.7). Absent when the execution
   * has no run log (e.g. a workspace Test Run without a reservation).
   */
  runId?: string;
  /**
   * BROWSER-ONLY, ADDITIVE observer. Called immediately BEFORE a node runs ('running') and
   * again AFTER it settles ('done' with its output, or 'error' with the message). It NEVER
   * influences execution — it only observes, so the desktop Rust runner (which renders no
   * canvas) needs no mirror. The editor uses it to light up per-node status pills + a live
   * run timeline.
   */
  onNodeStatus?: (
    nodeId: string,
    status: 'running' | 'done' | 'error',
    info?: { output?: unknown; error?: string },
  ) => void;
}

/**
 * Client-side WorkflowGraph shape check mirroring the backend FlowService::sanitizeFlowJson
 * rules (unique node ids, string types, edges to existing nodes). Returns an error message
 * or null when valid — used by both the executor and the Flows panel's JSON editor.
 */
export function validateWorkflowGraph(graph: unknown): string | null {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return 'flowJson must be an object of shape { nodes: [], edges: [] }';
  }
  const g = graph as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return 'flowJson must be an object of shape { nodes: [], edges: [] }';
  }
  const ids = new Set<string>();
  for (let i = 0; i < g.nodes.length; i++) {
    const node = g.nodes[i] as Partial<WorkflowGraphNode> | null;
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') {
      return `Flow node at index ${i} is missing a valid id`;
    }
    if (typeof node.type !== 'string' || node.type === '') {
      return `Flow node '${node.id}' is missing a type`;
    }
    if (ids.has(node.id)) return `Duplicate flow node id: '${node.id}'`;
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (let i = 0; i < g.edges.length; i++) {
    const edge = g.edges[i] as { id?: unknown; source?: unknown; target?: unknown } | null;
    if (!edge || typeof edge !== 'object' || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      return `Flow edge at index ${i} must have string source and target`;
    }
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return `Flow edge at index ${i} references a missing node ('${edge.source}' → '${edge.target}')`;
    }
    // Graph v2 (additive): an edge MAY carry a stable id — when present it must be a
    // non-empty string, ≤128 chars, unique across the graph (mirrors FlowService::
    // sanitizeFlowJson and the desktop runner's parse_graph).
    if (edge.id !== undefined) {
      if (typeof edge.id !== 'string' || edge.id === '' || edge.id.length > 128) {
        return `Flow edge at index ${i} has an invalid id`;
      }
      if (edgeIds.has(edge.id)) return `Duplicate flow edge id: '${edge.id}'`;
      edgeIds.add(edge.id);
    }
  }
  return null;
}

/** Kahn toposort; returns null when the graph has a cycle. */
function topologicalOrder(graph: WorkflowGraph): WorkflowGraphNode[] | null {
  const indegree = new Map<string, number>();
  const byId = new Map<string, WorkflowGraphNode>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    byId.set(node.id, node);
  }
  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  const order: WorkflowGraphNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (node) order.push(node);
    for (const edge of graph.edges) {
      if (edge.source !== id) continue;
      const next = (indegree.get(edge.target) ?? 0) - 1;
      indegree.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/** Which outgoing edges a finished node activates (condition nodes route by sourceHandle). */
function edgeIsActive(node: WorkflowGraphNode, output: unknown, sourceHandle: string | undefined): boolean {
  if (node.type === 'condition') {
    const branch = output ? 'true' : 'false';
    // A condition edge without a handle follows the truthy branch (sensible default).
    return sourceHandle === undefined || sourceHandle === null || sourceHandle === ''
      ? branch === 'true'
      : sourceHandle === branch;
  }
  if (node.type === 'flow_call') {
    // flow_call routes success/failure by handle (plan §8.3). A failed child only reaches
    // routing under failureMode 'route' (fail-parent throws instead — no edges activate);
    // a handle-less edge follows success, mirroring condition's default-branch shape.
    const branch = (output as { status?: unknown } | null)?.status === 'failed' ? 'failure' : 'success';
    return sourceHandle === undefined || sourceHandle === null || sourceHandle === ''
      ? branch === 'success'
      : sourceHandle === branch;
  }
  return true;
}

/**
 * Interpret a WorkflowGraph. Resolves (never rejects) with the run outcome.
 */
export async function executeFlow(graph: WorkflowGraph, options: ExecuteFlowOptions): Promise<FlowRunOutcome> {
  const invalid = validateWorkflowGraph(graph);
  if (invalid) {
    return { status: 'error', error: { code: 'invalid_flow', message: invalid }, nodesExecuted: 0 };
  }
  if (graph.nodes.length === 0) {
    return { status: 'done', result: {}, nodesExecuted: 0 };
  }
  if (graph.nodes.length > FLOW_NODE_BUDGET) {
    return {
      status: 'error',
      error: { code: 'invalid_flow', message: `Flow exceeds the ${FLOW_NODE_BUDGET}-node budget` },
      nodesExecuted: 0,
    };
  }

  const order = topologicalOrder(graph);
  if (!order) {
    return { status: 'error', error: { code: 'invalid_flow', message: 'Flow graph contains a cycle' }, nodesExecuted: 0 };
  }

  // Deadline: an internal controller aborts on timeout; an external signal chains in and
  // maps to 'cancelled' instead of 'timeout'. No explicit timeoutMs → adaptive default
  // (longer for AI/service flows — see defaultRunTimeoutMs).
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? defaultRunTimeoutMs(graph);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  let nodesExecuted = 0;

  const abortOutcome = (): FlowRunOutcome => ({
    status: timedOut ? 'timeout' : 'cancelled',
    error: timedOut
      ? { code: 'timeout', message: `Flow run exceeded ${timeoutMs}ms — a trigger's timeoutMs can raise the budget for slow steps` }
      : { code: 'cancelled', message: 'Flow run was cancelled' },
    nodesExecuted,
  });

  // A promise that resolves when the run aborts — raced against every node execution so a
  // wedged node (hung fetch, unresponsive dep) can never outlive the deadline.
  const aborted = new Promise<'aborted'>((resolve) => {
    if (controller.signal.aborted) resolve('aborted');
    else controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

  const outputs: Record<string, unknown> = {};
  const executed = new Set<string>();
  const active = new Set<string>(); // nodes reachable through taken branches
  // Incoming wires per target, each carrying its edge's array index — the activation key.
  // Activation is keyed by EDGE IDENTITY (index; stable within a stored graph), never by
  // `${source}→${target}`: parallel edges between the same two nodes (e.g. a condition's
  // true AND false handles wired to one node) must not share one activation key, or the
  // untaken branch is miscounted as activated (extensible-flows plan §3.1/§15.4; the
  // desktop runner keys identically).
  const incoming = new Map<string, { source: string; edgeIndex: number }[]>();
  graph.edges.forEach((edge, edgeIndex) => {
    const list = incoming.get(edge.target) ?? [];
    list.push({ source: edge.source, edgeIndex });
    incoming.set(edge.target, list);
  });
  const activatedEdges = new Set<number>(); // edge indexes whose branch was taken

  for (const node of order) {
    if ((incoming.get(node.id) ?? []).length === 0) active.add(node.id);
  }

  let outputNodeResult: unknown;
  let sawOutputNode = false;
  let lastOutput: unknown;

  try {
    for (const node of order) {
      if (controller.signal.aborted) return abortOutcome();
      if (!active.has(node.id)) continue;

      if (nodesExecuted >= FLOW_NODE_BUDGET) {
        return {
          status: 'error',
          error: { code: 'invalid_flow', message: `Flow exceeded the ${FLOW_NODE_BUDGET}-node execution budget` },
          nodesExecuted,
        };
      }

      // Upstream value: the single activated predecessor's output, or a map keyed by
      // node id when several branches converge.
      const activeIncoming = (incoming.get(node.id) ?? []).filter(
        (e) => executed.has(e.source) && activatedEdges.has(e.edgeIndex)
      );
      let upstream: unknown;
      if (activeIncoming.length === 1) {
        upstream = outputs[activeIncoming[0].source];
      } else if (activeIncoming.length > 1) {
        const merged: Record<string, unknown> = {};
        for (const e of activeIncoming) merged[e.source] = outputs[e.source];
        upstream = merged;
      }

      const scope: SelectorScope = {
        inputs: options.inputs ?? {},
        event: options.event,
        app: options.app,
        nodes: outputs,
        upstream,
      };

      // Observer (browser-only, additive): 'running' before, 'done'/'error' after. Never alters
      // control flow — the try/catch re-throws exactly as before so run semantics are unchanged.
      options.onNodeStatus?.(node.id, 'running');
      let output: unknown;
      try {
        const raced = await Promise.race([
          executeNode({
            node,
            scope,
            signal: controller.signal,
            deps: options.deps,
            capabilities: options.capabilities,
            flowSlug: options.flowSlug,
            callStack: options.callStack,
            runId: options.runId,
          }).then((value) => ({ value })),
          aborted,
        ]);
        if (raced === 'aborted') {
          options.onNodeStatus?.(node.id, 'error', {
            error: timedOut ? `Flow run exceeded ${timeoutMs}ms` : 'Flow run was cancelled',
          });
          return abortOutcome();
        }
        output = raced.value;
      } catch (err) {
        options.onNodeStatus?.(node.id, 'error', {
          error: controller.signal.aborted
            ? timedOut ? `Flow run exceeded ${timeoutMs}ms` : 'Flow run was cancelled'
            : err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      options.onNodeStatus?.(node.id, 'done', { output });

      nodesExecuted += 1;
      executed.add(node.id);
      outputs[node.id] = output;
      lastOutput = output;
      if (node.type === 'output') {
        sawOutputNode = true;
        outputNodeResult = output;
      }

      for (let i = 0; i < graph.edges.length; i++) {
        const edge = graph.edges[i];
        if (edge.source !== node.id) continue;
        if (edgeIsActive(node, output, edge.sourceHandle)) {
          activatedEdges.add(i);
          active.add(edge.target);
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return abortOutcome();
    if (err instanceof FlowExecError) {
      const error: FlowRunError = { code: err.code, message: err.message };
      if (err.nodeId) error.nodeId = err.nodeId;
      return { status: 'error', error, nodesExecuted };
    }
    return {
      status: 'error',
      error: { code: 'node_failed', message: err instanceof Error ? err.message : String(err) },
      nodesExecuted,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  return {
    status: 'done',
    result: sawOutputNode ? outputNodeResult : lastOutput,
    nodesExecuted,
  };
}
