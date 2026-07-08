import { describe, expect, it, vi } from 'vitest';
import { executeNode, FlowExecError, KV_WRITE_CAPABILITY, type FlowExecutorDeps, type FlowNodeContext } from './nodes';
import type { WorkflowGraphNode } from '../../types/flows';
import type { SelectorScope } from './selectors';

// Node handlers (docs/FORMLOGIC_FLOWS.md §4/§9): storage_get/storage_set are the Flow KV
// nodes (writes are capability-gated), aokie_speak is connector sugar, and llm_chat resolves
// its endpoint from Desktop services / configured AI base. Every dep is injected, so no
// worker / network / store is needed.

function fakeDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
  return {
    evaluateBoolean: vi.fn(async () => true),
    evaluateExpression: vi.fn(async () => null),
    listResponses: vi.fn(async () => []),
    submitResponse: vi.fn(async () => ({})),
    updateResponse: vi.fn(async () => ({})),
    connectorRequest: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function ctxFor(
  node: WorkflowGraphNode,
  deps: FlowExecutorDeps,
  extra: { scope?: SelectorScope; capabilities?: string[] | null; flowSlug?: string } = {}
): FlowNodeContext {
  return {
    node,
    scope: extra.scope ?? { inputs: {}, event: null, app: null, nodes: {} },
    signal: new AbortController().signal,
    deps,
    capabilities: extra.capabilities ?? null,
    flowSlug: extra.flowSlug,
  };
}

describe('storage_get', () => {
  it('reads via kvGet with the resolved scope + key', async () => {
    const kvGet = vi.fn(async () => 'stored-value');
    const deps = fakeDeps({ kvGet });
    const node: WorkflowGraphNode = { id: 'g', type: 'storage_get', data: { key: 'caller' } };
    const out = await executeNode(ctxFor(node, deps, { flowSlug: 'lookup' }));
    expect(out).toBe('stored-value');
    expect(kvGet).toHaveBeenCalledWith('flow:lookup', 'caller'); // default scope = flow:<slug>
  });

  it('resolves a $-selector key against the run scope', async () => {
    const kvGet = vi.fn(async () => 42);
    const deps = fakeDeps({ kvGet });
    const node: WorkflowGraphNode = { id: 'g', type: 'storage_get', data: { scope: 'app', key: '$event.data.phone' } };
    await executeNode(ctxFor(node, deps, { scope: { event: { data: { phone: '+614' } } } }));
    expect(kvGet).toHaveBeenCalledWith('app', '+614');
  });

  it('fails runner_unavailable when the runtime has no KV access', async () => {
    const node: WorkflowGraphNode = { id: 'g', type: 'storage_get', data: { key: 'x' } };
    await expect(executeNode(ctxFor(node, fakeDeps()))).rejects.toMatchObject({ code: 'runner_unavailable' });
  });
});

describe('storage_set', () => {
  it('is capability_denied without formlogic.kv.write (kvSet never called)', async () => {
    const kvSet = vi.fn(async () => ({}));
    const deps = fakeDeps({ kvSet });
    const node: WorkflowGraphNode = { id: 's', type: 'storage_set', data: { key: 'x', value: 1 } };
    await expect(executeNode(ctxFor(node, deps, { capabilities: [] }))).rejects.toMatchObject({
      code: 'capability_denied',
    });
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('writes via kvSet when the capability is declared', async () => {
    const kvSet = vi.fn(async () => ({}));
    const deps = fakeDeps({ kvSet });
    const node: WorkflowGraphNode = { id: 's', type: 'storage_set', data: { key: 'greeting', value: 'hi' } };
    const out = await executeNode(ctxFor(node, deps, { capabilities: [KV_WRITE_CAPABILITY], flowSlug: 'greet' }));
    expect(kvSet).toHaveBeenCalledWith('flow:greet', 'greeting', 'hi');
    expect(out).toEqual({ stored: true, scope: 'flow:greet', key: 'greeting' });
  });

  it('resolves valueFrom as a selector', async () => {
    const kvSet = vi.fn(async () => ({}));
    const deps = fakeDeps({ kvSet });
    const node: WorkflowGraphNode = { id: 's', type: 'storage_set', data: { scope: 'app', key: 'last', valueFrom: '$inputs.name' } };
    await executeNode(ctxFor(node, deps, { capabilities: [KV_WRITE_CAPABILITY], scope: { inputs: { name: 'Alex' } } }));
    expect(kvSet).toHaveBeenCalledWith('app', 'last', 'Alex');
  });
});

describe('logic_block frozen ctx', () => {
  it('passes a frozen {inputs,event,kv,app} ctx with a read-only kv snapshot', async () => {
    let seen: Record<string, unknown> | null = null;
    const deps = fakeDeps({
      kvList: vi.fn(async () => ({ total: 7 })),
      evaluateExpression: vi.fn(async (_expr, c) => {
        seen = c;
        return (c.kv as { total: number }).total * 2;
      }),
    });
    const node: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: 'kv.total * 2' } };
    const out = await executeNode(ctxFor(node, deps, { scope: { inputs: { a: 1 }, event: { name: 'x' } }, flowSlug: 'f' }));
    expect(out).toBe(14);
    expect(seen).not.toBeNull();
    expect(Object.isFrozen(seen)).toBe(true);
    expect((seen as unknown as { kv: unknown }).kv).toEqual({ total: 7 });
  });
});

describe('aokie_speak', () => {
  it('interpolates text and routes through the aokie operatorSpeak command', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'Hello {{event.data.name}}' } };
    await executeNode(ctxFor(node, deps, { scope: { event: { data: { name: 'Sam' } } } }));
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', { message: 'Hello Sam' });
  });

  it('supports textFrom selectors', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { textFrom: '$inputs.line' } };
    await executeNode(ctxFor(node, deps, { scope: { inputs: { line: 'Connecting now' } } }));
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', { message: 'Connecting now' });
  });
});

