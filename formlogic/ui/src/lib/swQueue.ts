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

/**
 * The submit result the classifier reads, from an api.request() answer. That layer gives no
 * status for a failed connection and none for a 2xx page that is not JSON (`unreadable`); only
 * the failed connection is a request the service worker can have queued. The other DID get an
 * answer (a captive portal's sign-in page, say), so nothing was queued and it is rejected: the
 * caller keeps the person's answers.
 */
export function submitResultFromApi(result: { error?: string; status?: number; unreadable?: true }): SubmitResultLike {
  if (!result.error) return { ok: true, status: result.status ?? 200 };
  const failedConnection = result.status === undefined && !result.unreadable;
  return {
    ok: false,
    status: result.status ?? 0,
    ...(failedConnection ? { networkError: result.error || 'network failure' } : {}),
  };
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

// -----------------------------------------------------------------------------
// The requests Workbox holds for replay (the backgroundSync routes in vite.config.ts).
//
// Workbox keeps them in its own database: `workbox-background-sync`, store `requests`, index
// `queueName`, each entry's `requestData.body` being the request body as an ArrayBuffer. Its
// replay removes an entry once ANY answer comes back (a refusal included), and never sends one
// older than the route's maxRetentionTime (24 hours): it deletes it instead, the next time it
// works through the queue. So nothing there is ever kept as "failed". A page finds its own entry
// by the idempotency key in the JSON body it sent.
// -----------------------------------------------------------------------------

/** The idempotency key in a queued request's JSON body, or null. */
function keyOfQueuedBody(body: unknown): string | null {
  try {
    if (!body || typeof (body as ArrayBuffer).byteLength !== 'number') return null;
    const parsed = JSON.parse(new TextDecoder().decode(body as ArrayBuffer)) as { idempotencyKey?: unknown } | null;
    return typeof parsed?.idempotencyKey === 'string' ? parsed.idempotencyKey : null;
  } catch {
    return null;
  }
}

/**
 * Count, and with `remove` delete, the requests queued under `queueName` whose body carries
 * `idempotencyKey`. Resolves 0 when there is no IndexedDB or Workbox never created its database
 * (opening it does not create it).
 */
function visitBackgroundSyncCopies(queueName: string, idempotencyKey: string, remove: boolean): Promise<number> {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(0);
  return new Promise<number>((resolve) => {
    let matched = 0;
    const open = indexedDB.open('workbox-background-sync');
    open.onerror = () => resolve(0);
    open.onblocked = () => resolve(0);
    open.onupgradeneeded = () => {
      // The database did not exist; opening it created an empty one. Abort so it stays absent.
      open.transaction?.abort();
      resolve(0);
    };
    open.onsuccess = () => {
      const db = open.result;
      const done = () => {
        db.close();
        resolve(matched);
      };
      try {
        if (!db.objectStoreNames.contains('requests')) {
          done();
          return;
        }
        const tx = db.transaction('requests', remove ? 'readwrite' : 'readonly');
        const cursorReq = tx.objectStore('requests').index('queueName').openCursor(IDBKeyRange.only(queueName));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const entry = cursor.value as { requestData?: { body?: unknown } } | undefined;
          if (keyOfQueuedBody(entry?.requestData?.body) === idempotencyKey) {
            matched++;
            if (remove) cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done();
      }
    };
  });
}

/** True while Workbox still holds a request with this idempotency key under `queueName`. */
export async function hasBackgroundSyncCopy(queueName: string, idempotencyKey: string): Promise<boolean> {
  return (await visitBackgroundSyncCopies(queueName, idempotencyKey, false)) > 0;
}

/** Remove every request with this idempotency key from `queueName`, so Workbox never replays it. Resolves with how many. */
export function discardBackgroundSyncCopies(queueName: string, idempotencyKey: string): Promise<number> {
  return visitBackgroundSyncCopies(queueName, idempotencyKey, true);
}
