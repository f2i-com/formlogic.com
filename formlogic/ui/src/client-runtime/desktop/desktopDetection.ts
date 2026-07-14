// FormLogic Desktop detection (docs/FORMLOGIC_DESKTOP.md §1/§5).
//
// A small reactive probe of GET /api/health on 127.0.0.1:17872. Recognises the
// FormLogic Desktop companion id and never throws on network failure — an
// unreachable Desktop simply publishes {available:false}.
//
// Lifecycle: detection is demand-driven, NOT started at boot. subscribeDesktopStatus()
// starts the poll on the first subscriber and stops it when the last one unsubscribes,
// so pages that never touch Desktop (public forms, marketing) make zero loopback fetches.
// After repeated consecutive failures the poll backs off from 10s to 30s (a machine
// without Desktop installed shouldn't burn a fetch every 10s forever).
import { DESKTOP_COMPANION_IDS, getDesktopBaseUrl, type DesktopHealth } from './desktopTypes';

const POLL_INTERVAL_MS = 10_000;
const BACKOFF_INTERVAL_MS = 30_000;
/** Consecutive failed probes before the poll backs off to the slow interval. */
const BACKOFF_AFTER_FAILURES = 3;
const FETCH_TIMEOUT_MS = 1500;

export interface DesktopInfo {
  /** True if the last health probe returned a recognised companion. */
  available: boolean;
  /** Which id the running companion reported ('formlogic-desktop'). */
  companion?: string;
  version?: string;
  apiVersion?: number;
  pluginApiVersion?: number;
  /** Base URL for downstream desktop API calls. */
  baseUrl: string;
  /** Last time the status changed, ms-since-epoch. */
  lastChange: number;
}

type Listener = (info: DesktopInfo) => void;

function initialInfo(): DesktopInfo {
  return { available: false, baseUrl: getDesktopBaseUrl(), lastChange: Date.now() };
}

let current: DesktopInfo = initialInfo();
const listeners = new Set<Listener>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let consecutiveFailures = 0;
let pollPromise: Promise<void> | null = null;

function isRecognisedCompanion(id: unknown): boolean {
  return typeof id === 'string' && (DESKTOP_COMPANION_IDS as readonly string[]).includes(id);
}

async function probeOnce(): Promise<void> {
  const base = getDesktopBaseUrl();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${base}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      // Different origin (loopback:17872 vs the app origin); Desktop's health route is
      // CORS-open and unauthenticated, so omit credentials.
      credentials: 'omit',
      cache: 'no-store',
    });
    clearTimeout(timeout);
    if (resp.ok) {
      const body = (await resp.json().catch(() => null)) as Partial<DesktopHealth> | null;
      const recognised = isRecognisedCompanion(body?.companion);
      consecutiveFailures = recognised ? 0 : consecutiveFailures + 1;
      publish({
        available: recognised,
        companion: recognised ? body?.companion : undefined,
        version: recognised ? body?.version : undefined,
        apiVersion: recognised && typeof body?.apiVersion === 'number' ? body.apiVersion : undefined,
        pluginApiVersion:
          recognised && typeof body?.pluginApiVersion === 'number' ? body.pluginApiVersion : undefined,
        baseUrl: base,
        lastChange: Date.now(),
      });
      return;
    }
  } catch {
    // Network error, timeout, or CORS rejection — all mean "not available". Never
    // logged: this probe runs on a loop and would flood the console.
  }
  consecutiveFailures += 1;
  publish({ available: false, baseUrl: base, lastChange: Date.now() });
}

function publish(next: DesktopInfo): void {
  const changed =
    next.available !== current.available ||
    next.companion !== current.companion ||
    next.version !== current.version;
  if (!changed) return; // no state change — keep the original lastChange
  current = next;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (e) {
      // A listener throwing must not break the probe loop.
      console.warn('[desktop-detect] listener threw:', e);
    }
  }
}

// One-shot timer chain (not setInterval) so each tick can pick the current interval —
// 10s while healthy, 30s once BACKOFF_AFTER_FAILURES consecutive probes have failed.
function scheduleNext(): void {
  if (!running || pollTimer !== null) return;
  const interval = consecutiveFailures >= BACKOFF_AFTER_FAILURES ? BACKOFF_INTERVAL_MS : POLL_INTERVAL_MS;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollPromise = probeOnce().finally(() => scheduleNext());
  }, interval);
}

/**
 * Start the periodic probe. Safe to call multiple times — only one loop runs. The first
 * probe fires immediately so the initial UI doesn't wait for the first interval tick.
 * Normally implied by subscribeDesktopStatus(); exposed for imperative callers.
 */
export function startDesktopDetection(): void {
  if (running) return;
  running = true;
  pollPromise = probeOnce().finally(() => scheduleNext());
}

/** Stop the periodic probe. */
export function stopDesktopDetection(): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** Snapshot of the current desktop status. */
export function getDesktopInfo(): DesktopInfo {
  return current;
}

/**
 * Subscribe to desktop-status changes. Starts detection on the first subscriber and
 * stops it when the last one unsubscribes (detection never runs globally at boot).
 * The listener fires only when availability/companion/version change — not on every
 * poll — and is called immediately with the current status.
 */
export function subscribeDesktopStatus(listener: Listener): () => void {
  listeners.add(listener);
  try {
    listener(current);
  } catch (e) {
    console.warn('[desktop-detect] initial listener call threw:', e);
  }
  startDesktopDetection();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopDesktopDetection();
  };
}

/**
 * Force an immediate probe (independent of the poll loop) — e.g. right after the user
 * launches Desktop and clicks "Check again".
 */
export async function refreshDesktopStatus(): Promise<DesktopInfo> {
  await probeOnce();
  return current;
}

/** Internal: lets tests await an in-flight probe. */
export function _currentProbePromise(): Promise<void> | null {
  return pollPromise;
}

/** Reset all detection state (listeners kept — tests manage their own). Test-only. */
export function __resetDesktopDetectionForTests(): void {
  stopDesktopDetection();
  listeners.clear();
  consecutiveFailures = 0;
  pollPromise = null;
  current = initialInfo();
}

/** Force a status snapshot without a network probe (drives connector/UI tests). Test-only. */
export function __setDesktopInfoForTests(info: Partial<DesktopInfo>): void {
  current = { ...initialInfo(), lastChange: Date.now(), ...info };
}

/** Current consecutive-failure count (asserts backoff behaviour). Test-only. */
export function __getConsecutiveFailuresForTests(): number {
  return consecutiveFailures;
}
