// FormLogic Flows v0 node set (docs/FORMLOGIC_FLOWS.md §4).
//
// Each node is interpreted by the executor against a WorkflowGraph. Node handlers only see
// (a) JSON node data, (b) the run scope (inputs/event/app + prior node outputs), and
// (c) the injected FlowExecutorDeps — the SAME capability boundary as app-logic effects:
// expressions run in the QuickJS sandbox (never eval), formlogic.* writes go through the
// viewer's authenticated session, connector requests through the standard permission-gated
// connector client, and HTTP is allow-listed to FormLogic Desktop + the FormLogic API only.
// Unsupported node types fail the run with `invalid_flow` naming the node — flows authored
// in the full F2I editor degrade loudly, never silently.
import { getDesktopBaseUrl } from '../desktop/desktopTypes';
import type { FlowRunErrorCode, WorkflowGraphNode } from '../../types/flows';
import { extractByPath, renderRequestTemplate, type AiCapability, type ResolvedAiProvider } from './aiProviders';
import {
  interpolateTemplate,
  resolveDeep,
  resolveSelector,
  scopeToContext,
  type SelectorScope,
} from './selectors';

/** Hard cap on nodes executed per run (docs §4: total-node budget). */
export const FLOW_NODE_BUDGET = 50;

/**
 * The `node.type` values `executeNode()` implements (docs §4 + §9). This is the executor's
 * declared contract — it MUST stay in lock-step with the `switch (node.type)` in executeNode
 * below (adding a case here without a case there, or vice-versa, is caught by the
 * nodeCatalog↔executor parity test). The editor's node catalog marks exactly these types
 * `executable`; every other palette node is display-only ("Requires FormLogic Desktop").
 */
export const EXECUTABLE_NODE_TYPES = [
  'input',
  'output',
  'condition',
  'template',
  'logic_block',
  'llm_chat',
  'http_request',
  'formlogic_list_responses',
  'formlogic_submit_response',
  'formlogic_update_response',
  'connector_request',
  'storage_get',
  'storage_set',
  'aokie_speak',
  // Desktop-service-backed nodes (docs §4). Real + executable: they drive a local
  // FormLogic Desktop service over its loopback HTTP API. Unreachable → an ACTIONABLE
  // node_failed ("install & start the service in FormLogic Desktop → Services").
  'browser_action',
  'image_gen',
  'stt_transcribe',
  'tts_speak',
] as const;

export type ExecutableNodeType = (typeof EXECUTABLE_NODE_TYPES)[number];

/** Default wall-clock budget for one logic_block evaluation (docs §4). */
export const LOGIC_BLOCK_DEFAULT_TIMEOUT_MS = 2000;
/** Bounds for a node-declared `data.timeoutMs` override, shared by logic_block AND condition (docs §4). */
const NODE_TIMEOUT_MIN_MS = 100;
const NODE_TIMEOUT_MAX_MS = 30000;

/** Capability a flow must declare (nodeCapabilities) before storage_set / formlogic.store may write. */
export const KV_WRITE_CAPABILITY = 'formlogic.kv.write';

// ── formlogic_list_responses contract (docs/FORMLOGIC_FLOWS.md §4) ─────────────────────────
// FROZEN CONTRACT — the desktop Rust runner mirrors this exactly. The node fetches up to
// `limit` rows, normalizes each to a FlowResponseRow, applies the ANDed `filters` client-side,
// and returns a STRUCTURED object so downstream nodes reference $nodes.<id>.first.answers.<field>,
// .count, .found or .responses. See docs §4 for the worked caller-lookup example.

/** Default number of rows formlogic_list_responses scans before filtering. */
export const LIST_RESPONSES_DEFAULT_LIMIT = 200;
/** Hard cap on rows formlogic_list_responses will scan (client-side filtering is per-page). */
export const LIST_RESPONSES_MAX_LIMIT = 500;

/** A comparison operator for a formlogic_list_responses filter row. */
export type FlowFilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'in';

/** One AND-ed filter over a form field: `answers[field] <op> value`. */
export interface FlowResponseFilter {
  field: string;
  op: FlowFilterOp;
  /** Literal or a `$` selector resolved against the run scope before matching. */
  value: unknown;
}

/** A response normalized to the shape downstream nodes see. */
export interface FlowResponseRow {
  id: string;
  answers: Record<string, unknown>;
  submittedAt?: string;
  status?: string;
}

/** The structured output of a formlogic_list_responses node. */
export interface FlowListResponsesResult {
  responses: FlowResponseRow[];
  count: number;
  first: FlowResponseRow | null;
  found: boolean;
}

const FILTER_OPS = new Set<FlowFilterOp>(['eq', 'neq', 'contains', 'gt', 'lt', 'in']);

/** Typed executor failure carrying the flow-run-result error code + offending node. */
export class FlowExecError extends Error {
  readonly code: FlowRunErrorCode;
  readonly nodeId?: string;

  constructor(code: FlowRunErrorCode, message: string, nodeId?: string) {
    super(message);
    this.name = 'FlowExecError';
    this.code = code;
    this.nodeId = nodeId;
  }
}

/**
 * Capabilities injected into a run. The browser wiring (flowDispatcher) binds these to the
 * QuickJS engine, the app runtime store and the connector client; tests inject fakes.
 */
export interface FlowExecutorDeps {
  /**
   * Sandboxed boolean expression over a JSON context (QuickJS — never eval).
   * `budgetMs`, when given, is the node's own clamped `data.timeoutMs`
   * (100ms–30s) — the real in-VM interrupt deadline should match it instead
   * of always falling back to the sandbox's internal default.
   */
  evaluateBoolean(expr: string, ctx: Record<string, unknown>, budgetMs?: number): Promise<boolean>;
  /**
   * Sandboxed value expression over a JSON context (QuickJS — never eval).
   * `budgetMs` is logic_block's clamped `data.timeoutMs` (or the 2s default) —
   * see `evaluateBoolean`.
   */
  evaluateExpression(expr: string, ctx: Record<string, unknown>, budgetMs?: number): Promise<unknown>;
  /** Read a form's responses with the viewer's session/permissions. */
  listResponses(formId: string, query?: Record<string, unknown>): Promise<unknown[]>;
  /** Submit through the normal authenticated pipeline (validation + onSubmit + idempotency). */
  submitResponse(formId: string, answers: Record<string, unknown>): Promise<unknown>;
  updateResponse(formId: string, responseId: string, answers: Record<string, unknown>): Promise<unknown>;
  /** Standard connector gateway (connector.<id>.<command> permission gating applies). */
  connectorRequest(connectorId: string, command: string, payload?: unknown): Promise<unknown>;
  /** Fetch override for llm_chat / http_request (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Flow KV read (docs §9) — the app store inside an app runtime, else the owner's workspace store. */
  kvGet?(scope: string, key: string): Promise<unknown>;
  /** Flow KV upsert (docs §9). Callers are gated by the KV_WRITE_CAPABILITY check in storage_set. */
  kvSet?(scope: string, key: string, value: unknown): Promise<unknown>;
  /** One KV scope's entries as a plain {key: value} object (logic_block's read-only ctx.kv snapshot). */
  kvList?(scope: string): Promise<Record<string, unknown>>;
  /**
   * Resolve a running FormLogic Desktop local AI service exposing an OpenAI-compatible
   * chat endpoint (GET /api/services on the paired Desktop). Null when Desktop is absent,
   * unpaired, or runs no suitable service.
   */
  resolveDesktopLlmEndpoint?(): Promise<{ endpoint: string; service: string } | null>;
  /**
   * Browser-only AI provider registry lookup. `data.provider` is a browser-execution routing
   * hint; the desktop Rust runner intentionally ignores it and uses its own service resolution.
   */
  resolveAiProvider?(capability: AiCapability, providerId: string): Promise<ResolvedAiProvider | null>;
  /** Configured app-level OpenAI-compatible AI base URL, when the app provides one. */
  getAppAiBase?(): string | null;
  /**
   * Resolve a running FormLogic Desktop local SERVICE's loopback base URL by its id
   * (e.g. 'playwright-browser', 'krea2') via the paired Desktop's GET /api/services.
   * Backs the desktop-service nodes (browser_action / image_gen). Null when Desktop is
   * absent, unpaired, or the service isn't running — the node then fails with an
   * actionable "install & start the service in FormLogic Desktop" message.
   */
  resolveDesktopServiceBase?(serviceId: string): Promise<string | null>;
}

