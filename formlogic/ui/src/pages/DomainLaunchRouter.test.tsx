// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchConfig } from '../lib/domainLaunchApi';

const { getNativeEntry, lookUpHost, rememberedHost } = vi.hoisted(() => ({ getNativeEntry: vi.fn(), lookUpHost: vi.fn(), rememberedHost: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { getNativeEntry } }));
vi.mock('../lib/domainLaunchApi', () => ({ lookUpHost, rememberedHost }));
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
  beforeEach(() => {
    vi.clearAllMocks();
    lookUpHost.mockReset();
    rememberedHost.mockReturnValue(null);
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, replace } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
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

  it('says so at the root of a host that is not connected', async () => {
    serverSays(null);
    expect(await show('/')).toContain("This domain isn't connected yet");
  });

  // Every page of a self-hosted site starts with this question, on a phone with one bar as much as
  // anywhere. Only the pages a real domain has rules about may wait for the answer.
  describe('while the server is being asked', () => {
    it('shows the platform\'s pages at once on a host it knows nothing of', async () => {
      stillAsking();
      for (const path of ['/dashboard', '/forms', '/form/abc123', '/settings/ai', '/docs', '/admin/users', '/open/app/shop']) {
        expect(await show(path), path).toBe('platform page');
      }
    });

    // AppRuntimeAuthGuard draws its sign-in form in place, and only the answer tells it the domain's
    // address to send people to instead. A first visit there has to hear that answer first.
    it.each(['/app/shop', '/app/shop/form/1', '/APP/shop/'])('waits at %s on a host it knows nothing of', async (path) => {
      stillAsking();
      expect(await show(path)).not.toContain('platform page');
    });

    it('does not wait at an app on a host remembered as no customer\'s domain', async () => {
      stillAsking();
      rememberedHost.mockReturnValue('not-domain');
      expect(await show('/app/shop')).toBe('platform page');
    });

    it('does not take a page whose name starts the same for /app', async () => {
      stillAsking();
      expect(await show('/apps')).toBe('platform page');
    });

    it('shows them at once on a host remembered as no customer\'s domain, the root too', async () => {
      stillAsking();
      rememberedHost.mockReturnValue('not-domain');
      expect(await show('/dashboard')).toBe('platform page');
      expect(await show('/')).toContain("This domain isn't connected yet");
      expect(await show('/some-new-page')).toBe('platform page');
    });

    it('shows nothing of the platform on a host remembered as a customer\'s domain', async () => {
      stillAsking();
      rememberedHost.mockReturnValue('domain');
      expect(await show('/dashboard')).not.toContain('platform page');
      expect(await show('/form/abc123')).not.toContain('platform page');
    });

    // A sign-in form must never show on a real domain, and a first visit must land on its app or
    // launch page: both are decided by an answer this browser doesn't have yet.
    it.each(['/', '/login', '/LOGIN/', '/signup', '/forgot-password', '/reset-password', '/accept-invite', '/sign-in/complete'])(
      'waits at %s on a host it knows nothing of',
      async (path) => {
        stillAsking();
        const page = await show(path);
        expect(page).not.toContain('platform page');
        expect(page).not.toContain("isn't connected");
      }
    );

    it('waits on a path that may be an app\'s own: a first visit must not flash a 404', async () => {
      stillAsking();
      expect(await show('/products/42')).not.toContain('platform page');
    });

    it.each(['/login', '/signup', '/reset-password', '/sign-in/complete'])('waits at %s even on a host remembered as none: it may have been connected since', async (path) => {
      stillAsking();
      rememberedHost.mockReturnValue('not-domain');
      expect(await show(path)).not.toContain('platform page');
    });
  });

  it('applies the answer when it comes: a first visit to a platform path ends on the app', async () => {
    let answer!: (result: unknown) => void;
    lookUpHost.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
    expect(await show('/settings')).toBe('platform page');

    await act(async () => answer({ config: config('runtime_direct'), answered: true }));

    expect(container.textContent).toBe('app shop for members');
  });

  it('keeps waiting at a sign-in page it moved to while the server was being asked', async () => {
    stillAsking();
    let goTo!: (path: string) => void;
    function Redirects() {
      goTo = useNavigate();
      return <p>platform page</p>;
    }
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DomainLaunchRouter host="shop.acme.com"><Redirects /></DomainLaunchRouter>
      </MemoryRouter>
    ));
    expect(container.textContent).toBe('platform page');

    await act(async () => goTo('/login?redirect=%2Fdashboard'));

    expect(container.textContent).not.toContain('platform page');
  });

  describe('with no answer from the server', () => {
    it('treats a host it knows nothing of as no customer\'s domain, sign-in included', async () => {
      noAnswer();
      expect(await show('/')).toBe('platform page');
      expect(await show('/login')).toBe('platform page');
      expect(await show('/dashboard')).toBe('platform page');
    });

    it('does not call a host it has heard of "not connected" just because it could not ask', async () => {
      noAnswer();
      rememberedHost.mockReturnValue('not-domain');
      expect(await show('/')).toBe('platform page');
    });

    it.each(['/', '/login', '/signup', '/reset-password', '/app/shop', '/dashboard', '/products/42'])('never shows %s as a platform page on a remembered domain', async (path) => {
      noAnswer();
      rememberedHost.mockReturnValue('domain');
      const page = await show(path);
      expect(page).not.toContain('platform page');
      expect(page).toContain("Can't reach this site right now");
    });

    it.each(['/form/abc123', '/privacy', '/terms'])('still opens %s on a remembered domain: nothing there asks anyone to sign in', async (path) => {
      noAnswer();
      rememberedHost.mockReturnValue('domain');
      expect(await show(path)).toBe('platform page');
    });
  });
});
