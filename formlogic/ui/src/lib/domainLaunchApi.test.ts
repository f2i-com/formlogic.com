// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLaunchConfig, lookUpHost, rememberedHost, rememberHost, type LaunchConfig } from './domainLaunchApi';

// Every page of a self-hosted site starts by asking this. Only a real answer may say what a host
// is: a slow network used to count as "no customer's domain" and put FormLogic's pages on one.

const CONFIG = { app: { slug: 'shop' }, domain: { domain: 'x', mode: 'launch_page' }, landing: { headline: 'Hi' } };
const STORED_CONFIG = CONFIG as unknown as LaunchConfig;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let hosts = 0;
/** The lookups live for the page, so each test has a host of its own. */
const newHost = () => `host-${++hosts}.example`;

function stubFetch(answer: (init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => answer(init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A server that takes the request and never answers: only the abort ends it, as in a browser. */
const silent = (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lookUpHost', () => {
  it('returns a customer\'s domain, for the caller to keep with what its app is', async () => {
    const host = newHost();
    stubFetch(async () => json(CONFIG));

    expect(await lookUpHost(host)).toEqual({ config: CONFIG, answered: true });
    expect(rememberedHost(host)).toBeNull();
  });

  it('remembers a host that isn\'t one: a 404 is an answer', async () => {
    const host = newHost();
    stubFetch(async () => json({ error: true }, 404));

    expect(await lookUpHost(host)).toEqual({ config: null, answered: true });
    expect(rememberedHost(host)).toEqual({ kind: 'not-domain' });
  });

  it('carries the server\'s word that the host is the site\'s own', async () => {
    const host = newHost();
    stubFetch(async () => json({ error: true, message: 'Domain not connected', platform: true }, 404));

    expect(await lookUpHost(host)).toEqual({ config: null, answered: true, platform: true });
    expect(rememberedHost(host)).toEqual({ kind: 'not-domain' });
  });

  it('forgets an old answer when the server gives a new one', async () => {
    const host = newHost();
    rememberHost(host, STORED_CONFIG, 'members');
    stubFetch(async () => json({ error: true }, 404));

    await lookUpHost(host);

    expect(rememberedHost(host)).toEqual({ kind: 'not-domain' });
  });

  it('asks once for a page, however many callers ask', async () => {
    const host = newHost();
    const fetchMock = stubFetch(async () => json(CONFIG));

    await Promise.all([lookUpHost(host), lookUpHost(host)]);
    await lookUpHost(host);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets a try run for 15 seconds, and remembers nothing when it ends', async () => {
    vi.useFakeTimers();
    const host = newHost();
    stubFetch(silent);
    let settled: unknown = null;
    void lookUpHost(host).then((result) => { settled = result; });

    await vi.advanceTimersByTimeAsync(14_900);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(100);

    expect(settled).toEqual({ config: null, answered: false });
    expect(rememberedHost(host)).toBeNull();
  });

  it.each([200, 404])('holds the timeout over a %i whose body stalls, not just the headers', async (status) => {
    vi.useFakeTimers();
    const host = newHost();
    stubFetch(async (init) => ({
      ok: status === 200,
      status,
      json: () => silent(init),
    }) as unknown as Response);
    let settled: unknown = null;
    void lookUpHost(host).then((result) => { settled = result; });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(settled).toEqual({ config: null, answered: false });
    expect(rememberedHost(host)).toBeNull();
  });

  it('does not wait, or ask, when the browser is offline', async () => {
    const host = newHost();
    const fetchMock = stubFetch(silent);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    expect(await lookUpHost(host)).toEqual({ config: null, answered: false });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a rate limit', () => json({ error: true }, 429)],
    ['a server error', () => json({ error: true }, 503)],
    ['a page that is not the API', () => new Response('<html>', { status: 200 })],
    ['a 404 page from something in front of the API', () => new Response('<html>Not Found</html>', { status: 404 })],
    ['a 404 with JSON that is not the server\'s', () => json('Not Found', 404)],
    ['JSON that is not a config', () => json({ hello: 'world' })],
  ])('takes %s for no answer: it says nothing about the host', async (_label, answer) => {
    const host = newHost();
    rememberHost(host, STORED_CONFIG, 'members');
    stubFetch(async () => answer());

    expect(await lookUpHost(host)).toEqual({ config: null, answered: false });

    expect(rememberedHost(host)).toEqual({ kind: 'domain', config: CONFIG, softnAccess: 'members' });
  });

  it('asks again after no answer', async () => {
    const host = newHost();
    const fetchMock = stubFetch(async () => json({ error: true }, 503));
    await lookUpHost(host);
    fetchMock.mockImplementation(async () => json(CONFIG));

    expect((await lookUpHost(host)).answered).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('works with storage blocked, remembering nothing', async () => {
    const host = newHost();
    stubFetch(async () => json(CONFIG));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });

    expect((await lookUpHost(host)).answered).toBe(true);
    expect(rememberedHost(host)).toBeNull();
  });
});

describe('what is remembered about a host', () => {
  it('keeps a domain with its config and access, so the next page can draw from them', () => {
    const host = newHost();
    rememberHost(host, STORED_CONFIG, 'application');
    expect(rememberedHost(host)).toEqual({ kind: 'domain', config: CONFIG, softnAccess: 'application' });
  });

  it('keeps a domain of any other kind of app, with no access', () => {
    const host = newHost();
    rememberHost(host, STORED_CONFIG);
    expect(rememberedHost(host)).toEqual({ kind: 'domain', config: CONFIG });
  });

  it('does not take FormLogic\'s own address for a customer\'s, even with an app connected to it', () => {
    const host = newHost();
    rememberHost(host, { ...STORED_CONFIG, platformUrl: `https://${host}` }, 'members');
    expect(rememberedHost(host)).toEqual({ kind: 'not-domain' });
  });

  it('reads the plain words an older version kept', () => {
    const host = newHost();
    localStorage.setItem(`formlogic:domain-host:${host}`, 'domain');
    expect(rememberedHost(host)).toEqual({ kind: 'domain' });

    localStorage.setItem(`formlogic:domain-host:${host}`, 'not-domain');
    expect(rememberedHost(host)).toEqual({ kind: 'not-domain' });
  });

  it.each(['{not json', '{"softnAccess":"members"}', '{"config":{"app":{}}}', 'null'])('knows nothing from a value it can\'t read: %s', (value) => {
    const host = newHost();
    localStorage.setItem(`formlogic:domain-host:${host}`, value);
    expect(rememberedHost(host)).toBeNull();
  });

  it('finds a host whatever its case', () => {
    const host = newHost();
    rememberHost(host.toUpperCase(), STORED_CONFIG, 'members');
    expect(rememberedHost(host)?.kind).toBe('domain');
  });
});

describe('fetchLaunchConfig', () => {
  // The consent page on FormLogic itself: nobody is waiting on a whole site's load there, and a slow
  // answer must not read as an address that isn't connected.
  it('has no timeout', async () => {
    const fetchMock = stubFetch(async () => json(CONFIG));

    expect(await fetchLaunchConfig(newHost())).toEqual(CONFIG);

    expect(fetchMock.mock.calls[0]![1]!.signal).toBeUndefined();
  });
});
