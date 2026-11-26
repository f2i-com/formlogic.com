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

  it('says a malformed tool call in words, as the engine refuses it and as OAIY\'s gateway hands that on', async () => {
    const friendly = 'The model returned an invalid tool call. Try asking again or choose another model in OAIY.';
    mockFetch(() => ({ status: 422, body: { error: { code: 'tool_contract_error', message: 'tool_contract_error: missing function tag; no tool from this batch was executed' } } }));
    expect(await oaiyAiChat('oaiy-engine', { messages: [] })).toMatchObject({ ok: false, error: { message: friendly } });
    // The gateway's wrapping (ai/gateway.rs): 502 upstream_error, the engine's error inside the message.
    mockFetch(() => ({ status: 502, body: { error: { code: 'upstream_error', message: 'upstream 422 Unprocessable Entity: {"code":"tool_contract_error","message":"tool_contract_error: missing function tag; no tool from this batch was executed","type":"invalid_request_error"}' } } }));
    expect(await oaiyAiChat('oaiy-engine', { messages: [] })).toMatchObject({ ok: false, error: { code: 'command_failed', message: friendly } });
    // Any other refusal of a provider's keeps its own words.
    mockFetch(() => ({ status: 502, body: { error: { code: 'upstream_error', message: 'upstream 429 Too Many Requests: {"message":"Rate limit reached"}' } } }));
    expect(await oaiyAiChat('openai', { messages: [] })).toMatchObject({ ok: false, error: { message: 'upstream 429 Too Many Requests: {"message":"Rate limit reached"}' } });
  });

  it('hands on what OAIY itself said beside the mapped code, which has one word for most refusals', async () => {
    // "That provider is not on this computer" and "the provider failed" are both command_failed.
    mockFetch(() => ({ status: 404, body: { error: { code: 'no_provider', message: 'No enabled AI chat provider is configured for this source.' } } }));
    expect(await oaiyAiChat('work-openai', { messages: [] })).toEqual({
      ok: false,
      error: { code: 'command_failed', message: 'No enabled AI chat provider is configured for this source.' },
      refusal: { code: 'no_provider', status: 404 },
    });
    mockFetch(() => ({ status: 500, body: undefined }));
    expect(await oaiyAiChat('work-openai', { messages: [] })).toMatchObject({ ok: false, refusal: { code: '', status: 500 } });
  });

  it('marks a transport failure so the caller can distinguish OAIY vanishing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await oaiyAiChat('openai', { messages: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.transportFailure).toBe(true);
  });

  describe('how long it waits', () => {
    /** An OAIY that has taken the request and is still working on it (an engine loading). */
    function stillWorking() {
      const fn = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      vi.stubGlobal('fetch', fn);
      return fn;
    }
    const settled = (promise: Promise<unknown>) => {
      let done = false;
      void promise.then(() => { done = true; });
      return () => done;
    };
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('waits as long as the caller\'s signal does, when the caller names no time of its own', async () => {
      // A flow run's deadline is its signal: three minutes with an AI step, where a cut at 30 s
      // failed every chat that had to load its engine first.
      const fetchFn = stillWorking();
      const run = new AbortController();
      const asked = oaiyAiChat('openai', { messages: [] }, { signal: run.signal });
      const done = settled(asked);
      await vi.advanceTimersByTimeAsync(170_000);
      expect(done()).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      run.abort();
      expect(await asked).toEqual({ ok: false, error: { code: 'connector_uncertain', message: 'OAIY Desktop did not answer in time.' } });
    });

    it('gives up after 30 s with neither a signal nor a time, and after the time it is given', async () => {
      stillWorking();
      const bare = oaiyAiChat('openai', { messages: [] });
      const bareDone = settled(bare);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(bareDone()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await bare).ok).toBe(false);

      const timed = oaiyAiChat('openai', { messages: [] }, { signal: new AbortController().signal, timeoutMs: 60_000 });
      const timedDone = settled(timed);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(timedDone()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await timed).ok).toBe(false);
    });

    it('says a chat it stopped waiting for may have run, and is not a transport failure', async () => {
      // A transport failure is one a caller may send again, or by another route. This one went
      // out: the provider may be answering, and billing, still.
      stillWorking();
      const asked = oaiyAiChat('openai', { messages: [] });
      await vi.advanceTimersByTimeAsync(30_000);
      const res = await asked;
      expect(res).toEqual({ ok: false, error: { code: 'connector_uncertain', message: 'OAIY Desktop did not answer in time.' } });
      expect((res as { transportFailure?: boolean }).transportFailure).toBeUndefined();
    });
  });
});
