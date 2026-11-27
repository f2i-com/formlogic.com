// resolveDefaultLlmTools: one model round with the hosted Studio's own tools, through the
// settings-chosen source. Each source that can take tools gets a scripted conversation and
// is checked on the wire; the ones that cannot answer tools-unsupported (so Studio carries
// on in text on the SAME source) — never a hop to another source.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAiDefaultForTests,
  readSiteToolsReply,
  resolveDefaultLlmTools,
  TOOLS_UNSUPPORTED,
  type AiPreferences,
  type ResolveDefaultLlmToolsDeps,
} from './aiDefault';
import type { ResolvedAiProvider } from './aiProviders';
import type { EditorAiMessage, EditorAiTool } from './aiToolCalls';

const TOOLS: EditorAiTool[] = [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const MESSAGES: EditorAiMessage[] = [
  { role: 'system', content: 'You edit Softn apps.' },
  { role: 'user', content: 'What is on the main screen?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'ui/main.ui' } }] },
  { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'No such file.', isError: true },
];

function prefs(overrides: Partial<AiPreferences>): AiPreferences {
  return { aiSource: 'site', desktopProviderId: null, desktopModel: null, customProviderId: null, chatToolMode: null, ...overrides };
}

function provider(overrides: Partial<ResolvedAiProvider> = {}): ResolvedAiProvider {
  return {
    name: 'My service',
    kind: 'openai',
    url: 'https://api.openai.test/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
    model: 'configured-model',
    responsePath: 'choices.0.message.content',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const COMPLETION = {
  choices: [{ message: { content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"ui/app.ui"}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 310, completion_tokens: 22, total_tokens: 332 },
};

afterEach(() => {
  __resetAiDefaultForTests();
  vi.unstubAllGlobals();
});

describe('resolveDefaultLlmTools — custom (browser) AI service over OpenAI-compatible tools', () => {
  async function run(p: ResolvedAiProvider, maxOutputTokens?: number) {
    const fetchFn = vi.fn(async () => jsonResponse(COMPLETION));
    const deps: ResolveDefaultLlmToolsDeps = {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'custom', customProviderId: 'svc' }) }),
      resolveCustomProvider: async () => p,
      fetchFn: fetchFn as unknown as typeof fetch,
    };
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS, ...(maxOutputTokens ? { maxOutputTokens } : {}) }, deps);
    const [url, init] = (fetchFn.mock.calls[0] ?? []) as unknown as [string, RequestInit];
    return { result, fetchFn, url, init, body: init ? JSON.parse(String(init.body)) : undefined };
  }

  it('sends the conversation as tool_calls / role:tool with the tools, and returns the calls with usage', async () => {
    const { result, url, init, body } = await run(provider(), 16384);
    expect(url).toBe('https://api.openai.test/v1/chat/completions');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' });
    expect(body).toEqual({
      model: 'configured-model',
      messages: [
        { role: 'system', content: 'You edit Softn apps.' },
        { role: 'user', content: 'What is on the main screen?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"ui/main.ui"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'Error: No such file.' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: TOOLS[0].inputSchema } }],
      // OpenAI's own API takes the output cap under its current name.
      max_completion_tokens: 16384,
    });
    expect(result).toEqual({
      ok: true,
      data: { source: 'custom', text: '', toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'ui/app.ui' } }], stopReason: 'tool_calls', usage: { inputTokens: 310, outputTokens: 22 } },
    });
  });

  it('uses max_tokens for an OpenAI-compatible local server, and sends no model the service does not name', async () => {
    const { body } = await run(provider({ kind: 'ollama', model: undefined, url: 'http://localhost:11434/v1/chat/completions' }), 4096);
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('model');
  });

  it('answers tools-unsupported for a service with a request template, without sending anything', async () => {
    const { result, fetchFn } = await run(provider({ kind: 'custom', requestTemplate: '{"prompt": {{prompt}}}', responsePath: 'output.text' }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(TOOLS_UNSUPPORTED);
  });

  it('answers tools-unsupported for a service read on a non-OpenAI response path', async () => {
    const { result, fetchFn } = await run(provider({ kind: 'custom', responsePath: 'content.0.text' }));
    expect(fetchFn).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error.code).toBe(TOOLS_UNSUPPORTED);
  });

  it('reports a provider refusal as a failure of that service, not tools-unsupported', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: { message: 'bad' } }, 400));
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'custom', customProviderId: 'svc' }) }),
      resolveCustomProvider: async () => provider(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });
  });
});

