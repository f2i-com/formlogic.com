// On-submit flow bindings for the FORM builder (docs/FORMLOGIC_FLOWS.md §5/§8).
//
// A form owner can wire the form's `form.submitted` event to one of their WORKSPACE flows:
// after a record is submitted the server enqueues a run (queued), which executes in an open
// app session or FormLogic Desktop. This panel edits the standalone-form bindings served by
// GET/POST/PUT/DELETE /api/forms/{id}/flow-bindings (app-attached forms are wired from the
// app's Flows panel instead). Input mapping rows turn a flow input into either a
// `$event.data.answers.<fieldId>` selector (populated from the form's fields) or a static
// literal — the serialization is a pure function (buildBindingPayload) so it is unit-tested
// without a DOM.
import { useCallback, useEffect, useState } from 'react';
import { Workflow, Plus, Trash2, Pencil, AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import type { FlowBinding, FlowBindingMode, FlowDefinition } from '../../types/flows';
import type { FormField } from '../../types/form';
import {
  FORM_SUBMITTED_EVENT,
  buildBindingPayload,
  rowsFromInputMap,
  type BindingDraft,
  type InputMappingRow,
} from './formFlowBindingsSerialize';

const INPUT_CLS =
  'w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none';
const LABEL_CLS = 'block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1';

function draftFromBinding(binding: FlowBinding | null, flows: FlowDefinition[]): BindingDraft {
  return {
    flow: binding?.flow ?? flows[0]?.slug ?? '',
    mode: binding?.mode ?? 'async',
    rows: rowsFromInputMap(binding?.inputMap),
    timeoutMs: binding?.timeoutMs ?? 30000,
    enabled: binding?.enabled ?? true,
  };
}

// ---------------------------------------------------------------------------
// Binding editor.
// ---------------------------------------------------------------------------

function BindingEditor({
  formId,
  fields,
  flows,
  binding,
  onDone,
  onCancel,
}: {
  formId: string;
  fields: FormField[];
  flows: FlowDefinition[];
  binding: FlowBinding | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<BindingDraft>(() => draftFromBinding(binding, flows));
  const [saving, setSaving] = useState(false);
  const patch = (updates: Partial<BindingDraft>) => setDraft((prev) => ({ ...prev, ...updates }));

  const setRow = (i: number, updates: Partial<InputMappingRow>) =>
    setDraft((prev) => ({ ...prev, rows: prev.rows.map((r, idx) => (idx === i ? { ...r, ...updates } : r)) }));
  const addRow = () =>
    setDraft((prev) => ({ ...prev, rows: [...prev.rows, { input: '', source: 'field', fieldId: fields[0]?.id }] }));
  const removeRow = (i: number) => setDraft((prev) => ({ ...prev, rows: prev.rows.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!draft.flow) {
      toast.error('Pick a flow', 'Choose which flow runs when this form is submitted.');
      return;
    }
    setSaving(true);
    const payload = buildBindingPayload(draft);
    const res = binding
      ? await api.updateFormFlowBinding(formId, binding.id, payload)
      : await api.createFormFlowBinding(formId, payload);
    setSaving(false);
    if (res.error || !res.data) {
      toast.error('Failed to save binding', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    toast.success(binding ? 'Binding updated' : 'Binding added');
    onDone();
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50/70 dark:bg-slate-800/40 p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLS} htmlFor="flow-select">Flow to run</label>
          <select
            id="flow-select"
            value={draft.flow}
            onChange={(e) => patch({ flow: e.target.value })}
            className={INPUT_CLS + ' cursor-pointer'}
          >
            {flows.length === 0 && <option value="">No workspace flows yet</option>}
            {flows.map((f) => (
              <option key={f.id} value={f.slug}>{f.name} ({f.slug})</option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="mode-select">Mode</label>
          <select
            id="mode-select"
            value={draft.mode}
            onChange={(e) => patch({ mode: e.target.value as FlowBindingMode })}
            className={INPUT_CLS + ' cursor-pointer'}
          >
            <option value="async">Async (recommended)</option>
            <option value="sync">Sync (wait for the flow)</option>
          </select>
        </div>
      </div>

      {draft.mode === 'sync' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Sync bindings block the submitter until the flow finishes or the timeout elapses. Keep the timeout
            short and prefer Async unless the submitter needs the result immediately.
          </span>
        </div>
      )}

      {draft.mode === 'sync' && (
        <div className="max-w-[12rem]">
          <label className={LABEL_CLS} htmlFor="timeout-input">Timeout (ms)</label>
          <Input
            id="timeout-input"
            type="number"
            min={250}
            max={300000}
            value={String(draft.timeoutMs)}
            onChange={(e) => patch({ timeoutMs: Math.max(250, Math.min(300000, Number(e.target.value) || 30000)) })}
          />
        </div>
      )}

      <div className="space-y-2">
        <span className={LABEL_CLS + ' mb-0'}>Input mapping (flow input ← form field or value)</span>
        {draft.rows.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-slate-500">No inputs mapped — the flow runs with no inputs.</p>
        )}
        {draft.rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Flow input name ${i + 1}`}
              placeholder="input name"
              value={row.input}
              onChange={(e) => setRow(i, { input: e.target.value })}
              className="w-32"
            />
            <span className="text-gray-400 dark:text-slate-500 text-sm">←</span>
            <select
              aria-label={`Input source ${i + 1}`}
              value={row.source}
              onChange={(e) => setRow(i, { source: e.target.value as 'field' | 'static' })}
              className={INPUT_CLS + ' cursor-pointer w-28'}
            >
              <option value="field">Field</option>
              <option value="static">Value</option>
            </select>
            {row.source === 'field' ? (
              <select
                aria-label={`Field for input ${i + 1}`}
                value={row.fieldId ?? ''}
                onChange={(e) => setRow(i, { fieldId: e.target.value })}
                className={INPUT_CLS + ' cursor-pointer flex-1 min-w-[8rem]'}
              >
                <option value="">Select a field…</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>{f.label || f.id}</option>
                ))}
              </select>
            ) : (
              <Input
                aria-label={`Static value for input ${i + 1}`}
                placeholder="literal or JSON"
                value={row.staticValue ?? ''}
                onChange={(e) => setRow(i, { staticValue: e.target.value })}
                className="flex-1 min-w-[8rem] font-mono text-xs"
              />
            )}
            <button
              type="button"
              onClick={() => removeRow(i)}
              aria-label={`Remove input row ${i + 1}`}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-3.5 w-3.5" /> Add input
        </Button>
      </div>

      <div className="flex items-center justify-between pt-1">
        <Switch checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" size="sm" />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : binding ? 'Save binding' : 'Add binding'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel.
// ---------------------------------------------------------------------------

export function FormFlowBindings({ formId, fields }: { formId: string; fields: FormField[] }) {
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [bindings, setBindings] = useState<FlowBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FlowBinding | null | 'new'>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // No synchronous setLoading(true) here — the initial state is already `true`, and
    // reloads (after create/delete) just refresh the lists in place. This keeps the
    // effect body free of a synchronous setState (react-hooks/set-state-in-effect).
    const [flowsRes, bindingsRes] = await Promise.all([
      api.listWorkspaceFlows(),
      api.listFormFlowBindings(formId),
    ]);
    if (flowsRes.data) setFlows(flowsRes.data.flows);
    if (bindingsRes.data) {
      setBindings(bindingsRes.data.bindings.filter((b) => b.event === FORM_SUBMITTED_EVENT));
    }
    if (flowsRes.error) {
      toast.error('Failed to load flows', typeof flowsRes.error === 'string' ? flowsRes.error : undefined);
    }
    setLoading(false);
  }, [formId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch: loads flows + bindings when the form changes
  useEffect(() => { void load(); }, [load]);

  const doDelete = async (bindingId: string) => {
    const res = await api.deleteFormFlowBinding(formId, bindingId);
    if (res.error) {
      toast.error('Failed to delete binding', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    toast.success('Binding removed');
    setConfirmDeleteId(null);
    void load();
  };

  const flowName = (slug: string) => flows.find((f) => f.slug === slug)?.name ?? slug;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-50 dark:bg-primary-500/10 p-2">
          <Workflow className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">On-submit flows</h3>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Runs after a record is submitted; queued server-side, executes in your open app session or
            FormLogic Desktop.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
      ) : (
        <>
          {flows.length === 0 && editing === null && (
            <p className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 px-3 py-4 text-center text-xs text-gray-500 dark:text-slate-400">
              You have no workspace flows yet. Create one in the Flows workspace, then bind it here.
            </p>
          )}

          {bindings.map((b) =>
            editing === b ? (
              <BindingEditor
                key={b.id}
                formId={formId}
                fields={fields}
                flows={flows}
                binding={b}
                onDone={() => { setEditing(null); void load(); }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div
                key={b.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{flowName(b.flow)}</p>
                  <p className="truncate font-mono text-xs text-gray-400 dark:text-slate-500">
                    {b.mode} · {Object.keys(b.inputMap ?? {}).length} input(s){b.enabled ? '' : ' · disabled'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(b)}
                  aria-label={`Edit binding for ${flowName(b.flow)}`}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(b.id)}
                  aria-label={`Delete binding for ${flowName(b.flow)}`}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          )}

          {editing === 'new' ? (
            <BindingEditor
              formId={formId}
              fields={fields}
              flows={flows}
              binding={null}
              onDone={() => { setEditing(null); void load(); }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            flows.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
                <Plus className="h-3.5 w-3.5" /> Add on-submit flow
              </Button>
            )
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={confirmDeleteId !== null}
        title="Remove this flow binding?"
        message="This form will no longer trigger the flow when a record is submitted."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => confirmDeleteId && doDelete(confirmDeleteId)}
        onClose={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
