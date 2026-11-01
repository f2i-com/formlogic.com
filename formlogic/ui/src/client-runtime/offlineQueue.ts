// Browser offline submission queue (IndexedDB).
//
// When an app-runtime submit can't reach the server (the device is offline), the submission is stored
// here instead of being lost, and flushed to the same idempotent create endpoint on reconnect. Each
// queued item carries a stable idempotencyKey, so the server's payload-hash-aware ledger dedupes a
// replay (see AppPublicController::processSubmission). This backs the SDK's useOfflineQueue status.
import { api, newIdempotencyKey } from '../lib/api';
import { currentSessionOwner } from '../lib/sessionGeneration';
import { discardBackgroundSyncCopies } from '../lib/swQueue';

/**
 * Queue-item lifecycle:
 *   - `pending`  — waiting / retryable (fresh, or kept after a generic or "processing" server response),
 *   - `syncing`  — a delivery attempt is in flight,
 *   - `failed`   — no longer sent by a flush: the server reported this idempotency key was reused with
 *                  a DIFFERENT submission (a genuine conflict), or the item used up MAX_ATTEMPTS. The
 *                  person can send it again (retrySubmission, not for a conflict) or discard it
 *                  (discardSubmission); otherwise it is removed FAILED_RETENTION_MS after it failed.
 */
export type QueuedStatus = 'pending' | 'syncing' | 'failed';

/**
 * Why an item is 'failed': the server holds a different submission under its key; it ran out of
 * attempts; it ran out of attempts and the last one was answered 2xx in a way the submit endpoint
 * never answers (UNRECOGNISED_REPLY); or the form's script acted and the record wasn't stored, so
 * only a person can decide to send it again.
 */
export type FailureKind = 'conflict' | 'gave-up' | 'unrecognised' | 'script-ran';

export interface QueuedSubmission {
  id: string;
  appSlug: string;
  formId: string;
  idempotencyKey: string;
  answers: Record<string, unknown>;
  /**
   * The flow run that wrote this record, when one did (appRuntimeStore.createResponse). Sent
   * with it, so the runs the record starts are that run's children and the server's depth
   * ceiling still stops a flow writing into its own form. Absent on a person's own write and on
   * rows stored before rows carried it.
   */
  flowRunId?: string;
  status: QueuedStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  /**
   * The user the submission belongs to (audit FL-09) — stamped at enqueue time and
   * immutable. Flushing sends ONLY the current owner's rows, so user A's queued
   * answers can never ride user B's cookies after an account switch on a shared
   * device. `undefined` = a legacy pre-upgrade row (kept flushable by anyone so
   * existing queues drain); `null` would mean an anonymous enqueue.
   */
  ownerUserId?: string | null;
  /**
   * When the item became 'failed' (ms). Rows that failed before this field existed get it the
   * first time they are read (sweepRows), so they keep the whole retention period from then.
   */
  failedAt?: number;
  /** Why it failed; absent on rows that failed before this field existed (see isConflict). */
  failure?: FailureKind;
}

/**
 * How long a failed submission stays on the device after it failed: 30 days. Long enough that
 * someone away for a few weeks still finds it and can send it again, short enough that answers
 * nobody acts on do not linger. It is also the server's default period for keeping idempotency
 * keys (bin/idempotency-cleanup.php), though the two clocks start at different times: the
 * server's at the first delivery attempt, this one when the item failed.
 */
export const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * True when the server holds a DIFFERENT submission under this item's key, so sending it again can
 * never succeed. Rows that failed before `failure` was recorded are known by the server's message
 * ("…already used with a different submission"), or the native flush's own fallback text.
 */
export function isConflict(item: { failure?: FailureKind; lastError?: string | null }): boolean {
  if (item.failure) return item.failure === 'conflict';
  return /different submission|idempotency conflict/i.test(item.lastError ?? '');
}

/**
 * True when the form's script acted and the record wasn't stored. A native item has no `failure`, so
 * it is known by the server's words (NotStoredAfterScript, ScriptRejection).
 */
export function isScriptRan(item: { failure?: FailureKind; lastError?: string | null }): boolean {
  if (item.failure) return item.failure === 'script-ran';
  return /script has already run|may already have acted/i.test(item.lastError ?? '');
}

