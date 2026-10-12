import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A submission queued offline is delivered when the server can be reached again. A failure that
// only says the server was not reached (no response, 408, 429) must not use up one of the
// MAX_ATTEMPTS, or staying offline long enough would mark the submission permanently failed.
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const queue = () => enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' } });

describe('flushQueue while the server cannot be reached', () => {
  it('keeps a submission pending, with no attempt used, however many times a flush finds no network', async () => {
    await queue();
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 0, error: 'Failed to fetch' });
    for (let i = 0; i < 12; i++) await flushQueue();
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBe('Failed to fetch');
  });

  it('treats 408 and 429 the same way', async () => {
    await queue();
    vi.mocked(api.createAppResponseResult).mockResolvedValueOnce({ ok: false, status: 408, error: 'Request Timeout' });
    await flushQueue();
    vi.mocked(api.createAppResponseResult).mockResolvedValueOnce({ ok: false, status: 429, error: 'Too many requests' });
    await flushQueue();
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  // Maintenance mode answers 503 on every API route for as long as the admin leaves it on, and a
  // reverse proxy answers 502/504 while the app server is restarting. Each reconnect and each
  // "Sync now" in that time is a flush: eight of them must not turn the submission into a failed
  // one, which is never sent again.
  it.each([502, 503, 504])('keeps a submission pending, with no attempt used, through any number of %i answers', async (status) => {
    await queue();
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status, error: 'Down for maintenance' });
    for (let i = 0; i < 12; i++) expect(await flushQueue()).toEqual({ flushed: 0, failed: 0 });
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBe('Down for maintenance');
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201, response: { id: 'r1' } });
    expect(await flushQueue()).toEqual({ flushed: 1, failed: 0 });
  });

  it('stops the pass at the first unreachable result instead of sending every queued item into it', async () => {
    await queue();
    await queue();
    await queue();
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 0, error: 'Failed to fetch' });
    expect(await flushQueue()).toEqual({ flushed: 0, failed: 0 });
    expect(api.createAppResponseResult).toHaveBeenCalledTimes(1);
    expect((await listQueue()).map((row) => row.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('delivers it once the server answers', async () => {
    await queue();
    vi.mocked(api.createAppResponseResult).mockResolvedValueOnce({ ok: false, status: 0, error: 'Failed to fetch' });
    await flushQueue();
    vi.mocked(api.createAppResponseResult).mockResolvedValueOnce({ ok: true, status: 201, response: { id: 'r1' } });
    expect(await flushQueue()).toEqual({ flushed: 1, failed: 0 });
    expect(await listQueue()).toEqual([]);
  });
});

describe('flushQueue when the server refuses', () => {
  it('still uses an attempt per server error and gives up at the cap', async () => {
    await queue();
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 500, error: 'Server error (500)' });
    await flushQueue();
    expect((await listQueue())[0].attempts).toBe(1);
    for (let i = 0; i < 7; i++) await flushQueue();
    const [row] = await listQueue();
    expect(row.attempts).toBe(8);
    expect(row.status).toBe('failed');
  });
});

describe('flushQueue when something other than FormLogic answers', () => {
  // A captive portal on a plain-HTTP install answers the POST with its own 200 page. Through the
  // real api layer that must not read as a delivery that removes the submission. Nor as "not
  // reached": a page that answers every time (an SPA fallback for /api) then kept it waiting for
  // ever. It is an attempt (offlineQueue.unrecognised.test.ts follows it to the cap).
  it('keeps the submission, using an attempt, instead of deleting it as delivered', async () => {
    const { api: real } = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>Sign in to the Wi-Fi</title>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    vi.mocked(api.createAppResponseResult).mockImplementation((...args) => real.createAppResponseResult(...args));
    await queue();
    expect(await flushQueue()).toEqual({ flushed: 0, failed: 0 });
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
  });
});
