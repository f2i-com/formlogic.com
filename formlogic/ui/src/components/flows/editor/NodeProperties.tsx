// FormLogic Flows editor — properties panel for the selected node.
//
// Edits the selected node's `data` fields per its catalog spec. Field widgets: text / number /
// select / boolean, a plain textarea (templates/prompts), a "QuickJS sandboxed" monospace editor
// for code fields, a JSON/selector monospace editor for structured fields, and the Flows-specific
// FORM PICKER, FILTERS editor and CONNECTOR pickers. Every panel shows the node's one-line
// description and an "Output:" hint (from the catalog) so the shape is visible while authoring.
// Nothing here executes — it only mutates the stored graph.
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { AlertTriangle, Info, Plus, Search, Sparkles, Trash2, Zap } from 'lucide-react';
import { checkFlowCallInput, serviceActionContract, type FlowCallIssue } from './flowCallChecks';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { CodeEditor } from '../../ui/CodeEditor';
import { ErrorBoundary } from '../../ErrorBoundary';
import {
  evalShowIf,
  effectiveNodeData,
  getReferenceSyntax,
  formatChipInsert,
  insertIntoInput,
  EMPTY_FLOW_EDITOR_CONTEXT,
  type FlowEditorContext,
  type NodePropertySpec,
  type ReferenceSyntax,
} from './nodeCatalog';
import { flowNodeRegistry } from '../registry/FlowNodeRegistry';
import { filterForms, formsForContext, shouldSearch } from './formPicker';
import type { FlowFilterOp } from '../../../client-runtime/flows/nodes';
import { listProviders } from '../../../client-runtime/flows/aiProviders';
import { defaultSourceLabel, getAiPreferences } from '../../../client-runtime/flows/aiDefault';
import { buildAiProviderOptions } from './aiProviderOptions';
import {
  desktopClient,
  type DesktopServiceSnapshot,
} from '../../../client-runtime/desktop/desktopClient';
import { catalogAction, useServiceCatalog } from '../../../hooks/useServiceCatalog';
import { useProviderProfiles } from '../../../hooks/useProviderProfiles';
import { mergeKnownConnectorCommands } from '../flowEventCatalog';
import { useAuthStore } from '../../../stores/authStore';

type MonacoEditor = import('monaco-editor').editor.IStandaloneCodeEditor;

/** Does a stored field value read as "set"? (drives showIf's never-hide-a-configured-field safety.) */
function fieldHasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}

/** Common Aokie call fields offered as one-click Trigger inputs when the flow is app-scoped. */
const AOKIE_QUICK_INPUTS: Array<{ name: string; example: string }> = [
  { name: 'callerPhone', example: '+61400000000' },
  { name: 'callId', example: 'call_123' },
  { name: 'callerName', example: 'Alex Smith' },
  { name: 'transcript', example: 'Caller: Hi…' },
];

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500';
const MONO_CLS = INPUT_CLS + ' font-mono text-xs';
const LABEL_CLS = 'block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1';
const HELP_CLS = 'mt-1 text-[11px] leading-snug text-gray-400 dark:text-slate-500';
const LINK_CLS =
  'text-[11px] font-medium text-primary-600 dark:text-primary-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded';

/** A form the picker can offer, with its fields for the filter / answers helpers. */
export interface FlowFormOption {
  id: string;
  title: string;
  fields: Array<{ id: string; label: string }>;
}

const FILTER_OP_OPTIONS: { value: FlowFilterOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
  // Inclusive bounds, pushed down to the database — the date-window ops
  // (ISO dates compare chronologically; the window applies BEFORE the limit).
  { value: 'gte', label: 'on or after (>=)' },
  { value: 'lte', label: 'on or before (<=)' },
  { value: 'in', label: 'one of' },
  // Digits-only last-9-suffix match, pushed down to the database — the
  // caller-ID lookup op ('+61 491 570 156' matches '0491570156').
  { value: 'phone_eq', label: 'phone number matches' },
];

/** Is this a structured (JSON/selector) code field vs. a QuickJS code field? */
function isJsonField(p: NodePropertySpec): boolean {
  return p.type === 'code' && !p.quickjs;
}

/** Turn a stored value into the string a code/text field shows. */
function toInput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** Parse a JSON-field input: valid JSON stays typed; anything else is a raw string (selector). */
function parseJsonField(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return undefined;
  if (/^[{[]|^-?\d|^(true|false|null)$|^"/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through — treat as raw selector string */
    }
  }
  return raw;
}

/** The static form id a form-picker value points at (a real id, not empty and not a `$` selector). */
function staticFormId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && !value.startsWith('$') ? value : null;
}

interface NodePropertiesProps {
  nodeId: string;
  type: string;
  data: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  /** The author's forms (for the form picker + field helpers). */
  forms: FlowFormOption[];
  /** App/connector context (drives the connector pickers). */
  context: FlowEditorContext;
  /** Selectors this node can reference (from the Trigger + prior nodes), shown as copyable chips. */
  insertHints?: string[];
  /** Opens the flow's Triggers panel — surfaced on the Trigger node so events are definable from here. */
  onOpenTriggers?: () => void;
  className?: string;
}

// ── Flows-specific widgets ─────────────────────────────────────────────────────────────────

