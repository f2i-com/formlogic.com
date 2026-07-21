// Remote Desktop service/plugin lifecycle ops (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md
// §5.3 — Phase 3 "Desktop Connection" popover).
//
// When no LOCAL loopback desktop is paired, the popover still needs to list and drive
// the services/plugins of the LINKED desktop running on another machine. That rides the
// account-scoped ops relay:
//
//   POST /api/desktop/ops {op, serviceId?|pluginId?} → {data:{commandId}} (typed errors)
//   GET  /api/desktop/ops/{id} → {data:{status:'pending'|'claimed'|'done'|'failed'|'expired',
//                                   result?, uncertain?}}
//
// The backend inserts the op into desktop_commands with reserved connector_id 'desktop';
// the target desktop claims it, runs its service/plugin manager, and completes it.
//
// Outcome honesty mirrors the connector commandRelay (audit INT-005/C-14): this module
// NEVER throws. A claimed-but-unreported op at the client give-up resolves 'uncertain'
// (the desktop may well have acted — the UI must never fake a clean failure), an
// unclaimed one resolves 'expired' ("no desktop online"). The server may also mark an
// outcome uncertain itself ({uncertain:true} — e.g. an op that expired while claimed);
// that verdict wins over the status word.
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { generateId } from '../../lib/utils';

/** Poll cadence while a relayed op is in flight. */
export const DESKTOP_OPS_POLL_MS = 1200;
/** Client-side give-up window (server-side commands expire ~60s after creation). */
export const DESKTOP_OPS_TIMEOUT_MS = 65_000;

/** The allow-listed ops the relay accepts (plan §5.3). */
export type DesktopOpName =
  | 'desktop.services.list'
  | 'desktop.services.start'
  | 'desktop.services.stop'
  | 'desktop.services.restart'
  | 'desktop.services.repair'
  | 'desktop.plugins.list'
  | 'desktop.plugins.start'
  | 'desktop.plugins.stop'
  | 'desktop.plugins.restart'
  | 'desktop.plugins.health';

export interface DesktopOpRequest {
  op: DesktopOpName;
  /** Required for desktop.services.* ops other than list. */
  serviceId?: string;
  /** Required for desktop.plugins.* ops other than list. */
  pluginId?: string;
}

/** The terminal states a relayed op can settle into. */
export type DesktopOpTerminalStatus = 'done' | 'failed' | 'expired';

/**
 * What the caller learns. `uncertain` is either server-marked ({uncertain:true}) or
 * CLIENT-derived: the op was CLAIMED by a desktop but hadn't reported back when we gave
 * up — the service/plugin may well have been restarted, so the UI must say "outcome
 * uncertain", never fake a clean failure.
 */
export type DesktopOpOutcomeStatus = DesktopOpTerminalStatus | 'uncertain';

export interface DesktopOpOutcome {
  status: DesktopOpOutcomeStatus;
  /** The op's result payload (e.g. the services/plugins list for *.list ops). */
  result?: unknown;
  /** Human-readable failure detail when status is 'failed'. */
  error?: string | null;
  commandId?: string;
}

/** Why an op never got as far as polling (typed enqueue refusal / transport failure). */
export interface DesktopOpFailure {
  /** Server-typed code when one was returned; otherwise 'transport' | 'auth_required'. */
  code: string;
  message: string;
  /** HTTP status when the failure came from the backend. */
  status?: number;
}

export type DesktopOpRunResult =
  | { ok: true; outcome: DesktopOpOutcome }
  | { ok: false; error: DesktopOpFailure };

export interface RunDesktopOpOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** Injectable delay (tests pass an immediate resolver). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests advance it to exercise the give-up branch). */
  now?: () => number;
  /** Injectable fetch (tests stub the wire). */
  fetchFn?: typeof fetch;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

function csrfHeaders(): Record<string, string> {
  const csrf = typeof document !== 'undefined'
    ? document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/)?.[1]
    : undefined;
  return csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {};
}

interface OpStatusData {
  status?: string;
  result?: unknown;
  error?: unknown;
  uncertain?: boolean;
}

