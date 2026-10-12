// @vitest-environment jsdom
// "N could not be sent" with nothing to do about it: a failed submission was never sent again and
// never left the device. Where the SDK counts failed submissions (OfflineQueuePanel, SyncStatus)
// the person sees each one (which form, when, why, never the answers) and can send it again or
// discard it, the second only after being told the answers will be lost.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({
  browser: { pending: 0, failed: 0 },
  native: { pending: 0, failed: 0 },
  browserFailed: [] as Array<Record<string, unknown>>,
  nativeFailed: [] as Array<Record<string, unknown>>,
  retry: vi.fn(),
  discard: vi.fn(),
  retryNative: vi.fn(),
  discardNative: vi.fn(),
}));
vi.mock('../client-runtime/offlineQueue', async (original) => ({
  ...(await original<typeof import('../client-runtime/offlineQueue')>()),
  queueCounts: async () => queue.browser,
  isFlushing: () => false,
  subscribeQueue: () => () => {},
  listFailedSubmissions: async () => queue.browserFailed,
  retrySubmission: queue.retry,
  discardSubmission: queue.discard,
}));
vi.mock('../client-runtime/nativeOfflineQueue', async (original) => ({
  ...(await original<typeof import('../client-runtime/nativeOfflineQueue')>()),
  nativeQueueCounts: async () => queue.native,
  listNativeFailedSubmissions: async () => queue.nativeFailed,
  retryNativeSubmission: queue.retryNative,
  discardNativeSubmission: queue.discardNative,
  flushAllQueues: vi.fn(async () => ({ browser: { flushed: 0, failed: 0 }, native: { flushed: 0, failed: 0 }, lastError: null })),
}));

import { OfflineQueuePanel, SyncStatus } from './components';
import { useAppRuntimeStore } from '../stores/appRuntimeStore';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

const failed = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  appSlug: 'shop',
  formId: 'orders',
  createdAt: Date.UTC(2026, 9, 1, 9, 30),
  failedAt: Date.UTC(2026, 9, 2, 9, 30),
  conflict: false,
  ...over,
});

beforeEach(() => {
  queue.browser = { pending: 0, failed: 0 };
  queue.native = { pending: 0, failed: 0 };
  queue.browserFailed = [];
  queue.nativeFailed = [];
  for (const fn of [queue.retry, queue.discard, queue.retryNative, queue.discardNative]) fn.mockReset();
  useAppRuntimeStore.setState({
    appSlug: 'shop',
    config: {
      app: { id: 'a1', slug: 'shop', name: 'Shop' },
      forms: [{ formId: 'orders', displayName: 'Tea orders', fields: [], settings: {} }],
      userPermissions: {},
    } as never,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppRuntimeStore.setState({ appSlug: null, config: null });
});

async function show(node: React.ReactNode) {
  await act(async () => { root.render(node); });
  await settle();
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
async function click(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" button in: ${host.textContent}`);
  await act(async () => { b.click(); });
  await settle();
}

describe('OfflineQueuePanel with submissions that could not be sent', () => {
  it('lists each one by form and time, with a short reason, and none of its answers', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [failed()];
    queue.native = { pending: 0, failed: 1 };
    queue.nativeFailed = [failed({ id: 'q_1', appSlug: 'other-app', formId: 'f9' })];
    await show(<OfflineQueuePanel />);
    const items = host.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Tea orders');
    expect(items[0].textContent).toContain('could not be sent after several tries');
    // A form of another app on this device is named by that app.
    expect(items[1].textContent).toContain('other-app');
    expect(host.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(Date.UTC(2026, 9, 1, 9, 30)).toISOString());
  });

  it('sends one again on "Send again", and says what came of it', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [failed()];
    queue.retry.mockImplementation(async () => {
      queue.browser = { pending: 1, failed: 0 };
      queue.browserFailed = [];
      return 'waiting';
    });
    await show(<OfflineQueuePanel />);
    await click('Send again');
    expect(queue.retry).toHaveBeenCalledWith('r1');
    expect(host.textContent).toContain('waiting to send');
  });

  it('sends a native one again through the native queue', async () => {
    queue.native = { pending: 0, failed: 1 };
    queue.nativeFailed = [failed({ id: 'q_1' })];
    queue.retryNative.mockResolvedValue('sent');
    await show(<OfflineQueuePanel />);
    await click('Send again');
    expect(queue.retryNative).toHaveBeenCalledWith('q_1');
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it('discards one only after saying its answers will be lost', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [failed()];
    queue.discard.mockImplementation(async () => {
      queue.browser = { pending: 0, failed: 0 };
      queue.browserFailed = [];
      return true;
    });
    await show(<OfflineQueuePanel />);
    await click('Discard');
    expect(queue.discard).not.toHaveBeenCalled();
    expect(host.textContent).toContain('answers will be lost');
    await click('Keep it');
    expect(queue.discard).not.toHaveBeenCalled();
    await click('Discard');
    await click('Discard answers');
    expect(queue.discard).toHaveBeenCalledWith('r1');
    expect(host.querySelectorAll('li')).toHaveLength(0);
  });

  it('says plainly when the server holds a different submission, and offers only Discard', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [failed({ conflict: true })];
    await show(<OfflineQueuePanel />);
    expect(host.textContent).toContain('already holds a different submission');
    expect(button('Send again')).toBeUndefined();
    expect(button('Discard')).toBeDefined();
  });

  it('can still discard while offline', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [failed()];
    queue.discard.mockResolvedValue(true);
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      await show(<OfflineQueuePanel />);
      await click('Discard');
      await click('Discard answers');
      expect(queue.discard).toHaveBeenCalledWith('r1');
    } finally {
      onLine.mockRestore();
    }
  });
});

describe('SyncStatus with submissions that could not be sent', () => {
  it('opens the same list from the line that counts them', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [failed()];
    await show(<SyncStatus />);
    expect(host.textContent).toContain('1 submission could not be sent');
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await click('Review');
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(button('Send again')).toBeDefined();
  });

  it('offers nothing to review when nothing failed', async () => {
    queue.browser = { pending: 2, failed: 0 };
    await show(<SyncStatus />);
    expect(button('Review')).toBeUndefined();
  });
});
