import { afterEach, describe, expect, it, vi } from 'vitest';

// The native runtime keeps its queue per app, not per account, and cannot see who is signed in:
// the WebView holds the session. So the page stamps the account on what it queues (ownerUserId,
// as in the browser queue, audit FL-09) and sends an item only while that account is signed in.
// A submission queued before a session expired then waits for its own account, instead of being
// sent under whoever signs in next on the device. Items from before items carried an owner are
// sent by whoever is signed in, as they were.
vi.mock('../lib/api', () => ({
  api: { syncBatch: vi.fn(), isDemoMode: () => false },
  newIdempotencyKey: () => 'test-key',
}));

import { api } from '../lib/api';
import { setSessionOwner } from '../lib/sessionGeneration';
import {
  discardNativeSubmission,
  enqueueNativeSubmission,
  flushNativeQueue,
  listNativeFailedSubmissions,
  nativeQueueCounts,
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
  ownerUserId?: string | null;
}

/** A bridge over an in-memory copy of the runtime's queue, with the runtime's own rules (sync_queue.rs). */
function runtime(rows: Row[]) {
  let seq = 0;
  const sync = {
    getQueue: vi.fn(async () => structuredClone(rows)),
    flush: vi.fn(async () => {
      const pending = rows.filter((r) => r.status === 'pending');
      return { pending: pending.length ? [{ appSlug: 'shop', items: structuredClone(pending) }] : [] };
    }),
    enqueueSubmission: vi.fn(async (item: Record<string, unknown>) => {
      const id = typeof item.id === 'string' && item.id ? item.id : `q_new_${++seq}`;
      rows.push({
        id,
        appSlug: 'shop',
        formId: String(item.formId),
        idempotencyKey: String(item.idempotencyKey),
        answers: item.answers as Record<string, unknown>,
        status: 'pending',
        attempts: Math.min(Number(item.attempts ?? 0), 8),
        lastError: null,
        createdAt: typeof item.createdAt === 'string' && item.createdAt ? item.createdAt : '2026-10-12T00:00:00Z',
        // Kept as given: absent stays absent, null stays null.
        ...('ownerUserId' in item ? { ownerUserId: item.ownerUserId as string | null } : {}),
      });
      return { id };
    }),
    ack: vi.fn(async (ids: string[]) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i].id)) rows.splice(i, 1);
      return { acked: before - rows.length, remaining: rows.length };
    }),
    fail: vi.fn(async (ids: string[]) => ({ failed: ids.length })),
  };
  (globalThis as unknown as { window?: unknown }).window = { FormLogicNative: { available: true, runtime: {}, sync } };
  return sync;
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  appSlug: 'shop',
  formId: 'orders',
  idempotencyKey: `k-${id}`,
  answers: { item: id },
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2026-10-01T09:30:00Z',
  ...over,
});

/** The four shapes a queue can hold: the signed-in account's, another account's, one made signed out, and one from before items carried an owner. */
const mixed = (): Row[] => [
  row('mine', { ownerUserId: 'u1' }),
  row('theirs', { ownerUserId: 'u2' }),
  row('anonymous', { ownerUserId: null }),
  row('legacy'),
];

function acceptEverything() {
  vi.mocked(api.syncBatch).mockImplementation(async (_slug, items) => ({
    data: { results: items.map((i) => ({ idempotencyKey: i.idempotencyKey, success: true })) },
  }) as never);
}