/** What the person is shown about a submission that could not be sent. Never its answers. */
export interface FailedSubmissionSummary {
  id: string;
  appSlug: string;
  formId: string;
  createdAt: number;
  failedAt: number | null;
  conflict: boolean;
  /** Its last attempt was answered in a way FormLogic does not recognise. The native queue does not say. */
  unrecognised?: boolean;
  /** The form's script acted and the record wasn't stored: nothing sends it again but the person. */
  scriptRan?: boolean;
}

/** The classified outcome of a single delivery attempt (see classifyDeliveryResult). */
export type DeliveryOutcome = 'delivered' | 'processing' | 'retry' | 'unrecognised' | 'unreachable' | 'terminal' | 'stopped';

/** The reason kept on a submission whose delivery was answered 2xx without the stored record's id. */
export const UNRECOGNISED_REPLY = 'The server answered in a way FormLogic does not recognise.';

/**
 * True when a 2xx's `response` is what the submit endpoint answers for an accepted submission
 * (AppPublicController::processSubmission): the stored record, or for a replay {id}, either way
 * with its id. A captive portal, an SPA fallback serving index.html for /api, a proxy's page or
 * some other service answering in JSON also answer 2xx, and none of them stored anything.
 */
export function isAcceptedSubmission(response: unknown): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  const id = (response as { id?: unknown }).id;
  return typeof id === 'string' && id !== '';
}

export interface DeliveryClassification {
  outcome: DeliveryOutcome;
  error: string | null;
}

/** The delivery-result shape classifyDeliveryResult reads (a subset of api.AppSubmitResult). */
export interface DeliveryResultInput {
  /** The server answered 2xx; delivered only when `response` is an accepted submission. */
  ok: boolean;
  /** The 2xx body's `response` (see isAcceptedSubmission). */
  response?: unknown;
  error?: string;
  /** 409: this key was already used with a different submission — a terminal conflict. */
  conflict?: boolean;
  /** 409: an identical submission is already being processed server-side — retryable. */
  processing?: boolean;
  /** 200: an idempotent replay of an already-completed submission (ok is also true). */
  idempotent?: boolean;
  /** The form's script acted and nothing was stored: sending it again would run the script again. */
  scriptRan?: boolean;
  /** The HTTP status; 0 when no response arrived at all (the api layer's network failure). */
  status?: number;
}

/**
 * Statuses that say only that the server was not reached, or asked to be tried later: no
 * response at all (0), 408 Request Timeout, 429 Too Many Requests, and 502, 503 and 504. 503 is
 * what every API route answers while the admin's maintenance mode is on (MaintenanceMiddleware),
 * and what the submit pipeline itself answers, marked retryable, when a form is busy; 502 and 504
 * are a gateway that could not reach the app server. Nothing about the submission was judged, so
 * a delivery that ends this way uses up none of its attempts. 500 is not one of them: a
 * submission the server fails on every time has to reach the attempt cap and stop.
 */
