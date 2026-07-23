// Site Chat engine (plan docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.4 + Phase 6):
// routes one chat turn through the user's configured AI source and normalizes tool
// activity/proposals for the widget.
//
// Sources (§5.6 preferences, resolved per turn — never a silent hop):
//   'site'    → POST /api/ai/chat {messages, stream:true, tools} — hosted loop, SSE
//               deltas + {type:'tool_call',…} events, allowance-metered server-side.
//   'desktop' → desktopTunnel.chatViaTunnel (E2E — content never touches the backend);
//               a 10-minute tool grant is minted per turn (POST /api/ai/chat-tool-grant)
//               and confirm-mode tool_proposal frames surface as approve/deny cards
//               answered via desktopTunnel.postInput ({type:'tool_approval',…}).
//   'custom'  → the browser-local AI-services registry. Tools are UNSUPPORTED there —
//               the reply carries an honest text-only note instead of fake activity.
//
// INTEGRATION NOTE (final pass): plan §5.1 puts toolMode/toolGrant inside the sealed
// tunnel body, but the Wave-1 desktopTunnel.ts public API builds only
// {v,kind,providerId,threadId,clientSeq,model?,messages?} and does not expose the
// in-flight request id. This module therefore (a) passes toolMode/toolGrant through a
// structurally-widened options object — a tunnel build that accepts them picks them up
// by name, today's build ignores them — and (b) resolves a proposal's postInput target
// from frame fields (requestId|request_id, falling back to callId). Reconcile in
// desktopTunnel.ts (owning scope): accept toolMode/toolGrant in ChatViaTunnelOptions
// and either expose the request id (e.g. onEnqueued) or set it on proposal frames.
import { api, type ChatToolGrant, type DesktopAiApiResponse } from '../../lib/api';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { logger } from '../../lib/logger';
import { generateId } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import {
  chatViaTunnel,
  postInput,
  type ChatViaTunnelOptions,
  type DesktopTunnelState,
} from '../../client-runtime/desktop/desktopTunnel';
import {
  getAiPreferences,
  type AiDefaultResult,
  type AiPreferences,
} from '../../client-runtime/flows/aiDefault';
import {
  extractByPath,
  renderRequestTemplate,
  resolveProviderRequest,
  type ResolvedAiProvider,
} from '../../client-runtime/flows/aiProviders';

export type ChatSource = 'site' | 'desktop' | 'custom';

export interface ChatEngineMessage {
  role: string;
  content: string;
}

export interface ChatTurnError {
  code: string;
  message: string;
}

export type ChatTurnOutcome =
  | { ok: true; source: ChatSource; content: string; note?: string }
  | { ok: false; source: ChatSource | null; error: ChatTurnError };

/** One tool action rendered inline in the transcript (both sources normalize to this). */
export interface ChatToolActivity {
  id: string;
  name: string;
  /** Raw status word from the wire ('running' | 'done' | 'failed' | …). */
  status: string;
  detail?: string;
  error?: string;
  /** Deep-link target when the tool result names a created/updated record. */
  link?: { kind: 'form' | 'app' | 'flow' | 'response'; id: string };
}

/** A confirm-mode tool proposal awaiting the user's decision (desktop source). */
export interface ChatToolProposal {
  callId: string;
  /** postInput target — resolved from the proposal frame (see header integration note). */
  requestId: string;
  tool: string;
  input: unknown;
  status: 'pending' | 'approved' | 'denied' | 'failed';
  error?: string;
}

export interface ChatTurnEvents {
  onDelta?: (delta: string, accumulated: string) => void;
  onState?: (state: DesktopTunnelState) => void;
  onToolActivity?: (activity: ChatToolActivity) => void;
  onToolProposal?: (proposal: ChatToolProposal) => void;
}

export interface SendChatTurnOptions {
  threadId: string;
  /** Conversation for the model (oldest-first, INCLUDING the new user message). */
  messages: ChatEngineMessage[];
  /** §11B O5a: the page the user is on — appended as a system hint so "this form"
   *  resolves without asking. The TOOLS stay the authority on ownership. */
  pageContext?: { kind: 'form' | 'app' | 'diagram'; id: string } | null;
  /** Demo account: chat works, tool actions are disabled (banner + tools:false). */
  isDemo?: boolean;
  signal?: AbortSignal;
  events?: ChatTurnEvents;
  /** Per-thread client sequence for the tunnel request (defaults to 1). */
  clientSeq?: number;
}

