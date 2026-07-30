// OAIY Desktop detection loop — subscribe-able, demand-driven.
//
// Mirrors desktopDetection.ts: a periodic /api/health probe that starts on the
// first subscriber and stops when the last unsubscribes, so pages that never
// touch a local runtime make zero loopback fetches. After repeated failures it
// backs off from 10s to 30s (a machine without OAIY installed shouldn't burn a
// fetch every 10s forever).
//
// The actual health probe + identity assertion (exact product match, compatible
// protocol major) lives in oaiyRuntime.probeOaiy(); this module only schedules
// it and notifies listeners when availability changes, so there is a single
// detection cache (oaiyRuntime's) that the connector layer also reads.
import { getOaiyInfo, probeOaiy, type OaiyInfo } from './oaiyRuntime';

const POLL_INTERVAL_MS = 10_000;
const BACKOFF_INTERVAL_MS = 30_000;
/** Consecutive failed probes before the poll backs off to the slow interval. */
const BACKOFF_AFTER_FAILURES = 3;

type Listener = (info: OaiyInfo) => void;

const listeners = new Set<Listener>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let consecutiveFailures = 0;
/** Last availability/version we NOTIFIED on, so we fire listeners only on change. */
let last: OaiyInfo = getOaiyInfo();

async function probeOnce(): Promise<void> {
  // force: a detection loop must not be served the short-lived cache — it is the
  // thing that refreshes it.
  const info = await probeOaiy(true);
  consecutiveFailures = info.available ? 0 : consecutiveFailures + 1;
  publish(info);
}

function publish(next: OaiyInfo): void {
  const changed = next.available !== last.available || next.version !== last.version;
  if (!changed) return; // no state change — nothing to announce
  last = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch (e) {
      // A listener throwing must not break the probe loop.
      console.warn('[oaiy-detect] listener threw:', e);
    }
  }
}

// One-shot timer chain (not setInterval) so each tick can pick the current
// interval — 10s while healthy, 30s once BACKOFF_AFTER_FAILURES probes have failed.
function scheduleNext(): void {
  if (!running || pollTimer !== null) return;
  const interval =
    consecutiveFailures >= BACKOFF_AFTER_FAILURES ? BACKOFF_INTERVAL_MS : POLL_INTERVAL_MS;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void probeOnce().finally(scheduleNext);
  }, interval);
}

/**
 * Start the periodic probe. Safe to call multiple times — only one loop runs.
 * The first probe fires immediately so the initial UI doesn't wait for a tick.
 * Normally implied by subscribeOaiyStatus(); exposed for imperative callers.
 */
export function startOaiyDetection(): void {
  if (running) return;
  running = true;
  void probeOnce().finally(scheduleNext);
}

/** Stop the periodic probe. */
export function stopOaiyDetection(): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** Snapshot of the current OAIY status (oaiyRuntime's detection cache). */
export function getOaiyStatus(): OaiyInfo {
  return getOaiyInfo();
}

/**
 * Force an immediate probe (independent of the poll loop) — e.g. right after the
 * user launches OAIY Desktop and clicks "Check again".
 */
export async function refreshOaiyStatus(): Promise<OaiyInfo> {
  const info = await probeOaiy(true);
  consecutiveFailures = info.available ? 0 : consecutiveFailures + 1;
  publish(info);
  return info;
}

/**
 * Subscribe to OAIY-status changes. Starts detection on the first subscriber and
 * stops it when the last one unsubscribes (detection never runs globally at boot).
 * The listener fires only when availability/version change — not on every poll —
 * and is called immediately with the current status.
 */
export function subscribeOaiyStatus(listener: Listener): () => void {
  listeners.add(listener);
  try {
    listener(getOaiyInfo());
  } catch (e) {
    console.warn('[oaiy-detect] initial listener call threw:', e);
  }
  startOaiyDetection();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopOaiyDetection();
  };
}

/** Reset the loop + notified state (listeners kept). Test-only. */
export function __resetOaiyDetectionLoopForTests(): void {
  stopOaiyDetection();
  consecutiveFailures = 0;
  last = { available: false, baseUrl: getOaiyInfo().baseUrl };
}
