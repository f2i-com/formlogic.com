// FormLogic Flows — editor node catalog (docs/FORMLOGIC_FLOWS.md §4, §9).
//
// ONE typed registry that drives the whole editor: the NodePalette (grouped, searchable),
// the NodeProperties panel (per-node field specs), the FlowCanvas (handles / labels / accent),
// and client-side validation. Adapted from the F2I node-JSON catalog
// (f2i-web/ui/src/bundled-modules/<module>/nodes/*.json) but native to FormLogic (Tailwind
// tokens, lucide icons) and pared to the v0 executor.
//
// TWO tiers of node, BOTH executable + in EXECUTABLE_NODE_TYPES (client-runtime/flows/nodes.ts) —
// the nodeCatalog↔executor parity test asserts this set matches the executor exactly:
//   (a) BROWSER-SAFE — input/output/logic/AI/formlogic/connector/storage nodes the browser runner
//       executes directly (storage_get/storage_set flow KV, docs §9; aokie_speak connector sugar).
//   (b) DESKTOP-SERVICE-BACKED ("Requires FormLogic Desktop") — browser_action / image_gen /
//       stt_transcribe / tts_speak drive a LOCAL FormLogic Desktop service over its loopback HTTP
//       API; they declare `requiresDesktopService` and render a "Runs on FormLogic Desktop" badge.
//       Reachable → real execution; unreachable → an actionable "install & start it" node_failed.
import {
  Zap,
  ArrowLeftToLine,
  GitBranch,
  Braces,
  Code2,
  Sparkles,
  Globe,
  Search,
  FilePlus2,
  FilePenLine,
  Plug,
  DatabaseZap,
  Database,
  PhoneOutgoing,
  Mic,
  Volume2,
  Image,
  MousePointerClick,
  type LucideIcon,
} from 'lucide-react';
import { EXECUTABLE_NODE_TYPES } from '../../../client-runtime/flows/nodes';

/** Palette grouping (order here is the palette section order). */
export type NodeCategory = 'io' | 'logic' | 'ai' | 'formlogic' | 'connector' | 'storage' | 'desktop';

export interface NodeCategoryMeta {
  id: NodeCategory;
  label: string;
  /** Short blurb shown under the category heading in the palette. */
  hint?: string;
}

export const NODE_CATEGORIES: NodeCategoryMeta[] = [
  { id: 'io', label: 'Input / Output' },
  { id: 'logic', label: 'Logic' },
  { id: 'formlogic', label: 'FormLogic data' },
  { id: 'ai', label: 'AI' },
  { id: 'connector', label: 'Connectors' },
  { id: 'storage', label: 'Flow storage' },
  { id: 'desktop', label: 'Requires FormLogic Desktop', hint: 'Runs on a local FormLogic Desktop service' },
];

/** A property editor field kind (drives the widget in NodeProperties). */
export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'code'
  | 'textarea'
  | 'boolean'
  /** Form picker (select of the author's forms) with a "dynamic value" escape hatch (id / selector). */
  | 'form'
  /** The Trigger node's declared inputs: rows of { name, example? } shown as chips on the node card. */
  | 'triggerInputs'
  /** Rows of { field, op, value } ANDed together (formlogic_list_responses). */
  | 'filters'
  /** Connector id — a select of context-available connectors, else free text. */
  | 'connector'
  /** Connector command — a datalist of the chosen connector's known commands, else free text. */
  | 'connectorCommand'
  /**
   * Desktop service id — a select of the paired Desktop's running services (fetched live via
   * `desktopClient.services.list()`), else free text when Desktop is unpaired/unreachable.
   * Backs `http_request`'s optional `service` field (docs §4).
   */
  | 'desktopService';

/**
 * A conditional-visibility predicate over the node's own data. A property with a `showIf` is only
 * shown (and only lint-checked) when the predicate holds — purely presentational, the executor
 * never sees it and hidden fields keep whatever value they hold. All present clauses are ANDed.
 */
export interface ShowIf {
  /** The controlling property key on the same node. */
  property: string;
  /** Show when the controlling value strictly equals this. */
  equals?: unknown;
  /** Show when the controlling value is NOT this. */
  notEquals?: unknown;
  /** Show when the controlling value is one of these. */
  in?: unknown[];
}