describe('resolveDefaultLlmTools — Site AI', () => {
  it('passes the neutral request to the backend and returns its reply as the site source', async () => {
    const siteChatTools = vi.fn(async () => ({ ok: true as const, data: { text: 'Done.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } } }));
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS, maxOutputTokens: 1000 }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'site' }) }),
      siteChatTools,
    });
    expect(siteChatTools).toHaveBeenCalledWith({ messages: MESSAGES, tools: TOOLS, maxOutputTokens: 1000 }, undefined);
    expect(result).toEqual({ ok: true, data: { source: 'site', text: 'Done.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } } });
  });

  it('posts {aiTools, messages, tools, maxOutputTokens} to /api/ai/chat with the CSRF header', async () => {
    vi.stubGlobal('document', { cookie: 'formlogic_csrf=tok123' });
    const fetchMock = vi.fn(async () => jsonResponse({ data: { content: '', toolCalls: [{ id: 'call_9', name: 'read_file', arguments: '{"path":"a"}' }], stopReason: 'tool_calls', usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS, maxOutputTokens: 1000 }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'site' }) }),
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/ai\/chat$/);
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok123');
    expect(JSON.parse(String(init.body))).toEqual({ aiTools: 1, messages: MESSAGES, tools: TOOLS, maxOutputTokens: 1000, stream: false });
    expect(result).toEqual({ ok: true, data: { source: 'site', text: '', toolCalls: [{ id: 'call_9', name: 'read_file', arguments: { path: 'a' } }], stopReason: 'tool_calls', usage: { inputTokens: 7, outputTokens: 3 } } });
  });

  it('reads an answer from a server without this mode (no toolCalls) as tools-unsupported', () => {
    expect(readSiteToolsReply({ content: 'plain text', usage: {} })).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
    // An answer that is no reply at all (a PHP error page that did not parse) failed; it is not an old server.
    expect(readSiteToolsReply(null, 200)).toMatchObject({ ok: false, error: { code: 'request_failed' } });
    expect(readSiteToolsReply('<br /><b>Fatal error</b>', 200)).toMatchObject({ ok: false, error: { code: 'request_failed' } });
  });

  it('reads the site\'s AI on OAIY (501 tools-unsupported) as tools-unsupported, so the editor asks in words', async () => {
    vi.stubGlobal('document', { cookie: 'formlogic_csrf=tok123' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: true, code: 'tools-unsupported', message: 'This site\'s AI runs on OAIY, which takes no tools.' }, 501)));
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'site' }) }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED, status: 501 } });
  });

  it('passes a typed refusal (allowance) through unchanged', async () => {
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'site' }) }),
      siteChatTools: async () => ({ ok: false, error: { code: 'ai_allowance_exceeded', message: 'Used up.', status: 402 } }),
    });
    expect(result).toEqual({ ok: false, error: { code: 'ai_allowance_exceeded', message: 'Used up.', status: 402 } });
  });
});

