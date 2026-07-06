// Browser offline submission queue (IndexedDB).
//
// When an app-runtime submit can't reach the server (the device is offline), the submission is stored
// here instead of being lost, and flushed to the same idempotent create endpoint on reconnect. Each
// queued item carries a stable idempotencyKey, so the server's payload-hash-aware ledger dedupes a
// replay (see AppPublicController::processSubmission). This backs the SDK's useOfflineQueue status.
import { api, newIdempotencyKey } from '../lib/api';

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

/** POST one queued item through the same idempotent create endpoint; throws on failure. */
async function deliver(item: QueuedSubmission): Promise<void> {
  const res = await api.createAppResponse(item.appSlug, item.formId, {
    answers: item.answers,
    idempotencyKey: item.idempotencyKey,
  });
  // A 409 conflict (same key, different payload) is terminal for this item — treat as delivered so it
  // doesn't loop forever; any other API error is retryable.
  if (res.error && !/different submission|already being processed/i.test(String(res.error))) {
    throw new Error(String(res.error));
  }
}

/**
 * Flush every pending item (oldest first). Successful items are removed; failed items are kept with an
 * incremented attempt count + lastError so the UI can surface them and a later flush can retry.
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
      await run('readwrite', (s) => s.put({ ...item, status: 'syncing' } as QueuedSubmission));
      notify();
      try {
        await deliver(item);
        await run('readwrite', (s) => s.delete(item.id));
        flushed++;
      } catch (e) {
        await run('readwrite', (s) =>
          s.put({
            ...item,
            status: 'failed',
            attempts: item.attempts + 1,
            lastError: e instanceof Error ? e.message : String(e),
          } as QueuedSubmission)
        );
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

// Flush automatically when connectivity returns.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushQueue();
  });
}