// ---------------------------------------------------------------------------
// Injectable seams (tests + the widget's production defaults).
// ---------------------------------------------------------------------------

export interface ChatEngineDeps {
  fetchPreferences?: () => Promise<AiDefaultResult<AiPreferences>>;
  mintToolGrant?: (instanceId?: string) => Promise<DesktopAiApiResponse<ChatToolGrant>>;
  tunnelChat?: typeof chatViaTunnel;
  postInputFn?: typeof postInput;
  fetchFn?: typeof fetch;
  resolveCustomProvider?: (providerId: string) => Promise<ResolvedAiProvider | null>;
  apiBase?: (endpoint: string) => string;
  csrfToken?: () => string | null;
}

/** Plan §5.1 sealed-body fields the current tunnel build does not carry yet (header note). */
interface TunnelToolOptions {
  toolMode?: 'auto' | 'confirm';
  toolGrant?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Tool activity + proposal normalization (shared by the site SSE and tunnel frames).
// ---------------------------------------------------------------------------

const TOOL_ACTIVITY_TYPES = new Set(['tool_call', 'tool_result', 'tool_executed']);

/** Recursively (bounded) hunt a tool result for a deep-linkable record id. */
function toolLinkFromResult(toolName: string, result: unknown): ChatToolActivity['link'] | null {
  const seen: unknown[] = [result];
  for (let depth = 0; depth < 4; depth += 1) {
    const current = seen.shift();
    if (current === undefined || current === null) return null;
    if (Array.isArray(current)) {
      seen.push(...current.slice(0, 8));
      continue;
    }
    const rec = asRecord(current);
    if (!rec) continue;
    const formId = firstString(rec.formId, rec.form_id);
    if (formId) return { kind: 'form', id: formId };
    const appId = firstString(rec.appId, rec.app_id);
    if (appId) return { kind: 'app', id: appId };
    const flowId = firstString(rec.flowId, rec.flow_id);
    if (flowId) return { kind: 'flow', id: flowId };
    const responseId = firstString(rec.responseId, rec.response_id);
    if (responseId) return { kind: 'response', id: responseId };
    const bareId = firstString(rec.id);
    if (bareId) {
      if (toolName.includes('form')) return { kind: 'form', id: bareId };
      if (toolName.includes('app')) return { kind: 'app', id: bareId };
      if (toolName.includes('flow')) return { kind: 'flow', id: bareId };
    }
    seen.push(...Object.values(rec).slice(0, 12));
  }
  return null;
}

/** Normalize a wire object to tool activity, or null when it is not one. */
export function normalizeToolActivity(raw: Record<string, unknown>): ChatToolActivity | null {
  const type = firstString(raw.type, raw.kind);
  if (!type || !TOOL_ACTIVITY_TYPES.has(type)) return null;
  const name = firstString(raw.name, raw.tool);
  if (!name) return null;
  const status = firstString(raw.status) ?? 'running';
  const error = firstString(raw.error) ?? (status === 'failed' ? firstString(raw.message, raw.code) : undefined);
  const link = toolLinkFromResult(name, raw.result ?? raw.output);
  return {
    id: firstString(raw.id, raw.callId) ?? generateId(),
    name,
    status,
    ...(firstString(raw.detail, raw.message) && status !== 'failed' ? { detail: firstString(raw.detail, raw.message) } : {}),
    ...(error ? { error } : {}),
    ...(link ? { link } : {}),
  };
}

/** Normalize a wire object to a confirm-mode tool proposal, or null when it is not one. */
export function normalizeToolProposal(raw: Record<string, unknown>): ChatToolProposal | null {
  if (firstString(raw.type, raw.kind) !== 'tool_proposal') return null;
  const callId = firstString(raw.callId, raw.call_id, raw.id);
  if (!callId) return null;
  return {
    callId,
    // postInput targets the relay REQUEST id; proposal frames should carry it, and the
    // callId is the documented fallback (header integration note).
    requestId: firstString(raw.requestId, raw.request_id) ?? callId,
    tool: firstString(raw.tool, raw.name) ?? 'tool',
    input: raw.input ?? raw.arguments ?? null,
    status: 'pending',
  };
}

/**
 * Answer a confirm-mode proposal: postInput seals {v:1, type:'tool_approval', callId,
 * approved} to the in-flight request (the desktop polls this channel while paused and
 * auto-denies after 120s, plan §5.4).
 */
export async function answerToolProposal(
  proposal: ChatToolProposal,
  approved: boolean,
  deps: ChatEngineDeps = {}
): Promise<{ ok: boolean; error?: string }> {
  const post = deps.postInputFn ?? postInput;
  const res = await post(proposal.requestId, { type: 'tool_approval', callId: proposal.callId, approved });
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.error.code === 'session_unknown'
          ? 'This proposal is no longer answerable — the request already completed.'
          : res.error.message,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Hosted Site AI SSE parser (pure + incremental so tests can drive it directly).
// Wire shape (backend AIController::emitChatStream + the Phase-6 tool loop):
//   event: delta  data: {"content":"…"}
//                     data: {"type":"tool_call","name":"create_form","status":"done",…}
//   event: done   data: {"usage":{…}}
//   event: error  data: {"message":"…"}
//   event: end    data: {}
// ---------------------------------------------------------------------------

export interface SiteChatSseSink {
  onDelta?: (delta: string, accumulated: string) => void;
  onToolActivity?: (activity: ChatToolActivity) => void;
  onDone?: (info: { usage?: unknown; content?: string }) => void;
  onError?: (error: ChatTurnError) => void;
}

export function createSiteChatSseParser(sink: SiteChatSseSink): { push(chunk: string): void; end(): void } {
  let buffer = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let accumulated = '';

  const dispatch = (event: string | null, data: string): void => {
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      if (event === 'error') sink.onError?.({ code: 'request_failed', message: data || 'The AI request failed.' });
      return;
    }
    const obj = asRecord(parsed);
    if (!obj) return;
    const type = firstString(obj.type);

    if (type && TOOL_ACTIVITY_TYPES.has(type)) {
      const activity = normalizeToolActivity(obj);
      if (activity) sink.onToolActivity?.(activity);
      return;
    }
    if (event === 'error' || type === 'error') {
      sink.onError?.({
        code: firstString(obj.code) ?? 'request_failed',
        message: firstString(obj.message) ?? 'The AI request failed.',
      });
      return;
    }
    if (event === 'done' || type === 'done') {
      sink.onDone?.({
        ...(obj.usage !== undefined ? { usage: obj.usage } : {}),
        ...(typeof obj.content === 'string' ? { content: obj.content } : {}),
      });
      return;
    }
    if (event === 'end') return;
    const delta = typeof obj.content === 'string' ? obj.content : type === 'delta' ? firstString(obj.text, obj.delta) : undefined;
    if (delta) {
      accumulated += delta;
      sink.onDelta?.(delta, accumulated);
    }
  };

  const processLine = (line: string): void => {
    if (line === '') {
      const data = dataLines.join('\n');
      dataLines = [];
      const event = eventName;
      eventName = null;
      dispatch(event, data);
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim() || null;
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // ':' keepalive comments + retry:/id: lines need no handling.
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
    },
    end(): void {
      if (buffer !== '') processLine(buffer.replace(/\r$/, ''));
      buffer = '';
      if (dataLines.length > 0 || eventName !== null) {
        const data = dataLines.join('\n');
        dataLines = [];
        const event = eventName;
        eventName = null;
        dispatch(event, data);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Source runners.
// ---------------------------------------------------------------------------

async function runSiteSource(
  opts: SendChatTurnOptions,
  deps: ChatEngineDeps
): Promise<ChatTurnOutcome> {
  const doFetch = deps.fetchFn ?? fetch;
  const base = deps.apiBase ?? resolveBackendApiUrl;
  const csrf = (deps.csrfToken ?? readCsrfToken)();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (csrf) headers['X-CSRF-Token'] = csrf;

  let res: Response;
  try {
    res = await doFetch(base('/ai/chat'), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ messages: opts.messages, stream: true, tools: !opts.isDemo }),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return {
      ok: false,
      source: 'site',
      error: { code: 'transport', message: e instanceof Error ? e.message : 'Network error' },
    };
  }

  if (!res.ok || !res.body) {
    let code = 'request_failed';
    let message = `The Site AI request failed (${res.status}).`;
    try {
      const body = asRecord(await res.json());
      code = firstString(body?.code) ?? code;
      message = firstString(body?.message) ?? message;
    } catch {
      /* keep the status-derived message */
    }
    if (res.status === 401) {
      return { ok: false, source: 'site', error: { code: 'auth_required', message: 'Sign in again to use Site AI.' } };
    }
    return { ok: false, source: 'site', error: { code, message } };
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // Tolerant fallback: a non-streaming build answers plain JSON {data:{content}}.
    try {
      const body = asRecord(await res.json());
      const data = asRecord(body?.data) ?? body;
      const content = data?.content;
      if (typeof content === 'string') return { ok: true, source: 'site', content };
    } catch {
      /* fall through to the honest failure */
    }
    return { ok: false, source: 'site', error: { code: 'request_failed', message: 'Site AI returned no content.' } };
  }

  opts.events?.onState?.({ state: 'streaming' });
  let failed: ChatTurnError | null = null;
  let finalContent: string | undefined;
  let accumulated = '';
  const parser = createSiteChatSseParser({
    onDelta: (delta, acc) => {
      accumulated = acc;
      opts.events?.onDelta?.(delta, acc);
    },
    onToolActivity: (activity) => opts.events?.onToolActivity?.(activity),
    onDone: (info) => {
      if (info.content !== undefined) finalContent = info.content;
    },
    onError: (error) => {
      failed = error;
    },
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return {
      ok: false,
      source: 'site',
      error: { code: 'transport', message: e instanceof Error ? e.message : 'The stream dropped mid-reply.' },
    };
  } finally {
    reader.releaseLock();
  }

  if (failed) {
    const err = failed as ChatTurnError;
    opts.events?.onState?.({ state: 'failed', code: err.code, message: err.message });
    return { ok: false, source: 'site', error: err };
  }
  opts.events?.onState?.({ state: 'done' });
  return { ok: true, source: 'site', content: finalContent ?? accumulated };
}

async function runDesktopSource(
  prefs: AiPreferences,
  opts: SendChatTurnOptions,
  deps: ChatEngineDeps
): Promise<ChatTurnOutcome> {
  const providerId = prefs.desktopProviderId?.trim() ?? '';
  if (!providerId) {
    return {
      ok: false,
      source: 'desktop',
      error: {
        code: 'ai_default_unresolved',
        message: 'Settings → AI names FormLogic Desktop as the default but no Desktop provider is chosen — pick one in Settings → AI.',
      },
    };
  }

  const toolMode: 'auto' | 'confirm' = prefs.chatToolMode === 'confirm' ? 'confirm' : 'auto';
  let toolGrant: string | undefined;
  let note: string | undefined;
  if (opts.isDemo) {
    note = 'Tool actions are disabled in the demo.';
  } else {
    // One 10-minute grant per turn (plan §5.4); a mint failure never blocks the reply —
    // the turn goes out without record actions and says so.
    const mint = deps.mintToolGrant ?? ((instanceId?: string) => api.mintChatToolGrant(instanceId));
    const grant = await mint();
    if (grant.data?.grantToken) {
      toolGrant = grant.data.grantToken;
    } else {
      note = `Record actions are unavailable this turn — the tool grant could not be minted (${grant.error ?? 'unknown error'}).`;
    }
  }

  const tunnel = deps.tunnelChat ?? chatViaTunnel;
  const tunnelOptions: ChatViaTunnelOptions & TunnelToolOptions = {
    providerId,
    model: prefs.desktopModel?.trim() || undefined,
    threadId: opts.threadId,
    messages: opts.messages,
    clientSeq: opts.clientSeq ?? 1,
    signal: opts.signal,
    onDelta: opts.events?.onDelta,
    onState: opts.events?.onState,
    onFrame: (frame) => {
      const proposal = normalizeToolProposal(frame);
      if (proposal) {
        opts.events?.onToolProposal?.(proposal);
        return;
      }
      const activity = normalizeToolActivity(frame);
      if (activity) opts.events?.onToolActivity?.(activity);
      // delta/state/done frames are consumed by the tunnel client itself.
    },
    toolMode,
    ...(toolGrant ? { toolGrant } : {}),
  };
  const res = await tunnel(tunnelOptions);
  if (!res.ok) {
    return { ok: false, source: 'desktop', error: { code: res.error.code, message: res.error.message } };
  }
  return { ok: true, source: 'desktop', content: res.data.finalText, ...(note ? { note } : {}) };
}

async function runCustomSource(
  prefs: AiPreferences,
  opts: SendChatTurnOptions,
  deps: ChatEngineDeps
): Promise<ChatTurnOutcome> {
  const NOTE = 'Tools aren’t supported on the Custom source — this reply is text-only.';
  const providerId = prefs.customProviderId?.trim() ?? '';
  if (!providerId) {
    return {
      ok: false,
      source: 'custom',
      error: {
        code: 'ai_default_unresolved',
        message: 'Settings → AI names a custom AI service as the default but none is chosen — pick one in Settings → AI.',
      },
    };
  }
  const resolveProvider =
    deps.resolveCustomProvider ??
    ((id: string) => resolveProviderRequest(useAuthStore.getState().user?.id, 'chat', id));
  const provider = await resolveProvider(providerId);
  if (!provider) {
    return {
      ok: false,
      source: 'custom',
      error: {
        code: 'ai_default_unresolved',
        message:
          `The default AI service '${providerId}' is not configured in this browser ` +
          '(custom AI services are stored per browser) — open Settings → AI here and re-choose the default.',
      },
    };
  }

  const { messages } = opts;
  const system = messages.find((m) => m.role === 'system')?.content;
  const prompt = [...messages].reverse().find((m) => m.role === 'user')?.content;
  const requestBody = provider.requestTemplate
    ? renderRequestTemplate(provider.requestTemplate, {
        model: provider.model,
        prompt,
        system,
        messages,
        apiKey: provider.apiKey,
      })
    : { messages, ...(provider.model ? { model: provider.model } : {}) };

  const doFetch = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(provider.url, {
      method: 'POST',
      headers: provider.headers,
      body: JSON.stringify(requestBody),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return {
      ok: false,
      source: 'custom',
      error: {
        code: 'transport',
        message: `Default AI service '${provider.name}' is unreachable: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  if (!res.ok) {
    const keyHint = provider.keyBlocked
      ? ' The saved API key was not sent because the provider uses unencrypted HTTP on a non-loopback host.'
      : '';
    return {
      ok: false,
      source: 'custom',
      error: { code: 'request_failed', message: `Default AI service '${provider.name}' responded ${res.status}.${keyHint}` },
    };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, source: 'custom', error: { code: 'request_failed', message: `Default AI service '${provider.name}' returned a non-JSON body.` } };
  }
  const content = extractByPath(payload, provider.responsePath ?? 'choices.0.message.content');
  if (typeof content !== 'string') {
    return { ok: false, source: 'custom', error: { code: 'request_failed', message: `Default AI service '${provider.name}' returned no text.` } };
  }
  return { ok: true, source: 'custom', content, note: NOTE };
}

// ---------------------------------------------------------------------------
// sendChatTurn — resolve the source from preferences, run exactly one source.
// ---------------------------------------------------------------------------

export async function sendChatTurn(opts: SendChatTurnOptions, deps: ChatEngineDeps = {}): Promise<ChatTurnOutcome> {
  // Page context rides the message list as a trailing system hint — identical for all
  // three sources, so "this form" means the same thing everywhere.
  if (opts.pageContext && /^[A-Za-z0-9-]{1,64}$/.test(opts.pageContext.id)) {
    const { kind, id } = opts.pageContext;
    opts = {
      ...opts,
      messages: [
        ...opts.messages,
        {
          role: 'system',
          content: `Page context: the user is currently viewing ${kind} with id ${id}. When they say "this ${kind}" or ask for changes without naming a target, use this id with your tools.`,
        },
      ],
    };
  }
  const fetchPreferences = deps.fetchPreferences ?? (() => getAiPreferences());
  let prefsRes: AiDefaultResult<AiPreferences>;
  try {
    prefsRes = await fetchPreferences();
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    logger.warn('[chat-engine] preferences fetch threw:', e);
    return {
      ok: false,
      source: null,
      error: {
        code: 'ai_default_unresolved',
        message: `Could not load your AI settings (${e instanceof Error ? e.message : String(e)}) — open Settings → AI and choose a default source.`,
      },
    };
  }
  if (!prefsRes.ok) {
    return {
      ok: false,
      source: null,
      error: { code: prefsRes.error.code, message: prefsRes.error.message },
    };
  }
  const prefs = prefsRes.data;

  switch (prefs.aiSource) {
    case 'site':
      return runSiteSource(opts, deps);
    case 'desktop':
      return runDesktopSource(prefs, opts, deps);
    case 'custom':
      return runCustomSource(prefs, opts, deps);
  }
}
