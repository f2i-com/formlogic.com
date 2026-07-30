import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  setOaiyToken,
} from './oaiyRuntime';
import { listOaiySources, oaiyAiChat } from './oaiyAi';

const BASE = 'http://127.0.0.1:19993';

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

describe('listOaiySources', () => {
  it('unwraps the {sources} union', async () => {
    mockFetch(() => ({ status: 200, body: { sources: [{ id: 'provider:openai', kind: 'provider' }] } }));
    const out = await listOaiySources();
    expect(out).toEqual([{ id: 'provider:openai', kind: 'provider' }]);
  });

  it('carries the bearer and hits /api/ai/sources', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { sources: [] } }));
    setOaiyToken('tok');
    await listOaiySources();
    expect(calls[0]!.url).toContain('/api/ai/sources');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns null when unreachable or malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await listOaiySources()).toBeNull();
    mockFetch(() => ({ status: 200, body: { nope: true } }));
    expect(await listOaiySources()).toBeNull();
  });
});

describe('oaiyAiChat — credential-hidden chat', () => {
  it('POSTs to the named-provider gateway with the bearer and returns the raw completion', async () => {
    const completion = { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ message: { content: 'hi' } }] };
    const { calls } = mockFetch(() => ({ status: 200, body: completion }));
    setOaiyToken('tok');
    const res = await oaiyAiChat('openai', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(res).toEqual({ ok: true, data: completion });
    expect(calls[0]!.url).toContain('/api/ai/providers/openai/v1/chat/completions');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    // The browser never sends the key — only the model + messages it authored.
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('gpt-4o-mini');
  });

  it('maps an upstream error to a typed failure (not a transport failure)', async () => {
    mockFetch(() => ({ status: 502, body: { error: { code: 'upstream_error', message: 'upstream 401' } } }));
    const res = await oaiyAiChat('openai', { messages: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('upstream 401');
      expect(res.transportFailure).toBeUndefined();
    }
  });

  it('marks a transport failure so the caller can distinguish OAIY vanishing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await oaiyAiChat('openai', { messages: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.transportFailure).toBe(true);
  });
});