describe('formlogic_list_responses', () => {
  const CUSTOMERS = [
    { id: 'r1', answers: { name: 'Alex', phone: '+61400111222', age: 30, tag: 'vip' }, submittedAt: '2026-01-01T00:00:00Z', status: 'submitted' },
    { id: 'r2', answers: { name: 'Blair', phone: '+61400999888', age: 52, tag: 'lead' } },
    { id: 'r3', answers: { name: 'Casey', phone: '+61400111222', age: 41, tag: 'vip' } },
  ];

  function listNode(data: Record<string, unknown>): WorkflowGraphNode {
    return { id: 'lookup', type: 'formlogic_list_responses', data: { form: 'form-1', ...data } };
  }

  it('returns the structured { responses, count, first, found } with no filters', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(ctxFor(listNode({}), deps))) as {
      responses: unknown[]; count: number; first: { id: string } | null; found: boolean;
    };
    expect(out.count).toBe(3);
    expect(out.found).toBe(true);
    expect(out.first?.id).toBe('r1');
    expect(out.responses).toHaveLength(3);
    // Rows are normalized to { id, answers, submittedAt?, status? }.
    expect(out.responses[0]).toMatchObject({ id: 'r1', answers: { name: 'Alex' }, submittedAt: '2026-01-01T00:00:00Z', status: 'submitted' });
  });

  it('equals filter selects only matching rows (count/first/found)', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'phone', op: 'eq', value: '+61400111222' }] }), deps)
    )) as { count: number; first: { id: string } | null; found: boolean };
    expect(out.count).toBe(2);
    expect(out.found).toBe(true);
    expect(out.first?.id).toBe('r1');
  });

  it('contains filter is case-insensitive substring match', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'name', op: 'contains', value: 'la' }] }), deps)
    )) as { count: number; first: { id: string } | null };
    expect(out.count).toBe(1); // 'Blair'
    expect(out.first?.id).toBe('r2');
  });

  it('greater-than filter compares numerically', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'age', op: 'gt', value: 40 }] }), deps)
    )) as { count: number };
    expect(out.count).toBe(2); // Blair 52, Casey 41
  });

  it('one-of filter tests membership over a comma list', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'tag', op: 'in', value: 'vip, gold' }] }), deps)
    )) as { count: number };
    expect(out.count).toBe(2); // Alex + Casey are vip
  });

  it('ANDs multiple filters and returns found=false / first=null on no match', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'tag', op: 'eq', value: 'vip' }, { field: 'age', op: 'gt', value: 100 }] }), deps)
    )) as { count: number; first: unknown; found: boolean };
    expect(out.count).toBe(0);
    expect(out.found).toBe(false);
    expect(out.first).toBeNull();
  });

  it('resolves a $-selector filter value against the run scope', async () => {
    const deps = fakeDeps({ listResponses: vi.fn(async () => CUSTOMERS) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'phone', op: 'eq', value: '$event.data.callerPhone' }] }), deps, {
        scope: { event: { data: { callerPhone: '+61400999888' } } },
      })
    )) as { count: number; first: { answers: { name: string } } | null };
    expect(out.count).toBe(1);
    expect(out.first?.answers.name).toBe('Blair');
  });

  it('caps the scanned limit at 500 (passes the clamped limit to listResponses)', async () => {
    const listResponses = vi.fn(async () => CUSTOMERS);
    await executeNode(ctxFor(listNode({ limit: 100000 }), fakeDeps({ listResponses })));
    expect(listResponses).toHaveBeenCalledWith('form-1', { limit: 500 });
    // default when unset
    await executeNode(ctxFor(listNode({}), fakeDeps({ listResponses })));
    expect(listResponses).toHaveBeenLastCalledWith('form-1', { limit: 200 });
  });

  it('fails invalid_flow when the form reference is missing', async () => {
    const node: WorkflowGraphNode = { id: 'lookup', type: 'formlogic_list_responses', data: {} };
    await expect(executeNode(ctxFor(node, fakeDeps()))).rejects.toMatchObject({ code: 'invalid_flow' });
  });
});