describe('resolveDefaultLlmTools — Desktop', () => {
  it('answers tools-unsupported for anthropic or when local OAIY is unavailable', async () => {
    const siteChatTools = vi.fn();
    const oaiyChat = vi.fn();
    const anthropicRes = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'anthropic' }) }),
      siteChatTools,
      oaiyAvailable: () => true,
      oaiyChat,
    });
    expect(siteChatTools).not.toHaveBeenCalled();
    expect(oaiyChat).not.toHaveBeenCalled();
    expect(anthropicRes).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });

    const offlineRes = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'oaiy-engine' }) }),
      siteChatTools,
      oaiyAvailable: () => false,
      oaiyChat,
    });
    expect(oaiyChat).not.toHaveBeenCalled();
    expect(offlineRes).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
  });

  it('uses local paired OAIY gateway natively for OpenAI-dialect providers and oaiy-engine', async () => {
    const oaiyChat = vi.fn(async () => ({ ok: true as const, data: COMPLETION as Record<string, unknown> }));
    const res = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS, maxOutputTokens: 16384 }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'provider:oaiy-engine', desktopModel: 'ignored-for-engine' }) }),
      oaiyAvailable: () => true,
      oaiyChat,
    });
    expect(oaiyChat).toHaveBeenCalledTimes(1);
    const [pid, body] = oaiyChat.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(pid).toBe('oaiy-engine');
    expect(body).not.toHaveProperty('model');
    expect(body.max_tokens).toBe(16384);
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(res).toEqual({
      ok: true,
      data: {
        source: 'desktop',
        text: '',
        toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'ui/app.ui' } }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 310, outputTokens: 22 },
      },
    });
  });

  it('falls back cleanly to tools-unsupported when local OAIY transport or auth fails', async () => {
    const oaiyChat = vi.fn(async () => ({
      ok: false as const,
      transportFailure: true,
      error: { code: 'connector_unavailable' as const, message: 'OAIY Desktop did not respond.' },
    }));
    const res = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'openai-codex-agent' }) }),
      oaiyAvailable: () => true,
      oaiyChat,
    });
    expect(oaiyChat).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
  });

  it('does not ask again, by the relay or in words, for a chat the OAIY here took and did not answer in time', async () => {
    // The request went out: the provider may be answering, and billing, still. The relay reaches
    // the same Desktop, so asking by it would run the chat a second time.
    const { resolveDefaultLlm } = await import('./aiDefault');
    const unanswered = { ok: false as const, error: { code: 'connector_uncertain' as const, message: 'OAIY Desktop did not answer in time.' } };
    const fetchPreferences = async () => ({ ok: true as const, data: prefs({ aiSource: 'desktop', desktopProviderId: 'openai-codex-agent' }) });
    const tunnelChat = vi.fn();
    const text = await resolveDefaultLlm(
      { messages: [{ role: 'user', content: 'Edit the page' }], editor: true },
      { fetchPreferences, oaiyAvailable: () => true, oaiyChat: async () => unanswered, tunnelChat },
    );
    expect(tunnelChat).not.toHaveBeenCalled();
    expect(text).toEqual({ ok: false, error: unanswered.error });
    const tools = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, { fetchPreferences, oaiyAvailable: () => true, oaiyChat: async () => unanswered });
    expect(tools).toEqual({ ok: false, error: unanswered.error });
  });

  describe('a provider the OAIY on this computer does not have', () => {
    // The provider chosen in Settings is on the Desktop the account is linked to, which is another
    // computer. OAIY here answers as OAIY does (ai/routes.rs), through the real client.
    const relayed = { ok: true as const, data: { finalText: 'From the linked Desktop.', threadId: 't1' } };
    function oaiyAnswers(status: number, code: string, message: string) {
      const fetchFn = vi.fn(async () => jsonResponse({ error: { code, message } }, status));
      vi.stubGlobal('fetch', fetchFn);
      return fetchFn;
    }
    async function ask(providerId: string) {
      const { resolveDefaultLlm } = await import('./aiDefault');
      const fetchPreferences = async () => ({ ok: true as const, data: prefs({ aiSource: 'desktop', desktopProviderId: providerId }) });
      const tunnelChat = vi.fn(async () => relayed);
      const text = await resolveDefaultLlm(
        { messages: [{ role: 'user', content: 'Edit the page' }], editor: true },
        { fetchPreferences, oaiyAvailable: () => true, tunnelChat: tunnelChat as never },
      );
      const tools = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, { fetchPreferences, oaiyAvailable: () => true, listOaiySources: async () => [] });
      return { text, tools, tunnelChat };
    }

    it('is asked for by the relay: OAIY\'s 404 no_provider, whose sentence has no "no provider" in it', async () => {
      const fetchFn = oaiyAnswers(404, 'no_provider', 'No enabled AI chat provider is configured for this source.');
      const { text, tools, tunnelChat } = await ask('provider:work-openai');
      expect(String((fetchFn.mock.calls[0] as unknown as [string])[0])).toContain('/api/ai/providers/work-openai/v1/chat/completions');
      expect(tunnelChat).toHaveBeenCalledTimes(1);
      expect(text).toEqual({ ok: true, data: { source: 'desktop', content: 'From the linked Desktop.', threadId: 't1' } });
      // With tools: the editor is told to ask in words, and the words go by the relay as above.
      expect(tools).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
    });

    it('is asked for by the relay when it is OAIY\'s own engine and the engines here are not running', async () => {
      oaiyAnswers(503, 'engine_unavailable', 'The engines are not running.');
      const { text, tools, tunnelChat } = await ask('oaiy-engine');
      expect(tunnelChat).toHaveBeenCalledTimes(1);
      expect(text).toMatchObject({ ok: true, data: { content: 'From the linked Desktop.' } });
      expect(tools).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
    });

    it('is not what a provider that is here and failed is taken for', async () => {
      oaiyAnswers(502, 'upstream_error', 'upstream 401 Unauthorized');
      const { text, tools, tunnelChat } = await ask('provider:work-openai');
      expect(tunnelChat).not.toHaveBeenCalled();
      expect(text).toEqual({ ok: false, error: { code: 'command_failed', message: 'upstream 401 Unauthorized' } });
      expect(tools).toEqual({ ok: false, error: { code: 'command_failed', message: 'upstream 401 Unauthorized' } });
    });
  });

  it('keeps custom-named Anthropic providers in OAIY on the text protocol instead of dropping tools', async () => {
    const oaiyChat = vi.fn();
    const res = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'claude-work' }) }),
      oaiyAvailable: () => true,
      listOaiySources: async () => [{ id: 'provider:claude-work', providerId: 'claude-work', protocol: 'anthropic' } as never],
      oaiyChat,
    });
    expect(oaiyChat).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
  });

  it('uses local paired OAIY directly for editor text-protocol turns to avoid the 256 KiB relay envelope limit', async () => {
    const { resolveDefaultLlm } = await import('./aiDefault');
    const oaiyChat = vi.fn(async () => ({
      ok: true as const,
      data: { choices: [{ message: { content: '<tool_call name="finish">{"summary":"ok"}</tool_call>' }, finish_reason: 'stop' }] },
    }));
    const tunnelChat = vi.fn();
    const res = await resolveDefaultLlm(
      { messages: [{ role: 'user', content: 'Edit the page' }], editor: true },
      {
        fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'provider:anthropic', desktopModel: 'claude-sonnet' }) }),
        oaiyAvailable: () => true,
        oaiyChat,
        tunnelChat,
      },
    );
    expect(tunnelChat).not.toHaveBeenCalled();
    expect(oaiyChat).toHaveBeenCalledTimes(1);
    const [pid, body] = oaiyChat.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(pid).toBe('anthropic');
    expect(body.model).toBe('claude-sonnet');
    expect(body.max_tokens).toBe(16384);
    expect(res).toEqual({ ok: true, data: { source: 'desktop', content: '<tool_call name="finish">{"summary":"ok"}</tool_call>' } });
  });

  it('fails clearly instead of returning empty text when local OAIY or custom editor providers emit reasoning only', async () => {
    const { resolveDefaultLlm } = await import('./aiDefault');
    const oaiyRes = await resolveDefaultLlm(
      { messages: [{ role: 'user', content: 'Edit the page' }], editor: true },
      {
        fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'oaiy-engine' }) }),
        oaiyAvailable: () => true,
        oaiyChat: vi.fn(async () => ({
          ok: true as const,
          data: { choices: [{ message: { content: '', reasoning_content: 'Thinking about the edit...' }, finish_reason: 'stop' }] },
        })),
      },
    );
    expect(oaiyRes.ok).toBe(false);
    if (!oaiyRes.ok) {
      expect(oaiyRes.error.code).toBe('reasoning_only');
      expect(oaiyRes.error.message).toMatch(/finished reasoning without writing a reply/i);
    }

    // Structured local OAIY tool round preserves reasoning_only stopReason when content & tool_calls are empty.
    const { resolveDefaultLlmTools } = await import('./aiDefault');
    const oaiyToolsRes = await resolveDefaultLlmTools(
      { messages: [{ role: 'user', content: 'Edit the page' }], tools: [] },
      {
        fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'oaiy-engine' }) }),
        oaiyAvailable: () => true,
        listOaiySources: vi.fn(async () => []),
        oaiyChat: vi.fn(async () => ({
          ok: true as const,
          data: { choices: [{ message: { content: '', reasoning_content: 'Thinking only...' }, finish_reason: 'stop' }] },
        })),
      },
    );
    expect(oaiyToolsRes).toEqual({
      ok: true,
      data: { source: 'desktop', text: '', toolCalls: [], stopReason: 'reasoning_only' },
    });

    // Optional maxOutputTokens from the editor overrides the 16,384 default on local OAIY text turns.
    const cappedOaiyChat = vi.fn(async () => ({
      ok: true as const,
      data: { choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }] },
    }));
    const cappedRes = await resolveDefaultLlm(
      { messages: [{ role: 'user', content: 'Edit the page' }], editor: true, maxOutputTokens: 32_768 },
      {
        fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'oaiy-engine' }) }),
        oaiyAvailable: () => true,
        oaiyChat: cappedOaiyChat,
      },
    );
    expect(cappedRes.ok).toBe(true);
    expect((cappedOaiyChat.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].max_tokens).toBe(32_768);

    // Editor AI readiness accepts locally paired OAIY even when no cloud-linked desktop is online.
    const { __setAiPreferencesFetcherForTests, getAiReadiness } = await import('./aiDefault');
    __setAiPreferencesFetcherForTests(async () => ({
      ok: true,
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'oaiy-engine' }),
    }));
    const editorReady = await getAiReadiness({ fresh: true, editor: true, oaiyAvailable: () => true });
    expect(editorReady).toMatchObject({ ready: true });
    __setAiPreferencesFetcherForTests(null);

    const customFetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.html"}' } }] }, finish_reason: 'tool_calls' }],
      }),
    );
    const customRes = await resolveDefaultLlm(
      { messages: [{ role: 'user', content: 'Edit the page' }], editor: true },
      {
        fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'custom', customProviderId: 'svc' }) }),
        resolveCustomProvider: async () => provider({ kind: 'ollama' }),
        fetchFn: customFetch as unknown as typeof fetch,
      },
    );
    expect(customRes.ok).toBe(true);
    if (customRes.ok) expect(customRes.data.content).toContain('<tool_call name="read_file">');
    const [, init] = customFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_tokens).toBe(16384);
  });
});

