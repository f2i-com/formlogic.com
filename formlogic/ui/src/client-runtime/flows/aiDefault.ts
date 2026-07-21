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
async function contractFetch(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<RawFetchOutcome> {
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
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, data: null, message: e instanceof Error ? e.message : 'Network error' };
  }
  let parsed: unknown = null;
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
    void signal; // the interim contract fetch has no abort support; the api method will honor it
    const res = await contractFetch('POST', '/ai/chat', { messages, stream: false });
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
