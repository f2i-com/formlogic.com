// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLaunchConfig, lookUpHost, rememberedHost } from './domainLaunchApi';

// Every page of a self-hosted site starts by asking this, and the question used to have no timeout:
// on a weak signal, an installed app sat on a spinner until the network gave up.

const CONFIG = { app: { slug: 'shop' }, domain: { domain: 'x', mode: 'launch_page' }, landing: { headline: 'Hi' } };
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
  it('remembers a customer\'s domain', async () => {
    const host = newHost();
    stubFetch(async () => json(CONFIG));

    expect(await lookUpHost(host)).toEqual({ config: CONFIG, answered: true });
    expect(rememberedHost(host)).toBe('domain');
  });

  it('remembers a host that isn\'t one: a 404 is an answer', async () => {
    const host = newHost();
    stubFetch(async () => json({ error: true }, 404));

    expect(await lookUpHost(host)).toEqual({ config: null, answered: true });
    expect(rememberedHost(host)).toBe('not-domain');
  });

  it('does not take FormLogic\'s own address for a customer\'s, even with an app connected to it', async () => {
    const host = newHost();
    stubFetch(async () => json({ ...CONFIG, platformUrl: `https://${host}` }));

    await lookUpHost(host);

    expect(rememberedHost(host)).toBe('not-domain');
  });

  it('forgets an old answer when the server gives a new one', async () => {
    const host = newHost();
    localStorage.setItem(`formlogic:domain-host:${host}`, 'domain');
    stubFetch(async () => json({ error: true }, 404));

    await lookUpHost(host);

    expect(rememberedHost(host)).toBe('not-domain');
  });

  it('asks once for a page, however many callers ask', async () => {
    const host = newHost();
    const fetchMock = stubFetch(async () => json(CONFIG));

    await Promise.all([lookUpHost(host), lookUpHost(host)]);
    await lookUpHost(host);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after about 2.5 seconds, and remembers nothing', async () => {
    vi.useFakeTimers();
    const host = newHost();
    stubFetch(silent);
    let settled: unknown = null;
    void lookUpHost(host).then((result) => { settled = result; });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(600);

    expect(settled).toEqual({ config: null, answered: false });
    expect(rememberedHost(host)).toBeNull();
  });

  it('holds the timeout over a body that stalls, not just the headers', async () => {
    vi.useFakeTimers();
    const host = newHost();
    stubFetch(async (init) => ({
      ok: true,
      status: 200,
      json: () => silent(init),
    }) as unknown as Response);
    let settled: unknown = null;
    void lookUpHost(host).then((result) => { settled = result; });

    await vi.advanceTimersByTimeAsync(2_600);

    expect(settled).toEqual({ config: null, answered: false });
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
    ['JSON that is not a config', () => json({ hello: 'world' })],
  ])('takes %s for no answer: it says nothing about the host', async (_label, answer) => {
    const host = newHost();
    localStorage.setItem(`formlogic:domain-host:${host}`, 'domain');
    stubFetch(async () => answer());

    expect(await lookUpHost(host)).toEqual({ config: null, answered: false });

    expect(rememberedHost(host)).toBe('domain');
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

describe('fetchLaunchConfig', () => {
  // The consent page on FormLogic itself: nobody is waiting on a whole site's load there, and a slow
  // answer must not read as an address that isn't connected.
  it('has no timeout', async () => {
    const fetchMock = stubFetch(async () => json(CONFIG));

    expect(await fetchLaunchConfig(newHost())).toEqual(CONFIG);

    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
  });
});
