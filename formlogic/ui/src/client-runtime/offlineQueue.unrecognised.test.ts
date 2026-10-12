import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A queued submission counts as delivered only when the server answers the way the submit
// endpoint answers an accepted one (AppPublicController::processSubmission): 201 with
// {response: {id}}, or 200 with {response: {id}, idempotent: true} for a replay. Anything else
// that comes back 2xx was not FormLogic storing it:
//   - an SPA fallback serving index.html for /api, or a proxy's own page, answers 200 every time
//     and never changes. Read as "not reached", it left the submission pending for ever;
//   - an interceptor that speaks JSON answering 200 with any object was taken as delivered, and
//     the submission was deleted though nothing was stored.
// Both now use up an attempt, so such a submission ends as failed, saying why, and can be sent
// again or discarded.
const owner = vi.hoisted(() => ({ id: 'u1' as string | null }));
vi.mock('../lib/api', () => ({
  api: { createAppResponseResult: vi.fn() },
  newIdempotencyKey: () => 'key',
}));
vi.mock('../lib/sessionGeneration', () => ({ currentSessionOwner: () => owner.id }));
vi.mock('../lib/swQueue', () => ({ discardBackgroundSyncCopies: vi.fn(async () => 0) }));

import { api } from '../lib/api';
import {
  UNRECOGNISED_REPLY,
  classifyDeliveryResult,
  enqueueSubmission,
  flushQueue,
  listFailedSubmissions,
  listQueue,
  retrySubmission,
  type QueuedSubmission,
} from './offlineQueue';

/** The one object store offlineQueue.ts uses ('submissions', keyPath 'id'), kept in memory. */
let rows: Map<string, unknown>;
function memoryIndexedDB(): IDBFactory {
  rows = new Map<string, unknown>();
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

beforeEach(async () => {
  owner.id = 'u1';
  vi.stubGlobal('indexedDB', memoryIndexedDB());
  vi.stubGlobal('document', { cookie: '' });
  // Every request goes through the real api layer to a stubbed network.
  const { api: real } = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  vi.mocked(api.createAppResponseResult).mockReset().mockImplementation((...args) => real.createAppResponseResult(...args));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const indexPage = () => new Response('<!doctype html><html><head><title>FormLogic</title></head><body><div id="root"></div></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const answer = (reply: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => reply()));
const queue = (key = 'k1') => enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: key });

describe('classifyDeliveryResult on a 2xx', () => {
  it('delivers what the endpoint answers for an accepted submission, and for a replay of one', () => {
    expect(classifyDeliveryResult({ ok: true, status: 201, response: { id: 'r1', status: 'submitted' } }).outcome).toBe('delivered');
    expect(classifyDeliveryResult({ ok: true, status: 200, response: { id: 'r1' }, idempotent: true }).outcome).toBe('delivered');
  });

  it('counts anything else as an attempt, saying the answer was not recognised', () => {
    for (const response of [undefined, null, {}, { id: '' }, { id: 7 }, 'ok', [{ id: 'r1' }]]) {
      const c = classifyDeliveryResult({ ok: true, status: 200, response });
      expect(c.outcome, JSON.stringify(response)).toBe('unrecognised');
      expect(c.error).toBe(UNRECOGNISED_REPLY);
    }
    expect(UNRECOGNISED_REPLY).toMatch(/server answered in a way FormLogic does not recognise/i);
  });
});

describe('a queued submission answered 2xx by something that is not the submit endpoint', () => {
  it('uses up an attempt on an SPA fallback page, instead of waiting for ever', async () => {
    await queue();
    answer(indexPage);
    expect(await flushQueue()).toEqual({ flushed: 0, failed: 0 });
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe(UNRECOGNISED_REPLY);
  });

  it('is not deleted as delivered when an interceptor answers 200 with some other JSON', async () => {
    await queue();
    answer(() => json(200, { ok: true }));
    expect(await flushQueue()).toEqual({ flushed: 0, failed: 0 });
    const [row] = await listQueue();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe(UNRECOGNISED_REPLY);
  });

  it('ends as failed at the attempt cap, with that reason, ready to send again or discard', async () => {
    await queue();
    answer(indexPage);
    for (let i = 0; i < 7; i++) await flushQueue();
    expect(await flushQueue()).toEqual({ flushed: 0, failed: 1 });
    const [row] = await listQueue();
    expect(row.status).toBe('failed');
    expect(row.failure).toBe('unrecognised');
    const [listed] = await listFailedSubmissions();
    expect(listed.unrecognised).toBe(true);
    expect(listed.conflict).toBe(false);
  });

  it('tells a retry answered the same way apart from one that found no server', async () => {
    await queue();
    answer(indexPage);
    for (let i = 0; i < 8; i++) await flushQueue();
    const [row] = await listQueue();
    expect(await retrySubmission(row.id)).toBe('unrecognised');
    answer(() => json(201, { response: { id: 'r1' } }));
    expect(await flushQueue()).toEqual({ flushed: 1, failed: 0 });
    expect(await listQueue()).toEqual([]);
  });

  // The reason is the last answer's: a retry that never got as far as this submission (an older
  // one ahead of it met maintenance, which ends the pass) must not repeat the earlier reason.
  it('does not give an earlier reason for a retry that was not answered at all', async () => {
    const now = Date.now();
    rows.set('older', { id: 'older', appSlug: 'shop', formId: 'orders', idempotencyKey: 'k0', answers: { item: 'tea' }, status: 'pending', attempts: 0, lastError: null, createdAt: now - 2000, ownerUserId: 'u1' } satisfies QueuedSubmission);
    rows.set('r1', { id: 'r1', appSlug: 'shop', formId: 'orders', idempotencyKey: 'k1', answers: { item: 'tea' }, status: 'failed', attempts: 8, lastError: UNRECOGNISED_REPLY, createdAt: now - 1000, ownerUserId: 'u1', failedAt: now, failure: 'unrecognised' } satisfies QueuedSubmission);
    answer(() => json(503, { error: true, message: 'Down for maintenance' }));
    expect(await retrySubmission('r1')).toBe('waiting');
  });

  it('still delivers once the real endpoint answers', async () => {
    await queue('k1');
    await queue('k2');
    answer(indexPage);
    await flushQueue();
    answer(() => json(201, { response: { id: 'r1' } }));
    expect(await flushQueue()).toEqual({ flushed: 2, failed: 0 });
    expect(await listQueue()).toEqual([]);
  });
});