describe('llm_chat endpoint resolution', () => {
  function llmNode(data: Record<string, unknown>): WorkflowGraphNode {
    return { id: 'llm', type: 'llm_chat', data: { prompt: 'hi', ...data } };
  }
  function okFetch(): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;
  }

  it('uses a running Desktop local AI service when no endpoint is set', async () => {
    const fetchFn = okFetch();
    const resolveDesktopLlmEndpoint = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' }));
    const deps = fakeDeps({ fetchFn, resolveDesktopLlmEndpoint, getAppAiBase: () => null });
    await executeNode(ctxFor(llmNode({ model: 'm' }), deps)); // model set → skips the /models probe
    expect(resolveDesktopLlmEndpoint).toHaveBeenCalled();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('falls back to the app AI base when Desktop is absent', async () => {
    const fetchFn = okFetch();
    const deps = fakeDeps({
      fetchFn,
      resolveDesktopLlmEndpoint: vi.fn(async () => null),
      getAppAiBase: () => 'http://localhost:8001/v1',
    });
    await executeNode(ctxFor(llmNode({ model: 'm' }), deps)); // model set → skips the /models probe
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://localhost:8001/v1/chat/completions');
  });

  it('discovers a model from /v1/models when the node pins none (Ollama requires one)', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const deps = fakeDeps({
      fetchFn,
      resolveDesktopLlmEndpoint: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' })),
      getAppAiBase: () => null,
    });
    await executeNode(ctxFor(llmNode({}), deps));
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('http://127.0.0.1:11434/v1/models'); // probes /models first
    const chat = calls.find((c) => String(c[0]).endsWith('/chat/completions'));
    expect(JSON.parse((chat![1] as RequestInit).body as string).model).toBe('llama3.1:8b');
  });

  it('node_failed naming all three options when no endpoint can be resolved', async () => {
    const deps = fakeDeps({ resolveDesktopLlmEndpoint: vi.fn(async () => null), getAppAiBase: () => null });
    await expect(executeNode(ctxFor(llmNode({}), deps))).rejects.toBeInstanceOf(FlowExecError);
    await executeNode(ctxFor(llmNode({}), deps)).catch((err: FlowExecError) => {
      expect(err.code).toBe('node_failed');
      expect(err.message).toMatch(/endpoint/i);
      expect(err.message).toMatch(/Desktop/i);
    });
  });

  it('rejects an author endpoint that is not allow-listed', async () => {
    const deps = fakeDeps({ fetchFn: okFetch() });
    await expect(executeNode(ctxFor(llmNode({ endpoint: 'https://evil.example.com/v1/chat/completions' }), deps)))
      .rejects.toMatchObject({ code: 'capability_denied' });
  });
});

