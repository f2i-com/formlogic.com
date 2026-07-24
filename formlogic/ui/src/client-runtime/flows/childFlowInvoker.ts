// flow_call child invocation core (extensible-flows plan §8.5) — the scope-independent
// FlowInvoker. One guarded implementation serves both browser scopes: the APP runtime
// (flowDispatcher's runtime flow list + app-scoped run APIs) and the WORKSPACE
// (owner-scoped flow list + run APIs, which is what makes flow_call testable from the
// Test Run drawer). A backend supplies resolution, reservation, completion, and the
// executor deps for the child; this module owns the §8.8 guards and the awaited
// execute-inline semantics, so guard behavior can never drift between scopes.
//
// Refusals throw Error with a §6.7 code prefix (`dependency_missing:` /
// `recursion_detected:` / `root_budget_exceeded:` / `transport_failed:`) — the flow_call
// node wraps them into its FlowExecError.
import { executeFlow, type FlowRunOutcome } from './flowExecutor';
import { resolveExecutableGraph } from './compiledGraph';
import type { FlowExecutorDeps } from './nodes';
import type { WorkflowGraph } from '../../types/flows';

/** Maximum awaited flow_call depth (plan §8.8; the ancestry includes the root flow). */
export const FLOW_CALL_MAX_DEPTH = 8;

export interface ChildFlowRequest {
  targetFlowId: string;
  inputs: Record<string, unknown>;
  callNodeId: string;
  /** Awaited ancestry INCLUDING the calling flow (stable ids, root first). */
  callStack: readonly string[];
  /** The calling run's log id — recorded as the child's parent (lineage, plan §8.7). */
  parentRunId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResolvedChildFlow {
  slug: string;
  flowJson: WorkflowGraph;
  nodeCapabilities: string[] | null;
}

export interface ChildFlowEnvelope {
  status: 'done' | 'error' | 'timeout' | 'cancelled';
  result?: unknown;
  error?: { code: string; message: string; nodeId?: string };
  runId?: string;
}

/** What one scope must provide. Backends own their API shapes and error logging. */
export interface ChildFlowBackend {
  /** Human scope name for refusal messages ('app runtime' / 'workspace'). */
  scope: string;
  /**
   * Resolve the target by STABLE id (plan §8.1 — never a slug); null = missing, disabled,
   * or not visible in this scope. May throw a prefixed refusal for scope-level problems
   * (e.g. no app runtime registered).
   */
  resolveFlow(flowId: string): Promise<ResolvedChildFlow | null>;
  /** Reserve the child run log (with lineage). The backend derives its own idempotency key. */
  reserveRun(flow: ResolvedChildFlow, req: ChildFlowRequest): Promise<{ runId: string } | { error: string }>;
  /** Persist the terminal outcome. Failures must be swallowed/logged by the backend. */
  completeRun(runId: string, outcome: FlowRunOutcome): Promise<void>;
  /** $app context for the child's selectors (undefined outside an app). */
  appContext(): Record<string, unknown> | undefined;
  /** Executor deps for the child — must include this scope's invokeChildFlow for grandchildren. */
  executorDeps(): FlowExecutorDeps;
}

/**
 * Awaited child invocation (plan §8.5 v1): resolve by stable id within the backend's
 * scope (the scope's flow list IS the allowlist — cross-scope calls are structurally
 * impossible), guard recursion/depth over the awaited ancestry, reserve a lineage-linked
 * run, execute inline with the ancestry extended, complete the run, return the envelope.
 */
export async function invokeChildFlowWith(
  backend: ChildFlowBackend,
  req: ChildFlowRequest,
): Promise<ChildFlowEnvelope> {
  const flow = await backend.resolveFlow(req.targetFlowId);
  if (!flow) {
    throw new Error(
      `dependency_missing: flow '${req.targetFlowId}' is not available in this ${backend.scope} (missing, disabled, or not yet loaded)`,
    );
  }
  if (req.callStack.includes(req.targetFlowId)) {
    throw new Error(`recursion_detected: flow '${flow.slug}' is already running in this awaited call chain`);
  }
  if (req.callStack.length >= FLOW_CALL_MAX_DEPTH) {
    throw new Error(`root_budget_exceeded: awaited flow_call depth limit (${FLOW_CALL_MAX_DEPTH}) reached`);
  }

  const reservation = await backend.reserveRun(flow, req);
  if ('error' in reservation) {
    throw new Error(`transport_failed: child run reservation failed: ${reservation.error}`);
  }

  // RUN-301: children execute the server-compiled canonical IR by the same rule as roots;
  // a blocked compile is the child's typed failure envelope, not an unknown-node crash.
  // (The child was resolved BY stable id, so the request's target id IS the flow id.)
  const resolved = await resolveExecutableGraph(req.targetFlowId, flow.flowJson);
  const outcome: FlowRunOutcome = resolved.ok
    ? await executeFlow(resolved.graph, {
      inputs: req.inputs,
      app: backend.appContext(),
      timeoutMs: req.timeoutMs,
      deps: backend.executorDeps(),
      capabilities: flow.nodeCapabilities,
      flowSlug: flow.slug,
      signal: req.signal,
      callStack: [...req.callStack, req.targetFlowId],
      runId: reservation.runId,
    })
    : { status: 'error', error: resolved.error, nodesExecuted: 0 };
  try {
    await backend.completeRun(reservation.runId, outcome);
  } catch {
    // The run-log write is bookkeeping — the child's in-memory outcome is authoritative
    // for the awaiting parent, and the backend has already logged the failure.
  }
  return { status: outcome.status, result: outcome.result, error: outcome.error, runId: reservation.runId };
}