describe('the editor\'s output cap and a custom AI service that refuses it', () => {
  // The cap goes first. A service that holds it to its model's limits answers 400 to a request it
  // answered before the editor sent one, so that one is asked once more without it.
  const REPLY = { choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }] };
  async function ask(p: ResolvedAiProvider, answers: Array<() => Response>, editor = true) {
    const { resolveDefaultLlm } = await import('./aiDefault');
    const fetchFn = vi.fn(async () => (answers.shift() ?? (() => jsonResponse(REPLY)))());
    const result = await resolveDefaultLlm(
      { messages: [{ role: 'user', content: 'Edit the page' }], ...(editor ? { editor: true } : {}) },
      {
        fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'custom', customProviderId: 'svc' }) }),
        resolveCustomProvider: async () => p,
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    );
    const bodies = fetchFn.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>);
    return { result, bodies };
  }
  const refusal = (message: string) => () => jsonResponse({ error: { message, type: 'invalid_request_error' } }, 400);

  it('asks again without the cap when the service says the cap is over its model\'s limit', async () => {
    const { result, bodies } = await ask(provider(), [refusal('max_tokens is too large: 16384. This model supports at most 4096 completion tokens, whereas you provided 16384.')]);
    expect(result).toEqual({ ok: true, data: { source: 'custom', content: 'Done.' } });
    expect(bodies).toEqual([
      { messages: [{ role: 'user', content: 'Edit the page' }], model: 'configured-model', max_completion_tokens: 16384 },
      { messages: [{ role: 'user', content: 'Edit the page' }], model: 'configured-model' },
    ]);
  });

  it('asks again without it when the cap does not fit in the model\'s context', async () => {
    const { result, bodies } = await ask(provider({ kind: 'ollama' }), [refusal('This model\'s maximum context length is 8192 tokens. However, you requested 16500 tokens (116 in the messages, 16384 in the completion).')]);
    expect(result).toMatchObject({ ok: true, data: { content: 'Done.' } });
    expect(bodies.map(body => body.max_tokens)).toEqual([16384, undefined]);
  });

  it('asks once more only: a second refusal is the answer', async () => {
    const tooLarge = refusal('max_tokens is too large');
    const { result, bodies } = await ask(provider(), [tooLarge, tooLarge]);
    expect(bodies).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });
  });

  it('does not ask again for a 400 about anything else, or for a request that carried no cap', async () => {
    const other = await ask(provider(), [refusal('The model `configured-model` does not exist.')]);
    expect(other.bodies).toHaveLength(1);
    expect(other.result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });

    const chat = await ask(provider(), [refusal('This model\'s maximum context length is 8192 tokens.')], false);
    expect(chat.bodies).toEqual([{ messages: [{ role: 'user', content: 'Edit the page' }], model: 'configured-model' }]);
    expect(chat.result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });
  });

  // The same service, asked with the editor's tools: its refusal of the cap ended the turn as a
  // failed request, where the chat without tools was asked again and answered.
  describe('with the editor\'s tools', () => {
    /** `maxOutputTokens` null: a caller that names no cap. */
    async function askWithTools(p: ResolvedAiProvider, answers: Array<() => Response>, maxOutputTokens: number | null = 16384) {
      const fetchFn = vi.fn(async () => (answers.shift() ?? (() => jsonResponse(COMPLETION)))());
      const result = await resolveDefaultLlmTools(
        { messages: MESSAGES, tools: TOOLS, ...(maxOutputTokens === null ? {} : { maxOutputTokens }) },
        {
          fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'custom', customProviderId: 'svc' }) }),
          resolveCustomProvider: async () => p,
          fetchFn: fetchFn as unknown as typeof fetch,
        },
      );
      const bodies = fetchFn.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>);
      return { result, bodies };
    }

    it('asks again without the cap, with the same conversation and tools, and returns the calls', async () => {
      const { result, bodies } = await askWithTools(provider(), [refusal('max_tokens is too large: 16384. This model supports at most 4096 completion tokens, whereas you provided 16384.')]);
      expect(result).toMatchObject({ ok: true, data: { source: 'custom', toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'ui/app.ui' } }], stopReason: 'tool_calls' } });
      expect(bodies).toHaveLength(2);
      expect(bodies[0].max_completion_tokens).toBe(16384);
      expect(bodies[0]).toEqual({ ...bodies[1], max_completion_tokens: 16384 });
      expect(bodies[1]).not.toHaveProperty('max_completion_tokens');
      expect(bodies[1].tools).toHaveLength(1);
    });

    it('asks again when the cap does not fit in the context of a local server\'s model', async () => {
      const { result, bodies } = await askWithTools(provider({ kind: 'ollama' }), [refusal('This model\'s maximum context length is 8192 tokens. However, you requested 16500 tokens.')], 4096);
      expect(result.ok).toBe(true);
      expect(bodies.map(body => body.max_tokens)).toEqual([4096, undefined]);
    });

    it('asks once more only, and not at all for another 400 or a request that carried no cap', async () => {
      const tooLarge = refusal('max_tokens is too large');
      const twice = await askWithTools(provider(), [tooLarge, tooLarge]);
      expect(twice.bodies).toHaveLength(2);
      expect(twice.result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });

      const other = await askWithTools(provider(), [refusal('The model `configured-model` does not exist.')]);
      expect(other.bodies).toHaveLength(1);
      expect(other.result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });

      const uncapped = await askWithTools(provider(), [refusal('This model\'s maximum context length is 8192 tokens.')], null);
      expect(uncapped.bodies).toHaveLength(1);
      expect(uncapped.bodies[0]).not.toHaveProperty('max_completion_tokens');
      expect(uncapped.result).toMatchObject({ ok: false, error: { code: 'request_failed', status: 400 } });
    });
  });
});
