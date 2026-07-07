import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFlowDispatcherForTests,
  __setFlowDispatcherDepsForTests,
  __setRuntimeFlowsForTests,
  dispatchFormEvent,
  runFlowBySlug,
  type FlowDispatcherDeps,
} from './flowDispatcher';
import type { FlowExecutorDeps } from './nodes';
import type { RuntimeFlows } from '../../types/flows';

// Dispatcher pipeline (docs/FORMLOGIC_FLOWS.md §5): condition → reserve-first (idempotent
// replay skips execution) → inputMap → execute → outputActions → complete. All browser
// bindings are injected, so the whole pipeline runs headless here.

function passthroughGraph(): RuntimeFlows['flows'][number] {
  return {
    slug: 'echo',
    name: 'Echo',
    engine: 'f2i',
    flowJson: {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'out', type: 'output', data: { value: '$inputs.callerPhone' } },
      ],
      edges: [{ source: 'in', target: 'out' }],
    },
    inputSchema: null,
    outputSchema: null,
    nodeCapabilities: null,
    version: 1,
  };
}

function binding(overrides: Partial<RuntimeFlows['bindings'][number]> = {}): RuntimeFlows['bindings'][number] {
  return {
    id: 'b1',
    flow: 'echo',
    formId: null,
    connectorId: null,
    event: 'form.submitted',
    mode: 'sync',
    condition: null,
    inputMap: { callerPhone: '$event.data.answers.phone' },
    outputActions: null,
    timeoutMs: 5000,
    retryPolicy: null,
    fallbackPolicy: null,
    sortOrder: 0,
    ...overrides,
  };
}

interface Harness {
  reserveCalls: Array<Record<string, unknown>>;
  completeCalls: Array<{ runId: string; payload: Record<string, unknown> }>;
  toasts: Array<{ message: string; level: string }>;
  conditionCalls: Array<{ expr: string; ctx: Record<string, unknown> }>;
  connectorCalls: Array<{ connectorId: string; command: string; payload: unknown }>;
}

function installDeps(overrides: Partial<FlowDispatcherDeps> = {}): Harness {
  const harness: Harness = { reserveCalls: [], completeCalls: [], toasts: [], conditionCalls: [], connectorCalls: [] };
  const seenKeys = new Set<string>();
  const executorDeps: FlowExecutorDeps = {
    evaluateBoolean: async () => true,
    evaluateExpression: async () => null,
    listResponses: async () => [],
    submitResponse: async () => ({ id: 'resp-new' }),
    updateResponse: async () => ({ id: 'resp-upd' }),
    connectorRequest: async () => ({ ok: true }),
  };
  __setFlowDispatcherDepsForTests({
    getAppSlug: () => 'my-app',
    getAppContext: () => ({ slug: 'my-app', id: 'app-1' }),
    fetchRuntimeFlows: async () => null,
    reserveRun: async (_slug, payload) => {
      harness.reserveCalls.push(payload as unknown as Record<string, unknown>);
      // Mimic the server's UNIQUE idempotency_key gate: replays return idempotent.
      if (seenKeys.has(payload.idempotencyKey)) return { runId: 'run-dup', idempotent: true };
      seenKeys.add(payload.idempotencyKey);
      return { runId: `run-${seenKeys.size}` };
    },
    completeRun: async (_slug, runId, payload) => {
      harness.completeCalls.push({ runId, payload: payload as unknown as Record<string, unknown> });
    },
    evaluateCondition: async (expr, ctx) => {
      harness.conditionCalls.push({ expr, ctx });
      // Mimic the QuickJS empty-global sandbox: only `event` exists as a context global,
      // so an expression touching window/document throws a ReferenceError.
      if (/\b(window|document|globalThis|fetch)\b/.test(expr)) {
        throw new ReferenceError("'window' is not defined");
      }
      return true;
    },
    executorDeps,
    createResponse: async () => ({ id: 'resp-new' }),
    updateResponse: async () => ({ id: 'resp-upd' }),
    connectorRequest: async (connectorId, command, payload) => {
      harness.connectorCalls.push({ connectorId, command, payload });
      return { ok: true };
    },
    toast: (message, level) => harness.toasts.push({ message, level }),
    delay: async () => undefined,
    ...overrides,
  });
  return harness;
}

