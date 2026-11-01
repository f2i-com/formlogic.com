import { afterEach, describe, expect, it, vi } from 'vitest';

// The native runtime's queue (sync_queue.rs) marks an item 'failed' at its attempt cap or on an
// idempotency conflict, and flush() never hands a failed item out again. The person must be able
// to send it again or discard it from the page, with the bridge every installed runtime has
// (enqueueSubmission, getQueue, ack), and a sign-out must leave none of it behind.
vi.mock('../lib/api', () => ({
  api: { syncBatch: vi.fn(), isDemoMode: () => false },
  newIdempotencyKey: () => 'test-key',
}));

import { api } from '../lib/api';
import {
  discardNativeSubmission,
  listNativeFailedSubmissions,
  nativeUnsentCount,
  purgeNativeQueue,
  retryNativeSubmission,
} from './nativeOfflineQueue';

interface Row {
  id: string;
  appSlug: string;
  formId: string;
  idempotencyKey: string;
  answers: Record<string, unknown>;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  failedAt?: number;
}

/** A bridge over an in-memory copy of the runtime's queue, with the runtime's own rules. */
function runtime(rows: Row[]) {
  let seq = 0;
  const sync = {
    getQueue: vi.fn(async () => structuredClone(rows)),
    flush: vi.fn(async () => {
      const pending = rows.filter((r) => r.status === 'pending');
      return { pending: pending.length ? [{ appSlug: 'shop', items: structuredClone(pending) }] : [] };
    }),
    enqueueSubmission: vi.fn(async (item: Record<string, unknown>) => {
      // sync_queue.rs from_incoming: an id the page gives is kept; else a fresh one.
      const id = typeof item.id === 'string' && item.id ? item.id : `q_new_${++seq}`;
      rows.push({
        id,
        appSlug: 'shop',
        formId: String(item.formId),
        idempotencyKey: String(item.idempotencyKey),
        answers: item.answers as Record<string, unknown>,
        status: 'pending',
        attempts: Math.min(Number(item.attempts ?? 0), 8), // MAX_SYNC_ATTEMPTS
        lastError: null,
        createdAt: typeof item.createdAt === 'string' && item.createdAt ? item.createdAt : '2026-10-12T00:00:00Z',
      });
      return { id };
    }),
    ack: vi.fn(async (ids: string[]) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i].id)) rows.splice(i, 1);
      return { acked: before - rows.length, remaining: rows.length };
    }),
    fail: vi.fn(async () => ({ failed: 0 })),
  };
  (globalThis as unknown as { window?: unknown }).window = { FormLogicNative: { available: true, runtime: {}, sync } };
  return sync;
}

