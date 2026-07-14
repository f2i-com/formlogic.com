import { describe, expect, it, vi } from 'vitest';
import {
  executeNode,
  FlowExecError,
  isAllowedFlowUrl,
  isLoopbackUrl,
  KV_WRITE_CAPABILITY,
  LOGIC_BLOCK_DEFAULT_TIMEOUT_MS,
  type FlowExecutorDeps,
  type FlowNodeContext,
} from './nodes';
import type { ResolvedAiProvider } from './aiProviders';
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

// Shared adversarial-URL fixture table, pinned against the Rust twin's identical assertions
// (flows/runner.rs `is_loopback_url` / `is_allowed_flow_url` tests). TS was never vulnerable to
// the fragment/userinfo host-spoofing bug fixed on the Rust side — it already parses with
// `new URL()` — but both runtimes are exercised against the SAME strings here so a future change
// to either side that reintroduces divergence is caught immediately.
describe('isLoopbackUrl / isAllowedFlowUrl', () => {
  it('resolves the fragment-userinfo PoC to the attacker host, not loopback', () => {
    // `#` starts the fragment per the WHATWG URL Standard, so `@127.0.0.1/` after it is inert
    // fragment text, never part of the authority. The real (and only) host is attacker.example.com.
    const url = 'http://attacker.example.com#@127.0.0.1/';
    expect(new URL(url).hostname).toBe('attacker.example.com');
    expect(isLoopbackUrl(url)).toBe(false);
    expect(isAllowedFlowUrl(url)).toBe(false);
  });

  it('resolves the userinfo-syntax PoC to the attacker host, not loopback', () => {
    // `user@host` syntax: `127.0.0.1` is discarded as userinfo; the real host is
    // attacker.example.com.
    const url = 'http://127.0.0.1@attacker.example.com/';
    expect(new URL(url).hostname).toBe('attacker.example.com');
    expect(isLoopbackUrl(url)).toBe(false);
    expect(isAllowedFlowUrl(url)).toBe(false);
  });

  it('still recognizes genuinely loopback URLs (port, bare host, bracketed IPv6)', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8080/foo')).toBe(true);
    expect(isLoopbackUrl('http://localhost/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]/')).toBe(true);
  });

  it('isAllowedFlowUrl never falls back to loopback (Desktop base / FormLogic API only)', () => {
    // Loopback is real (isLoopbackUrl says so)...
    expect(isLoopbackUrl('http://127.0.0.1:11434/v1/chat/completions')).toBe(true);
    // ...but isAllowedFlowUrl alone doesn't grant it — only call sites that explicitly OR it
    // with isLoopbackUrl (the service-backed node handlers) get loopback access.
    expect(isAllowedFlowUrl('http://127.0.0.1:11434/v1/chat/completions')).toBe(false);
  });
});

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

