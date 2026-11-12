// FormLogic Flows workspace - run history for the selected flow.
//
// Owner-wide run log (GET /api/flow-runs) filtered to one flow: status chips, relative
// timestamps, runtime ownership, expandable input/result/error, and paged loading. Bindings,
// queued-run claims, ctx.flows.run intents and server test runs all land here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, History, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { parseServerDate } from '../../lib/utils';
import { Button } from '../ui/Button';
import { PanelHeader } from './PanelHeader';
import { flowNodeRegistry } from './registry/FlowNodeRegistry';
import { runLocationLabel } from './editor/executionLocation';
import { formatAbsoluteTimeTitle, formatRelativeTime } from './relativeTime';
import { statusChipStyle } from './runHistoryChip';
import type { FlowDefinition, FlowRunLog, FlowRunStatus, WorkflowGraphNode } from '../../types/flows';
import type { FlowRunErrorCode } from '../../types/flows';

/**
 * Plain-language cause + what to do, for the closed FlowRunErrorCode set.
 *
 * A failed run used to report itself as `capability_denied: ...` above a raw JSON dump —
 * accurate, and useless to the person who has to fix it. The raw code stays visible
 * beside the sentence so a new, unmapped code is never silently swallowed.
 */
const RUN_ERROR_HELP: Record<FlowRunErrorCode, { cause: string; next: string }> = {
  node_failed: {
    cause: 'One of the steps failed while it was running.',
    next: 'Open the flow and check the step named below.',
  },
  timeout: {
    cause: 'It took longer than its time limit and was stopped.',
    next: 'Either the step it was waiting on is slow, or the limit is too short.',
  },
  cancelled: {
    cause: 'It was stopped before it finished.',
    next: 'Run it again if that was not deliberate.',
  },
  capability_denied: {
    cause: "A step needed permission this flow doesn't have.",
    next: 'Open the flow and save it again — saving grants what its steps need.',
  },
  invalid_flow: {
    cause: 'The flow could not be prepared to run.',
    next: 'Open it and look for steps flagged as needing attention.',
  },
  runner_unavailable: {
    cause: 'Nothing was available to run it.',
    next: 'Check the selected runtime and its connection. For local AI or Aokie steps, start OAIY and reconnect it.',
  },
};


const STATUSES: (FlowRunStatus | 'all')[] = ['all', 'done', 'error', 'timeout', 'queued', 'running', 'cancelled'];
const PAGE_SIZE = 25;

function statusChip(run: FlowRunLog) {
  const { cls, label } = statusChipStyle(run);
  return <span className={`inline-block flex-none whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${cls}`}>{label}</span>;
}

function runtimeChip(run: FlowRunLog) {
  if (!run.runtime && !run.claimedBy) return null;
  const label = run.runtime ?? 'claimed';
  const cls = run.runtime === 'desktop'
    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300'
    : 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300';
  return (
    <span
      className={`inline-block flex-none whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4 ${cls}`}
      title={run.claimedBy ? `Claimed by ${run.claimedBy}` : `Runtime: ${label}`}
    >
      {label}
    </span>
  );
}

/**
 * Lineage chip (extensible-flows plan §8.7): a run spawned by a flow_call names its
 * parent run + calling node. The run history is per-flow, so the chip carries the
 * provenance inline; the full cross-flow run TREE arrives with the /children endpoint.
 */
function lineageChip(run: FlowRunLog) {
  if (!run.parentRunId) return null;
  return (
    <span
      className="inline-block flex-none whitespace-nowrap rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium leading-4 text-violet-700 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-300"
      title={`Child run — called from run ${run.parentRunId}${run.callNodeId ? ` (step ${run.callNodeId})` : ''}`}
    >
      child · d{run.depth ?? 1}
    </span>
  );
}

