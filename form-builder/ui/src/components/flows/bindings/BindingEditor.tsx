// FormLogic Flows binding editor.
//
// Shared by the app Deploy panel and the /flows Triggers rail. It edits the binding payload only;
// callers decide whether that payload is saved through app routes or form-scoped workspace routes.
// Transient editor state (JSON validation, insert targets) stays local and never enters node data.
import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Search, Trash2 } from 'lucide-react';
import { cn, generateId } from '../../../lib/utils';
import { toast } from '../../../stores/toastStore';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { EventPicker } from '../EventPicker';
import { mergeKnownConnectorCommands } from '../flowEventCatalog';
import { filterForms, formsForContext, shouldSearch } from '../editor/formPicker';
import {
  EMPTY_FLOW_EDITOR_CONTEXT,
  formatChipInsert,
  insertIntoInput,
  type FlowConnectorInfo,
  type FlowEditorContext,
  type ReferenceSyntax,
} from '../editor/nodeCatalog';
import type { FlowFormOption } from '../editor/NodeProperties';
import { declaredInputNames } from '../editor/nodeSummary';
import type {
  FlowBinding,
  FlowBindingMode,
  FlowDefinition,
  FlowOutputAction,
  FlowOutputActionType,
} from '../../../types/flows';

const EVENT_DATA_HINTS = [
  '$event.data',
  '$event.data.callId',
  '$event.data.from',
  '$event.data.callerPhone',
  '$event.data.body',
  '$event.data.text',
  '$event.data.speaker',
  '$event.data.outcome',
  '$event.data.durationSeconds',
  '$event.data.formId',
  '$event.data.responseId',
  '$event.data.answers',
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
const ERROR_CLS = 'mt-1 flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400';

export interface BindingDraft {
  event: string;
  flow: string;
  formId: string;
  mode: FlowBindingMode;
  conditionExpr: string;
  inputRows: Array<{ id: string; key: string; value: string }>;
  actions: FlowOutputAction[];
  timeoutMs: number;
  enabled: boolean;
}

interface BindingEditorProps {
  binding: FlowBinding | null;
  flows: FlowDefinition[];
  connectors?: FlowConnectorInfo[];
  forms?: FlowFormOption[];
  context?: FlowEditorContext;
  /** Workspace-flow trigger editor: the event is fixed to form.submitted and a form is required. */
  workspaceFormOnly?: boolean;
  /** Used by /flows so a selected flow's trigger cannot be retargeted to another flow. */
  lockFlow?: boolean;
  /** Existing workspace bindings stay on their current form route; create a new binding to move. */
  lockFormId?: boolean;
  onSave: (payload: Record<string, unknown>, draft: BindingDraft) => Promise<FlowBinding | null>;
  onSaved: (binding: FlowBinding) => void;
  onDelete: () => void;
}

/** Parse a value cell: valid JSON stays typed; anything else is a raw string/selector. */
function parseCell(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return '';
  if (/^[{["]|^-?\d|^(true|false|null)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through - treat as a raw string/selector */
    }
  }
  return raw;
}

function cellToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function jsonCellError(raw: string): string | null {
  const t = raw.trim();
  if (t === '' || (!t.startsWith('{') && !t.startsWith('['))) return null;
  try {
    JSON.parse(t);
    return null;
  } catch {
    return 'Invalid JSON. Use valid JSON or a bare selector/string.';
  }
}

function draftFromBinding(
  binding: FlowBinding | null,
  flows: FlowDefinition[],
  forms: FlowFormOption[],
  workspaceFormOnly: boolean,
  hasAokieConnector: boolean,
): BindingDraft {
  return {
    event: workspaceFormOnly ? 'form.submitted' : binding?.event ?? (hasAokieConnector ? 'aokie.call.incoming' : 'form.submitted'),
    flow: binding?.flow ?? flows[0]?.slug ?? '',
    formId: binding?.formId ?? (workspaceFormOnly ? forms[0]?.id ?? '' : ''),
    mode: binding?.mode ?? 'async',
    conditionExpr: binding?.condition?.expr ?? '',
    inputRows: Object.entries(binding?.inputMap ?? {}).map(([key, value]) => ({ id: generateId(), key, value: cellToString(value) })),
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
  const payload: Record<string, unknown> = {
    event: draft.event.trim(),
    flow: draft.flow,
    mode: draft.mode,
    condition: draft.conditionExpr.trim() !== '' ? { type: 'expression', expr: draft.conditionExpr.trim() } : null,
    inputMap: Object.keys(inputMap).length > 0 ? inputMap : null,
    outputActions: actions.length > 0 ? actions : null,
    timeoutMs: draft.timeoutMs,
    enabled: draft.enabled,
  };
  if (draft.formId.trim() !== '') payload.formId = draft.formId.trim();
  return payload;
}

function ChipRow({ mode, onInsert }: { mode: ReferenceSyntax; onInsert: (formatted: string) => 'inserted' | 'copied' }) {
  const [flash, setFlash] = useState<{ h: string; kind: 'inserted' | 'copied' } | null>(null);
  const activate = (h: string) => {
    const kind = onInsert(formatChipInsert(h, mode));
    setFlash({ h, kind });
    setTimeout(() => setFlash((f) => (f?.h === h ? null : f)), 1200);
  };
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {EVENT_DATA_HINTS.map((h) => (
        <button
          key={h}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => activate(h)}
          title="Insert at cursor (or copy)"
          className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 hover:bg-primary-100 hover:text-primary-700 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-primary-500/20 dark:hover:text-primary-200"
        >
          {flash?.h === h ? (flash.kind === 'inserted' ? 'inserted!' : 'copied!') : h}
        </button>
      ))}
    </div>
  );
}

function BindingFormPicker({
  options,
  value,
  onChange,
  context,
  disabled = false,
}: {
  options: FlowFormOption[];
  value: string;
  onChange: (id: string) => void;
  context: FlowEditorContext;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = options.find((f) => f.id === value) ?? null;
  const results = useMemo(() => filterForms(options, query).slice(0, 30), [options, query]);
  const searchable = shouldSearch(options, context);

  if (!searchable) {
    return (
      <select
        value={options.some((f) => f.id === value) ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Binding form"
        className={cn(INPUT_CLS, 'cursor-pointer', disabled && 'cursor-not-allowed opacity-70')}
      >
        <option value="">Select a form...</option>
        {options.map((f) => (
          <option key={f.id} value={f.id}>{f.title}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={open ? query : selected?.title ?? ''}
          placeholder={selected ? selected.title : 'Search your forms...'}
          disabled={disabled}
          onFocus={() => { if (!disabled) { setOpen(true); setQuery(''); } }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); } }}
          className={cn(INPUT_CLS, 'pl-8', disabled && 'cursor-not-allowed opacity-70')}
          role="combobox"
          aria-expanded={open}
          aria-label="Search your forms"
        />
      </div>
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-gray-400 dark:text-slate-500">No forms match "{query}".</li>
          ) : (
            results.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={f.id === value}
                  onMouseDown={(e) => { e.preventDefault(); onChange(f.id); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors',
                    f.id === value
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  {f.title}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function BindingEditor({
  binding,
  flows,
  connectors = [],
  forms = [],
  context = EMPTY_FLOW_EDITOR_CONTEXT,
  workspaceFormOnly = false,
  lockFlow = false,
  lockFormId = false,
  onSave,
  onSaved,
  onDelete,
}: BindingEditorProps) {
  const formOptions = useMemo(() => formsForContext(forms, context), [forms, context]);
  const availableConnectorIds = useMemo(
    () => [...new Set([...connectors.map((connector) => connector.id), ...context.connectors.map((connector) => connector.id)])],
    [connectors, context.connectors],
  );
  const hasAokieConnector = availableConnectorIds.includes('aokie');
  const [draft, setDraft] = useState<BindingDraft>(() => draftFromBinding(binding, flows, formOptions, workspaceFormOnly, hasAokieConnector));
  const [saving, setSaving] = useState(false);
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [commandListPrefix] = useState(() => generateId());
  const patch = (p: Partial<BindingDraft>) => setDraft((d) => ({ ...d, ...p }));

  const patchAction = (index: number, p: Partial<FlowOutputAction>) =>
    setDraft((d) => ({ ...d, actions: d.actions.map((a, i) => (i === index ? { ...a, ...p } : a)) }));

  const selectedFlowDef = flows.find((f) => f.slug === draft.flow) ?? null;
  const declaredInputs = useMemo(() => {
    const trigger = selectedFlowDef?.flowJson?.nodes?.find((n) => n.type === 'input');
    return trigger ? declaredInputNames(trigger.data ?? {}) : [];
  }, [selectedFlowDef]);

  const conditionInputRef = useRef<HTMLInputElement | null>(null);
  const activeInputRowRef = useRef<HTMLInputElement | null>(null);
  const insertOrCopy = (el: HTMLInputElement | null, formatted: string): 'inserted' | 'copied' => {
    if (el && el.isConnected) { insertIntoInput(el, formatted); return 'inserted'; }
    void navigator.clipboard?.writeText(formatted).catch(() => {});
    return 'copied';
  };

  const validateJson = (key: string, raw: string): boolean => {
    const msg = jsonCellError(raw);
    setJsonErrors((errors) => {
      const next = { ...errors };
      if (msg) next[key] = msg;
      else delete next[key];
      return next;
    });
    return msg === null;
  };

  const validateAllJson = (): boolean => {
    const next: Record<string, string> = {};
    for (const row of draft.inputRows) {
      const msg = jsonCellError(row.value);
      if (msg) next[`input:${row.id}`] = msg;
    }
    draft.actions.forEach((action, index) => {
      if (typeof action.answers === 'string') {
        const msg = jsonCellError(action.answers);
        if (msg) next[`action:${index}:answers`] = msg;
      }
      if (typeof action.payload === 'string') {
        const msg = jsonCellError(action.payload);
        if (msg) next[`action:${index}:payload`] = msg;
      }
    });
    setJsonErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async () => {
    if (!draft.flow) {
      toast.error('Pick a flow for this binding');
      return;
    }
    if ((workspaceFormOnly || draft.event === 'form.submitted') && formOptions.length > 0 && draft.formId.trim() === '') {
      toast.error('Pick a form for this trigger');
      return;
    }
    if (!validateAllJson()) {
      toast.error('Fix invalid JSON before saving');
      return;
    }
    setSaving(true);
    try {
      const saved = await onSave(draftToPayload(draft), draft);
      setSaving(false);
      if (!saved) return;
      onSaved(saved);
      toast.success('Binding saved', `${saved.event} -> ${saved.flow}`);
    } catch (error) {
      setSaving(false);
      toast.error('Failed to save binding', error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200/80 p-4 dark:border-slate-700/60 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className={LABEL_CLS}>Event</label>
          {workspaceFormOnly ? (
            <input value="form.submitted" readOnly aria-label="Binding event name" className={cn(MONO_INPUT_CLS, 'cursor-not-allowed opacity-80')} />
          ) : (
            <EventPicker
              value={draft.event}
              connectorIds={availableConnectorIds}
              onChange={(next) => patch({
                event: next.event,
                ...(next.event === 'form.submitted' && !draft.formId && formOptions[0] ? { formId: formOptions[0].id } : {}),
                ...(next.presetCondition !== undefined ? { conditionExpr: next.presetCondition } : {}),
              })}
              aria-label="Binding event name"
              inputClassName={MONO_INPUT_CLS}
            />
          )}
        </div>
        <div>
          <label className={LABEL_CLS}>Flow</label>
          <select
            value={draft.flow}
            onChange={(e) => patch({ flow: e.target.value })}
            disabled={lockFlow}
            aria-label="Binding flow"
            className={cn(INPUT_CLS, 'cursor-pointer', lockFlow && 'cursor-not-allowed opacity-70')}
          >
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

      {(workspaceFormOnly || draft.event === 'form.submitted') && formOptions.length > 0 && (
        <div>
          <label className={LABEL_CLS}>Form</label>
          <BindingFormPicker
            options={formOptions}
            value={draft.formId}
            onChange={(formId) => patch({ formId })}
            context={context}
            disabled={lockFormId}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr,8rem]">
        <div>
          <label className={LABEL_CLS}>Condition (sandboxed boolean over <span className="font-mono">event</span>; optional)</label>
          <input
            ref={conditionInputRef}
            value={draft.conditionExpr}
            onChange={(e) => patch({ conditionExpr: e.target.value })}
            placeholder="event.data.direction === 'incoming'"
            aria-label="Binding condition expression"
            className={MONO_INPUT_CLS}
          />
          <ChipRow mode="quickjs" onInsert={(formatted) => insertOrCopy(conditionInputRef.current, formatted)} />
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

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className={LABEL_CLS + ' mb-0'}>Input map (flow input &lt;- selector or literal)</span>
          <Button variant="ghost" size="sm" onClick={() => patch({ inputRows: [...draft.inputRows, { id: generateId(), key: '', value: '' }] })} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Add input
          </Button>
        </div>
        <p className="text-[10px] text-gray-400 dark:text-slate-500">Insert into the focused value field:</p>
        <ChipRow mode="selector" onInsert={(formatted) => insertOrCopy(activeInputRowRef.current, formatted)} />
        {draft.inputRows.length === 0 && (
          <p className="mt-1.5 text-xs text-gray-400 dark:text-slate-500">No inputs - the flow runs with an empty inputs object.</p>
        )}
        <div className="mt-1.5 space-y-1.5">
          {draft.inputRows.map((row, i) => {
            const key = row.key.trim();
            const undeclared = key !== '' && declaredInputs.length > 0 && !declaredInputs.includes(key);
            const jsonKey = `input:${row.id}`;
            return (
              <div key={row.id}>
                <div className="flex items-center gap-2">
                  <input
                    value={row.key}
                    onChange={(e) => patch({ inputRows: draft.inputRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)) })}
                    placeholder="callerPhone"
                    aria-label={`Input name ${i + 1}`}
                    className={MONO_INPUT_CLS + ' max-w-[12rem]'}
                  />
                  <span className="text-xs text-gray-400">&lt;-</span>
                  <input
                    onFocus={(e) => { activeInputRowRef.current = e.currentTarget; }}
                    onBlur={(e) => validateJson(jsonKey, e.currentTarget.value)}
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
                {jsonErrors[jsonKey] && (
                  <p className={ERROR_CLS}>
                    <AlertTriangle className="h-3 w-3 flex-none" />
                    {jsonErrors[jsonKey]}
                  </p>
                )}
                {undeclared && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3 flex-none" />
                    "{key}" is not one of {selectedFlowDef?.name ?? 'the target flow'}'s declared Trigger inputs ({declaredInputs.join(', ')}) - check for a typo.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className={LABEL_CLS + ' mb-0'}>Output actions (applied in order after a successful run)</span>
          <Button variant="ghost" size="sm" onClick={() => patch({ actions: [...draft.actions, { type: 'formlogic.toast', message: '' }] })} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Add action
          </Button>
        </div>
        <div className="space-y-2">
          {draft.actions.map((action, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-2.5 dark:border-slate-700 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={action.type}
                  onChange={(e) => patchAction(i, { type: e.target.value as FlowOutputActionType })}
                  aria-label={`Action ${i + 1} type`}
                  className={INPUT_CLS + ' max-w-[16rem] cursor-pointer font-mono text-xs'}
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input value={action.form ?? ''} onChange={(e) => patchAction(i, { form: e.target.value || undefined })} placeholder="form id" aria-label={`Action ${i + 1} form`} className={MONO_INPUT_CLS} />
                  {action.type === 'formlogic.updateResponse' && (
                    <input value={action.responseId ?? ''} onChange={(e) => patchAction(i, { responseId: e.target.value || undefined })} placeholder="responseId ($result.record.id)" aria-label={`Action ${i + 1} responseId`} className={MONO_INPUT_CLS} />
                  )}
                  <div className="sm:col-span-2">
                    <input
                      value={typeof action.answers === 'string' ? action.answers : cellToString(action.answers)}
                      onBlur={(e) => validateJson(`action:${i}:answers`, e.currentTarget.value)}
                      onChange={(e) => patchAction(i, { answers: e.target.value })}
                      placeholder='answers ($result or {"field":"$result.x"})'
                      aria-label={`Action ${i + 1} answers`}
                      className={MONO_INPUT_CLS}
                    />
                    {jsonErrors[`action:${i}:answers`] && (
                      <p className={ERROR_CLS}>
                        <AlertTriangle className="h-3 w-3 flex-none" />
                        {jsonErrors[`action:${i}:answers`]}
                      </p>
                    )}
                  </div>
                </div>
              )}
              {action.type === 'connector.request' && (() => {
                const grantCommands = connectors.find((c) => c.id === action.connectorId)?.commands ?? [];
                const commands = mergeKnownConnectorCommands(action.connectorId, grantCommands, availableConnectorIds);
                const commandListId = `flow-action-commands-${commandListPrefix}-${i}`;
                return (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input value={action.connectorId ?? ''} onChange={(e) => patchAction(i, { connectorId: e.target.value || undefined })} placeholder={hasAokieConnector ? 'connectorId (aokie)' : 'connectorId'} aria-label={`Action ${i + 1} connector`} className={MONO_INPUT_CLS} />
                    <input value={action.command ?? ''} list={commands.length > 0 ? commandListId : undefined} onChange={(e) => patchAction(i, { command: e.target.value || undefined })} placeholder={hasAokieConnector ? 'command (sms.send)' : 'command'} aria-label={`Action ${i + 1} command`} className={MONO_INPUT_CLS} />
                    {commands.length > 0 && (
                      <datalist id={commandListId}>
                        {commands.map((command) => <option key={command} value={command} />)}
                      </datalist>
                    )}
                    <div>
                      <input
                        value={typeof action.payload === 'string' ? action.payload : cellToString(action.payload)}
                        onBlur={(e) => validateJson(`action:${i}:payload`, e.currentTarget.value)}
                        onChange={(e) => patchAction(i, { payload: e.target.value })}
                        placeholder='payload {"to":"$event.data.from"}'
                        aria-label={`Action ${i + 1} payload`}
                        className={MONO_INPUT_CLS}
                      />
                      {jsonErrors[`action:${i}:payload`] && (
                        <p className={ERROR_CLS}>
                          <AlertTriangle className="h-3 w-3 flex-none" />
                          {jsonErrors[`action:${i}:payload`]}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
              {(action.type === 'formlogic.toast' || action.type === 'call.speak') && (
                <input value={action.message ?? ''} onChange={(e) => patchAction(i, { message: e.target.value })} placeholder="message ({{result.summary}} interpolates)" aria-label={`Action ${i + 1} message`} className={MONO_INPUT_CLS} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex items-center justify-between border-t border-gray-200/80 bg-white/95 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-900/95">
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
