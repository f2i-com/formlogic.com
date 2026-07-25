// FormLogic Flows — run-status model (Test Run → canvas pills + run timeline).
//
// The browser executor's additive `onNodeStatus(nodeId, status, info)` observer
// (client-runtime/flows/flowExecutor) emits 'running' before a node runs and 'done'/'error'
// after. These PURE reducers fold that event stream into (a) a per-node status map the canvas
// node cards read to draw status pills, and (b) an ordered run log the Test Run drawer renders
// as a debug timeline. Nothing here executes a flow — it only records what the executor reports.

/**
 * A node's live run phase (idle = never reported, so it's simply absent from the map).
 *
 * RUN-302 added 'skipped': a node whose typed data inputs can never arrive is not run, and that
 * is neither success nor failure. Showing it as either would misreport what happened — the node
 * did not fail, and it did not produce anything.
 */
export type NodeRunPhase = 'running' | 'done' | 'error' | 'skipped';

/** One node's recorded run status. */
export interface NodeRunStatus {
  status: NodeRunPhase;
  /** Error message (status === 'error'). */
  error?: string;
  /** The node's output (status === 'done'), kept for the timeline's compact preview. */
  output?: unknown;
  /** Wall-clock ms when the node started (first 'running'). */
  startedAt?: number;
  /** Wall-clock ms when it settled ('done'/'error'). */
  endedAt?: number;
}

/** Per-node status keyed by node id (idle nodes are absent). */
export type NodeStatusMap = Record<string, NodeRunStatus>;

/** The executor's onNodeStatus info payload. */
export interface NodeStatusInfo {
  output?: unknown;
  error?: string;
}

/**
 * Fold one onNodeStatus event into the status map (pure — returns a new map).
 * 'running' seeds startedAt; 'done'/'error' set endedAt (keeping the prior startedAt so a
 * duration can be derived) plus the output/error. `at` is injectable for deterministic tests.
 */
export function reduceNodeStatus(
  map: NodeStatusMap,
  nodeId: string,
  status: NodeRunPhase,
  info?: NodeStatusInfo,
  at: number = Date.now(),
): NodeStatusMap {
  const prev = map[nodeId];
  const next: NodeRunStatus =
    status === 'running'
      ? { status, startedAt: at }
      : {
          status,
          startedAt: prev?.startedAt,
          endedAt: at,
          ...(info && 'output' in info ? { output: info.output } : {}),
          ...(info?.error !== undefined ? { error: info.error } : {}),
        };
  return { ...map, [nodeId]: next };
}

/** A run log: the status map plus the node ids in first-seen order (for a stable timeline). */
export interface RunLog {
  map: NodeStatusMap;
  order: string[];
}

export const EMPTY_RUN_LOG: RunLog = { map: {}, order: [] };

/** Fold one onNodeStatus event into a RunLog (map + first-seen order). Pure. */
export function reduceRunLog(
  log: RunLog,
  nodeId: string,
  status: NodeRunPhase,
  info?: NodeStatusInfo,
  at: number = Date.now(),
): RunLog {
  const map = reduceNodeStatus(log.map, nodeId, status, info, at);
  const order = log.order.includes(nodeId) ? log.order : [...log.order, nodeId];
  return { map, order };
}

/** A node's run duration in ms, or null when it hasn't settled / wasn't timed. */
export function nodeDurationMs(status: NodeRunStatus | undefined): number | null {
  if (!status || status.startedAt === undefined || status.endedAt === undefined) return null;
  return Math.max(0, status.endedAt - status.startedAt);
}

/** Human-readable duration ('12ms' / '1.4s'). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// ---------------------------------------------------------------------------
// Edge run-beam derivation (Live Wire) — turns the same status map into a per-edge run state
// so the canvas edge (FlowEdge) can render a travelling beam / executed-path highlight without
// the executor ever knowing the canvas exists. Presentation only; never executes anything.
// ---------------------------------------------------------------------------

/** An edge's live run-beam phase, derived — never stored on the edge itself. */
export type EdgeRunPhase = 'active' | 'done' | 'failed';

export interface EdgeRunState {
  phase: EdgeRunPhase;
  /** The duration of the hop the edge delivered (its target's run time), or null if untimed. */
  durationMs: number | null;
  /** True only on the first qualifying done-edge (input order) into a given target — dedupes
   *  multi-input joins so a node's duration renders once, not once per incoming wire. */
  showDuration: boolean;
}

/** The minimal edge shape the deriver needs (a subset of FlowRFEdge). */
export interface RunnableEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

/**
 * Derive every edge's run-beam state from the current node status map. Mirrors the REAL executor
 * routing rule (client-runtime/flows/flowExecutor.ts `edgeIsActive`) exactly, so a condition
 * node's un-taken branch never lights up even when its target happened to run via another path:
 * a condition edge is only "active" when `sourceHandle` matches the source's actual output
 * branch ('true'/'false'), with a handle-less edge following the truthy branch — the same
 * default the executor applies. Pure; reads only the status map, never touches the graph.
 */
export function deriveEdgeRunStates(
  edges: RunnableEdge[],
  nodeTypeById: (id: string) => string | undefined,
  status: NodeStatusMap,
): Record<string, EdgeRunState> {
  const out: Record<string, EdgeRunState> = {};
  const shownForTarget = new Set<string>();

  for (const edge of edges) {
    const sourceStatus = status[edge.source];
    const targetStatus = status[edge.target];
    // A hop is only traversed once its source has settled successfully and the target exists in
    // the map at all (idle-idle edges — nothing has run yet — are left out entirely).
    if (!sourceStatus || sourceStatus.status !== 'done' || !targetStatus) continue;

    if (nodeTypeById(edge.source) === 'condition') {
      const branch = sourceStatus.output ? 'true' : 'false';
      const handle = edge.sourceHandle;
      const onBranch = handle === undefined || handle === null || handle === '' ? branch === 'true' : handle === branch;
      if (!onBranch) continue; // the un-taken branch stays dark even if its target ran another way
    }

    const phase: EdgeRunPhase =
      targetStatus.status === 'running' ? 'active' : targetStatus.status === 'error' ? 'failed' : 'done';
    const durationMs = nodeDurationMs(targetStatus);
    const showDuration = phase === 'done' && durationMs !== null && !shownForTarget.has(edge.target);
    if (showDuration) shownForTarget.add(edge.target);

    out[edge.id] = { phase, durationMs, showDuration };
  }

  return out;
}

/** A one-line, length-capped preview of a node's output for the timeline. */
export function previewOutput(value: unknown, max = 120): string {
  if (value === undefined) return '—';
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