// Cross-runtime timeout parity (docs/FORMLOGIC_FLOWS.md §4): a declared data.timeoutMs
// (clamped 100ms..30s) must become the REAL budget the sandbox evaluates against — not
// just an outer wall-clock race — so logic_block/condition behave identically to the Rust
// desktop runner regardless of which value (or none) a node declares.
describe('logic_block timeoutMs threading', () => {
  it('defaults budgetMs to LOGIC_BLOCK_DEFAULT_TIMEOUT_MS when data.timeoutMs is absent', async () => {
    const evaluateExpression = vi.fn(async () => 1);
    const deps = fakeDeps({ evaluateExpression });
    const node: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: '1' } };
    await executeNode(ctxFor(node, deps));
    expect(evaluateExpression).toHaveBeenCalledWith('1', expect.anything(), LOGIC_BLOCK_DEFAULT_TIMEOUT_MS);
  });

  it('clamps a declared timeoutMs into [100, 30000] and passes the SAME value as budgetMs', async () => {
    const evaluateExpression = vi.fn(async () => 1);
    const deps = fakeDeps({ evaluateExpression });

    const tooLow: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: '1', timeoutMs: 10 } };
    await executeNode(ctxFor(tooLow, deps));
    expect(evaluateExpression).toHaveBeenLastCalledWith('1', expect.anything(), 100);

    const tooHigh: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: '1', timeoutMs: 999999 } };
    await executeNode(ctxFor(tooHigh, deps));
    expect(evaluateExpression).toHaveBeenLastCalledWith('1', expect.anything(), 30000);

    const inRange: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: '1', timeoutMs: 5000 } };
    await executeNode(ctxFor(inRange, deps));
    expect(evaluateExpression).toHaveBeenLastCalledWith('1', expect.anything(), 5000);
  });

  it('FAILS the node (not a silent null) when evaluateExpression hangs past the declared timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      // A dep that never settles simulates the sandbox's own budget/backstop never
      // resolving in time — logic_block must now fail loudly (matching condition), not
      // resolve to null the way the old calculateValue()-swallowing wiring did.
      const deps = fakeDeps({ evaluateExpression: () => new Promise(() => {}) });
      const node: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: 'neverResolves()', timeoutMs: 500 } };
      const promise = executeNode(ctxFor(node, deps));
      const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout', nodeId: 'lb' });
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a rejected evaluateExpression as a real failure (does not swallow to null)', async () => {
    const deps = fakeDeps({ evaluateExpression: async () => { throw new Error('sandbox budget exceeded'); } });
    const node: WorkflowGraphNode = { id: 'lb', type: 'logic_block', data: { expr: 'x' } };
    await expect(executeNode(ctxFor(node, deps))).rejects.toThrow(/sandbox budget exceeded/);
  });
});

describe('condition timeoutMs threading', () => {
  it('passes undefined budgetMs when data.timeoutMs is absent (preserves the sandbox default)', async () => {
    const evaluateBoolean = vi.fn(async () => true);
    const deps = fakeDeps({ evaluateBoolean });
    const node: WorkflowGraphNode = { id: 'c', type: 'condition', data: { expr: 'true' } };
    await executeNode(ctxFor(node, deps));
    expect(evaluateBoolean).toHaveBeenCalledWith('true', expect.anything(), undefined);
  });

  it('clamps a declared timeoutMs into [100, 30000] and passes it as budgetMs', async () => {
    const evaluateBoolean = vi.fn(async () => true);
    const deps = fakeDeps({ evaluateBoolean });

    const tooLow: WorkflowGraphNode = { id: 'c', type: 'condition', data: { expr: 'true', timeoutMs: 10 } };
    await executeNode(ctxFor(tooLow, deps));
    expect(evaluateBoolean).toHaveBeenLastCalledWith('true', expect.anything(), 100);

    const tooHigh: WorkflowGraphNode = { id: 'c', type: 'condition', data: { expr: 'true', timeoutMs: 999999 } };
    await executeNode(ctxFor(tooHigh, deps));
    expect(evaluateBoolean).toHaveBeenLastCalledWith('true', expect.anything(), 30000);

    const inRange: WorkflowGraphNode = { id: 'c', type: 'condition', data: { expr: 'true', timeoutMs: 1500 } };
    await executeNode(ctxFor(inRange, deps));
    expect(evaluateBoolean).toHaveBeenLastCalledWith('true', expect.anything(), 1500);
  });

  it('still throws when evaluateBoolean rejects (unchanged fail-closed behavior)', async () => {
    const deps = fakeDeps({ evaluateBoolean: async () => { throw new Error('condition budget exceeded'); } });
    const node: WorkflowGraphNode = { id: 'c', type: 'condition', data: { expr: 'x', timeoutMs: 300 } };
    await expect(executeNode(ctxFor(node, deps))).rejects.toThrow(/condition budget exceeded/);
  });
});