/**
 * Which of the executor's value-resolution mechanisms (client-runtime/flows/nodes.ts +
 * the Rust mirror flows/runner.rs) a property's stored value is put through, and therefore
 * which syntax a "insert a $nodes/$inputs reference" chip must produce for it to actually work:
 *   - 'selector' — the WHOLE field value is resolved as one bare `$`-rooted selector string
 *     (`resolveSelector`), or the field is JSON walked by `resolveDeep` (a selector-shaped
 *     STRING VALUE inside it resolves the same way) — both want the bare `$nodes.x.y` string.
 *   - 'quickjs'  — a `code` field with `quickjs: true` runs as literal JS in the sandbox, where
 *     `inputs`/`nodes`/`event`/`upstream`/`app` are real JS variables (no `$`, no `{{ }}`).
 *   - 'template' — resolved via `interpolateTemplate`, which only scans for `{{ ... }}`
 *     placeholders in free text; a bare `$selector` dropped outside braces is never resolved and
 *     ends up verbatim in the output (e.g. spoken on a live call).
 */
export type ReferenceSyntax = 'selector' | 'quickjs' | 'template';

export interface NodePropertySpec {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  /** Helper line under the field. */
  help?: string;
  default?: unknown;
  options?: { value: string; label: string }[];
  /** `code` fields render a monospace Monaco editor labelled "QuickJS sandboxed". */
  quickjs?: boolean;
  /** Monaco language for a `code` field ('javascript' default, 'json' for structured fields). */
  language?: string;
  /** Authoring aid: flag a warning badge when this (visible) property is empty. Never blocks a run. */
  required?: boolean;
  /** Show this property only when the predicate over the node's data holds (presentation only). */
  showIf?: ShowIf;
  /**
   * Override the inferred reference syntax (see `ReferenceSyntax`). Only needed for a field
   * resolved via `interpolateTemplate` in the executor — everything else is inferred correctly
   * by `getReferenceSyntax` (a `code` field with `quickjs: true` → 'quickjs', else 'selector').
   */
  referenceSyntax?: ReferenceSyntax;
}

/**
 * The reference syntax a chip-insert must produce for this property to actually resolve
 * (docs `ReferenceSyntax`). An explicit `referenceSyntax` always wins; otherwise a QuickJS
 * `code` field infers 'quickjs' and everything else defaults to 'selector' — correct for both
 * whole-value-selector fields (`resolveSelector`) AND JSON fields walked by `resolveDeep`,
 * since both want the bare `$nodes.x.y` string. Only `interpolateTemplate` fields need the
 * explicit 'template' override (set per-field below, cross-checked against nodes.ts).
 */
export function getReferenceSyntax(spec: NodePropertySpec): ReferenceSyntax {
  if (spec.referenceSyntax) return spec.referenceSyntax;
  if (spec.type === 'code' && spec.quickjs) return 'quickjs';
  return 'selector';
}

/** True when `s` is safe as a bare `.seg` JS property access rather than needing `["seg"]`. */
function isJsIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

/**
 * Format a raw chip hint (`$nodes.<id>` / `$inputs.<name>` / `$event`) for insertion into
 * a field of the given `ReferenceSyntax` so the executor actually resolves it:
 *   - 'selector' — unchanged (the bare string IS the value the executor expects).
 *   - 'template' — wrapped in `{{ }}` (a leading `$` inside braces is tolerated by
 *     `interpolateTemplate`/`interpolate_template`, so no need to strip it).
 *   - 'quickjs'  — the leading `$` is stripped so the root reads as the plain JS variable the
 *     sandbox actually exposes (`$event` → `event`), and every path segment after the root is
 *     emitted as `.seg` only when `seg` is a valid bare JS identifier, else as `["seg"]`. This
 *     matters because every node id in this app is auto-minted as `<type>-<n>` (`condition-1`,
 *     `http_request-2`, …, see canvasOps.ts `mintNodeId`) — `nodes.condition-1` would parse as
 *     the subtraction `nodes.condition - 1`, not a lookup of `nodes['condition-1']`. So
 *     `$nodes.condition-1` → `nodes["condition-1"]`, while `$inputs.name` → `inputs.name` and
 *     `$event` → `event` stay dotted since those segments are valid identifiers.
 */
export function formatChipInsert(hint: string, mode: ReferenceSyntax): string {
  switch (mode) {
    case 'template':
      return `{{ ${hint} }}`;
    case 'quickjs': {
      const path = hint.startsWith('$') ? hint.slice(1) : hint;
      const [root, ...rest] = path.split('.');
      return rest.reduce((acc, seg) => (isJsIdentifier(seg) ? `${acc}.${seg}` : `${acc}[${JSON.stringify(seg)}]`), root);
    }
    case 'selector':
    default:
      return hint;
  }
}

/**
 * Insert `text` at an input/textarea's caret via the native value setter so React's onChange
 * still fires (plain `el.value = …` bypasses React's tracked-value machinery and the change is
 * silently dropped). Shared by every plain-field chip-insert UI (NodeProperties' InsertHints,
 * FlowsPanel's ChipRow) — the caret/setter mechanics are identical regardless of which fields a
 * given panel happens to expose.
 */
