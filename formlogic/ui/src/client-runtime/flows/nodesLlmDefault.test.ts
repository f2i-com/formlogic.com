// llm_chat provider-order tests for the plan §5.6 "Default (from Settings)" alias.
//
// The injected runDefaultAiChat dep is the browser runner's alias implementation
// (aiDefault.resolveDefaultLlm, wired by flowDispatcher). These tests pin the ORDER:
//   explicit 'provider:<id>' → paired-Desktop provider (fail closed) — unchanged
//   explicit 'local:<id>'   → browser-local registry only — never the Desktop leg
//   absent / 'default'      → the default alias — typed failures, never a source hop
//   endpoint override       → legacy chain wins over the alias (explicit config first)
// and that a runtime WITHOUT the dep keeps the legacy endpoint chain byte-for-byte.
import { describe, expect, it, vi } from 'vitest';
import { executeNode, FlowExecError, type FlowExecutorDeps, type FlowNodeContext } from './nodes';
import type { DefaultLlmOutcome } from './aiDefault';
import type { ResolvedAiProvider } from './aiProviders';
import type { WorkflowGraphNode } from '../../types/flows';
import type { SelectorScope } from './selectors';

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
  extra: { scope?: SelectorScope } = {}
): FlowNodeContext {
  return {
    node,
    scope: extra.scope ?? { inputs: {}, event: null, app: null, nodes: {} },
    signal: new AbortController().signal,
    deps,
    capabilities: null,
  };
}

function llmNode(data: Record<string, unknown>): WorkflowGraphNode {
  return { id: 'llm', type: 'llm_chat', data: { prompt: 'hi', ...data } };
}

function okFetch(content = 'pong'): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  ) as unknown as typeof fetch;
}

function defaultOk(data: Partial<Extract<DefaultLlmOutcome, { ok: true }>['data']> = {}): DefaultLlmOutcome {
  return { ok: true, data: { source: 'site', content: 'default pong', ...data } };
}

const provider: ResolvedAiProvider = {
  name: 'Browser OpenAI',
  kind: 'openai',
  url: 'https://api.openai.test/v1/chat/completions',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
  model: 'provider-model',
  responsePath: 'reply.text',
};