/** Everything one node execution can see. */
export interface FlowNodeContext {
  node: WorkflowGraphNode;
  /** Selector scope for the run: $inputs / $event / $app / $nodes / $upstream. */
  scope: SelectorScope;
  signal: AbortSignal;
  deps: FlowExecutorDeps;
  /** The running flow's declared nodeCapabilities (null/absent = none declared). */
  capabilities?: string[] | null;
  /** The running flow's slug — the default KV scope is 'flow:<slug>' (docs §9). */
  flowSlug?: string;
}

/**
 * HTTP allow-list (docs §4): FormLogic Desktop's loopback base URL and the same-origin
 * FormLogic API only. Anything else is a capability_denied — flows can never exfiltrate
 * to arbitrary hosts from the viewer's browser.
 */
export function isAllowedFlowUrl(url: string): boolean {
  const desktop = getDesktopBaseUrl();
  if (url === desktop || url.startsWith(desktop + '/')) return true;
  if (url === '/api' || url.startsWith('/api/')) return true;
  if (typeof window !== 'undefined' && window.location?.origin) {
    const apiBase = `${window.location.origin}/api`;
    if (url === apiBase || url.startsWith(apiBase + '/')) return true;
  }
  return false;
}

/**
 * True for loopback-only http(s) URLs (127.0.0.1 / localhost / ::1). Desktop-managed AI
 * services run on their own loopback ports (Ollama on 11434, llama.cpp on 8080, …), so an
 * endpoint RESOLVED FROM the paired Desktop's /api/services list is allowed when — and only
 * when — it stays on the local machine. Never applied to author-supplied URLs.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
  } catch {
    return false;
  }
}

function nodeData(node: WorkflowGraphNode): Record<string, unknown> {
  return node.data && typeof node.data === 'object' ? node.data : {};
}

function requireString(node: WorkflowGraphNode, data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  throw new FlowExecError(
    'invalid_flow',
    `Node '${node.id}' (${node.type}) is missing '${keys[0]}'`,
    node.id
  );
}

/**
 * Capability gate shared by connector_request and aokie_speak (its inlined sugar form) —
 * a flow must declare EITHER the exact 'connector.<id>.<command>' capability OR the
 * connector-wide wildcard 'connector.<id>.*' in nodeCapabilities before it may dispatch to
 * the connector gateway. Same declare-then-grant model as KV_WRITE_CAPABILITY above; keep
 * both call sites routed through this one function so they can't drift out of sync.
 */
function requireConnectorCapability(ctx: FlowNodeContext, connectorId: string, command: string, nodeId: string): void {
  const exact = `connector.${connectorId}.${command}`;
  const wildcard = `connector.${connectorId}.*`;
  const granted = ctx.capabilities ?? [];
  if (!granted.includes(exact) && !granted.includes(wildcard)) {
    throw new FlowExecError(
      'capability_denied',
      `Node '${nodeId}' requires the '${exact}' capability — add \`${exact}\` or \`${wildcard}\` to the flow's nodeCapabilities`,
      nodeId
    );
  }
}

/** JSON expression context shared by condition/logic_block (keys become sandbox globals). */
function exprContext(ctx: FlowNodeContext): Record<string, unknown> {
  return {
    inputs: ctx.scope.inputs ?? {},
    event: ctx.scope.event ?? null,
    app: ctx.scope.app ?? null,
    nodes: ctx.scope.nodes ?? {},
    upstream: ctx.scope.upstream ?? null,
  };
}

/** Default KV scope for a node: node data.scope, else 'flow:<slug>', else 'app' (docs §9). */
function kvScopeFor(data: Record<string, unknown>, ctx: FlowNodeContext): string {
  if (typeof data.scope === 'string' && data.scope.trim() !== '') return data.scope;
  return ctx.flowSlug ? `flow:${ctx.flowSlug}` : 'app';
}

/** Resolve a storage node's key: literal string or a `$` selector into the run scope. */
function resolveKvKey(node: WorkflowGraphNode, data: Record<string, unknown>, ctx: FlowNodeContext): string {
  const raw = requireString(node, data, ['key', 'k']);
  const resolved = resolveSelector(raw, ctx.scope);
  if (typeof resolved !== 'string' || resolved === '') {
    throw new FlowExecError('node_failed', `Node '${node.id}' key did not resolve to a string`, node.id);
  }
  return resolved;
}

/**
 * Clamp a node's declared `data.timeoutMs` into [100, 30000] (docs §4), or
 * `undefined` when absent/not a finite number — callers then fall back to
 * their own default budget, preserving today's behavior for nodes that don't
 * declare an override.
 */
function clampDeclaredTimeoutMs(data: Record<string, unknown>): number | undefined {
  return typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs)
    ? Math.min(Math.max(data.timeoutMs, NODE_TIMEOUT_MIN_MS), NODE_TIMEOUT_MAX_MS)
    : undefined;
}

/** Race a node-scoped promise against a wall-clock deadline (logic_block's 2s default). */
async function withNodeTimeout<T>(promise: Promise<T>, timeoutMs: number, node: WorkflowGraphNode): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new FlowExecError('timeout', `Node '${node.id}' (${node.type}) exceeded ${timeoutMs}ms`, node.id)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a node-data form reference (formId or selector). */
function resolveFormRef(node: WorkflowGraphNode, data: Record<string, unknown>, ctx: FlowNodeContext): string {
  const raw = requireString(node, data, ['form', 'formId']);
  const resolved = resolveSelector(raw, ctx.scope);
  if (typeof resolved !== 'string' || resolved === '') {
    throw new FlowExecError('node_failed', `Node '${node.id}' form reference did not resolve to a form id`, node.id);
  }
  return resolved;
}

