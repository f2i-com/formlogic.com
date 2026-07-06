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

/** A native bridge whose flush() returns exactly `items` grouped under a single appSlug. */
function makeBridge(items: ReturnType<typeof item>[]): Bridge {
  return {
    available: true,
    runtime: {},
    sync: {
      flush: vi.fn(async () => ({ pending: [{ appSlug: 'demo', items }] })),
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

describe('flushNativeQueue — idempotency-aware ack / fail / keep (task #10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acks success + idempotent replays, fails a conflict + generic error, and keeps a processing item', async () => {
    const items = [
      item('i-ok', 'k-ok', { a: 1 }),
      item('i-idem', 'k-idem', { a: 2 }),
      item('i-conflict', 'k-conflict', { a: 3 }),
      item('i-proc', 'k-proc', { a: 4 }),
      item('i-fail', 'k-fail', { a: 5 }),
    ];
    const bridge = makeBridge(items);
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({
      data: {
        results: [
          { idempotencyKey: 'k-ok', success: true, responseId: 'r1', error: null, status: 201, conflict: false, processing: false, idempotent: false },
          { idempotencyKey: 'k-idem', success: true, responseId: 'r2', error: null, status: 200, conflict: false, processing: false, idempotent: true },
          { idempotencyKey: 'k-conflict', success: false, responseId: null, error: 'This idempotency key was already used with a different submission.', status: 409, conflict: true, processing: false, idempotent: false },
          { idempotencyKey: 'k-proc', success: false, responseId: null, error: 'This submission is already being processed. Please retry in a moment.', status: 409, conflict: false, processing: true, idempotent: false },
          { idempotencyKey: 'k-fail', success: false, responseId: null, error: 'Validation failed', status: 400, conflict: false, processing: false, idempotent: false },
        ],
      },
    });

    const result = await flushNativeQueue();

    // ACK: fresh success AND idempotent replay — the server already holds both.
    expect(bridge.sync.ack).toHaveBeenCalledTimes(1);
    expect(bridge.sync.ack).toHaveBeenCalledWith(['i-ok', 'i-idem']);

    // FAIL: the conflict (terminal-fail once it exhausts the native attempt cap) and the generic
    // validation failure — but NOT the processing item.
    expect(bridge.sync.fail).toHaveBeenCalledTimes(1);
    const [failedIds] = bridge.sync.fail.mock.calls[0] as [string[], string];
    expect(failedIds).toEqual(['i-conflict', 'i-fail']);
    expect(failedIds).not.toContain('i-proc');

    // KEEP: the processing item is neither acked nor failed → it survives for the next flush.
    expect(bridge.sync.ack.mock.calls.flat(2)).not.toContain('i-proc');

    expect(result).toEqual({ flushed: 2, failed: 2 });
  });

  it('acks an idempotent replay even if success is false (a 200 replay carries idempotent:true)', async () => {
    const items = [item('i-idem', 'k-idem', { a: 1 })];
    const bridge = makeBridge(items);
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({
      data: {
        results: [
          { idempotencyKey: 'k-idem', success: false, responseId: 'r9', error: null, status: 200, conflict: false, processing: false, idempotent: true },
        ],
      },
    });

    const result = await flushNativeQueue();

    expect(bridge.sync.ack).toHaveBeenCalledWith(['i-idem']);
    expect(bridge.sync.fail).not.toHaveBeenCalled();
    expect(result).toEqual({ flushed: 1, failed: 0 });
  });

  it('keeps a processing-only batch entirely queued (no ack, no fail, counts as neither)', async () => {
    const items = [item('i-proc', 'k-proc', { a: 1 })];
    const bridge = makeBridge(items);
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({
      data: {
        results: [
          { idempotencyKey: 'k-proc', success: false, responseId: null, error: 'processing', status: 409, conflict: false, processing: true, idempotent: false },
        ],
      },
    });

    const result = await flushNativeQueue();

    expect(bridge.sync.ack).not.toHaveBeenCalled();
    expect(bridge.sync.fail).not.toHaveBeenCalled();
    expect(result).toEqual({ flushed: 0, failed: 0 });
  });

  it('still fails a plain success:false result with no idempotency flags (back-compat)', async () => {
    const items = [item('i-fail', 'k-fail', { a: 1 })];
    const bridge = makeBridge(items);
    setBridge(bridge);
    // A pre-#10 server that omits status/conflict/processing/idempotent must still be handled: a bare
    // success:false is a retryable failure.
    vi.mocked(api.syncBatch).mockResolvedValueOnce({
      data: {
        results: [
          { idempotencyKey: 'k-fail', success: false, responseId: null, error: 'Failed' },
        ],
      },
    });

    const result = await flushNativeQueue();

    expect(bridge.sync.ack).not.toHaveBeenCalled();
    expect(bridge.sync.fail).toHaveBeenCalledWith(['i-fail'], 'Failed');
    expect(result).toEqual({ flushed: 0, failed: 1 });
  });
});
