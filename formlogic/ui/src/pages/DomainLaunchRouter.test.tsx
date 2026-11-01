// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchConfig } from '../lib/domainLaunchApi';

const { getNativeEntry, lookUpHost, rememberedHost, rememberHost } = vi.hoisted(() => ({ getNativeEntry: vi.fn(), lookUpHost: vi.fn(), rememberedHost: vi.fn(), rememberHost: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { getNativeEntry } }));
vi.mock('../lib/domainLaunchApi', () => ({ lookUpHost, rememberedHost, rememberHost }));
vi.mock('./AppLaunchPage', () => ({ AppLaunchPage: () => <p>launch page</p> }));
vi.mock('../components/app-runtime/AppEntryRouter', () => ({
  DomainNativeApp: ({ slug, access }: { slug: string; access: string }) => <p>app {slug} for {access}</p>,
}));

import { DomainLaunchRouter } from './DomainLaunchRouter';

const config = (mode: string) => ({ app: { slug: 'shop', name: 'Shop' }, domain: { domain: 'shop.acme.com', mode } });
/** The server's answer about the host: its launch config, or that it isn't connected. */
const serverSays = (found: unknown) => lookUpHost.mockResolvedValue({ config: found as LaunchConfig | null, answered: true });
const noAnswer = () => lookUpHost.mockResolvedValue({ config: null, answered: false });
const stillAsking = () => lookUpHost.mockReturnValue(new Promise(() => {}));
/** An answer the test gives when it chooses. */
function answerLater() {
  let answer!: (result: unknown) => void;
  lookUpHost.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
  return (result: unknown) => act(async () => answer(result));
}
const SPINNER = '.animate-spin';
const waitFor = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const show = async (path: string) => {
  await act(async () => root.render(
    <MemoryRouter key={path} initialEntries={[path]}>
      <DomainLaunchRouter host="shop.acme.com"><p>platform page</p></DomainLaunchRouter>
    </MemoryRouter>
  ));
  return container.textContent ?? '';
};

