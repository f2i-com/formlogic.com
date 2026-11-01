// @vitest-environment jsdom
// The router and the real lookup and storage, with only the network stubbed: what a slow or failing
// server does to a page, which the router's own tests can't show with the lookup mocked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getNativeEntry } = vi.hoisted(() => ({ getNativeEntry: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { getNativeEntry } }));
vi.mock('./AppLaunchPage', () => ({ AppLaunchPage: () => <p>launch page</p> }));
vi.mock('../components/app-runtime/AppEntryRouter', () => ({
  DomainNativeApp: ({ slug, access }: { slug: string; access: string }) => <p>app {slug} for {access}</p>,
}));

import { DomainLaunchRouter } from './DomainLaunchRouter';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG = {
  app: { slug: 'shop', name: 'Shop', theme: { primaryColor: '#000' } },
  domain: { domain: 'x', mode: 'runtime_direct' },
  landing: { headline: 'Hi' },
  platformUrl: 'https://forms.acme.com',
};
const SOFTN = { data: { home: true, access: 'members', native: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let hosts = 0;
/** A lookup that was answered lives for the page, so each test has a host of its own. */
const newHost = () => `router-${++hosts}.example`;
const remember = (host: string, value: string) => localStorage.setItem(`formlogic:domain-host:${host}`, value);
const kept = (host: string) => localStorage.getItem(`formlogic:domain-host:${host}`);

/** A server that takes the request and never answers: only the abort ends it, as in a browser. */
const silent = (init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});

function stubFetch(answer: (init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => answer(init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let root: Root;
let container: HTMLDivElement;
const show = async (host: string, path: string) => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <DomainLaunchRouter host={host}><p>platform page</p></DomainLaunchRouter>
    </MemoryRouter>
  ));
  return container.textContent ?? '';
};
const waitFor = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const assign = vi.fn();
const location = window.location;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  assign.mockClear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...location, assign, replace: vi.fn() } });
  getNativeEntry.mockReset().mockResolvedValue(SOFTN);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.defineProperty(window, 'location', { configurable: true, value: location });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a first visit to a customer\'s domain', () => {
  it('reaches its app after a 429, and shows nothing of the platform on the way', async () => {
    const host = newHost();
    const fetchMock = stubFetch(async () => json({ error: true }, 429));

    expect(await show(host, '/login')).not.toContain('platform page');
    await waitFor(2_900);
    expect(container.textContent).not.toContain('platform page');

    fetchMock.mockImplementation(async () => json(CONFIG));
    await waitFor(100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('platform page');
    expect(assign.mock.calls[0][0]).toContain('https://forms.acme.com/sign-in/domain');
    expect(JSON.parse(kept(host)!)).toEqual({ config: CONFIG, softnAccess: 'members' });
  });

  it('takes an answer slower than the old 2.5 seconds', async () => {
    const host = newHost();
    stubFetch(() => new Promise((resolve) => { setTimeout(() => resolve(json(CONFIG)), 6_000); }));

    expect(await show(host, '/')).not.toContain('platform page');
    await waitFor(5_900);
    expect(container.textContent).not.toContain('platform page');
    await waitFor(100);

    expect(container.textContent).toBe('app shop for members');
  });

  it('lets a try run for 15 seconds, then asks again', async () => {
    const host = newHost();
    const fetchMock = stubFetch(silent);
    await show(host, '/');

    await waitFor(14_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.signal?.aborted).toBe(false);
    await waitFor(100);
    expect(fetchMock.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    expect(kept(host)).toBeNull();

    await waitFor(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Can't reach this site right now");
  });

  it('asks nothing while offline, and asks when the browser is back', async () => {
    const host = newHost();
    const fetchMock = stubFetch(async () => json(CONFIG));
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await show(host, '/');
    await waitFor(9_000);
    expect(fetchMock).not.toHaveBeenCalled();

    offline.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('app shop for members');
    offline.mockRestore();
  });
});

describe('a returning visitor', () => {
  it.each([
    ['a 429', async () => json({ error: true }, 429)],
    ['a 503', async () => json({ error: true }, 503)],
    ['a dropped connection', async () => { throw new TypeError('Failed to fetch'); }],
  ])('keeps the app, and what is stored, through %s', async (_label, failure) => {
    const host = newHost();
    const stored = JSON.stringify({ config: CONFIG, softnAccess: 'members' });
    remember(host, stored);
    const fetchMock = stubFetch(failure);

    expect(await show(host, '/dashboard')).toBe('app shop for members');
    await waitFor(40_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(container.textContent).toBe('app shop for members');
    expect(kept(host)).toBe(stored);
  });

  it('leaves for FormLogic from /login with no answer at all', async () => {
    const host = newHost();
    remember(host, JSON.stringify({ config: CONFIG, softnAccess: 'members' }));
    stubFetch(silent);

    expect(await show(host, '/login')).not.toContain('platform page');

    expect(assign.mock.calls[0][0]).toContain('https://forms.acme.com/sign-in/domain');
  });

  it('lets a real answer replace what is stored', async () => {
    const host = newHost();
    remember(host, JSON.stringify({ config: CONFIG, softnAccess: 'members' }));
    stubFetch(async () => json({ error: true }, 404));

    await show(host, '/');

    expect(kept(host)).toBe('not-domain');
    expect(container.textContent).toContain("This domain isn't connected yet");
  });

  it('keeps the last access when only the app\'s own answer failed', async () => {
    const host = newHost();
    const stored = JSON.stringify({ config: CONFIG, softnAccess: 'members' });
    remember(host, stored);
    stubFetch(async () => json(CONFIG));
    getNativeEntry.mockResolvedValue({ error: 'Too many requests', status: 429 });

    expect(await show(host, '/dashboard')).toBe('app shop for members');
    expect(kept(host)).toBe(stored);
  });
});

describe('a domain connected since the last visit', () => {
  it('takes over from a page that showed at once', async () => {
    const host = newHost();
    remember(host, 'not-domain');
    stubFetch(() => new Promise((resolve) => { setTimeout(() => resolve(json(CONFIG)), 5_000); }));

    expect(await show(host, '/')).toBe('platform page');
    await waitFor(5_000);

    expect(container.textContent).toBe('app shop for members');
  });

  it('shows no password form for as long as the answer may be on its way', async () => {
    const host = newHost();
    remember(host, 'not-domain');
    stubFetch(() => new Promise((resolve) => { setTimeout(() => resolve(json(CONFIG)), 2_000); }));

    expect(await show(host, '/app/shop')).not.toContain('platform page');
    await waitFor(2_000);

    expect(container.textContent).toBe('app shop for members');
  });
});

describe('a self-hosted site', () => {
  it('shows every page once the server says the host is its own, and remembers that', async () => {
    const host = newHost();
    stubFetch(async () => json({ error: true, message: 'Domain not connected', platform: true }, 404));

    expect(await show(host, '/')).toBe('platform page');
    expect(kept(host)).toBe('not-domain');
  });

  it('does not wait on a later visit, however slow the server is', async () => {
    const host = newHost();
    remember(host, 'not-domain');
    stubFetch(silent);

    expect(await show(host, '/dashboard')).toBe('platform page');
  });
});
