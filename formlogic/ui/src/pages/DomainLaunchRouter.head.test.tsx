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
  DomainNativeApp: ({ slug }: { slug: string }) => <p>app {slug}</p>,
}));

import { DomainLaunchRouter } from './DomainLaunchRouter';

const SITE_TITLE = 'FormLogic — Build the system that runs your business';
const config = { app: { slug: 'shop', name: 'Shop', description: 'A shop' }, domain: { domain: 'shop.acme.com', mode: 'runtime_direct' }, landing: {}, platformUrl: 'https://forms.example' } as unknown as LaunchConfig;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let go: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  go = (path) => navigate(path);
  return null;
}
const show = (path: string) => act(async () => root.render(
  <MemoryRouter initialEntries={[path]}>
    <Navigator />
    <DomainLaunchRouter host="shop.acme.com"><p>platform page</p></DomainLaunchRouter>
  </MemoryRouter>
));
/** The head public/domain-head.js leaves: the site's values kept, and the app named where `named`. */
function bootHead(named: boolean) {
  const marks = (site: string, app: string) => named ? `data-fl-original="${site}" data-fl-applied="${app}"` : `data-fl-original="${site}"`;
  document.head.innerHTML = `<title ${marks(SITE_TITLE, 'Shop')}>${named ? 'Shop' : SITE_TITLE}</title>`
    + `<meta name="description" content="${named ? 'A shop' : 'Forms'}" ${marks('Forms', 'A shop')}>`
    + `<meta name="apple-mobile-web-app-title" content="${named ? 'Shop' : 'FormLogic'}" ${marks('FormLogic', 'Shop')}>`
    + `<link rel="manifest" href="${named ? '/manifest.json' : '/manifest.webmanifest'}" ${marks('/manifest.webmanifest', '/manifest.json')}>`;
}
const manifest = () => document.head.querySelector('link[rel="manifest"]')?.getAttribute('href');

describe("DomainLaunchRouter and the page's head", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookUpHost.mockResolvedValue({ config, answered: true });
    getNativeEntry.mockResolvedValue({ data: { home: true, access: 'application', native: true } });
    rememberedHost.mockReturnValue(null);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.head.innerHTML = '';
  });

  it('names the app as soon as the answer comes, on a first visit nothing named it on', async () => {
    bootHead(false);
    await show('/dashboard');
    expect(container.textContent).toBe('app shop');
    expect(document.title).toBe('Shop');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('A shop');
    expect(manifest()).toBe('/manifest.json');
  });

  it("gives the site's own head back on a page of the domain that isn't the app's, and the app's on the way back", async () => {
    rememberedHost.mockReturnValue({ kind: 'domain', config, softnAccess: 'application' });
    bootHead(true);
    await show('/');
    expect(container.textContent).toBe('app shop');
    expect(document.title).toBe('Shop');
    await act(async () => go('/privacy'));
    expect(container.textContent).toBe('platform page');
    expect(document.title).toBe(SITE_TITLE);
    expect(document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('FormLogic');
    expect(manifest()).toBe('/manifest.webmanifest');
    await act(async () => go('/'));
    expect(document.title).toBe('Shop');
    expect(manifest()).toBe('/manifest.json');
  });

  it("gives the site's head back when the server says the domain no longer shows the app", async () => {
    rememberedHost.mockReturnValue({ kind: 'domain', config, softnAccess: 'application' });
    lookUpHost.mockResolvedValue({ config: null, answered: true });
    bootHead(true);
    await show('/');
    expect(document.title).toBe(SITE_TITLE);
    expect(manifest()).toBe('/manifest.webmanifest');
  });
});
