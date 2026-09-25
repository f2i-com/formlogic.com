// Flows "Default (from Settings)" AI alias — browser-runner half (plan
// docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.6 + Phase 4).
//
// When a flow's llm_chat node has no explicit provider (absent/'default'), the browser
// runner resolves the ACTING USER's AI settings and runs the turn through exactly one
// source:
//   'site'    → POST /api/ai/chat (hosted, allowance-metered server-side)
//   'desktop' → the E2E tunnel (desktopTunnel.chatViaTunnel) with the settings'
//               provider + model — content never touches the backend
//   'custom'  → the browser-local AI-services registry (aiProviders.resolveProviderRequest)
//
// NO SILENT FALLBACK (§5.6): an unresolvable or failing source produces a typed error —
// never a hop to a different source. Preferences are cached for 60s (keyed by user id)
// so a flow run doesn't refetch them per node.
//
// Integration note: lib/api is owned by another scope and its `getAiPreferences`/AI-chat
// methods land concurrently. This module prefers them when present (duck-typed) and
// otherwise talks to the SAME contract routes directly (GET /api/ai/preferences,
// POST /api/ai/chat) with the lib/api conventions (cookies + CSRF header). The final
// pass can delete the fallback once the api methods exist everywhere.
import { api } from '../../lib/api';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { logger } from '../../lib/logger';
import { useAuthStore } from '../../stores/authStore';
import {
  chatViaTunnel,
  type DesktopTunnelState,
} from '../desktop/desktopTunnel';
import {
  extractByPath,
  renderRequestTemplate,
  resolveProviderRequest,
  type ResolvedAiProvider,
} from './aiProviders';
import {
  EDITOR_AI_TOOLS_VERSION,
  editorToolCall,
  editorUsage,
  fromOpenAiChatCompletion,
  toOpenAiChatMessages,
  toOpenAiTools,
  type EditorAiReply,
  type EditorAiToolRequest,
} from './aiToolCalls';

// ---------------------------------------------------------------------------
// Types (contract: GET /api/ai/preferences, POST /api/ai/chat).
// ---------------------------------------------------------------------------

export type AiSource = 'site' | 'desktop' | 'custom';

/** The acting user's AI preferences (GET /api/ai/preferences → {data: …}). */
export interface AiPreferences {
  aiSource: AiSource;
  desktopProviderId: string | null;
  desktopModel: string | null;
  customProviderId: string | null;
  chatToolMode: 'auto' | 'confirm' | null;
  /** Default reasoning effort for the Codex/ChatGPT desktop connector (null = provider default). */
  desktopReasoning?: string | null;
}

/**
 * Typed failure codes for the default-AI lane. `ai_default_unresolved` = no usable
 * preferences/source configuration; `ai_allowance_exceeded` passes through from the
 * hosted Site AI route; Desktop-tunnel codes (§5.8) pass through verbatim. Open-ended
 * for forward compatibility, mirroring DesktopTunnelErrorCode.
 */
export type AiDefaultErrorCode =
  | 'ai_default_unresolved'
  | 'ai_allowance_exceeded'
  | 'auth_required'
  | 'transport'
  | 'request_failed'
  | (string & {});

export interface AiDefaultError {
  code: AiDefaultErrorCode;
  message: string;
  /** HTTP status when the failure came from a backend route. */
  status?: number;
}

export type AiDefaultResult<T> = { ok: true; data: T } | { ok: false; error: AiDefaultError };

export interface AiDefaultChatMessage {
  role: string;
  content: string;
}

export interface DefaultLlmSuccess {
  source: AiSource;
  content: string;
  /** Hosted-usage payload (site source only), passed through for observability. */
  usage?: unknown;
  /** Tunnel thread id (desktop source only). */
  threadId?: string;
}

export type DefaultLlmOutcome = AiDefaultResult<DefaultLlmSuccess>;

