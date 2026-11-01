// @vitest-environment jsdom
// What the person is told about submissions waiting on the device. A submission can wait while the
// browser says "online" (a Wi-Fi sign-in page answered, the server is in maintenance mode, a rate
// limit), so "online" alone must not read as "all changes saved"; and a "Sync now" that could send
// nothing must say so, or the button appears to do nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({
  browser: { pending: 0, failed: 0 },
  native: { pending: 0, failed: 0 },
  flushAll: vi.fn(),
  flushing: false,
  nativeFlushing: false,
}));
vi.mock('../client-runtime/offlineQueue', async (original) => ({
  ...(await original<typeof import('../client-runtime/offlineQueue')>()),
  queueCounts: async () => queue.browser,
  isFlushing: () => queue.flushing,
  subscribeQueue: () => () => {},
}));
vi.mock('../client-runtime/nativeOfflineQueue', async (original) => ({
  ...(await original<typeof import('../client-runtime/nativeOfflineQueue')>()),
  nativeQueueCounts: async () => queue.native,
  flushAllQueues: queue.flushAll,
  isNativeFlushing: () => queue.nativeFlushing,
}));

import { OfflineQueuePanel, SyncStatus } from './components';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  queue.browser = { pending: 0, failed: 0 };
  queue.native = { pending: 0, failed: 0 };
  queue.flushing = false;
  queue.nativeFlushing = false;
  queue.flushAll.mockReset().mockResolvedValue({ browser: { flushed: 0, failed: 0 }, native: { flushed: 0, failed: 0 }, lastError: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(node: React.ReactNode) {
  await act(async () => { root.render(node); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('SyncStatus', () => {
  it('says everything is saved only when nothing waits', async () => {
    await show(<SyncStatus />);
    expect(host.textContent).toContain('all changes saved');
  });

  it('says how many submissions wait, while online', async () => {
    queue.browser = { pending: 2, failed: 0 };
    queue.native = { pending: 1, failed: 0 };
    await show(<SyncStatus />);
    expect(host.textContent).not.toContain('all changes saved');
    expect(host.textContent).toContain('3 submissions waiting to send');
  });

  it('says so when a submission could not be sent at all', async () => {
    queue.browser = { pending: 0, failed: 1 };
    await show(<SyncStatus />);
    expect(host.textContent).not.toContain('all changes saved');
    expect(host.textContent).toContain('1 submission could not be sent');
  });
});

describe('OfflineQueuePanel', () => {
  const syncNow = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Sync now');

  it('says nothing could be sent when "Sync now" reaches no server, and keeps the button', async () => {
    queue.browser = { pending: 2, failed: 0 };
    await show(<OfflineQueuePanel />);
    await act(async () => { syncNow()!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(queue.flushAll).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Nothing could be sent just now');
    expect(host.textContent).toContain('still on this device');
    expect(syncNow()).toBeDefined();
  });

  // A pass already under way (the one started on coming back to the page, say) makes this one
  // return at once with nothing sent. That is not "nothing could be sent".
  it('does not say so while another pass is still sending', async () => {
    queue.browser = { pending: 2, failed: 0 };
    queue.flushing = true;
    await show(<OfflineQueuePanel />);
    await act(async () => { syncNow()!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).not.toContain('Nothing could be sent');
  });

  it('does not say so while a pass over the native queue is still sending', async () => {
    queue.native = { pending: 2, failed: 0 };
    queue.nativeFlushing = true;
    await show(<OfflineQueuePanel />);
    await act(async () => { syncNow()!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).not.toContain('Nothing could be sent');
  });

  it('says nothing of the kind when everything was sent', async () => {
    queue.browser = { pending: 2, failed: 0 };
    await show(<OfflineQueuePanel />);
    queue.flushAll.mockImplementation(async () => {
      queue.browser = { pending: 0, failed: 0 };
      return { browser: { flushed: 2, failed: 0 }, native: { flushed: 0, failed: 0 }, lastError: null };
    });
    await act(async () => { syncNow()!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).not.toContain('Nothing could be sent');
    expect(host.textContent).toContain('all changes saved');
  });
});