describe('aokie_speak', () => {
  it('interpolates text and routes through the aokie operatorSpeak command', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'Hello {{event.data.name}}' } };
    await executeNode(
      ctxFor(node, deps, {
        scope: { event: { data: { name: 'Sam' } } },
        capabilities: ['connector.aokie.call.operatorSpeak'],
      })
    );
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', { text: 'Hello Sam' });
  });

  it('carries the flow input callId so the plugin can refuse stale speech (phase 0)', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'Hi' } };
    await executeNode(
      ctxFor(node, deps, {
        scope: { inputs: { callId: 'call_9' } },
        capabilities: ['connector.aokie.call.operatorSpeak'],
      })
    );
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', {
      text: 'Hi',
      callId: 'call_9',
    });
  });

  it('carries the caller turn number as inResponseTo (9.2 within-call staleness)', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'Hi' } };
    await executeNode(
      ctxFor(node, deps, {
        scope: { inputs: { callId: 'call_9', turn: 4 } },
        capabilities: ['connector.aokie.call.operatorSpeak'],
      })
    );
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', {
      text: 'Hi',
      callId: 'call_9',
      inResponseTo: 4,
    });
  });

  it('treats a typed stale refusal as a benign skip, never a node error (9.1/9.2)', async () => {
    const staleErr = Object.assign(new Error('the conversation moved on'), { code: 'stale_turn' });
    const connectorRequest = vi.fn(async () => {
      throw staleErr;
    });
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'Hi' } };
    const out = await executeNode(
      ctxFor(node, deps, {
        scope: { inputs: { callId: 'call_9', turn: 4 } },
        capabilities: ['connector.aokie.call.operatorSpeak'],
      })
    );
    expect(out).toEqual({ skipped: true, reason: 'stale_turn' });
  });

  it('supports textFrom selectors', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { textFrom: '$inputs.line' } };
    await executeNode(
      ctxFor(node, deps, {
        scope: { inputs: { line: 'Connecting now' } },
        capabilities: ['connector.aokie.call.operatorSpeak'],
      })
    );
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', { text: 'Connecting now' });
  });
});

