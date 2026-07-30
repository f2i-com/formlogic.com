// Deploy panel: FormLogic Flows (docs/FORMLOGIC_FLOWS.md).
//
// Owner surface for the app's event bindings + run history. Flow authoring lives in the
// first-class Flows workspace (/flows); this panel keeps app-scoped binding management and links
// each app flow back to the workspace editor.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, Plus, RefreshCw, Workflow } from 'lucide-react';
import { api } from '../../lib/api';
import { formatRelativeTime, parseServerDate } from '../../lib/utils';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Switch } from '../ui/Switch';
import { EmptyState } from '../ui/EmptyState';
import { BindingEditor } from '../flows/bindings/BindingEditor';
import { deriveFlowConnectors } from '../flows/flowConnectors';
import type { FlowBinding, FlowDefinition, FlowRunLog } from '../../types/flows';
import { returnToState } from '../../hooks/useReturnTo';

function statusChip(status: string) {
  const cls =
    status === 'done'
      ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200/70 dark:border-emerald-500/25'
      : status === 'running' || status === 'queued'
        ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200/70 dark:border-blue-500/25'
        : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 border-red-200/70 dark:border-red-500/25';
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${cls}`}>{status}</span>;
}

function runDuration(run: FlowRunLog): string {
  if (!run.startedAt || !run.finishedAt) return '-';
  // parseServerDate: offsetless UTC MySQL datetimes — Safari can't even parse them raw.
  const ms = parseServerDate(run.finishedAt).getTime() - parseServerDate(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function FlowRow({ appId, flow, onSaved }: {
  appId: string;
  flow: FlowDefinition;
  onSaved: (updated: FlowDefinition) => void;
}) {
  const toggleEnabled = async (enabled: boolean) => {
    const r = await api.updateFlow(appId, flow.id, { enabled });
    if (r.error || !r.data) {
      toast.error('Failed to update flow', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    onSaved(r.data.flow);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200/80 bg-gray-50/70 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-800/40">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{flow.name}</p>
        <p className="truncate font-mono text-xs text-gray-400 dark:text-slate-500">{flow.slug} - v{flow.version}</p>
      </div>
      {/* `label` wins over `ariaLabel` in Switch, so pass ariaLabel ONLY — otherwise
          every row announces as an identical "Enabled, switch" and pausing the wrong
          production automation is a coin flip. */}
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-gray-600 dark:text-slate-300" aria-hidden="true">Enabled</span>
        <Switch checked={flow.enabled} onChange={toggleEnabled} ariaLabel={`Enable ${flow.name}`} size="sm" />
      </span>
      <Link
        to={`/flows?flow=${encodeURIComponent(flow.id)}`}
        // Carry the origin, so the flow editor's Back returns to this panel rather than
        // stranding the owner in the automations workspace.
        state={returnToState(`/apps/${appId}/deploy`, 'Deploy & share')}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-primary-600 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-400 dark:hover:bg-primary-500/10"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Automations
      </Link>
    </div>
  );
}

function RunHistory({ appId }: { appId: string }) {
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  // A failed fetch left `runs` null forever, so the section claimed "Loading..."
  // permanently while the only signal — a toast — had already faded.
  const [runsError, setRunsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listFlowRuns(appId, { limit: 25 }).then((r) => {
      if (cancelled) return;
      if (r.data) { setRuns(r.data.runs); setRunsError(false); }
      else if (r.error) {
        setRunsError(true);
        toast.error('Failed to load run history', typeof r.error === 'string' ? r.error : undefined);
      }
    });
    return () => { cancelled = true; };
  }, [appId]);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.listFlowRuns(appId, { limit: 25 });
    setLoading(false);
    if (r.error || !r.data) {
      setRunsError(true);
      toast.error('Failed to load run history', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    setRunsError(false);
    setRuns(r.data.runs);
  }, [appId]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300">Run history</h4>
        <Button variant="ghost" size="sm" onClick={load} isLoading={loading} disabled={loading} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
          Refresh
        </Button>
      </div>
      {runsError ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          Couldn't load run history. Use Refresh to try again.
        </p>
      ) : runs === null || runs.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-slate-400">
          {runs === null ? 'Loading…' : 'No runs yet - bindings and test runs appear here.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200/80 dark:border-slate-700/60">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200/80 text-left text-xs text-gray-500 dark:border-slate-700/60 dark:text-slate-400">
                <th className="px-3 py-2 font-medium">Flow</th>
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
                  expanded={expandedRun === run.runId}
                  onToggle={() => setExpandedRun((id) => (id === run.runId ? null : run.runId))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RunRow({ run, expanded, onToggle }: { run: FlowRunLog; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Details for the ${run.flow ?? 'flow'} run`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
        }}
        className="cursor-pointer border-b border-gray-100 last:border-b-0 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:border-slate-800 dark:hover:bg-slate-800/40"
      >
        <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-slate-300">{run.flow ?? '-'}</td>
        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{run.triggerEvent}</td>
        <td className="px-3 py-2">{statusChip(run.status)}</td>
        <td
          className="whitespace-nowrap px-3 py-2 text-xs text-gray-500 dark:text-slate-400"
          title={parseServerDate(run.startedAt ?? run.createdAt).toLocaleString()}
        >
          {/* The raw column is a zone-less UTC string with no hint that it is UTC, so a
              run 5 minutes old read as 10 hours old in an Australian browser. */}
          {formatRelativeTime(run.startedAt ?? run.createdAt)}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">{runDuration(run)}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 last:border-b-0 dark:border-slate-800">
          <td colSpan={5} className="bg-gray-50/70 px-3 py-2 dark:bg-slate-800/40">
            {run.error && (
              <p className="mb-1.5 text-xs text-red-600 dark:text-red-400">
                {run.error.code}: {run.error.message}{run.error.nodeId ? ` (node '${run.error.nodeId}')` : ''}
              </p>
            )}
            <pre className="max-h-40 overflow-x-auto whitespace-pre text-xs text-gray-600 dark:text-slate-400">
              {JSON.stringify({ inputSnapshot: run.inputSnapshot, result: run.result, error: run.error }, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function FlowsPanel({ appId }: { appId: string; appSlug?: string }) {
  const app = useAppStore((s) => s.getApp(appId));
  const connectors = useMemo(() => deriveFlowConnectors(app), [app]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [bindings, setBindings] = useState<FlowBinding[]>([]);
  const [showNewBinding, setShowNewBinding] = useState(false);
  const [pendingDeleteBinding, setPendingDeleteBinding] = useState<FlowBinding | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    void (async () => {
      const [flowsRes, bindingsRes] = await Promise.all([api.listFlows(appId), api.listFlowBindings(appId)]);
      if (flowsRes.data) setFlows(flowsRes.data.flows);
      if (bindingsRes.data) setBindings(bindingsRes.data.bindings);
      if (flowsRes.error) toast.error('Failed to load flows', typeof flowsRes.error === 'string' ? flowsRes.error : undefined);
      if (bindingsRes.error) toast.error('Failed to load flow bindings', typeof bindingsRes.error === 'string' ? bindingsRes.error : undefined);
      setLoaded(true);
    })();
  }, [open, loaded, appId]);

  const saveExistingBinding = (binding: FlowBinding) => async (payload: Record<string, unknown>) => {
    const r = await api.updateFlowBinding(appId, binding.id, payload);
    if (r.error || !r.data) {
      toast.error('Could not save the trigger', typeof r.error === 'string' ? r.error : undefined);
      return null;
    }
    return r.data.binding;
  };

  const createBinding = async (payload: Record<string, unknown>) => {
    const r = await api.createFlowBinding(appId, payload);
    if (r.error || !r.data) {
      toast.error('Could not save the trigger', typeof r.error === 'string' ? r.error : undefined);
      return null;
    }
    return r.data.binding;
  };

  const confirmDeleteBinding = async () => {
    if (!pendingDeleteBinding) return;
    const binding = pendingDeleteBinding;
    setPendingDeleteBinding(null);
    const r = await api.deleteFlowBinding(appId, binding.id);
    if (r.error) {
      toast.error('Could not delete the trigger', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    setBindings((list) => list.filter((b) => b.id !== binding.id));
  };

  return (
    <div className="rounded-2xl border border-gray-200/80 bg-white p-6 dark:border-slate-700/60 dark:bg-slate-900/50">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 text-left">
        <Workflow className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        <h3 className="flex-1 font-medium tracking-tight text-gray-900 dark:text-white">Flows</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">
          {loaded ? `${flows.length} flow${flows.length === 1 ? '' : 's'} - ${bindings.length} binding${bindings.length === 1 ? '' : 's'}` : ''}
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Event-driven automations over this app's data. Author flows in the{' '}
            <Link to="/flows" className="font-medium text-primary-600 hover:underline dark:text-primary-400">Automations</Link>{' '}
            (visual graph editor + test runs); bind them to events here.
          </p>

          {flows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 dark:border-slate-700">
              <EmptyState
                icon={Workflow}
                title="No flows yet"
                description="Build this app's automations under Automations (starter templates included), then choose what starts them here."
                action={
                  <Link
                    to="/flows"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open Automations
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              {flows.map((flow) => (
                <FlowRow
                  key={flow.id}
                  appId={appId}
                  flow={flow}
                  onSaved={(updated) => setFlows((list) => list.map((f) => (f.id === updated.id ? updated : f)))}
                />
              ))}
            </div>
          )}

          {flows.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300">Triggers</h4>
                {!showNewBinding && (
                  <Button variant="outline" size="sm" onClick={() => setShowNewBinding(true)} leftIcon={<Plus className="h-3.5 w-3.5" />}>
                    Add trigger
                  </Button>
                )}
              </div>
              <div className="space-y-3">
                {bindings.map((binding) => (
                  <BindingEditor
                    key={binding.id}
                    binding={binding}
                    flows={flows}
                    connectors={connectors}
                    onSave={saveExistingBinding(binding)}
                    onSaved={(updated) => setBindings((list) => list.map((b) => (b.id === updated.id ? updated : b)))}
                    onDelete={() => setPendingDeleteBinding(binding)}
                  />
                ))}
                {showNewBinding && (
                  <BindingEditor
                    binding={null}
                    flows={flows}
                    connectors={connectors}
                    onSave={createBinding}
                    onSaved={(created) => {
                      setBindings((list) => [...list, created]);
                      setShowNewBinding(false);
                    }}
                    onDelete={() => setShowNewBinding(false)}
                  />
                )}
                {bindings.length === 0 && !showNewBinding && (
                  <p className="text-xs text-gray-400 dark:text-slate-500">
                    No bindings - flows only run via workspace test runs or the flow.run app-logic effect until you bind an event.
                  </p>
                )}
              </div>
            </div>
          )}

          {loaded && <RunHistory appId={appId} />}
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingDeleteBinding !== null}
        onClose={() => setPendingDeleteBinding(null)}
        onConfirm={confirmDeleteBinding}
        title="Delete binding"
        message={pendingDeleteBinding ? `Delete the '${pendingDeleteBinding.event}' binding? The flow itself is kept.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
