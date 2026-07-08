import { describe, expect, it, vi } from 'vitest';
import { executeFlow, validateWorkflowGraph } from './flowExecutor';
import type { FlowExecutorDeps } from './nodes';
import type { WorkflowGraph } from '../../types/flows';

// v0 browser executor (docs/FORMLOGIC_FLOWS.md §4): topological interpretation of the
// restricted node set, condition branch routing via sourceHandle, invalid_flow on unknown
// node types, and the per-run timeout. All capabilities are injected (FlowExecutorDeps),
// so no QuickJS worker / network / store is needed here.

function fakeDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
  return {
    evaluateBoolean: vi.fn(async () => true),
    evaluateExpression: vi.fn(async () => null),
    listResponses: vi.fn(async () => []),
    submitResponse: vi.fn(async () => ({ id: 'resp-1' })),
    updateResponse: vi.fn(async () => ({ id: 'resp-1' })),
    connectorRequest: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('validateWorkflowGraph', () => {
  it('accepts a well-formed graph and rejects shape violations', () => {
    expect(validateWorkflowGraph({ nodes: [{ id: 'a', type: 'input' }], edges: [] })).toBeNull();
    expect(validateWorkflowGraph(null)).toMatch(/nodes/);
    expect(validateWorkflowGraph({ nodes: [{ id: '', type: 'input' }], edges: [] })).toMatch(/valid id/);
    expect(
      validateWorkflowGraph({ nodes: [{ id: 'a', type: 'input' }, { id: 'a', type: 'output' }], edges: [] })
    ).toMatch(/Duplicate/);
    expect(
      validateWorkflowGraph({ nodes: [{ id: 'a', type: 'input' }], edges: [{ source: 'a', target: 'ghost' }] })
    ).toMatch(/missing node/);
  });
});

describe('executeFlow — condition routing', () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'in', type: 'input' },
      { id: 'check', type: 'condition', data: { expr: 'inputs.flag' } },
      { id: 'yes', type: 'template', data: { template: 'took true ({{inputs.name}})' } },
      { id: 'no', type: 'template', data: { template: 'took false' } },
      { id: 'out', type: 'output' },
    ],
    edges: [
      { source: 'in', target: 'check' },
      { source: 'check', target: 'yes', sourceHandle: 'true' },
      { source: 'check', target: 'no', sourceHandle: 'false' },
      { source: 'yes', target: 'out' },
      { source: 'no', target: 'out' },
    ],
  };

  it('follows the true branch when the sandboxed condition is true', async () => {
    const deps = fakeDeps({
      evaluateBoolean: vi.fn(async (_expr, ctx) => !!(ctx.inputs as { flag?: unknown }).flag),
    });
    const outcome = await executeFlow(graph, { inputs: { flag: true, name: 'Alex' }, deps });
    expect(outcome.status).toBe('done');
    expect(outcome.result).toBe('took true (Alex)');
    expect(outcome.nodesExecuted).toBe(4); // in, check, yes, out — 'no' pruned
  });

  it('follows the false branch when the condition is false', async () => {
    const deps = fakeDeps({
      evaluateBoolean: vi.fn(async (_expr, ctx) => !!(ctx.inputs as { flag?: unknown }).flag),
    });
    const outcome = await executeFlow(graph, { inputs: { flag: false }, deps });
    expect(outcome.status).toBe('done');
    expect(outcome.result).toBe('took false');
  });
});

describe('executeFlow — nodes', () => {
  it('template node interpolates event/inputs paths', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'tpl', type: 'template', data: { template: 'Hi {{event.data.callerName}} / {{inputs.x}}' } },
      ],
      edges: [{ source: 'in', target: 'tpl' }],
    };
    const outcome = await executeFlow(graph, {
      inputs: { x: 7 },
      event: { data: { callerName: 'Alex' } },
      deps: fakeDeps(),
    });
    expect(outcome.status).toBe('done');
    expect(outcome.result).toBe('Hi Alex / 7');
  });

  it('formlogic_submit_response submits resolved answers through the injected api', async () => {
    const submitResponse = vi.fn(async () => ({ id: 'resp-42' }));
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        {
          id: 'submit',
          type: 'formlogic_submit_response',
          data: { form: 'form-1', answers: { phone: '$inputs.callerPhone', note: 'from flow' } },
        },
        { id: 'out', type: 'output' },
      ],
      edges: [
        { source: 'in', target: 'submit' },
        { source: 'submit', target: 'out' },
      ],
    };
    const outcome = await executeFlow(graph, {
      inputs: { callerPhone: '+61400000000' },
      deps: fakeDeps({ submitResponse }),
    });
    expect(outcome.status).toBe('done');
    expect(submitResponse).toHaveBeenCalledWith('form-1', { phone: '+61400000000', note: 'from flow' });
    expect(outcome.result).toEqual({ id: 'resp-42' }); // output passes upstream through
  });

  it('an unknown node type fails the run with invalid_flow naming the node', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'mystery', type: 'quantum_entangle' },
      ],
      edges: [{ source: 'in', target: 'mystery' }],
    };
    const outcome = await executeFlow(graph, { deps: fakeDeps() });
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('invalid_flow');
    expect(outcome.error?.nodeId).toBe('mystery');
    expect(outcome.error?.message).toContain('quantum_entangle');
    expect(outcome.error?.message).toContain('mystery');
  });

  it('a throwing node yields node_failed with the node id', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'boom', type: 'connector_request', data: { connectorId: 'aokie', command: 'sms.send' } },
      ],
      edges: [{ source: 'in', target: 'boom' }],
    };
    const outcome = await executeFlow(graph, {
      deps: fakeDeps({ connectorRequest: vi.fn(async () => { throw new Error('no dongle'); }) }),
      // Declared so the throw under test comes from the connector dispatch itself, not the
      // capability gate (see nodes.test.ts for the capability_denied cases).
      capabilities: ['connector.aokie.sms.send'],
    });
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('node_failed');
    expect(outcome.error?.message).toContain('no dongle');
  });

  it('http_request outside the allow-list is capability_denied', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'req', type: 'http_request', data: { url: 'https://evil.example.com/exfil' } },
      ],
      edges: [{ source: 'in', target: 'req' }],
    };
    const outcome = await executeFlow(graph, { deps: fakeDeps() });
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('capability_denied');
    expect(outcome.error?.nodeId).toBe('req');
  });
});