export function insertIntoInput(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = start + text.length;
  requestAnimationFrame(() => {
    try { el.focus(); el.setSelectionRange(caret, caret); } catch { /* field detached */ }
  });
}

/** One graph handle (a connectable port). Executor edges reference these by id. */
export interface NodeHandleSpec {
  id: string;
  label: string;
  /** Tailwind text/border accent token for the handle dot (condition true/false). */
  tone?: 'default' | 'true' | 'false';
}

export interface NodeSpec {
  /** Stored `node.type`. Executable types match a case in executeNode(). */
  type: string;
  label: string;
  category: NodeCategory;
  description: string;
  /** Optional longer explanation for the palette hover popover (falls back to `description`). */
  doc?: string;
  icon: LucideIcon;
  /** Tailwind color family used for the node header + palette dot (e.g. 'emerald'). */
  accent: string;
  /** false = display-only palette entry (not insertable). */
  executable: boolean;
  /** Target (incoming) handles. */
  inputs: NodeHandleSpec[];
  /** Source (outgoing) handles. */
  outputs: NodeHandleSpec[];
  /** Editable data fields. */
  properties: NodePropertySpec[];
  /** Seed data for a freshly-dropped node. */
  defaultData?: Record<string, unknown>;
  /** Capability the flow must declare for this node (surfaced read-only in properties). */
  capability?: string;
  /**
   * One-line description of the node's OUTPUT and how to reference it downstream. Surfaced in the
   * properties panel ("Output:" hint) and the docs §4 node reference. Executable nodes only.
   */
  output?: string;
  /**
   * App-specific nodes (connector sugar like aokie_speak) declare the connector they need. The
   * context-aware palette (docs §4) hides them unless an installed app provides that connector.
   */
  requiresConnector?: string;
  /**
   * Desktop-service-backed nodes (browser_action / image_gen / stt_transcribe / tts_speak) name
   * the FormLogic Desktop service they drive (a human name). The palette + canvas render a
   * "Runs on FormLogic Desktop" badge; the node executes for real against that local loopback
   * service (client-runtime/flows/nodes.ts), failing with an actionable "install & start it"
   * message when it isn't reachable.
   */
  requiresDesktopService?: string;
}

/** Info about a connector available to the current flow context (drives palette + connector pickers). */
export interface FlowConnectorInfo {
  id: string;
  /** Commands known from the app's declared `connector.<id>.<command>` grants (may be empty). */
  commands: string[];
}

/**
 * The editor context that drives the context-aware palette (docs §4): whether the selected flow is
 * app-scoped and which connectors are actually available (from installed apps' declared grants).
 */
export interface FlowEditorContext {
  /** True when the selected flow belongs to an app (has an appId). */
  appScoped: boolean;
  /** Connectors available in this context; workspace flows have none. */
  connectors: FlowConnectorInfo[];
  /**
   * The form ids the selected flow's app owns (its nav forms). When set on an app-scoped flow, the
   * form picker offers ONLY these — the short, labelled list of the handful the app owns — instead
   * of a giant unfiltered dropdown. Empty/absent → the picker falls back to a searchable list of all
   * the author's forms.
   */
  appFormIds?: string[];
}

/** A workspace flow with no app context — no connectors, so connector-gated nodes stay hidden. */
export const EMPTY_FLOW_EDITOR_CONTEXT: FlowEditorContext = { appScoped: false, connectors: [] };

/**
 * Is a catalog node available in the given editor context? Generic nodes always are; a node that
 * declares `requiresConnector` shows only when an available connector provides it (docs §4).
 */
export function isNodeAvailableInContext(spec: NodeSpec, ctx: FlowEditorContext): boolean {
  if (spec.requiresConnector) {
    return ctx.connectors.some((c) => c.id === spec.requiresConnector);
  }
  return true;
}

/**
 * Evaluate a property's `showIf` predicate against a node's (effective) data. Absent predicate →
 * always visible. All present clauses (equals / notEquals / in) are ANDed. Pure — no side effects.
 */
export function evalShowIf(showIf: ShowIf | undefined, data: Record<string, unknown>): boolean {
  if (!showIf) return true;
  const value = data[showIf.property];
  if ('equals' in showIf && value !== showIf.equals) return false;
  if ('notEquals' in showIf && value === showIf.notEquals) return false;
  if (showIf.in !== undefined && !showIf.in.includes(value)) return false;
  return true;
}