describe('DomainLaunchRouter', () => {
  const replace = vi.fn();
  const assign = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    lookUpHost.mockReset();
    rememberedHost.mockReturnValue(null);
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, replace, assign } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('opens a SoftN app at the domain itself, with no redirect', async () => {
    serverSays(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
    expect(await show('/')).toBe('app shop for members');
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps the app on every other path, so a domain shows no platform pages', async () => {
    serverSays(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'application', native: true } });
    for (const path of ['/dashboard', '/forms', '/settings', '/apps', '/app/shop/native', '/admin/users']) {
      expect(await show(path), path).toBe('app shop for application');
    }
  });

  it("leaves FormLogic's own address its own pages when an app is connected to it", async () => {
    serverSays({ ...config('runtime_direct'), platformUrl: 'https://shop.acme.com' });
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'application', native: true } });
    for (const path of ['/admin', '/admin/users', '/forms', '/dashboard']) {
      expect(await show(path), path).toBe('platform page');
    }
    expect(await show('/')).toBe('launch page');
  });

  it('keeps the app when FormLogic is at another address, a local preview included', async () => {
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'application', native: true } });
    for (const platformUrl of ['https://forms.acme.com', window.location.origin]) {
      serverSays({ ...config('runtime_direct'), platformUrl });
      expect(await show('/forms'), platformUrl).toBe('app shop for application');
    }
  });

  it('leaves the account pages a visitor needs to get in', async () => {
    serverSays(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
    for (const path of ['/signup', '/login', '/forgot-password', '/reset-password', '/accept-invite', '/privacy', '/terms', '/signup/']) {
      expect(await show(path), path).toBe('platform page');
    }
  });

  // A form's link and its embed are the same address, and they used to open the app instead.
  it.each(['runtime_direct', 'launch_page'])('opens a form link as a form on a SoftN app\'s domain (%s)', async (mode) => {
    serverSays(config(mode));
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
    for (const path of ['/form/abc123', '/form/abc123/', '/FORM/abc123']) {
      expect(await show(path), path).toBe('platform page');
    }
    // The app's own routes are not forms, and neither is a page of a similar name.
    expect(await show('/forms')).toBe('app shop for members');
    expect(await show('/formula')).toBe('app shop for members');
  });

  it('shows a launch page at the root of a SoftN app, and the app past it', async () => {
    serverSays(config('launch_page'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
    expect(await show('/')).toBe('launch page');
    expect(await show('/app/shop')).toBe('app shop for members');
  });

  it('still sends any other kind of app to its address', async () => {
    serverSays(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members' } });
    await show('/');
    expect(replace).toHaveBeenCalledWith('/app/shop');
  });

  it('still shows the normal app past the root of any other kind of app', async () => {
    serverSays(config('launch_page'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members' } });
    expect(await show('/form/1')).toBe('platform page');
  });

  it('renders the normal app on a host the server does not know, past its root', async () => {
    // A self-hosted FormLogic whose build was not given its own name: its dashboard must survive.
    serverSays(null);
    expect(await show('/dashboard')).toBe('platform page');
    expect(getNativeEntry).not.toHaveBeenCalled();
  });

  it('says so at the root of a host the server says is neither a domain nor the site', async () => {
    serverSays(null);
    expect(await show('/')).toContain("This domain isn't connected yet");
  });

  // The server's word that a host is the site's own: nothing about it can be unconnected.
  it.each(['/', '/login', '/signup', '/app/shop', '/dashboard', '/some-new-page'])('shows the normal app at %s on the site\'s own address', async (path) => {
    lookUpHost.mockResolvedValue({ config: null, answered: true, platform: true });
    expect(await show(path)).toBe('platform page');
  });

  it('keeps what the server said, with the app\'s kind', async () => {
    const found = config('launch_page');
    serverSays(found);
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
    await show('/');
    expect(rememberHost).toHaveBeenCalledWith('shop.acme.com', found, 'members');
  });

  describe('on a host nothing is known of, before there is an answer', () => {
    it.each(['/form/abc123', '/FORM/abc123/', '/privacy', '/terms'])('opens %s at once: it is the same page on any host', async (path) => {
      stillAsking();
      expect(await show(path)).toBe('platform page');
    });

    // Every path on a SoftN domain is its app's, so a first visit must land on it, never on
    // FormLogic's pages or its 404, and AppRuntimeAuthGuard draws its sign-in form in place until
    // the answer gives it the domain's address. On a site of its own this costs one lookup.
    const anyOtherPage = ['/', '/login', '/LOGIN/', '/signup', '/forgot-password', '/reset-password', '/accept-invite', '/sign-in/complete', '/app/shop', '/app/shop/form/1', '/APP/shop/', '/products/42', '/dashboard', '/settings', '/forms', '/apps', '/docs', '/download', '/packs', '/admin/users'];
    it.each(anyOtherPage)('waits at %s, then says it can\'t reach the site, and never shows the page', async (path) => {
      vi.useFakeTimers();
      noAnswer();
      const page = await show(path);
      expect(page).not.toContain('platform page');
      expect(container.querySelector(SPINNER)).not.toBeNull();

      await waitFor(7_900);
      expect(container.querySelector(SPINNER)).not.toBeNull();
      await waitFor(100);

      expect(container.textContent).toContain("Can't reach this site right now");
      expect(container.textContent).not.toContain('platform page');
      await waitFor(120_000);
      expect(container.textContent).not.toContain('platform page');
    });

    it('takes an answer that comes after it gave up waiting', async () => {
      vi.useFakeTimers();
      const answer = answerLater();
      getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
      await show('/');
      await waitFor(8_000);
      expect(container.textContent).toContain("Can't reach this site right now");

      await answer({ config: config('runtime_direct'), answered: true });

      expect(container.textContent).toBe('app shop for members');
    });

    it('asks again from Try again, without reloading the page', async () => {
      vi.useFakeTimers();
      const reload = vi.fn();
      Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, replace, assign, reload } });
      noAnswer();
      await show('/');
      await waitFor(8_000);
      const asked = lookUpHost.mock.calls.length;
      serverSays(null);

      await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!.click());

      expect(lookUpHost).toHaveBeenCalledTimes(asked + 1);
      expect(reload).not.toHaveBeenCalled();
      expect(container.textContent).toContain("This domain isn't connected yet");
    });

    // The old word for a domain, which came with nothing to draw it from.
    it('treats a host remembered only as "domain" as one it knows nothing of', async () => {
      stillAsking();
      rememberedHost.mockReturnValue({ kind: 'domain' });
      expect(await show('/form/abc123')).toBe('platform page');
      expect(await show('/dashboard')).not.toContain('platform page');
    });
  });

  describe('on a host remembered as a domain, with its config', () => {
    const stored = (mode: string, softnAccess?: string) => rememberedHost.mockReturnValue({ kind: 'domain', config: { ...config(mode), platformUrl: 'https://forms.acme.com' }, softnAccess });

    it.each(['/', '/products/42', '/dashboard', '/app/shop'])('draws %s as the stored answer does, with no answer yet', async (path) => {
      noAnswer();
      stored('runtime_direct', 'members');
      expect(await show(path)).toBe('app shop for members');
    });

    it('draws the launch page at the root', async () => {
      stillAsking();
      stored('launch_page', 'members');
      expect(await show('/')).toBe('launch page');
    });

    const domainFor = (mode: string) => ({ ...config(mode), platformUrl: 'https://forms.acme.com' });

    it('sends a sign-in to FormLogic, not a form here, once the server has said where', async () => {
      const answer = answerLater();
      stored('launch_page', 'members');
      getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
      expect(await show('/login')).not.toContain('platform page');
      expect(assign).not.toHaveBeenCalled();

      await answer({ config: domainFor('launch_page'), answered: true });

      expect(assign.mock.calls[0][0]).toContain('https://forms.acme.com/sign-in/domain');
    });

    it('sends a password page there too, token and all', async () => {
      const answer = answerLater();
      stored('launch_page');
      getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members' } });
      await show('/reset-password?token=t');
      expect(replace).not.toHaveBeenCalled();

      await answer({ config: domainFor('launch_page'), answered: true });

      expect(replace).toHaveBeenCalledWith('https://forms.acme.com/reset-password?token=t');
    });

    // Storage can be old, or written by a script that got in once: it can't send a token anywhere.
    it.each(['/login', '/reset-password?token=t', '/accept-invite?token=t'])('stays at %s while there is no answer, and shows no form', async (path) => {
      vi.useFakeTimers();
      noAnswer();
      stored('launch_page', 'members');
      await show(path);
      expect(container.textContent).not.toContain('platform page');
      await waitFor(8_000);

      expect(container.textContent).toContain("Can't reach this site right now");
      expect(replace).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    });

    it('finishes the way back from signing in', async () => {
      stillAsking();
      stored('launch_page', 'members');
      await act(async () => { await show('/sign-in/complete'); });
      expect(container.textContent).toContain("That sign-in didn't finish");
    });

    it('sends any other kind of app to its address', async () => {
      stillAsking();
      stored('runtime_direct');
      await show('/');
      expect(replace).toHaveBeenCalledWith('/app/shop');
    });

    it.each(['/form/abc123', '/privacy', '/terms'])('still opens %s', async (path) => {
      noAnswer();
      stored('runtime_direct', 'members');
      expect(await show(path)).toBe('platform page');
    });

    it('never says it can\'t reach the site', async () => {
      vi.useFakeTimers();
      noAnswer();
      stored('runtime_direct', 'members');
      await show('/');
      await waitFor(60_000);
      expect(container.textContent).toBe('app shop for members');
    });

    it('keeps asking, and the same answer changes nothing on the page', async () => {
      vi.useFakeTimers();
      noAnswer();
      stored('runtime_direct', 'members');
      await show('/');
      await waitFor(3_000);
      expect(lookUpHost).toHaveBeenCalledTimes(2);
      const shown = container.firstElementChild;

      serverSays(config('runtime_direct'));
      getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
      await waitFor(6_000);

      expect(container.textContent).toBe('app shop for members');
      expect(container.firstElementChild).toBe(shown);
    });

    it('switches when the answer differs', async () => {
      const answer = answerLater();
      stored('runtime_direct', 'members');
      getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
      expect(await show('/')).toBe('app shop for members');

      await answer({ config: config('launch_page'), answered: true });

      expect(container.textContent).toBe('launch page');
    });

    it('lets the answer that the domain is gone replace it', async () => {
      const answer = answerLater();
      stored('runtime_direct', 'members');
      expect(await show('/')).toBe('app shop for members');

      await answer({ config: null, answered: true });

      expect(container.textContent).toContain("This domain isn't connected yet");
    });
  });

  describe('on a host remembered as none', () => {
    beforeEach(() => rememberedHost.mockReturnValue({ kind: 'not-domain' }));

    it.each(['/dashboard', '/form/abc123', '/privacy'])('shows %s at once', async (path) => {
      stillAsking();
      expect(await show(path)).toBe('platform page');
    });

    it('shows the site\'s own home at once', async () => {
      stillAsking();
      rememberedHost.mockReturnValue({ kind: 'not-domain', platform: true });
      expect(await show('/')).toBe('platform page');
    });

    // An alias no list names: its answer replaces the home page, so the page doesn't draw one first.
    it('holds the home page back when the server never said this is the site\'s address', async () => {
      const answer = answerLater();
      expect(await show('/')).not.toContain('platform page');

      await answer({ config: null, answered: true });

      expect(container.textContent).toContain("This domain isn't connected yet");
    });

    // It may have been connected since, and a page that takes a password can't be taken back.
    it.each(['/login', '/signup', '/reset-password', '/sign-in/complete', '/app/shop', '/APP/shop/'])('holds %s back for 2.5 seconds at most', async (path) => {
      vi.useFakeTimers();
      stillAsking();
      expect(await show(path)).not.toContain('platform page');
      await waitFor(2_400);
      expect(container.textContent).not.toContain('platform page');
      await waitFor(100);
      expect(container.textContent).toBe('platform page');
    });

    it('lets a late answer that it is a domain take over', async () => {
      vi.useFakeTimers();
      const answer = answerLater();
      getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
      await show('/app/shop');
      await waitFor(2_500);
      expect(container.textContent).toBe('platform page');

      await answer({ config: config('runtime_direct'), answered: true });

      expect(container.textContent).toBe('app shop for members');
    });

    it('does not call it unconnected for want of an answer', async () => {
      vi.useFakeTimers();
      noAnswer();
      await show('/');
      await waitFor(30_000);
      expect(container.textContent).toBe('platform page');
    });
  });

  it('applies the answer when it comes: a first visit to any path ends on the app', async () => {
    const answer = answerLater();
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
    expect(await show('/settings')).not.toContain('platform page');

    await answer({ config: config('runtime_direct'), answered: true });

    expect(container.textContent).toBe('app shop for members');
  });

  describe('asking again', () => {
    it('backs off to every 15 seconds, for as long as the page is open', async () => {
      vi.useFakeTimers();
      noAnswer();
      await show('/dashboard');
      expect(lookUpHost).toHaveBeenCalledTimes(1);

      for (const [ms, asked] of [[2_900, 1], [100, 2], [5_900, 2], [100, 3], [11_900, 3], [100, 4], [14_900, 4], [100, 5], [14_900, 5], [100, 6], [15_000, 7]]) {
        await waitFor(ms);
        expect(lookUpHost).toHaveBeenCalledTimes(asked);
      }
    });

    it('asks as soon as the browser is back online', async () => {
      vi.useFakeTimers();
      noAnswer();
      await show('/dashboard');
      await waitFor(3_000);
      const asked = lookUpHost.mock.calls.length;

      await act(async () => window.dispatchEvent(new Event('online')));

      expect(lookUpHost).toHaveBeenCalledTimes(asked + 1);
    });

    it('does not start a second try while one is running', async () => {
      stillAsking();
      await show('/dashboard');
      await act(async () => window.dispatchEvent(new Event('online')));
      expect(lookUpHost).toHaveBeenCalledTimes(1);
    });

    it('stops once it has an answer', async () => {
      vi.useFakeTimers();
      serverSays(null);
      await show('/dashboard');
      await act(async () => window.dispatchEvent(new Event('online')));
      await waitFor(60_000);
      expect(lookUpHost).toHaveBeenCalledTimes(1);
    });

    it('stops when the page goes, waiting to try again', async () => {
      vi.useFakeTimers();
      noAnswer();
      await show('/dashboard');
      await act(async () => root.unmount());
      root = createRoot(container);

      await waitFor(60_000);

      expect(lookUpHost).toHaveBeenCalledTimes(1);
    });

    it('stops when the page goes with a try on its way, whatever that try comes back with', async () => {
      vi.useFakeTimers();
      const answer = answerLater();
      await show('/dashboard');
      await act(async () => root.unmount());
      root = createRoot(container);

      await answer({ config: null, answered: false });
      await waitFor(60_000);

      expect(lookUpHost).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the app\'s own answer doesn\'t come', () => {
    const nativeEntry = { data: { home: true, access: 'members', native: true } };

    it.each([
      ['a rate limit', { error: 'Too many requests', status: 429 }],
      ['a server error', { error: 'Server error (503)', status: 503 }],
      ['no connection', { error: 'Network error', transportFailure: true }],
    ])('does not take %s to mean it is no SoftN app', async (_label, failed) => {
      vi.useFakeTimers();
      serverSays(config('runtime_direct'));
      getNativeEntry.mockResolvedValue(failed);

      expect(await show('/dashboard')).not.toContain('platform page');
      expect(rememberHost).not.toHaveBeenCalled();

      getNativeEntry.mockResolvedValue(nativeEntry);
      await waitFor(3_000);
      expect(container.textContent).toBe('app shop for members');
    });

    it('still opens a form and the legal pages on the domain meanwhile', async () => {
      serverSays(config('runtime_direct'));
      getNativeEntry.mockResolvedValue({ error: 'Too many requests', status: 429 });
      for (const path of ['/form/abc123', '/privacy', '/terms']) {
        expect(await show(path), path).toBe('platform page');
      }
    });

    it('does not take a host remembered as none at its word, once the server has said otherwise', async () => {
      vi.useFakeTimers();
      serverSays(config('runtime_direct'));
      getNativeEntry.mockResolvedValue({ error: 'Too many requests', status: 429 });
      rememberedHost.mockReturnValue({ kind: 'not-domain' });

      expect(await show('/')).not.toContain('platform page');
      await waitFor(2_500);
      expect(container.textContent).not.toContain('platform page');
    });

    // The host's answer is an answer, whatever is keeping the app's: no password form on a domain.
    it('hears that it is a domain at once, with the app\'s own answer still out', async () => {
      vi.useFakeTimers();
      serverSays(config('runtime_direct'));
      getNativeEntry.mockReturnValue(new Promise(() => {}));
      rememberedHost.mockReturnValue({ kind: 'not-domain' });

      await show('/app/shop');
      await waitFor(2_500);

      expect(container.textContent).not.toContain('platform page');
    });

    it('sends a password page on with the host\'s answer, whatever became of the app\'s', async () => {
      vi.useFakeTimers();
      serverSays({ ...config('launch_page'), platformUrl: 'https://forms.acme.com' });
      getNativeEntry.mockResolvedValue({ error: 'Server error', status: 503 });
      rememberedHost.mockReturnValue({ kind: 'domain', config: { ...config('launch_page'), platformUrl: 'https://forms.acme.com' }, softnAccess: 'members' });

      await show('/reset-password?token=t');

      expect(replace).toHaveBeenCalledWith('https://forms.acme.com/reset-password?token=t');
    });

    it('takes a refusal for the answer it is', async () => {
      serverSays(config('launch_page'));
      getNativeEntry.mockResolvedValue({ error: 'Not allowed', status: 403 });
      expect(await show('/dashboard')).toBe('platform page');
    });

    it('asks again when the request never returns', async () => {
      vi.useFakeTimers();
      serverSays(config('runtime_direct'));
      getNativeEntry.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(nativeEntry);
      await show('/products/42');

      await waitFor(14_900);
      expect(container.textContent).toContain("Can't reach this site right now");
      await waitFor(3_200);

      expect(container.textContent).toBe('app shop for members');
    });

    it('keeps the stored page meanwhile', async () => {
      vi.useFakeTimers();
      serverSays(config('runtime_direct'));
      getNativeEntry.mockResolvedValue({ error: 'Too many requests', status: 429 });
      rememberedHost.mockReturnValue({ kind: 'domain', config: config('runtime_direct'), softnAccess: 'members' });

      expect(await show('/dashboard')).toBe('app shop for members');
      await waitFor(30_000);
      expect(container.textContent).toBe('app shop for members');
    });
  });

  it('keeps waiting at a sign-in page it moved to while the server was being asked', async () => {
    stillAsking();
    let goTo!: (path: string) => void;
    function Redirects() {
      goTo = useNavigate();
      return <p>platform page</p>;
    }
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/form/abc123']}>
        <DomainLaunchRouter host="shop.acme.com"><Redirects /></DomainLaunchRouter>
      </MemoryRouter>
    ));
    expect(container.textContent).toBe('platform page');

    await act(async () => goTo('/login?redirect=%2Fdashboard'));

    expect(container.textContent).not.toContain('platform page');
  });
});
