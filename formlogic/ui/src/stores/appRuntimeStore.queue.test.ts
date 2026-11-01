import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A submission made offline is kept on the device and the person is told "this will send by itself
// as soon as you're back online. You can close the app." The queue was flushed only by the
// browser's `online` event, which does not fire on a page that loads already online: someone who
// closed the app offline and opened it again with a connection kept their submission on the
// device until the connection happened to drop and return. Opening the app delivers what waits.
vi.mock('../lib/api', () => ({
  api: {
    getAppRuntime: vi.fn(),
    createAppResponse: vi.fn(),
    createAppResponseResult: vi.fn(),
    syncBatch: vi.fn(),
    onSessionExpired: vi.fn(),
    removeSessionExpiredCallback: vi.fn(),
    isDemoMode: () => false,
  },
  newIdempotencyKey: vi.fn(() => 'key'),
}));
vi.mock('../lib/sessionGeneration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sessionGeneration')>()),
  currentSessionOwner: () => 'u1',
}));
vi.mock('../client-runtime/desktop/desktopClient', () => ({ setConnectorCapabilityContext: vi.fn() }));
vi.mock('../client-runtime/connectors/packConnectorDriver', () => ({ syncPackConnectors: vi.fn() }));

import { api, newIdempotencyKey } from '../lib/api';
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
  const transaction = () => {
    const tx = { objectStore: () => store, oncomplete: null as null | (() => void) };
    setTimeout(() => tx.oncomplete?.());
    return tx;
  };
  const db = { objectStoreNames: { contains: () => true }, createObjectStore: () => store, transaction };
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
  vi.mocked(api.createAppResponse).mockReset();
  vi.mocked(api.createAppResponseResult).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opening an app with submissions waiting on the device', () => {
  it('sends them once the app has loaded', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.getAppRuntime).mockResolvedValue(runtime as never);
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201, response: { id: 'r1' } });

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

// The native runtime keeps its queue per app, not per account. A submission it queued for a
// session that then expired must wait for that account, not be sent under whoever signs in next
// on the device: it is queued stamped with the signed-in account (enqueueNativeSubmission).
describe('a submission made offline in the native runtime', () => {
  it('is queued there under the signed-in account', async () => {
    const enqueue = vi.fn(async () => ({ id: 'n1' }));
    vi.stubGlobal('window', { FormLogicNative: { available: true, sync: { enqueueSubmission: enqueue } } });
    vi.stubGlobal('navigator', { onLine: false });
    useAppRuntimeStore.setState({ appSlug: 'shop' });

    const result = await useAppRuntimeStore.getState().createResponse('orders', { item: 'tea' });

    expect(result).toMatchObject({ id: 'n1', queued: true });
    expect(enqueue).toHaveBeenCalledWith({ appSlug: 'shop', formId: 'orders', idempotencyKey: 'key', answers: { item: 'tea' }, ownerUserId: 'u1' });
    expect(await listQueue()).toEqual([]);
  });
});

// An online submit the server may have stored (a gateway answered 502) keeps its key for the retry.
// Going offline before that retry must not change it: the two copies would both be stored.
describe('a retry made offline', () => {
  beforeEach(() => {
    let keys = 0;
    vi.mocked(newIdempotencyKey).mockImplementation(() => `key-${++keys}`);
    useAppRuntimeStore.setState({ appSlug: 'shop' });
    vi.stubGlobal('window', {});
  });
  afterEach(() => {
    vi.mocked(newIdempotencyKey).mockImplementation(() => 'key');
  });

  async function failOnline(answers: Record<string, unknown>) {
    vi.mocked(api.createAppResponse).mockResolvedValueOnce({ error: 'Bad gateway', status: 502 } as never);
    await expect(useAppRuntimeStore.getState().createResponse('orders', answers)).rejects.toThrow('Bad gateway');
  }

  it('goes under a new key once the form\'s script has acted: the server stays closed to the old one', async () => {
    vi.mocked(api.createAppResponse).mockResolvedValueOnce({ error: 'Check first', status: 409, scriptRan: true } as never);
    await expect(useAppRuntimeStore.getState().createResponse('orders', { item: 'tea' })).rejects.toThrow('Check first');
    const firstKey = vi.mocked(api.createAppResponse).mock.calls[0][2].idempotencyKey;
    vi.mocked(api.createAppResponse).mockResolvedValueOnce({ data: { response: { id: 'r1' } } } as never);

    await useAppRuntimeStore.getState().createResponse('orders', { item: 'tea' });

    expect(vi.mocked(api.createAppResponse).mock.calls[1][2].idempotencyKey).not.toBe(firstKey);
  });

  it('queues the same answers under the key of the attempt that failed', async () => {
    await failOnline({ item: 'tea' });
    const firstKey = vi.mocked(api.createAppResponse).mock.calls[0][2].idempotencyKey;

    vi.stubGlobal('navigator', { onLine: false });
    await useAppRuntimeStore.getState().createResponse('orders', { item: 'tea' });

    const [row] = await listQueue();
    expect(row.idempotencyKey).toBe(firstKey);
  });

  it('queues changed answers under a new key: that is a new submission', async () => {
    await failOnline({ item: 'tea' });
    const firstKey = vi.mocked(api.createAppResponse).mock.calls[0][2].idempotencyKey;

    vi.stubGlobal('navigator', { onLine: false });
    await useAppRuntimeStore.getState().createResponse('orders', { item: 'coffee' });

    const [row] = await listQueue();
    expect(row.idempotencyKey).not.toBe(firstKey);
  });

  it('does not reuse a key once its submission is queued: the same answers again are another submission', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await useAppRuntimeStore.getState().createResponse('orders', { item: 'tea' });
    await useAppRuntimeStore.getState().createResponse('orders', { item: 'tea' });

    const keys = (await listQueue()).map((row) => row.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
});
