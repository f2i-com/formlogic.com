// FormLogic Desktop pairing (docs/FORMLOGIC_DESKTOP.md §3).
//
// Loopback alone is not sufficient for privileged commands, so the browser pairs:
//   1. POST /api/desktop/pairing-requests {origin} → {requestId}
//   2. Desktop shows a native confirmation naming the origin
//   3. GET /api/desktop/pairing-requests/{id} polls until approved (→ bearer token,
//      bound to this origin) or denied.
//
// The token lives in sessionStorage ONLY (never localStorage, never cookies — contract
// §3.5), namespaced per desktop instance (base URL) so a test/dev instance on another
// port can't leak its token into the real one. All privileged calls attach
// `Authorization: Bearer <token>` (EventSource uses `?token=` instead).
import { getDesktopBaseUrl, type DesktopPairingPollResult, type DesktopPairingStatus } from './desktopTypes';

const TOKEN_KEY_PREFIX = 'formlogic-desktop-token:';

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 120_000; // the user has to click a native dialog — be patient
const FETCH_TIMEOUT_MS = 5000;

// sessionStorage is absent in non-DOM environments (unit tests, SSR); fall back to an
// in-memory map with the same per-instance keying so the flow stays exercisable.
const memoryStore = new Map<string, string>();

function storageKey(): string {
  return `${TOKEN_KEY_PREFIX}${getDesktopBaseUrl()}`;
}

function storageGet(key: string): string | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage.getItem(key);
  } catch {
    /* storage blocked — fall through to memory */
  }
  return memoryStore.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, value);
      return;
    }
  } catch {
    /* storage blocked — fall through to memory */
  }
  memoryStore.set(key, value);
}

function storageRemove(key: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  memoryStore.delete(key);
}

/** The pairing token for the CURRENT desktop instance, or null when unpaired. */
export function getDesktopToken(): string | null {
  return storageGet(storageKey());
}

/** Persist a pairing token for the current desktop instance (sessionStorage-scoped). */
export function storeDesktopToken(token: string): void {
  storageSet(storageKey(), token);
}

/** Forget the pairing token (user disconnect, or Desktop rejected it as expired). */
export function clearDesktopToken(): void {
  storageRemove(storageKey());
}

/** True when a pairing token is held for the current desktop instance. */
export function isDesktopPaired(): boolean {
  return getDesktopToken() !== null;
}

/**
 * Authorization headers for a privileged desktop call — `{}` when unpaired so callers
 * can spread it unconditionally.
 */
export function desktopAuthHeaders(): Record<string, string> {
  const token = getDesktopToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? (AbortSignal as unknown as { timeout: (n: number) => AbortSignal }).timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Begin pairing: asks Desktop to show its native confirmation for `origin`.
 * Resolves the requestId to poll, or null when Desktop is unreachable / refused.
 */
export async function requestPairing(origin: string): Promise<string | null> {
  try {
    const res = await fetch(`${getDesktopBaseUrl()}/api/desktop/pairing-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin }),
      credentials: 'omit',
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { requestId?: unknown } | null;
    return typeof body?.requestId === 'string' && body.requestId ? body.requestId : null;
  } catch {
    return null;
  }
}

export interface PollPairingOptions {
  /** Poll cadence, default 1.5s. */
  intervalMs?: number;
  /** Overall cap waiting for the user's native approval, default 120s. */
  timeoutMs?: number;
}

export type PollPairingResult =
  | { status: 'approved' }
  | { status: 'denied' }
  /** Timed out waiting, or Desktop became unreachable mid-poll. */
  | { status: 'timeout' };

/**
 * Poll a pairing request until it resolves. On approval the returned token is stored
 * (per desktop instance) so desktopAuthHeaders()/getDesktopToken() pick it up; the raw
 * token is deliberately NOT returned to keep it off component state. Never throws.
 */
export async function pollPairing(
  requestId: string,
  options: PollPairingOptions = {}
): Promise<PollPairingResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let poll: DesktopPairingPollResult | null = null;
    try {
      const res = await fetch(
        `${getDesktopBaseUrl()}/api/desktop/pairing-requests/${encodeURIComponent(requestId)}`,
        { credentials: 'omit', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS) }
      );
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { status?: unknown; token?: unknown } | null;
        if (body && typeof body.status === 'string') {
          poll = { status: body.status as DesktopPairingStatus, token: typeof body.token === 'string' ? body.token : undefined };
        }
      }
    } catch {
      /* transient network failure — keep polling until the deadline */
    }

    if (poll?.status === 'approved' && poll.token) {
      storeDesktopToken(poll.token);
      return { status: 'approved' };
    }
    if (poll?.status === 'denied') return { status: 'denied' };

    if (Date.now() + intervalMs > deadline) return { status: 'timeout' };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