afterEach(() => {
  __resetFlowDispatcherForTests();
  vi.restoreAllMocks();
});

describe('dispatchFormEvent — idempotency', () => {
  it('a duplicate event reserves with the SAME key and executes at most once', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding()] }, 'my-app');

    const detail = { formId: 'form-1', responseId: 'resp-7', answers: { phone: '+614' } };
    await dispatchFormEvent('form.submitted', detail);
    await dispatchFormEvent('form.submitted', detail); // replay (double-fire / second tab)

    expect(harness.reserveCalls).toHaveLength(2);
    expect(harness.reserveCalls[0].idempotencyKey).toBe(harness.reserveCalls[1].idempotencyKey);
    expect(harness.reserveCalls[0].idempotencyKey).toBe('flow:b1:form.submitted:form-1:resp-7');
    // Execution + completion happened exactly once — the replay saw idempotent and skipped.
    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('done');
  });

  it('builds inputs via inputMap selectors and stores them in the reserve snapshot', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding()] }, 'my-app');

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r1', answers: { phone: '+61400' } });

    expect(harness.reserveCalls[0].inputSnapshot).toEqual({ callerPhone: '+61400' });
    // The executor saw those inputs: the output node selected $inputs.callerPhone.
    expect(harness.completeCalls[0].payload.result).toEqual({ value: '+61400' });
  });
});

