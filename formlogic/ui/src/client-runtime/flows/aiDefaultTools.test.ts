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

  it('passes a typed refusal (allowance) through unchanged', async () => {
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'site' }) }),
      siteChatTools: async () => ({ ok: false, error: { code: 'ai_allowance_exceeded', message: 'Used up.', status: 402 } }),
    });
    expect(result).toEqual({ ok: false, error: { code: 'ai_allowance_exceeded', message: 'Used up.', status: 402 } });
  });
});

describe('resolveDefaultLlmTools — Desktop', () => {
  it('answers tools-unsupported: the tunnel carries messages, not a caller\'s tools', async () => {
    const siteChatTools = vi.fn();
    const result = await resolveDefaultLlmTools({ messages: MESSAGES, tools: TOOLS }, {
      fetchPreferences: async () => ({ ok: true, data: prefs({ aiSource: 'desktop', desktopProviderId: 'anthropic' }) }),
      siteChatTools,
    });
    expect(siteChatTools).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: TOOLS_UNSUPPORTED } });
  });
});
