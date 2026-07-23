// Tests for the plan §5.6 "Default (from Settings)" AI alias (browser-runner half).
//
// Covers: the full resolution matrix (site → hosted /api/ai/chat, desktop → E2E tunnel,
// custom → browser-local registry), typed failure pass-through (ai_allowance_exceeded,
// tunnel codes, ai_default_unresolved) with NO silent source hop, the 60s preferences
// cache, the interim contract fetch (until lib/api grows its methods), and the
// resolved-source label shown by the editor picker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAiDefaultForTests,
  __setAiPreferencesFetcherForTests,
  defaultSourceLabel,
  getAiPreferences,
  invalidateAiPreferencesCache,
  resolveDefaultLlm,
  type AiDefaultResult,
  type AiPreferences,
  type ResolveDefaultLlmDeps,
} from './aiDefault';
import type { ResolvedAiProvider } from './aiProviders';
import type { ChatViaTunnelSuccess, DesktopTunnelResult } from '../desktop/desktopTunnel';
import { useAuthStore } from '../../stores/authStore';

const MESSAGES = [{ role: 'user', content: 'hello' }];

function prefs(overrides: Partial<AiPreferences> = {}): AiPreferences {
  return {
    aiSource: 'site',
    desktopProviderId: null,
    desktopModel: null,
    customProviderId: null,
    chatToolMode: null,
    ...overrides,
  };
}

function prefsOk(value: AiPreferences): AiDefaultResult<AiPreferences> {
  return { ok: true, data: value };
}

function customProvider(overrides: Partial<ResolvedAiProvider> = {}): ResolvedAiProvider {
  return {
    name: 'My OpenAI',
    kind: 'openai',
    url: 'https://api.openai.test/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
    model: 'provider-model',
    responsePath: 'choices.0.message.content',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  __resetAiDefaultForTests();
  vi.unstubAllGlobals();
  useAuthStore.setState({ user: null });
});

