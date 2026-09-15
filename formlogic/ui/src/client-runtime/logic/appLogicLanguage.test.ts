// @vitest-environment node
//
// App-logic scripts in Python (formlogic-python/1): a script's `language` reaches the engine,
// so a Python `def run(ctx)` returns the same effects / ui / reject objects a JavaScript
// `function run(ctx)` does and the trusted host applies them the same way. Runs on the REAL
// installed ZIPP engine (zipp-host runEval, minus the Worker Vitest doesn't have): the mocked
// runAppLogic hands zipp-host exactly what engine.ts would post to the Worker.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from './appLogicHost';
import { runAppLogic } from '../../lib/formlogic';
import { runEval } from '../../lib/formlogic/zipp-host';
import type { CustomAppLogicBundle, CustomAppLogicScript } from '../../types/customAppLogic';

vi.mock('../../lib/formlogic', () => ({
  runAppLogic: vi.fn(),
}));

const mockedRunAppLogic = vi.mocked(runAppLogic);

// A runaway Python loop spends the whole instruction budget (seconds), and there is no Worker
// watchdog here to cut it short.
const CASE_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await runEval('calc', '1 + 1', {});
}, CASE_TIMEOUT_MS);

beforeEach(() => {
  mockedRunAppLogic.mockReset();
  mockedRunAppLogic.mockImplementation((source, ctx, budgetMs, language) =>
    runEval('applogic', source, ctx, { budgetMs, language })
  );
});

function script(id: string, hook: CustomAppLogicScript['hook'], source: string, language?: CustomAppLogicScript['language']): CustomAppLogicScript {
  return { id, hook, runtime: 'quickjs', source, enabled: true, ...(language ? { language } : {}) };
}

function bundle(scripts: CustomAppLogicScript[], permissions: string[] = []): CustomAppLogicBundle {
  return { version: 1, runtime: 'quickjs', strictPermissions: true, scripts, permissions: permissions as CustomAppLogicBundle['permissions'] };
}

const GATE = `def run(ctx):
    fuel = ctx["answers"].get("fuel_percent") or 0
    if fuel < 15:
        return {"reject": True, "message": "Fuel is too low (" + str(fuel) + "%)."}
    return {"ui": {"setValues": {"checked": True}}, "warnings": ["checked " + ctx["hook"]]}
`;