// ── Desktop-service-backed nodes (docs §4) ─────────────────────────────────────────────────
// browser_action / image_gen / stt_transcribe / tts_speak drive a LOCAL FormLogic Desktop
// service over loopback HTTP. Every dep is injected — a routed fetch mock stands in for the
// service. The key contract: unreachable → an ACTIONABLE node_failed that NEVER says "coming soon".

/** A JSON Response, like the service returns. */
function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

/** Route a fetch mock by URL suffix → JSON body (longest suffix wins). */
function routedFetch(routes: Record<string, unknown>): typeof fetch {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return vi.fn(async (url: string | URL) => {
    const u = String(url).split('?')[0];
    for (const k of keys) if (u.endsWith(k)) return jsonResponse(routes[k]);
    return jsonResponse({ error: `no route for ${u}` }, 404);
  }) as unknown as typeof fetch;
}

describe('browser_action', () => {
  const base = 'http://127.0.0.1:17880';
  function browserDeps(fetchFn: typeof fetch, resolve: string | null = base): FlowExecutorDeps {
    return fakeDeps({ fetchFn, resolveDesktopServiceBase: vi.fn(async () => resolve) });
  }

  it('drives session → goto → extract_text end-to-end and returns structured output', async () => {
    const fetchFn = routedFetch({
      '/session': { sessionId: 's1' },
      '/goto': { url: 'https://ex.com/', title: 'Example', status: 200 },
      '/evaluate': { result: 'Hello world' },
    });
    const node: WorkflowGraphNode = { id: 'b', type: 'browser_action', data: { action: 'extract_text', url: 'https://ex.com', selector: 'h1' } };
    const out = (await executeNode(ctxFor(node, browserDeps(fetchFn)))) as Record<string, unknown>;
    expect(out.sessionId).toBe('s1');
    expect(out.url).toBe('https://ex.com/');
    expect(out.title).toBe('Example');
    expect(out.status).toBe(200);
    expect(out.text).toBe('Hello world');
  });

  it('reuses a threaded sessionId (no new /session call) and clicks', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const node: WorkflowGraphNode = { id: 'b', type: 'browser_action', data: { action: 'click', selector: '#go', sessionId: '$inputs.sid' } };
    const out = (await executeNode(ctxFor(node, browserDeps(fetchFn), { scope: { inputs: { sid: 's9' } } }))) as Record<string, unknown>;
    expect(out.sessionId).toBe('s9');
    expect(calls.some((c) => c.endsWith('/session'))).toBe(false); // reused, never created
    expect(calls.some((c) => c.endsWith('/session/s9/action'))).toBe(true);
  });

  it('screenshot returns a dataUrl', async () => {
    const fetchFn = routedFetch({ '/session': { sessionId: 's1' }, '/screenshot': { dataUrl: 'data:image/png;base64,AAA' } });
    const node: WorkflowGraphNode = { id: 'b', type: 'browser_action', data: { action: 'screenshot' } };
    const out = (await executeNode(ctxFor(node, browserDeps(fetchFn)))) as Record<string, unknown>;
    expect(out.dataUrl).toBe('data:image/png;base64,AAA');
  });

  it('fails with an ACTIONABLE (never "coming soon") message when no service is reachable', async () => {
    const node: WorkflowGraphNode = { id: 'b', type: 'browser_action', data: { action: 'goto', url: 'https://ex.com' } };
    await executeNode(ctxFor(node, browserDeps(okBrowserFetchUnused(), null))).catch((err: FlowExecError) => {
      expect(err).toBeInstanceOf(FlowExecError);
      expect(err.code).toBe('node_failed');
      expect(err.message).toMatch(/FormLogic Desktop/);
      expect(err.message).toMatch(/Playwright Browser/);
      expect(err.message).not.toMatch(/coming soon/i);
    });
    await expect(executeNode(ctxFor(node, browserDeps(okBrowserFetchUnused(), null)))).rejects.toBeInstanceOf(FlowExecError);
  });

  it('fails with the actionable message when the service is resolved but unreachable', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const node: WorkflowGraphNode = { id: 'b', type: 'browser_action', data: { action: 'goto', url: 'https://ex.com' } };
    await expect(executeNode(ctxFor(node, browserDeps(fetchFn)))).rejects.toMatchObject({ code: 'node_failed' });
    await executeNode(ctxFor(node, browserDeps(fetchFn))).catch((err: FlowExecError) => {
      expect(err.message).toMatch(/Install and start the Playwright Browser/);
    });
  });
});

