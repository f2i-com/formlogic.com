// Deploy panel: FormLogic Flows (docs/FORMLOGIC_FLOWS.md).
//
// Owner surface for the app's EVENT BINDINGS + run history. Flow authoring moved to the
// first-class Flows workspace (/flows — visual graph editor, node palette, test runs);
// this panel lists the app's flows with an "Open in Flows workspace" deep link per flow
// (/flows?flow=<id>) and keeps the binding editor, which stays app-scoped.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, Plus, RefreshCw, Trash2, Workflow } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Switch } from '../ui/Switch';
import { EmptyState } from '../ui/EmptyState';
import type {
  FlowBinding,
  FlowBindingMode,
  FlowDefinition,
  FlowOutputAction,
  FlowOutputActionType,
  FlowRunLog,
} from '../../types/flows';

// Suggested event names for bindings (desktop/connector events + form events + manual).
const EVENT_SUGGESTIONS = [
  'aokie.call.incoming',
  'aokie.call.ended',
  'aokie.call.missed',
  'aokie.sms.received',
  'form.submitted',
  'manual',
];

const MODES: FlowBindingMode[] = ['sync', 'async', 'background', 'manual'];
const ACTION_TYPES: FlowOutputActionType[] = [
  'formlogic.submitResponse',
  'formlogic.updateResponse',
  'formlogic.toast',
  'connector.request',
  'call.speak',
];

const INPUT_CLS =
  'w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none';
const MONO_INPUT_CLS = INPUT_CLS + ' font-mono text-xs';
const LABEL_CLS = 'block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1';