/** A searchable typeahead over a list of forms (workspace flows / apps with many forms). */
function FormCombobox({
  options,
  value,
  onChange,
}: {
  options: FlowFormOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = options.find((f) => f.id === value) ?? null;
  const results = useMemo(() => filterForms(options, query).slice(0, 30), [options, query]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={open ? query : selected?.title ?? ''}
          placeholder={selected ? selected.title : 'Search your forms…'}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); } }}
          className={INPUT_CLS + ' pl-8'}
          role="combobox"
          aria-expanded={open}
          aria-label="Search your forms"
        />
      </div>
      {open && (
        <ul
          role="listbox"
          className="scrollbar-thin absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-1 shadow-lg"
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
                  className={cnRow(f.id === value)}
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

function cnRow(active: boolean): string {
  return (
    'flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors ' +
    (active
      ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300'
      : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800')
  );
}

/**
 * Form picker (the "too many forms" fix): app-scoped flows get ONLY their app's forms as a short
 * labelled list; workspace flows (or apps with many forms) get a searchable typeahead. A "dynamic
 * value" escape hatch (a form id or a $selector) stays available as a secondary option.
 */
function FormPickerField({
  spec,
  value,
  forms,
  context,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  forms: FlowFormOption[];
  context: FlowEditorContext;
  onChange: (value: unknown) => void;
}) {
  const raw = typeof value === 'string' ? value : '';
  const options = useMemo(() => formsForContext(forms, context), [forms, context]);
  const knownIds = options.map((f) => f.id);
  const [dynamic, setDynamic] = useState(raw !== '' && !knownIds.includes(raw));
  const searchable = shouldSearch(options, context);

  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      {dynamic ? (
        <input
          type="text"
          value={raw}
          placeholder="form id or $inputs.formId"
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLS + ' font-mono text-xs'}
        />
      ) : searchable ? (
        <FormCombobox options={options} value={raw} onChange={(id) => onChange(id || undefined)} />
      ) : (
        <select
          value={knownIds.includes(raw) ? raw : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLS + ' cursor-pointer'}
        >
          <option value="">Select a form…</option>
          {options.map((f) => (
            <option key={f.id} value={f.id}>{f.title}</option>
          ))}
        </select>
      )}
      <div className="mt-1 flex items-center justify-between gap-2">
        {spec.help && <p className={HELP_CLS + ' mt-0 flex-1'}>{spec.help}</p>}
        <button type="button" className={LINK_CLS + ' flex-none'} onClick={() => setDynamic((d) => !d)}>
          {dynamic ? 'Pick from a list' : 'Use a dynamic value'}
        </button>
      </div>
    </label>
  );
}

/**
 * Flow picker (flow_call §8): a select of the context's SIBLING flows by stable id — the same
 * list the runtime's child-flow invoker resolves against. Degrades to a raw stable-id text
 * field when the context carries no flows (embeddings without a flow list). Warns inline on
 * self-recursion (always refused at run time) and keeps an id no longer in the list visible.
 */
function FlowPickerField({
  spec,
  value,
  context,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  context: FlowEditorContext;
  onChange: (value: unknown) => void;
}) {
  const raw = typeof value === 'string' ? value : '';
  const options = context.flows ?? [];

  if (options.length === 0) {
    return <Field spec={spec} value={value} onChange={onChange} />;
  }
  const known = options.some((f) => f.id === raw);
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <select
        value={raw}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        aria-label="Target flow"
        className={INPUT_CLS + ' cursor-pointer'}
      >
        <option value="">Pick a flow…</option>
        {raw !== '' && !known && <option value={raw}>Missing flow ({raw.slice(0, 8)}…)</option>}
        {options.map((f) => (
          <option key={f.id} value={f.id}>{f.name} ({f.slug})</option>
        ))}
      </select>
      {raw !== '' && context.currentFlowId !== undefined && raw === context.currentFlowId && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 flex-none" />
          This flow calls itself — self-recursion is always refused at run time.
        </p>
      )}
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

/** flow_call input-mapping advice (§6.4 lattice consumer) — presentation only, never blocks. */
function FlowCallInputIssues({ issues }: { issues: FlowCallIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {issues.map((issue, i) => (
        <p
          key={`${issue.key ?? ''}:${i}`}
          className={
            'flex items-start gap-1 text-[11px] leading-snug ' +
            (issue.severity === 'error'
              ? 'text-red-600 dark:text-red-400'
              : issue.severity === 'warn'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-400 dark:text-slate-500')
          }
        >
          {issue.severity === 'info'
            ? <Info className="mt-0.5 h-3 w-3 flex-none" />
            : <AlertTriangle className="mt-0.5 h-3 w-3 flex-none" />}
          {issue.message}
        </p>
      ))}
    </div>
  );
}

/** Trigger node: declare/rename/remove the named inputs the flow receives from its binding. */
function TriggerInputsField({
  spec,
  value,
  context,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  context: FlowEditorContext;
  onChange: (value: unknown) => void;
}) {
  const rows = Array.isArray(value)
    ? value
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({
          name: typeof r.name === 'string' ? r.name : '',
          example: typeof r.example === 'string' ? r.example : '',
        }))
    : [];

  const commit = (next: typeof rows) =>
    onChange(next.length === 0 ? undefined : next.map((r) => (r.example ? { name: r.name, example: r.example } : { name: r.name })));
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = (name = '', example = '') => commit([...rows, { name, example }]);
  const removeRow = (i: number) => commit(rows.filter((_, j) => j !== i));

  const existing = new Set(rows.map((r) => r.name));
  const hasAokieConnector = context.connectors.some((connector) => connector.id === 'aokie');
  const quickAdds = hasAokieConnector ? AOKIE_QUICK_INPUTS.filter((q) => !existing.has(q.name)) : [];

  return (
    <div className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="rounded-lg border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-gray-400 dark:text-slate-500">$inputs.</span>
              <input
                type="text"
                value={row.name}
                placeholder="callerPhone"
                onChange={(e) => setRow(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
                className={INPUT_CLS + ' min-w-0 flex-1 font-mono text-xs'}
                aria-label="Input name"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label="Remove input"
                className="flex-none rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500 dark:hover:bg-slate-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <input
              type="text"
              value={row.example}
              placeholder="example value (optional, used for test runs)"
              onChange={(e) => setRow(i, { example: e.target.value })}
              className={INPUT_CLS + ' text-xs'}
              aria-label="Example value"
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => addRow()}
        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-dashed border-gray-300 dark:border-slate-600 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-300 hover:border-primary-300 hover:text-primary-600 dark:hover:border-primary-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <Plus className="h-3.5 w-3.5" /> Add an input
      </button>
      {quickAdds.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-[10px] font-medium text-gray-400 dark:text-slate-500">Common call fields:</p>
          <div className="flex flex-wrap gap-1">
            {quickAdds.map((q) => (
              <button
                key={q.name}
                type="button"
                onClick={() => addRow(q.name, q.example)}
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 dark:border-slate-600 px-2 py-0.5 font-mono text-[10px] text-gray-600 dark:text-slate-300 hover:border-primary-300 hover:text-primary-600 dark:hover:border-primary-500/40"
              >
                <Plus className="h-2.5 w-2.5" /> {q.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </div>
  );
}

/** Filters editor: rows of { field, op, value }, ANDed. */
function FiltersField({
  spec,
  value,
  formFields,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  formFields: Array<{ id: string; label: string }> | null;
  onChange: (value: unknown) => void;
}) {
  const rows = Array.isArray(value)
    ? value
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({
          field: typeof r.field === 'string' ? r.field : '',
          op: (typeof r.op === 'string' ? r.op : 'eq') as FlowFilterOp,
          value: typeof r.value === 'string' ? r.value : r.value == null ? '' : String(r.value),
        }))
    : [];

  const commit = (next: typeof rows) => onChange(next.length === 0 ? undefined : next);
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) =>
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => commit([...rows, { field: '', op: 'eq' as FlowFilterOp, value: '' }]);
  const removeRow = (i: number) => commit(rows.filter((_, j) => j !== i));

  // A usable field picker needs actual fields; an empty list must fall back
  // to free text (an empty "Select a field…" dropdown reads as broken).
  const pickerFields = formFields && formFields.length > 0 ? formFields : null;

  const tinyLabel = 'mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500';

  return (
    <div className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      {rows.length === 0 && (
        <p className="mb-1.5 text-[11px] text-gray-400 dark:text-slate-500">
          No rules yet — every record comes back. Add one to find a specific
          record, e.g. field <span className="font-mono">phone</span>, condition{' '}
          <span className="italic">phone number matches</span>, value{' '}
          <span className="font-mono">$inputs.callerPhone</span>.
        </p>
      )}
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="rounded-lg border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-2.5 space-y-2">
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <span className={tinyLabel}>Field</span>
                {pickerFields ? (
                  <select
                    value={row.field}
                    onChange={(e) => setRow(i, { field: e.target.value })}
                    className={INPUT_CLS + ' cursor-pointer'}
                    aria-label="Filter field"
                  >
                    <option value="">Select a field…</option>
                    {/* A saved field id the picker doesn't know (form fields
                        still loading, imported flow) must stay VISIBLE —
                        collapsing it to "Select a field…" made a configured
                        filter look broken. */}
                    {row.field !== '' && !pickerFields.some((f) => f.id === row.field) && (
                      <option value={row.field}>{row.field}</option>
                    )}
                    {pickerFields.map((f) => (
                      <option key={f.id} value={f.id}>{f.label || f.id}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={row.field}
                    placeholder="field id (e.g. phone)"
                    onChange={(e) => setRow(i, { field: e.target.value })}
                    className={INPUT_CLS + ' font-mono text-xs'}
                    aria-label="Filter field id"
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label="Remove filter"
                title="Remove this rule"
                className="mt-4 flex-none rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500 dark:hover:bg-slate-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div>
              <span className={tinyLabel}>Condition</span>
              <select
                value={row.op}
                onChange={(e) => setRow(i, { op: e.target.value as FlowFilterOp })}
                className={INPUT_CLS + ' w-full cursor-pointer'}
                aria-label="Filter operator"
              >
                {FILTER_OP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={tinyLabel}>Value</span>
              <input
                type="text"
                value={row.value}
                placeholder="a value, or $inputs.callerPhone"
                onChange={(e) => setRow(i, { value: e.target.value })}
                className={INPUT_CLS + ' w-full'}
                aria-label="Filter value"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addRow}
        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-dashed border-gray-300 dark:border-slate-600 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-300 hover:border-primary-300 hover:text-primary-600 dark:hover:border-primary-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <Plus className="h-3.5 w-3.5" /> Add rule
      </button>
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </div>
  );
}

/** Connector id picker: a select of context-available connectors, else free text. */
function ConnectorField({
  spec,
  value,
  context,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  context: FlowEditorContext;
  onChange: (value: unknown) => void;
}) {
  const raw = typeof value === 'string' ? value : '';
  const ids = context.connectors.map((c) => c.id);
  const placeholder = context.connectors.some((connector) => connector.id === 'aokie') ? spec.placeholder : 'connector id';
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      {ids.length > 0 ? (
        <select
          value={raw}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLS + ' cursor-pointer'}
        >
          <option value="">Select a connector…</option>
          {ids.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
          {raw !== '' && !ids.includes(raw) && <option value={raw}>{raw}</option>}
        </select>
      ) : (
        <input
          type="text"
          value={raw}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLS}
        />
      )}
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

/** Connector command picker: an input with a datalist of the selected connector's known commands. */
function ConnectorCommandField({
  nodeId,
  spec,
  value,
  connectorId,
  context,
  onChange,
}: {
  nodeId: string;
  spec: NodePropertySpec;
  value: unknown;
  connectorId: unknown;
  context: FlowEditorContext;
  onChange: (value: unknown) => void;
}) {
  const raw = typeof value === 'string' ? value : '';
  const grantCommands = context.connectors.find((c) => c.id === connectorId)?.commands ?? [];
  const availableConnectorIds = context.connectors.map((connector) => connector.id);
  const commands = mergeKnownConnectorCommands(connectorId, grantCommands, availableConnectorIds);
  const placeholder = availableConnectorIds.includes('aokie') ? spec.placeholder : 'command';
  const listId = `connector-cmds-${nodeId}`;
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <input
        type="text"
        value={raw}
        placeholder={placeholder}
        list={commands.length > 0 ? listId : undefined}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        className={INPUT_CLS}
      />
      {commands.length > 0 && (
        <datalist id={listId}>
          {commands.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

/**
 * Desktop-service id picker: a select of all services the paired Desktop advertises, else free
 * text when Desktop is unpaired, unreachable, or reports none. Desktop auto-starts services by
 * id/port, so non-running entries are valid choices.
 * Unlike `ConnectorField` (which reads already-loaded `context.connectors` synchronously), the
 * service list isn't preloaded anywhere in the editor context, so this component fetches
 * `desktopClient.services.list()` itself on mount, with a simple loading state.
 */
function DesktopServicePickerField({
  spec,
  value,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [services, setServices] = useState<DesktopServiceSnapshot[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    desktopClient.services.list().then((res) => {
      if (cancelled) return;
      setServices(res.ok ? res.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const raw = typeof value === 'string' ? value : '';
  const loading = services === null;
  const ids = services?.map((s) => s.id) ?? [];
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      {loading ? (
        <input type="text" value={raw} disabled placeholder="Loading Desktop services…" className={INPUT_CLS + ' opacity-60'} />
      ) : ids.length > 0 ? (
        <select
          value={raw}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLS + ' cursor-pointer'}
        >
          <option value="">(none — URL below is an absolute address)</option>
          {services!.map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.id}</option>
          ))}
          {raw !== '' && !ids.includes(raw) && <option value={raw}>{raw}</option>}
        </select>
      ) : (
        <input
          type="text"
          value={raw}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLS}
        />
      )}
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

// ── service_action pickers (§6.4 consumer #2: the catalog's typed action schemas) ─────

// The catalog fetch/hook live in hooks/useServiceCatalog.ts — the SRV-405 binding UI on an
// installed extension needs exactly the same session-cached catalog.

/** ServiceDefinition picker over the paired Desktop's v3 catalog; free text otherwise. */
function ServiceDefinitionPickerField({
  spec,
  value,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const catalog = useServiceCatalog();
  const raw = typeof value === 'string' ? value : '';
  if (catalog === undefined) {
    return (
      <label className="block">
        <span className={LABEL_CLS}>{spec.label}</span>
        <input type="text" value={raw} disabled placeholder="Loading the Desktop Services catalog…" className={INPUT_CLS + ' opacity-60'} />
      </label>
    );
  }
  if (!catalog || catalog.definitions.length === 0) {
    return <Field spec={spec} value={value} onChange={onChange} />;
  }
  const known = catalog.definitions.some((d) => d.id === raw);
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <select
        value={raw}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        aria-label="Service definition"
        className={INPUT_CLS + ' cursor-pointer'}
      >
        <option value="">Pick a service…</option>
        {raw !== '' && !known && <option value={raw}>{raw} (not in the catalog)</option>}
        {catalog.definitions.map((d) => (
          <option key={d.id} value={d.id}>{d.name || d.id}</option>
        ))}
      </select>
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

/**
 * Provider-profile picker for a `connection`. The value is an opaque Desktop provider id, so
 * offering the real list beats asking an author to recall one. Unpaired Desktop (or no
 * configured providers) degrades to the ordinary text field rather than an empty select, and
 * a stored id that is no longer offered stays selectable so opening a flow never drops it.
 */
function ProviderConnectionPickerField({
  spec,
  value,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const profiles = useProviderProfiles();
  const raw = typeof value === 'string' ? value : '';
  if (profiles === undefined) {
    return (
      <label className="block">
        <span className={LABEL_CLS}>{spec.label}</span>
        <input type="text" value={raw} disabled placeholder="Loading Desktop providers…" className={INPUT_CLS + ' opacity-60'} />
      </label>
    );
  }
  if (profiles.length === 0) {
    return <Field spec={spec} value={value} onChange={onChange} />;
  }
  const known = profiles.some((p) => p.refId === raw);
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <select
        value={raw}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        aria-label="Connection"
        className={INPUT_CLS + ' cursor-pointer'}
      >
        <option value="">Pick a connection…</option>
        {raw !== '' && !known && <option value={raw}>{raw} (not currently available)</option>}
        {profiles.map((profile) => (
          <option key={profile.refId} value={profile.refId}>{profile.name}</option>
        ))}
      </select>
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

/** Action picker within the node's chosen definition — schema-aware (§6.3): the picked
 *  action's description surfaces under the field so authors see what they wired. */
function ServiceActionPickerField({
  spec,
  value,
  definitionId,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  definitionId: unknown;
  onChange: (value: unknown) => void;
}) {
  const catalog = useServiceCatalog();
  const raw = typeof value === 'string' ? value : '';
  const definition = catalog && typeof definitionId === 'string'
    ? catalog.definitions.find((d) => d.id === definitionId) ?? null
    : null;
  if (catalog === undefined) {
    return (
      <label className="block">
        <span className={LABEL_CLS}>{spec.label}</span>
        <input type="text" value={raw} disabled placeholder="Loading the Desktop Services catalog…" className={INPUT_CLS + ' opacity-60'} />
      </label>
    );
  }
  if (!definition || definition.actions.length === 0) {
    return <Field spec={spec} value={value} onChange={onChange} />;
  }
  const selected = definition.actions.find((a) => a.id === raw) ?? null;
  const known = selected !== null;
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <select
        value={raw}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        aria-label="Service action"
        className={INPUT_CLS + ' cursor-pointer'}
      >
        <option value="">Pick an action…</option>
        {raw !== '' && !known && <option value={raw}>{raw} (not in this service)</option>}
        {definition.actions.map((a) => (
          <option key={a.id} value={a.id}>{a.title || a.id} ({a.id})</option>
        ))}
      </select>
      {selected?.description ? (
        <p className={HELP_CLS}>{selected.description}</p>
      ) : (
        spec.help && <p className={HELP_CLS}>{spec.help}</p>
      )}
    </label>
  );
}

/** service_action's input editor + §6.4 advice against the action's declared inputSchema. */
function ServiceActionInputField({
  spec,
  value,
  definitionId,
  actionId,
  onChange,
  setInserter,
}: {
  spec: NodePropertySpec;
  value: unknown;
  definitionId: unknown;
  actionId: unknown;
  onChange: (value: unknown) => void;
  setInserter: (fn: ((text: string) => void) | null) => void;
}) {
  const catalog = useServiceCatalog();
  const contract = serviceActionContract(catalogAction(catalog, definitionId, actionId));
  const issues = contract ? checkFlowCallInput(value, contract) : [];
  return (
    <div className="space-y-1.5">
      <CodeField spec={spec} value={value} onChange={onChange} setInserter={setInserter} />
      {issues.length > 0 && <FlowCallInputIssues issues={issues} />}
    </div>
  );
}

export function AiProviderPickerField({
  spec,
  value,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const userId = useAuthStore((state) => state.user?.id);
  // Only offer services that declare this node's capability (a custom service may be
  // chat-only / speech-only). The currently-selected service always stays listed —
  // flagged below — so a mismatch is visible and fixable, never silently dropped.
  const capability = spec.capability ?? 'chat';
  const raw = typeof value === 'string' ? value : '';
  // The list lives in localStorage (an external store): derive it during render and
  // invalidate by bumping `version` — from the ai-services-changed event and from
  // focus/open on the select — instead of mirroring into state via effects.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const providers = useMemo(
    () => listProviders(userId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the localStorage read
    [userId, version]
  );
  // Plan §5.6: the "Default (from Settings)" option shows the currently-resolved source
  // beside it. Preferences come from the shared 60s cache in aiDefault.ts.
  const [defaultLabel, setDefaultLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAiPreferences()
      .then((res) => {
        if (cancelled || !res.ok) return;
        const customName =
          res.data.aiSource === 'custom' && res.data.customProviderId
            ? listProviders(userId).find((p) => p.id === res.data.customProviderId)?.name ?? null
            : null;
        setDefaultLabel(defaultSourceLabel(res.data, customName));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId, version]);
  const options = useMemo(
    () => buildAiProviderOptions({ providers, capability, currentValue: raw, defaultSourceLabel: defaultLabel }),
    [providers, capability, raw, defaultLabel]
  );

  useEffect(() => {
    window.addEventListener('formlogic:ai-services-changed', refresh);
    return () => window.removeEventListener('formlogic:ai-services-changed', refresh);
  }, [refresh]);

  const openManager = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('formlogic:open-ai-services'));
  };

  return (
    <div className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <select
        value={raw}
        onFocus={refresh}
        onMouseDown={refresh}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        className={INPUT_CLS + ' cursor-pointer'}
      >
        {options.map((option) => (
          <option key={option.value === '' ? '(auto)' : option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="mt-1 flex flex-col gap-2">
        {spec.help && <p className={HELP_CLS + ' mt-0'}>{spec.help}</p>}
        <Button type="button" variant="outline" size="sm" onClick={openManager} leftIcon={<Sparkles className="h-3.5 w-3.5" />}>
          Manage AI services...
        </Button>
      </div>
    </div>
  );
}

/** Append-a-field helper under an answers editor: a datalist of the form's field ids. */
function AnswersFieldAdder({
  nodeId,
  fields,
  answers,
  onChange,
}: {
  nodeId: string;
  fields: Array<{ id: string; label: string }>;
  answers: unknown;
  onChange: (value: unknown) => void;
}) {
  const [pick, setPick] = useState('');
  const listId = `answer-fields-${nodeId}`;
  const add = (fieldId: string) => {
    const id = fieldId.trim();
    if (id === '') return;
    // Only extend when answers is empty or already an object (never clobber a raw selector string).
    const base = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : answers == null ? {} : null;
    if (base && !(id in base)) onChange({ ...base, [id]: '' });
    setPick('');
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={pick}
        list={listId}
        placeholder="add a field id…"
        onChange={(e) => setPick(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(pick); } }}
        className={INPUT_CLS + ' font-mono text-xs'}
        aria-label="Add an answer field"
      />
      <datalist id={listId}>
        {fields.map((f) => (
          <option key={f.id} value={f.id}>{f.label || f.id}</option>
        ))}
      </datalist>
      <Button type="button" variant="outline" size="sm" onClick={() => add(pick)} className="flex-none">Add</Button>
    </div>
  );
}

/**
 * A real code editor (Monaco) for `code`-type fields (condition/logic_block expressions, JSON /
 * selector bodies, the output value). Keeps the "QuickJS sandboxed" / "JSON / selectors"
 * affordances, registers itself as the active selector-insert target on focus, and falls back to a
 * monospace textarea if Monaco can't mount (offline chunk, worker failure).
 */
function CodeField({
  spec,
  value,
  onChange,
  setInserter,
}: {
  spec: NodePropertySpec;
  value: unknown;
  onChange: (value: unknown) => void;
  setInserter: (fn: ((text: string) => void) | null) => void;
}) {
  const json = isJsonField(spec);
  const language = spec.language ?? (spec.quickjs ? 'javascript' : json ? 'json' : 'javascript');
  const text = toInput(value);
  const handle = (v: string) => onChange(json ? parseJsonField(v) : v);
  // What syntax a chip-insert must produce here (bare selector / plain-JS / {{ }} template) —
  // 'quickjs' for condition/logic_block's sandboxed expr, 'selector' for JSON/selector bodies
  // (resolveDeep), matching nodes.ts exactly (see getReferenceSyntax).
  const mode = getReferenceSyntax(spec);

  const fallback = (
    // data-ref-syntax lets the panel's generic onPanelFocus format chip-inserts correctly if
    // Monaco fails to mount (ErrorBoundary) — the Monaco path formats via onEditorMount below.
    <textarea
      value={text}
      placeholder={spec.placeholder}
      rows={6}
      spellCheck={false}
      onChange={(e) => handle(e.target.value)}
      className={MONO_CLS + ' resize-y'}
      data-ref-syntax={mode}
    />
  );

  const onEditorMount = (editor: MonacoEditor) => {
    editor.onDidFocusEditorText(() => {
      setInserter((toInsert) => {
        const formatted = formatChipInsert(toInsert, mode);
        const sel = editor.getSelection();
        if (sel) editor.executeEdits('insert-selector', [{ range: sel, text: formatted, forceMoveMarkers: true }]);
        editor.focus();
      });
    });
  };

  return (
    <label className="block">
      <span className={LABEL_CLS}>
        {spec.label}
        {spec.quickjs && (
          <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
            QuickJS sandboxed
          </span>
        )}
        {json && (
          <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-slate-700 dark:text-slate-300">
            JSON / selectors
          </span>
        )}
      </span>
      <ErrorBoundary fallback={fallback}>
        <div className="overflow-hidden rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900" style={{ height: 156 }}>
          <CodeEditor value={text} onChange={handle} language={language} height="100%" onMount={onEditorMount} />
        </div>
      </ErrorBoundary>
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: NodePropertySpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (spec.type === 'boolean') {
    return (
      <div className="flex items-center justify-between">
        <span className={LABEL_CLS + ' mb-0'}>{spec.label}</span>
        <Switch checked={!!value} onChange={(v) => onChange(v)} label={spec.label} size="sm" />
      </div>
    );
  }

  if (spec.type === 'select') {
    return (
      <label className="block">
        <span className={LABEL_CLS}>{spec.label}</span>
        <select
          value={typeof value === 'string' ? value : (spec.default as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLS + ' cursor-pointer'}
        >
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
      </label>
    );
  }

  if (spec.type === 'number') {
    return (
      <label className="block">
        <span className={LABEL_CLS}>{spec.label}</span>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={INPUT_CLS}
        />
        {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
      </label>
    );
  }

  if (spec.type === 'textarea') {
    return (
      <label className="block">
        <span className={LABEL_CLS}>{spec.label}</span>
        <textarea
          value={toInput(value)}
          placeholder={spec.placeholder}
          rows={3}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLS + ' resize-y'}
          data-ref-syntax={getReferenceSyntax(spec)}
        />
        {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
      </label>
    );
  }

  // text
  return (
    <label className="block">
      <span className={LABEL_CLS}>{spec.label}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={spec.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        className={INPUT_CLS}
        data-ref-syntax={getReferenceSyntax(spec)}
      />
      {spec.help && <p className={HELP_CLS}>{spec.help}</p>}
    </label>
  );
}

/**
 * Variable picker: the selectors this node can reference ($inputs.* / $event / $nodes.*), grouped.
 * Clicking a chip inserts it at the focused field's cursor (plain input/textarea OR the Monaco code
 * editor); with nothing focused it copies to the clipboard. mousedown is prevented so the click
 * never steals focus from the field being edited.
 */
function InsertHints({ hints, onInsert }: { hints: string[]; onInsert: (h: string) => 'inserted' | 'copied' }) {
  const [flash, setFlash] = useState<{ h: string; kind: 'inserted' | 'copied' } | null>(null);
  if (hints.length === 0) return null;
  const groups = [
    { label: 'Inputs', items: hints.filter((h) => h.startsWith('$inputs.')) },
    { label: 'Event', items: hints.filter((h) => h === '$event') },
    { label: 'Node outputs', items: hints.filter((h) => h.startsWith('$nodes.')) },
  ].filter((g) => g.items.length > 0);
  const activate = (h: string) => {
    const kind = onInsert(h);
    setFlash({ h, kind });
    setTimeout(() => setFlash((f) => (f?.h === h ? null : f)), 1200);
  };
  return (
    <div className="rounded-lg border border-gray-200/80 dark:border-slate-700/60 bg-white/60 dark:bg-slate-800/40 p-2 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
        Insert a value
      </p>
      {groups.map((g) => (
        <div key={g.label}>
          <p className="mb-1 text-[9px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-600">{g.label}</p>
          <div className="flex flex-wrap gap-1">
            {g.items.map((h) => (
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
        </div>
      ))}
    </div>
  );
}

export function NodeProperties({ nodeId, type, data, onPatch, onDelete, forms, context = EMPTY_FLOW_EDITOR_CONTEXT, insertHints = [], onOpenTriggers, className }: NodePropertiesProps) {
  // Registry resolution (never undefined): unknown types get the §4.5 missing-definition
  // placeholder — the panel explains the situation and shows the raw config read-only.
  const spec = flowNodeRegistry.resolveNodeSpec(type, context);
  // The selected form's fields power the filter-field select + the answers datalist (static form only).
  const formId = staticFormId(data.form);
  const selectedForm = formId ? forms.find((f) => f.id === formId) ?? null : null;
  const formFields = selectedForm?.fields ?? null;

  // Selector-insert target: the last-focused code editor / text field. Chips insert there, else copy.
  const activeInsertRef = useRef<((text: string) => void) | null>(null);
  const setInserter = useCallback((fn: ((text: string) => void) | null) => { activeInsertRef.current = fn; }, []);
  useEffect(() => { activeInsertRef.current = null; }, [nodeId]); // reset when the selection changes
  const insertOrCopy = useCallback((h: string): 'inserted' | 'copied' => {
    const fn = activeInsertRef.current;
    if (fn) { fn(h); return 'inserted'; }
    void navigator.clipboard?.writeText(h).catch(() => {});
    return 'copied';
  }, []);
  // Track focus of a plain text field so chip-insert lands at its caret (Monaco fields self-register).
  // The field's `data-ref-syntax` (set by Field()/CodeField's fallback from the property spec) says
  // which syntax the executor actually resolves there — absent (bespoke widgets: form picker,
  // filters, connector pickers) defaults to 'selector', matching what those fields expect today.
  const onPanelFocus = useCallback((e: FocusEvent) => {
    const t = e.target as HTMLElement;
    const el = t as HTMLInputElement | HTMLTextAreaElement;
    const isText = (t.tagName === 'INPUT' && (el.type === 'text' || el.type === '')) || t.tagName === 'TEXTAREA';
    if (!isText || t.closest('.monaco-editor')) return;
    const mode = (el.dataset.refSyntax as ReferenceSyntax | undefined) ?? 'selector';
    activeInsertRef.current = (hint: string) => insertIntoInput(el, formatChipInsert(hint, mode));
  }, []);

  // showIf: hide a property whose predicate fails — unless it already holds a value (never hide config).
  const effective = spec ? effectiveNodeData(spec, data) : data;
  const visibleProps = spec ? spec.properties.filter((p) => evalShowIf(p.showIf, effective) || fieldHasValue(data[p.key])) : [];

  return (
    <div className={cn('flex h-full min-h-0 w-80 flex-none flex-col border-l border-gray-200/80 bg-gray-50/60 dark:border-slate-700/60 dark:bg-slate-900/40', className)}>
      <div className="flex items-center justify-between border-b border-gray-200/80 dark:border-slate-700/60 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{spec?.label ?? type}</p>
          <p className="truncate font-mono text-[11px] text-gray-400 dark:text-slate-500">{nodeId} · {type}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label="Delete node">
          <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
        </Button>
      </div>

      {/* key={nodeId} remounts the field widgets (form-picker mode, adders) when the selection changes. */}
      <div key={nodeId} onFocus={onPanelFocus} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3 space-y-3.5">
        {spec ? (
          <>
            <p className="text-xs text-gray-500 dark:text-slate-400">{spec.description}</p>
            {spec.output && (
              <p className="rounded-lg bg-gray-100/80 dark:bg-slate-800/60 px-2.5 py-1.5 text-[11px] leading-snug text-gray-500 dark:text-slate-400">
                <span className="font-semibold text-gray-600 dark:text-slate-300">Output:</span> {spec.output}
              </p>
            )}
            {spec.capability && (
              <p className="rounded-lg bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                Requires the <span className="font-mono">{spec.capability}</span> capability — declare it in the flow's node capabilities.
              </p>
            )}
            {type === 'input' && onOpenTriggers && (
              <div className="rounded-lg border border-primary-200/80 bg-primary-50/60 px-2.5 py-2 dark:border-primary-500/25 dark:bg-primary-500/10">
                <p className="text-[11px] leading-snug text-primary-700 dark:text-primary-200">
                  Events that run this flow are defined as triggers.
                </p>
                <Button variant="outline" size="sm" className="mt-2 w-full" leftIcon={<Zap className="h-3.5 w-3.5" />} onClick={onOpenTriggers}>
                  Manage triggers
                </Button>
              </div>
            )}
            {spec.missing && Object.keys(data).length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Stored configuration (read-only)</p>
                <pre className="scrollbar-thin max-h-64 overflow-auto rounded-lg bg-gray-100/80 px-2.5 py-2 font-mono text-[11px] leading-snug text-gray-600 dark:bg-slate-800/60 dark:text-slate-300">
                  {JSON.stringify(data, null, 2)}
                </pre>
              </div>
            )}
            {type !== 'input' && !spec.missing && <InsertHints hints={insertHints} onInsert={insertOrCopy} />}
            {visibleProps.length === 0 ? (
              !spec.missing && <p className="text-xs text-gray-400 dark:text-slate-500">This node has no editable settings.</p>
            ) : (
              visibleProps.map((p) => {
                const onChange = (value: unknown) => onPatch({ [p.key]: value });
                if (p.type === 'triggerInputs') {
                  return <TriggerInputsField key={p.key} spec={p} value={data[p.key]} context={context} onChange={onChange} />;
                }
                if (p.type === 'form') {
                  return <FormPickerField key={p.key} spec={p} value={data[p.key]} forms={forms} context={context} onChange={onChange} />;
                }
                if (p.type === 'flow') {
                  return <FlowPickerField key={p.key} spec={p} value={data[p.key]} context={context} onChange={onChange} />;
                }
                if (p.type === 'filters') {
                  return <FiltersField key={p.key} spec={p} value={data[p.key]} formFields={formFields} onChange={onChange} />;
                }
                if (p.type === 'connector') {
                  return <ConnectorField key={p.key} spec={p} value={data[p.key]} context={context} onChange={onChange} />;
                }
                if (p.type === 'connectorCommand') {
                  return (
                    <ConnectorCommandField
                      key={p.key}
                      nodeId={nodeId}
                      spec={p}
                      value={data[p.key]}
                      connectorId={data.connectorId}
                      context={context}
                      onChange={onChange}
                    />
                  );
                }
                if (p.type === 'desktopService') {
                  return <DesktopServicePickerField key={p.key} spec={p} value={data[p.key]} onChange={onChange} />;
                }
                if (p.type === 'serviceDefinition') {
                  return <ServiceDefinitionPickerField key={p.key} spec={p} value={data[p.key]} onChange={onChange} />;
                }
                if (p.type === 'providerConnection') {
                  return <ProviderConnectionPickerField key={p.key} spec={p} value={data[p.key]} onChange={onChange} />;
                }
                if (p.type === 'serviceActionId') {
                  return (
                    <ServiceActionPickerField
                      key={p.key}
                      spec={p}
                      value={data[p.key]}
                      definitionId={data.definitionId}
                      onChange={onChange}
                    />
                  );
                }
                if (p.type === 'aiProvider') {
                  return <AiProviderPickerField key={p.key} spec={p} value={data[p.key]} onChange={onChange} />;
                }
                // http_request's `url` becomes a PATH (not an absolute URL) once a `service` is
                // chosen above it — swap the help/placeholder to say so, purely presentational
                // (the stored value/key are untouched; the executor decides the same way).
                if (p.key === 'url' && typeof data.service === 'string' && data.service.trim() !== '') {
                  const pathSpec: NodePropertySpec = {
                    ...p,
                    placeholder: '/predict  or  predict',
                    help: `Path under the '${data.service}' service (leading slash optional) — {{...}} templating against the run scope.`,
                  };
                  return <Field key={p.key} spec={pathSpec} value={data[p.key]} onChange={onChange} />;
                }
                if (p.type === 'code') {
                  const codeField = <CodeField key={p.key} spec={p} value={data[p.key]} onChange={onChange} setInserter={setInserter} />;
                  // service_action: §6.4 advice against the catalog action's declared inputSchema
                  // (consumer #2 of the assignability lattice — same conservative machinery).
                  if (p.key === 'input' && type === 'service_action') {
                    return (
                      <ServiceActionInputField
                        key={p.key}
                        spec={p}
                        value={data[p.key]}
                        definitionId={data.definitionId}
                        actionId={data.actionId}
                        onChange={onChange}
                        setInserter={setInserter}
                      />
                    );
                  }
                  // flow_call: static §6.4 advice for the input mapping against the picked child's
                  // contract (declared Trigger inputs + optional inputSchema). Purely presentational.
                  if (p.key === 'input' && type === 'flow_call') {
                    const child = (context.flows ?? []).find((f) => f.id === data.flowId) ?? null;
                    const issues = checkFlowCallInput(data[p.key], child);
                    if (issues.length > 0) {
                      return (
                        <div key={p.key} className="space-y-1.5">
                          {codeField}
                          <FlowCallInputIssues issues={issues} />
                        </div>
                      );
                    }
                    return codeField;
                  }
                  if (p.key === 'answers' && formFields && formFields.length > 0) {
                    return (
                      <div key={p.key} className="space-y-1.5">
                        {codeField}
                        <AnswersFieldAdder nodeId={nodeId} fields={formFields} answers={data[p.key]} onChange={onChange} />
                      </div>
                    );
                  }
                  return codeField;
                }
                return <Field key={p.key} spec={p} value={data[p.key]} onChange={onChange} />;
              })
            )}
          </>
        ) : (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Unknown node type <span className="font-mono">{type}</span> — authored in the full F2I editor. It is kept as-is but has no
            settings form here.
          </p>
        )}
      </div>
    </div>
  );
}
