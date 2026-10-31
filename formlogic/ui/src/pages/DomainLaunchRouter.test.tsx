// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getNativeEntry, fetchLaunchConfig } = vi.hoisted(() => ({ getNativeEntry: vi.fn(), fetchLaunchConfig: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { getNativeEntry } }));
vi.mock('../lib/domainLaunchApi', () => ({ fetchLaunchConfig }));
vi.mock('./AppLaunchPage', () => ({ AppLaunchPage: () => <p>launch page</p> }));
vi.mock('../components/app-runtime/AppEntryRouter', () => ({
  DomainNativeApp: ({ slug, access }: { slug: string; access: string }) => <p>app {slug} for {access}</p>,
}));

import { DomainLaunchRouter } from './DomainLaunchRouter';

const config = (mode: string) => ({ app: { slug: 'shop', name: 'Shop' }, domain: { domain: 'shop.acme.com', mode } });
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
    fetchLaunchConfig.mockResolvedValue(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
    expect(await show('/')).toBe('app shop for members');
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps the app on every other path, so a domain shows no platform pages', async () => {
    fetchLaunchConfig.mockResolvedValue(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'application', native: true } });
    for (const path of ['/dashboard', '/forms', '/settings', '/apps', '/app/shop/native', '/admin/users']) {
      expect(await show(path), path).toBe('app shop for application');
    }
  });

  it('leaves the account pages a visitor needs to get in', async () => {
    fetchLaunchConfig.mockResolvedValue(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'members', native: true } });
    for (const path of ['/signup', '/login', '/forgot-password', '/reset-password', '/accept-invite', '/privacy', '/terms', '/signup/']) {
      expect(await show(path), path).toBe('platform page');
    }
  });

  it('shows a launch page at the root of a SoftN app, and the app past it', async () => {
    fetchLaunchConfig.mockResolvedValue(config('launch_page'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members', native: true } });
    expect(await show('/')).toBe('launch page');
    expect(await show('/app/shop')).toBe('app shop for members');
  });

  it('still sends any other kind of app to its address', async () => {
    fetchLaunchConfig.mockResolvedValue(config('runtime_direct'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members' } });
    await show('/');
    expect(replace).toHaveBeenCalledWith('/app/shop');
  });

  it('still shows the normal app past the root of any other kind of app', async () => {
    fetchLaunchConfig.mockResolvedValue(config('launch_page'));
    getNativeEntry.mockResolvedValue({ data: { home: false, access: 'members' } });
    expect(await show('/form/1')).toBe('platform page');
  });

  it('renders the normal app on a host the server does not know, past its root', async () => {
    // A self-hosted FormLogic whose build was not given its own name: its dashboard must survive.
    fetchLaunchConfig.mockResolvedValue(null);
    expect(await show('/dashboard')).toBe('platform page');
    expect(getNativeEntry).not.toHaveBeenCalled();
  });

  it('says so at the root of a host that is not connected', async () => {
    fetchLaunchConfig.mockResolvedValue(null);
    expect(await show('/')).toContain("This domain isn't connected yet");
  });

  it('shows nothing of the platform while it finds out', async () => {
    fetchLaunchConfig.mockReturnValue(new Promise(() => {}));
    expect(await show('/dashboard')).not.toContain('platform page');
  });
});
