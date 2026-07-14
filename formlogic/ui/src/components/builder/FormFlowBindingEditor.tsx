// Shared on-submit binding editor for the builder-side Flows dock.
//
// It intentionally serializes through formFlowBindingsSerialize.ts so the builder edits the same
// payload shape the /flows Triggers panel expects for form.submitted bindings.
import { useState } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import type { FlowBinding, FlowBindingMode, FlowDefinition } from '../../types/flows';
import type { FormField } from '../../types/form';
import {
  buildBindingPayload,
  rowsFromInputMap,
  type BindingDraft,
  type InputMappingRow,
} from './formFlowBindingsSerialize';
import { triggerInputNamesFromFlow } from './formFlowSeed';

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

function firstUnusedInput(inputNames: string[], rows: InputMappingRow[]): string {
  return inputNames.find((name) => !rows.some((row) => row.input === name)) ?? '';
}

export function FormFlowBindingEditor({
  fields,
  flows,
  binding,
  onSave,
  onDone,
  onCancel,
}: {
  fields: FormField[];
  flows: FlowDefinition[];
  binding: FlowBinding | null;
  onSave: (binding: FlowBinding | null, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<BindingDraft>(() => draftFromBinding(binding, flows));
  const [saving, setSaving] = useState(false);
  const selectedFlow = flows.find((flow) => flow.slug === draft.flow) ?? null;
  const inputNames = triggerInputNamesFromFlow(selectedFlow);
  const hasBlankInput = draft.rows.some((row) => row.input.trim() === '');

  const patch = (updates: Partial<BindingDraft>) => setDraft((prev) => ({ ...prev, ...updates }));
  const setRow = (i: number, updates: Partial<InputMappingRow>) =>
    setDraft((prev) => ({ ...prev, rows: prev.rows.map((row, idx) => (idx === i ? { ...row, ...updates } : row)) }));
  const addRow = () =>
    setDraft((prev) => ({
      ...prev,
      rows: [
        ...prev.rows,
        {
          input: firstUnusedInput(inputNames, prev.rows),
          source: 'field',
          fieldId: fields[0]?.id,
        },
      ],
    }));
  const removeRow = (i: number) => setDraft((prev) => ({ ...prev, rows: prev.rows.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!draft.flow) {
      toast.error('Pick a flow', 'Choose which flow runs when this form is submitted.');
      return;
    }
    setSaving(true);
    const result = await onSave(binding, buildBindingPayload(draft));
    setSaving(false);
    if (!result.ok) {
      toast.error('Failed to save binding', result.error);
      return;
    }
    toast.success(binding ? 'Binding updated' : 'Binding added');
    onDone();
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50/70 dark:bg-slate-800/40 p-4 space-y-4">
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className={LABEL_CLS} htmlFor="flow-select">Flow to run</label>
          <select
            id="flow-select"
            value={draft.flow}
            onChange={(e) => patch({ flow: e.target.value })}
            className={cn(INPUT_CLS, 'cursor-pointer')}
          >
            {flows.length === 0 && <option value="">No flows yet</option>}
            {flows.map((flow) => (
              <option key={flow.id} value={flow.slug}>{flow.name} ({flow.slug})</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLS} htmlFor="mode-select">Mode</label>
            <select
              id="mode-select"
              value={draft.mode}
              onChange={(e) => patch({ mode: e.target.value as FlowBindingMode })}
              className={cn(INPUT_CLS, 'cursor-pointer')}
            >
              <option value="async">Async</option>
              <option value="sync">Sync</option>
            </select>
          </div>
          {draft.mode === 'sync' && (
            <div>
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
        </div>
      </div>

      {draft.mode === 'sync' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Sync bindings block submission until the flow finishes or times out. Prefer Async unless the submitter needs the result immediately.</span>
        </div>
      )}

      <div className="space-y-2">
        <span className={cn(LABEL_CLS, 'mb-0')}>Input mapping</span>
        {inputNames.length > 0 && (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Input names come from the selected flow's Trigger. Choose Custom to type a name manually.
          </p>
        )}
        {draft.rows.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-slate-500">No inputs mapped; the flow runs with no inputs.</p>
        )}
        {draft.rows.map((row, i) => {
          const declared = inputNames.includes(row.input);
          const inputSelectValue = declared ? row.input : '__custom';
          return (
            <div key={i} className="rounded-lg border border-gray-200/80 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/30 p-2 space-y-2">
              <div className="grid grid-cols-1 gap-2">
                {inputNames.length > 0 ? (
                  <div className="flex gap-2">
                    <select
                      aria-label={`Flow input name ${i + 1}`}
                      value={inputSelectValue}
                      onChange={(e) => {
                        if (e.target.value === '__custom') setRow(i, { input: '' });
                        else setRow(i, { input: e.target.value });
                      }}
                      className={cn(INPUT_CLS, 'cursor-pointer min-w-0 flex-1')}
                    >
                      {inputNames.map((name) => <option key={name} value={name}>{name}</option>)}
                      <option value="__custom">Custom...</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      aria-label={`Remove input row ${i + 1}`}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      aria-label={`Flow input name ${i + 1}`}
                      placeholder="input name"
                      value={row.input}
                      onChange={(e) => setRow(i, { input: e.target.value })}
                      className="min-w-0 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      aria-label={`Remove input row ${i + 1}`}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {inputNames.length > 0 && !declared && (
                  <Input
                    aria-label={`Custom flow input name ${i + 1}`}
                    placeholder="custom input name"
                    value={row.input}
                    onChange={(e) => setRow(i, { input: e.target.value })}
                  />
                )}
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 dark:text-slate-500 text-sm">from</span>
                  <select
                    aria-label={`Input source ${i + 1}`}
                    value={row.source}
                    onChange={(e) => setRow(i, { source: e.target.value as 'field' | 'static' })}
                    className={cn(INPUT_CLS, 'cursor-pointer w-28')}
                  >
                    <option value="field">Field</option>
                    <option value="static">Value</option>
                  </select>
                  {row.source === 'field' ? (
                    <select
                      aria-label={`Field for input ${i + 1}`}
                      value={row.fieldId ?? ''}
                      onChange={(e) => setRow(i, { fieldId: e.target.value })}
                      className={cn(INPUT_CLS, 'cursor-pointer min-w-0 flex-1')}
                    >
                      <option value="">Select a field...</option>
                      {fields.map((field) => (
                        <option key={field.id} value={field.id}>{field.label || field.id}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      aria-label={`Static value for input ${i + 1}`}
                      placeholder="literal or JSON"
                      value={row.staticValue ?? ''}
                      onChange={(e) => setRow(i, { staticValue: e.target.value })}
                      className="min-w-0 flex-1 font-mono text-xs"
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {hasBlankInput && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Blank input-name rows are dropped on save.
          </p>
        )}
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-3.5 w-3.5" /> Add input
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-gray-200 dark:border-slate-700 pt-3">
        <Switch checked={draft.enabled} onChange={(value) => patch({ enabled: value })} label="Enabled" size="sm" />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : binding ? 'Save binding' : 'Create binding'}
          </Button>
        </div>
      </div>
    </div>
  );
}
