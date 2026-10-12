import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A submission the queue gives up on (eight refusals, or an idempotency key the server holds for a
// different submission) is marked 'failed' and never sent again. The person must be able to send it
// again or throw it away, and its answers must not stay on the device for good: a failed submission
// is removed some time after it failed, and everything an account queued goes when it signs out.
const owner = vi.hoisted(() => ({ id: 'u1' as string | null }));
vi.mock('../lib/api', () => ({
  api: { createAppResponseResult: vi.fn() },
  newIdempotencyKey: () => 'key',
}));
vi.mock('../lib/sessionGeneration', () => ({ currentSessionOwner: () => owner.id }));
// A submit that never reached the server also left a copy in Workbox's queue (see swQueue.ts).
vi.mock('../lib/swQueue', () => ({ discardBackgroundSyncCopies: vi.fn(async () => 0) }));

import { api } from '../lib/api';
import { discardBackgroundSyncCopies } from '../lib/swQueue';
import {
  FAILED_RETENTION_MS,
  discardSubmission,
  enqueueSubmission,
  flushQueue,
  listFailedSubmissions,
  listQueue,
  purgeQueueForOwner,
  queueCounts,
  retrySubmission,
  unsentCountFor,
  type QueuedSubmission,
} from './offlineQueue';

/** The one object store offlineQueue.ts uses ('submissions', keyPath 'id'), kept in memory. */
function memoryIndexedDB(rows: Map<string, unknown>): IDBFactory {
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

const DAY = 24 * 60 * 60 * 1000;
let rows: Map<string, unknown>;
let now = 1_800_000_000_000;

/** A row exactly as today's code stores it (no failedAt, no failure kind). */
function todaysRow(over: Partial<QueuedSubmission>): QueuedSubmission {
  return {
    id: 'r1',
    appSlug: 'shop',
    formId: 'orders',
    idempotencyKey: 'k1',
    answers: { item: 'tea', phone: '0400 000 000' },
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: now - 2 * DAY,
    ownerUserId: 'u1',
    ...over,
  };
}

beforeEach(() => {
  rows = new Map();
  owner.id = 'u1';
  now += 1000 * DAY;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('indexedDB', memoryIndexedDB(rows));
  vi.mocked(api.createAppResponseResult).mockReset();
  vi.mocked(discardBackgroundSyncCopies).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function giveUp(): Promise<QueuedSubmission> {
  const q = await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
  vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 500, error: 'Server error (500)' });
  for (let i = 0; i < 8; i++) await flushQueue();
  const [row] = await listQueue();
  expect(row.status).toBe('failed');
  return q;
}

describe('a submission the queue gave up on', () => {
  it('records when and why it failed', async () => {
    await giveUp();
    const [row] = await listQueue();
    expect(row.failedAt).toBe(now);
    expect(row.failure).toBe('gave-up');
  });

  it('records a conflict as a conflict', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 409, conflict: true, error: 'This idempotency key was already used with a different submission.' });
    await flushQueue();
    const [row] = await listQueue();
    expect(row.status).toBe('failed');
    expect(row.failure).toBe('conflict');
  });

  it('is listed for the person with what identifies it, and never its answers', async () => {
    const q = await giveUp();
    const listed = await listFailedSubmissions();
    expect(listed).toEqual([{ id: q.id, appSlug: 'shop', formId: 'orders', createdAt: q.createdAt, failedAt: now, conflict: false, unrecognised: false }]);
    expect(JSON.stringify(listed)).not.toContain('tea');
  });

  it('can be sent again: back to pending with its attempts reset, sent now under the same key', async () => {
    const q = await giveUp();
    vi.mocked(api.createAppResponseResult).mockReset().mockResolvedValue({ ok: true, status: 201, response: { id: 'r1' } });
    expect(await retrySubmission(q.id)).toBe('sent');
    expect(api.createAppResponseResult).toHaveBeenCalledTimes(1);
    expect(api.createAppResponseResult).toHaveBeenCalledWith('shop', 'orders', { answers: { item: 'tea' }, idempotencyKey: 'k1' });
    expect(await listQueue()).toEqual([]);
  });

  it('waits again, with a fresh set of attempts, when the retry finds no server', async () => {
    const q = await giveUp();
    vi.mocked(api.createAppResponseResult).mockReset().mockResolvedValue({ ok: false, status: 0, error: 'Failed to fetch' });
    expect(await retrySubmission(q.id)).toBe('waiting');
    const [row] = await listQueue();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.failedAt).toBeUndefined();
    expect(row.failure).toBeUndefined();
    expect(await queueCounts()).toEqual({ pending: 1, failed: 0 });
  });

  it('is not sent again when the server holds a different submission under its key', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 409, conflict: true, error: 'This idempotency key was already used with a different submission.' });
    await flushQueue();
    const [row] = await listQueue();
    expect((await listFailedSubmissions())[0].conflict).toBe(true);
    vi.mocked(api.createAppResponseResult).mockClear();
    expect(await retrySubmission(row.id)).toBe('conflict');
    expect(api.createAppResponseResult).not.toHaveBeenCalled();
    expect((await listQueue())[0].status).toBe('failed');
  });

  it('can be discarded, with the copy Workbox may hold of it', async () => {
    const q = await giveUp();
    expect(await discardSubmission(q.id)).toBe(true);
    expect(await listQueue()).toEqual([]);
    expect(discardBackgroundSyncCopies).toHaveBeenCalledWith('formSubmissionQueue', 'k1');
  });

  it('cannot be sent or discarded by another account', async () => {
    const q = await giveUp();
    owner.id = 'u2';
    expect(await discardSubmission(q.id)).toBe(false);
    expect(await retrySubmission(q.id)).toBe('missing');
    owner.id = 'u1';
    expect((await listQueue())[0].status).toBe('failed');
  });
});

