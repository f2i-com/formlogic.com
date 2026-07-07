// FormLogic Flows — run-status model (Test Run → canvas pills + run timeline).
//
// The browser executor's additive `onNodeStatus(nodeId, status, info)` observer
// (client-runtime/flows/flowExecutor) emits 'running' before a node runs and 'done'/'error'
// after. These PURE reducers fold that event stream into (a) a per-node status map the canvas
// node cards read to draw status pills, and (b) an ordered run log the Test Run drawer renders
// as a debug timeline. Nothing here executes a flow — it only records what the executor reports.

/** A node's live run phase (idle = never reported, so it's simply absent from the map). */
export type NodeRunPhase = 'running' | 'done' | 'error';

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
