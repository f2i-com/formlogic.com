// OAIY Desktop AI-gateway access for FormLogic flows.
//
// OAIY now serves the same credential-hidden AI lane FormLogic Desktop does:
//   GET  /api/ai/sources                                  — services + providers union
//   POST /api/ai/providers/{id}/v1/chat/completions       — chat, key injected server-side
// so a flow's provider:<id> chat can run through OAIY instead of FormLogic
// Desktop. Shaped like the FormLogic Desktop client (never throws, resolves a
// DesktopClientResult / a nullable list) so the flow dispatcher can prefer OAIY
// with a one-line branch and keep its error handling unchanged.
import type { DesktopClientResult, DesktopErrorShape } from '../desktop/desktopTypes';
import type { DesktopAiSource } from '../desktop/desktopClient';
import { forgetRefusedOaiyToken, getOaiyBaseUrl, getOaiyToken, mapOaiyErrorCode } from './oaiyRuntime';

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${getOaiyBaseUrl()}/api/ai/sources`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...authHeaders() },
    });
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => null)) as { sources?: DesktopAiSource[] } | null;
    return Array.isArray(body?.sources) ? body!.sources : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * oaiyAiChat's result: the Desktop client's, and for a refusal what OAIY itself said. The
 * error's code is OAIY's put into the Desktop taxonomy, which has one word (`command_failed`)
 * for most of OAIY's. A caller that must tell "that provider is not on this computer" (404
 * `no_provider`) from "the provider failed" reads `refusal`.
 */
export type OaiyAiChatResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: DesktopErrorShape; transportFailure?: boolean; refusal?: { code: string; status: number } };

/**
 * What a request this page stopped waiting for comes to, a chat or a picture: its own time ran
 * out, or the caller's signal did. It went out, so it is not a transport failure (the mark a
 * caller reads as "OAIY was not there" and may answer by asking again, or by another route):
 * OAIY may be working on it, and a provider billing for it, still.
 */
function unanswered(): { ok: false; error: DesktopErrorShape } {
  return { ok: false, error: { code: 'connector_uncertain', message: 'OAIY Desktop did not answer in time.' } };
}

/**
 * Run a credential-hidden chat completion against an OAIY-hosted provider by id.
 * OAIY injects the key server-side; FormLogic only ever holds its pairing token.
 * Returns the raw OpenAI chat-completion object as `data` (matching
 * desktopClient.ai.chat), or a typed error; a transport failure is marked so the
 * caller can distinguish "OAIY vanished" from a real refusal. Never throws.
 *
 * How long it waits: `timeoutMs` when given; otherwise the caller's `signal` alone, as
 * desktopClient.ai.chat does; and 30 s only with neither. A flow run hands its own deadline
 * as the signal (three minutes with an AI step), and OAIY holds a chat for as long as a
 * local engine takes to load: a 30 s cut of our own under that failed every cold start.
 * A chat cut off while waiting is `connector_uncertain`, not a transport failure: the
 * request went out, the provider may answer (and bill) yet, so no caller sends it again.
 */
export async function oaiyAiChat(
  providerId: string,
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<OaiyAiChatResult> {
  const controller = new AbortController();
  const timeoutMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : opts?.signal ? null : FETCH_TIMEOUT_MS;
  const timer = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let resp: Response;
  let text: string;
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
    text = await resp.text();
  } catch {
    if (controller.signal.aborted) return unanswered();
    return {
      ok: false,
      transportFailure: true,
      error: { code: 'connector_unavailable', message: 'OAIY Desktop did not respond.' },
    };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
  }

  const json = text ? safeParse(text) : undefined;
  if (resp.ok) {
    return { ok: true, data: (json ?? {}) as Record<string, unknown> };
  }
  forgetRefusedOaiyToken(resp.status, json);
  const err = (json as { error?: { code?: string; message?: string } })?.error;
  const rawCode = err?.code ?? '';
  // OAIY's engine refuses a model's malformed tool call as 422 `tool_contract_error`. OAIY
  // Desktop's gateway hands on whatever a provider refused as 502 `upstream_error`, with the
  // provider's own error inside its message (`upstream 422 Unprocessable Entity:
  // {"code":"tool_contract_error",…}`), so through the gateway the code is found there.
  const toolContractError =
    (resp.status === 422 && rawCode === 'tool_contract_error') ||
    (rawCode === 'upstream_error' && typeof err?.message === 'string' && err.message.includes('tool_contract_error'));
  const friendlyMessage =
    toolContractError
      ? 'The model returned an invalid tool call. Try asking again or choose another model in OAIY.'
      : err?.message ?? `OAIY AI provider request failed (HTTP ${resp.status})`;
  return {
    ok: false,
    error: {
      code: mapOaiyErrorCode(rawCode, resp.status),
      message: friendlyMessage,
    },
    refusal: { code: rawCode, status: resp.status },
  };
}

/** A picture can take minutes on a modest computer; past this the step gives up. */
const IMAGE_TIMEOUT_MS = 10 * 60_000;

/**
 * A picture from OAIY's own engine: the picture model switched on in OAIY (Engines), or the one
 * `body.model` names. OAIY forwards `POST /api/ai/engine/gateway/v1/images/generations` to its
 * engines for a paired app (scope `ai.use`) and answers in the OpenAI images shape
 * (`{ data: [{ b64_json }] }`). The page names no model and no service: what OAIY has is what
 * is used. Returns the raw answer as `data`, or a typed error with OAIY's own sentence; a
 * transport failure is marked. Never throws.
 *
 * A picture it stopped waiting for (its own ten minutes, or the caller's signal) is
 * `connector_uncertain`, as a chat is (oaiyAiChat), and not a transport failure: OAIY took the
 * request and its engine may be drawing still, so nothing was unreachable and nobody should ask
 * for the same picture again on the strength of it.
 */
export async function oaiyEngineImage(
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<DesktopClientResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let resp: Response;
  let text: string;
  try {
    resp = await fetch(`${getOaiyBaseUrl()}/api/ai/engine/gateway/v1/images/generations`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    text = await resp.text();
  } catch {
    if (controller.signal.aborted) return unanswered();
    return {
      ok: false,
      transportFailure: true,
      error: { code: 'connector_unavailable', message: 'OAIY Desktop did not respond.' },
    };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
  }

  const json = text ? safeParse(text) : undefined;
  if (resp.ok) {
    return { ok: true, data: (json ?? {}) as Record<string, unknown> };
  }
  forgetRefusedOaiyToken(resp.status, json);
  // OAIY's own errors are { error: { code, message } }; the engines' are { error: { message } }
  // or { error: "…" }.
  const raw = (json as { error?: unknown } | undefined)?.error;
  const err = raw && typeof raw === 'object' ? (raw as { code?: string; message?: string }) : undefined;
  const said = typeof raw === 'string' ? raw : err?.message;
  return {
    ok: false,
    error: {
      code: mapOaiyErrorCode(err?.code ?? '', resp.status),
      message: said && said.trim() !== '' ? said : `OAIY answered HTTP ${resp.status}`,
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