/** One relay call; null on transport failure or a non-JSON body (the poll keeps going). */
async function requestOp(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit
): Promise<{ httpStatus: number; body: Record<string, unknown> | null } | null> {
  let res: Response;
  try {
    res = await fetchFn(resolveBackendApiUrl(path), {
      credentials: 'include',
      cache: 'no-store',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    return null;
  }
  const body = asRecord(await res.json().catch(() => null));
  return { httpStatus: res.status, body };
}

function failure(error: DesktopOpFailure): DesktopOpRunResult {
  return { ok: false, error };
}

function outcome(out: DesktopOpOutcome): DesktopOpRunResult {
  return { ok: true, outcome: out };
}

/**
 * Enqueue one lifecycle op and poll it to a terminal outcome. Resolves a typed failure
 * only when the op never reached the queue (transport failure, auth, or a typed relay
 * refusal such as desktop_offline / ambiguous_desktop / permission_denied); everything
 * after a successful enqueue resolves as a DesktopOpOutcome. Never throws.
 */
export async function runDesktopOp(
  request: DesktopOpRequest,
  options: RunDesktopOpOptions = {}
): Promise<DesktopOpRunResult> {
  const pollMs = options.pollMs ?? DESKTOP_OPS_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DESKTOP_OPS_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const fetchFn = options.fetchFn ?? fetch;

  // One client intent id per operator action, mirroring the connector commandRelay:
  // a transport-level retry of the enqueue dedupes server-side instead of running the
  // lifecycle action twice. generateId, NOT bare crypto.randomUUID — randomUUID only
  // exists in secure contexts and this app runs on plain http:// in dev.
  const enqueueBody: Record<string, unknown> = { op: request.op, idempotencyKey: `ui-op-${generateId()}` };
  if (request.serviceId !== undefined) enqueueBody.serviceId = request.serviceId;
  if (request.pluginId !== undefined) enqueueBody.pluginId = request.pluginId;

  let enq = await requestOp(fetchFn, '/desktop/ops', {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(enqueueBody),
  });
  if (enq === null) {
    // The POST may have been DELIVERED but lost its response (indistinguishable from
    // never-sent). ONE same-key retry: it either dedupes into the first command (we then
    // poll its real outcome) or fails again identically. Lifecycle ops are idempotent in
    // effect (restart twice = restarted), so the worst case is a duplicate no-op.
    enq = await requestOp(fetchFn, '/desktop/ops', {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify(enqueueBody),
    });
  }
  if (enq === null) {
    return failure({
      code: 'transport',
      message: 'Could not reach FormLogic — the action may or may not have been queued. Check before retrying.',
    });
  }
  if (enq.httpStatus === 401) {
    return failure({ code: 'auth_required', message: 'Sign in again to control the desktop.', status: 401 });
  }
  const enqError = asRecord(enq.body?.error) ?? (enq.body?.error === true ? {} : null);
  if (!enq.body || enqError !== null || enq.httpStatus >= 400) {
    return failure({
      code: firstString(enqError?.code, enq.body?.code) ?? 'op_refused',
      message: firstString(enqError?.message, enq.body?.message) ?? `The desktop op was refused (${enq.httpStatus}).`,
      status: enq.httpStatus,
    });
  }
  const data = asRecord(enq.body.data);
  const commandId = firstString(data?.commandId, data?.id, enq.body.commandId);
  if (!commandId) {
    return failure({
      code: 'op_refused',
      message: 'The desktop op was accepted but returned no command id.',
      status: enq.httpStatus,
    });
  }
  const enqueuedStatus = firstString(data?.status);
  if (enqueuedStatus === 'done' || enqueuedStatus === 'failed' || enqueuedStatus === 'expired') {
    return outcome({
      status: enqueuedStatus,
      result: data?.result,
      error: enqueuedStatus === 'failed' ? firstString(data?.message, data?.error) ?? 'The desktop reported a failure.' : null,
      commandId,
    });
  }

  const startedAt = now();
  let lastStatus: string = enqueuedStatus ?? 'pending';
  for (;;) {
    await sleep(pollMs);
    const poll = await requestOp(fetchFn, `/desktop/ops/${encodeURIComponent(commandId)}`, { method: 'GET' });
    const pollData: OpStatusData | null = asRecord(poll?.body?.data) ?? asRecord(poll?.body);
    if (pollData && typeof pollData.status === 'string') {
      lastStatus = pollData.status;
      // A server-marked uncertain verdict wins over the status word (the desktop may
      // have acted; the backend could not confirm either way).
      if (pollData.uncertain === true) {
        return outcome({ status: 'uncertain', result: pollData.result, commandId });
      }
      if (pollData.status === 'done') {
        return outcome({ status: 'done', result: pollData.result, commandId });
      }
      if (pollData.status === 'failed') {
        const pollError = asRecord(pollData.result);
        return outcome({
          status: 'failed',
          result: pollData.result,
          error: firstString(asRecord(pollData.error)?.message, pollData.error, pollError?.message, pollError?.error)
            ?? 'The desktop reported a failure.',
          commandId,
        });
      }
      if (pollData.status === 'expired') {
        return outcome({ status: 'expired', result: pollData.result, commandId });
      }
    }
    if (now() - startedAt >= timeoutMs) {
      // Give-up semantics stay truthful: an op a desktop CLAIMED may have run — that is
      // 'uncertain', not a failure; an unclaimed op means no desktop was online.
      return outcome({ status: lastStatus === 'claimed' ? 'uncertain' : 'expired', commandId });
    }
  }
}