function failure<T>(error: AiDefaultError): AiDefaultResult<T> {
  return { ok: false, error };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// Preferences fetch + 60s cache.
// ---------------------------------------------------------------------------

const PREFS_CACHE_TTL_MS = 60_000;

let prefsCache: { userId: string | null; at: number; prefs: AiPreferences } | null = null;

/** Drop the cached preferences (e.g. after the user saves Settings → AI). */
export function invalidateAiPreferencesCache(): void {
  prefsCache = null;
}

interface RawFetchOutcome {
  ok: boolean;
  status: number;
  /** Parsed `data` member of the standard envelope (or the whole body). */
  data: unknown;
  code?: string;
  message?: string;
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Minimal contract fetch mirroring lib/api's conventions (HttpOnly cookie auth, CSRF
 * header on writes, typed `code` preserved from the standard error envelope). Used
 * only until lib/api grows its own preferences/AI-chat methods.
 */
async function contractFetch(method: 'GET' | 'POST', endpoint: string, body?: unknown, signal?: AbortSignal): Promise<RawFetchOutcome> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (method !== 'GET') {
    const csrf = readCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(resolveBackendApiUrl(endpoint), {
      method,
      headers,
      credentials: 'include',
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, data: null, message: e instanceof Error ? e.message : 'Network error' };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const rec = asRecord(parsed);
  return {
    ok: res.ok,
    status: res.status,
    data: rec && 'data' in rec ? rec.data : parsed,
    code: typeof rec?.code === 'string' ? rec.code : undefined,
    message: typeof rec?.message === 'string' ? rec.message : undefined,
  };
}

/** lib/api response shapes this module can consume once the Site-AI scope lands them. */
interface PrefsApiLike {
  getAiPreferences?: () => Promise<{ data?: unknown; error?: string; status?: number; code?: string }>;
  aiChat?: (body: { messages: AiDefaultChatMessage[]; stream: false }) => Promise<{
    data?: unknown;
    error?: string;
    status?: number;
    code?: string;
  }>;
}

function apiLike(): PrefsApiLike {
  return api as unknown as PrefsApiLike;
}

function parsePreferences(raw: unknown): AiPreferences | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const source = rec.aiSource;
  if (source !== 'site' && source !== 'desktop' && source !== 'custom') return null;
  return {
    aiSource: source,
    desktopProviderId: stringOrNull(rec.desktopProviderId),
    desktopModel: stringOrNull(rec.desktopModel),
    customProviderId: stringOrNull(rec.customProviderId),
    chatToolMode: rec.chatToolMode === 'auto' || rec.chatToolMode === 'confirm' ? rec.chatToolMode : null,
    desktopReasoning: stringOrNull(rec.desktopReasoning),
  };
}

type PrefsFetcher = () => Promise<AiDefaultResult<AiPreferences>>;

async function fetchAiPreferencesUncached(): Promise<AiDefaultResult<AiPreferences>> {
  // Prefer the lib/api method when it exists (acting-mode routing + CSRF come with it);
  // the direct contract fetch is the interim path until that lands.
  const apiMethod = apiLike().getAiPreferences;
  let status: number | undefined;
  let code: string | undefined;
  let message: string | undefined;
  let data: unknown;
  if (typeof apiMethod === 'function') {
    const res = await apiMethod.call(api);
    if (res.error !== undefined) {
      status = res.status;
      code = res.code;
      message = res.error;
    } else {
      data = res.data;
    }
  } else {
    const res = await contractFetch('GET', '/ai/preferences');
    status = res.status || undefined;
    code = res.code;
    message = res.message;
    if (res.ok) data = res.data;
  }
  if (data !== undefined) {
    const prefs = parsePreferences(data);
    if (prefs) return { ok: true, data: prefs };
    return failure({
      code: 'ai_default_unresolved',
      message: 'The AI preferences response was not understood — open Settings → AI and save your default AI source.',
      status,
    });
  }
  if (status === 401) {
    return failure({ code: 'auth_required', message: 'Sign in again to load your AI settings.', status });
  }
  return failure({
    code: status === undefined ? 'transport' : code ?? 'request_failed',
    message: message ?? 'Could not load your AI settings.',
    status,
  });
}

// Test seam (mirrors desktopTunnel's __resetDesktopTunnelForTests): lets suites stub
// the raw preferences fetch without touching the network or lib/api.
let prefsFetcherForTests: PrefsFetcher | null = null;

/** Test-only: replace the underlying preferences fetch (null restores the real one). */
export function __setAiPreferencesFetcherForTests(fetcher: PrefsFetcher | null): void {
  prefsFetcherForTests = fetcher;
}

/** Test-only: drop the cache AND any stubbed fetcher. */
export function __resetAiDefaultForTests(): void {
  prefsCache = null;
  prefsFetcherForTests = null;
}

/**
 * The acting user's AI preferences, cached for 60s (keyed by the signed-in user id so
 * an account switch never inherits the previous user's source). Fetch failures are
 * typed and never cached.
 */
export async function getAiPreferences(options: { fresh?: boolean } = {}): Promise<AiDefaultResult<AiPreferences>> {
  const userId = useAuthStore.getState().user?.id ?? null;
  if (!options.fresh && prefsCache && prefsCache.userId === userId && Date.now() - prefsCache.at < PREFS_CACHE_TTL_MS) {
    return { ok: true, data: prefsCache.prefs };
  }
  const fetcher = prefsFetcherForTests ?? fetchAiPreferencesUncached;
  const res = await fetcher();
  if (res.ok) {
    prefsCache = { userId, at: Date.now(), prefs: res.data };
  }
  return res;
}

// ---------------------------------------------------------------------------
// getAiReadiness — the ONE source-specific readiness resolver (audit FL-23).
// ---------------------------------------------------------------------------

export interface AiReadiness {
  ready: boolean;
  /** Why not ready — mirrors the execution-time refusal, so invites never over-promise. */
  reason?: string;
  prefs?: AiPreferences;
}

/** A desktop connection heartbeated inside this window counts as online (mirrors ROUTE-001's 90s + margin). */
const DESKTOP_FRESH_MS = 120_000;

/**
 * Source-specific readiness (audit FL-23): "preferences loaded" is NOT "AI can run".
 * This validates exactly what execution validates later — a chosen Desktop provider
 * for 'desktop' (plus a recently-seen desktop when the connections API answers), a
 * locally-configured provider for 'custom' — so surfaces that INVITE a prompt
 * (Dashboard CreateBand) agree with what execution will accept. Lives in this module
 * so the checks can never drift from runCustomSource / the desktop lane.
 */
export async function getAiReadiness(options: { fresh?: boolean } = {}): Promise<AiReadiness> {
  const res = await getAiPreferences(options);
  if (!res.ok) return { ready: false, reason: res.error.message };
  const prefs = res.data;
  switch (prefs.aiSource) {
    case 'site':
      return { ready: true, prefs };
    case 'desktop': {
      if (!prefs.desktopProviderId?.trim()) {
        return {
          ready: false,
          prefs,
          reason: 'FormLogic Desktop is the default AI but no Desktop provider is chosen — pick one in Settings → AI.',
        };
      }
      // Liveness is best-effort: a definitive "no desktop has been seen recently"
      // is a real not-ready; a failed connections lookup stays configuration-only
      // (never hide the surface on a transient API blip).
      try {
        const connections = await api.getDesktopConnections();
        if (!connections.error && connections.data) {
          const fresh = connections.data.connections.some((c) => {
            if (!c.lastSeenAt) return false;
            // Zone-less API timestamps are UTC — anchor them before comparing.
            const seen = Date.parse(c.lastSeenAt.endsWith('Z') || c.lastSeenAt.includes('+') ? c.lastSeenAt : c.lastSeenAt.replace(' ', 'T') + 'Z');
            return Number.isFinite(seen) && Date.now() - seen < DESKTOP_FRESH_MS;
          });
          if (!fresh) {
            return {
              ready: false,
              prefs,
              reason: 'FormLogic Desktop is the default AI but no linked desktop is online right now.',
            };
          }
        }
      } catch {
        // connections lookup unavailable — fall through to configuration readiness
      }
      return { ready: true, prefs };
    }
    case 'custom': {
      const providerId = prefs.customProviderId?.trim() ?? '';
      if (!providerId) {
        return {
          ready: false,
          prefs,
          reason: 'A custom AI service is the default but none is chosen — pick one in Settings → AI.',
        };
      }
      const provider = await resolveProviderRequest(useAuthStore.getState().user?.id, 'chat', providerId);
      if (!provider) {
        return {
          ready: false,
          prefs,
          reason: `The default AI service '${providerId}' is not configured in this browser — custom AI services are stored per browser.`,
        };
      }
      return { ready: true, prefs };
    }
  }
}

/** Short human label for the resolved default source, shown beside the picker's "Default" option. */
export function defaultSourceLabel(prefs: AiPreferences, customProviderName?: string | null): string {
  switch (prefs.aiSource) {
    case 'site':
      return 'Site AI';
    case 'desktop':
      return prefs.desktopProviderId ? `Desktop — ${prefs.desktopProviderId}` : 'Desktop (no provider chosen)';
    case 'custom': {
      const name = customProviderName ?? prefs.customProviderId;
      return name ? `Custom — ${name}` : 'Custom (no service chosen)';
    }
  }
}

// ---------------------------------------------------------------------------
// resolveDefaultLlm — run one chat turn through the settings-chosen source.
// ---------------------------------------------------------------------------

export interface ResolveDefaultLlmOptions {
  messages: AiDefaultChatMessage[];
  signal?: AbortSignal;
  /** Streaming deltas (desktop source only — site/custom answer non-streaming in v1). */
  onDelta?: (delta: string, accumulated: string) => void;
  onState?: (state: DesktopTunnelState) => void;
}

/** Injectable seams (tests + runtimes with their own wiring); production uses the defaults. */
export interface ResolveDefaultLlmDeps {
  fetchPreferences?: PrefsFetcher;
  siteChat?: (messages: AiDefaultChatMessage[], signal?: AbortSignal) => Promise<AiDefaultResult<{ content: string; usage?: unknown }>>;
  tunnelChat?: typeof chatViaTunnel;
  resolveCustomProvider?: (providerId: string) => Promise<ResolvedAiProvider | null>;
  fetchFn?: typeof fetch;
}

interface SiteChatBody {
  content: string;
  usage?: unknown;
}

/** Hosted Site AI: POST /api/ai/chat {messages, stream:false} → {data:{content, usage?}}. */
async function defaultSiteChat(
  messages: AiDefaultChatMessage[],
  signal?: AbortSignal
): Promise<AiDefaultResult<SiteChatBody>> {
  const apiMethod = apiLike().aiChat;
  let status: number | undefined;
  let code: string | undefined;
  let message: string | undefined;
  let data: unknown;
  if (typeof apiMethod === 'function') {
    const res = await apiMethod.call(api, { messages, stream: false });
    if (res.error !== undefined) {
      status = res.status;
      code = res.code;
      message = res.error;
    } else {
      data = res.data;
    }
  } else {
    const res = await contractFetch('POST', '/ai/chat', { messages, stream: false }, signal);
    status = res.status || undefined;
    code = res.code;
    message = res.message;
    if (res.ok) data = res.data;
  }
  if (data !== undefined) {
    const rec = asRecord(data);
    const content = rec?.content;
    if (rec && typeof content === 'string') {
      return { ok: true, data: { content, ...(rec.usage !== undefined ? { usage: rec.usage } : {}) } };
    }
    return failure({ code: 'request_failed', message: 'Site AI returned no content.', status });
  }
  if (status === 401) {
    return failure({ code: 'auth_required', message: 'Sign in again to use Site AI.', status });
  }
  return failure({
    code: status === undefined ? 'transport' : code ?? 'request_failed',
    message: message ?? 'The Site AI request failed.',
    status,
  });
}

async function runCustomSource(
  prefs: AiPreferences,
  opts: ResolveDefaultLlmOptions,
  deps: ResolveDefaultLlmDeps
): Promise<DefaultLlmOutcome> {
  const providerId = prefs.customProviderId?.trim() ?? '';
  if (!providerId) {
    return failure({
      code: 'ai_default_unresolved',
      message: 'Settings → AI names a custom AI service as the default but none is chosen — pick one in Settings → AI.',
    });
  }
  const resolveProvider =
    deps.resolveCustomProvider ??
    ((id: string) => resolveProviderRequest(useAuthStore.getState().user?.id, 'chat', id));
  const provider = await resolveProvider(providerId);
  if (!provider) {
    // §5.6 v1 caveat: custom provider definitions live in ONE browser's localStorage —
    // anywhere else the source is honestly unresolvable, never silently hosted.
    return failure({
      code: 'ai_default_unresolved',
      message:
        `The default AI service '${providerId}' is not configured in this browser ` +
        '(custom AI services are stored per browser) — open Settings → AI here and re-choose the default.',
    });
  }

  const messages = opts.messages;
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
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return failure({
      code: 'transport',
      message: `Default AI service '${provider.name}' is unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!res.ok) {
    const keyHint = provider.keyBlocked
      ? ' The saved API key was not sent because the provider uses unencrypted HTTP on a non-loopback host.'
      : '';
    return failure({
      code: 'request_failed',
      message: `Default AI service '${provider.name}' responded ${res.status}.${keyHint}`,
      status: res.status,
    });
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return failure({ code: 'request_failed', message: `Default AI service '${provider.name}' returned a non-JSON body.`, status: res.status });
  }
  const content = extractByPath(payload, provider.responsePath ?? 'choices.0.message.content');
  if (typeof content !== 'string') {
    return failure({ code: 'request_failed', message: `Default AI service '${provider.name}' returned no text.`, status: res.status });
  }
  return { ok: true, data: { source: 'custom', content } };
}

/**
 * Resolve the "Default (from Settings)" alias for one llm_chat turn (§5.6, browser
 * runner). Resolves a typed failure — NEVER throws for source/preference problems and
 * NEVER falls through to a different source. Abort signals still throw as usual.
 */
export async function resolveDefaultLlm(
  opts: ResolveDefaultLlmOptions,
  deps: ResolveDefaultLlmDeps = {}
): Promise<DefaultLlmOutcome> {
  const fetchPreferences = deps.fetchPreferences ?? (() => getAiPreferences());
  let prefsRes: AiDefaultResult<AiPreferences>;
  try {
    prefsRes = await fetchPreferences();
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    logger.warn('[ai-default] preferences fetch threw:', err);
    return failure({
      code: 'ai_default_unresolved',
      message: `Could not load your AI settings (${err instanceof Error ? err.message : String(err)}) — open Settings → AI and choose a default source.`,
    });
  }
  if (!prefsRes.ok) {
    return failure({
      code: 'ai_default_unresolved',
      message: `Could not load your AI settings (${prefsRes.error.message}) — open Settings → AI and choose a default source.`,
      status: prefsRes.error.status,
    });
  }
  const prefs = prefsRes.data;

  switch (prefs.aiSource) {
    case 'site': {
      const siteChat = deps.siteChat ?? defaultSiteChat;
      const res = await siteChat(opts.messages, opts.signal);
      if (!res.ok) return failure(res.error); // ai_allowance_exceeded & friends pass through
      return { ok: true, data: { source: 'site', content: res.data.content, ...(res.data.usage !== undefined ? { usage: res.data.usage } : {}) } };
    }
    case 'desktop': {
      const providerId = prefs.desktopProviderId?.trim() ?? '';
      if (!providerId) {
        return failure({
          code: 'ai_default_unresolved',
          message: 'Settings → AI names FormLogic Desktop as the default but no Desktop provider is chosen — pick one in Settings → AI.',
        });
      }
      const tunnel = deps.tunnelChat ?? chatViaTunnel;
      const model = prefs.desktopModel?.trim() || undefined;
      const res = await tunnel({
        providerId,
        model,
        messages: opts.messages,
        signal: opts.signal,
        onDelta: opts.onDelta,
        onState: opts.onState,
      });
      if (!res.ok) {
        // Tunnel typed errors (desktop_offline, e2e_key_rotated, …) pass through verbatim.
        return failure({ code: res.error.code, message: res.error.message, status: res.error.status });
      }
      return { ok: true, data: { source: 'desktop', content: res.data.finalText, threadId: res.data.threadId } };
    }
    case 'custom':
      return runCustomSource(prefs, opts, deps);
  }
}

// ---------------------------------------------------------------------------
// resolveDefaultLlmTools — one model round WITH caller-supplied tools (the hosted Softn
// Studio's `aiTools` bridge capability). The caller runs the tools; this only asks.
// ---------------------------------------------------------------------------

/**
 * The code for "this source cannot take tools". The editor bridge answers it as
 * `{ok:false, code:'tools-unsupported'}` and Studio carries on with tool calls written
 * as text, so it is a routine answer, not a failure of the source.
 */
export const TOOLS_UNSUPPORTED = 'tools-unsupported';

export interface ResolveDefaultLlmToolsOptions extends EditorAiToolRequest {
  signal?: AbortSignal;
}

export interface DefaultLlmToolsSuccess extends EditorAiReply {
  source: AiSource;
}

export type DefaultLlmToolsOutcome = AiDefaultResult<DefaultLlmToolsSuccess>;

/** Injectable seams, as ResolveDefaultLlmDeps. */
export interface ResolveDefaultLlmToolsDeps {
  fetchPreferences?: PrefsFetcher;
  siteChatTools?: (request: EditorAiToolRequest, signal?: AbortSignal) => Promise<AiDefaultResult<EditorAiReply>>;
  resolveCustomProvider?: (providerId: string) => Promise<ResolvedAiProvider | null>;
  fetchFn?: typeof fetch;
}

/** The response path an OpenAI-compatible service answers on (the provider editor's default). */
const OPENAI_CHAT_RESPONSE_PATH = 'choices.0.message.content';

/**
 * Site AI with tools: POST /api/ai/chat {aiTools:1, messages, tools, maxOutputTokens} →
 * {data:{content, toolCalls, stopReason, usage}}. The backend maps to its OpenAI-compatible
 * upstream, applies its own bounds, and charges one allowance unit per round, as for text.
 */
async function defaultSiteChatTools(request: EditorAiToolRequest, signal?: AbortSignal): Promise<AiDefaultResult<EditorAiReply>> {
  const res = await contractFetch('POST', '/ai/chat', {
    aiTools: EDITOR_AI_TOOLS_VERSION,
    messages: request.messages,
    tools: request.tools,
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
    stream: false,
  }, signal);
  const status = res.status || undefined;
  if (!res.ok) {
    if (status === 401) return failure({ code: 'auth_required', message: 'Sign in again to use Site AI.', status });
    return failure({ code: status === undefined ? 'transport' : res.code ?? 'request_failed', message: res.message ?? 'The Site AI request failed.', status });
  }
  return readSiteToolsReply(res.data, status);
}

/** The backend's tools-mode `data` → the bridge reply. A server from before this mode answers without toolCalls: tools-unsupported. */
export function readSiteToolsReply(data: unknown, status?: number): AiDefaultResult<EditorAiReply> {
  const rec = asRecord(data);
  if (!rec || typeof rec.content !== 'string' || !Array.isArray(rec.toolCalls)) {
    return failure({ code: TOOLS_UNSUPPORTED, message: 'This FormLogic server does not pass tools to Site AI.', status });
  }
  const toolCalls: EditorAiReply['toolCalls'] = [];
  rec.toolCalls.forEach((raw, index) => {
    const call = asRecord(raw);
    if (!call || typeof call.name !== 'string' || call.name === '') return;
    toolCalls.push(editorToolCall(index, call.id, call.name, call.arguments));
  });
  const usage = asRecord(rec.usage);
  const counts = usage ? editorUsage(usage.promptTokens, usage.completionTokens) : undefined;
  return {
    ok: true,
    data: {
      text: rec.content,
      toolCalls,
      stopReason: typeof rec.stopReason === 'string' ? rec.stopReason : null,
      ...(counts ? { usage: counts } : {}),
    },
  };
}

async function runCustomSourceTools(
  prefs: AiPreferences,
  opts: ResolveDefaultLlmToolsOptions,
  deps: ResolveDefaultLlmToolsDeps
): Promise<DefaultLlmToolsOutcome> {
  const providerId = prefs.customProviderId?.trim() ?? '';
  if (!providerId) {
    return failure({
      code: 'ai_default_unresolved',
      message: 'Settings → AI names a custom AI service as the default but none is chosen — pick one in Settings → AI.',
    });
  }
  const resolveProvider =
    deps.resolveCustomProvider ??
    ((id: string) => resolveProviderRequest(useAuthStore.getState().user?.id, 'chat', id));
  const provider = await resolveProvider(providerId);
  if (!provider) {
    return failure({
      code: 'ai_default_unresolved',
      message:
        `The default AI service '${providerId}' is not configured in this browser ` +
        '(custom AI services are stored per browser) — open Settings → AI here and re-choose the default.',
    });
  }
  // A request template or a non-OpenAI response path means the service is not speaking
  // /chat/completions as-is: its body has no place for tools, so do not pretend it does.
  if (provider.requestTemplate || (provider.responsePath ?? OPENAI_CHAT_RESPONSE_PATH) !== OPENAI_CHAT_RESPONSE_PATH) {
    return failure({
      code: TOOLS_UNSUPPORTED,
      message: `The default AI service '${provider.name}' uses a custom request format, which cannot carry tool definitions.`,
    });
  }
  // OpenAI's own API takes the output cap as max_completion_tokens (its current models
  // refuse max_tokens); OpenAI-compatible servers (Ollama, LM Studio, custom) read max_tokens.
  const outputCap = opts.maxOutputTokens === undefined
    ? {}
    : provider.kind === 'openai' ? { max_completion_tokens: opts.maxOutputTokens } : { max_tokens: opts.maxOutputTokens };
  const body = {
    ...(provider.model ? { model: provider.model } : {}),
    messages: toOpenAiChatMessages(opts.messages),
    ...(opts.tools.length ? { tools: toOpenAiTools(opts.tools) } : {}),
    ...outputCap,
  };
  const doFetch = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(provider.url, { method: 'POST', headers: provider.headers, body: JSON.stringify(body), signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return failure({
      code: 'transport',
      message: `Default AI service '${provider.name}' is unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!res.ok) {
    const keyHint = provider.keyBlocked
      ? ' The saved API key was not sent because the provider uses unencrypted HTTP on a non-loopback host.'
      : '';
    return failure({ code: 'request_failed', message: `Default AI service '${provider.name}' responded ${res.status}.${keyHint}`, status: res.status });
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return failure({ code: 'request_failed', message: `Default AI service '${provider.name}' returned a non-JSON body.`, status: res.status });
  }
  const reply = fromOpenAiChatCompletion(payload);
  if (!reply) {
    return failure({ code: 'request_failed', message: `Default AI service '${provider.name}' returned no message.`, status: res.status });
  }
  return { ok: true, data: { source: 'custom', ...reply } };
}

/**
 * One model round with caller-supplied tools, through the settings-chosen source — the
 * same resolution and NO-SILENT-FALLBACK rule as resolveDefaultLlm:
 *   'site'    → the backend, which maps to its OpenAI-compatible upstream;
 *   'custom'  → the browser's AI service over OpenAI /chat/completions `tools`, when it
 *               speaks that wire; a templated service answers tools-unsupported;
 *   'desktop' → tools-unsupported: the sealed tunnel carries messages only, and the
 *               desktop runs its own tool loop over FormLogic's tools, never a caller's.
 * tools-unsupported is not a hop to another source: the caller keeps this source and
 * asks again in text.
 */
export async function resolveDefaultLlmTools(
  opts: ResolveDefaultLlmToolsOptions,
  deps: ResolveDefaultLlmToolsDeps = {}
): Promise<DefaultLlmToolsOutcome> {
  const fetchPreferences = deps.fetchPreferences ?? (() => getAiPreferences());
  let prefsRes: AiDefaultResult<AiPreferences>;
  try {
    prefsRes = await fetchPreferences();
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    logger.warn('[ai-default] preferences fetch threw:', err);
    return failure({
      code: 'ai_default_unresolved',
      message: `Could not load your AI settings (${err instanceof Error ? err.message : String(err)}) — open Settings → AI and choose a default source.`,
    });
  }
  if (!prefsRes.ok) {
    return failure({
      code: 'ai_default_unresolved',
      message: `Could not load your AI settings (${prefsRes.error.message}) — open Settings → AI and choose a default source.`,
      status: prefsRes.error.status,
    });
  }
  const prefs = prefsRes.data;
  switch (prefs.aiSource) {
    case 'site': {
      const siteChatTools = deps.siteChatTools ?? defaultSiteChatTools;
      const request: EditorAiToolRequest = {
        messages: opts.messages,
        tools: opts.tools,
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      };
      const res = await siteChatTools(request, opts.signal);
      if (!res.ok) return failure(res.error);
      return { ok: true, data: { source: 'site', ...res.data } };
    }
    case 'desktop':
      return failure({ code: TOOLS_UNSUPPORTED, message: 'FormLogic Desktop answers in text; it does not take tools from the editor.' });
    case 'custom':
      return runCustomSourceTools(prefs, opts, deps);
  }
}
