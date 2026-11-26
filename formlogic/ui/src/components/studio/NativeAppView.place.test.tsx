// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mysite.example/pricing.html?fbclid=abc"}
// The page's address and a SoftN app's place. SoftN's frame keeps no query in a place: a link that
// arrives as /pricing.html?fbclid=abc opens /pricing.html, and the frame says `/pricing.html` back.
// The address already names that place, so it is left as the visitor has it; Back to it sends the
// frame to the place without the query, and pushes nothing over the entries ahead.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type FrameProps = { initialPlace?: string | null; navigateTo?: { place: string; seq: number } | null; onPlace?: (place: string) => void };
const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), frames: [] as FrameProps[] }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({
  HostedAppFrame: (props: FrameProps) => { mocks.frames.push(props); return <div data-testid="frame" />; },
}));

import { NativeAppView } from './NativeAppView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const frame = () => mocks.frames.at(-1)!;
/** The app's frame says where the app is, and the page has had time to follow it. */
const says = (place: string) => act(async () => { frame().onPlace?.(place); await new Promise(resolve => setTimeout(resolve, 250)); });

beforeEach(async () => {
  window.history.replaceState(null, '', '/pricing.html?fbclid=abc');
  mocks.frames.length = 0;
  mocks.getNativeRuntime.mockResolvedValue({ data: { name: 'My site', project: { version: 1, client: { 'manifest.json': '{}' }, assets: {}, access: 'application', origins: [], storageScope: { access: 'application', appId: 'app-one' } } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<NativeAppView slug="mysite" fullScreen onDomain />); });
  await act(async () => {});
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null; });

it('leaves the query on the address when the frame says the place the address already names', async () => {
  // The whole place is the frame component's to hand over; it takes the query off (HostedAppFrame).
  expect(frame().initialPlace).toBe('/pricing.html?fbclid=abc');
  await says('/pricing.html');
  expect(address()).toBe('/pricing.html?fbclid=abc');
});

it('follows the app to another page, and comes Back to the entry with its query as it was', async () => {
  await says('/pricing.html');
  const entries = window.history.length;
  await says('/about.html');
  expect(address()).toBe('/about.html');
  expect(window.history.length).toBe(entries + 1);

  // Back: the browser shows the first entry again and the page sends the frame there.
  await act(async () => {
    window.history.replaceState(null, '', '/pricing.html?fbclid=abc');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(frame().navigateTo?.place).toBe('/pricing.html');
  const after = window.history.length;
  await says('/pricing.html');
  expect(address()).toBe('/pricing.html?fbclid=abc');
  expect(window.history.length).toBe(after);
});

it('sends the frame nowhere for an address that differs from where the app is only by its query', async () => {
  await says('/pricing.html');
  await act(async () => {
    window.history.replaceState(null, '', '/pricing.html?utm_source=news');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(frame().navigateTo ?? null).toBeNull();
});