describe('resolveDefaultLlm — resolution matrix', () => {
  it("site source → POSTed chat via the site lane, content + usage returned", async () => {
    const siteChat = vi.fn(async () => ({ ok: true as const, data: { content: 'site pong', usage: { in: 3, out: 2 } } }));
    const tunnelChat = vi.fn();
    const resolveCustomProvider = vi.fn();
    const deps: ResolveDefaultLlmDeps = {
      fetchPreferences: async () => prefsOk(prefs({ aiSource: 'site' })),
      siteChat,
      tunnelChat,
      resolveCustomProvider,
    };

    const out = await resolveDefaultLlm({ messages: MESSAGES }, deps);

    expect(out).toEqual({ ok: true, data: { source: 'site', content: 'site pong', usage: { in: 3, out: 2 } } });
    expect(siteChat).toHaveBeenCalledWith(MESSAGES, undefined);
    expect(tunnelChat).not.toHaveBeenCalled();
    expect(resolveCustomProvider).not.toHaveBeenCalled();
  });

  it("site source → 'ai_allowance_exceeded' passes through verbatim, never a source hop", async () => {
    const siteChat = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'ai_allowance_exceeded' as const, message: 'Monthly Site AI allowance used up.', status: 402 },
    }));
    const tunnelChat = vi.fn();
    const resolveCustomProvider = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      { fetchPreferences: async () => prefsOk(prefs()), siteChat, tunnelChat, resolveCustomProvider }
    );

    expect(out).toEqual({
      ok: false,
      error: { code: 'ai_allowance_exceeded', message: 'Monthly Site AI allowance used up.', status: 402 },
    });
    expect(tunnelChat).not.toHaveBeenCalled();
    expect(resolveCustomProvider).not.toHaveBeenCalled();
  });

  it('desktop source → tunnel chat with the settings provider + model', async () => {
    const tunnelChat = vi.fn(
      async (): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> => ({
        ok: true,
        data: { threadId: 'thread-1', finalText: 'desktop pong' },
      })
    );
    const siteChat = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => prefsOk(prefs({ aiSource: 'desktop', desktopProviderId: 'codex', desktopModel: 'gpt-5' })),
        siteChat,
        tunnelChat,
      }
    );

    expect(out).toEqual({ ok: true, data: { source: 'desktop', content: 'desktop pong', threadId: 'thread-1' } });
    expect(tunnelChat).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'codex', model: 'gpt-5', messages: MESSAGES })
    );
    expect(siteChat).not.toHaveBeenCalled();
  });

  it('desktop source → a blank desktop model is omitted, not sent as an empty string', async () => {
    const tunnelChat = vi.fn(
      async (): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> => ({
        ok: true,
        data: { threadId: 't', finalText: 'pong' },
      })
    );
    await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => prefsOk(prefs({ aiSource: 'desktop', desktopProviderId: 'codex', desktopModel: '  ' })),
        tunnelChat,
      }
    );
    expect(tunnelChat).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex', model: undefined }));
  });

  it('desktop source without a chosen provider → ai_default_unresolved, tunnel never called', async () => {
    const tunnelChat = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      { fetchPreferences: async () => prefsOk(prefs({ aiSource: 'desktop', desktopProviderId: null })), tunnelChat }
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('ai_default_unresolved');
    expect(tunnelChat).not.toHaveBeenCalled();
  });

  it('desktop source → tunnel typed errors pass through verbatim, never a source hop', async () => {
    const tunnelChat = vi.fn(
      async (): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> => ({
        ok: false,
        error: { code: 'desktop_offline', message: 'The linked desktop is offline.' },
      })
    );
    const siteChat = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => prefsOk(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' })),
        siteChat,
        tunnelChat,
      }
    );

    expect(out).toEqual({ ok: false, error: { code: 'desktop_offline', message: 'The linked desktop is offline.', status: undefined } });
    expect(siteChat).not.toHaveBeenCalled();
  });

  it('custom source → browser-local registry provider, OpenAI-shaped POST', async () => {
    const provider = customProvider({ responsePath: 'reply.text' });
    const fetchFn = vi.fn(async () => jsonResponse({ reply: { text: 'custom pong' } })) as unknown as typeof fetch;
    const resolveCustomProvider = vi.fn(async () => provider);
    const siteChat = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => prefsOk(prefs({ aiSource: 'custom', customProviderId: 'p1' })),
        siteChat,
        resolveCustomProvider,
        fetchFn,
      }
    );

    expect(out).toEqual({ ok: true, data: { source: 'custom', content: 'custom pong' } });
    expect(resolveCustomProvider).toHaveBeenCalledWith('p1');
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.openai.test/v1/chat/completions');
    expect((call[1] as RequestInit).headers).toEqual(provider.headers);
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ messages: MESSAGES, model: 'provider-model' });
    expect(siteChat).not.toHaveBeenCalled();
  });

  it('custom source → a provider request template is honored', async () => {
    const provider = customProvider({
      requestTemplate: '{"model":"{{apiKey}}","input":{{messages}}}',
      apiKey: 'sk-inline',
      model: undefined,
    });
    const fetchFn = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'pong' } }] })) as unknown as typeof fetch;
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => prefsOk(prefs({ aiSource: 'custom', customProviderId: 'p1' })),
        resolveCustomProvider: async () => provider,
        fetchFn,
      }
    );

    expect(out.ok).toBe(true);
    const body = JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ model: 'sk-inline', input: MESSAGES });
  });

  it('custom source → provider unresolvable in this browser → ai_default_unresolved, no fetch', async () => {
    const fetchFn = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => prefsOk(prefs({ aiSource: 'custom', customProviderId: 'p-gone' })),
        resolveCustomProvider: async () => null,
        fetchFn: fetchFn as unknown as typeof fetch,
      }
    );

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('ai_default_unresolved');
      expect(out.error.message).toMatch(/not configured in this browser/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('custom source without a chosen service → ai_default_unresolved', async () => {
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      { fetchPreferences: async () => prefsOk(prefs({ aiSource: 'custom', customProviderId: null })) }
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('ai_default_unresolved');
  });

  it('preferences that cannot be loaded → ai_default_unresolved naming the cause, no source called', async () => {
    const siteChat = vi.fn();
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => ({ ok: false, error: { code: 'transport', message: 'Network error' } }),
        siteChat,
      }
    );

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('ai_default_unresolved');
      expect(out.error.message).toMatch(/Network error/);
      expect(out.error.message).toMatch(/Settings/);
    }
    expect(siteChat).not.toHaveBeenCalled();
  });

  it('a throwing preferences fetch → ai_default_unresolved (never an unhandled throw)', async () => {
    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      {
        fetchPreferences: async () => {
          throw new Error('db gone');
        },
      }
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('ai_default_unresolved');
  });
});

