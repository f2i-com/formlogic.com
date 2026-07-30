// OAIY Desktop AI-gateway access for FormLogic flows.
//
// OAIY now serves the same credential-hidden AI lane FormLogic Desktop does:
//   GET  /api/ai/sources                                  — services + providers union
//   POST /api/ai/providers/{id}/v1/chat/completions       — chat, key injected server-side
// so a flow's provider:<id> chat can run through OAIY instead of FormLogic
// Desktop. Shaped like the FormLogic Desktop client (never throws, resolves a
// DesktopClientResult / a nullable list) so the flow dispatcher can prefer OAIY
// with a one-line branch and keep its error handling unchanged.
import type { DesktopClientResult } from '../desktop/desktopTypes';
import type { DesktopAiSource } from '../desktop/desktopClient';
import { getOaiyBaseUrl, getOaiyToken, mapOaiyErrorCode } from './oaiyRuntime';

const FETCH_TIMEOUT_MS = 30_000;

function authHeaders(): Record<string, string> {
  const t = getOaiyToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * The OAIY AI sources union (local services + configured providers), in the same
 * DesktopAiSource shape FormLogic Desktop returns. Null when OAIY is unreachable,
 * so the caller falls back to FormLogic Desktop. Never throws.
 */
export async function listOaiySources(): Promise<DesktopAiSource[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${getOaiyBaseUrl()}/api/ai/sources`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...authHeaders() },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => null)) as { sources?: DesktopAiSource[] } | null;
    return Array.isArray(body?.sources) ? body!.sources : null;
  } catch {
    return null;
  }
}

/**
 * Run a credential-hidden chat completion against an OAIY-hosted provider by id.
 * OAIY injects the key server-side; FormLogic only ever holds its pairing token.
 * Returns the raw OpenAI chat-completion object as `data` (matching
 * desktopClient.ai.chat), or a typed error; a transport failure is marked so the
 * caller can distinguish "OAIY vanished" from a real refusal. Never throws.
 */
export async function oaiyAiChat(
  providerId: string,
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<DesktopClientResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let resp: Response;
  try {
    resp = await fetch(
      `${getOaiyBaseUrl()}/api/ai/providers/${encodeURIComponent(providerId)}/v1/chat/completions`,
      {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return {
      ok: false,
      transportFailure: true,
      error: { code: 'connector_unavailable', message: 'OAIY Desktop did not respond.' },
    };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
  }

  const text = await resp.text().catch(() => '');
  const json = text ? safeParse(text) : undefined;
  if (resp.ok) {
    return { ok: true, data: (json ?? {}) as Record<string, unknown> };
  }
  const err = (json as { error?: { code?: string; message?: string } })?.error;
  return {
    ok: false,
    error: {
      code: mapOaiyErrorCode(err?.code ?? '', resp.status),
      message: err?.message ?? `OAIY AI provider request failed (HTTP ${resp.status})`,
    },
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
