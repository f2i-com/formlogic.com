import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A record a flow run writes names that run (flowRunId), so the runs the record starts are the
// run's children and the server's depth ceiling stops a flow that writes into its own form. A
// write that could not be sent at once and was parked in the offline queue lost the name: sent
// later, its runs started a fresh chain, and a loop that kept going through the queue never met
// the ceiling.
vi.mock('../lib/api', () => ({
  api: { createAppResponseResult: vi.fn() },
  newIdempotencyKey: () => 'key',
}));
vi.mock('../lib/sessionGeneration', () => ({ currentSessionOwner: () => 'u1' }));

import { api } from '../lib/api';
import { enqueueSubmission, flushQueue, listQueue } from './offlineQueue';

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
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
  };
  return {
    open: () => {
      const req = { result: db, error: null, onsuccess: null as null | (() => void), onerror: null, onupgradeneeded: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  } as unknown as IDBFactory;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', memoryIndexedDB());
  vi.mocked(api.createAppResponseResult).mockReset();
  vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201, data: { response: { id: 'r1' } } } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a flow run\'s write parked in the offline queue', () => {
  it('is sent naming the run that made it', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1', flowRunId: 'run-7' });
    await flushQueue();
    expect(api.createAppResponseResult).toHaveBeenCalledWith('shop', 'orders', { answers: { item: 'tea' }, idempotencyKey: 'k1', flowRunId: 'run-7' });
    expect(await listQueue()).toEqual([]);
  });

  it('a person\'s own write, and a row stored before rows carried a run, name none', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k2' });
    await flushQueue();
    expect(api.createAppResponseResult).toHaveBeenCalledWith('shop', 'orders', { answers: { item: 'tea' }, idempotencyKey: 'k2' });
  });
});