/** Parse a value cell: valid JSON stays typed; anything else is a raw string (selectors). */
function parseCell(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return '';
  if (/^[{["]|^-?\d|^(true|false|null)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through — treat as a raw string/selector */
    }
  }
  return raw;
}

function cellToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

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
  if (!run.startedAt || !run.finishedAt) return '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Flow row (authoring lives in the Flows workspace).
// ---------------------------------------------------------------------------

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
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-gray-50/70 dark:bg-slate-800/40 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{flow.name}</p>
        <p className="truncate font-mono text-xs text-gray-400 dark:text-slate-500">{flow.slug} · v{flow.version}</p>
      </div>
      <Switch checked={flow.enabled} onChange={toggleEnabled} label="Enabled" size="sm" />
      <Link
        to={`/flows?flow=${encodeURIComponent(flow.id)}`}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Flows workspace
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Binding card (event → flow wiring).
// ---------------------------------------------------------------------------

interface BindingDraft {
  event: string;
  flow: string;
  mode: FlowBindingMode;
  conditionExpr: string;
  inputRows: Array<{ key: string; value: string }>;
  actions: FlowOutputAction[];
  timeoutMs: number;
  enabled: boolean;
}

function draftFromBinding(binding: FlowBinding | null, flows: FlowDefinition[]): BindingDraft {
  return {
    event: binding?.event ?? 'aokie.call.incoming',
    flow: binding?.flow ?? flows[0]?.slug ?? '',
    mode: binding?.mode ?? 'async',
    conditionExpr: binding?.condition?.expr ?? '',
    inputRows: Object.entries(binding?.inputMap ?? {}).map(([key, value]) => ({ key, value: cellToString(value) })),
    actions: (binding?.outputActions ?? []).map((a) => ({ ...a })),
    timeoutMs: binding?.timeoutMs ?? 30000,
    enabled: binding?.enabled ?? true,
  };
}

function draftToPayload(draft: BindingDraft): Record<string, unknown> {
  const inputMap: Record<string, unknown> = {};
  for (const row of draft.inputRows) {
    if (row.key.trim() !== '') inputMap[row.key.trim()] = parseCell(row.value);
  }
  const actions = draft.actions.map((a) => {
    const clean: Record<string, unknown> = { type: a.type };
    if (a.form) clean.form = a.form;
    if (a.responseId) clean.responseId = a.responseId;
    if (a.answers !== undefined && a.answers !== '') clean.answers = typeof a.answers === 'string' ? parseCell(a.answers) : a.answers;
    if (a.when) clean.when = a.when;
    if (a.connectorId) clean.connectorId = a.connectorId;
    if (a.command) clean.command = a.command;
    if (a.payload !== undefined && a.payload !== '') clean.payload = typeof a.payload === 'string' ? parseCell(a.payload) : a.payload;
    if (a.message) clean.message = a.message;
    return clean;
  });
  return {
    event: draft.event.trim(),
    flow: draft.flow,
    mode: draft.mode,
    condition: draft.conditionExpr.trim() !== '' ? { type: 'expression', expr: draft.conditionExpr.trim() } : null,
    inputMap: Object.keys(inputMap).length > 0 ? inputMap : null,
    outputActions: actions.length > 0 ? actions : null,
    timeoutMs: draft.timeoutMs,
    enabled: draft.enabled,
  };
}

function BindingCard({ appId, binding, flows, eventsListId, onSaved, onDelete }: {
  appId: string;
  binding: FlowBinding | null; // null = new (unsaved) binding
  flows: FlowDefinition[];
  eventsListId: string;
  onSaved: (binding: FlowBinding) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<BindingDraft>(() => draftFromBinding(binding, flows));
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<BindingDraft>) => setDraft((d) => ({ ...d, ...p }));

  const patchAction = (index: number, p: Partial<FlowOutputAction>) =>
    setDraft((d) => ({ ...d, actions: d.actions.map((a, i) => (i === index ? { ...a, ...p } : a)) }));

  const save = async () => {
    if (!draft.flow) {
      toast.error('Pick a flow for this binding');
      return;
    }
    setSaving(true);
    const payload = draftToPayload(draft);
    const r = binding
      ? await api.updateFlowBinding(appId, binding.id, payload)
      : await api.createFlowBinding(appId, payload);
    setSaving(false);
    if (r.error || !r.data) {
      toast.error('Failed to save binding', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    onSaved(r.data.binding);
    toast.success('Binding saved', `${r.data.binding.event} → ${r.data.binding.flow}`);
  };

  return (
    <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={LABEL_CLS}>Event</label>
          <input
            value={draft.event}
            onChange={(e) => patch({ event: e.target.value })}
            list={eventsListId}
            aria-label="Binding event name"
            className={MONO_INPUT_CLS}
          />
        </div>
        <div>
          <label className={LABEL_CLS}>Flow</label>
          <select value={draft.flow} onChange={(e) => patch({ flow: e.target.value })} aria-label="Binding flow" className={INPUT_CLS + ' cursor-pointer'}>
            {flows.map((f) => <option key={f.id} value={f.slug}>{f.name} ({f.slug})</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLS}>Mode</label>
          <select value={draft.mode} onChange={(e) => patch({ mode: e.target.value as FlowBindingMode })} aria-label="Binding mode" className={INPUT_CLS + ' cursor-pointer'}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr,8rem] gap-3">
        <div>
          <label className={LABEL_CLS}>Condition (sandboxed boolean over <span className="font-mono">event</span>; optional)</label>
          <input
            value={draft.conditionExpr}
            onChange={(e) => patch({ conditionExpr: e.target.value })}
            placeholder="event.data.direction === 'incoming'"
            aria-label="Binding condition expression"
            className={MONO_INPUT_CLS}
          />
        </div>
        <div>
          <label className={LABEL_CLS}>Timeout (ms)</label>
          <input
            type="number"
            min={250}
            max={300000}
            value={draft.timeoutMs}
            onChange={(e) => patch({ timeoutMs: Number(e.target.value) || 30000 })}
            aria-label="Binding timeout in milliseconds"
            className={INPUT_CLS}
          />
        </div>
      </div>

      {/* Input map rows */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className={LABEL_CLS + ' mb-0'}>Input map (flow input ← selector or literal)</span>
          <Button variant="ghost" size="sm" onClick={() => patch({ inputRows: [...draft.inputRows, { key: '', value: '' }] })} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Add input
          </Button>
        </div>
        {draft.inputRows.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-slate-500">No inputs — the flow runs with an empty inputs object.</p>
        )}
        <div className="space-y-1.5">
          {draft.inputRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={row.key}
                onChange={(e) => patch({ inputRows: draft.inputRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)) })}
                placeholder="callerPhone"
                aria-label={`Input name ${i + 1}`}
                className={MONO_INPUT_CLS + ' max-w-[12rem]'}
              />
              <span className="text-gray-400 text-xs">←</span>
              <input
                value={row.value}
                onChange={(e) => patch({ inputRows: draft.inputRows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })}
                placeholder="$event.data.from"
                aria-label={`Input selector ${i + 1}`}
                className={MONO_INPUT_CLS}
              />
              <Button variant="ghost" size="sm" onClick={() => patch({ inputRows: draft.inputRows.filter((_, j) => j !== i) })} aria-label={`Remove input ${i + 1}`}>
                <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Output action rows */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className={LABEL_CLS + ' mb-0'}>Output actions (applied in order after a successful run)</span>
          <Button variant="ghost" size="sm" onClick={() => patch({ actions: [...draft.actions, { type: 'formlogic.toast', message: '' }] })} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Add action
          </Button>
        </div>
        <div className="space-y-2">
          {draft.actions.map((action, i) => (
            <div key={i} className="rounded-lg border border-gray-200 dark:border-slate-700 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={action.type}
                  onChange={(e) => patchAction(i, { type: e.target.value as FlowOutputActionType })}
                  aria-label={`Action ${i + 1} type`}
                  className={INPUT_CLS + ' cursor-pointer max-w-[16rem] text-xs font-mono'}
                >
                  {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input
                  value={action.when ?? ''}
                  onChange={(e) => patchAction(i, { when: e.target.value || undefined })}
                  placeholder="when (e.g. $result.found)"
                  aria-label={`Action ${i + 1} when gate`}
                  className={MONO_INPUT_CLS}
                />
                <Button variant="ghost" size="sm" onClick={() => patch({ actions: draft.actions.filter((_, j) => j !== i) })} aria-label={`Remove action ${i + 1}`}>
                  <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
              {(action.type === 'formlogic.submitResponse' || action.type === 'formlogic.updateResponse') && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input value={action.form ?? ''} onChange={(e) => patchAction(i, { form: e.target.value || undefined })} placeholder="form id" aria-label={`Action ${i + 1} form`} className={MONO_INPUT_CLS} />
                  {action.type === 'formlogic.updateResponse' && (
                    <input value={action.responseId ?? ''} onChange={(e) => patchAction(i, { responseId: e.target.value || undefined })} placeholder="responseId ($result.record.id)" aria-label={`Action ${i + 1} responseId`} className={MONO_INPUT_CLS} />
                  )}
                  <input value={typeof action.answers === 'string' ? action.answers : cellToString(action.answers)} onChange={(e) => patchAction(i, { answers: e.target.value })} placeholder='answers ($result or {"field":"$result.x"})' aria-label={`Action ${i + 1} answers`} className={MONO_INPUT_CLS + ' sm:col-span-2'} />
                </div>
              )}
              {action.type === 'connector.request' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input value={action.connectorId ?? ''} onChange={(e) => patchAction(i, { connectorId: e.target.value || undefined })} placeholder="connectorId (aokie)" aria-label={`Action ${i + 1} connector`} className={MONO_INPUT_CLS} />
                  <input value={action.command ?? ''} onChange={(e) => patchAction(i, { command: e.target.value || undefined })} placeholder="command (sms.send)" aria-label={`Action ${i + 1} command`} className={MONO_INPUT_CLS} />
                  <input value={typeof action.payload === 'string' ? action.payload : cellToString(action.payload)} onChange={(e) => patchAction(i, { payload: e.target.value })} placeholder='payload ({"to":"$event.data.from"})' aria-label={`Action ${i + 1} payload`} className={MONO_INPUT_CLS} />
                </div>
              )}
              {(action.type === 'formlogic.toast' || action.type === 'call.speak') && (
                <input value={action.message ?? ''} onChange={(e) => patchAction(i, { message: e.target.value })} placeholder="message ({{result.summary}} interpolates)" aria-label={`Action ${i + 1} message`} className={MONO_INPUT_CLS} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Switch checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" size="sm" />
          <Button variant="ghost" size="sm" onClick={onDelete} aria-label="Delete binding">
            <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
          </Button>
        </div>
        <Button size="sm" onClick={save} isLoading={saving} disabled={saving}>{binding ? 'Save binding' : 'Create binding'}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run history.
// ---------------------------------------------------------------------------

function RunHistory({ appId }: { appId: string }) {
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  // Initial fetch: setState only from the promise callback (never synchronously in the effect).
  useEffect(() => {
    let cancelled = false;
    api.listFlowRuns(appId, { limit: 25 }).then((r) => {
      if (cancelled) return;
      if (r.data) setRuns(r.data.runs);
      else if (r.error) toast.error('Failed to load run history', typeof r.error === 'string' ? r.error : undefined);
    });
    return () => { cancelled = true; };
  }, [appId]);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.listFlowRuns(appId, { limit: 25 });
    setLoading(false);
    if (r.error || !r.data) {
      toast.error('Failed to load run history', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    setRuns(r.data.runs);
  }, [appId]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300">Run history</h4>
        <Button variant="ghost" size="sm" onClick={load} isLoading={loading} disabled={loading} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
          Refresh
        </Button>
      </div>
      {runs === null || runs.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-slate-500">
          {runs === null ? 'Loading…' : 'No runs yet — bindings and test runs appear here.'}
        </p>
      ) : (
        <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-slate-400 border-b border-gray-200/80 dark:border-slate-700/60">
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
        onClick={onToggle}
        className="border-b border-gray-100 dark:border-slate-800 last:border-b-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/40"
      >
        <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-slate-300">{run.flow ?? '—'}</td>
        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{run.triggerEvent}</td>
        <td className="px-3 py-2">{statusChip(run.status)}</td>
        <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{run.startedAt ?? run.createdAt}</td>
        <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">{runDuration(run)}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 dark:border-slate-800 last:border-b-0">
          <td colSpan={5} className="px-3 py-2 bg-gray-50/70 dark:bg-slate-800/40">
            {run.error && (
              <p className="text-xs text-red-600 dark:text-red-400 mb-1.5">
                {run.error.code}: {run.error.message}{run.error.nodeId ? ` (node '${run.error.nodeId}')` : ''}
              </p>
            )}
            <pre className="text-xs text-gray-600 dark:text-slate-400 overflow-x-auto max-h-40 whitespace-pre">
              {JSON.stringify({ inputSnapshot: run.inputSnapshot, result: run.result, error: run.error }, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Panel.
// ---------------------------------------------------------------------------

export function FlowsPanel({ appId }: { appId: string; appSlug?: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [bindings, setBindings] = useState<FlowBinding[]>([]);
  const [showNewBinding, setShowNewBinding] = useState(false);
  const [pendingDeleteBinding, setPendingDeleteBinding] = useState<FlowBinding | null>(null);
  const eventsListId = `flow-events-${appId}`;

  useEffect(() => {
    if (!open || loaded) return;
    void (async () => {
      const [flowsRes, bindingsRes] = await Promise.all([api.listFlows(appId), api.listFlowBindings(appId)]);
      if (flowsRes.data) setFlows(flowsRes.data.flows);
      if (bindingsRes.data) setBindings(bindingsRes.data.bindings);
      if (flowsRes.error) toast.error('Failed to load flows', typeof flowsRes.error === 'string' ? flowsRes.error : undefined);
      setLoaded(true);
    })();
  }, [open, loaded, appId]);

  const confirmDeleteBinding = async () => {
    if (!pendingDeleteBinding) return;
    const binding = pendingDeleteBinding;
    setPendingDeleteBinding(null);
    const r = await api.deleteFlowBinding(appId, binding.id);
    if (r.error) {
      toast.error('Failed to delete binding', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    setBindings((list) => list.filter((b) => b.id !== binding.id));
  };

  return (
    <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 text-left">
        <Workflow className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        <h3 className="flex-1 font-medium text-gray-900 dark:text-white tracking-tight">Flows</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">
          {loaded ? `${flows.length} flow${flows.length === 1 ? '' : 's'} · ${bindings.length} binding${bindings.length === 1 ? '' : 's'}` : ''}
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Event-driven automations over this app's data. Author flows in the{' '}
            <Link to="/flows" className="font-medium text-primary-600 dark:text-primary-400 hover:underline">Flows workspace</Link>{' '}
            (visual graph editor + test runs); bind them to events here.
          </p>

          <datalist id={eventsListId}>
            {EVENT_SUGGESTIONS.map((e) => <option key={e} value={e} />)}
          </datalist>

          {/* Flow library (authoring lives in the Flows workspace) */}
          {flows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 dark:border-slate-700">
              <EmptyState
                icon={Workflow}
                title="No flows yet"
                description="Create this app's flows in the Flows workspace (starter templates included), then bind them to events here."
                action={
                  <Link
                    to="/flows"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open Flows workspace
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

          {/* Bindings */}
          {flows.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300">Event bindings</h4>
                {!showNewBinding && (
                  <Button variant="outline" size="sm" onClick={() => setShowNewBinding(true)} leftIcon={<Plus className="h-3.5 w-3.5" />}>
                    Add binding
                  </Button>
                )}
              </div>
              <div className="space-y-3">
                {bindings.map((binding) => (
                  <BindingCard
                    key={binding.id}
                    appId={appId}
                    binding={binding}
                    flows={flows}
                    eventsListId={eventsListId}
                    onSaved={(updated) => setBindings((list) => list.map((b) => (b.id === updated.id ? updated : b)))}
                    onDelete={() => setPendingDeleteBinding(binding)}
                  />
                ))}
                {showNewBinding && (
                  <BindingCard
                    appId={appId}
                    binding={null}
                    flows={flows}
                    eventsListId={eventsListId}
                    onSaved={(created) => {
                      setBindings((list) => [...list, created]);
                      setShowNewBinding(false);
                    }}
                    onDelete={() => setShowNewBinding(false)}
                  />
                )}
                {bindings.length === 0 && !showNewBinding && (
                  <p className="text-xs text-gray-400 dark:text-slate-500">
                    No bindings — flows only run via workspace test runs or the flow.run app-logic effect until you bind an event.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Run history */}
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
