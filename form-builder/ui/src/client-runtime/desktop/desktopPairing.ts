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
  notifyPairedListeners();
}

/** Forget the pairing token (user disconnect, or Desktop rejected it as expired). */
export function clearDesktopToken(): void {
  storageRemove(storageKey());
  notifyPairedListeners();
}

// ── Paired-state change notifications ────────────────────────────────────────
// So UI (the Device Setup screen, the desktop panel) reacts the moment a token
// is stored/dropped — e.g. after a silent reconnect completes with no click.
type PairedListener = (paired: boolean) => void;
const pairedListeners = new Set<PairedListener>();

function notifyPairedListeners(): void {
  const paired = isDesktopPaired();
  for (const l of pairedListeners) {
    try {
      l(paired);
    } catch {
      /* a listener throwing must not break token storage */
    }
  }
}

/** Subscribe to pairing-token changes; returns an unsubscribe. Fires on store/clear. */
export function subscribeDesktopPaired(listener: PairedListener): () => void {
  pairedListeners.add(listener);
  return () => {
    pairedListeners.delete(listener);
  };
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

export interface RequestPairingResult {
  /** Poll id — present unless this was a SILENT probe on an untrusted origin. */
  requestId: string | null;
  /** The desktop already trusts this origin: the token is ready to poll, no prompt. */
  autoApproved: boolean;
}

/**
 * Begin pairing: asks Desktop to confirm `origin`. `silent` (a background
 * reconnect on load, not a user click) tells the desktop NOT to create a
 * pending approval for an untrusted origin — so a probe can't nag the desktop
 * window. An already-trusted origin (one that still holds a live token) comes
 * back `autoApproved` either way, so a browser that lost its session token
 * re-pairs with no prompt. Returns null only when Desktop is unreachable.
 */
export async function requestPairing(
  origin: string,
  opts: { silent?: boolean } = {}
): Promise<RequestPairingResult | null> {
  try {
    const res = await fetch(`${getDesktopBaseUrl()}/api/desktop/pairing-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, silent: opts.silent === true }),
      credentials: 'omit',
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { requestId?: unknown; autoApproved?: unknown }
      | null;
    return {
      requestId: typeof body?.requestId === 'string' && body.requestId ? body.requestId : null,
      autoApproved: body?.autoApproved === true,
    };
  } catch {
    return null;
  }
}

/** Guards against overlapping silent-reconnect attempts (detection ticks + panels). */
let reconnecting: Promise<boolean> | null = null;
/**
 * Set by an EXPLICIT user "Disconnect" so auto-reconnect doesn't instantly
 * undo it — the desktop still trusts this origin, so a silent re-pair would
 * otherwise succeed immediately. A 401 token-drop does NOT set this (that path
 * SHOULD self-heal); only a deliberate disconnect does. Cleared when the user
 * explicitly reconnects, or naturally on a full page reload (module re-init).
 */
let autoReconnectSuppressed = false;

/**
 * Explicit user disconnect: drop this session's token AND stop auto-reconnect
 * from silently restoring it. (The desktop's trust in the origin is untouched;
 * an explicit Connect re-pairs without a prompt.)
 */
export function disconnectDesktop(): void {
  autoReconnectSuppressed = true;
  clearDesktopToken();
}

/** Re-enable auto-reconnect (the user chose to connect again). */
export function allowAutoReconnect(): void {
  autoReconnectSuppressed = false;
}

/**
 * Silently re-establish pairing when the desktop ALREADY trusts this origin
 * (the common case after a browser restart drops the session-scoped token):
 * ask for a token with `silent`, and if the desktop auto-approves (trusted
 * origin), poll it in and store it — no native prompt, no user click. Returns
 * true when a token is now held. A never-trusted origin returns false fast
 * WITHOUT creating a pending desktop request, so the caller shows an explicit
 * "Connect FormLogic Desktop" button. Idempotent + de-duplicated.
 */
export async function attemptSilentReconnect(origin?: string): Promise<boolean> {
  if (isDesktopPaired()) return true;
  if (autoReconnectSuppressed) return false;
  if (reconnecting) return reconnecting;
  const target = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  if (!target) return false;
  reconnecting = (async () => {
    try {
      const begun = await requestPairing(target, { silent: true });
      if (!begun || !begun.autoApproved || !begun.requestId) return false;
      // Auto-approved: the token is already waiting — a short poll picks it up.
      const result = await pollPairing(begun.requestId, { intervalMs: 400, timeoutMs: 4000 });
      return result.status === 'approved';
    } catch {
      return false;
    } finally {
      reconnecting = null;
    }
  })();
  return reconnecting;
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
