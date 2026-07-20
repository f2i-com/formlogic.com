import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFlowDispatcherForTests,
  __setFlowDispatcherDepsForTests,
  __setRuntimeFlowsForTests,
  defaultDesktopRuntimeFresh,
  dispatchFormEvent,
  isDesktopFlowChatProvider,
  runFlowBySlug,
  shouldDeferEventToDesktop,
  type FlowDispatcherDeps,
} from './flowDispatcher';
import { api } from '../../lib/api';
import type { FlowExecutorDeps } from './nodes';
import type { RuntimeFlows } from '../../types/flows';
import type { AiSourceListing } from './desktopService';

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

describe('Desktop named-provider flow routing', () => {
  const source = (overrides: Partial<AiSourceListing> = {}): AiSourceListing => ({
    id: 'provider:openai-codex-agent',
    kind: 'provider',
    refId: 'openai-codex-agent',
    name: 'ChatGPT via Codex',
    category: 'ChatGPT / Codex',
    status: 'provider',
    capabilities: ['chat'],
    useCases: ['background', 'forms', 'flows'],
    url: '',
    model: 'gpt-5.6-luna',
    enabled: true,
    ...overrides,
  });

  it('accepts flow-capable and legacy providers but rejects call-only virtual adapters', () => {
    expect(isDesktopFlowChatProvider(source(), 'openai-codex-agent')).toBe(true);
    expect(isDesktopFlowChatProvider(source({ useCases: undefined }), 'openai-codex-agent')).toBe(true);
    expect(isDesktopFlowChatProvider(source({
      id: 'provider:openai-codex-agent-luna-low',
      refId: 'openai-codex-agent-luna-low',
      useCases: ['live-call', 'try-assistant'],
    }), 'openai-codex-agent-luna-low')).toBe(false);
  });
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

describe('desktop-first routing for connector events', () => {
  it('defers aokie.* events to the desktop runtime while its heartbeat is fresh', async () => {
    const harness = installDeps({ desktopRuntimeFresh: async () => true });
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding({ event: 'aokie.call.ended' })] }, 'my-app');
    await dispatchFormEvent('aokie.call.ended', { formId: 'form-1', responseId: 'rd1', answers: {} });
    // The desktop owns live-call work (local LLM + speech) — the browser must not reserve.
    expect(harness.reserveCalls).toHaveLength(0);
  });

  it('takes over aokie.* events when the desktop heartbeat is stale', async () => {
    const harness = installDeps({ desktopRuntimeFresh: async () => false });
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding({ event: 'aokie.call.ended' })] }, 'my-app');
    await dispatchFormEvent('aokie.call.ended', { formId: 'form-1', responseId: 'rd2', answers: {} });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it('never defers non-connector events, even with a fresh desktop', async () => {
    const harness = installDeps({ desktopRuntimeFresh: async () => true });
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding()] }, 'my-app');
    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'rd3', answers: {} });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it('a failing freshness probe fails OPEN (the browser still handles the event)', async () => {
    const harness = installDeps({ desktopRuntimeFresh: async () => { throw new Error('offline'); } });
    __setRuntimeFlowsForTests({ flows: [passthroughGraph()], bindings: [binding({ event: 'aokie.call.ended' })] }, 'my-app');
    await dispatchFormEvent('aokie.call.ended', { formId: 'form-1', responseId: 'rd4', answers: {} });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  // The SHARED single-writer gate (audit FL-001/C-04): the app-logic
  // connector-event bridge (useDesktopConnectorEvents) applies the exact same
  // predicate before running raw onConnectorEvent record writes, so the
  // browser and the desktop runtime can never both write for one event.
  it('shouldDeferEventToDesktop mirrors the routing for the app-logic bridge', async () => {
    installDeps({ desktopRuntimeFresh: async () => true });
    expect(await shouldDeferEventToDesktop('aokie.call.incoming')).toBe(true);
    expect(await shouldDeferEventToDesktop('form.submitted')).toBe(false);

    installDeps({ desktopRuntimeFresh: async () => false });
    expect(await shouldDeferEventToDesktop('aokie.call.incoming')).toBe(false);

    // Fails open: an unreachable probe must never strand an event unwritten.
    installDeps({ desktopRuntimeFresh: async () => { throw new Error('offline'); } });
    expect(await shouldDeferEventToDesktop('aokie.call.incoming')).toBe(false);
  });

  // Regression (live report 2026-07-13, duplicated transcript turns): ROUTE-001
  // wrapped GET /desktop-connections as {connections:[...]} and the DEFAULT
  // freshness probe still read res.data as a bare array — it saw zero rows,
  // reported "no desktop", and the browser wrote every aokie.* record a second
  // time next to the desktop runtime's row. The default probe must understand
  // the wrapped shape (and still treat a stale heartbeat as not-fresh).
  it('defaultDesktopRuntimeFresh reads the {connections:[...]} wrapper as UTC', async () => {
    const spy = vi.spyOn(api, 'getDesktopConnections');
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-13T04:00:00Z'));
      // The REAL wire format: zone-less "YYYY-MM-DD HH:MM:SS", which the
      // backend serves in UTC (MySQL session pinned to +00:00). Parsing it
      // as local time made every heartbeat look hours stale on a non-UTC
      // browser — the 2026-07-13 double-write root cause.
      spy.mockResolvedValue({
        data: { connections: [{ lastSeenAt: '2026-07-13 03:59:30' }] },
      } as never);
      expect(await defaultDesktopRuntimeFresh()).toBe(true);

      // Past the 30s probe cache; a heartbeat older than 90s is not fresh.
      vi.setSystemTime(new Date('2026-07-13T04:00:31Z'));
      spy.mockResolvedValue({
        data: { connections: [{ lastSeenAt: '2026-07-13 03:00:00' }] },
      } as never);
      expect(await defaultDesktopRuntimeFresh()).toBe(false);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
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
      { connectorId: 'aokie', command: 'call.operatorSpeak', payload: { text: 'Connecting +614' } },
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

  it('a sync binding whose flow succeeds but whose output action throws still persists \'done\', yet triggers the fallback', async () => {
    // The bug this guards: a thrown output action (e.g. the aokie connector's
    // operatorSpeak rejecting a bad payload) used to be swallowed into
    // `result.outputActionErrors` with NO effect on the fallback decision, because
    // `outcome.status` stayed 'done'. The fix threads the collected actionErrors back onto
    // the returned outcome so `runBinding`'s fallback check can see them.
    const harness = installDeps({
      connectorRequest: async () => {
        throw new Error('plugin busy');
      },
    });
    __setRuntimeFlowsForTests(
      {
        flows: [passthroughGraph()],
        bindings: [
          binding({
            outputActions: [{ type: 'call.speak', message: 'Thanks {{result}}' }],
            fallbackPolicy: { onError: 'log_and_continue', fallbackReply: 'Sorry, one moment.' },
          }),
        ],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r10', answers: { phone: '+617' } });

    // (c) the terminal status persisted to the run log is UNCHANGED: the flow graph itself
    // succeeded, so it still completes 'done' — only the in-memory fallback decision differs.
    expect(harness.completeCalls).toHaveLength(1);
    expect(harness.completeCalls[0].payload.status).toBe('done');
    // (a) the collected action error made it onto the persisted result (proves actionErrors
    // was actually populated — the only source for `result.outputActionErrors`).
    expect(harness.completeCalls[0].payload.result).toEqual({
      value: '+617',
      outputActionErrors: ['call.speak: plugin busy'],
    });
    // (b) applyFallback actually fired despite status:'done', because outcome.actionErrors was
    // non-empty — this is the exact new branch of runBinding's fallback condition.
    expect(harness.toasts).toEqual([{ message: 'Sorry, one moment.', level: 'warning' }]);
  });

  it('a sync binding whose flow succeeds and whose output action ALSO succeeds never triggers the fallback', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests(
      {
        flows: [passthroughGraph()],
        bindings: [
          binding({
            outputActions: [{ type: 'call.speak', message: 'Thanks {{result}}' }],
            fallbackPolicy: { onError: 'log_and_continue', fallbackReply: 'Sorry, one moment.' },
          }),
        ],
      },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r11', answers: { phone: '+618' } });

    expect(harness.completeCalls[0].payload.status).toBe('done');
    expect(harness.completeCalls[0].payload.result).toEqual({ value: '+618' }); // no outputActionErrors key
    expect(harness.toasts).toEqual([]); // no fallback — nothing failed
  });

  it('a sync binding with NO output actions configured never triggers the fallback', async () => {
    const harness = installDeps();
    __setRuntimeFlowsForTests(
      { flows: [passthroughGraph()], bindings: [binding({ fallbackPolicy: { fallbackReply: 'Sorry, one moment.' } })] },
      'my-app'
    );

    await dispatchFormEvent('form.submitted', { formId: 'form-1', responseId: 'r12', answers: { phone: '+619' } });

    expect(harness.completeCalls[0].payload.status).toBe('done');
    expect(harness.toasts).toEqual([]);
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
            // Declared so retries exercise the connector dispatch under test, not the
            // capability gate (see nodes.test.ts for the capability_denied cases).
            nodeCapabilities: ['connector.aokie.call.current'],
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