/** Clamp a node's `limit` into [1, LIST_RESPONSES_MAX_LIMIT], defaulting when unset/invalid. */
function clampListLimit(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : LIST_RESPONSES_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), LIST_RESPONSES_MAX_LIMIT);
}

/** First defined non-empty string among the candidates (for tolerant field aliasing). */
function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c;
  }
  return undefined;
}

/** Normalize a raw response record (snake/camel tolerant) to a FlowResponseRow, or null. */
function normalizeResponseRow(raw: unknown): FlowResponseRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : typeof r.id === 'number' ? String(r.id) : '';
  const answers =
    r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers)
      ? (r.answers as Record<string, unknown>)
      : {};
  const row: FlowResponseRow = { id, answers };
  const submittedAt = firstString(r.submittedAt, r.submitted_at, r.createdAt, r.created_at);
  if (submittedAt !== undefined) row.submittedAt = submittedAt;
  const status = firstString(r.status);
  if (status !== undefined) row.status = status;
  return row;
}

/** Parse a node's `data.filters` into typed rows (unknown ops → 'eq'; empty fields dropped). */
function parseResponseFilters(raw: unknown): FlowResponseFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowResponseFilter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const field = typeof r.field === 'string' ? r.field.trim() : '';
    if (field === '') continue;
    const op = typeof r.op === 'string' && FILTER_OPS.has(r.op as FlowFilterOp) ? (r.op as FlowFilterOp) : 'eq';
    out.push({ field, op, value: r.value });
  }
  return out;
}

