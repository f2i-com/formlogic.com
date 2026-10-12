import { afterEach, describe, expect, it, vi } from 'vitest';

// A 2xx whose body is not JSON (a Wi-Fi sign-in page, an SPA fallback serving index.html for /api)
// is not FormLogic's answer, and the API layer says so (`unreadable`, no status). The native flush
// read the missing status as "the server was not reached" and kept the items as they were without
// using an attempt, so a server that always answers that way kept them waiting for ever. They now
// use an attempt each, with a reason that says what happened, as the browser queue's do.
vi.mock('../lib/api', () => ({
  api: { syncBatch: vi.fn(), isDemoMode: () => false },
  newIdempotencyKey: () => 'test-key',
}));

import { api } from '../lib/api';
import { flushNativeQueue } from './nativeOfflineQueue';

function runtimeWithOnePending() {
  const sync = {
    getQueue: vi.fn(async () => []),
    flush: vi.fn(async () => ({
      pending: [{
        appSlug: 'shop',
        items: [{ id: 'q_1', appSlug: 'shop', formId: 'orders', idempotencyKey: 'k1', answers: { item: 'tea' }, status: 'pending', attempts: 0, lastError: null, createdAt: '2026-10-12T00:00:00Z' }],
      }],
    })),
    ack: vi.fn(async () => ({ acked: 0, remaining: 1 })),
    fail: vi.fn(async () => ({ failed: 1 })),
  };
  (globalThis as unknown as { window?: unknown }).window = { FormLogicNative: { available: true, runtime: {}, sync } };
  return sync;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('the native flush and an answer that is not FormLogic\'s', () => {
  it('uses an attempt, with the reason, when a 2xx body is not JSON', async () => {
    const sync = runtimeWithOnePending();
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Invalid response from server', unreadable: true } as never);
    const result = await flushNativeQueue();
    expect(sync.fail).toHaveBeenCalledWith(['q_1'], 'The server answered in a way FormLogic does not recognise');
    expect(sync.ack).not.toHaveBeenCalled();
    expect(result).toEqual({ flushed: 0, failed: 1 });
  });

  it('still uses none when the server was not reached at all', async () => {
    const sync = runtimeWithOnePending();
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Failed to fetch' } as never);
    await flushNativeQueue();
    expect(sync.fail).not.toHaveBeenCalled();
    expect(sync.ack).not.toHaveBeenCalled();
  });
});