// Capability gate shared by connector_request and aokie_speak (docs: declare-then-grant,
// same model as storage_set/KV_WRITE_CAPABILITY above). aokie_speak is inlined sugar for
// connector_request aokie/call.operatorSpeak in nodes.ts, so it must be gated identically —
// these fixtures mirror the Rust twin's `mod tests` 1:1 (runner.rs).
describe('connector_request / aokie_speak capability gate', () => {
  it('connector_request is capability_denied with no nodeCapabilities declared', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = {
      id: 'c',
      type: 'connector_request',
      data: { connectorId: 'aokie', command: 'call.operatorSpeak' },
    };
    await expect(executeNode(ctxFor(node, deps, { capabilities: [] }))).rejects.toMatchObject({
      code: 'capability_denied',
    });
    expect(connectorRequest).not.toHaveBeenCalled();
  });

  it('aokie_speak is capability_denied with no nodeCapabilities declared (closes the TS bypass)', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'hi' } };
    await expect(executeNode(ctxFor(node, deps, { capabilities: [] }))).rejects.toMatchObject({
      code: 'capability_denied',
    });
    expect(connectorRequest).not.toHaveBeenCalled();
  });

  it('connector_request succeeds with the exact connector.<id>.<command> capability', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = {
      id: 'c',
      type: 'connector_request',
      data: { connectorId: 'aokie', command: 'call.operatorSpeak' },
    };
    const out = await executeNode(ctxFor(node, deps, { capabilities: ['connector.aokie.call.operatorSpeak'] }));
    expect(out).toEqual({ ok: true });
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', undefined);
  });

  it('connector_request succeeds with the connector.<id>.* wildcard capability', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = {
      id: 'c',
      type: 'connector_request',
      data: { connectorId: 'aokie', command: 'call.operatorSpeak' },
    };
    const out = await executeNode(ctxFor(node, deps, { capabilities: ['connector.aokie.*'] }));
    expect(out).toEqual({ ok: true });
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', undefined);
  });

  it('aokie_speak succeeds with the connector.aokie.* wildcard capability', async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = { id: 'sp', type: 'aokie_speak', data: { text: 'hi' } };
    await executeNode(ctxFor(node, deps, { capabilities: ['connector.aokie.*'] }));
    expect(connectorRequest).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', { text: 'hi' });
  });

  it("a different connector's capability does not grant aokie", async () => {
    const connectorRequest = vi.fn(async () => ({ ok: true }));
    const deps = fakeDeps({ connectorRequest });
    const node: WorkflowGraphNode = {
      id: 'c',
      type: 'connector_request',
      data: { connectorId: 'aokie', command: 'call.operatorSpeak' },
    };
    await expect(
      executeNode(ctxFor(node, deps, { capabilities: ['connector.other.*'] }))
    ).rejects.toMatchObject({ code: 'capability_denied' });
    expect(connectorRequest).not.toHaveBeenCalled();
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

  it('phone_eq matches digits-normalized last-9 suffixes across formats', async () => {
    const rows = [
      { id: 'p1', answers: { name: 'Lance', phone: '0491 570 156' } },
      { id: 'p2', answers: { name: 'Robin', phone: '+61 400 999 888' } },
      { id: 'p3', answers: { name: 'Shorty', phone: '243' } },
    ];
    const deps = fakeDeps({ listResponses: vi.fn(async () => rows) });
    const out = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'phone', op: 'phone_eq', value: '+61491570156' }] }), deps)
    )) as { count: number; first: { answers: { name: string } } | null };
    expect(out.count).toBe(1);
    expect(out.first?.answers.name).toBe('Lance');
  });

  it('pushes eq AND phone_eq string filters down to the fetch (server-side lookup)', async () => {
    const listResponses = vi.fn(async () => CUSTOMERS);
    await executeNode(
      ctxFor(
        listNode({
          filters: [
            { field: 'tag', op: 'eq', value: 'vip' },
            { field: 'phone', op: 'phone_eq', value: '+61400111222' },
            { field: 'age', op: 'gt', value: 40 }, // not pushable — stays client-side only
          ],
        }),
        fakeDeps({ listResponses })
      )
    );
    expect(listResponses).toHaveBeenCalledWith('form-1', {
      limit: 200,
      answersEq: { tag: 'vip' },
      answersPhoneEq: { phone: '+61400111222' },
    });
  });

  it('fails invalid_flow when the form reference is missing', async () => {
    const node: WorkflowGraphNode = { id: 'lookup', type: 'formlogic_list_responses', data: {} };
    await expect(executeNode(ctxFor(node, fakeDeps()))).rejects.toMatchObject({ code: 'invalid_flow' });
  });

  it('gte/lte compare ISO dates chronologically (string fallback) and numbers numerically', async () => {
    const rows = [
      { id: 'd1', answers: { name: 'Past', date: '2026-01-05' } },
      { id: 'd2', answers: { name: 'InWindow', date: '2026-07-20' } },
      { id: 'd3', answers: { name: 'Boundary', date: '2026-10-12' } },
      { id: 'd4', answers: { name: 'Beyond', date: '2026-12-01' } },
      { id: 'd5', answers: { name: 'NoDate' } },
    ];
    const deps = fakeDeps({ listResponses: vi.fn(async () => rows) });
    const out = (await executeNode(
      ctxFor(
        listNode({
          filters: [
            { field: 'date', op: 'gte', value: '2026-07-14' },
            { field: 'date', op: 'lte', value: '2026-10-12' },
          ],
        }),
        deps
      )
    )) as { count: number; responses: Array<{ answers: { name: string } }> };
    // Inclusive on the boundary; the missing-date row fails gte.
    expect(out.count).toBe(2);
    expect(out.responses.map((r) => r.answers.name)).toEqual(['InWindow', 'Boundary']);
    // Numeric semantics survive: 9 < 10 numerically.
    const nout = (await executeNode(
      ctxFor(listNode({ filters: [{ field: 'age', op: 'gte', value: 10 }] }), fakeDeps({
        listResponses: vi.fn(async () => [
          { id: 'n1', answers: { age: 9 } },
          { id: 'n2', answers: { age: 10 } },
        ]),
      }))
    )) as { count: number };
    expect(nout.count).toBe(1);
  });

  it('pushes gte/lte string bounds down to the fetch (the date window filters BEFORE the limit)', async () => {
    const listResponses = vi.fn(async () => []);
    await executeNode(
      ctxFor(
        listNode({
          filters: [
            { field: 'date', op: 'gte', value: '2026-07-14' },
            { field: 'date', op: 'lte', value: '2026-10-12' },
            { field: 'age', op: 'gte', value: 40 }, // non-string — stays client-side only
          ],
        }),
        fakeDeps({ listResponses })
      )
    );
    expect(listResponses).toHaveBeenCalledWith('form-1', {
      limit: 200,
      answersGte: { date: '2026-07-14' },
      answersLte: { date: '2026-10-12' },
    });
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

  it('uses a browser AI provider before endpoint/Desktop/app-base resolution', async () => {
    const provider: ResolvedAiProvider = {
      name: 'Browser OpenAI',
      kind: 'openai',
      url: 'https://api.openai.test/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      model: 'provider-model',
      responsePath: 'reply.text',
    };
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ reply: { text: 'provider pong' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;
    const resolveAiProvider = vi.fn(async () => provider);
    const deps = fakeDeps({
      fetchFn,
      resolveAiProvider,
      resolveDesktopLlmEndpoint: vi.fn(async () => null),
      getAppAiBase: () => null,
    });

    const out = await executeNode(ctxFor(llmNode({ provider: 'p1', prompt: 'hi {{inputs.name}}' }), deps, {
      scope: { inputs: { name: 'Ada' } },
    }));

    expect(out).toEqual({ content: 'provider pong', raw: { reply: { text: 'provider pong' } } });
    expect(resolveAiProvider).toHaveBeenCalledWith('chat', 'p1');
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.test/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: provider.headers,
      body: expect.any(String),
    }));
    const body = JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('provider-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi Ada' }]);
  });

  it('renders a browser provider requestTemplate instead of the default chat body', async () => {
    const provider: ResolvedAiProvider = {
      name: 'Custom',
      kind: 'custom',
      url: 'https://custom.example.test/chat',
      headers: { 'Content-Type': 'application/json' },
      model: 'custom-model',
      requestTemplate: '{"m": {{model}}, "q": {{prompt}}, "msgs": {{messages}}}',
      responsePath: 'answer',
    };
    const fetchFn = vi.fn(async () => jsonResponse({ answer: 'templated' })) as unknown as typeof fetch;
    const deps = fakeDeps({ fetchFn, resolveAiProvider: vi.fn(async () => provider) });

    const out = await executeNode(ctxFor(llmNode({ provider: 'custom', prompt: 'Use "quotes"' }), deps));

    expect(out).toMatchObject({ content: 'templated' });
    const body = JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      m: 'custom-model',
      q: 'Use "quotes"',
      msgs: [{ role: 'user', content: 'Use "quotes"' }],
    });
  });

  it('fails actionably when a referenced browser AI provider is not configured', async () => {
    const deps = fakeDeps({ resolveAiProvider: vi.fn(async () => null) });
    await expect(executeNode(ctxFor(llmNode({ provider: 'missing' }), deps))).rejects.toMatchObject({
      code: 'node_failed',
      message: expect.stringMatching(/not configured in this browser.*Flows -> AI services/),
    });
  });

  it('keeps legacy resolution when no provider field is present', async () => {
    const fetchFn = okFetch();
    const resolveAiProvider = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const deps = fakeDeps({
      fetchFn,
      resolveAiProvider,
      resolveDesktopLlmEndpoint: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' })),
      getAppAiBase: () => null,
    });

    await executeNode(ctxFor(llmNode({ model: 'm' }), deps));

    expect(resolveAiProvider).not.toHaveBeenCalled();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('falls through to legacy resolution when provider is set but the runtime has no browser provider resolver', async () => {
    const fetchFn = okFetch();
    const deps = fakeDeps({
      fetchFn,
      resolveDesktopLlmEndpoint: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'ollama' })),
      getAppAiBase: () => null,
    });

    await executeNode(ctxFor(llmNode({ provider: 'browser-only', model: 'm' }), deps));

    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
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

describe('http_request', () => {
  it('rejects a non-allow-listed absolute URL when `service` is unset (unchanged existing behavior)', async () => {
    const node: WorkflowGraphNode = { id: 'h', type: 'http_request', data: { url: 'https://evil.example/x' } };
    await expect(executeNode(ctxFor(node, fakeDeps({ fetchFn: routedFetch({}) }))))
      .rejects.toMatchObject({ code: 'capability_denied' });
  });

  it('with `service` set, treats `url` as a PATH under the resolved service base (leading slash)', async () => {
    const fetchFn = routedFetch({ '/predict': { predicted: true } });
    const resolveDesktopServiceBase = vi.fn(async () => 'http://127.0.0.1:8080');
    const node: WorkflowGraphNode = { id: 'h', type: 'http_request', data: { service: 'llama-cpp', url: '/predict' } };
    const out = (await executeNode(ctxFor(node, fakeDeps({ fetchFn, resolveDesktopServiceBase })))) as Record<string, unknown>;
    expect(resolveDesktopServiceBase).toHaveBeenCalledWith('llama-cpp');
    expect(out.ok).toBe(true);
    expect((out.body as Record<string, unknown>).predicted).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:8080/predict', expect.anything());
  });

  it('joins the path the same way whether `url` has a leading slash or not', async () => {
    const fetchFn = routedFetch({ '/predict': { predicted: true } });
    const resolveDesktopServiceBase = vi.fn(async () => 'http://127.0.0.1:8080/');
    const node: WorkflowGraphNode = { id: 'h', type: 'http_request', data: { service: 'llama-cpp', url: 'predict' } };
    await executeNode(ctxFor(node, fakeDeps({ fetchFn, resolveDesktopServiceBase })));
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:8080/predict', expect.anything());
  });

  it('fails with the actionable desktopServiceUnavailable message (never "coming soon") when the service cannot be resolved', async () => {
    const node: WorkflowGraphNode = { id: 'h', type: 'http_request', data: { service: 'llama-cpp', url: '/predict' } };
    const deps = fakeDeps({ resolveDesktopServiceBase: vi.fn(async () => null) });
    await expect(executeNode(ctxFor(node, deps))).rejects.toMatchObject({ code: 'node_failed' });
    await executeNode(ctxFor(node, deps)).catch((err: FlowExecError) => {
      expect(err.message).toMatch(/llama-cpp/);
      expect(err.message).not.toMatch(/coming soon/i);
    });
  });

  it('never redirects to a different host even when `url` looks like an absolute URL, once `service` is fixed', async () => {
    // The templatable `url` can only ever become a PATH under the fixed, author-chosen service
    // base — an attacker controlling trigger data that feeds `url` can influence the path, but
    // never which host is contacted, because `service` is never templated.
    const fetchFn = routedFetch({});
    const resolveDesktopServiceBase = vi.fn(async () => 'http://127.0.0.1:8080');
    const node: WorkflowGraphNode = { id: 'h', type: 'http_request', data: { service: 'llama-cpp', url: 'https://evil.example/steal' } };
    await executeNode(ctxFor(node, fakeDeps({ fetchFn, resolveDesktopServiceBase })));
    const calledUrl = String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.startsWith('http://127.0.0.1:8080/')).toBe(true);
  });
});

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

  it('uses a browser AI provider before endpoint/service resolution', async () => {
    const provider: ResolvedAiProvider = {
      name: 'Speech Provider',
      kind: 'openai',
      url: 'https://api.openai.test/v1/audio/transcriptions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      model: 'whisper-provider',
    };
    const fetchFn = vi.fn(async () => jsonResponse({ text: 'provider transcript' })) as unknown as typeof fetch;
    const resolveAiProvider = vi.fn(async () => provider);
    const deps = fakeDeps({ fetchFn, resolveAiProvider });
    const node: WorkflowGraphNode = {
      id: 'stt',
      type: 'stt_transcribe',
      data: {
        provider: 'p-stt',
        endpoint: 'https://evil.example/v1/audio/transcriptions',
        audio: '$inputs.rec',
      },
    };

    const out = (await executeNode(ctxFor(node, deps, { scope: { inputs: { rec: 'data:audio/wav;base64,AA' } } }))) as Record<string, unknown>;

    expect(out.text).toBe('provider transcript');
    expect(resolveAiProvider).toHaveBeenCalledWith('transcription', 'p-stt');
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.test/v1/audio/transcriptions', expect.objectContaining({
      method: 'POST',
      headers: provider.headers,
      body: expect.any(String),
    }));
    const body = JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ audio: 'data:audio/wav;base64,AA', file: 'data:audio/wav;base64,AA', model: 'whisper-provider' });
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

  it("defaults to the Desktop 'aokie-voice' speech service when no endpoint/service is set (parity with flows/runner.rs)", async () => {
    const fetchFn = routedFetch({ '/v1/audio/transcriptions': { text: 'default service transcript' } });
    const resolveDesktopServiceBase = vi.fn(async () => 'http://127.0.0.1:17920');
    const node: WorkflowGraphNode = { id: 'stt', type: 'stt_transcribe', data: { audio: '$inputs.rec' } };
    const out = (await executeNode(
      ctxFor(node, fakeDeps({ fetchFn, resolveDesktopServiceBase }), { scope: { inputs: { rec: 'data:audio/wav;base64,AA' } } })
    )) as Record<string, unknown>;
    expect(resolveDesktopServiceBase).toHaveBeenCalledWith('aokie-voice');
    expect(out.text).toBe('default service transcript');
  });

  it('an explicitly named service that fails to resolve still errors — never silently substitutes the default', async () => {
    const resolveDesktopServiceBase = vi.fn(async (id: string) => (id === 'aokie-voice' ? 'http://127.0.0.1:17920' : null));
    const node: WorkflowGraphNode = { id: 'stt', type: 'stt_transcribe', data: { service: 'my-whisper', audio: '$inputs.rec' } };
    await expect(
      executeNode(ctxFor(node, fakeDeps({ resolveDesktopServiceBase }), { scope: { inputs: { rec: 'x' } } }))
    ).rejects.toMatchObject({ code: 'node_failed' });
    expect(resolveDesktopServiceBase).toHaveBeenCalledWith('my-whisper');
    expect(resolveDesktopServiceBase).not.toHaveBeenCalledWith('aokie-voice');
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

  it('uses a browser AI provider URL and headers for speech', async () => {
    const provider: ResolvedAiProvider = {
      name: 'Speech Provider',
      kind: 'openai',
      url: 'https://api.openai.test/v1/audio/speech',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      model: 'tts-provider',
    };
    const fetchFn = vi.fn(async () => jsonResponse({ audioUrl: 'https://cdn.example.test/a.mp3' })) as unknown as typeof fetch;
    const resolveAiProvider = vi.fn(async () => provider);
    const node: WorkflowGraphNode = { id: 'tts', type: 'tts_speak', data: { provider: 'p-tts', voice: 'alloy', text: 'hi {{inputs.name}}' } };

    const out = (await executeNode(ctxFor(node, fakeDeps({ fetchFn, resolveAiProvider }), { scope: { inputs: { name: 'Ada' } } }))) as Record<string, unknown>;

    expect(out.audioUrl).toBe('https://cdn.example.test/a.mp3');
    expect(resolveAiProvider).toHaveBeenCalledWith('speech', 'p-tts');
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.test/v1/audio/speech', expect.objectContaining({
      method: 'POST',
      headers: provider.headers,
      body: expect.any(String),
    }));
    const body = JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ input: 'hi Ada', model: 'tts-provider', voice: 'alloy' });
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

  it("defaults to the Desktop 'aokie-voice' speech service when no endpoint/service is set (parity with flows/runner.rs)", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([65, 66, 67]), { status: 200, headers: { 'Content-Type': 'audio/wav' } })) as unknown as typeof fetch;
    const resolveDesktopServiceBase = vi.fn(async () => 'http://127.0.0.1:17920');
    const node: WorkflowGraphNode = { id: 'tts', type: 'tts_speak', data: { text: 'hi' } };
    const out = (await executeNode(ctxFor(node, fakeDeps({ fetchFn, resolveDesktopServiceBase })))) as Record<string, unknown>;
    expect(resolveDesktopServiceBase).toHaveBeenCalledWith('aokie-voice');
    expect(out.audioUrl).toBe('data:audio/wav;base64,QUJD');
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:17920/v1/audio/speech', expect.anything());
  });
});