/** Loose equality consistent with stored field values: identity, else String() compare. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Numeric compare with a locale string fallback when either side is non-numeric. */
function numericCompare(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** `one of` membership: the filter value is an array or a comma list; loose-equals membership. */
function inList(fieldValue: unknown, filterValue: unknown): boolean {
  const list = Array.isArray(filterValue)
    ? filterValue
    : String(filterValue ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
  return list.some((item) => looseEquals(fieldValue, item));
}

/** Evaluate one filter op against a field value (see docs §4 for op semantics). */
function matchesFilterOp(fieldValue: unknown, op: FlowFilterOp, filterValue: unknown): boolean {
  switch (op) {
    case 'eq':
      return looseEquals(fieldValue, filterValue);
    case 'neq':
      return !looseEquals(fieldValue, filterValue);
    case 'contains':
      return String(fieldValue ?? '').toLowerCase().includes(String(filterValue ?? '').toLowerCase());
    case 'gt':
      return numericCompare(fieldValue, filterValue) > 0;
    case 'lt':
      return numericCompare(fieldValue, filterValue) < 0;
    case 'in':
      return inList(fieldValue, filterValue);
    default:
      return false;
  }
}

/**
 * llm_chat endpoint resolution (docs §4), in order:
 *   1. the node's own data.endpoint  — allow-listed exactly as before (Desktop base / FormLogic API);
 *   2. a running FormLogic Desktop local AI service (paired Desktop's GET /api/services —
 *      OpenAI-compatible, loopback-only endpoints);
 *   3. the app's configured AI base URL (appContext.aiBaseUrl), '<base>/chat/completions'.
 * No candidate → node_failed with a message naming all three options.
 */
async function resolveLlmChatEndpoint(ctx: FlowNodeContext): Promise<string> {
  const { node, deps } = ctx;
  const data = nodeData(node);

  if (typeof data.endpoint === 'string' && data.endpoint.trim() !== '') {
    if (!isAllowedFlowUrl(data.endpoint)) {
      throw new FlowExecError(
        'capability_denied',
        `Node '${node.id}' llm_chat endpoint is not allow-listed (Desktop base URL or the FormLogic API only)`,
        node.id
      );
    }
    return data.endpoint;
  }

  if (deps.resolveDesktopLlmEndpoint) {
    let resolved: { endpoint: string; service: string } | null = null;
    try {
      resolved = await deps.resolveDesktopLlmEndpoint();
    } catch {
      resolved = null; // Desktop probe failures fall through to the next option.
    }
    // Desktop-resolved endpoints are trusted ONLY on the local machine.
    if (resolved && isLoopbackUrl(resolved.endpoint)) return resolved.endpoint;
  }

  const aiBase = deps.getAppAiBase?.() ?? null;
  if (typeof aiBase === 'string' && aiBase.trim() !== '') {
    const endpoint = `${aiBase.replace(/\/+$/, '')}/chat/completions`;
    if (isAllowedFlowUrl(endpoint) || isLoopbackUrl(endpoint)) return endpoint;
  }

  throw new FlowExecError(
    'node_failed',
    `Node '${node.id}' llm_chat has no AI endpoint — set the node's 'endpoint', ` +
      `start a local AI service in FormLogic Desktop (paired), or configure the app's AI base URL`,
    node.id
  );
}

/** Best-effort: the first model id the OpenAI-compatible service advertises at
 *  `…/v1/models`. Returns null on any failure (a single-model server that
 *  doesn't need the field is unaffected; Ollama, which requires it, gets one). */
async function discoverDefaultModel(
  chatEndpoint: string,
  doFetch: typeof fetch,
  signal?: AbortSignal,
  headers?: HeadersInit
): Promise<string | null> {
  try {
    const init: RequestInit = { signal };
    if (headers) init.headers = headers;
    const res = await doFetch(chatEndpoint.replace('/chat/completions', '/models'), init);
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const id = payload?.data?.find((m) => typeof m?.id === 'string')?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

async function resolveNodeAiProvider(ctx: FlowNodeContext, capability: AiCapability): Promise<ResolvedAiProvider | null> {
  const data = nodeData(ctx.node);
  const providerId = typeof data.provider === 'string' ? data.provider.trim() : '';
  if (providerId === '' || !ctx.deps.resolveAiProvider) return null;
  const provider = await ctx.deps.resolveAiProvider(capability, providerId);
  if (!provider) {
    throw new FlowExecError(
      'node_failed',
      `Node '${ctx.node.id}' AI service '${providerId}' is not configured in this browser for ${capability} -- open Flows -> AI services and add or enable it (and check its capabilities).`,
      ctx.node.id
    );
  }
  return provider;
}

function providerKeyBlockedHint(provider: ResolvedAiProvider | null): string {
  return provider?.keyBlocked
    ? ' The saved API key was not sent because the provider uses unencrypted HTTP on a non-loopback host.'
    : '';
}

function appendProviderKeyBlockedHint(message: string, provider: ResolvedAiProvider | null): string {
  const hint = providerKeyBlockedHint(provider);
  return hint ? `${message}.${hint}` : message;
}

async function runLlmChat(ctx: FlowNodeContext): Promise<unknown> {
  const { node, deps } = ctx;
  const data = nodeData(node);
  const provider = await resolveNodeAiProvider(ctx, 'chat');
  const endpoint = provider?.url ?? await resolveLlmChatEndpoint(ctx);
  const templateCtx = scopeToContext(ctx.scope);
  const messages: Array<{ role: string; content: string }> = [];
  let systemText = '';
  if (typeof data.system === 'string' && data.system !== '') {
    systemText = interpolateTemplate(data.system, templateCtx);
    messages.push({ role: 'system', content: systemText });
  }
  if (Array.isArray(data.messages)) {
    for (const m of data.messages) {
      if (m && typeof m === 'object' && typeof (m as { role?: unknown }).role === 'string' && typeof (m as { content?: unknown }).content === 'string') {
        const msg = m as { role: string; content: string };
        messages.push({ role: msg.role, content: interpolateTemplate(msg.content, templateCtx) });
      }
    }
  }
  let promptText = '';
  if (typeof data.prompt === 'string' && data.prompt !== '') {
    promptText = interpolateTemplate(data.prompt, templateCtx);
    messages.push({ role: 'user', content: promptText });
  }
  if (messages.length === 0) {
    throw new FlowExecError('invalid_flow', `Node '${node.id}' llm_chat has no prompt/messages`, node.id);
  }
  const body: Record<string, unknown> = { messages };
  const doFetch = deps.fetchFn ?? fetch;
  // Model may be templated ({{...}}) so a config record / upstream node can drive it.
  const modelStr = typeof data.model === 'string' ? interpolateTemplate(data.model, templateCtx).trim() : '';
  if (modelStr) {
    body.model = modelStr;
  } else if (provider?.model) {
    body.model = provider.model;
  } else {
    // Ollama (and other strict OpenAI-compatible servers) reject a model-less
    // request. If the flow didn't pin a model, use the first the service
    // advertises so model-less flows work out of the box.
    const fallback = await discoverDefaultModel(endpoint, doFetch, ctx.signal, provider?.headers);
    if (fallback) body.model = fallback;
  }
  if (typeof data.temperature === 'number') body.temperature = data.temperature;
  if (typeof data.maxTokens === 'number') body.max_tokens = data.maxTokens;
  // Pass-through extra request params (e.g. Qwen3's
  // chat_template_kwargs:{enable_thinking:false} to skip the reasoning block).
  if (data.extraBody && typeof data.extraBody === 'object') {
    Object.assign(body, data.extraBody as Record<string, unknown>);
  }

  const requestBody = provider?.requestTemplate
    ? renderRequestTemplate(provider.requestTemplate, {
        model: body.model,
        prompt: promptText,
        system: systemText,
        messages,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        input: promptText,
        apiKey: provider.apiKey,
      })
    : body;

  // One bounded retry (seen live on the desktop runner: a concurrent LLM
  // request got an EMPTY completion). Transport errors, non-2xx and empty
  // replies each get exactly one more attempt; a still-empty SECOND
  // completion returns normally so flow-level fallback text applies.
  // Mirrors the Rust runner (flows/runner.rs run_llm_chat).
  let failure: FlowExecError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: provider?.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw err; // deliberate cancel — never retry
      failure = new FlowExecError(
        'node_failed',
        `Node '${node.id}' llm_chat endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
        node.id
      );
      continue;
    }
    if (!res.ok) {
      failure = new FlowExecError('node_failed', appendProviderKeyBlockedHint(`Node '${node.id}' llm_chat responded ${res.status}`, provider), node.id);
      continue;
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      failure = new FlowExecError('node_failed', `Node '${node.id}' llm_chat returned a non-JSON body`, node.id);
      continue;
    }
    const content = extractByPath(payload, provider?.responsePath ?? 'choices.0.message.content');
    const text = typeof content === 'string' ? content : null;
    if (attempt === 0 && (text === null || text.trim() === '')) {
      continue; // empty completion — retry once
    }
    return { content: text, raw: payload };
  }
  throw failure ?? new FlowExecError('node_failed', `Node '${node.id}' llm_chat failed`, node.id);
}

async function runHttpRequest(ctx: FlowNodeContext): Promise<unknown> {
  const { node, deps } = ctx;
  const data = nodeData(node);
  const rawUrl = requireString(node, data, ['url']);
  const interpolatedUrl = interpolateTemplate(rawUrl, scopeToContext(ctx.scope));
  // `data.service`, if set, is a STATIC, author-chosen service id — read directly off the
  // node's data, NEVER templated/selector-resolved. It pins WHICH desktop service is hit; the
  // (templatable) `url` becomes a PATH appended to that service's resolved loopback base
  // instead of being used as an absolute URL. This is what keeps the feature safe when
  // trigger/event data flows into `url`: an attacker who controls the trigger can influence
  // the PATH but never the host, because `service` is fixed at flow-authoring time. The
  // allow-list check below is skipped entirely in this branch — the service resolution IS the
  // trust boundary now, not the URL allow-list.
  let url: string;
  if (typeof data.service === 'string' && data.service.trim() !== '') {
    let base: string | null = null;
    if (deps.resolveDesktopServiceBase) {
      try {
        base = await deps.resolveDesktopServiceBase(data.service);
      } catch {
        base = null;
      }
    }
    if (!base || !isLoopbackUrl(base)) {
      // bundled=true: unlike stt_transcribe/tts_speak, http_request has no 'endpoint' property
      // to fall back to — the only fix is to start the named service (or fix `service`).
      throw desktopServiceUnavailable(node, data.service, true);
    }
    url = `${base.replace(/\/+$/, '')}/${interpolatedUrl.replace(/^\/+/, '')}`;
  } else {
    url = interpolatedUrl;
    if (!isAllowedFlowUrl(url)) {
      throw new FlowExecError(
        'capability_denied',
        `Node '${node.id}' http_request URL is not allow-listed (Desktop base URL or the FormLogic API only)`,
        node.id
      );
    }
  }
  const method = typeof data.method === 'string' && data.method !== '' ? data.method.toUpperCase() : 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (data.headers && typeof data.headers === 'object' && !Array.isArray(data.headers)) {
    for (const [k, v] of Object.entries(data.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  const resolvedBody = data.body !== undefined ? resolveDeep(data.body, ctx.scope) : undefined;
  const doFetch = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: resolvedBody !== undefined && method !== 'GET' && method !== 'HEAD' ? JSON.stringify(resolvedBody) : undefined,
      credentials: url.startsWith('/') ? 'include' : 'omit',
      signal: ctx.signal,
    });
  } catch (err) {
    throw new FlowExecError(
      'node_failed',
      `Node '${node.id}' http_request failed: ${err instanceof Error ? err.message : String(err)}`,
      node.id
    );
  }
  let parsed: unknown = null;
  const text = await res.text().catch(() => '');
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

// ── Desktop-service-backed nodes (docs §4) ─────────────────────────────────────────────────
// browser_action / image_gen drive LOCAL FormLogic Desktop services over loopback HTTP. Speech
// nodes use configured OpenAI-compatible endpoints; their optional Desktop service id only
// resolves a base URL. The browser path is best-effort: resolve the service base (node
// data.endpoint override, else the paired Desktop's GET /api/services), then a short loopback
// fetch. On ANY transport failure (Desktop absent / unpaired / service not running / CORS /
// connection refused) the node fails with an ACTIONABLE message — never "coming soon". The
// desktop Rust runner (flows/runner.rs) mirrors these semantics exactly.

/** The actionable failure raised when a desktop service can't be reached (never "coming soon"). */
function desktopServiceUnavailable(node: WorkflowGraphNode, service: string, bundled: boolean): FlowExecError {
  const msg = bundled
    ? `This step runs on FormLogic Desktop. Install and start the ${service} service in FormLogic Desktop → Services, then run the flow there.`
    : `This step needs a ${service} service. Set the step's 'endpoint' to a running ${service} endpoint (or start one in FormLogic Desktop → Services), then run the flow there.`;
  return new FlowExecError('node_failed', `Node '${node.id}': ${msg}`, node.id);
}

/**
 * Resolve a desktop service's loopback BASE url for browser_action / image_gen:
 *   1. the node's own data.endpoint (allow-listed to Desktop base / FormLogic API / loopback);
 *   2. the paired FormLogic Desktop's running service by id (deps.resolveDesktopServiceBase).
 * No candidate → the actionable node_failed above (bundled service).
 */
async function resolveServiceBase(
  ctx: FlowNodeContext,
  serviceId: string,
  humanName: string
): Promise<string> {
  const { node, deps } = ctx;
  const data = nodeData(node);
  if (typeof data.endpoint === 'string' && data.endpoint.trim() !== '') {
    const base = data.endpoint.replace(/\/+$/, '');
    if (!isAllowedFlowUrl(base) && !isLoopbackUrl(base)) {
      throw new FlowExecError(
        'capability_denied',
        `Node '${node.id}' endpoint is not allow-listed (a local loopback service, the Desktop base URL or the FormLogic API only)`,
        node.id
      );
    }
    return base;
  }
  if (deps.resolveDesktopServiceBase) {
    let base: string | null = null;
    try {
      base = await deps.resolveDesktopServiceBase(serviceId);
    } catch {
      base = null;
    }
    if (base && isLoopbackUrl(base)) return base.replace(/\/+$/, '');
  }
  throw desktopServiceUnavailable(node, humanName, true);
}

/** POST/GET a desktop service and parse JSON. Transport failure → the actionable message. */
async function serviceFetchJson(
  ctx: FlowNodeContext,
  url: string,
  init: RequestInit,
  humanName: string,
  bundled: boolean
): Promise<Record<string, unknown>> {
  const { node, deps } = ctx;
  const doFetch = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: ctx.signal });
  } catch {
    // Unreachable / CORS / connection refused — the service isn't running here.
    throw desktopServiceUnavailable(node, humanName, bundled);
  }
  if (!res.ok) {
    throw new FlowExecError('node_failed', `Node '${node.id}': ${humanName} service responded ${res.status}`, node.id);
  }
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    throw new FlowExecError('node_failed', `Node '${node.id}': ${humanName} service returned a non-JSON body`, node.id);
  }
}

async function providerFetchJson(
  ctx: FlowNodeContext,
  provider: ResolvedAiProvider,
  init: RequestInit,
  humanName: string
): Promise<Record<string, unknown>> {
  const doFetch = ctx.deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(provider.url, { ...init, signal: ctx.signal });
  } catch (err) {
    throw new FlowExecError(
      'node_failed',
      `Node '${ctx.node.id}': ${humanName} provider '${provider.name}' unreachable: ${err instanceof Error ? err.message : String(err)}`,
      ctx.node.id
    );
  }
  if (!res.ok) {
    throw new FlowExecError(
      'node_failed',
      appendProviderKeyBlockedHint(`Node '${ctx.node.id}': ${humanName} provider '${provider.name}' responded ${res.status}`, provider),
      ctx.node.id
    );
  }
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    throw new FlowExecError('node_failed', `Node '${ctx.node.id}': ${humanName} provider '${provider.name}' returned a non-JSON body`, ctx.node.id);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Encode raw audio bytes to a base64 string (chunked so a large buffer can't blow the stack). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : // Node/test fallback.
      (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer!.from(
        binary,
        'binary'
      ).toString('base64');
}

/** The playwright-browser service id + human name (docs §4). */
const BROWSER_SERVICE = { id: 'playwright-browser', name: 'Playwright Browser' } as const;

/**
 * browser_action — drive the local Playwright Browser service (default port 17880). One node
 * runs a full step: (re)use a session, optionally navigate + wait, then perform the action.
 * Output: { sessionId, status?, url?, title?, text?, html?, dataUrl?, result? }.
 */
async function runBrowserAction(ctx: FlowNodeContext): Promise<unknown> {
  const { node, scope } = ctx;
  const data = nodeData(node);
  const base = await resolveServiceBase(ctx, BROWSER_SERVICE.id, BROWSER_SERVICE.name);
  const action = typeof data.action === 'string' && data.action !== '' ? data.action : 'goto';
  const templateCtx = scopeToContext(scope);

  // 1. Session — reuse a threaded sessionId, else create one.
  const sessionRef = resolveSelector(data.sessionId, scope);
  let sessionId = typeof sessionRef === 'string' && sessionRef !== '' ? sessionRef : '';
  let createdSession = false;
  if (sessionId === '') {
    const config = data.config && typeof data.config === 'object' && !Array.isArray(data.config) ? data.config : {};
    const created = await serviceFetchJson(
      ctx,
      `${base}/session`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ config }) },
      BROWSER_SERVICE.name,
      true
    );
    sessionId = typeof created.sessionId === 'string' ? created.sessionId : '';
    if (sessionId === '') throw new FlowExecError('node_failed', `Node '${node.id}': browser session was not created`, node.id);
    createdSession = true;
  }
  const out: Record<string, unknown> = { sessionId };
  const sPath = `${base}/session/${encodeURIComponent(sessionId)}`;

  // 2. Navigate (when a url is provided).
  const url = typeof data.url === 'string' && data.url !== '' ? interpolateTemplate(data.url, templateCtx) : '';
  if (url !== '') {
    const nav: Record<string, unknown> = { url };
    if (typeof data.waitUntil === 'string' && data.waitUntil !== '') nav.waitUntil = data.waitUntil;
    const r = await serviceFetchJson(ctx, `${sPath}/goto`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(nav) }, BROWSER_SERVICE.name, true);
    out.url = r.url;
    out.title = r.title;
    out.status = r.status;
  }

  // 3. Wait for a selector (when provided).
  if (typeof data.waitFor === 'string' && data.waitFor !== '') {
    const wait: Record<string, unknown> = { selector: data.waitFor };
    if (typeof data.waitTimeoutMs === 'number') wait.timeoutMs = data.waitTimeoutMs;
    await serviceFetchJson(ctx, `${sPath}/wait`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(wait) }, BROWSER_SERVICE.name, true);
  }

  // 4. Perform the action.
  const selector = typeof data.selector === 'string' && data.selector !== '' ? data.selector : '';
  switch (action) {
    case 'goto':
      if (url === '') throw new FlowExecError('invalid_flow', `Node '${node.id}' browser_action 'goto' needs a url`, node.id);
      break;
    case 'click': {
      if (selector === '') throw new FlowExecError('invalid_flow', `Node '${node.id}' browser_action 'click' needs a selector`, node.id);
      await serviceFetchJson(ctx, `${sPath}/action`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'click', selector }) }, BROWSER_SERVICE.name, true);
      break;
    }
    case 'type': {
      if (selector === '') throw new FlowExecError('invalid_flow', `Node '${node.id}' browser_action 'type' needs a selector`, node.id);
      const text = typeof data.text === 'string' ? interpolateTemplate(data.text, templateCtx) : '';
      await serviceFetchJson(ctx, `${sPath}/action`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'type', selector, text }) }, BROWSER_SERVICE.name, true);
      break;
    }
    case 'extract_text': {
      const script = selector !== ''
        ? `(document.querySelector(${JSON.stringify(selector)})||{}).innerText||''`
        : `document.body?document.body.innerText:''`;
      const r = await serviceFetchJson(ctx, `${sPath}/evaluate`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ script }) }, BROWSER_SERVICE.name, true);
      out.text = r.result;
      break;
    }
    case 'extract_html': {
      const r = await serviceFetchJson(ctx, `${sPath}/html`, { method: 'GET' }, BROWSER_SERVICE.name, true);
      out.html = r.html;
      break;
    }
    case 'screenshot': {
      const r = await serviceFetchJson(ctx, `${sPath}/screenshot`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ fullPage: !!data.fullPage }) }, BROWSER_SERVICE.name, true);
      out.dataUrl = r.dataUrl;
      break;
    }
    case 'evaluate': {
      const script = requireString(node, data, ['script']);
      const r = await serviceFetchJson(ctx, `${sPath}/evaluate`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ script }) }, BROWSER_SERVICE.name, true);
      out.result = r.result;
      break;
    }
    default:
      throw new FlowExecError('invalid_flow', `Node '${node.id}' browser_action has an unknown action '${action}'`, node.id);
  }

  // 5. Close the session only when we created it AND the author asked (else keep it for
  //    threading via $nodes.<id>.sessionId into a later browser_action).
  if (createdSession && data.closeSession) {
    const doFetch = ctx.deps.fetchFn ?? fetch;
    await doFetch(`${sPath}`, { method: 'DELETE', signal: ctx.signal }).catch(() => undefined);
  }
  return out;
}