export function isUnreachableStatus(status: number | undefined): boolean {
  return status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Decide what to do with a queued item given the server's delivery result. Pure + free of IndexedDB so
 * it is unit-testable directly. Prefers explicit server flags (the 409 body carries {conflict}/
 * {processing}) over message-string matching:
 *   - success / idempotent replay           → 'delivered'  (remove from the queue),
 *   - any other 2xx (see isAcceptedSubmission)
 *                                            → 'unrecognised' (keep pending; bump attempts, as 'retry'),
 *   - server says "already being processed"  → 'processing' (keep pending; do NOT remove or fail),
 *   - server says "different submission"     → 'terminal'   (mark failed; never retry — surface it),
 *   - server says the form's script acted    → 'stopped'    (mark failed; only the person sends it again),
 *   - server not reached (0 / 408 / 429 / 502 / 503 / 504, see isUnreachableStatus)
 *                                            → 'unreachable' (keep pending; attempts unchanged),
 *   - any other error                        → 'retry'      (keep pending; bump attempts).
 */
export function classifyDeliveryResult(result: DeliveryResultInput): DeliveryClassification {
  if (result.ok) {
    // Something answered, and the same thing is likely to answer next time: an attempt, so a
    // submission behind it ends as failed (with this reason) rather than waiting for ever.
    return isAcceptedSubmission(result.response)
      ? { outcome: 'delivered', error: null }
      : { outcome: 'unrecognised', error: UNRECOGNISED_REPLY };
  }
  const message = (result.error ?? '').trim();
  if (result.scriptRan === true) {
    return { outcome: 'stopped', error: message || 'The form\'s script acted, and this was not stored.' };
  }
  // Flags win over regex; the regex is a fallback for a transport that only surfaced the message.
  if (result.processing === true || /already being processed/i.test(message)) {
    return { outcome: 'processing', error: message || 'This submission is already being processed.' };
  }
  if (result.conflict === true || /different submission/i.test(message)) {
    return {
      outcome: 'terminal',
      error: message || 'This idempotency key was already used with a different submission.',
    };
  }
  if (isUnreachableStatus(result.status)) {
    return { outcome: 'unreachable', error: message || 'The server could not be reached.' };
  }
  return { outcome: 'retry', error: message || 'Delivery failed' };
}

const DB_NAME = 'formlogic-offline';
const STORE = 'submissions';
/** The form shows this when a write fails and the browser gave no reason of its own. */
const NOT_SAVED = 'This could not be saved on this device.';
const listeners = new Set<() => void>();
let flushing = false;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Settles when the transaction commits: a full disk can abort it there, after the request succeeded. */
function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const req = fn(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(req.result);
        transaction.onabort = () => reject(transaction.error ?? new Error(NOT_SAVED));
      })
  );
}

/**
 * Read a row and write back what `change` makes of it, in one transaction. `change` returning null
 * leaves the row as it is, and so does a row that is no longer there: a flush that read the queue
 * before the person discarded an item must not write it back.
 */
function updateRow(id: string, change: (row: QueuedSubmission) => QueuedSubmission | null): Promise<QueuedSubmission | null> {
  return openDb().then(
    (db) =>
      new Promise<QueuedSubmission | null>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const read = store.get(id) as IDBRequest<QueuedSubmission | undefined>;
        let next: QueuedSubmission | null = null;
        read.onsuccess = () => {
          next = read.result ? change(read.result) : null;
          if (next) store.put(next);
        };
        transaction.oncomplete = () => resolve(next);
        transaction.onabort = () => reject(transaction.error ?? new Error(NOT_SAVED));
      })
  );
}