describe('llm_chat "Default (from Settings)" alias order (plan §5.6)', () => {
  it('an absent provider resolves via the injected default runner, ahead of the legacy chain', async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk({ usage: { total: 4 } }));
    const fetchFn = okFetch();
    const resolveDesktopLlmEndpoint = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' }));
    const deps = fakeDeps({ runDefaultAiChat, fetchFn, resolveDesktopLlmEndpoint });

    const out = await executeNode(ctxFor(llmNode({}), deps));

    expect(out).toEqual({ content: 'default pong', raw: { source: 'site', usage: { total: 4 } } });
    expect(runDefaultAiChat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], expect.anything());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(resolveDesktopLlmEndpoint).not.toHaveBeenCalled();
  });

  it("the literal 'default' provider resolves the same way and carries the tunnel thread id", async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk({ source: 'desktop', threadId: 'thread-9' }));
    const deps = fakeDeps({ runDefaultAiChat, fetchFn: okFetch() });

    const out = await executeNode(ctxFor(llmNode({ provider: 'default' }), deps));

    expect(out).toEqual({ content: 'default pong', raw: { source: 'desktop', threadId: 'thread-9' } });
    expect(runDefaultAiChat).toHaveBeenCalled();
  });

  it("a templated provider resolving to 'default' uses the alias", async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk());
    const deps = fakeDeps({ runDefaultAiChat, fetchFn: okFetch() });

    await executeNode(ctxFor(llmNode({ provider: '{{inputs.provider}}' }), deps, { scope: { inputs: { provider: 'default' }, event: null, app: null, nodes: {} } }));

    expect(runDefaultAiChat).toHaveBeenCalled();
  });

  it('an explicit bare provider beats the alias and keeps the legacy registry path', async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk());
    const resolveAiProvider = vi.fn(async () => provider);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ reply: { text: 'provider pong' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;
    const deps = fakeDeps({ runDefaultAiChat, resolveAiProvider, fetchFn });

    const out = await executeNode(ctxFor(llmNode({ provider: 'p1' }), deps));

    expect(out).toEqual({ content: 'provider pong', raw: { reply: { text: 'provider pong' } } });
    expect(runDefaultAiChat).not.toHaveBeenCalled();
    expect(resolveAiProvider).toHaveBeenCalledWith('chat', 'p1');
  });

  it("an explicit 'provider:<id>' beats the alias and keeps the paired-Desktop path", async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk());
    const invokeDesktopAiChat = vi.fn(async () => ({ choices: [{ message: { content: 'desktop pong' } }] }));
    const deps = fakeDeps({ runDefaultAiChat, invokeDesktopAiChat, fetchFn: okFetch() });

    const out = await executeNode(ctxFor(llmNode({ provider: 'provider:desk-1' }), deps));

    expect(out).toEqual({ content: 'desktop pong', raw: { choices: [{ message: { content: 'desktop pong' } }] } });
    expect(runDefaultAiChat).not.toHaveBeenCalled();
    expect(invokeDesktopAiChat).toHaveBeenCalledWith('desk-1', expect.any(Object), expect.anything());
  });

  it("'local:<id>' resolves the browser registry WITHOUT the paired-Desktop leg", async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk());
    const invokeDesktopAiChat = vi.fn(async () => null);
    const resolveAiProvider = vi.fn(async () => provider);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ reply: { text: 'local pong' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;
    const deps = fakeDeps({ runDefaultAiChat, invokeDesktopAiChat, resolveAiProvider, fetchFn });

    const out = await executeNode(ctxFor(llmNode({ provider: 'local:p1' }), deps));

    expect(out).toEqual({ content: 'local pong', raw: { reply: { text: 'local pong' } } });
    expect(invokeDesktopAiChat).not.toHaveBeenCalled();
    expect(runDefaultAiChat).not.toHaveBeenCalled();
    expect(resolveAiProvider).toHaveBeenCalledWith('chat', 'p1');
  });

  it("an alias 'ai_allowance_exceeded' failure propagates typed — never a silent source hop", async () => {
    const runDefaultAiChat = vi.fn(async (): Promise<DefaultLlmOutcome> => ({
      ok: false,
      error: { code: 'ai_allowance_exceeded', message: 'Monthly Site AI allowance used up.', status: 402 },
    }));
    const fetchFn = okFetch();
    const resolveDesktopLlmEndpoint = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' }));
    const deps = fakeDeps({ runDefaultAiChat, fetchFn, resolveDesktopLlmEndpoint });

    const err = (await executeNode(ctxFor(llmNode({}), deps)).catch((e: FlowExecError) => e)) as FlowExecError;

    expect(err).toBeInstanceOf(FlowExecError);
    expect(err.code).toBe('node_failed');
    expect(err.message).toMatch(/ai_allowance_exceeded/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(resolveDesktopLlmEndpoint).not.toHaveBeenCalled();
  });

  it('an alias tunnel failure (desktop_offline) propagates typed — never a silent source hop', async () => {
    const runDefaultAiChat = vi.fn(async (): Promise<DefaultLlmOutcome> => ({
      ok: false,
      error: { code: 'desktop_offline', message: 'The linked desktop is offline.' },
    }));
    const fetchFn = okFetch();
    const deps = fakeDeps({ runDefaultAiChat, fetchFn });

    const err = (await executeNode(ctxFor(llmNode({ provider: 'default' }), deps)).catch((e: FlowExecError) => e)) as FlowExecError;

    expect(err).toBeInstanceOf(FlowExecError);
    expect(err.code).toBe('node_failed');
    expect(err.message).toMatch(/desktop_offline/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a throwing alias runner surfaces as node_failed naming the default lane', async () => {
    const runDefaultAiChat = vi.fn(async (): Promise<DefaultLlmOutcome> => {
      throw new Error('tunnel exploded');
    });
    const deps = fakeDeps({ runDefaultAiChat });

    const err = (await executeNode(ctxFor(llmNode({}), deps)).catch((e: FlowExecError) => e)) as FlowExecError;

    expect(err).toBeInstanceOf(FlowExecError);
    expect(err.code).toBe('node_failed');
    expect(err.message).toMatch(/default AI failed/);
    expect(err.message).toMatch(/tunnel exploded/);
  });

  it('an explicit endpoint override keeps the legacy path even when the alias runner exists', async () => {
    const runDefaultAiChat = vi.fn(async () => defaultOk());
    const fetchFn = okFetch('endpoint pong');
    const deps = fakeDeps({ runDefaultAiChat, fetchFn });

    const out = await executeNode(ctxFor(llmNode({ endpoint: '/api/v1/chat/completions', model: 'm' }), deps));

    expect(out).toEqual({ content: 'endpoint pong', raw: expect.any(Object) });
    expect(runDefaultAiChat).not.toHaveBeenCalled();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/v1/chat/completions');
  });

  it('without the alias dep, an absent provider keeps the legacy Desktop-service chain unchanged', async () => {
    const fetchFn = okFetch('legacy pong');
    const resolveDesktopLlmEndpoint = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' }));
    const deps = fakeDeps({ fetchFn, resolveDesktopLlmEndpoint, getAppAiBase: () => null });

    const out = await executeNode(ctxFor(llmNode({ model: 'm' }), deps));

    expect(out).toEqual({ content: 'legacy pong', raw: expect.any(Object) });
    expect(resolveDesktopLlmEndpoint).toHaveBeenCalled();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});
