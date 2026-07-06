// Browser offline submission queue (IndexedDB).
//
// When an app-runtime submit can't reach the server (the device is offline), the submission is stored
// here instead of being lost, and flushed to the same idempotent create endpoint on reconnect. Each
// queued item carries a stable idempotencyKey, so the server's payload-hash-aware ledger dedupes a
// replay (see AppPublicController::processSubmission). This backs the SDK's useOfflineQueue status.
import { api, newIdempotencyKey } from '../lib/api';

/**
 * Queue-item lifecycle:
 *   - `pending`  — waiting / retryable (fresh, or kept after a generic or "processing" server response),
 *   - `syncing`  — a delivery attempt is in flight,
 *   - `failed`   — TERMINAL, non-retryable: the server reported this idempotency key was reused with a
 *                  DIFFERENT submission (a genuine conflict). These are surfaced and never retried.
 */
export type QueuedStatus = 'pending' | 'syncing' | 'failed';

export interface QueuedSubmission {
  id: string;
  appSlug: string;
  formId: string;
  idempotencyKey: string;
  answers: Record<string, unknown>;
  status: QueuedStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
}

/** The classified outcome of a single delivery attempt (see classifyDeliveryResult). */
export type DeliveryOutcome = 'delivered' | 'processing' | 'retry' | 'terminal';

export interface DeliveryClassification {
  outcome: DeliveryOutcome;
  error: string | null;
}

/** The delivery-result shape classifyDeliveryResult reads (a subset of api.AppSubmitResult). */
export interface DeliveryResultInput {
  ok: boolean;
  error?: string;
  /** 409: this key was already used with a different submission — a terminal conflict. */
  conflict?: boolean;
  /** 409: an identical submission is already being processed server-side — retryable. */
  processing?: boolean;
  /** 200: an idempotent replay of an already-completed submission (ok is also true). */
  idempotent?: boolean;
}

/**
 * Decide what to do with a queued item given the server's delivery result. Pure + free of IndexedDB so
 * it is unit-testable directly. Prefers explicit server flags (the 409 body carries {conflict}/
 * {processing}) over message-string matching:
 *   - success / idempotent replay           → 'delivered'  (remove from the queue),
 *   - server says "already being processed"  → 'processing' (keep pending; do NOT remove or fail),
 *   - server says "different submission"     → 'terminal'   (mark failed; never retry — surface it),
 *   - any other error                        → 'retry'      (keep pending; bump attempts).
 */
export function classifyDeliveryResult(result: DeliveryResultInput): DeliveryClassification {
  if (result.ok) return { outcome: 'delivered', error: null };
  const message = (result.error ?? '').trim();
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
  return { outcome: 'retry', error: message || 'Delivery failed' };
}

const DB_NAME = 'formlogic-offline';
const STORE = 'submissions';
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

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
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
}): Promise<QueuedSubmission> {
  const row: QueuedSubmission = {
    id: uuid(),
    appSlug: item.appSlug,
    formId: item.formId,
    idempotencyKey: item.idempotencyKey ?? newIdempotencyKey(),
    answers: item.answers,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: Date.now(),
  };
  await run('readwrite', (s) => s.put(row));
  notify();
  return row;
}

export async function listQueue(): Promise<QueuedSubmission[]> {
  const all = await run<QueuedSubmission[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedSubmission[]>);
  return (all ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

export async function queueCounts(): Promise<{ pending: number; failed: number }> {
  const items = await listQueue();
  return {
    pending: items.filter((i) => i.status !== 'failed').length,
    failed: items.filter((i) => i.status === 'failed').length,
  };
}

/** POST one queued item through the same idempotent create endpoint; returns the classified outcome. */
async function deliver(item: QueuedSubmission): Promise<DeliveryClassification> {
  const res = await api.createAppResponseResult(item.appSlug, item.formId, {
    answers: item.answers,
    idempotencyKey: item.idempotencyKey,
  });
  return classifyDeliveryResult(res);
}

/** After this many attempts a still-undeliverable item is marked terminal 'failed', so a permanently
 *  non-deliverable submission drains instead of re-POSTing on every reconnect forever. */
const MAX_ATTEMPTS = 8;

/**
 * Flush every retryable item (oldest first). Terminal ('failed') items are skipped — never retried.
 * Outcomes: delivered → removed; processing → kept pending (no attempt bump); conflict → marked
 * terminal 'failed' + surfaced; any other error → kept pending with an incremented attempt count +
 * lastError so a later flush retries it.
 */
export async function flushQueue(): Promise<{ flushed: number; failed: number }> {
  if (flushing) return { flushed: 0, failed: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { flushed: 0, failed: 0 };
  flushing = true;
  notify();
  let flushed = 0;
  let failed = 0;
  try {
    for (const item of await listQueue()) {
      // Terminal conflicts are non-retryable — leave them for the user to see, don't re-send.
      if (item.status === 'failed') continue;
      await run('readwrite', (s) => s.put({ ...item, status: 'syncing' } as QueuedSubmission));
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
      if (outcome === 'delivered') {
        await run('readwrite', (s) => s.delete(item.id));
        flushed++;
      } else if (outcome === 'processing') {
        // Server still processing an earlier attempt (e.g. a stranded 'pending' reservation). Keep the
        // item retryable but bump attempts + cap, so a permanently-stuck reservation eventually
        // terminates instead of re-POSTing on every reconnect forever.
        const attempts = item.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        await run('readwrite', (s) =>
          s.put({ ...item, status: terminal ? 'failed' : 'pending', attempts, lastError: error } as QueuedSubmission));
        if (terminal) failed++;
      } else if (outcome === 'terminal') {
        await run('readwrite', (s) =>
          s.put({ ...item, status: 'failed', attempts: item.attempts + 1, lastError: error } as QueuedSubmission));
        failed++;
      } else {
        // Generic retryable error — bump attempts and go terminal at the cap so a deterministically
        // non-deliverable item (e.g. a server-only validation reject) drains instead of retrying forever.
        const attempts = item.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        await run('readwrite', (s) =>
          s.put({ ...item, status: terminal ? 'failed' : 'pending', attempts, lastError: error } as QueuedSubmission));
        failed++;
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

// Flush automatically when connectivity returns.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushQueue();
  });
}
