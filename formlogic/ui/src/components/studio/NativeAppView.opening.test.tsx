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

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), site: [] as Array<Record<string, unknown>> }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: () => <div data-testid="frame">running</div> }));
vi.mock('./SiteAppFrame', () => ({ SiteAppFrame: (props: Record<string, unknown>) => { mocks.site.push(props); return <div data-testid="site-frame">its own pages</div>; } }));

import { NativeAppView } from './NativeAppView';
import { useAuthStore } from '../../stores/authStore';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const look: NativeLook = { background: '#0b1020', spinner: '#e9c46a', themeColor: null, description: '', icon: null, version: 'abc', installable: true };
const opened = { data: { name: 'Outerstead', project: { version: 1, client: { 'manifest.json': '{}' }, assets: {}, access: 'application', origins: [], storageScope: { access: 'application', appId: 'app-one' } } } };
let root: Root | null = null;
let host: HTMLElement | null = null;
async function render(props: { onDomain?: boolean; fullScreen?: boolean; onSiteProblem?: (problem: { kind: 'blocked' | 'error' | 'note'; text: string }) => void } = {}) {
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
  mocks.site.length = 0;
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
  setSessionOwner(null); useAuthStore.setState({ user: null });
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

// A JavaScript app: the server's own pages, in a frame of their own (SiteAppFrame).
const site = { url: '/api/app/outerstead/site/t1-abc/index.html', entry: 'index.html', proof: 'proof-one' };
const withSite = (more: Record<string, unknown> = {}) => ({ data: { ...opened.data, project: { ...opened.data.project, origins: ['https://api.example.com'], site, ...more } } });

it('shows a JavaScript app in the site frame, not the SoftN one, and passes on what went wrong in it', async () => {
  mocks.getNativeRuntime.mockResolvedValue(withSite());
  const onSiteProblem = vi.fn();
  await render({ onSiteProblem });
  expect(host?.querySelector('[data-testid="site-frame"]')).not.toBeNull();
  expect(host?.querySelector('[data-testid="frame"]')).toBeNull();
  const props = mocks.site[mocks.site.length - 1];
  expect(props).toMatchObject({ slug: 'outerstead', name: 'Outerstead', version: 1, site, backendOrigins: ['https://api.example.com'], className: undefined });
  // Anyone's app is not told who is looking at it.
  expect(props.userId).toBeNull();
  expect(props.onProblem).toBe(onSiteProblem);
  expect(document.title).toBe('Outerstead');
});

it('gives the site frame the preview’s edge where the app is not the whole page', async () => {
  mocks.getNativeRuntime.mockResolvedValue(withSite());
  await render({ fullScreen: false });
  expect(String(mocks.site[mocks.site.length - 1].className)).toContain('min-h-[420px]');
});

it('tells a members’ JavaScript app who the member is, and anyone’s app nobody, signed in or not', async () => {
  useAuthStore.setState({ user: { id: 'member-a', email: 'a@example.test' } as never });
  setSessionOwner('member-a'); bumpSessionGeneration();
  mocks.getNativeRuntime.mockResolvedValue(withSite({ access: 'members', storageScope: { access: 'members', appId: 'app-one', userId: 'member-a' } }));
  await render();
  expect(mocks.site[mocks.site.length - 1].userId).toBe('member-a');
  await act(async () => root!.unmount());
  root = null; mocks.site.length = 0;
  mocks.getNativeRuntime.mockResolvedValue(withSite());
  await render();
  expect(mocks.site[mocks.site.length - 1].userId).toBeNull();
});

it('holds a JavaScript app to the admission every app is held to', async () => {
  // A members' descriptor for somebody else: refused before any frame is made.
  mocks.getNativeRuntime.mockResolvedValue(withSite({ access: 'members', storageScope: { access: 'members', appId: 'app-one', userId: 'someone-else' } }));
  await render();
  expect(mocks.site).toHaveLength(0);
  expect(host?.querySelector('[data-testid="site-frame"]')).toBeNull();
  expect(text()).toContain('could not verify');
});

it('shows a SoftN app in its own frame as before', async () => {
  mocks.getNativeRuntime.mockResolvedValue(opened);
  await render({ onSiteProblem: vi.fn() });
  expect(host?.querySelector('[data-testid="frame"]')).not.toBeNull();
  expect(host?.querySelector('[data-testid="site-frame"]')).toBeNull();
  expect(mocks.site).toHaveLength(0);
});

