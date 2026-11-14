// @vitest-environment jsdom
// A link in a hosted SoftN app to another site, a mail address or a phone number. The frame can
// open nothing (it is sandboxed with scripts alone), so SoftN's frame hands such a link to the page
// (`links: 1`, `{ type: 'link', href }`) and stays on the app. The page shows where it goes and opens
// it only when the person says so. And where an older frame does go to another address, the app is
// stopped as before, but can be opened again from the notice.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { getBytes } = vi.hoisted(() => ({ getBytes: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({
  getZippWasmBytes: getBytes,
  getEngineBytes: getBytes,
  engineIdentity: (id: string) => (id === 'zipp-web-python' ? { version: '0.0.17', sha256: 'current' } : undefined),
  engineNeedsBytes: () => true,
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn(), runNativeRequest: vi.fn(), getHostedRuntime: vi.fn(), getNativeRuntime: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
const notes = { access: 'application' as const, storageScope: { access: 'application' as const, appId: 'notes' }, assets: {} };
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = { port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
const channels: StubChannel[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  channels.length = 0;
  getBytes.mockResolvedValue(new ArrayBuffer(8));
  vi.stubGlobal('MessageChannel', class {
    port1 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    port2 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    constructor() { channels.push(this); }
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The frame opened and the app handed to it; the app's port. */
async function open() {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={notes} />));
  const iframe = container.querySelector('iframe')!;
  const posted = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1, places: 1, links: 1 } }));
  });
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { type?: string })?.type === 'formlogic:init')).toBe(true));
  return channels[0];
}
const say = (channel: StubChannel, data: unknown) => act(async () => channel.port1.onmessage?.({ data }));
const bar = () => container.querySelector('[role="dialog"][aria-label="A link out of the app"]');
const press = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });

/** The page's clock, as the bar reads it, moved by the test; and what the page opened. */
function clockAndTabs() {
  const time = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => time.now);
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
  return { time, opened };
}
const openButton = () => [...bar()!.querySelectorAll('button')].find(button => /^(Open link|Write email|Call)/.test(button.textContent ?? ''))!;
/** A tap on `element`: the pointer's press, then its click. */
const tap = (element: Element) => act(async () => {
  element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
});

it('shows where a link goes, host first, and opens it in a tab of its own only when the person says so', async () => {
  const channel = await open();
  const { time, opened } = clockAndTabs();
  expect(bar()).toBeNull();
  await say(channel, { type: 'link', href: 'https://example.com.evil.example/login?next=1' });
  expect(bar()?.textContent).toContain('This app links to example.com.evil.example');
  expect(openButton().textContent).toContain('Open link');
  // A button, not a link: a link is followed by a middle click, a drag or its menu too, none of which wait.
  expect(bar()!.querySelector('a')).toBeNull();
  // The keyboard comes to the bar, not to Open: a key meant for the app opens nothing.
  expect(document.activeElement).toBe(bar());
  // Pressed as it appears, Open does nothing (a double click or an Enter meant for the app).
  await press(openButton());
  expect(opened).not.toHaveBeenCalled();
  // The whole address is shown.
  expect(bar()?.textContent).toContain('https://example.com.evil.example/login?next=1');
  // Stay here puts it away, and nothing was opened.
  await press([...bar()!.querySelectorAll('button')].find(button => button.textContent === 'Stay here'));
  expect(bar()).toBeNull();
  // Once an address has been there long enough, Open opens it in a tab of its own, and the bar goes.
  await say(channel, { type: 'link', href: 'https://example.com/page' });
  time.now += 700;
  await tap(openButton());
  expect(opened).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener,noreferrer');
  expect(bar()).toBeNull();
});