function notify(): void {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

/** The native queue has no events of its own, so its passes tell the same subscribers. */
export const notifyQueueChanged = notify;

/** Subscribe to queue changes (enqueue / flush progress). Returns an unsubscribe fn. */
export function subscribeQueue(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isFlushing(): boolean {
  return flushing;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Queue a submission for later delivery. Generates a stable idempotencyKey if none is supplied. */
export async function enqueueSubmission(item: {
  appSlug: string;
  formId: string;
  answers: Record<string, unknown>;
  idempotencyKey?: string;
  flowRunId?: string;
}): Promise<QueuedSubmission> {
  const row: QueuedSubmission = {
    id: uuid(),
    appSlug: item.appSlug,
    formId: item.formId,
    idempotencyKey: item.idempotencyKey ?? newIdempotencyKey(),
    answers: item.answers,
    ...(item.flowRunId ? { flowRunId: item.flowRunId } : {}),
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: Date.now(),
    ownerUserId: currentSessionOwner(),
  };
  await run('readwrite', (s) => s.put(row));
  notify();
  return row;
}

/** Every row, oldest first, after the retention rules (sweepRows) have been applied. */
export async function listQueue(): Promise<QueuedSubmission[]> {
  const all = await run<QueuedSubmission[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedSubmission[]>);
  return (await sweepRows(all ?? [])).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Answers do not stay on the device for good. Applied on every read of the queue:
 *   - a failed row is removed FAILED_RETENTION_MS after it failed. A failed row from before
 *     `failedAt` existed is stamped now instead, so an upgrade does not delete it unseen;
 *   - a row parked for another account (its session expired, and someone else has signed in on
 *     this device since) is removed FAILED_RETENTION_MS after it was queued. While nobody is
 *     signed in it is kept, however old, for its owner to sign back in and send.
 * Rows of the signed-in account that are still pending are never removed for their age.
 */
async function sweepRows(rows: QueuedSubmission[]): Promise<QueuedSubmission[]> {
  const now = Date.now();
  const signedIn = currentSessionOwner();
  const kept: QueuedSubmission[] = [];
  let removed = false;
  for (const row of rows) {
    const failedExpired = row.status === 'failed' && typeof row.failedAt === 'number' && now - row.failedAt > FAILED_RETENTION_MS;
    const parkedExpired =
      typeof row.ownerUserId === 'string' && signedIn !== null && row.ownerUserId !== signedIn && now - row.createdAt > FAILED_RETENTION_MS;
    if (failedExpired || parkedExpired) {
      await run('readwrite', (s) => s.delete(row.id));
      removed = true;
      continue;
    }
    if (row.status === 'failed' && typeof row.failedAt !== 'number') {
      const stamped = await updateRow(row.id, (r) => (r.status === 'failed' && typeof r.failedAt !== 'number' ? { ...r, failedAt: now } : null));
      kept.push(stamped ?? { ...row, failedAt: now });
      continue;
    }
    kept.push(row);
  }
  if (removed) notify();
  return kept;
}

/**
 * True when the row is `userId`'s to see, send, retry or discard (audit FL-09): its own rows, and
 * legacy rows from before rows carried an owner. One test for all of them, so what a sign-out
 * warning counts is exactly what the sign-out removes.
 */
function belongsTo(item: QueuedSubmission, userId: string | null): boolean {
  if (item.ownerUserId === undefined) return true; // legacy pre-upgrade row
  return item.ownerUserId === userId;
}

/** True when the CURRENT session may deliver/see this row (audit FL-09). */
function ownedByCurrentSession(item: QueuedSubmission): boolean {
  return belongsTo(item, currentSessionOwner());
}

export async function queueCounts(): Promise<{ pending: number; failed: number }> {
  // Counts are scoped to the current owner (audit FL-09): user B's status badge
  // must not surface (or invite retries of) user A's parked submissions.
  const items = (await listQueue()).filter(ownedByCurrentSession);
  return {
    pending: items.filter((i) => i.status !== 'failed').length,
    failed: items.filter((i) => i.status === 'failed').length,
  };
}

/** How many rows, pending or failed, purgeQueueForOwner(userId) would remove (the sign-out warning). */
export async function unsentCountFor(userId: string | null): Promise<number> {
  return (await listQueue()).filter((i) => belongsTo(i, userId)).length;
}

/**
 * Erase every queued submission belonging to `userId`, pending or failed, and the legacy rows
 * without an owner (audit FL-09/FL-10): the teardown for a sign-out, an account deletion and a
 * sign-out in another tab. Plaintext answers must not outlive the session that wrote them, and a
 * row left behind would be sent under whoever signs in next. Not called when a session merely
 * expired (see teardownUserSession).
 */
export async function purgeQueueForOwner(userId: string | null): Promise<void> {
  const doomed = (await listQueue()).filter((i) => belongsTo(i, userId));
  for (const item of doomed) {
    await run('readwrite', (s) => s.delete(item.id));
  }
  if (doomed.length > 0) notify();
}

/** The current account's failed submissions, oldest first, for the person to retry or discard. */
export async function listFailedSubmissions(): Promise<FailedSubmissionSummary[]> {
  return (await listQueue())
    .filter((i) => i.status === 'failed' && ownedByCurrentSession(i))
    .map((i) => ({
      id: i.id,
      appSlug: i.appSlug,
      formId: i.formId,
      createdAt: i.createdAt,
      failedAt: typeof i.failedAt === 'number' ? i.failedAt : null,
      conflict: isConflict(i),
      unrecognised: i.failure === 'unrecognised',
      scriptRan: isScriptRan(i),
    }));
}

/**
 * What became of a retried submission: sent; waiting (back in the queue, the server was not reached
 * or asked to be tried later); unrecognised (back in the queue, answered 2xx by something that is
 * not the submit endpoint, see UNRECOGNISED_REPLY); failed again; refused because the server holds
 * a different submission under its key; or missing (not this account's, or no longer there).
 */
export type RetryOutcome = 'sent' | 'waiting' | 'unrecognised' | 'failed' | 'conflict' | 'missing';

/**
 * Send a failed submission again: back to 'pending' with its attempts reset, then a flush now.
 * It keeps its idempotency key, so if the server did store it after all, this is answered as a
 * replay rather than stored twice. A conflict is never sent again (the server holds a different
 * submission under that key; only discarding it makes sense). One whose form script acted goes
 * under a new key: the old one stays refused on the server, so that nothing else runs that script
 * again, and this is the person choosing to.
 */
export async function retrySubmission(id: string): Promise<RetryOutcome> {
  const row = (await listQueue()).find((i) => i.id === id);
  if (!row || !ownedByCurrentSession(row)) return 'missing';
  if (row.status === 'failed' && isConflict(row)) return 'conflict';
  const reset = await updateRow(id, (r) => {
    if (r.status !== 'failed') return null;
    // lastError too: what the retry is told comes from its own answer, not an earlier one.
    const next: QueuedSubmission = { ...r, status: 'pending', attempts: 0, lastError: null };
    if (isScriptRan(r)) next.idempotencyKey = newIdempotencyKey();
    delete next.failedAt;
    delete next.failure;
    return next;
  });
  if (reset) notify();
  // A pass already under way read the queue before this item was pending again: let it finish,
  // then run one that sees it.
  if (currentPass) await currentPass.catch(() => undefined);
  await flushQueue().catch(() => undefined);
  const after = (await listQueue()).find((i) => i.id === id);
  if (!after) return 'sent';
  if (after.status === 'failed') return isConflict(after) ? 'conflict' : 'failed';
  return after.lastError === UNRECOGNISED_REPLY ? 'unrecognised' : 'waiting';
}

/**
 * Remove one of the current account's queued submissions from the device. Its answers are gone for
 * good, so the screen asks first. A submit that never reached the server may also have left a copy
 * in Workbox's background-sync queue, which would still send it: that copy goes too.
 */
export async function discardSubmission(id: string): Promise<boolean> {
  const row = (await listQueue()).find((i) => i.id === id);
  if (!row || !ownedByCurrentSession(row)) return false;
  await run('readwrite', (s) => s.delete(id));
  notify();
  try {
    await discardBackgroundSyncCopies('formSubmissionQueue', row.idempotencyKey);
  } catch {
    // No service worker queue in this browser: nothing else holds it.
  }
  return true;
}

/** POST one queued item through the same idempotent create endpoint; returns the classified outcome. */
async function deliver(item: QueuedSubmission): Promise<DeliveryClassification> {
  const res = await api.createAppResponseResult(item.appSlug, item.formId, {
    answers: item.answers,
    idempotencyKey: item.idempotencyKey,
    ...(item.flowRunId ? { flowRunId: item.flowRunId } : {}),
  });
  return classifyDeliveryResult(res);
}

/** After this many attempts a still-undeliverable item is marked terminal 'failed', so a permanently
 *  non-deliverable submission drains instead of re-POSTing on every reconnect forever. */
const MAX_ATTEMPTS = 8;

/** The pass flushQueue is running, if any (retrySubmission waits for it). */
let currentPass: Promise<{ flushed: number; failed: number }> | null = null;

/**
 * Flush every retryable item (oldest first). Terminal ('failed') items are skipped: only the person
 * sends one again (retrySubmission). Outcomes: delivered → removed; processing → kept pending
 * (attempt bumped, capped); conflict → marked 'failed' with failure 'conflict'; server not reached
 * → kept pending with its attempts unchanged, and the pass ends; any other error, or a 2xx that is
 * not an accepted submission → kept pending with an incremented attempt count + lastError so a
 * later flush retries it, and 'failed' at MAX_ATTEMPTS with failure 'gave-up' (or 'unrecognised'
 * when the last answer was such a 2xx).
 *
 * The returned `failed` counts items that turned NEWLY TERMINAL during this flush (audit FL-25) —
 * an item kept 'pending' for a later retry is not reported as failed.
 */
export async function flushQueue(): Promise<{ flushed: number; failed: number }> {
  if (flushing) return { flushed: 0, failed: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { flushed: 0, failed: 0 };
  flushing = true;
  const pass = runPass();
  currentPass = pass;
  try {
    return await pass;
  } finally {
    if (currentPass === pass) currentPass = null;
  }
}

async function runPass(): Promise<{ flushed: number; failed: number }> {
  notify();
  let flushed = 0;
  let failed = 0;
  try {
    for (const listed of await listQueue()) {
      // Ownership partition (audit FL-09): another user's rows stay PARKED — they are
      // never delivered through this session's cookies. They resume when their owner
      // signs back in.
      if (!ownedByCurrentSession(listed)) continue;
      // The list was read when the pass began. Each row is read again before it is sent: the
      // person may have discarded it (it stays gone) or retried it (its attempts were reset) since.
      // Failed rows are left alone: only the person sends one again.
      const item = await updateRow(listed.id, (row) => (row.status === 'failed' ? null : { ...row, status: 'syncing' }));
      if (!item) continue;
      notify();
      let classification: DeliveryClassification;
      try {
        classification = await deliver(item);
      } catch (e) {
        // deliver() shouldn't throw (the api layer surfaces network errors as a result), but if it
        // does, treat it as a generic retryable failure rather than leaving the item stuck 'syncing'.
        classification = { outcome: 'retry', error: e instanceof Error ? e.message : String(e) };
      }
      const { outcome, error } = classification;
      // Each result is written onto the row as it is NOW, and only if it is still there (a
      // Discard while the request was out stays a discard).
      const settle = (patch: Partial<QueuedSubmission>) => updateRow(item.id, (row) => ({ ...row, ...patch }));
      const failure = (kind: FailureKind): Partial<QueuedSubmission> => ({ status: 'failed', failedAt: Date.now(), failure: kind });
      if (outcome === 'unreachable') {
        // Not reached, so not judged: back to pending with its attempts untouched, however long
        // the outage lasts. The rest of the queue would meet the same outage, so this pass ends
        // here; the next reconnect or "Sync now" tries again (nothing retries on a timer).
        await settle({ status: 'pending', lastError: error });
        notify();
        break;
      }
      if (outcome === 'delivered') {
        await run('readwrite', (s) => s.delete(item.id));
        flushed++;
      } else if (outcome === 'processing') {
        // Server still processing an earlier attempt (e.g. a stranded 'pending' reservation). Keep the
        // item retryable but bump attempts + cap, so a permanently-stuck reservation eventually
        // terminates instead of re-POSTing on every reconnect forever.
        const attempts = item.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        await settle({ status: 'pending', attempts, lastError: error, ...(terminal ? failure('gave-up') : {}) });
        if (terminal) failed++;
      } else if (outcome === 'terminal') {
        await settle({ attempts: item.attempts + 1, lastError: error, ...failure('conflict') });
        failed++;
      } else if (outcome === 'stopped') {
        await settle({ attempts: item.attempts + 1, lastError: error, ...failure('script-ran') });
        failed++;
      } else {
        // Generic retryable error, or a 2xx that was not the submit endpoint's ('unrecognised') —
        // bump attempts and go terminal at the cap so a deterministically non-deliverable item
        // (e.g. a server-only validation reject, an SPA fallback answering for /api) drains
        // instead of retrying forever. `failed` counts only NEWLY-TERMINAL items (audit FL-25): a
        // retryable item stored back as 'pending' is not a failure yet, and reporting it as one
        // made sync toasts claim losses that hadn't happened.
        const attempts = item.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        const kind: FailureKind = outcome === 'unrecognised' ? 'unrecognised' : 'gave-up';
        await settle({ status: 'pending', attempts, lastError: error, ...(terminal ? failure(kind) : {}) });
        if (terminal) failed++;
      }
      notify();
    }
  } finally {
    flushing = false;
    notify();
  }
  return { flushed, failed };
}

/** Alias of flushQueue for the unified flush surface (contract FU-3/#9: browser + native). */
export const flushBrowserQueue = flushQueue;

// Flush automatically when connectivity returns. (Opening an app and coming back to the page
// flush too, spaced apart: flushQueuesWhenDue in nativeOfflineQueue.ts, which knows both queues.)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushQueue();
  });
}