/** How long a run took ("120ms", "1.4s"), or '' when the row does not say when it started and ended. */
function runDuration(run: FlowRunLog): string {
  if (!run.startedAt || !run.finishedAt) return '';
  // parseServerDate: offsetless UTC MySQL datetimes — Safari can't even parse them raw.
  const ms = parseServerDate(run.finishedAt).getTime() - parseServerDate(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function isActiveRun(run: FlowRunLog): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function nodeLabelById(flow: FlowDefinition | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of flow?.flowJson.nodes ?? []) {
    const label = labelForNode(node);
    if (label) map.set(node.id, label);
  }
  return map;
}

function labelForNode(node: WorkflowGraphNode): string | null {
  // FLOW-203: through the registry, so a contributed node reads as its label here rather than as
  // a raw dotted type. resolveKnownNodeSpec (not resolveNodeSpec) so an uninstalled extension
  // shows its stored type instead of the word "missing" — the type is the more useful clue when
  // reading a past run.
  return flowNodeRegistry.resolveKnownNodeSpec(node.type)?.label ?? null;
}

export function FlowRunHistory({ flowId, flow, refreshKey }: { flowId: string; flow?: FlowDefinition; refreshKey?: number }) {
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<FlowRunStatus | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const labelsByNodeId = useMemo(() => nodeLabelById(flow), [flow]);
  const hasActiveRuns = useMemo(() => (runs ?? []).some(isActiveRun), [runs]);

  const loadRuns = useCallback(async (opts: { offset?: number; limit?: number; append?: boolean; showSpinner?: boolean } = {}) => {
    const offset = opts.offset ?? 0;
    const append = opts.append === true;
    const limit = opts.limit ?? PAGE_SIZE;
    const showSpinner = opts.showSpinner !== false;
    if (append) setLoadingMore(true);
    else if (showSpinner) setLoading(true);
    setLoadError(null);
    const r = await api.listMyFlowRuns({ flowId, status: status === 'all' ? undefined : status, limit, offset });
    if (append) setLoadingMore(false);
    else if (showSpinner) setLoading(false);
    if (r.error || !r.data) {
      const message = typeof r.error === 'string' ? r.error : 'Could not load run history';
      if (append) {
        setLoadError(message);
        return;
      }
      setRuns([]);
      setTotal(0);
      setLoadError(message);
      return;
    }
    const page = r.data;
    setTotal(page.total);
    setRuns((prev) => (append ? [...(prev ?? []), ...page.runs] : page.runs));
  }, [flowId, status]);

  const refreshVisibleRuns = useCallback(() => {
    const limit = Math.max(PAGE_SIZE, runs?.length ?? PAGE_SIZE);
    void loadRuns({ offset: 0, limit, showSpinner: false });
  }, [loadRuns, runs?.length]);

  // Reset stale rows when the flow/filter/refresh key changes — during render (React's
  // "adjusting state when props change" pattern), never inside an effect body.
  const resetKey = `${flowId}|${status}|${refreshKey ?? 0}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setRuns(null);
    setExpanded(null);
  }

  useEffect(() => {
    // The leading await makes the load (and every setState inside it) run after the effect
    // body returns — the lint-clean convention (react-hooks/set-state-in-effect) used by the
    // workspace's initial-load effect.
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await loadRuns();
    })();
    return () => { cancelled = true; };
  }, [refreshKey, loadRuns]);

  useEffect(() => {
    if (!hasActiveRuns) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const clear = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const arm = () => {
      clear();
      if (document.visibilityState === 'visible') {
        interval = setInterval(refreshVisibleRuns, 5000);
      }
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', arm);
    };
  }, [hasActiveRuns, refreshVisibleRuns]);

  const canLoadMore = runs !== null && runs.length < total;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PanelHeader
        icon={History}
        title="Run history"
        count={runs === null ? undefined : total}
        actions={(
          <>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as FlowRunStatus | 'all')}
              aria-label="Filter runs by status"
              className="cursor-pointer rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
            </select>
            <Button variant="ghost" size="sm" onClick={() => void loadRuns()} isLoading={loading} disabled={loading} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </>
        )}
      />

      {/* pb-24: the last run scrolls clear of the chat button fixed at the window's corner. */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-24">
        {loadError && runs !== null && runs.length === 0 ? (
          <div className="px-3 py-4">
            <div className="mb-3 flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
              <div>
                <p className="font-medium">Couldn't load runs</p>
                <p className="mt-0.5 text-red-500 dark:text-red-300">{loadError}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadRuns()} isLoading={loading} disabled={loading} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
              Retry
            </Button>
          </div>
        ) : runs === null || loading ? (
          <p className="px-3 py-4 text-xs text-gray-500 dark:text-slate-400">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="px-3 py-4 text-xs leading-5 text-gray-500 dark:text-slate-400">No runs yet. Trigger the flow or use Test run.</p>
        ) : (
          <>
            {/* A row a run, two lines each: how it went and when, then what started it, where it
                ran and how long it took. (Five columns do not fit a panel 384 px wide: the table
                was wider than its panel, and "done (action failed)" stood three lines tall.) */}
            <ul className="divide-y divide-gray-100 border-b border-gray-100 dark:divide-slate-800 dark:border-slate-800" aria-label="Runs, newest first">
              {runs.map((run) => (
                <RunRow
                  key={run.runId}
                  run={run}
                  nodeLabel={run.error?.nodeId ? labelsByNodeId.get(run.error.nodeId) : undefined}
                  expanded={expanded === run.runId}
                  onToggle={() => setExpanded((id) => (id === run.runId ? null : run.runId))}
                />
              ))}
            </ul>
            <div className="flex items-center justify-between gap-2 px-3 py-3">
              <p className="text-[11px] tabular-nums text-gray-500 dark:text-slate-400">
                Showing {runs.length} of {total}
              </p>
              {canLoadMore && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadRuns({ offset: runs.length, append: true })}
                  isLoading={loadingMore}
                  disabled={loadingMore}
                >
                  Load more
                </Button>
              )}
            </div>
            {loadError && (
              <p className="px-3 pb-3 text-xs text-red-600 dark:text-red-400">{loadError}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, nodeLabel, expanded, onToggle }: { run: FlowRunLog; nodeLabel?: string; expanded: boolean; onToggle: () => void }) {
  const started = run.startedAt ?? run.createdAt;
  // The as-executed location (plan §5.7): browser, desktop or cloud. A row from before it was
  // recorded says nothing about where it ran, rather than a dash between two dots.
  const location = runLocationLabel((run as FlowRunLog & { executionLocation?: unknown }).executionLocation);
  const duration = runDuration(run);
  return (
    <li data-run-row>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer flex-col gap-1 px-3 py-2 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:hover:bg-white/[0.03] max-sm:py-2.5"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {statusChip(run)}
          {runtimeChip(run)}
          {lineageChip(run)}
          <span className="ml-auto flex-none whitespace-nowrap text-xs tabular-nums text-gray-500 dark:text-slate-400" title={formatAbsoluteTimeTitle(started)}>
            {formatRelativeTime(started)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
          <span className="min-w-0 truncate font-mono text-[11px] text-gray-600 dark:text-slate-300" title={`Started by ${run.triggerEvent}`}>{run.triggerEvent}</span>
          {location !== '—' && <><span aria-hidden="true">·</span><span data-run-location className="flex-none" title="Where it ran">{location}</span></>}
          {duration !== '' && <><span aria-hidden="true">·</span><span className="flex-none tabular-nums" title="How long it took">{duration}</span></>}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
            {run.parentRunId && (
              <p className="mb-1.5 text-[11px] text-gray-500 dark:text-slate-400">
                Called from run <span className="font-mono">{run.parentRunId}</span>
                {run.callNodeId && <> by step <span className="font-mono">{run.callNodeId}</span></>}
                {run.rootRunId && run.rootRunId !== run.parentRunId && (
                  <> · root <span className="font-mono">{run.rootRunId}</span></>
                )}
                {typeof run.depth === 'number' && run.depth > 0 && <> · depth {run.depth}</>}
              </p>
            )}
            {run.error && (
              <div className="mb-1.5 text-xs text-red-600 dark:text-red-400">
                {RUN_ERROR_HELP[run.error.code] ? (
                  <>
                    <p className="font-medium">{RUN_ERROR_HELP[run.error.code].cause}</p>
                    <p className="mt-0.5 text-gray-600 dark:text-slate-400">{RUN_ERROR_HELP[run.error.code].next}</p>
                  </>
                ) : (
                  <p className="font-medium">{run.error.message}</p>
                )}
                {run.error.nodeId && (
                  <p className="mt-0.5 text-gray-600 dark:text-slate-400">
                    Step: <span className="font-medium">{nodeLabel || run.error.nodeId}</span>
                  </p>
                )}
                {/* The raw code and message stay available — they are what a support
                    conversation needs, and an unmapped code must never vanish. */}
                <p className="mt-0.5 font-mono text-[11px] text-gray-500 dark:text-slate-500">
                  {run.error.code}: {run.error.message}
                </p>
              </div>
            )}
            {(run as { redacted?: boolean }).redacted ? (
              <p className="text-xs text-gray-500 dark:text-slate-400 italic">
                Run payloads (input snapshot, result) can contain record data, so they are hidden from platform admins.
              </p>
            ) : (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-slate-400">
                {JSON.stringify({ inputSnapshot: run.inputSnapshot, result: run.result }, null, 2)}
              </pre>
            )}
            <ChildRuns runId={run.runId} level={0} />
        </div>
      )}
    </li>
  );
}

/** Deepest child level the tree expands to (matches the browser invoker's awaited-depth guard). */
const CHILD_TREE_MAX_LEVELS = 8;

/**
 * The collapsible run tree (extensible-flows plan §8.7), one fetch-on-expand level at a
 * time via GET /api/flow-runs/{id}/children (§14.4). Renders nothing when a run has no
 * children — most runs — so ordinary history rows stay clean. Child runs may belong to a
 * DIFFERENT flow (that is the point of flow_call), so each row names its flow slug.
 */
function ChildRuns({ runId, level }: { runId: string; level: number }) {
  const [children, setChildren] = useState<FlowRunLog[] | null>(null);
  const [total, setTotal] = useState(0);
  const [openChild, setOpenChild] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      const r = await api.listFlowRunChildren(runId, { limit: 25 });
      if (cancelled) return;
      setChildren(r.data?.runs ?? []);
      setTotal(r.data?.total ?? 0);
    })();
    return () => { cancelled = true; };
  }, [runId]);

  if (children === null || children.length === 0) return null;
  return (
    <div className={level === 0 ? 'mt-2 border-t border-gray-200/70 pt-2 dark:border-slate-700/50' : 'mt-1'}>
      {level === 0 && (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
          Child runs ({total})
        </p>
      )}
      <ul className="space-y-1 border-l border-gray-200/80 pl-2.5 dark:border-slate-700/60">
        {children.map((child) => (
          <li key={child.runId} className="text-xs">
            <button
              type="button"
              onClick={() => setOpenChild((id) => (id === child.runId ? null : child.runId))}
              className="flex w-full flex-wrap items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-gray-100/70 dark:hover:bg-slate-800/60"
              title={`Run ${child.runId}${child.callNodeId ? ` — by step ${child.callNodeId}` : ''}`}
            >
              {statusChip(child)}
              <span className="font-mono text-gray-600 dark:text-slate-300">{child.flow ?? child.flowDefinitionId}</span>
              {child.callNodeId && <span className="text-gray-400 dark:text-slate-500">via {child.callNodeId}</span>}
              <span className="ml-auto text-gray-400 dark:text-slate-500" title={formatAbsoluteTimeTitle(child.startedAt ?? child.createdAt)}>
                {formatRelativeTime(child.startedAt ?? child.createdAt)}{runDuration(child) !== '' && ` · ${runDuration(child)}`}
              </span>
            </button>
            {openChild === child.runId && (
              <div className="mt-1 pl-1">
                {child.error && (
                  <p className="mb-1 text-[11px] text-red-600 dark:text-red-400">
                    {child.error.code}: {child.error.message}
                  </p>
                )}
                {level + 1 < CHILD_TREE_MAX_LEVELS && <ChildRuns runId={child.runId} level={level + 1} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {total > children.length && (
        <p className="mt-1 pl-2.5 text-[11px] text-gray-400 dark:text-slate-500">
          Showing {children.length} of {total} children
        </p>
      )}
    </div>
  );
}
