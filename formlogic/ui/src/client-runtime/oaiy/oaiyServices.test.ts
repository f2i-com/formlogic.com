import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  setOaiyToken,
} from './oaiyRuntime';
import { listOaiyServices, oaiyServiceAction } from './oaiyServices';

const BASE = 'http://127.0.0.1:19996';

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

beforeEach(() => {
  __setOaiyBaseUrlForTests(BASE);
  setOaiyToken(null);
});
afterEach(() => {
  __resetOaiyBaseUrlForTests();
  setOaiyToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('listOaiyServices', () => {
  it('maps OAIY /api/services to the FormLogic Desktop service shape (node null)', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        services: [
          {
            id: 'llamacpp',
            name: 'llama.cpp',
            description: 'local llm',
            category: 'llm',
            status: 'running',
            error: null,
            port: 8080,
            defaultPort: 8080,
            pid: 1234,
            docsUrl: 'https://x',
          },
        ],
        dataDir: 'C:/data',
      },
    }));
    const out = await listOaiyServices();
    expect(out).toEqual([
      {
        id: 'llamacpp',
        name: 'llama.cpp',
        category: 'llm',
        status: 'running',
        port: 8080,
        defaultPort: 8080,
        docsUrl: 'https://x',
        node: null,
      },
    ]);
  });

  it('carries the bearer when a token is held', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { services: [] } }));
    setOaiyToken('tok');
    await listOaiyServices();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0]!.url).toContain('/api/services');
  });

  it('returns [] when OAIY answers with no services', async () => {
    mockFetch(() => ({ status: 200, body: { services: [] } }));
    expect(await listOaiyServices()).toEqual([]);
  });

  it('returns null when unreachable (so the caller can fall back)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await listOaiyServices()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the timeout active while reading the body and clears it afterwards', async () => {
    vi.useFakeTimers();
    let finishBody!: (body: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) })));
    const pending = listOaiyServices();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    finishBody({ services: [] });
    expect(await pending).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns null on a non-ok response or a malformed body', async () => {
    mockFetch(() => ({ status: 500, body: { error: 'boom' } }));
    expect(await listOaiyServices()).toBeNull();
  });
});

describe('oaiyServiceAction', () => {
  it.each(['start', 'stop', 'repair'] as const)('%s posts to its route with the token', async (action) => {
    setOaiyToken('t');
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true } }));
    expect(await oaiyServiceAction('llama.cpp', action)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/services/llama.cpp/${action}`);
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer t');
  });

  it('restarts with a stop and a start: OAIY has no route for it, and its relay does the same', async () => {
    const { calls } = mockFetch((url) => (url.endsWith('/stop') ? { status: 400, body: { error: 'not running' } } : { status: 200, body: { ok: true } }));
    expect(await oaiyServiceAction('a/b', 'restart')).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/services/a%2Fb/stop`, `${BASE}/api/services/a%2Fb/start`]);
  });

  it('says what OAIY said went wrong: a service route refuses in plain text', async () => {
    mockFetch(() => ({ status: 400, body: { error: 'port 8080 is in use' } }));
    expect(await oaiyServiceAction('llama.cpp', 'start')).toEqual({ ok: false, error: 'port 8080 is in use' });
  });
});
