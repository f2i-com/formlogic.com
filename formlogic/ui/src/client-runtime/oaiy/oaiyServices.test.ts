import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  setOaiyToken,
} from './oaiyRuntime';
import { listOaiyServices } from './oaiyServices';

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
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await listOaiyServices()).toBeNull();
  });

  it('returns null on a non-ok response or a malformed body', async () => {
    mockFetch(() => ({ status: 500, body: { error: 'boom' } }));
    expect(await listOaiyServices()).toBeNull();
  });
});