describe('how long a failed submission stays on the device', () => {
  it(`is removed ${FAILED_RETENTION_MS / DAY} days after it failed, and not before`, async () => {
    expect(FAILED_RETENTION_MS).toBe(30 * DAY);
    rows.set('old', todaysRow({ id: 'old', status: 'failed', attempts: 8, failedAt: now - 30 * DAY - 1, failure: 'gave-up' }));
    rows.set('young', todaysRow({ id: 'young', idempotencyKey: 'k2', status: 'failed', attempts: 8, failedAt: now - 29 * DAY, failure: 'gave-up' }));
    expect((await listQueue()).map((r) => r.id)).toEqual(['young']);
    expect(await queueCounts()).toEqual({ pending: 0, failed: 1 });
  });

  it('never removes a pending submission of the signed-in account for its age', async () => {
    rows.set('r1', todaysRow({ createdAt: now - 400 * DAY }));
    expect(await listQueue()).toHaveLength(1);
  });
});

describe('rows stored before this change', () => {
  it('keep sending when pending', async () => {
    rows.set('r1', todaysRow({}));
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201, response: { id: 'r1' } });
    expect(await flushQueue()).toEqual({ flushed: 1, failed: 0 });
    expect(await listQueue()).toEqual([]);
  });

  it('when failed, get the whole retention period from the first time they are seen, not from when they were queued', async () => {
    rows.set('r1', todaysRow({ status: 'failed', attempts: 8, lastError: 'Server error (500)', createdAt: now - 90 * DAY }));
    const [row] = await listQueue();
    expect(row.failedAt).toBe(now);
    now += 29 * DAY;
    expect(await listQueue()).toHaveLength(1);
    now += 2 * DAY;
    expect(await listQueue()).toEqual([]);
  });

  it('when failed, can be sent again', async () => {
    rows.set('r1', todaysRow({ status: 'failed', attempts: 8, lastError: 'Server error (500)' }));
    expect((await listFailedSubmissions())[0].conflict).toBe(false);
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201, response: { id: 'r1' } });
    expect(await retrySubmission('r1')).toBe('sent');
    expect(api.createAppResponseResult).toHaveBeenCalledWith('shop', 'orders', { answers: { item: 'tea', phone: '0400 000 000' }, idempotencyKey: 'k1' });
  });

  it('when failed on a conflict, are known as one by their message', async () => {
    rows.set('r1', todaysRow({ status: 'failed', attempts: 1, lastError: 'This idempotency key was already used with a different submission.' }));
    expect((await listFailedSubmissions())[0].conflict).toBe(true);
    expect(await retrySubmission('r1')).toBe('conflict');
  });

  it('without an owner (from before rows had one) are listed, sent and discarded like the account’s own', async () => {
    rows.set('r1', todaysRow({ status: 'failed', attempts: 8, ownerUserId: undefined }));
    expect(await listFailedSubmissions()).toHaveLength(1);
    expect(await discardSubmission('r1')).toBe(true);
  });
});

