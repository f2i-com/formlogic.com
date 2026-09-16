import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFlowDispatcherForTests,
  __setFlowDispatcherDepsForTests,
  __setRuntimeFlowsForTests,
  claimQueuedAppRuns,
  startWorkspaceClaimLoop,
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
  claimCalls: Array<{ runId: string; runtime: string; instanceId?: string; logicLanguages?: readonly string[] }>;
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
      harness.claimCalls.push({ runId, runtime: payload.runtime, instanceId: payload.instanceId, logicLanguages: payload.logicLanguages });
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

  it('lists and claims declaring the languages this browser runs', async () => {
    const listQueuedRuns = vi.fn(async () => [queuedRun()]);
    const harness = installDeps({ listQueuedRuns });
    __setRuntimeFlowsForTests({ flows: [echoFlow()], bindings: [binding()] }, 'my-app');

    await claimQueuedAppRuns();

    expect(listQueuedRuns).toHaveBeenCalledWith('my-app', expect.any(Number), ['javascript', 'python']);
    expect(harness.claimCalls[0].logicLanguages).toEqual(['javascript', 'python']);
  });

  // A queued aokie.* run belongs to a fresh Desktop — unless its flow has Python code and no
  // fresh Desktop advertises Python: the server hides that run from the Desktop, so skipping
  // it here would leave it queued until the heartbeat died.
  it('keeps desktop-first runs the Desktop cannot run instead of stranding them', async () => {
    const pyFlow: RuntimeFlows['flows'][number] = {
      ...echoFlow(),
      slug: 'py-echo',
      flowJson: {
        nodes: [
          { id: 'in', type: 'input' },
          { id: 'lb', type: 'logic_block', data: { expr: 'inputs["phone"]', language: 'python' } },
        ],
        edges: [{ source: 'in', target: 'lb' }],
      },
    };
    const aokieRun = (runId: string, flow: string) =>
      queuedRun({ runId, flow, bindingId: null, triggerEvent: 'aokie.call.ended', inputSnapshot: { event: { name: 'aokie.call.ended', data: {} } } });
    const runs = [aokieRun('run-js', 'echo'), aokieRun('run-py', 'py-echo')];

    // A legacy Desktop (no capability tokens) takes JavaScript, as it always has.
    let harness = installDeps({
      listQueuedRuns: async () => runs,
      desktopRuntimeFresh: async () => ({ fresh: true, freshCapabilities: [[]] }),
    });
    __setRuntimeFlowsForTests({ flows: [echoFlow(), pyFlow], bindings: [] }, 'my-app');
    await claimQueuedAppRuns();
    expect(harness.claimCalls.map((c) => c.runId)).toEqual(['run-py']);

    // A healthy ZIPP-era Desktop that runs Python takes every run.
    __resetFlowDispatcherForTests();
    harness = installDeps({
      listQueuedRuns: async () => runs,
      desktopRuntimeFresh: async () => ({ fresh: true, freshCapabilities: [['logic-language:python', 'logic-engine:zipp']] }),
    });
    __setRuntimeFlowsForTests({ flows: [echoFlow(), pyFlow], bindings: [] }, 'my-app');
    await claimQueuedAppRuns();
    expect(harness.claimCalls).toHaveLength(0);

    // Before PR-A the python token alone took every run (0 claims here). It marks a ZIPP-era
    // Desktop, and without 'logic-engine:zipp' its engine is down: the browser claims both runs.
    __resetFlowDispatcherForTests();
    harness = installDeps({
      listQueuedRuns: async () => runs,
      desktopRuntimeFresh: async () => ({ fresh: true, freshCapabilities: [['logic-language:python']] }),
    });
    __setRuntimeFlowsForTests({ flows: [echoFlow(), pyFlow], bindings: [] }, 'my-app');
    await claimQueuedAppRuns();
    expect(harness.claimCalls.map((c) => c.runId).sort()).toEqual(['run-js', 'run-py']);
  });

  it('the workspace claim loop declares the languages too', async () => {
    const listWorkspaceQueuedRuns = vi.fn(async () => [queuedRun({ appId: null, bindingId: null, formId: null })]);
    const claims: Array<{ runtime: string; logicLanguages?: readonly string[] }> = [];
    installDeps({
      fetchWorkspaceFlows: async () => [{ ...echoFlow(), id: 'fd-1', enabled: true } as never],
      listWorkspaceQueuedRuns,
      claimWorkspaceRun: async (_runId, payload) => {
        claims.push(payload);
        return { claimed: false };
      },
    });
    const stop = startWorkspaceClaimLoop();
    try {
      await vi.waitFor(() => expect(claims).toHaveLength(1));
    } finally {
      stop();
    }
    expect(listWorkspaceQueuedRuns).toHaveBeenCalledWith(expect.any(Number), ['javascript', 'python']);
    expect(claims[0]).toMatchObject({ runtime: 'browser', logicLanguages: ['javascript', 'python'] });
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