/**
 * A node's data with each unset property filled from its spec default, so a `showIf` that keys off
 * a defaulted select (e.g. browser_action.action='goto', http_request.method='GET') evaluates
 * correctly even on an older graph that never persisted the default.
 */
export function effectiveNodeData(spec: NodeSpec | undefined, data: Record<string, unknown>): Record<string, unknown> {
  if (!spec) return data;
  let out: Record<string, unknown> | null = null;
  for (const p of spec.properties) {
    if (data[p.key] === undefined && p.default !== undefined) {
      out = out ?? { ...data };
      out[p.key] = p.default;
    }
  }
  return out ?? data;
}

const IN: NodeHandleSpec[] = [{ id: 'in', label: 'In' }];
const OUT: NodeHandleSpec[] = [{ id: 'out', label: 'Out' }];

// ---------------------------------------------------------------------------
// EXECUTABLE nodes — one spec per case in executeNode() (nodes.ts).
// ---------------------------------------------------------------------------

const EXECUTABLE_SPECS: NodeSpec[] = [
  {
    type: 'input',
    label: 'Trigger',
    category: 'io',
    description:
      'When this flow runs. It receives named inputs from the trigger event (set by the flow binding). Everything downstream reads them as $inputs.<name>.',
    icon: Zap,
    accent: 'emerald',
    executable: true,
    output: 'The flow inputs. Reference any one downstream as $inputs.<name> (e.g. $inputs.callerPhone).',
    inputs: [],
    outputs: [{ id: 'out', label: 'Runs' }],
    properties: [
      {
        key: 'inputs',
        label: 'Inputs this flow receives',
        type: 'triggerInputs',
        help: 'These are provided by the flow binding (from the trigger event). Reference them below as $inputs.<name>.',
      },
    ],
  },
  {
    type: 'output',
    label: 'Output',
    category: 'io',
    description: 'The flow result. A selector/literal in "value" wins; otherwise the upstream value passes through.',
    icon: ArrowLeftToLine,
    accent: 'emerald',
    executable: true,
    output: 'The flow result (terminal node — nothing references it downstream).',
    inputs: IN,
    outputs: [],
    properties: [
      {
        key: 'value',
        label: 'Value (selector or JSON)',
        type: 'code',
        quickjs: false,
        language: 'json',
        placeholder: '{ "greeting": "$nodes.match.greeting" }',
        help: 'Optional. Selector strings ($nodes.x, $inputs.y) resolve against the run scope. Leave blank to pass the upstream value through.',
      },
    ],
  },
  {
    type: 'condition',
    label: 'Condition',
    category: 'logic',
    description: 'Branch on a sandboxed boolean expression. The True / False handles route downstream nodes.',
    icon: GitBranch,
    accent: 'amber',
    executable: true,
    output: 'Boolean — routes to the True or False handle. Rarely referenced by value.',
    inputs: IN,
    outputs: [
      { id: 'true', label: 'True', tone: 'true' },
      { id: 'false', label: 'False', tone: 'false' },
    ],
    properties: [
      {
        key: 'expr',
        label: 'Expression',
        type: 'code',
        quickjs: true,
        required: true,
        placeholder: "inputs.durationSeconds > 5",
        help: 'Boolean over { inputs, event, app, nodes, upstream }. Runs in QuickJS — never eval. An error or timeout fails the run.',
      },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '1000', help: 'Optional. 100–30000.' },
    ],
  },
  {
    type: 'template',
    label: 'Template',
    category: 'logic',
    description: 'Interpolate a {{path}} template against the run scope into a string.',
    icon: Braces,
    accent: 'amber',
    executable: true,
    output: 'String — the interpolated text. Reference downstream as $nodes.<id>.',
    inputs: IN,
    outputs: OUT,
    properties: [
      {
        key: 'template',
        label: 'Template',
        type: 'textarea',
        required: true,
        placeholder: 'Hello {{inputs.name}}, thanks for calling.',
        help: '{{event.data.from}} / {{nodes.match.greeting}} interpolate; missing paths render empty.',
        referenceSyntax: 'template',
      },
    ],
  },
  {
    type: 'logic_block',
    label: 'Logic block',
    category: 'logic',
    description: 'Run a JS expression in the QuickJS sandbox with a frozen JSON ctx { inputs, event, app, nodes, upstream, kv }.',
    icon: Code2,
    accent: 'sky',
    executable: true,
    output: 'Whatever your code returns (any JSON value). Reference as $nodes.<id> or $nodes.<id>.<key>.',
    inputs: IN,
    outputs: OUT,
    properties: [
      {
        key: 'expr',
        label: 'Code',
        type: 'code',
        quickjs: true,
        required: true,
        language: 'javascript',
        placeholder: 'const c = nodes.customers.find(r => r.answers.phone === inputs.from);\nreturn { found: !!c, name: c?.answers?.name };',
        help: 'Return a JSON value. Wall clock capped (2s default; data.timeoutMs 100ms–30s). An error or timeout fails the run.',
      },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '2000', help: 'Optional. 100–30000.' },
      { key: 'scope', label: 'KV scope (ctx.kv)', type: 'text', placeholder: 'flow:<slug>', help: 'Optional. Read-only KV snapshot exposed as ctx.kv.' },
    ],
  },
  {
    type: 'llm_chat',
    label: 'LLM chat',
    category: 'ai',
    description: 'Call an OpenAI-compatible chat endpoint (FormLogic Desktop local model or the configured AI provider).',
    doc: 'Sends a system + user prompt to an OpenAI-compatible chat model and returns the reply. The model, sampling and endpoint are optional advanced settings — by default the paired FormLogic Desktop model or the app-configured AI provider is used. Reference the reply text downstream as $nodes.<id>.content.',
    icon: Sparkles,
    accent: 'violet',
    executable: true,
    capability: 'model.llm.local',
    output: 'Object { content: string|null, raw }. Reference the reply text as $nodes.<id>.content.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'system', label: 'System prompt', type: 'textarea', placeholder: 'You are a concise note-taker.', referenceSyntax: 'template' },
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        placeholder: 'Summarise this call:\n{{nodes.context.transcript}}',
        help: '{{...}} templating against the run scope.',
        referenceSyntax: 'template',
      },
      { key: 'advanced', label: 'Show model & endpoint options', type: 'boolean', help: 'Reveal the model, sampling and endpoint override. Leave off to use the default provider.' },
      {
        key: 'model',
        label: 'Model',
        type: 'text',
        placeholder: 'default (Desktop/provider decides)',
        help: '{{...}} templating against the run scope (e.g. to pin a model from a config record).',
        showIf: { property: 'advanced', equals: true },
        referenceSyntax: 'template',
      },
      { key: 'maxTokens', label: 'Max tokens', type: 'number', placeholder: '220', showIf: { property: 'advanced', equals: true } },
      { key: 'temperature', label: 'Temperature', type: 'number', placeholder: '0.7', showIf: { property: 'advanced', equals: true } },
      {
        key: 'endpoint',
        label: 'Endpoint override',
        type: 'text',
        placeholder: '(auto) Desktop service / app AI base',
        help: 'Allow-listed to the FormLogic API or the paired Desktop base URL only.',
        showIf: { property: 'advanced', equals: true },
      },
    ],
  },
  {
    type: 'http_request',
    label: 'HTTP request',
    category: 'connector',
    description:
      'Fetch an allow-listed URL (the FormLogic API or the paired Desktop base URL only), or a named Desktop service.',
    icon: Globe,
    accent: 'cyan',
    executable: true,
    output: 'Object { status: number, ok: boolean, body }. Reference the parsed body as $nodes.<id>.body.',
    inputs: IN,
    outputs: OUT,
    properties: [
      {
        key: 'service',
        label: 'Desktop service (optional)',
        type: 'desktopService',
        placeholder: 'e.g. llama-cpp — leave blank to call an absolute URL below',
        help:
          "Target a named service running in FormLogic Desktop (llama.cpp, Ollama, a custom script service, …) " +
          "by id instead of hand-typing its loopback URL. When set, 'URL' below becomes a PATH under that " +
          "service (e.g. /predict) rather than an absolute URL, and only that service's resolved loopback " +
          'port is reachable — the Desktop/API URL allow-list does not apply for this node. Fixed at ' +
          'authoring time; never affected by trigger/event data.',
      },
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: '/api/v1/…  or  http://127.0.0.1:8787/…',
        help: '{{...}} templating against the run scope.',
        referenceSyntax: 'template',
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
      },
      {
        key: 'body',
        label: 'Body (JSON, selectors ok)',
        type: 'code',
        language: 'json',
        placeholder: '{ "id": "$inputs.id" }',
        // A GET request sends no body — hide it to reduce clutter (the field's value is untouched).
        showIf: { property: 'method', notEquals: 'GET' },
      },
    ],
  },
  {
    type: 'formlogic_list_responses',
    label: 'Find records',
    category: 'formlogic',
    description: 'Find records in a form, with an optional filter.',
    icon: Search,
    accent: 'indigo',
    executable: true,
    capability: 'formlogic.responses.read',
    output:
      'The matching records. Use the first match as $nodes.<id>.first.answers.<field>, all of them as $nodes.<id>.responses, ' +
      'the total as $nodes.<id>.count, and whether any matched as $nodes.<id>.found.',
    inputs: IN,
    outputs: OUT,
    properties: [
      {
        key: 'form',
        label: 'Form',
        type: 'form',
        required: true,
        help: 'The form to search in.',
      },
      {
        key: 'filters',
        label: 'Only keep records where…',
        type: 'filters',
        help: 'Every rule must match. A value can be typed in, or reference an input like $inputs.callerPhone.',
      },
      {
        key: 'return',
        label: 'Use',
        type: 'select',
        default: 'first',
        options: [
          { value: 'first', label: 'First match' },
          { value: 'all', label: 'All matches' },
        ],
        help: 'Just tells you which output to read — it does not change what runs.',
      },
      {
        key: 'limit',
        label: 'Rows to scan',
        type: 'number',
        placeholder: '200',
        help: 'How many rows to look through before filtering. Default 200, max 500.',
      },
    ],
  },
  {
    type: 'formlogic_submit_response',
    label: 'Submit response',
    category: 'formlogic',
    description: 'Submit through the normal authenticated pipeline (validation + onSubmit + idempotency).',
    icon: FilePlus2,
    accent: 'indigo',
    executable: true,
    capability: 'formlogic.responses.write',
    output: 'The created response ({ id, answers, … }). Reference the new id as $nodes.<id>.id.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'form', label: 'Form', type: 'form', required: true, help: 'The target form. Pick one, or use a dynamic value (id / selector).' },
      {
        key: 'answers',
        label: 'Answers (JSON, selectors ok)',
        type: 'code',
        language: 'json',
        required: true,
        placeholder: '{ "summary": "$nodes.decide.summary" }',
        help: 'Must resolve to an object of field → value.',
      },
    ],
  },
  {
    type: 'formlogic_update_response',
    label: 'Update response',
    category: 'formlogic',
    description: 'Patch an existing response through the authenticated pipeline.',
    icon: FilePenLine,
    accent: 'indigo',
    executable: true,
    capability: 'formlogic.responses.write',
    output: 'The updated response. Reference as $nodes.<id>.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'form', label: 'Form', type: 'form', required: true, help: 'The target form. Pick one, or use a dynamic value (id / selector).' },
      { key: 'responseId', label: 'Response id', type: 'text', required: true, placeholder: '$nodes.lookup.first.id' },
      { key: 'answers', label: 'Answers (JSON, selectors ok)', type: 'code', language: 'json', placeholder: '{ "status": "done" }' },
    ],
  },
  {
    type: 'connector_request',
    label: 'Connector request',
    category: 'connector',
    description: 'Call a connector command through the permission-gated connector client (e.g. aokie sms.send).',
    icon: Plug,
    accent: 'cyan',
    executable: true,
    output: 'The connector command result (shape depends on the command). Reference as $nodes.<id>.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'connectorId', label: 'Connector', type: 'connector', required: true, placeholder: 'aokie' },
      { key: 'command', label: 'Command', type: 'connectorCommand', required: true, placeholder: 'sms.send' },
      { key: 'payload', label: 'Payload (JSON, selectors ok)', type: 'code', language: 'json', placeholder: '{ "to": "$event.data.from" }' },
    ],
  },
  {
    type: 'storage_get',
    label: 'Storage get',
    category: 'storage',
    description: 'Read a value from flow KV storage (docs §9). Missing key → undefined.',
    icon: Database,
    accent: 'teal',
    executable: true,
    output: 'The stored value (or undefined when the key is absent). Reference as $nodes.<id>.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'key', label: 'Key', type: 'text', required: true, placeholder: 'cursor  or  $inputs.key' },
      { key: 'scope', label: 'Scope', type: 'text', placeholder: 'flow:<slug> (default)', help: 'Optional. Defaults to flow:<slug>.' },
    ],
  },
  {
    type: 'storage_set',
    label: 'Storage set',
    category: 'storage',
    description: "Write a value to flow KV storage (docs §9). Requires the flow's 'formlogic.kv.write' capability.",
    icon: DatabaseZap,
    accent: 'teal',
    executable: true,
    capability: 'formlogic.kv.write',
    output: 'Object { stored: true, scope, key }.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'key', label: 'Key', type: 'text', required: true, placeholder: 'cursor  or  $inputs.key' },
      { key: 'value', label: 'Value (JSON, selectors ok)', type: 'code', language: 'json', placeholder: '{ "seenAt": "$event.receivedAt" }' },
      { key: 'valueFrom', label: 'Value from (selector)', type: 'text', placeholder: '$nodes.build.value', help: 'Optional. Takes precedence over Value.' },
      { key: 'scope', label: 'Scope', type: 'text', placeholder: 'flow:<slug> (default)' },
    ],
  },
  {
    type: 'aokie_speak',
    label: 'Aokie speak',
    category: 'connector',
    description: 'Speak text on the live call (sugar for the aokie call.operatorSpeak connector command).',
    icon: PhoneOutgoing,
    accent: 'rose',
    executable: true,
    // App-specific: only shown when an installed app provides the aokie connector (docs §4).
    requiresConnector: 'aokie',
    output: 'The connector result of aokie call.operatorSpeak.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'text', label: 'Text', type: 'textarea', placeholder: 'Thanks for calling {{inputs.name}}!', help: '{{...}} templating against the run scope.', referenceSyntax: 'template' },
      { key: 'textFrom', label: 'Text from (selector)', type: 'text', placeholder: '$nodes.summary.content', help: 'Optional. Takes precedence over Text.' },
    ],
  },

  // ── Desktop-service-backed nodes (docs §4) — REAL + executable ─────────────────────────────
  // Each drives a local FormLogic Desktop service over its loopback HTTP API (the browser
  // resolves it via the paired Desktop's GET /api/services; the desktop runner via its services
  // registry). Unreachable → an actionable "install & start the service" node_failed. The
  // browser executor (client-runtime/flows/nodes.ts) and the desktop Rust runner
  // (flows/runner.rs) implement identical semantics — the parity test keeps the set in lock-step.
  {
    type: 'browser_action',
    label: 'Browser action',
    category: 'desktop',
    description: 'Drive a real browser (navigate, click, type, extract, screenshot, evaluate) via the local Playwright Browser service.',
    icon: MousePointerClick,
    accent: 'slate',
    executable: true,
    requiresDesktopService: 'Playwright Browser',
    output:
      'Object { sessionId, status?, url?, title?, text?, html?, dataUrl?, result? } — the fields depend on the action. ' +
      'Thread $nodes.<id>.sessionId into a later browser action to reuse the same page.',
    inputs: IN,
    outputs: OUT,
    properties: [
      {
        key: 'action',
        label: 'Action',
        type: 'select',
        default: 'goto',
        options: [
          { value: 'goto', label: 'Go to URL' },
          { value: 'click', label: 'Click' },
          { value: 'type', label: 'Type text' },
          { value: 'extract_text', label: 'Extract text' },
          { value: 'extract_html', label: 'Extract HTML' },
          { value: 'screenshot', label: 'Screenshot' },
          { value: 'evaluate', label: 'Evaluate JS' },
        ],
        help: 'What this step does on the page.',
      },
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://example.com  ({{...}} ok)', help: 'Navigated first when set. Required for "Go to URL".', showIf: { property: 'action', equals: 'goto' }, referenceSyntax: 'template' },
      { key: 'selector', label: 'Selector', type: 'text', placeholder: 'button.submit  /  #email', help: 'CSS selector for Click / Type / Extract.', showIf: { property: 'action', in: ['click', 'type', 'extract_text', 'extract_html'] } },
      { key: 'text', label: 'Text to type', type: 'textarea', placeholder: 'hello@example.com  ({{...}} ok)', help: 'For the Type action.', showIf: { property: 'action', equals: 'type' }, referenceSyntax: 'template' },
      { key: 'script', label: 'Script (Evaluate JS)', type: 'code', language: 'javascript', placeholder: 'document.title', help: 'For the Evaluate action — runs in the page.', showIf: { property: 'action', equals: 'evaluate' } },
      { key: 'waitFor', label: 'Wait for selector', type: 'text', placeholder: '#results', help: 'Optional. Wait until this selector appears before the action.' },
      { key: 'sessionId', label: 'Reuse session (selector)', type: 'text', placeholder: '$nodes.open.sessionId', help: 'Optional. Reuse a page from a previous browser action.' },
      { key: 'closeSession', label: 'Close the page after', type: 'boolean', help: 'Close a session this step created (default keeps it open for reuse).' },
      { key: 'endpoint', label: 'Service base override', type: 'text', placeholder: '(auto) http://127.0.0.1:17880', help: 'Optional. A local loopback base URL for the browser service.' },
    ],
  },
  {
    type: 'image_gen',
    label: 'Image generation',
    category: 'desktop',
    description: 'Generate an image from a prompt via the local Krea-2 Turbo service (or a configured OpenAI-compatible images endpoint).',
    icon: Image,
    accent: 'slate',
    executable: true,
    requiresDesktopService: 'Krea-2 Turbo (image generation)',
    output: 'Object { imageUrl } (a link to the generated image) or { dataUrl } — reference as $nodes.<id>.imageUrl.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'prompt', label: 'Prompt', type: 'textarea', required: true, placeholder: 'A watercolour fox in a forest ({{...}} ok)', help: 'What to generate.', referenceSyntax: 'template' },
      { key: 'width', label: 'Width', type: 'number', placeholder: '1024' },
      { key: 'height', label: 'Height', type: 'number', placeholder: '1024' },
      { key: 'steps', label: 'Steps', type: 'number', placeholder: '8', help: 'Optional. Sampling steps.' },
      { key: 'model', label: 'Model', type: 'text', placeholder: '(service default)', help: 'Optional. For an OpenAI-compatible endpoint.' },
      { key: 'service', label: 'Service id', type: 'text', placeholder: 'krea2', help: 'Optional. The Desktop service id (default krea2).' },
      { key: 'endpoint', label: 'Endpoint override', type: 'text', placeholder: '(auto) http://127.0.0.1:17910/generate', help: 'Optional. A full loopback POST URL (native /generate or /v1/images/generations).' },
    ],
  },
  {
    type: 'stt_transcribe',
    label: 'Speech → text',
    category: 'desktop',
    description: 'Transcribe audio to text via a configured OpenAI-compatible transcription endpoint running on FormLogic Desktop.',
    icon: Mic,
    accent: 'slate',
    executable: true,
    requiresDesktopService: 'speech-to-text',
    output: 'Object { text } — the transcript. Reference as $nodes.<id>.text.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'endpoint', label: 'Endpoint', type: 'text', required: true, placeholder: 'http://127.0.0.1:PORT/v1/audio/transcriptions', help: 'A local OpenAI-compatible transcription endpoint.' },
      { key: 'model', label: 'Model', type: 'text', placeholder: 'whisper-1', help: 'Optional.' },
      { key: 'audio', label: 'Audio (selector)', type: 'text', required: true, placeholder: '$inputs.recording', help: 'A data URL, URL or base64 audio string.' },
      { key: 'service', label: 'Service id', type: 'text', placeholder: '(optional)', help: 'Optional. A Desktop service id to resolve the endpoint from.' },
    ],
  },
  {
    type: 'tts_speak',
    label: 'Text → speech',
    category: 'desktop',
    description: 'Synthesise speech from text via a configured OpenAI-compatible speech endpoint running on FormLogic Desktop.',
    icon: Volume2,
    accent: 'slate',
    executable: true,
    requiresDesktopService: 'text-to-speech',
    output: 'Object { audioUrl } (a link or data: URL to the audio) or { dataUrl } — reference as $nodes.<id>.audioUrl.',
    inputs: IN,
    outputs: OUT,
    properties: [
      { key: 'endpoint', label: 'Endpoint', type: 'text', required: true, placeholder: 'http://127.0.0.1:PORT/v1/audio/speech', help: 'A local OpenAI-compatible speech endpoint.' },
      { key: 'model', label: 'Model', type: 'text', placeholder: 'tts-1', help: 'Optional.' },
      { key: 'voice', label: 'Voice', type: 'text', placeholder: 'alloy', help: 'Optional.' },
      { key: 'text', label: 'Text', type: 'textarea', required: true, placeholder: 'Hello {{inputs.name}} ({{...}} ok)', help: 'The text to speak.', referenceSyntax: 'template' },
      { key: 'service', label: 'Service id', type: 'text', placeholder: '(optional)', help: 'Optional. A Desktop service id to resolve the endpoint from.' },
    ],
  },
];

export const NODE_SPECS: NodeSpec[] = [...EXECUTABLE_SPECS];

const SPECS_BY_TYPE = new Map<string, NodeSpec>(NODE_SPECS.map((s) => [s.type, s]));

/** The catalog spec for a node type, or undefined for an unknown (foreign-editor) type. */
export function getNodeSpec(type: string): NodeSpec | undefined {
  return SPECS_BY_TYPE.get(type);
}

/** Every executable catalog type (for the parity test + validation). */
export const CATALOG_EXECUTABLE_TYPES: string[] = EXECUTABLE_SPECS.map((s) => s.type);

/** Re-export so the parity test imports the executor contract from one place. */
export { EXECUTABLE_NODE_TYPES };

/** Specs for a category, in declaration order. */
export function specsForCategory(category: NodeCategory): NodeSpec[] {
  return NODE_SPECS.filter((s) => s.category === category);
}

/** Seed `data` for a freshly-created node: defaultData + each property's `default`. */
export function initialNodeData(spec: NodeSpec): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(spec.defaultData ?? {}) };
  for (const p of spec.properties) {
    if (p.default !== undefined && data[p.key] === undefined) data[p.key] = p.default;
  }
  return data;
}