/** A never-called fetch (the resolver returns null before any request). */
function okBrowserFetchUnused(): typeof fetch {
  return vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
}

describe('image_gen', () => {
  const base = 'http://127.0.0.1:17910';
  function imageDeps(fetchFn: typeof fetch, resolve: string | null = base): FlowExecutorDeps {
    return fakeDeps({ fetchFn, resolveDesktopServiceBase: vi.fn(async () => resolve) });
  }
  function imgNode(data: Record<string, unknown>): WorkflowGraphNode {
    return { id: 'img', type: 'image_gen', data: { prompt: 'a fox', ...data } };
  }

  it('returns imageUrl from the krea2 native /generate shape', async () => {
    const fetchFn = routedFetch({ '/generate': { ok: true, imageUrl: 'http://127.0.0.1:17910/file?path=x.png' } });
    const out = (await executeNode(ctxFor(imgNode({}), imageDeps(fetchFn)))) as Record<string, unknown>;
    expect(out.imageUrl).toBe('http://127.0.0.1:17910/file?path=x.png');
  });

  it('accepts the OpenAI-compatible images shape (data[].url)', async () => {
    const fetchFn = routedFetch({ '/generate': { data: [{ url: 'http://127.0.0.1:17910/img/1.png' }] } });
    const out = (await executeNode(ctxFor(imgNode({}), imageDeps(fetchFn)))) as Record<string, unknown>;
    expect(out.imageUrl).toBe('http://127.0.0.1:17910/img/1.png');
  });

  it('turns a base64 image (data[].b64_json) into a dataUrl', async () => {
    const fetchFn = routedFetch({ '/generate': { data: [{ b64_json: 'QUJD' }] } });
    const out = (await executeNode(ctxFor(imgNode({}), imageDeps(fetchFn)))) as Record<string, unknown>;
    expect(out.dataUrl).toBe('data:image/png;base64,QUJD');
  });

  it('fails with an actionable (never "coming soon") message when krea2 is not reachable', async () => {
    await executeNode(ctxFor(imgNode({}), imageDeps(okBrowserFetchUnused(), null))).catch((err: FlowExecError) => {
      expect(err.code).toBe('node_failed');
      expect(err.message).toMatch(/Krea-2/);
      expect(err.message).not.toMatch(/coming soon/i);
    });
    await expect(executeNode(ctxFor(imgNode({}), imageDeps(okBrowserFetchUnused(), null)))).rejects.toBeInstanceOf(FlowExecError);
  });
});