describe('binding condition — sandbox semantics', () => {
  it('gets ONLY the event scope (no window/DOM), and an erroring expression fails safe', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests(
      {
        flows: [passthroughGraph()],
        bindings: [binding({ condition: { type: 'expression', expr: 'window.location.href.length > 0' } })],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r2', answers: {} });

    // The evaluator received a JSON ctx exposing only `event` — never window/document.
    expect(harness.conditionCalls).toHaveLength(1);
    expect(Object.keys(harness.conditionCalls[0].ctx)).toEqual(['event']);
    // The ReferenceError (as QuickJS would throw) skipped the binding entirely: no run.
    expect(harness.reserveCalls).toHaveLength(0);
    expect(harness.completeCalls).toHaveLength(0);
  });

  it('a false condition skips the binding without reserving', async () => {
    const harness = installDeps({ evaluateCondition: async () => false });
    __setRuntimeFlowsForTests(
      { flows: [passthroughGraph()], bindings: [binding({ condition: { type: 'expression', expr: 'false' } })] },
      'my-app'
    );
    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r3', answers: {} });
    expect(harness.reserveCalls).toHaveLength(0);
  });
});

describe('binding matching + output actions', () => {
  it('ignores events that match no binding', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding({ event: 'aokie.call.ended' })] }, 'my-app');
    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r4', answers: {} });
    expect(harness.reserveCalls).toHaveLength(0);
  });

  it('a binding scoped to a form only fires for that form', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding({ formId: 'form-2' })] }, 'my-app');
    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r5', answers: {} });
    expect(harness.reserveCalls).toHaveLength(0);
    await dispatchFormEvent('form.submitted', { formId: 'form-2', responseId: 'r6', answers: {} });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it('applies outputActions in order after a successful run (when-gated, templated)', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests(
      {
        flows: [passthroughGraph()],
        bindings: [
          binding({
            outputActions: [
              { type: 'formlogic.toast', message: 'Caller {{result}}' },
              { type: 'call.speak', message: 'Connecting {{result}}', when: '$result' },
              { type: 'connector.request', connectorId: 'aokie', command: 'sms.send', payload: { to: '$result' }, when: '$result.missing' },
            ],
          }),
        ],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r7', answers: { phone: '+614' } });

    expect(harness.toasts).toEqual([{ message: 'Caller +614', level: 'info' }]);
    // call.speak routes through the aokie connector's operatorSpeak command.
    expect(harness.connectorCalls).toEqual([
      { connectorId: 'aokie', command: 'call.operatorSpeak', payload: { message: 'Connecting +614' } },
    ]);
    // The third action's `when` selector was falsy — sms.send never fired.
  });

  it('formlogic.store output action persists part of the result into Flow KV', async () => {
    const kvCalls: Array<{ scope: string; key: string; value: unknown }> = [];
    const executorDeps: FlowExecutorDeps = {
      evaluateBoolean: async () => true,
      evaluateExpression: async () => null,
      listResponses: async () => [],
      submitResponse: async () => ({}),
      updateResponse: async () => ({}),
      connectorRequest: async () => ({ ok: true }),
      kvSet: async (scope, key, value) => {
        kvCalls.push({ scope, key, value });
        return { scope, key, v: value };
      },
    };
    installDeps({ executorDeps });
    __setRuntimeFlowsForTests(
      {
        flows: [passthroughGraph()],
        bindings: [
          binding({
            outputActions: [
              { type: 'formlogic.store', scope: 'app', key: 'lastCaller', value: '$result' } as never,
            ],
          }),
        ],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'rk', answers: { phone: '+619' } });

    expect(kvCalls).toEqual([{ scope: 'app', key: 'lastCaller', value: '+619' }]);
  });

  it('surfaces the sync fallbackReply as a toast when the flow fails', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests(
      {
        flows: [
          {
            ...passthroughGraph(),
            slug: 'broken',
            flowJson: { nodes: [{ id: 'x', type: 'not_a_real_node' }], edges: [] },
          },
        ],
        bindings: [
          binding({ flow: 'broken', fallbackPolicy: { onError: 'log_and_continue', fallbackReply: 'One moment please.' } }),
        ],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r8', answers: {} });

    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('error');
    expect(harness.toasts).toEqual([{ message: 'One moment please.', level: 'warning' }]);
  });

  it('retries per retryPolicy up to maxAttempts before completing with the failure', async () => {
    let attempts = 0;
    const harness = installDeps({
      executorDeps: {
        evaluateBoolean: async () => true,
        evaluateExpression: async () => null,
        listResponses: async () => [],
        submitResponse: async () => ({}),
        updateResponse: async () => ({}),
        connectorRequest: async () => {
          attempts += 1;
          throw new Error('flaky connector');
        },
      },
    });
    __setRuntimeFlowsForTests(
      {
        flows: [
          {
            ...passthroughGraph(),
            slug: 'flaky',
            flowJson: {
              nodes: [
                { id: 'in', type: 'input' },
                { id: 'req', type: 'connector_request', data: { connectorId: 'aokie', command: 'call.current' } },
              ],
              edges: [{ source: 'in', target: 'req' }],
            },
          },
        ],
        bindings: [binding({ flow: 'flaky', retryPolicy: { maxAttempts: 3, backoff: 'none' } })],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r9', answers: {} });

    expect(attempts).toBe(3);
    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('error');
  });
});

describe('runFlowBySlug (flow.run effect / manual)', () => {
  it('sync: reserves, executes, completes, and resolves with the flow result', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [] }, 'my-app');

    const result = await runFlowBySlug('echo', { input: { callerPhone: '+615' }, mode: 'sync' });

    expect(result).toBe('+615');
    expect(harness.reserveCalls).toHaveLength(1);
    expect(harness.reserveCalls[0].triggerEvent).toBe('manual');
    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('done');
  });

  it('rejects for an unknown flow slug', async () => {
    installDeps();
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [] }, 'my-app');
    await expect(runFlowBySlug('nope')).rejects.toThrow(/Unknown or disabled flow/);
  });
});
