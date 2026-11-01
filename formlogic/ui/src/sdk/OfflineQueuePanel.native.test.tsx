// @vitest-environment jsdom
// The native runtime's queue has no events of its own, and its passes run on reconnecting and when
// an app opens. The status used to hear only the browser queue, so it went on saying "2 waiting to
// send" about submissions already sent, and nothing about ones that had failed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client-runtime/offlineQueue', async (original) => ({
  ...(await original<typeof import('../client-runtime/offlineQueue')>()),
  queueCounts: async () => ({ pending: 0, failed: 0 }),
  listFailedSubmissions: async () => [],
}));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  api: { syncBatch: vi.fn(), isDemoMode: () => false },
}));

import { api } from '../lib/api';
import { flushNativeQueue } from '../client-runtime/nativeOfflineQueue';
import { SyncStatus } from './components';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

const item = { id: 'n1', appSlug: 'shop', formId: 'orders', idempotencyKey: 'k1', answers: { a: 1 }, status: 'pending', attempts: 0, lastError: null, createdAt: '2026-10-01T09:30:00Z' };

function bridge(rows: Array<typeof item>) {
  (window as unknown as { FormLogicNative?: unknown }).FormLogicNative = {
    available: true,
    runtime: {},
    sync: {
      getQueue: async () => rows,
      flush: async () => ({ pending: rows.length ? [{ appSlug: 'shop', items: rows }] : [] }),
      ack: async (ids: string[]) => {
        for (const id of ids) rows.splice(rows.findIndex((row) => row.id === id), 1);
        return { acked: ids.length, remaining: rows.length };
      },
      fail: async (ids: string[]) => ({ failed: ids.length }),
      enqueueSubmission: async () => ({ id: 'x' }),
    },
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { FormLogicNative?: unknown }).FormLogicNative;
  vi.mocked(api.syncBatch).mockReset();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('the status and the native queue', () => {
  it('drops the count once a pass nobody asked for has sent them', async () => {
    bridge([{ ...item }]);
    vi.mocked(api.syncBatch).mockResolvedValue({ data: { results: [{ idempotencyKey: 'k1', success: true, responseId: 'r1', error: null }] } } as never);
    await act(async () => { root.render(<SyncStatus />); });
    await settle();
    expect(host.textContent).toContain('1 submission waiting to send');

    await act(async () => { await flushNativeQueue(); });
    await settle();

    expect(host.textContent).not.toContain('waiting to send');
    expect(host.textContent).toContain('all changes saved');
  });

  it('mentions them once a pass has marked them failed', async () => {
    const rows = [{ ...item }];
    bridge(rows);
    vi.mocked(api.syncBatch).mockImplementation(async () => {
      rows[0].status = 'failed';
      return { data: { results: [{ idempotencyKey: 'k1', success: false, responseId: null, error: 'Nope', conflict: true }] } } as never;
    });
    await act(async () => { root.render(<SyncStatus />); });
    await settle();

    await act(async () => { await flushNativeQueue(); });
    await settle();

    expect(host.textContent).toContain('1 submission could not be sent');
  });
});
