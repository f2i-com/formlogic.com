// flow_call child-invocation core (childFlowInvoker.ts): the §8.8 guards, inline
// execution + completion envelope, ancestry extension for grandchildren, and the
// dispatcher-wiring pin (both scope builders must carry an invoker — a scope mix-up
// here shipped once and stranded flow_call in BOTH scopes).
import { describe, expect, it, vi } from 'vitest';
import {
  FLOW_CALL_MAX_DEPTH,
  invokeChildFlowWith,
  type ChildFlowBackend,
  type ResolvedChildFlow,
} from './childFlowInvoker';
import { buildDefaultExecutorDeps, buildWorkspaceExecutorDeps } from './flowDispatcher';
import type { FlowExecutorDeps } from './nodes';

function fakeExecDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
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

const CHILD: ResolvedChildFlow = {
  slug: 'child',
  nodeCapabilities: null,
  flowJson: {
    nodes: [
      { id: 'in', type: 'input' },
      { id: 't', type: 'template', data: { template: 'hi {{inputs.name}}' } },
      { id: 'out', type: 'output' },
    ],
    edges: [
      { source: 'in', target: 't' },
      { source: 't', target: 'out' },
    ],
  },
};

function backend(overrides: Partial<ChildFlowBackend> = {}): ChildFlowBackend {
  return {
    scope: 'test scope',
    resolveFlow: async () => CHILD,
    reserveRun: async () => ({ runId: 'run-child' }),
    completeRun: vi.fn(async () => {}),
    appContext: () => undefined,
    executorDeps: () => fakeExecDeps(),
    ...overrides,
  };
}

describe('invokeChildFlowWith', () => {
  it('executes the child inline, returns the envelope, and completes the run', async () => {
    const completeRun = vi.fn(async () => {});
    const b = backend({ completeRun });
    const envelope = await invokeChildFlowWith(b, {
      targetFlowId: 'child-1',
      inputs: { name: 'Alex' },
      callNodeId: 'call',
      callStack: ['parent-1'],
      parentRunId: 'run-parent',
    });
    expect(envelope.status).toBe('done');
    expect(envelope.result).toBe('hi Alex');
    expect(envelope.runId).toBe('run-child');
    expect(completeRun).toHaveBeenCalledWith('run-child', expect.objectContaining({ status: 'done', result: 'hi Alex' }));
  });

  it('refuses an unresolvable flow with dependency_missing', async () => {
    const b = backend({ resolveFlow: async () => null });
    await expect(
      invokeChildFlowWith(b, { targetFlowId: 'ghost', inputs: {}, callNodeId: 'c', callStack: ['p'] }),
    ).rejects.toThrow(/dependency_missing/);
  });

  it('refuses a target already in the awaited ancestry with recursion_detected', async () => {
    const b = backend();
    await expect(
      invokeChildFlowWith(b, { targetFlowId: 'child-1', inputs: {}, callNodeId: 'c', callStack: ['root', 'child-1'] }),
    ).rejects.toThrow(/recursion_detected/);
  });

  it('refuses at the awaited depth ceiling with root_budget_exceeded', async () => {
    const b = backend();
    const deepStack = Array.from({ length: FLOW_CALL_MAX_DEPTH }, (_, i) => `flow-${i}`);
    await expect(
      invokeChildFlowWith(b, { targetFlowId: 'child-1', inputs: {}, callNodeId: 'c', callStack: deepStack }),
    ).rejects.toThrow(/root_budget_exceeded/);
  });

  it('surfaces reservation failures as transport_failed', async () => {
    const b = backend({ reserveRun: async () => ({ error: 'quota' }) });
    await expect(
      invokeChildFlowWith(b, { targetFlowId: 'child-1', inputs: {}, callNodeId: 'c', callStack: ['p'] }),
    ).rejects.toThrow(/transport_failed.*quota/);
  });

  it('extends the ancestry so a grandchild calling an ancestor is refused', async () => {
    // The child graph flow_calls BACK to the parent id; its executor deps route through
    // the same backend, so the extended callStack must trip the recursion guard and
    // (fail-parent default) fail the CHILD run — surfaced in the awaited envelope.
    const looping: ResolvedChildFlow = {
      slug: 'loops-back',
      nodeCapabilities: null,
      flowJson: {
        nodes: [
          { id: 'in', type: 'input' },
          { id: 'call', type: 'flow_call', data: { flowId: 'parent-1' } },
        ],
        edges: [{ source: 'in', target: 'call' }],
      },
    };
    const b: ChildFlowBackend = backend({
      resolveFlow: async (id) => (id === 'loopy' ? looping : CHILD),
      executorDeps: () =>
        fakeExecDeps({ invokeChildFlow: (req) => invokeChildFlowWith(b, req) }),
    });
    const envelope = await invokeChildFlowWith(b, {
      targetFlowId: 'loopy',
      inputs: {},
      callNodeId: 'c',
      callStack: ['parent-1'],
    });
    expect(envelope.status).toBe('error');
    expect(envelope.error?.message).toMatch(/recursion_detected/);
  });
});

describe('dispatcher wiring (scope mix-up pin)', () => {
  it('BOTH executor-deps builders carry a flow_call invoker', () => {
    expect(typeof buildDefaultExecutorDeps().invokeChildFlow).toBe('function');
    expect(typeof buildWorkspaceExecutorDeps().invokeChildFlow).toBe('function');
  });

  it('BOTH executor-deps builders carry the §7.6 service_action Desktop invoker', () => {
    expect(typeof buildDefaultExecutorDeps().invokeServiceAction).toBe('function');
    expect(typeof buildWorkspaceExecutorDeps().invokeServiceAction).toBe('function');
  });
});