/** The krea2 (text-to-image) service id + human name (docs §4). */
const IMAGE_SERVICE = { id: 'krea2', name: 'Krea-2 Turbo (Text-to-Image)' } as const;

/**
 * image_gen — text-to-image via the local Krea-2 service (POST /generate → {imageUrl}) or a
 * configured OpenAI-compatible images endpoint (POST /v1/images/generations → {data:[{url|b64_json}]}).
 * A superset body drives both (extra fields are ignored by each). Output: { imageUrl | dataUrl }.
 */
async function runImageGen(ctx: FlowNodeContext): Promise<unknown> {
  const { node, scope } = ctx;
  const data = nodeData(node);
  const serviceId = typeof data.service === 'string' && data.service !== '' ? data.service : IMAGE_SERVICE.id;

  // Endpoint: an explicit override is the full POST url; otherwise the resolved service base + /generate.
  let endpoint: string;
  if (typeof data.endpoint === 'string' && data.endpoint.trim() !== '') {
    endpoint = data.endpoint;
    if (!isAllowedFlowUrl(endpoint) && !isLoopbackUrl(endpoint)) {
      throw new FlowExecError('capability_denied', `Node '${node.id}' image_gen endpoint is not allow-listed (a local loopback service or the FormLogic API only)`, node.id);
    }
  } else {
    endpoint = `${await resolveServiceBase(ctx, serviceId, IMAGE_SERVICE.name)}/generate`;
  }

  const prompt = interpolateTemplate(requireString(node, data, ['prompt']), scopeToContext(scope));
  const width = typeof data.width === 'number' ? data.width : 1024;
  const height = typeof data.height === 'number' ? data.height : 1024;
  const body: Record<string, unknown> = { prompt, width, height, size: `${width}x${height}` };
  if (typeof data.steps === 'number') body.steps = data.steps;
  if (typeof data.model === 'string' && data.model !== '') body.model = data.model;

  const r = await serviceFetchJson(ctx, endpoint, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, IMAGE_SERVICE.name, true);
  // krea2 native shape.
  if (typeof r.imageUrl === 'string' && r.imageUrl !== '') return { imageUrl: r.imageUrl };
  // OpenAI-compatible images shape.
  const first = Array.isArray(r.data) ? (r.data[0] as Record<string, unknown> | undefined) : undefined;
  if (first && typeof first.url === 'string' && first.url !== '') return { imageUrl: first.url };
  if (first && typeof first.b64_json === 'string' && first.b64_json !== '') return { dataUrl: `data:image/png;base64,${first.b64_json}` };
  if (typeof r.url === 'string' && r.url !== '') return { imageUrl: r.url };
  throw new FlowExecError('node_failed', `Node '${node.id}': image_gen response had no image (expected imageUrl or data[].url / data[].b64_json)`, node.id);
}