it('a run of presses meant for the app never reaches Open, nor does a press begun before it was ready', async () => {
  const channel = await open();
  const { time, opened } = clockAndTabs();
  await say(channel, { type: 'link', href: 'https://evil.example/' });
  // "Tap fast!": each tap before Open is ready starts its wait over, so the tap at 600 ms opens nothing either.
  for (let i = 0; i <= 5; i++) {
    await tap(openButton());
    time.now += 120;
  }
  expect(opened).not.toHaveBeenCalled();
  // A press begun before then and let go after opens nothing.
  await act(async () => { openButton().dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  time.now += 2000;
  await act(async () => { openButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
  expect(opened).not.toHaveBeenCalled();
  // A middle click opens nothing at all.
  time.now += 2000;
  await act(async () => { openButton().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, detail: 1 })); });
  expect(opened).not.toHaveBeenCalled();
  // A press of the person's, once they have stopped and read it, opens it.
  await tap(openButton());
  expect(opened).toHaveBeenCalledWith('https://evil.example/', '_blank', 'noopener,noreferrer');
});

it('a newer address in the bar is waited for from when it is shown, not the address before', async () => {
  const channel = await open();
  const { time, opened } = clockAndTabs();
  await say(channel, { type: 'link', href: 'https://example.com/a' });
  time.now += 500;
  await say(channel, { type: 'link', href: 'https://evil.example/b' });
  expect(bar()?.textContent).toContain('This app links to evil.example');
  // 700 ms after the first, 200 after the one shown: not yet.
  time.now += 200;
  await tap(openButton());
  expect(opened).not.toHaveBeenCalled();
  time.now += 700;
  await tap(openButton());
  expect(opened).toHaveBeenCalledWith('https://evil.example/b', '_blank', 'noopener,noreferrer');
});

it('a mail address or a number opens in a tab of its own too, so this page stays, and Escape puts it away', async () => {
  const channel = await open();
  const { time, opened } = clockAndTabs();
  await say(channel, { type: 'link', href: 'mailto:someone@example.com?subject=Hi' });
  expect(bar()?.textContent).toContain('This app wants to write to someone@example.com');
  expect(openButton().textContent).toBe('Write email');
  time.now += 700;
  await tap(openButton());
  expect(opened).toHaveBeenCalledWith('mailto:someone@example.com?subject=Hi', '_blank', 'noopener,noreferrer');
  // A newer link takes the place of one still shown.
  await say(channel, { type: 'link', href: 'mailto:someone@example.com' });
  await say(channel, { type: 'link', href: 'tel:+61400000000' });
  expect(bar()?.textContent).toContain('This app wants to call +61400000000');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(bar()).toBeNull();
});

it('takes a link only right after a press of the person’s, where the browser can say', async () => {
  const channel = await open();
  // An app whose code runs in the frame's own scripts can hand a link on with no click; a press in the frame is this page's too.
  const activation = { isActive: false };
  Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true });
  try {
    await say(channel, { type: 'link', href: 'https://example.com/' });
    expect(bar()).toBeNull();
    activation.isActive = true;
    await say(channel, { type: 'link', href: 'https://example.com/' });
    expect(bar()).not.toBeNull();
  } finally {
    delete (navigator as unknown as Record<string, unknown>).userActivation;
  }
});

it('takes nothing from the frame that is not a link it may show', async () => {
  const channel = await open();
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '//example.com/', '/about.html', 'https://bank.example.com@evil.example/', 7, null, `https://example.com/${'a'.repeat(2001)}`]) {
    await say(channel, { type: 'link', href });
    expect(bar(), String(href).slice(0, 30)).toBeNull();
  }
});

it('an app stopped by going to another address can be opened again, in a new frame', async () => {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={notes} />));
  const first = container.querySelector('iframe')!;
  // The frame's document loads, then is replaced under it: the second load is the app going away.
  await act(async () => { first.dispatchEvent(new Event('load')); });
  await act(async () => { first.dispatchEvent(new Event('load')); });
  expect(container.textContent).toContain('This app tried to navigate away and was stopped');
  expect(container.querySelector('iframe')).toBeNull();
  await press([...container.querySelectorAll('button')].find(button => button.textContent === 'Open the app again'));
  expect(container.textContent).not.toContain('was stopped');
  const second = container.querySelector('iframe');
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
});
