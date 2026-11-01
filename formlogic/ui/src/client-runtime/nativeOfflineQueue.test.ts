import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api layer so flushNativeQueue never hits the network. The factory is hoisted, so it must be
// self-contained (no outer refs); we read the mock back via `import { api }` below.
vi.mock('../lib/api', () => ({
  api: { syncBatch: vi.fn() },
  newIdempotencyKey: () => 'test-key',
}));

import { api } from '../lib/api';
import { bumpSessionGeneration } from '../lib/sessionGeneration';
import { flushNativeQueue, isNativeFlushing } from './nativeOfflineQueue';
import { subscribeQueue } from './offlineQueue';

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
    expect(result).toEqual({ flushed: 1, failed: 0 }); // i2 used an attempt and is still queued
  });

  it('keeps every item (fail, retryable) when the server refuses the whole batch', async () => {
    const bridge = makeBridge();
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({ error: 'Server error (500)', status: 500 });

    const result = await flushNativeQueue();

    expect(bridge.sync.ack).not.toHaveBeenCalled();
    expect(bridge.sync.fail).toHaveBeenCalledWith(['i1', 'i2'], 'Server error (500)');
    expect(result).toEqual({ flushed: 0, failed: 0 });
  });

  // "Sync now" says "N submissions failed to sync", so only an item that has run out of attempts
  // counts; the runtime alone knows which those are, and says so in the item's status.
  it('counts as failed only the items the runtime has given up on', async () => {
    const bridge = makeBridge();
    bridge.sync.getQueue.mockResolvedValue([{ ...item('i1', 'k1', {}), status: 'failed' }, item('i2', 'k2', {})]);
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({ error: 'Server error (500)', status: 500 });

    expect(await flushNativeQueue()).toEqual({ flushed: 0, failed: 1 });
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

  // The runtime holds 500 items or 10 MB for an app, and the server takes 100 items or 2 MB in one
  // POST. Sent in one, a backlog was refused whole and every item used an attempt, until all of it
  // read "could not be sent after several tries".
  describe('a group larger than one POST', () => {
    function bridgeHolding(items: ReturnType<typeof item>[]): Bridge {
      const bridge = makeBridge();
      bridge.sync.flush.mockResolvedValue({ pending: [{ appSlug: 'demo', items }] });
      setBridge(bridge);
      return bridge;
    }
    function acceptEverything(): void {
      vi.mocked(api.syncBatch).mockImplementation(async (_slug, items) => ({
        data: { results: items.map((i) => ({ idempotencyKey: i.idempotencyKey, success: true, responseId: 'r', error: null })) },
      }));
    }
    const sizes = () => vi.mocked(api.syncBatch).mock.calls.map(([, items]) => items.length);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

    it('goes in POSTs of at most 100 items, in queue order', async () => {
      const items = Array.from({ length: 250 }, (_, n) => item(`i${n}`, `k${n}`, { n }));
      const bridge = bridgeHolding(items);
      acceptEverything();

      expect(await flushNativeQueue()).toEqual({ flushed: 250, failed: 0 });

      expect(sizes()).toEqual([100, 100, 50]);
      const sent = vi.mocked(api.syncBatch).mock.calls.flatMap(([, batch]) => batch.map((i) => i.idempotencyKey));
      expect(sent).toEqual(items.map((i) => i.idempotencyKey));
      expect(bridge.sync.fail).not.toHaveBeenCalled();
    });

    it('goes in POSTs under the size limit, measured in bytes', async () => {
      // 1.2 MB as UTF-8 and 400 KB as UTF-16 code units, so a count of characters would put all
      // three in one POST of 3.6 MB.
      const answers = { text: '語'.repeat(400_000) };
      bridgeHolding([item('i1', 'k1', answers), item('i2', 'k2', answers), item('i3', 'k3', answers)]);
      acceptEverything();

      expect(await flushNativeQueue()).toEqual({ flushed: 3, failed: 0 });

      expect(sizes()).toEqual([1, 1, 1]);
      for (const [, batch] of vi.mocked(api.syncBatch).mock.calls) {
        expect(bytes({ items: batch })).toBeLessThan(2 * 1024 * 1024);
      }
    });

    it.each([
      ['413, over the body limit', { error: 'Request body too large', status: 413 }],
      ['400, too many items', { error: 'Too many items (max 100 per batch)', status: 400 }],
    ])('uses no attempt on a POST refused as a whole (%s), and sends the two halves', async (_name, refusal) => {
      const bridge = bridgeHolding([item('i1', 'k1', {}), item('i2', 'k2', {}), item('i3', 'k3', {}), item('i4', 'k4', {})]);
      acceptEverything();
      vi.mocked(api.syncBatch).mockResolvedValueOnce(refusal);

      expect(await flushNativeQueue()).toEqual({ flushed: 4, failed: 0 });

      expect(sizes()).toEqual([4, 2, 2]);
      expect(bridge.sync.fail).not.toHaveBeenCalled();
    });

    it('uses an attempt on one item refused alone: that refusal is of the item', async () => {
      const bridge = bridgeHolding([item('i1', 'k1', {}), item('i2', 'k2', {})]);
      acceptEverything();
      vi.mocked(api.syncBatch)
        .mockResolvedValueOnce({ error: 'Request body too large', status: 413 })
        .mockResolvedValueOnce({ error: 'Request body too large', status: 413 });

      expect(await flushNativeQueue()).toEqual({ flushed: 1, failed: 0 });

      expect(bridge.sync.fail).toHaveBeenCalledWith(['i1'], 'Request body too large');
      expect(bridge.sync.ack).toHaveBeenCalledWith(['i2']);
    });
  });

  it('uses no attempt, and stops, when the session has ended', async () => {
    const bridge = makeBridge();
    bridge.sync.flush.mockResolvedValueOnce({
      pending: [
        { appSlug: 'one', items: [item('i1', 'k1', { a: 1 })] },
        { appSlug: 'two', items: [item('i2', 'k2', { a: 2 })] },
      ],
    });
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValue({ error: 'Authentication required', status: 401 });

    expect(await flushNativeQueue()).toEqual({ flushed: 0, failed: 0 });

    expect(api.syncBatch).toHaveBeenCalledTimes(1);
    expect(bridge.sync.fail).not.toHaveBeenCalled();
  });

  // A batch answers 200 with a status for each item. A 503 there is the server's ledger down or a
  // form busy: the browser queue waits on that, and spending an attempt would turn an outage into
  // "could not be sent".
  it('uses no attempt on an item the server asked to be tried later', async () => {
    const bridge = makeBridge();
    setBridge(bridge);
    vi.mocked(api.syncBatch).mockResolvedValueOnce({
      data: {
        results: [
          { idempotencyKey: 'k1', success: false, responseId: null, error: 'The form is busy', status: 503 },
          { idempotencyKey: 'k2', success: false, responseId: null, error: 'Validation failed', status: 400 },
        ],
      },
    });

    await flushNativeQueue();

    expect(bridge.sync.fail).toHaveBeenCalledTimes(1);
    expect(bridge.sync.fail).toHaveBeenCalledWith(['i2'], 'Validation failed');
    expect(bridge.sync.ack).not.toHaveBeenCalled();
  });

  // The status hears about a pass only through the browser queue's subscribers.
  it('tells the queue\'s subscribers when a pass starts and when it ends', async () => {
    setBridge(makeBridge());
    vi.mocked(api.syncBatch).mockResolvedValueOnce({ data: { results: [] } });
    const heard: boolean[] = [];
    const stop = subscribeQueue(() => heard.push(isNativeFlushing()));

    await flushNativeQueue();
    stop();

    expect(heard).toEqual([true, false]);
  });

  // The server takes 60 items a minute from an account and hands the rest back as still to do.
  // Nothing else would send those until the next reconnect or "Sync now".
  describe('a batch cut short by the limit', () => {
    const cutShort = (keys = ['k2']) => ({
      data: {
        results: [
          { idempotencyKey: 'k1', success: true, responseId: 'r1', error: null, status: 201 },
          ...keys.map((idempotencyKey) => ({ idempotencyKey, success: false, responseId: null, error: 'Try again in a moment', status: 429, processing: true })),
        ],
      },
    });

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      bumpSessionGeneration();
      vi.useRealTimers();
    });

    it('flushes once more when the minute has passed, using no attempt on what waited', async () => {
      const bridge = makeBridge();
      setBridge(bridge);
      vi.mocked(api.syncBatch).mockResolvedValueOnce(cutShort());
      await flushNativeQueue();
      expect(bridge.sync.fail).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(api.syncBatch).toHaveBeenCalledTimes(1);

      vi.mocked(api.syncBatch).mockResolvedValueOnce({ data: { results: [] } });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(api.syncBatch).toHaveBeenCalledTimes(2);
    });

    it('sets one timer however many passes are cut short, and keeps going while it is cut short', async () => {
      setBridge(makeBridge());
      vi.mocked(api.syncBatch).mockResolvedValue(cutShort());
      await flushNativeQueue();
      await flushNativeQueue();
      expect(api.syncBatch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(62_000);
      expect(api.syncBatch).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(62_000);
      expect(api.syncBatch).toHaveBeenCalledTimes(4);
    });

    it('stops when the batches no longer are', async () => {
      setBridge(makeBridge());
      vi.mocked(api.syncBatch).mockResolvedValueOnce(cutShort());
      await flushNativeQueue();
      vi.mocked(api.syncBatch).mockResolvedValue({ data: { results: [] } });

      await vi.advanceTimersByTimeAsync(180_000);

      expect(api.syncBatch).toHaveBeenCalledTimes(2);
    });

    it('sets nothing for an item that is merely being processed elsewhere', async () => {
      setBridge(makeBridge());
      vi.mocked(api.syncBatch).mockResolvedValueOnce({
        data: { results: [{ idempotencyKey: 'k1', success: false, responseId: null, error: 'Busy', status: 409, processing: true }] },
      });
      await flushNativeQueue();

      await vi.advanceTimersByTimeAsync(180_000);

      expect(api.syncBatch).toHaveBeenCalledTimes(1);
    });

    it('is cleared when the session ends: what it would send is not the next session\'s', async () => {
      setBridge(makeBridge());
      vi.mocked(api.syncBatch).mockResolvedValueOnce(cutShort());
      await flushNativeQueue();

      bumpSessionGeneration();
      await vi.advanceTimersByTimeAsync(180_000);

      expect(api.syncBatch).toHaveBeenCalledTimes(1);
    });

    it('sets nothing when the session ended during the pass', async () => {
      setBridge(makeBridge());
      vi.mocked(api.syncBatch).mockImplementationOnce(async () => {
        bumpSessionGeneration();
        return cutShort();
      });
      await flushNativeQueue();

      await vi.advanceTimersByTimeAsync(180_000);

      expect(api.syncBatch).toHaveBeenCalledTimes(1);
    });
  });
});
