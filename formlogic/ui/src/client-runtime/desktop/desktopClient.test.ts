import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopClient, setConnectorCapabilityContext } from './desktopClient';
import { clearDesktopToken, getDesktopToken, storeDesktopToken } from './desktopPairing';

// Desktop client error mapping: network failure → connector_unavailable (flagged as a
// transport failure), HTTP 401 → auth_required + the stored token is dropped, and a
// desktop-returned typed error envelope passes through untouched.

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
}

function setFetch(mock: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

function serviceAwareFetch(
  serviceId: 'openai-api' | 'openai-codex-agent',
  desktopResponse: (...args: unknown[]) => Promise<Response>,
  token = `cap_${serviceId.replace(/-/g, '_')}`
): ReturnType<typeof vi.fn> {
  setConnectorCapabilityContext('owner-app');
  return setFetch(vi.fn((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes('/api/app/owner-app/service-capability')) {
      return jsonResponse({ token, serviceId, expiresInSeconds: 300 });
    }
    return desktopResponse(...args);
  }));
}

function streamResponse(chunks: string[], status = 200, contentType = 'text/event-stream'): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return Promise.resolve(new Response(stream, { status, headers: { 'Content-Type': contentType } }));
}

afterEach(() => {
  clearDesktopToken();
  setConnectorCapabilityContext(null);
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('desktopClient.connectors.request', () => {
  it('POSTs the connector-request body with the bearer token and unwraps data', async () => {
    storeDesktopToken('tok_abc');
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true, data: { dongles: [] }, requestId: 'r1' })));

    const res = await desktopClient.connectors.request('aokie', 'dongle.list', { verbose: true });

    expect(res).toEqual({ ok: true, data: { dongles: [] }, requestId: 'r1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/connectors/aokie/request');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
    expect(JSON.parse(init.body as string)).toEqual({
      connectorId: 'aokie',
      command: 'dongle.list',
      payload: { verbose: true },
    });
  });

  it('maps a network failure to connector_unavailable with transportFailure', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const res = await desktopClient.connectors.request('aokie', 'phone.status');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('connector_unavailable');
      expect(res.transportFailure).toBe(true);
    }
  });

  it('maps HTTP 401 to auth_required and drops the stored pairing token', async () => {
    storeDesktopToken('tok_expired');
    setFetch(vi.fn(() => jsonResponse({ message: 'unauthorized' }, 401)));

    const res = await desktopClient.connectors.request('aokie', 'phone.status');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('auth_required');
      expect(res.transportFailure).toBeUndefined(); // a real desktop response, not transport
    }
    expect(getDesktopToken()).toBeNull();
  });

  it('passes a desktop-returned typed error envelope through verbatim (no transport flag)', async () => {
    storeDesktopToken('tok_abc');
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'capability_denied', message: 'not declared' } }, 403)));

    const res = await desktopClient.connectors.request('aokie', 'call.answer');

    expect(res).toEqual({ ok: false, error: { code: 'capability_denied', message: 'not declared' } });
  });
});

describe('desktopClient.plugins.list', () => {
  it('accepts both bare-array and wrapped list shapes', async () => {
    storeDesktopToken('tok_abc');
    setFetch(vi.fn(() => jsonResponse([{ id: 'aokie', state: 'running' }])));
    let res = await desktopClient.plugins.list();
    expect(res.ok && res.data).toEqual([{ id: 'aokie', state: 'running' }]);

    setFetch(vi.fn(() => jsonResponse({ plugins: [{ id: 'aokie', state: 'stopped' }] })));
    res = await desktopClient.plugins.list();
    expect(res.ok && res.data).toEqual([{ id: 'aokie', state: 'stopped' }]);
  });
});

describe('desktopClient.plugins lifecycle', () => {
  it('restart/enable/disable POST to their loopback routes with the id encoded', async () => {
    storeDesktopToken('tok_abc');
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true })));

    await desktopClient.plugins.restart('aokie/phone');
    await desktopClient.plugins.enable('aokie');
    await desktopClient.plugins.disable('aokie');

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      'http://127.0.0.1:17872/api/plugins/aokie%2Fphone/restart',
      'http://127.0.0.1:17872/api/plugins/aokie/enable',
      'http://127.0.0.1:17872/api/plugins/aokie/disable',
    ]);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
    }
  });
});

