import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFlowDispatcherForTests,
  __setFlowDispatcherDepsForTests,
  __setRuntimeFlowsForTests,
  claimQueuedAppRuns,
  type FlowDispatcherDeps,
} from './flowDispatcher';
import type { FlowExecutorDeps } from './nodes';
import type { FlowRunLog, RuntimeFlows } from '../../types/flows';

// Queued-run claiming (docs/FORMLOGIC_FLOWS.md §10): an open app runtime lists queued runs,
// claims each exactly once (queued→running; the loser of a race gets 409 and skips), executes
// from the stored input_snapshot.event, and completes the run. Everything is injected.

function echoFlow(): RuntimeFlows['flows'][number] {
  return {
    slug: 'echo',
    name: 'Echo',
    engine: 'f2i',
    flowJson: {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'out', type: 'output', data: { value: '$inputs.phone' } },
      ],
      edges: [{ source: 'in', target: 'out' }],
    },
    inputSchema: null,
    outputSchema: null,
    nodeCapabilities: null,
    version: 1,
  };
}

function binding(): RuntimeFlows['bindings'][number] {
  return {
    id: 'b1',
    flow: 'echo',
    formId: null,
    connectorId: null,
    event: 'form.submitted',
    mode: 'async',
    condition: null,
    inputMap: { phone: '$event.data.answers.phone' },
    outputActions: null,
    timeoutMs: 5000,
    retryPolicy: null,
    fallbackPolicy: null,
    sortOrder: 0,
  };
}

function queuedRun(overrides: Partial<FlowRunLog> = {}): FlowRunLog {
  return {
    runId: 'run-1',
    appId: 'app-1',
    formId: 'form-1',
    responseId: 'resp-1',
    bindingId: 'b1',
    flowDefinitionId: 'fd-1',
    flow: 'echo',
    triggerEvent: 'form.submitted',
    correlationId: 'corr-1',
    idempotencyKey: 'flow:b1:form.submitted:form-1:resp-1',
    status: 'queued',
    runtime: null,
    claimedBy: null,
    inputSnapshot: { event: { name: 'form.submitted', data: { answers: { phone: '+614' } } } },
    result: null,
    outputActions: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Harness {
  claimCalls: Array<{ runId: string; runtime: string; instanceId?: string }>;
  completeCalls: Array<{ runId: string; payload: Record<string, unknown> }>;
}

function installDeps(overrides: Partial<FlowDispatcherDeps>): Harness {
  const harness: Harness = { claimCalls: [], completeCalls: [] };
  const executorDeps: FlowExecutorDeps = {
    evaluateBoolean: async () => true,
    evaluateExpression: async () => null,
    listResponses: async () => [],
    submitResponse: async () => ({}),
    updateResponse: async () => ({}),
    connectorRequest: async () => ({ ok: true }),
  };
  __setFlowDispatcherDepsForTests({
    getAppSlug: () => 'my-app',
    getAppContext: () => ({ slug: 'my-app', id: 'app-1' }),
    executorDeps,
    createResponse: async () => ({}),
    updateResponse: async () => ({}),
    connectorRequest: async () => ({ ok: true }),
    evaluateCondition: async () => true,
    toast: () => undefined,
    delay: async () => undefined,
    claimRun: async (_slug, runId, payload) => {
      harness.claimCalls.push({ runId, runtime: payload.runtime, instanceId: payload.instanceId });
      return { claimed: true };
    },
    completeRun: async (_slug, runId, payload) => {
      harness.completeCalls.push({ runId, payload: payload as unknown as Record<string, unknown> });
    },
    ...overrides,
  });
  return harness;
}

afterEach(() => {
  __resetFlowDispatcherForTests();
  vi.restoreAllMocks();
});

describe('claimQueuedAppRuns', () => {
  it('claims a queued run (runtime browser + instanceId), executes from the snapshot, completes done', async () => {
    const harness = installDeps({ listQueuedRuns: async () => [queuedRun()] });
    __setRuntimeFlowsForTests({ flows: [echoFlow()], bindings: [binding()] }, 'my-app');

    const executed = await claimQueuedAppRuns();

    expect(executed).toBe(1);
    expect(harness.claimCalls).toHaveLength(1);
    expect(harness.claimCalls[0]).toMatchObject({ runId: 'run-1', runtime: 'browser' });
    expect(harness.claimCalls[0].instanceId).toBeTruthy();
    // input_snapshot.event drove the binding inputMap: $event.data.answers.phone → +614.
    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('done');
    expect(harness.completeCalls[0].payload.result).toEqual({ value: '+614' });
  });

  it('a 409 (already claimed) skips execution — no complete', async () => {
    const harness = installDeps({
      listQueuedRuns: async () => [queuedRun()],
      claimRun: async () => ({ claimed: false }),
    });
    __setRuntimeFlowsForTests({ flows: [echoFlow()], bindings: [binding()] }, 'my-app');

    const executed = await claimQueuedAppRuns();

    expect(executed).toBe(0);
    expect(harness.completeCalls).toHaveLength(0);
  });

  it('claiming a run whose flow is not loaded completes runner_unavailable', async () => {
    const harness = installDeps({
      listQueuedRuns: async () => [queuedRun({ flow: 'ghost' })],
    });
    __setRuntimeFlowsForTests({ flows: [echoFlow()], bindings: [binding()] }, 'my-app');

    await claimQueuedAppRuns();

    expect(harness.claimCalls).toHaveLength(1);
    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('error');
    expect((harness.completeCalls[0].payload.error as { code: string }).code).toBe('runner_unavailable');
  });
});