/** The bundled Desktop speech service (Parakeet STT + pocket-tts TTS) — stt/tts's default. */
const SPEECH_SERVICE = 'aokie-voice';

/**
 * Resolve an OpenAI-compatible endpoint for stt/tts: the node's own data.endpoint
 * (allow-listed), a data.service resolved on the paired Desktop + defaultPath, else the
 * bundled 'aokie-voice' speech service — the same default-service pattern as
 * browser_action/image_gen, mirrored in the desktop runner (flows/runner.rs). An explicitly
 * named service that fails to resolve still errors (no silent substitution).
 * No candidate → the actionable node_failed (unbundled service).
 */
async function resolveConfiguredEndpoint(ctx: FlowNodeContext, defaultPath: string, humanName: string): Promise<string> {
  const { node, deps } = ctx;
  const data = nodeData(node);
  if (typeof data.endpoint === 'string' && data.endpoint.trim() !== '') {
    const endpoint = data.endpoint;
    if (!isAllowedFlowUrl(endpoint) && !isLoopbackUrl(endpoint)) {
      throw new FlowExecError('capability_denied', `Node '${node.id}' endpoint is not allow-listed (a local loopback service or the FormLogic API only)`, node.id);
    }
    return endpoint;
  }
  const explicitService = typeof data.service === 'string' && data.service !== '' ? data.service : null;
  if (deps.resolveDesktopServiceBase) {
    const serviceId = explicitService ?? SPEECH_SERVICE;
    let base: string | null = null;
    try {
      base = await deps.resolveDesktopServiceBase(serviceId);
    } catch {
      base = null;
    }
    if (base && isLoopbackUrl(base)) return `${base.replace(/\/+$/, '')}${defaultPath}`;
  }
  throw desktopServiceUnavailable(node, humanName, false);
}