describe('stt_transcribe', () => {
  it('POSTs the configured endpoint with the resolved audio and returns { text }', async () => {
    const fetchFn = routedFetch({ '/v1/audio/transcriptions': { text: 'hello there' } });
    const deps = fakeDeps({ fetchFn });
    const node: WorkflowGraphNode = {
      id: 'stt', type: 'stt_transcribe',
      data: { endpoint: 'http://127.0.0.1:9000/v1/audio/transcriptions', model: 'whisper-1', audio: '$inputs.rec' },
    };
    const out = (await executeNode(ctxFor(node, deps, { scope: { inputs: { rec: 'data:audio/wav;base64,AA' } } }))) as Record<string, unknown>;
    expect(out.text).toBe('hello there');
  });

  it('fails with an actionable (never "coming soon") message when no endpoint/service is set', async () => {
    const node: WorkflowGraphNode = { id: 'stt', type: 'stt_transcribe', data: { audio: '$inputs.rec' } };
    await executeNode(ctxFor(node, fakeDeps(), { scope: { inputs: { rec: 'data:audio/wav;base64,AA' } } })).catch((err: FlowExecError) => {
      expect(err.code).toBe('node_failed');
      expect(err.message).toMatch(/speech-to-text/);
      expect(err.message).not.toMatch(/coming soon/i);
    });
    await expect(executeNode(ctxFor(node, fakeDeps(), { scope: { inputs: { rec: 'x' } } }))).rejects.toBeInstanceOf(FlowExecError);
  });

  it('rejects a non-allow-listed endpoint', async () => {
    const node: WorkflowGraphNode = { id: 'stt', type: 'stt_transcribe', data: { endpoint: 'https://evil.example/v1/audio/transcriptions', audio: '$inputs.rec' } };
    await expect(executeNode(ctxFor(node, fakeDeps({ fetchFn: routedFetch({}) }), { scope: { inputs: { rec: 'x' } } })))
      .rejects.toMatchObject({ code: 'capability_denied' });
  });
});

describe('tts_speak', () => {
  const endpoint = 'http://127.0.0.1:9001/v1/audio/speech';

  it('turns audio bytes into a data URL', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([65, 66, 67]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })) as unknown as typeof fetch;
    const node: WorkflowGraphNode = { id: 'tts', type: 'tts_speak', data: { endpoint, model: 'tts-1', voice: 'alloy', text: 'hi {{inputs.name}}' } };
    const out = (await executeNode(ctxFor(node, fakeDeps({ fetchFn }), { scope: { inputs: { name: 'Ada' } } }))) as Record<string, unknown>;
    expect(out.audioUrl).toBe('data:audio/mpeg;base64,QUJD'); // "ABC"
    expect(out.dataUrl).toBe('data:audio/mpeg;base64,QUJD');
  });

  it('accepts a JSON { audioUrl } response', async () => {
    const fetchFn = routedFetch({ '/v1/audio/speech': { audioUrl: 'http://127.0.0.1:9001/a.mp3' } });
    const node: WorkflowGraphNode = { id: 'tts', type: 'tts_speak', data: { endpoint, text: 'hi' } };
    const out = (await executeNode(ctxFor(node, fakeDeps({ fetchFn })))) as Record<string, unknown>;
    expect(out.audioUrl).toBe('http://127.0.0.1:9001/a.mp3');
  });

  it('fails with an actionable (never "coming soon") message when no endpoint/service is set', async () => {
    const node: WorkflowGraphNode = { id: 'tts', type: 'tts_speak', data: { text: 'hi' } };
    await executeNode(ctxFor(node, fakeDeps())).catch((err: FlowExecError) => {
      expect(err.code).toBe('node_failed');
      expect(err.message).toMatch(/text-to-speech/);
      expect(err.message).not.toMatch(/coming soon/i);
    });
    await expect(executeNode(ctxFor(node, fakeDeps()))).rejects.toBeInstanceOf(FlowExecError);
  });
});