afterEach(() => {
  setSessionOwner(null);
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('the native queue and the account that queued an item', () => {
  it('stamps the signed-in account on what the page queues', async () => {
    const rows: Row[] = [];
    runtime(rows);
    setSessionOwner('u1');
    const { id } = await enqueueNativeSubmission({ appSlug: 'shop', formId: 'orders', idempotencyKey: 'k1', answers: { a: 1 } });
    expect(rows).toEqual([expect.objectContaining({ id, ownerUserId: 'u1', idempotencyKey: 'k1', answers: { a: 1 } })]);
    // Signed out, the stamp is null: such an item is not sent under an account that signs in later.
    setSessionOwner(null);
    await enqueueNativeSubmission({ appSlug: 'shop', formId: 'orders', idempotencyKey: 'k2', answers: {} });
    expect(rows[1].ownerUserId).toBeNull();
  });

  it('refuses to queue without the native queue, so the caller uses the browser one', async () => {
    (globalThis as unknown as { window?: unknown }).window = {};
    await expect(enqueueNativeSubmission({ appSlug: 'shop', formId: 'orders', idempotencyKey: 'k', answers: {} })).rejects.toThrow();
  });

  it('sends only the signed-in account’s items and the ones from before items carried an owner', async () => {
    const rows = mixed();
    const sync = runtime(rows);
    setSessionOwner('u1');
    acceptEverything();
    expect(await flushNativeQueue()).toEqual({ flushed: 2, failed: 0 });
    const sent = vi.mocked(api.syncBatch).mock.calls.flatMap(([, items]) => items.map((i) => i.idempotencyKey));
    expect(sent.sort()).toEqual(['k-legacy', 'k-mine']);
    // Another account's item, and one made signed out, wait: neither acknowledged nor failed.
    expect(rows.map((r) => r.id).sort()).toEqual(['anonymous', 'theirs']);
    expect(sync.fail).not.toHaveBeenCalled();
    // When that account signs in again, its item is sent.
    setSessionOwner('u2');
    expect(await flushNativeQueue()).toEqual({ flushed: 1, failed: 0 });
    expect(rows.map((r) => r.id)).toEqual(['anonymous']);
  });

  it('sends nothing when no item is the signed-in account’s', async () => {
    runtime([row('theirs', { ownerUserId: 'u2' })]);
    setSessionOwner('u1');
    expect(await flushNativeQueue()).toEqual({ flushed: 0, failed: 0 });
    expect(api.syncBatch).not.toHaveBeenCalled();
  });

  it('counts and lists only what the signed-in account may act on', async () => {
    runtime([
      ...mixed(),
      row('mine-failed', { ownerUserId: 'u1', status: 'failed', attempts: 8 }),
      row('theirs-failed', { ownerUserId: 'u2', status: 'failed', attempts: 8 }),
    ]);
    setSessionOwner('u1');
    expect(await nativeQueueCounts()).toEqual({ pending: 2, failed: 1 });
    expect((await listNativeFailedSubmissions()).map((i) => i.id)).toEqual(['mine-failed']);
  });

  it('does not let one account send again or discard another account’s item', async () => {
    const rows = [row('theirs-failed', { ownerUserId: 'u2', status: 'failed', attempts: 8 })];
    const sync = runtime(rows);
    setSessionOwner('u1');
    expect(await retryNativeSubmission('theirs-failed')).toBe('missing');
    expect(await discardNativeSubmission('theirs-failed')).toBe(false);
    expect(sync.enqueueSubmission).not.toHaveBeenCalled();
    expect(sync.ack).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('keeps the account on an item sent again', async () => {
    const rows = [row('mine-failed', { ownerUserId: 'u1', status: 'failed', attempts: 8 }), row('legacy-failed', { status: 'failed', attempts: 5 })];
    const sync = runtime(rows);
    setSessionOwner('u1');
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Failed to fetch' } as never);
    expect(await retryNativeSubmission('mine-failed')).toBe('waiting');
    expect(await retryNativeSubmission('legacy-failed')).toBe('waiting');
    expect(sync.enqueueSubmission.mock.calls.map(([item]) => (item as Record<string, unknown>).ownerUserId)).toEqual(['u1', 'u1']);
  });

  it('removes at sign-out the leaving account’s items and the unowned ones, and counts exactly those first', async () => {
    const rows = mixed();
    runtime(rows);
    expect(await nativeUnsentCount('u1')).toBe(2);
    await purgeNativeQueue('u1');
    expect(rows.map((r) => r.id).sort()).toEqual(['anonymous', 'theirs']);
    expect(await nativeUnsentCount('u1')).toBe(0);
  });

  it('removes every item of the app when the caller names no account, as before', async () => {
    const rows = mixed();
    runtime(rows);
    expect(await nativeUnsentCount()).toBe(4);
    await purgeNativeQueue();
    expect(rows).toEqual([]);
  });
});
