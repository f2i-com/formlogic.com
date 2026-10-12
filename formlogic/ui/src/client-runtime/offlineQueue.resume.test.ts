// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The browser's `online` event is the queue's automatic trigger, and it fires only when the
// browser's own idea of the connection changes. A Wi-Fi sign-in page, maintenance mode and a
// rate limit all leave a submission waiting while the browser says "online" throughout, so the
// event never comes. Coming back to the page is the other moment worth trying: the person has
// been away (signing in to the Wi-Fi in another tab, say), and it costs one read when nothing waits.
const demo = vi.hoisted(() => ({ on: false }));
vi.mock('../lib/api', () => ({
  api: { createAppResponseResult: vi.fn(), syncBatch: vi.fn(), isDemoMode: () => demo.on },
  newIdempotencyKey: () => 'key',
}));
vi.mock('../lib/sessionGeneration', () => ({ currentSessionOwner: () => 'u1' }));

import { api } from '../lib/api';
import { enqueueSubmission, isFlushing, listQueue } from './offlineQueue';
import { AUTO_FLUSH_SPACING_MS, flushNativeQueue } from './nativeOfflineQueue';
import type { FormLogicNativeBridge } from './connectors/connectorTypes';

/** The one object store offlineQueue.ts uses ('submissions', keyPath 'id'), kept in memory. */
function memoryIndexedDB(): IDBFactory {
  const rows = new Map<string, unknown>();
  const request = (result: unknown) => {
    const req = { result: undefined as unknown, error: null, onsuccess: null as null | (() => void), onerror: null };
    queueMicrotask(() => { req.result = result; req.onsuccess?.(); });
    return req;
  };
  const store = {
    put: (row: { id: string }) => { rows.set(row.id, structuredClone(row)); return request(row.id); },
    get: (id: string) => request(rows.has(id) ? structuredClone(rows.get(id)) : undefined),
    delete: (id: string) => { rows.delete(id); return request(undefined); },
    getAll: () => request([...rows.values()].map((row) => structuredClone(row))),
  };
  const db = { objectStoreNames: { contains: () => true }, createObjectStore: () => store, transaction: () => ({ objectStore: () => store }) };
  return {
    open: () => {
      const req = { result: db, error: null, onsuccess: null as null | (() => void), onerror: null, onupgradeneeded: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  } as unknown as IDBFactory;
}

let visibility: DocumentVisibilityState = 'visible';
// The clock the automatic passes are spaced by. Each test starts long after the one before it.
let now = 1_800_000_000_000;

async function settled() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!isFlushing()) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function comeBackToThePage(state: DocumentVisibilityState = 'visible') {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
  await settled();
}

function nativeBridge(items = [{ id: 'i1', idempotencyKey: 'k1', formId: 'orders', answers: { item: 'tea' } }]) {
  const sync = {
    flush: vi.fn(async () => ({ pending: [{ appSlug: 'shop', items }] })),
    ack: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
  (window as { FormLogicNative?: unknown }).FormLogicNative = { available: true, sync };
  return sync;
}

beforeEach(() => {
  now += 10 * AUTO_FLUSH_SPACING_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('indexedDB', memoryIndexedDB());
  vi.mocked(api.createAppResponseResult).mockReset();
  vi.mocked(api.syncBatch).mockReset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  visibility = 'visible';
  demo.on = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as { FormLogicNative?: FormLogicNativeBridge }).FormLogicNative;
});

describe('coming back to the page with submissions waiting', () => {
  it('sends the browser queue', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201 });

    await comeBackToThePage();

    expect(api.createAppResponseResult).toHaveBeenCalledTimes(1);
    expect(await listQueue()).toEqual([]);
  });

  it('sends the native queue', async () => {
    const sync = nativeBridge();
    vi.mocked(api.syncBatch).mockResolvedValue({ data: { results: [{ idempotencyKey: 'k1', success: true, responseId: 'r1', error: null }] } });

    await comeBackToThePage();

    expect(api.syncBatch).toHaveBeenCalledTimes(1);
    expect(sync.ack).toHaveBeenCalledWith(['i1']);
  });

  it('does nothing when the page is being hidden', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });

    await comeBackToThePage('hidden');

    expect(api.createAppResponseResult).not.toHaveBeenCalled();
    expect((await listQueue()).length).toBe(1);
  });

  // A submission is given a fixed number of attempts, and an answer of "still being processed" or
  // a server error uses one. Those attempts are for tries spread over time: the server can hold a
  // submission as "being processed" for ten minutes. Flipping between tabs must not spend them all
  // in a minute and leave the submission failed, which is never sent again.
  it('does not spend a submission’s attempts on tab switches', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 409, processing: true, error: 'This submission is already being processed.' });
    const sync = nativeBridge();
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Server error (500)', status: 500 });

    for (let i = 0; i < 12; i++) {
      await comeBackToThePage('hidden');
      now += 5_000;
      await comeBackToThePage('visible');
    }

    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(sync.fail).toHaveBeenCalledTimes(1);
  });

  it('tries again once enough time has passed', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 409, processing: true, error: 'This submission is already being processed.' });
    await comeBackToThePage();
    expect(api.createAppResponseResult).toHaveBeenCalledTimes(1);

    now += AUTO_FLUSH_SPACING_MS;
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 200, idempotent: true });
    await comeBackToThePage();

    expect(api.createAppResponseResult).toHaveBeenCalledTimes(2);
    expect(await listQueue()).toEqual([]);
  });

  // The demo keeps its submissions in the browser: "delivering" there would move a waiting
  // submission into the demo's local records and drop it from the queue.
  it('leaves the queue alone in the demo', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    demo.on = true;

    await comeBackToThePage();

    expect(api.createAppResponseResult).not.toHaveBeenCalled();
    expect((await listQueue()).length).toBe(1);
  });
});

describe('flushNativeQueue called while it is already running', () => {
  // Reconnecting, coming back to the page, opening an app and "Sync now" can all ask at once. A
  // second pass would read the same items from the runtime and post the same batch again.
  it('posts the batch once', async () => {
    const sync = nativeBridge();
    let answer!: (value: unknown) => void;
    vi.mocked(api.syncBatch).mockReturnValue(new Promise((resolve) => { answer = resolve; }) as never);

    const first = flushNativeQueue();
    const second = flushNativeQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer({ data: { results: [{ idempotencyKey: 'k1', success: true, responseId: 'r1', error: null }] } });

    expect(await second).toEqual({ flushed: 0, failed: 0 });
    expect(await first).toEqual({ flushed: 1, failed: 0 });
    expect(api.syncBatch).toHaveBeenCalledTimes(1);
    expect(sync.flush).toHaveBeenCalledTimes(1);
    expect(sync.ack).toHaveBeenCalledTimes(1);

    // And the guard is released: a later pass runs.
    vi.mocked(api.syncBatch).mockResolvedValue({ data: { results: [] } });
    await flushNativeQueue();
    expect(sync.flush).toHaveBeenCalledTimes(2);
  });
});
