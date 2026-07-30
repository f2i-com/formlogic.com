// Pairing FormLogic Web with OAIY Desktop.
//
// OAIY's exec routes are privileged. FormLogic Web is an untrusted origin, so it
// presents a bearer token — and it earns that token by pairing: it raises a
// request, OAIY shows the user a prompt with a short code, the user approves in
// OAIY Desktop, and FormLogic collects the minted token by polling. The user's
// approval is the trust act; the code lets them confirm the prompt is really
// this app before they click.
//
// This is the analogue of desktopPairing.ts for OAIY. The token it stores via
// setOaiyToken() is what oaiyRuntime.ts / desktopConnector.ts then use.
import { getOaiyBaseUrl, setOaiyToken } from './oaiyRuntime';

const POLL_INTERVAL_MS = 1500;
/** A user who is going to approve does so within a couple of minutes; past this
 *  the OAIY-side request has expired anyway (5 min TTL), so stop polling. */
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

export type PairingState = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingHandle {
  pairingId: string;
  /** The short code to show the user so they confirm it matches OAIY's prompt. */
  code: string;
}

export interface PairingResult {
  state: PairingState;
  /** Present only on `approved`. Already stored via setOaiyToken(). */
  token?: string;
}

/**
 * Raise a pairing request. Returns the id + the code to display to the user.
 *
 * Open on OAIY's side (its only power is to raise a prompt), so this needs no
 * token. Never throws for a reachable-but-refusing OAIY — a network failure
 * rejects, which the caller shows as "OAIY Desktop not reachable".
 */
export async function requestOaiyPairing(product: string, label?: string): Promise<PairingHandle> {
  const resp = await fetch(`${getOaiyBaseUrl()}/api/bridge/pairing`, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ product, label }),
  });
  if (!resp.ok) {
    throw new Error(`OAIY pairing request failed (HTTP ${resp.status})`);
  }
  const body = (await resp.json()) as { pairingId?: string; code?: string };
  if (!body.pairingId || !body.code) {
    throw new Error('OAIY pairing response was malformed');
  }
  return { pairingId: body.pairingId, code: body.code };
}

/**
 * Poll a pairing request once. On `approved`, the token is stored via
 * setOaiyToken() and returned. A transport error resolves to `pending` (a blip
 * should not abandon the wait); a 404 resolves to `expired` (OAIY forgot it).
 */
export async function pollOaiyPairing(pairingId: string): Promise<PairingResult> {
  let resp: Response;
  try {
    resp = await fetch(`${getOaiyBaseUrl()}/api/bridge/pairing/${encodeURIComponent(pairingId)}`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { state: 'pending' };
  }
  if (resp.status === 404) return { state: 'expired' };
  if (!resp.ok) return { state: 'pending' };
  const body = (await resp.json().catch(() => null)) as
    | { status?: PairingState; token?: string | null }
    | null;
  const state = (body?.status ?? 'pending') as PairingState;
  if (state === 'approved' && body?.token) {
    setOaiyToken(body.token);
    return { state: 'approved', token: body.token };
  }
  return { state };
}

export interface PairOptions {
  /** Called with the handle as soon as the request is raised, so the UI can show
   *  the code the user must confirm against OAIY's prompt. */
  onPending?: (handle: PairingHandle) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The whole flow: request → show the code → poll until the user decides.
 *
 * Resolves `approved` (with the token stored), `denied`, or `expired`
 * (timeout / the user never acted). Aborting the signal resolves `expired` too —
 * a cancelled pairing is indistinguishable from one that timed out, and neither
 * granted anything.
 */
export async function pairWithOaiy(
  product: string,
  label: string | undefined,
  opts: PairOptions = {},
): Promise<PairingResult> {
  const handle = await requestOaiyPairing(product, label);
  opts.onPending?.(handle);

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    if (opts.signal?.aborted) return { state: 'expired' };
    const res = await pollOaiyPairing(handle.pairingId);
    if (res.state === 'approved' || res.state === 'denied' || res.state === 'expired') {
      return res;
    }
    if (Date.now() >= deadline) return { state: 'expired' };
    await sleep(POLL_INTERVAL_MS, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
