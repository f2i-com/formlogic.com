import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A submission made offline is kept on the device and the person is told "this will send by itself
// as soon as you're back online. You can close the app." The queue was flushed only by the
// browser's `online` event, which does not fire on a page that loads already online: someone who
// closed the app offline and opened it again with a connection kept their submission on the
// device until the connection happened to drop and return. Opening the app delivers what waits.
vi.mock('../lib/api', () => ({
  api: {
    getAppRuntime: vi.fn(),
    createAppResponseResult: vi.fn(),
    syncBatch: vi.fn(),
    onSessionExpired: vi.fn(),
    removeSessionExpiredCallback: vi.fn(),
    isDemoMode: () => false,
  },
  newIdempotencyKey: () => 'key',
}));
vi.mock('../lib/sessionGeneration', () => ({ currentSessionOwner: () => 'u1' }));
vi.mock('../client-runtime/desktop/desktopClient', () => ({ setConnectorCapabilityContext: vi.fn() }));
vi.mock('../client-runtime/connectors/packConnectorDriver', () => ({ syncPackConnectors: vi.fn() }));

import { api } from '../lib/api';
import { enqueueSubmission, isFlushing, listQueue } from '../client-runtime/offlineQueue';
import { useAppRuntimeStore } from './appRuntimeStore';

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

const runtime = { data: { app: { id: 'a1', slug: 'shop', name: 'Shop' }, forms: [], permissions: { formLevel: {} }, user: {} } };

/** The flush is started by initialize(), not awaited by it. */
async function flushSettled() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!isFlushing()) return;
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', memoryIndexedDB());
  vi.mocked(api.getAppRuntime).mockReset();
  vi.mocked(api.createAppResponseResult).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opening an app with submissions waiting on the device', () => {
  it('sends them once the app has loaded', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.getAppRuntime).mockResolvedValue(runtime as never);
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201 });

    await useAppRuntimeStore.getState().initialize('shop');
    await flushSettled();

    expect(api.createAppResponseResult).toHaveBeenCalledWith('shop', 'orders', { answers: { item: 'tea' }, idempotencyKey: 'k1' });
    expect(await listQueue()).toEqual([]);
  });

  it('leaves them waiting, untouched, when the app could not be loaded', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.getAppRuntime).mockResolvedValue({ error: 'Failed to fetch' } as never);

    await useAppRuntimeStore.getState().initialize('shop');
    await flushSettled();

    expect(api.createAppResponseResult).not.toHaveBeenCalled();
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });
});
