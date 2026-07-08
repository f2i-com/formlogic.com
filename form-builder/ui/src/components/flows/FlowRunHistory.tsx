// FormLogic Flows workspace — run history for the selected flow.
//
// Owner-wide run log (GET /api/flow-runs) filtered to one flow: status chips, duration,
// expandable input/result/error, and a status filter. Bindings, queued-run claims, ctx.flows.run
// intents and server test runs all land here.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { statusChipStyle } from './runHistoryChip';
import type { FlowRunLog, FlowRunStatus } from '../../types/flows';

const STATUSES: (FlowRunStatus | 'all')[] = ['all', 'done', 'error', 'timeout', 'queued', 'running', 'cancelled'];

function statusChip(run: FlowRunLog) {
  const { cls, label } = statusChipStyle(run);
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${cls}`}>{label}</span>;
}

function runDuration(run: FlowRunLog): string {
  if (!run.startedAt || !run.finishedAt) return '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function FlowRunHistory({ flowId, refreshKey }: { flowId: string; refreshKey?: number }) {
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<FlowRunStatus | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.listMyFlowRuns({ flowId, status: status === 'all' ? undefined : status, limit: 25 });
    setLoading(false);
    if (r.error || !r.data) {
      toast.error('Failed to load run history', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    setRuns(r.data.runs);
  }, [flowId, status]);

  useEffect(() => {
    let cancelled = false;
    api.listMyFlowRuns({ flowId, status: status === 'all' ? undefined : status, limit: 25 }).then((r) => {
      if (cancelled) return;
      if (r.data) setRuns(r.data.runs);
      else if (r.error) toast.error('Failed to load run history', typeof r.error === 'string' ? r.error : undefined);
    });
    return () => { cancelled = true; };
  }, [flowId, status, refreshKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200/80 dark:border-slate-700/60 px-3 py-2">
        <h4 className="flex-1 text-sm font-medium text-gray-700 dark:text-slate-300">Run history</h4>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as FlowRunStatus | 'all')}
          aria-label="Filter runs by status"
          className="rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500 cursor-pointer"
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
        </select>
        <Button variant="ghost" size="sm" onClick={load} isLoading={loading} disabled={loading} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {runs === null || runs.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-400 dark:text-slate-500">
            {runs === null ? 'Loading…' : 'No runs yet — bindings, queued claims and test runs appear here.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="text-left text-xs text-gray-500 dark:text-slate-400 border-b border-gray-200/80 dark:border-slate-700/60">
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow
                  key={run.runId}
                  run={run}
                  expanded={expanded === run.runId}
                  onToggle={() => setExpanded((id) => (id === run.runId ? null : run.runId))}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, expanded, onToggle }: { run: FlowRunLog; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className="border-b border-gray-100 dark:border-slate-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/40">
        <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-slate-400">{run.triggerEvent}</td>
        <td className="px-3 py-2">{statusChip(run)}</td>
        <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{run.startedAt ?? run.createdAt}</td>
        <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">{runDuration(run)}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 dark:border-slate-800">
          <td colSpan={4} className="px-3 py-2 bg-gray-50/70 dark:bg-slate-800/40">
            {run.error && (
              <p className="mb-1.5 text-xs text-red-600 dark:text-red-400">
                {run.error.code}: {run.error.message}{run.error.nodeId ? ` (node '${run.error.nodeId}')` : ''}
              </p>
            )}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-slate-400">
              {JSON.stringify({ inputSnapshot: run.inputSnapshot, result: run.result }, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