describe('desktopClient.services lifecycle', () => {
  it('start/stop/repair POST to their loopback routes', async () => {
    storeDesktopToken('tok_abc');
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true })));

    await desktopClient.services.start('llama-cpp');
    await desktopClient.services.stop('llama-cpp');
    await desktopClient.services.repair('aokie-voice');

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      'http://127.0.0.1:17872/api/services/llama-cpp/start',
      'http://127.0.0.1:17872/api/services/llama-cpp/stop',
      'http://127.0.0.1:17872/api/services/aokie-voice/repair',
    ]);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe('POST');
    }
  });

  it('restart composes stop then start (no dedicated loopback route)', async () => {
    storeDesktopToken('tok_abc');
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true })));

    const res = await desktopClient.services.restart('llama-cpp');

    expect(res.ok).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      'http://127.0.0.1:17872/api/services/llama-cpp/stop',
      'http://127.0.0.1:17872/api/services/llama-cpp/start',
    ]);
  });

  it('restart surfaces the stop failure and never calls start', async () => {
    storeDesktopToken('tok_abc');
    const fetchMock = setFetch(
      vi.fn(() => jsonResponse({ ok: false, error: { code: 'command_failed', message: 'stop refused' } }, 500))
    );

    const res = await desktopClient.services.restart('llama-cpp');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe('stop refused');
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe('desktopClient.ai gateway', () => {
  it('POSTs chat through a named provider with pairing plus an exact owner service capability', async () => {
    storeDesktopToken('pair_tok');
    const completion = { choices: [{ message: { content: 'hello' } }] };
    const fetchMock = serviceAwareFetch('openai-api', () => jsonResponse(completion));

    const res = await desktopClient.ai.chat(
      { model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }] },
      'chat/provider'
    );

    expect(res).toEqual({ ok: true, data: completion });
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.formlogic.local/api/app/owner-app/service-capability');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/ai/providers/chat%2Fprovider/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pair_tok');
    expect((init.headers as Record<string, string>)['X-FormLogic-Capability']).toBe('cap_openai_api');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hi' }],
    });
  });

  it('uses the delegated Codex capability for the generic ChatGPT background provider', async () => {
    storeDesktopToken('pair_tok');
    const completion = { choices: [{ message: { content: 'Background result' } }] };
    const fetchMock = serviceAwareFetch('openai-codex-agent', () => jsonResponse(completion));

    const result = await desktopClient.ai.chat(
      { messages: [{ role: 'user', content: 'Draft an SMS' }] },
      'openai-codex-agent'
    );

    expect(result).toEqual({ ok: true, data: completion });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      serviceId: 'openai-codex-agent',
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      'http://127.0.0.1:17872/api/ai/providers/openai-codex-agent/v1/chat/completions'
    );
    expect((init.headers as Record<string, string>)['X-FormLogic-Capability']).toBe(
      'cap_openai_codex_agent'
    );
  });

  it('lists public model metadata through the authenticated provider gateway', async () => {
    storeDesktopToken('pair_tok');
    const fetchMock = serviceAwareFetch('openai-api', () => jsonResponse({ object: 'list', data: [{ id: 'model-a' }] }));

    const res = await desktopClient.ai.models('openai');

    expect(res).toEqual({ ok: true, data: [{ id: 'model-a' }] });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/ai/providers/openai/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pair_tok');
    expect((init.headers as Record<string, string>)['X-FormLogic-Capability']).toBe('cap_openai_api');
  });

  it('uploads transcription audio as multipart without overriding the browser boundary', async () => {
    storeDesktopToken('pair_tok');
    const fetchMock = serviceAwareFetch('openai-api', () => jsonResponse({ text: 'Hello from audio' }));

    const res = await desktopClient.ai.transcribe({
      file: new Blob(['wave-bytes'], { type: 'audio/wav' }),
      filename: 'sample.wav',
      model: 'gpt-4o-mini-transcribe',
      language: 'en',
      responseFormat: 'json',
      timestampGranularities: ['word'],
    }, 'speech/provider');

    expect(res).toEqual({ ok: true, data: { text: 'Hello from audio' } });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/ai/providers/speech%2Fprovider/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer pair_tok');
    expect(headers['X-FormLogic-Capability']).toBe('cap_openai_api');
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('sample.wav');
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
  });

  it('sends a typed audio chat request through a named provider', async () => {
    storeDesktopToken('pair_tok');
    const completion = {
      choices: [{ message: { audio: { data: 'response-audio', transcript: 'Hello' } } }],
    };
    const fetchMock = serviceAwareFetch('openai-api', () => jsonResponse(completion));
    const body = {
      model: 'gpt-audio-1.5',
      modalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      audio: { voice: 'alloy', format: 'wav' },
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio' as const, input_audio: { data: 'request-audio', format: 'wav' } }],
      }],
    };

    const res = await desktopClient.ai.audioChat(body, 'audio/provider');

    expect(res).toEqual({ ok: true, data: completion });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/ai/providers/audio%2Fprovider/v1/audio/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('brokers a Realtime WebRTC SDP offer through a pinned provider', async () => {
    storeDesktopToken('pair_tok');
    const fetchMock = serviceAwareFetch('openai-api', () => jsonResponse({ sdp: 'v=0\r\nanswer' }));
    const offer = {
      sdp: 'v=0\r\noffer',
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      instructions: 'Be concise.',
      session: {
        output_modalities: ['audio'],
        audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } },
      },
    };

    const res = await desktopClient.ai.createRealtimeSession(offer, 'realtime/provider');

    expect(res).toEqual({ ok: true, data: { sdp: 'v=0\r\nanswer' } });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/ai/providers/realtime%2Fprovider/v1/realtime/sessions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(offer);
  });

  it('purges a cached owner token when the same app slug receives a new principal epoch', async () => {
    storeDesktopToken('pair_tok');
    serviceAwareFetch('openai-api', () => jsonResponse({ choices: [] }), 'owner_capability');
    await expect(desktopClient.ai.chat({ messages: [{ role: 'user', content: 'owner' }] }))
      .resolves.toEqual({ ok: true, data: { choices: [] } });

    // Login/session reset may enter the same slug text as another user. A
    // repeated context assignment must invalidate, not preserve, the token.
    setConnectorCapabilityContext('owner-app');
    const fetchMock = setFetch(vi.fn((url: string) => {
      if (url.includes('/service-capability')) {
        return jsonResponse({ error: true, message: 'Only the owner may mint' }, 403);
      }
      throw new Error('Desktop must not receive a prior principal capability');
    }));
    const result = await desktopClient.ai.chat({ messages: [{ role: 'user', content: 'member' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capability_denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses fragmented SSE incrementally with bounded JSON events', async () => {
    storeDesktopToken('pair_tok');
    const chunks = [
      ': heartbeat\n\ndata: {"id":"one","choices":[{"delta":{"content":"Hel"}}]}\r\n\r\nda',
      'ta: {"id":"two","choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    ];
    const fetchMock = serviceAwareFetch('openai-api', () => streamResponse(chunks));
    const seen: string[] = [];

    const res = await desktopClient.ai.chatStream(
      { stream: false, messages: [{ role: 'user', content: 'Hi' }] },
      {
        onChunk(chunk) {
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) seen.push(content);
        },
      },
      'stream/provider'
    );

    expect(res.ok && res.data).toEqual({
      chunks: 2,
      bytes: chunks.reduce((total, chunk) => total + new TextEncoder().encode(chunk).byteLength, 0),
      sawDone: true,
    });
    expect(seen).toEqual(['Hel', 'lo']);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/ai/providers/stream%2Fprovider/v1/chat/completions');
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pair_tok');
    expect((init.headers as Record<string, string>)['X-FormLogic-Capability']).toBe('cap_openai_api');
    expect(JSON.parse(init.body as string)).toEqual({
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    });
  });

  it('returns typed errors for malformed or oversized SSE without invoking consumers', async () => {
    storeDesktopToken('pair_tok');
    const onChunk = vi.fn();
    serviceAwareFetch('openai-api', () => streamResponse(['data: {not-json}\n\n']));
    let res = await desktopClient.ai.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { onChunk }
    );
    expect(res).toEqual({
      ok: false,
      error: { code: 'command_failed', message: 'Desktop returned an invalid or oversized AI event stream.' },
    });
    expect(onChunk).not.toHaveBeenCalled();

    setFetch(vi.fn(() => streamResponse([`data: ${'x'.repeat(512 * 1024 + 1)}\n\n`])));
    res = await desktopClient.ai.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { onChunk }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('command_failed');
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('drops the pairing token when the streaming endpoint returns 401', async () => {
    storeDesktopToken('expired');
    serviceAwareFetch('openai-api', () => Promise.resolve(new Response(
      JSON.stringify({ ok: false, error: { code: 'auth_required', message: 'pair again' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )));

    const res = await desktopClient.ai.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { onChunk: vi.fn() }
    );

    expect(res).toEqual({ ok: false, error: { code: 'auth_required', message: 'pair again' } });
    expect(getDesktopToken()).toBeNull();
  });

  it('does not surface raw upstream streaming error details', async () => {
    storeDesktopToken('pair_tok');
    serviceAwareFetch('openai-api', () => streamResponse([
      'data: {"error":{"message":"Bearer secret-token must never escape"}}\n\n',
    ]));

    const res = await desktopClient.ai.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { onChunk: vi.fn() }
    );

    expect(res).toEqual({
      ok: false,
      error: { code: 'command_failed', message: 'The AI provider reported a streaming error.' },
    });
    expect(JSON.stringify(res)).not.toContain('secret-token');
  });
});

describe('desktopClient.servicePlatform', () => {
  it('returns a credential-free catalog projection without transport internals', async () => {
    storeDesktopToken('pair_tok');
    const fetchMock = setFetch(vi.fn(() => jsonResponse({
      schemaVersion: 3,
      definitions: [{
        schemaVersion: 3,
        id: 'openai-codex-agent',
        version: '0.1.0',
        name: 'Codex Agent',
        description: 'Delegated assistant',
        kind: 'delegated-agent',
        category: { id: 'ai.agents', label: 'AI & Agents' },
        tags: ['codex'],
        capabilities: ['agent.assistant'],
        auth: { token: 'must-not-reach-the-site' },
        actions: [{
          id: 'assistant.chat',
          title: 'Ask assistant',
          tags: ['assistant'],
          inputSchema: { type: 'object' },
          transport: { kind: 'stdio-jsonrpc', rpcMethod: 'turn/start' },
        }],
      }],
    })));

    const res = await desktopClient.servicePlatform.catalog();

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.definitions[0]).not.toHaveProperty('auth');
      expect(res.data.definitions[0].actions[0]).not.toHaveProperty('transport');
      expect(res.data.definitions[0].actions[0]).toEqual({
        id: 'assistant.chat',
        title: 'Ask assistant',
        tags: ['assistant'],
        inputSchema: { type: 'object' },
      });
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/services/catalog');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pair_tok');
  });

  it('uses an owner capability for Codex reads and normalized assistant work', async () => {
    storeDesktopToken('pair_tok');
    const desktopResponses = vi.fn()
      .mockImplementationOnce(() => jsonResponse({
        available: true,
        running: true,
        requiresOpenaiAuth: false,
        account: { accountType: 'chatgpt', email: 'owner@example.test' },
        safeDefaults: {
          fileSystem: 'none',
          network: 'OpenAI provider only; agent tools blocked',
          approvals: 'never',
          credentials: 'OAuth file encrypted by Windows EFS',
        },
      }))
      .mockImplementationOnce(() => jsonResponse({ models: [{
        id: 'model-id',
        model: 'model-slug',
        displayName: 'Model',
        description: '',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium'],
      }] }))
      .mockImplementationOnce(() => jsonResponse({ threadId: 'thread-1', turnId: 'turn-1', text: 'Hello' }));
    const fetchMock = serviceAwareFetch('openai-codex-agent', desktopResponses, 'owner_capability');

    const status = await desktopClient.servicePlatform.codex.status();
    const models = await desktopClient.servicePlatform.codex.models();
    const chat = await desktopClient.servicePlatform.codex.assistantChat({
      prompt: 'Build a form',
      model: 'model-slug',
      reasoningEffort: 'medium',
    });

    expect(status.ok && status.data.account?.email).toBe('owner@example.test');
    expect(models.ok && models.data[0].model).toBe('model-slug');
    expect(chat).toEqual({ ok: true, data: { threadId: 'thread-1', turnId: 'turn-1', text: 'Hello' } });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://api.formlogic.local/api/app/owner-app/service-capability',
      'http://127.0.0.1:17872/api/services/codex/status',
      'http://127.0.0.1:17872/api/services/codex/models',
      'http://127.0.0.1:17872/api/services/codex/actions/assistant.chat',
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      serviceId: 'openai-codex-agent',
    });
    expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string)).toEqual({
      prompt: 'Build a form',
      model: 'model-slug',
      reasoningEffort: 'medium',
    });
    for (const call of fetchMock.mock.calls.slice(1)) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-FormLogic-Capability']).toBe('owner_capability');
      expect(headers.Authorization).toBe('Bearer pair_tok');
    }
    expect('startLogin' in desktopClient.servicePlatform.codex).toBe(false);
    expect('logout' in desktopClient.servicePlatform.codex).toBe(false);
    expect('interrupt' in desktopClient.servicePlatform.codex).toBe(false);
  });

  it('deduplicates concurrent cold capability mints for the same service', async () => {
    storeDesktopToken('pair_tok');
    setConnectorCapabilityContext('owner-app');
    let resolveMint!: (response: Response) => void;
    const mintResponse = new Promise<Response>((resolve) => {
      resolveMint = resolve;
    });
    const fetchMock = setFetch(vi.fn((url: string) => {
      if (url.includes('/service-capability')) return mintResponse;
      if (url.endsWith('/api/services/codex/status')) {
        return jsonResponse({ available: true, running: true, requiresOpenaiAuth: false });
      }
      if (url.endsWith('/api/services/codex/models')) return jsonResponse({ models: [] });
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const statusPromise = desktopClient.servicePlatform.codex.status();
    const modelsPromise = desktopClient.servicePlatform.codex.models();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/service-capability'))).toHaveLength(1);
    });
    resolveMint(await jsonResponse({
      token: 'shared_capability',
      serviceId: 'openai-codex-agent',
      expiresInSeconds: 300,
    }));

    const [status, models] = await Promise.all([statusPromise, modelsPromise]);
    expect(status.ok).toBe(true);
    expect(models.ok).toBe(true);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/service-capability'))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('discards a capability response that crosses a principal epoch', async () => {
    storeDesktopToken('pair_tok');
    setConnectorCapabilityContext('owner-app');
    let resolveMint!: (response: Response) => void;
    const mintResponse = new Promise<Response>((resolve) => {
      resolveMint = resolve;
    });
    const fetchMock = setFetch(vi.fn((url: string) => {
      if (url.includes('/service-capability')) return mintResponse;
      throw new Error('Desktop must not receive authority from a previous principal epoch');
    }));

    const statusPromise = desktopClient.servicePlatform.codex.status();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    setConnectorCapabilityContext('owner-app');
    resolveMint(await jsonResponse({
      token: 'old_principal_capability',
      serviceId: 'openai-codex-agent',
      expiresInSeconds: 300,
    }));

    const status = await statusPromise;
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error.code).toBe('capability_denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mints an account-scoped capability for workspace Form/App generation', async () => {
    storeDesktopToken('pair_tok');
    setConnectorCapabilityContext(null);
    const fetchMock = setFetch(vi.fn((url: string) => {
      if (url === 'http://api.formlogic.local/api/service-capability') {
        return jsonResponse({
          token: 'workspace_capability',
          serviceId: 'openai-codex-agent',
          expiresInSeconds: 300,
        });
      }
      return jsonResponse({
        available: true,
        running: true,
        requiresOpenaiAuth: false,
        account: { accountType: 'chatgpt' },
        safeDefaults: {
          fileSystem: 'none',
          network: 'OpenAI provider only; agent tools blocked',
          approvals: 'never',
          credentials: 'OAuth file encrypted by Windows EFS',
        },
      });
    }));

    const result = await desktopClient.servicePlatform.codex.status();
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://api.formlogic.local/api/service-capability',
      'http://127.0.0.1:17872/api/services/codex/status',
    ]);
    const desktopHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(desktopHeaders['X-FormLogic-Capability']).toBe('workspace_capability');
  });
});