describe('a flush under way', () => {
  it('does not bring back a submission discarded while it runs', async () => {
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'tea' }, idempotencyKey: 'k1' });
    rows.set('gone', todaysRow({ id: 'gone', idempotencyKey: 'k2', createdAt: now }));
    let release!: () => void;
    vi.mocked(api.createAppResponseResult).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: false, status: 500, error: 'Server error (500)' });
    }));
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: false, status: 500, error: 'Server error (500)' });
    const pass = flushQueue();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await discardSubmission('gone')).toBe(true);
    release();
    await pass;
    expect((await listQueue()).map((r) => r.idempotencyKey)).toEqual(['k1']);
    expect(api.createAppResponseResult).toHaveBeenCalledTimes(1);
  });

  it('is followed by another pass when a retry comes in while it runs, so the retried one is sent', async () => {
    const q = await giveUp();
    await enqueueSubmission({ appSlug: 'shop', formId: 'orders', answers: { item: 'coffee' }, idempotencyKey: 'k2' });
    let release!: () => void;
    vi.mocked(api.createAppResponseResult).mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 201, response: { id: 'r1' } });
    }));
    vi.mocked(api.createAppResponseResult).mockResolvedValue({ ok: true, status: 201, response: { id: 'r1' } });
    const pass = flushQueue();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const retried = retrySubmission(q.id);
    // Hold the pass until the retry has put the item back and asked for a flush of its own.
    await vi.waitFor(() => expect((rows.get(q.id) as QueuedSubmission).status).toBe('pending'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    release();
    await pass;
    expect(await retried).toBe('sent');
    expect(await listQueue()).toEqual([]);
  });
});

describe('when an account leaves the device', () => {
  it('counts what it would lose, and removes exactly that: its own rows and ownerless old ones', async () => {
    rows.set('mine', todaysRow({ id: 'mine' }));
    rows.set('mine-failed', todaysRow({ id: 'mine-failed', idempotencyKey: 'k2', status: 'failed', attempts: 8, failedAt: now }));
    rows.set('legacy', todaysRow({ id: 'legacy', idempotencyKey: 'k3', ownerUserId: undefined }));
    rows.set('theirs', todaysRow({ id: 'theirs', idempotencyKey: 'k4', ownerUserId: 'u2' }));
    rows.set('anon', todaysRow({ id: 'anon', idempotencyKey: 'k5', ownerUserId: null }));
    expect(await unsentCountFor('u1')).toBe(3);
    await purgeQueueForOwner('u1');
    expect((await listQueue()).map((r) => r.id).sort()).toEqual(['anon', 'theirs']);
    expect(await unsentCountFor('u1')).toBe(0);
  });
});

describe('a submission left behind by an account whose session expired', () => {
  it('waits for that account while nobody else is signed in, however old it is', async () => {
    rows.set('r1', todaysRow({ ownerUserId: 'u2', createdAt: now - 60 * DAY }));
    owner.id = null;
    expect(await listQueue()).toHaveLength(1);
  });

  it('is removed once it is older than the retention period and another account uses the device', async () => {
    rows.set('old', todaysRow({ id: 'old', ownerUserId: 'u2', createdAt: now - 31 * DAY }));
    rows.set('young', todaysRow({ id: 'young', idempotencyKey: 'k2', ownerUserId: 'u2', createdAt: now - 3 * DAY }));
    expect((await listQueue()).map((r) => r.id)).toEqual(['young']);
  });
});