const failedRow = (over: Partial<Row> = {}): Row => ({
  id: 'q_1',
  appSlug: 'shop',
  formId: 'orders',
  idempotencyKey: 'k1',
  answers: { item: 'tea', phone: '0400 000 000' },
  status: 'failed',
  attempts: 5,
  lastError: 'Server error (500)',
  createdAt: '2026-10-01T09:30:00Z',
  ...over,
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('failed submissions in the native queue', () => {
  it('are listed with what identifies them, and never their answers', async () => {
    runtime([failedRow(), failedRow({ id: 'q_2', idempotencyKey: 'k2', status: 'pending', attempts: 1 })]);
    const listed = await listNativeFailedSubmissions();
    expect(listed).toEqual([
      { id: 'q_1', appSlug: 'shop', formId: 'orders', createdAt: Date.parse('2026-10-01T09:30:00Z'), failedAt: null, conflict: false, scriptRan: false },
    ]);
    expect(JSON.stringify(listed)).not.toContain('tea');
  });

  it('take the time they failed from a runtime that records it (seconds)', async () => {
    runtime([failedRow({ failedAt: 1_790_000_000 })]);
    expect((await listNativeFailedSubmissions())[0].failedAt).toBe(1_790_000_000_000);
  });

  it('are known as a conflict by the message the flush stored', async () => {
    runtime([
      failedRow({ id: 'a', lastError: 'This idempotency key was already used with a different submission.', attempts: 0 }),
      failedRow({ id: 'b', lastError: 'Idempotency conflict', attempts: 0 }),
    ]);
    expect((await listNativeFailedSubmissions()).map((i) => i.conflict)).toEqual([true, true]);
  });

  it('can be sent again: queued afresh under the same key with its attempts reset, the failed one removed, and sent now', async () => {
    const rows = [failedRow()];
    const sync = runtime(rows);
    vi.mocked(api.syncBatch).mockImplementation(async (_slug, items) => ({
      data: { results: items.map((i) => ({ idempotencyKey: i.idempotencyKey, success: true })) },
    }) as never);
    expect(await retryNativeSubmission('q_1')).toBe('sent');
    const queued = sync.enqueueSubmission.mock.calls[0][0] as Record<string, unknown>;
    // No id: the runtime would keep it, and acknowledging the old item would then remove both.
    expect(queued.id).toBeUndefined();
    expect(queued).toMatchObject({ formId: 'orders', idempotencyKey: 'k1', answers: { item: 'tea', phone: '0400 000 000' }, attempts: 0, createdAt: '2026-10-01T09:30:00Z' });
    expect(sync.ack).toHaveBeenCalledWith(['q_1']);
    expect(api.syncBatch).toHaveBeenCalledWith('shop', [{ idempotencyKey: 'k1', formId: 'orders', answers: { item: 'tea', phone: '0400 000 000' } }]);
    expect(rows).toEqual([]);
  });

  it('wait in the queue again when the retry finds no server', async () => {
    const rows = [failedRow()];
    runtime(rows);
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Failed to fetch' } as never);
    expect(await retryNativeSubmission('q_1')).toBe('waiting');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0, idempotencyKey: 'k1' });
  });

  it('go under a new key when the form\'s script acted: the server stays closed to the old one', async () => {
    const rows = [failedRow({ lastError: 'Your answers could not be saved, but this form\'s script has already run.' })];
    const sync = runtime(rows);
    vi.mocked(api.syncBatch).mockImplementation(async (_slug, items) => ({
      data: { results: items.map((i) => ({ idempotencyKey: i.idempotencyKey, success: true })) },
    }) as never);

    expect(await retryNativeSubmission('q_1')).toBe('sent');

    expect((sync.enqueueSubmission.mock.calls[0][0] as Record<string, unknown>).idempotencyKey).toBe('test-key');
  });

  it('are not sent again when the server holds a different submission under the key', async () => {
    const rows = [failedRow({ lastError: 'This idempotency key was already used with a different submission.', attempts: 0 })];
    const sync = runtime(rows);
    expect(await retryNativeSubmission('q_1')).toBe('conflict');
    expect(sync.enqueueSubmission).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('failed');
  });

  it('can be discarded', async () => {
    const rows = [failedRow()];
    const sync = runtime(rows);
    expect(await discardNativeSubmission('q_1')).toBe(true);
    expect(sync.ack).toHaveBeenCalledWith(['q_1']);
    expect(rows).toEqual([]);
  });

  it('are counted, with the pending ones, and all removed when the account signs out', async () => {
    const rows = [failedRow(), failedRow({ id: 'q_2', idempotencyKey: 'k2', status: 'pending', attempts: 1 })];
    runtime(rows);
    expect(await nativeUnsentCount()).toBe(2);
    await purgeNativeQueue();
    expect(rows).toEqual([]);
    expect(await nativeUnsentCount()).toBe(0);
  });

  it('are nothing to act on in a browser without the native runtime', async () => {
    (globalThis as unknown as { window?: unknown }).window = {};
    expect(await listNativeFailedSubmissions()).toEqual([]);
    expect(await nativeUnsentCount()).toBe(0);
    expect(await retryNativeSubmission('q_1')).toBe('missing');
    expect(await discardNativeSubmission('q_1')).toBe(false);
    await expect(purgeNativeQueue()).resolves.toBeUndefined();
  });
});
