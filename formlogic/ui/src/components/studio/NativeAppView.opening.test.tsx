// @vitest-environment jsdom
// Opening an app: a failure asking again may cure says so and asks again (by hand, or when the
// connection comes back), signing in is offered only where it helps, and the app's name reaches the
// tab and an iPhone's home screen as soon as it is known.
// The site's offline queue listens for `online` too, and reads IndexedDB when it hears it.
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeLook } from '../../lib/appLook';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: () => <div data-testid="frame">running</div> }));

import { NativeAppView } from './NativeAppView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const look: NativeLook = { background: '#0b1020', spinner: '#e9c46a', themeColor: null, description: '', icon: null, version: 'abc', installable: true };
const opened = { data: { name: 'Outerstead', project: { version: 1, client: { 'manifest.json': '{}' }, assets: {}, access: 'application', origins: [], storageScope: { access: 'application', appId: 'app-one' } } } };
let root: Root | null = null;
let host: HTMLElement | null = null;
async function render(props: { onDomain?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter><NativeAppView slug="outerstead" fullScreen {...props} /></MemoryRouter>); });
  await act(async () => {});
}
const text = () => host?.textContent ?? '';
const button = (label: string) => [...(host?.querySelectorAll('button') ?? [])].find(node => node.textContent === label);
const signIn = () => [...(host?.querySelectorAll('a') ?? [])].find(node => node.textContent === 'Sign in or join this app');

beforeEach(() => {
  mocks.getNativeRuntime.mockReset();
  document.title = 'FormLogic';
  const meta = document.createElement('meta');
  meta.name = 'apple-mobile-web-app-title';
  meta.content = 'FormLogic';
  document.head.append(meta);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host?.remove(); host = null;
  document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
  localStorage.clear();
});

it('says a lost connection plainly, offers Try again and no sign-in, and opens when asked again', async () => {
  mocks.getNativeRuntime.mockResolvedValueOnce({ error: 'The app’s pictures and sounds could not be downloaded. Check your connection and try again.', transportFailure: true });
  mocks.getNativeRuntime.mockResolvedValueOnce(opened);
  await render();
  expect(text()).toContain('Check your connection');
  expect(signIn()).toBeUndefined();
  await act(async () => { button('Try again')!.click(); });
  await act(async () => {});
  expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(2);
  expect(text()).toContain('running');
});

it('asks again by itself when the connection comes back', async () => {
  mocks.getNativeRuntime.mockResolvedValueOnce({ error: 'The app was updated while it was opening.', status: 409 });
  mocks.getNativeRuntime.mockResolvedValueOnce(opened);
  await render();
  expect(button('Try again')).toBeDefined();
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await act(async () => {});
  expect(text()).toContain('running');
});

it('offers signing in on FormLogic’s own page where the app refused this person', async () => {
  mocks.getNativeRuntime.mockResolvedValue({ error: 'App not found or access denied', status: 404 });
  await render();
  expect(signIn()).toBeDefined();
  expect(button('Try again')).toBeDefined();
});

it('never offers signing in on the app’s own domain, where the link led back to this page', async () => {
  mocks.getNativeRuntime.mockResolvedValue({ error: 'App not found or access denied', status: 404 });
  await render({ onDomain: true });
  expect(signIn()).toBeUndefined();
  expect(button('Try again')).toBeDefined();
});

it('names the tab and an iPhone home screen as soon as the project comes, while its media download', async () => {
  let finish!: (value: unknown) => void;
  mocks.getNativeRuntime.mockImplementation((_slug: string, onLook?: (look: NativeLook | null, early?: { name?: string }) => void) => {
    onLook?.(look, { name: 'Outerstead' });
    return new Promise(resolve => { finish = resolve; });
  });
  await render();
  // Still downloading its media.
  expect(host?.querySelector('[data-testid="frame"]')).toBeNull();
  expect(document.title).toBe('Outerstead');
  expect(document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('Outerstead');
  await act(async () => { finish(opened); });
  await act(async () => root!.unmount());
  root = null;
  expect(document.title).toBe('FormLogic');
  expect(document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('FormLogic');
});