describe('executeFlow — limits', () => {
  it('enforces the per-run timeout (a hung node cannot outlive the deadline)', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'stuck', type: 'logic_block', data: { expr: 'while(true){}' } },
      ],
      edges: [{ source: 'in', target: 'stuck' }],
    };
    const outcome = await executeFlow(graph, {
      timeoutMs: 250, // schema minimum
      deps: fakeDeps({ evaluateExpression: vi.fn(() => new Promise(() => { /* never resolves */ })) }),
    });
    expect(outcome.status).toBe('timeout');
    expect(outcome.error?.code).toBe('timeout');
  });

  it('a cyclic graph is invalid_flow', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'template', data: { template: 'x' } },
        { id: 'b', type: 'template', data: { template: 'y' } },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    };
    const outcome = await executeFlow(graph, { deps: fakeDeps() });
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('invalid_flow');
    expect(outcome.error?.message).toMatch(/cycle/i);
  });

  it('an external abort maps to cancelled, not timeout', async () => {
    const controller = new AbortController();
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'slow', type: 'logic_block', data: { expr: '1' } },
      ],
      edges: [{ source: 'in', target: 'slow' }],
    };
    const deps = fakeDeps({
      evaluateExpression: vi.fn(() => new Promise(() => { /* hangs until aborted */ })),
    });
    const run = executeFlow(graph, { timeoutMs: 60_000, deps, signal: controller.signal });
    controller.abort();
    const outcome = await run;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.error?.code).toBe('cancelled');
  });
});

describe('executeFlow — logic_block/condition per-node timeoutMs (docs §4)', () => {
  it('logic_block: a declared timeoutMs shorter than the flow deadline FAILS the flow, not a silent null result', async () => {
    // Regression guard for the actual bug: previously `evaluateExpression` was called with
    // NO budget (2 args), so the sandbox's own internal default budget fired early and
    // swallowed to `null` well before this node-level race ever got a chance to fire. This
    // fake reproduces exactly that pre-fix call shape (budgetMs === undefined -> resolve
    // null immediately) vs. the fixed shape (budgetMs threaded through -> hangs past it),
    // so — unlike a fake that simply never resolves regardless of args — this test actually
    // fails if the budgetMs threading regresses, not just if the outer race is removed.
    const evaluateExpression = vi.fn((_expr: string, _ctx: Record<string, unknown>, budgetMs?: number) => {
      if (budgetMs === undefined) return Promise.resolve(null);
      return new Promise(() => { /* never resolves within the declared budget */ });
    });
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'lb', type: 'logic_block', data: { expr: 'neverResolves()', timeoutMs: 150 } },
      ],
      edges: [{ source: 'in', target: 'lb' }],
    };
    const outcome = await executeFlow(graph, {
      timeoutMs: 30_000, // generous flow deadline — the NODE's own 150ms must fire first
      deps: fakeDeps({ evaluateExpression }),
    });
    expect(evaluateExpression).toHaveBeenCalledWith('neverResolves()', expect.anything(), 150);
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('timeout');
    expect(outcome.error?.message).toMatch(/150ms/);
    expect(outcome.result).toBeUndefined();
  });

  it('condition: an evaluateBoolean rejection still fails the flow (unchanged fail-closed behavior)', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'c', type: 'condition', data: { expr: 'x', timeoutMs: 300 } },
      ],
      edges: [{ source: 'in', target: 'c' }],
    };
    const outcome = await executeFlow(graph, {
      deps: fakeDeps({
        evaluateBoolean: vi.fn(async () => {
          throw new Error('condition budget exceeded');
        }),
      }),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toMatch(/condition budget exceeded/);
  });
});