/**
 * stt_transcribe — speech → text via a configured OpenAI-compatible transcription endpoint
 * (POST /v1/audio/transcriptions). `audio` is a selector to a data URL / URL / base64 string,
 * sent as JSON { model?, audio, file }. Output: { text }.
 */
async function runSttTranscribe(ctx: FlowNodeContext): Promise<unknown> {
  const { node, scope } = ctx;
  const data = nodeData(node);
  const provider = await resolveNodeAiProvider(ctx, 'transcription');
  const endpoint = provider?.url ?? await resolveConfiguredEndpoint(ctx, '/v1/audio/transcriptions', 'speech-to-text');
  const audioRef = resolveSelector(data.audio, scope);
  const audio = typeof audioRef === 'string' ? audioRef : '';
  if (audio === '') throw new FlowExecError('invalid_flow', `Node '${node.id}' stt_transcribe needs 'audio' (a data URL / URL / base64)`, node.id);
  const body: Record<string, unknown> = { audio, file: audio };
  if (typeof data.model === 'string' && data.model !== '') body.model = data.model;
  else if (provider?.model) body.model = provider.model;
  const r = provider
    ? await providerFetchJson(ctx, provider, { method: 'POST', headers: provider.headers, body: JSON.stringify(body) }, 'speech-to-text')
    : await serviceFetchJson(ctx, endpoint, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'speech-to-text', false);
  const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : '';
  return { text };
}

/**
 * tts_speak — text → speech via a configured OpenAI-compatible endpoint (POST /v1/audio/speech,
 * body { model, voice, input }). Audio bytes → a data URL; a JSON {audioUrl|b64_json} response is
 * also accepted. Output: { audioUrl | dataUrl }.
 */
async function runTtsSpeak(ctx: FlowNodeContext): Promise<unknown> {
  const { node, scope } = ctx;
  const data = nodeData(node);
  const provider = await resolveNodeAiProvider(ctx, 'speech');
  const endpoint = provider?.url ?? await resolveConfiguredEndpoint(ctx, '/v1/audio/speech', 'text-to-speech');
  const input = interpolateTemplate(requireString(node, data, ['text', 'input']), scopeToContext(scope));
  const body: Record<string, unknown> = { input };
  if (typeof data.model === 'string' && data.model !== '') body.model = data.model;
  else if (provider?.model) body.model = provider.model;
  if (typeof data.voice === 'string' && data.voice !== '') body.voice = data.voice;

  const doFetch = ctx.deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(endpoint, { method: 'POST', headers: provider?.headers ?? JSON_HEADERS, body: JSON.stringify(body), signal: ctx.signal });
  } catch {
    if (provider) throw new FlowExecError('node_failed', `Node '${node.id}': text-to-speech provider '${provider.name}' unreachable`, node.id);
    throw desktopServiceUnavailable(node, 'text-to-speech', false);
  }
  if (!res.ok) {
    const target = provider ? `provider '${provider.name}'` : 'service';
    throw new FlowExecError('node_failed', appendProviderKeyBlockedHint(`Node '${node.id}': text-to-speech ${target} responded ${res.status}`, provider), node.id);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const url = typeof j.audioUrl === 'string' ? j.audioUrl : typeof j.url === 'string' ? j.url : typeof j.dataUrl === 'string' ? j.dataUrl : '';
    if (url !== '') return url.startsWith('data:') ? { audioUrl: url, dataUrl: url } : { audioUrl: url };
    const b64 = typeof j.b64_json === 'string' ? j.b64_json : typeof j.audio === 'string' ? j.audio : '';
    if (b64 !== '') {
      const dataUrl = `data:audio/mpeg;base64,${b64}`;
      return { audioUrl: dataUrl, dataUrl };
    }
    throw new FlowExecError('node_failed', `Node '${node.id}': text-to-speech response had no audio (expected audio bytes, audioUrl or b64_json)`, node.id);
  }
  const buffer = await res.arrayBuffer();
  const dataUrl = `data:${contentType || 'audio/mpeg'};base64,${arrayBufferToBase64(buffer)}`;
  return { audioUrl: dataUrl, dataUrl };
}

/**
 * Execute one node and return its output value. Throws FlowExecError (typed) or a plain
 * Error (wrapped by the executor into node_failed).
 */