describe('getAiPreferences — 60s cache', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 'user-1', email: 'u@example.com' } });
  });

  it('serves repeat reads from the cache within the TTL', async () => {
    const fetcher = vi.fn(async () => prefsOk(prefs()));
    __setAiPreferencesFetcherForTests(fetcher);

    await getAiPreferences();
    await getAiPreferences();
    expect(fetcher).toHaveBeenCalledTimes(1);

    invalidateAiPreferencesCache();
    await getAiPreferences();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by user id — an account switch refetches', async () => {
    const fetcher = vi.fn(async () => prefsOk(prefs()));
    __setAiPreferencesFetcherForTests(fetcher);

    await getAiPreferences();
    useAuthStore.setState({ user: { id: 'user-2', email: 'v@example.com' } });
    await getAiPreferences();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never caches failures', async () => {
    let calls = 0;
    __setAiPreferencesFetcherForTests(async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, error: { code: 'transport', message: 'down' } }
        : prefsOk(prefs());
    });

    const first = await getAiPreferences();
    const second = await getAiPreferences();
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('{fresh:true} bypasses the cache', async () => {
    const fetcher = vi.fn(async () => prefsOk(prefs()));
    __setAiPreferencesFetcherForTests(fetcher);
    await getAiPreferences();
    await getAiPreferences({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('defaultSiteChat (interim contract fetch for POST /api/ai/chat)', () => {
  it('POSTs {messages, stream:false} and unwraps {data:{content, usage}}', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { content: 'hosted pong', usage: { total: 9 } } }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      { fetchPreferences: async () => prefsOk(prefs()) }
    );

    expect(out).toEqual({ ok: true, data: { source: 'site', content: 'hosted pong', usage: { total: 9 } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/ai\/chat$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ messages: MESSAGES, stream: false });
  });

  it("passes the route's typed 'ai_allowance_exceeded' through", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: true, code: 'ai_allowance_exceeded', message: 'Monthly allowance used up.' }, 402))
    );

    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      { fetchPreferences: async () => prefsOk(prefs()) }
    );

    expect(out).toEqual({
      ok: false,
      error: { code: 'ai_allowance_exceeded', message: 'Monthly allowance used up.', status: 402 },
    });
  });

  it('a network-level failure is typed transport, not a silent fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hangup');
      })
    );

    const out = await resolveDefaultLlm(
      { messages: MESSAGES },
      { fetchPreferences: async () => prefsOk(prefs()) }
    );

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('transport');
      expect(out.error.message).toMatch(/socket hangup/);
    }
  });
});

describe('defaultSourceLabel (picker hint)', () => {
  it('site reads "Site AI"', () => {
    expect(defaultSourceLabel(prefs())).toBe('Site AI');
  });

  it('desktop names the chosen provider, or flags the missing choice honestly', () => {
    expect(defaultSourceLabel(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' }))).toBe('Desktop — codex');
    expect(defaultSourceLabel(prefs({ aiSource: 'desktop' }))).toBe('Desktop (no provider chosen)');
  });

  it('custom prefers the registry name, falls back to the id, then an honest empty state', () => {
    expect(defaultSourceLabel(prefs({ aiSource: 'custom', customProviderId: 'p1' }), 'My OpenAI')).toBe('Custom — My OpenAI');
    expect(defaultSourceLabel(prefs({ aiSource: 'custom', customProviderId: 'p1' }))).toBe('Custom — p1');
    expect(defaultSourceLabel(prefs({ aiSource: 'custom' }))).toBe('Custom (no service chosen)');
  });
});
