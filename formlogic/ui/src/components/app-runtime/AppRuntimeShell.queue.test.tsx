// @vitest-environment jsdom
// A standard app (no custom screen) said nothing about submissions waiting on the device or ones
// that could not be sent: the SDK's queue panel, with Send again and Discard, was only reachable
// from a custom screen that included it. The app shell now says so in one quiet line, and opens
// the same panel behind "Review".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({
  browser: { pending: 0, failed: 0 },
  native: { pending: 0, failed: 0 },
  browserFailed: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../client-runtime/offlineQueue', async (original) => ({
  ...(await original<typeof import('../../client-runtime/offlineQueue')>()),
  queueCounts: async () => queue.browser,
  isFlushing: () => false,
  subscribeQueue: () => () => {},
  listFailedSubmissions: async () => queue.browserFailed,
  retrySubmission: vi.fn(),
  discardSubmission: vi.fn(),
}));
vi.mock('../../client-runtime/nativeOfflineQueue', async (original) => ({
  ...(await original<typeof import('../../client-runtime/nativeOfflineQueue')>()),
  nativeQueueCounts: async () => queue.native,
  listNativeFailedSubmissions: async () => [],
  flushAllQueues: vi.fn(async () => ({ browser: { flushed: 0, failed: 0 }, native: { flushed: 0, failed: 0 }, lastError: null })),
}));

import { AppRuntimeShell } from './AppRuntimeShell';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

function setApp(settings: Record<string, unknown> = {}) {
  useAppRuntimeStore.setState({
    appSlug: 'shop',
    config: {
      app: { id: 'a1', slug: 'shop', name: 'Shop', status: 'published', settings, navConfig: [], reports: [] },
      forms: [{ formId: 'orders', displayName: 'Tea orders', fields: [], settings: {} }],
      userPermissions: {},
    } as never,
  });
}

beforeEach(() => {
  queue.browser = { pending: 0, failed: 0 };
  queue.native = { pending: 0, failed: 0 };
  queue.browserFailed = [];
  setApp();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppRuntimeStore.setState({ appSlug: null, config: null });
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function showShell() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/app/shop']}>
        <Routes>
          <Route path="/app/:appSlug/*" element={<AppRuntimeShell><p>Screen</p></AppRuntimeShell>} />
        </Routes>
      </MemoryRouter>
    );
  });
  await settle();
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
async function click(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" button in: ${host.textContent}`);
  await act(async () => { b.click(); });
  await settle();
}

describe('the standard app shell with submissions on this device', () => {
  it('says nothing when nothing waits and nothing failed', async () => {
    await showShell();
    expect(button('Review')).toBeUndefined();
    expect(host.textContent).not.toContain('waiting to send');
  });

  it('counts the ones waiting, and opens the queue panel on "Review"', async () => {
    queue.browser = { pending: 1, failed: 0 };
    queue.native = { pending: 1, failed: 0 };
    await showShell();
    expect(host.textContent).toContain('2 submissions waiting to send');
    expect(button('Sync now')).toBeUndefined();
    expect(button('Review')?.getAttribute('aria-expanded')).toBe('false');
    await click('Review');
    expect(button('Hide')?.getAttribute('aria-expanded')).toBe('true');
    expect(button('Sync now')).toBeDefined();
    await click('Hide');
    expect(button('Sync now')).toBeUndefined();
  });

  it('counts the ones that could not be sent, each to send again or discard', async () => {
    queue.browser = { pending: 0, failed: 1 };
    queue.browserFailed = [{ id: 'r1', appSlug: 'shop', formId: 'orders', createdAt: Date.UTC(2026, 9, 1), failedAt: Date.UTC(2026, 9, 2), conflict: false }];
    await showShell();
    expect(host.textContent).toContain('1 submission could not be sent');
    await click('Review');
    const item = host.querySelector('li');
    expect(item?.textContent).toContain('Tea orders');
    expect(button('Send again')).toBeDefined();
    expect(button('Discard')).toBeDefined();
  });

  it('names both when some wait and some failed', async () => {
    queue.browser = { pending: 2, failed: 1 };
    await showShell();
    expect(host.textContent).toContain('2 waiting to send, 1 could not be sent');
  });

  it('leaves waiting ones to the offline banner while offline, but still shows a failed one', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      queue.browser = { pending: 2, failed: 0 };
      await showShell();
      expect(host.textContent).toContain("You're offline");
      expect(button('Review')).toBeUndefined();
      queue.browser = { pending: 2, failed: 1 };
      act(() => root.unmount());
      root = createRoot(host);
      await showShell();
      expect(host.textContent).toContain('1 submission could not be sent');
      expect(host.textContent).not.toContain('waiting to send');
      expect(button('Review')).toBeDefined();
    } finally {
      onLine.mockRestore();
    }
  });

  it('shows it in a chromeless app too, which has no offline banner', async () => {
    setApp({ hideNav: true });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      queue.browser = { pending: 1, failed: 0 };
      await showShell();
      expect(host.textContent).toContain('1 submission waiting to send');
      expect(button('Review')).toBeDefined();
    } finally {
      onLine.mockRestore();
    }
  });
});