describe('app logic in Python, through the trusted host on the real engine', () => {
  it('a Python run(ctx) rejects, or returns effects the host applies', async () => {
    const logic = bundle([script('gate', 'onBeforeSubmit', GATE, 'python')], ['ui.setValues']);

    const low = await runHook({ bundle: logic, hook: 'onBeforeSubmit', input: { answers: { fuel_percent: 8 } } });
    expect(low.errors).toEqual([]);
    expect(low.rejected).toBe(true);
    expect(low.message).toBe('Fuel is too low (8%).');

    const applied: Array<Record<string, unknown>> = [];
    const ok = await runHook({
      bundle: logic,
      hook: 'onBeforeSubmit',
      input: { answers: { fuel_percent: 60 } },
      handlers: { setValues: (values) => applied.push(values) },
    });
    expect(ok.errors).toEqual([]);
    expect(ok.rejected).toBe(false);
    expect(ok.ran).toBe(1);
    expect(ok.values).toEqual({ checked: true });
    expect(applied).toEqual([{ checked: true }]);
    expect(ok.warnings).toEqual(['checked onBeforeSubmit']);
    expect(mockedRunAppLogic.mock.calls.every((call) => call[3] === 'python')).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('JavaScript and Python scripts on one hook each run in their own language', async () => {
    const logic = bundle([
      script('js', 'onScreenEnter', "function run(ctx) { return { ui: { setValues: { a: 'js' } } }; }"),
      script('py', 'onScreenEnter', 'def run(ctx):\n    return {"ui": {"setValues": {"b": "py"}}}', 'python'),
    ], ['ui.setValues']);
    const outcome = await runHook({ bundle: logic, hook: 'onScreenEnter', input: {} });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ a: 'js', b: 'py' });
    expect(mockedRunAppLogic.mock.calls.map((call) => call[3])).toEqual([undefined, 'python']);
  }, CASE_TIMEOUT_MS);

  it('a script in a language this host does not run fails; it never runs as JavaScript', async () => {
    const logic = bundle([
      script('odd', 'onAppStart', "function run(ctx) { return { ui: { setValues: { ranAsJs: true } } }; }", 'ruby' as never),
    ], ['ui.setValues']);
    const outcome = await runHook({ bundle: logic, hook: 'onAppStart', input: {} });
    expect(outcome.ran).toBe(0);
    expect(outcome.values).toEqual({});
    expect(outcome.errors).toEqual(['odd: Unknown logic language: ruby']);
  }, CASE_TIMEOUT_MS);

  it("a script whose language is null or '' is JavaScript, as the server reads it", async () => {
    const logic = bundle([
      { ...script('empty', 'onAppStart', 'function run(ctx) { return { ui: { setValues: { a: 1 } } }; }'), language: '' as never },
      { ...script('null', 'onAppStart', 'function run(ctx) { return { ui: { setValues: { b: 2 } } }; }'), language: null as never },
    ], ['ui.setValues']);
    const all = await runHook({ bundle: logic, hook: 'onAppStart', input: {} });
    expect(all.errors).toEqual([]);
    expect(all.values).toEqual({ a: 1, b: 2 });
    // The Desktop split keeps them with the JavaScript scripts...
    const kept = await runHook({ bundle: logic, hook: 'onAppStart', input: {}, languages: ['javascript'] });
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual({ a: 1, b: 2 });
    // ...and defers them with the JavaScript scripts.
    expect((await runHook({ bundle: logic, hook: 'onAppStart', input: {}, languages: ['python'] })).ran).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('a runaway Python script is a resource error and does not affect the next hook', async () => {
    const logic = bundle([
      script('spin', 'onAppStart', 'def run(ctx):\n    while True:\n        pass', 'python'),
      script('gate', 'onBeforeSubmit', GATE, 'python'),
    ]);
    const spun = await runHook({ bundle: logic, hook: 'onAppStart', input: {} });
    expect(spun.ran).toBe(0);
    expect(spun.errors).toHaveLength(1);
    expect(spun.errors[0]).toMatch(/^spin: .*instruction budget/);

    const next = await runHook({ bundle: logic, hook: 'onBeforeSubmit', input: { answers: { fuel_percent: 3 } } });
    expect(next.errors).toEqual([]);
    expect(next.rejected).toBe(true);
    expect(next.message).toBe('Fuel is too low (3%).');
  }, CASE_TIMEOUT_MS);

  it('`languages` runs only those scripts, and a hook chained from them runs every script', async () => {
    // The desktop bridge's split: JavaScript went to a Desktop, Python stays here. The Python
    // script asks a connector; the chained onConnectorEvent handles a result no Desktop saw.
    const logic = bundle([
      script('js-event', 'onConnectorEvent', "function run(ctx) { return ctx.event && ctx.event.result ? { ui: { setValues: { mapped: ctx.event.result.v } } } : { ui: { setValues: { jsRanOnRaw: true } } }; }"),
      script('py-event', 'onConnectorEvent', 'def run(ctx):\n    if ctx["event"].get("result"):\n        return {}\n    return {"effects": [{"type": "connector.request", "connectorId": "device", "command": "gps.read"}]}', 'python'),
    ], ['ui.setValues', 'connector.device.*']);
    const outcome = await runHook({
      bundle: logic,
      hook: 'onConnectorEvent',
      input: { event: { name: 'aokie.call.incoming' } },
      handlers: { connectorRequest: async () => ({ v: 42 }), setValues: () => {} },
      languages: ['python'],
    });
    expect(outcome.errors).toEqual([]);
    // js-event never saw the raw event (the Desktop has it) but did map the chained result.
    expect(outcome.values).toEqual({ mapped: 42 });
  }, CASE_TIMEOUT_MS);
});
