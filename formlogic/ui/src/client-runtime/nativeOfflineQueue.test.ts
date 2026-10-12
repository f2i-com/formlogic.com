import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api layer so flushNativeQueue never hits the network. The factory is hoisted, so it must be
// self-contained (no outer refs); we read the mock back via `import { api }` below.
vi.mock('../lib/api', () => ({
  api: { syncBatch: vi.fn() },
  newIdempotencyKey: () => 'test-key',
}));

import { api } from '../lib/api';
import { flushNativeQueue } from './nativeOfflineQueue';

interface Bridge {
  available: boolean;
  runtime: Record<string, unknown>;
  sync: {
    flush: ReturnType<typeof vi.fn>;
    ack: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    getQueue: ReturnType<typeof vi.fn>;
    enqueueSubmission: ReturnType<typeof vi.fn>;
  };
}

function item(id: string, key: string, answers: Record<string, unknown>) {
  return { id, appSlug: 'demo', formId: 'f1', idempotencyKey: key, answers, status: 'pending', attempts: 1, lastError: null };
}

function makeBridge(): Bridge {
  return {
    available: true,
    runtime: {},
    sync: {
      flush: vi.fn(async () => ({
        pending: [{ appSlug: 'demo', items: [item('i1', 'k1', { a: 1 }), item('i2', 'k2', { a: 2 })] }],
      })),
      ack: vi.fn(async (ids: string[]) => ({ acked: ids.length, remaining: 0 })),
      fail: vi.fn(async (ids: string[]) => ({ failed: ids.length })),
      getQueue: vi.fn(async () => []),
      enqueueSubmission: vi.fn(),
    },
  };
}

function setBridge(bridge: Bridge | null): void {
  (globalThis as unknown as { window?: unknown }).window = bridge ? { FormLogicNative: bridge } : {};
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('flushNativeQueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs the flushed batch, then acks accepted items and fails the rest', async () => {
    const bridge = makeBridge();
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({
      data: {
        results: [
          { idempotencyKey: 'k1', success: true, responseId: 'r1', error: null },
          { idempotencyKey: 'k2', success: false, responseId: null, error: 'Validation failed' },
        ],
      },
    });

    const result = await flushNativeQueue();

    expect(api.syncBatch).toHaveBeenCalledTimes(1);
    expect(api.syncBatch).toHaveBeenCalledWith('demo', [
      { idempotencyKey: 'k1', formId: 'f1', answers: { a: 1 } },
      { idempotencyKey: 'k2', formId: 'f1', answers: { a: 2 } },
    ]);
    expect(bridge.sync.ack).toHaveBeenCalledWith(['i1']);
    expect(bridge.sync.fail).toHaveBeenCalledWith(['i2'], 'Validation failed');
    expect(result).toEqual({ flushed: 1, failed: 1 });
  });

  it('keeps every item (fail, retryable) when the server refuses the whole batch', async () => {
    const bridge = makeBridge();
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({ error: 'Server error (500)', status: 500 });

    const result = await flushNativeQueue();

    expect(bridge.sync.ack).not.toHaveBeenCalled();
    expect(bridge.sync.fail).toHaveBeenCalledWith(['i1', 'i2'], 'Server error (500)');
    expect(result).toEqual({ flushed: 0, failed: 2 });
  });

  // The server was not reached (the api layer gives no status), or asked to be tried later: nothing
  // was judged, so sync.fail, which uses up one of the runtime's attempts, is not called. The items
  // stay queued exactly as they were; the native flush() never changes attempts on its own.
  it.each([
    ['no response at all', { error: 'Failed to fetch' }],
    ['408 Request Timeout', { error: 'Request Timeout', status: 408 }],
    ['429 Too Many Requests', { error: 'Too many requests', status: 429 }],
    // Maintenance mode answers 503 on every API route; a gateway answers 502/504 while the app
    // server is down.
    ['502 Bad Gateway', { error: 'Server error (502)', status: 502 }],
    ['503 from maintenance mode', { error: 'Down for maintenance', status: 503 }],
    ['504 Gateway Timeout', { error: 'Server error (504)', status: 504 }],
  ])('leaves every item queued, with no attempt used, when the batch meets %s', async (_name, response) => {
    const bridge = makeBridge();
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce(response);

    const result = await flushNativeQueue();

    expect(bridge.sync.ack).not.toHaveBeenCalled();
    expect(bridge.sync.fail).not.toHaveBeenCalled();
    expect(result).toEqual({ flushed: 0, failed: 0 });
  });

  it('stops after the first batch that cannot reach the server', async () => {
    const bridge = makeBridge();
    bridge.sync.flush.mockResolvedValueOnce({
      pending: [
        { appSlug: 'one', items: [item('i1', 'k1', { a: 1 })] },
        { appSlug: 'two', items: [item('i2', 'k2', { a: 2 })] },
      ],
    });
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Failed to fetch' });

    await flushNativeQueue();

    expect(api.syncBatch).toHaveBeenCalledTimes(1);
    expect(bridge.sync.fail).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no native bridge', async () => {
    setBridge(null);
    const result = await flushNativeQueue();
    expect(api.syncBatch).not.toHaveBeenCalled();
    expect(result).toEqual({ flushed: 0, failed: 0 });
  });
});
