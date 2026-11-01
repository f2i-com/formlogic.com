// @vitest-environment jsdom
// A screen's first live feed can stop to ask "Let this app use this computer?". The person may go
// Back, or the document may reload, before they answer. Cleanup has run by then, so a feed started
// on their Allow belonged to nobody: its listener and captions loop ran until a full page reload.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomScreenRuntime } from './CustomScreenRuntime';
import type { ScreenBridge } from './screenBridge';

const h = vi.hoisted(() => ({ assertAllowed: vi.fn(), subscribeEvents: vi.fn(), startCaptions: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { isDemoMode: () => false } }));
vi.mock('../../lib/screenCompile', () => ({
  resolveScreenAssets: async (screen: { html?: string; css?: string; js?: string }) => ({
    html: screen.html || '', css: screen.css || '', js: screen.js || '',
  }),
}));
vi.mock('../../client-runtime/appLocalAccess', async (original) => ({
  ...(await original<typeof import('../../client-runtime/appLocalAccess')>()),
  assertAppMayUseThisComputer: h.assertAllowed,
}));
vi.mock('../../client-runtime/desktop/desktopEvents', () => ({ subscribeDesktopEvents: h.subscribeEvents }));
vi.mock('../../client-runtime/desktop/desktopDetection', () => ({ subscribeDesktopStatus: () => () => {} }));
vi.mock('./connector/realtimeCaptions', () => ({ startRealtimeCaptions: h.startCaptions }));
vi.mock('../../client-runtime/connectors/packConnectorDriver', () => ({ captionsConnectorId: () => 'aokie' }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
let answer: (allowed: boolean) => void;

const bridge = { liveFeedsAllowed: () => true, canObserveConnector: () => true, localBridgeAvailable: () => true } as unknown as ScreenBridge;

async function render(html: string) {
  const screen = { html, css: '', js: '', _trust: 'owner' as const };
  await act(async () => {
    root.render(<CustomScreenRuntime screen={screen} appSlug="demo" formId="notes" formTitle="Notes" bridge={bridge} />);
  });
  return container.querySelector('iframe')!;
}

async function ask(frame: HTMLIFrameElement, action: string) {
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow,
    data: { __fl: true, action, id: 'subscribe', gen: 0, payload: { filter: { connectorId: 'aokie' } } },
  })));
}

async function allow() {
  await act(async () => {
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mounted = true;
  h.assertAllowed.mockImplementation(() => new Promise<void>((resolve) => { answer = () => resolve(); }));
  h.subscribeEvents.mockReturnValue(() => {});
  h.startCaptions.mockReturnValue({ stop: () => {}, tombstone: () => {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
});

const feeds = [
  ['eventsSubscribe', () => h.subscribeEvents],
  ['captionsSubscribe', () => h.startCaptions],
] as const;

describe.each(feeds)('%s while the access prompt is open', (action, feed) => {
  it('starts the feed when the screen is still there', async () => {
    const frame = await render('<main>Calls</main>');
    await ask(frame, action);
    expect(feed()).not.toHaveBeenCalled();

    await allow();

    expect(feed()).toHaveBeenCalledOnce();
  });

  it('starts nothing once the person has gone Back', async () => {
    const frame = await render('<main>Calls</main>');
    await ask(frame, action);

    await act(async () => root.unmount());
    mounted = false;
    await allow();

    expect(feed()).not.toHaveBeenCalled();
  });

  it('starts nothing for a document that has been replaced', async () => {
    const frame = await render('<main>First document</main>');
    await ask(frame, action);

    await render('<main>Second document</main>');
    await allow();

    expect(feed()).not.toHaveBeenCalled();
  });
});