export async function executeNode(ctx: FlowNodeContext): Promise<unknown> {
  const { node, deps } = ctx;
  const data = nodeData(node);

  switch (node.type) {
    case 'input':
      // The flow's resolved inputs enter the graph here.
      return { ...(ctx.scope.inputs as Record<string, unknown> | undefined ?? {}) };

    case 'output':
      // data.value (selector/literal) wins; otherwise pass the upstream value through.
      return data.value !== undefined ? resolveDeep(data.value, ctx.scope) : ctx.scope.upstream;

    case 'condition': {
      // A declared data.timeoutMs (100ms..30s, docs §4) becomes the sandbox's real
      // interrupt budget; when absent, evaluateBoolean's own default budget applies,
      // exactly as before. condition keeps its existing throw-on-error/timeout
      // behavior — only the ACTUAL budget used is now configurable.
      const expr = requireString(node, data, ['expr', 'expression', 'condition']);
      const budgetMs = clampDeclaredTimeoutMs(data);
      return await deps.evaluateBoolean(expr, exprContext(ctx), budgetMs);
    }

    case 'template': {
      const template = requireString(node, data, ['template', 'text']);
      return interpolateTemplate(template, scopeToContext(ctx.scope));
    }

    case 'logic_block': {
      // User code ALWAYS runs in the QuickJS sandbox (docs §4) with a frozen, JSON-only
      // ctx: {inputs, event, kv, app} (+ nodes/upstream for graph plumbing). `kv` is a
      // read snapshot of the node's KV scope — writes only happen via storage_set, which
      // is capability-gated. Wall clock is capped at 2s by default (data.timeoutMs
      // overrides within 100ms..30s) so a wedged evaluation can't stall the run budget.
      const expr = requireString(node, data, ['expr', 'code', 'expression']);
      let kv: Record<string, unknown> = {};
      if (deps.kvList) {
        try {
          kv = await deps.kvList(kvScopeFor(data, ctx));
        } catch {
          kv = {}; // a KV read failure degrades to an empty snapshot, never fails the node
        }
      }
      const frozenCtx = Object.freeze({ ...exprContext(ctx), kv });
      const timeoutMs = clampDeclaredTimeoutMs(data) ?? LOGIC_BLOCK_DEFAULT_TIMEOUT_MS;
      // Thread the SAME timeoutMs into the sandbox as its real interrupt budget
      // (previously the sandbox always used its own fixed 1s default regardless of
      // this value, so a script could be silently cut off well before — or run well
      // past — the node's declared deadline). evaluateExpression is now also
      // non-swallowing for the flow path: a timeout/error propagates as a rejection
      // instead of resolving to `null`, so withNodeTimeout's race and a sandbox
      // rejection both surface as a real flow failure, matching condition's behavior.
      return await withNodeTimeout(deps.evaluateExpression(expr, frozenCtx, timeoutMs), timeoutMs, node);
    }

    case 'llm_chat':
      return await runLlmChat(ctx);

    case 'http_request':
      return await runHttpRequest(ctx);

    case 'formlogic_list_responses': {
      // FROZEN CONTRACT (docs §4): fetch up to `limit` rows, normalize, apply ANDed filters
      // client-side, and return { responses, count, first, found }. Fails loudly on a missing form.
      const formId = resolveFormRef(node, data, ctx);
      const limit = clampListLimit(data.limit);
      // Server-side pushdown (audit AOK-FLOW-001): eq filters with scalar
      // resolved values become answers.<field> query params, so an exact
      // lookup is answered by the database — a match beyond the fetch limit
      // is never silently missed. Every filter still applies client-side
      // below (frozen contract unchanged); pushdown only changes WHICH rows
      // come back. Mirrors pushdown_eq_filters in the Rust runner.
      // Only STRING values push down (review sweep): the client-side filter
      // below uses loose (stringified) equality, but the server's json_extract
      // eq is stricter for non-string stored values, so pushing a number/bool
      // could fetch a narrower set the client filter can't rescue. Every eq
      // lookup in practice (call_id, phone) is a string; number/bool eq stays
      // fully client-side, identically to the Rust runner.
      const answersEq: Record<string, string> = {};
      for (const f of parseResponseFilters(data.filters)) {
        if (f.op !== 'eq' || !/^[A-Za-z0-9_]{1,64}$/.test(f.field)) continue;
        const resolved = resolveSelector(f.value, ctx.scope);
        if (typeof resolved === 'string') answersEq[f.field] = resolved;
      }
      const raw = await deps.listResponses(formId, Object.keys(answersEq).length > 0 ? { limit, answersEq } : { limit });
      const rows: FlowResponseRow[] = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        const row = normalizeResponseRow(item);
        if (row) rows.push(row);
      }
      const filters = parseResponseFilters(data.filters);
      const matched =
        filters.length === 0
          ? rows
          : rows.filter((row) =>
              filters.every((f) => matchesFilterOp(row.answers[f.field], f.op, resolveSelector(f.value, ctx.scope)))
            );
      const result: FlowListResponsesResult = {
        responses: matched,
        count: matched.length,
        first: matched.length > 0 ? matched[0] : null,
        found: matched.length > 0,
      };
      return result;
    }

    case 'formlogic_submit_response': {
      const formId = resolveFormRef(node, data, ctx);
      const answers = resolveDeep(data.answers, ctx.scope);
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new FlowExecError('node_failed', `Node '${node.id}' answers did not resolve to an object`, node.id);
      }
      return await deps.submitResponse(formId, answers as Record<string, unknown>);
    }

    case 'formlogic_update_response': {
      const formId = resolveFormRef(node, data, ctx);
      const responseId = resolveSelector(data.responseId, ctx.scope);
      if (typeof responseId !== 'string' || responseId === '') {
        throw new FlowExecError('node_failed', `Node '${node.id}' responseId did not resolve`, node.id);
      }
      const answers = resolveDeep(data.answers, ctx.scope);
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new FlowExecError('node_failed', `Node '${node.id}' answers did not resolve to an object`, node.id);
      }
      return await deps.updateResponse(formId, responseId, answers as Record<string, unknown>);
    }

    case 'connector_request': {
      const connectorId = requireString(node, data, ['connectorId', 'connector']);
      const command = requireString(node, data, ['command']);
      requireConnectorCapability(ctx, connectorId, command, node.id);
      const payload = data.payload !== undefined ? resolveDeep(data.payload, ctx.scope) : undefined;
      return await deps.connectorRequest(connectorId, command, payload);
    }

    case 'storage_get': {
      // Flow KV read (docs §9): {scope?, key} → the stored value (undefined when absent).
      if (!deps.kvGet) {
        throw new FlowExecError('runner_unavailable', `Node '${node.id}' storage_get: this runtime has no KV access`, node.id);
      }
      const key = resolveKvKey(node, data, ctx);
      return await deps.kvGet(kvScopeFor(data, ctx), key);
    }

    case 'storage_set': {
      // Flow KV write (docs §9): {scope?, key, value|valueFrom}. Writes are capability-
      // gated: the flow must declare 'formlogic.kv.write' in nodeCapabilities — the same
      // declare-then-grant model as connector/responses capabilities.
      if (!(ctx.capabilities ?? []).includes(KV_WRITE_CAPABILITY)) {
        throw new FlowExecError(
          'capability_denied',
          `Node '${node.id}' storage_set requires the '${KV_WRITE_CAPABILITY}' capability — add it to the flow's nodeCapabilities`,
          node.id
        );
      }
      if (!deps.kvSet) {
        throw new FlowExecError('runner_unavailable', `Node '${node.id}' storage_set: this runtime has no KV access`, node.id);
      }
      const key = resolveKvKey(node, data, ctx);
      const value = typeof data.valueFrom === 'string'
        ? resolveSelector(data.valueFrom, ctx.scope)
        : resolveDeep(data.value, ctx.scope);
      const scope = kvScopeFor(data, ctx);
      await deps.kvSet(scope, key, value ?? null);
      return { stored: true, scope, key };
    }

    case 'aokie_speak': {
      // Sugar for connector_request aokie call.operatorSpeak: {text|textFrom}. Routed
      // through the same requireConnectorCapability gate as connector_request — this is
      // still a connector dispatch under the hood, not a separate capability surface.
      requireConnectorCapability(ctx, 'aokie', 'call.operatorSpeak', node.id);
      let text: unknown;
      if (typeof data.textFrom === 'string') {
        text = resolveSelector(data.textFrom, ctx.scope);
      } else {
        text = interpolateTemplate(requireString(node, data, ['text', 'message']), scopeToContext(ctx.scope));
      }
      if (typeof text !== 'string' || text === '') {
        throw new FlowExecError('node_failed', `Node '${node.id}' aokie_speak text did not resolve to a string`, node.id);
      }
      // The aokie plugin's call.operatorSpeak requires the `text` field (and
      // rejects unknown fields), so send `text`, not `message`.
      return await deps.connectorRequest('aokie', 'call.operatorSpeak', { text });
    }

    // ── Desktop-service-backed nodes (docs §4) ──────────────────────────────────────────────
    case 'browser_action':
      return await runBrowserAction(ctx);

    case 'image_gen':
      return await runImageGen(ctx);

    case 'stt_transcribe':
      return await runSttTranscribe(ctx);

    case 'tts_speak':
      return await runTtsSpeak(ctx);

    default:
      // Docs §4: unsupported node types fail the run loudly, never silently.
      throw new FlowExecError(
        'invalid_flow',
        `Unsupported node type '${node.type}' (node '${node.id}')`,
        node.id
      );
  }
}
