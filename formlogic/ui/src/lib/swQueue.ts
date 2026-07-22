// Offline-submit honesty (review 2026-07-22, blocker 6): the Workbox
// background-sync queue gives NO application-level result, so the submit path
// must derive an explicit outcome instead of trusting navigator.onLine:
//   - accepted: the server answered 2xx;
//   - queued:   the fetch failed at the network layer AND the service worker
//               (NetworkOnly + backgroundSync route for POST /api/forms/{id}/responses,
//               see vite.config.ts) is provably active with BackgroundSync support,
//               so the exact request — envelope + idempotency key — was captured
//               for replay;
//   - rejected: anything else (a definitive server refusal, or a network failure
//               with no queue to catch it). The caller keeps the user's answers.
// A non-2xx is NEVER reported as accepted, and "queued" is never claimed without
// the SW controller + sync registration.

export type SubmitOutcome = 'accepted' | 'queued' | 'rejected';

export interface SubmitResultLike {
  ok: boolean;
  status: number;
  /** Set when fetch itself threw (no server answer at all). */
  networkError?: string;
}

/**
 * True only when a service worker controls this page and BackgroundSync is
 * registered — the two conditions under which Workbox's NetworkOnly +
 * backgroundSync route provably queued the failed POST for replay.
 */
export async function swBackgroundSyncActive(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    if (!navigator.serviceWorker.controller) return false;
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration && 'sync' in registration;
  } catch {
    return false;
  }
}

/** Classify a submit result into the honest tri-state (see module note). */
export async function classifySubmitOutcome(result: SubmitResultLike): Promise<SubmitOutcome> {
  if (result.ok) return 'accepted';
  // A non-ok result WITH a status is a definitive server answer — rejected.
  if (!result.networkError) return 'rejected';
  // Network-layer failure: queued only when the SW background-sync queue is
  // provably there to have captured the exact request bytes.
  return (await swBackgroundSyncActive()) ? 'queued' : 'rejected';
}
