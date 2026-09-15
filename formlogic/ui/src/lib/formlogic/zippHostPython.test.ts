// @vitest-environment node
//
// zipp-host's Python path as a host, on the real engine: which engine methods it uses and in
// what order, how many attempts a block costs, what crosses into the guest, and how failures
// are classified. What the contract MEANS is in docs/contracts/formlogic-python-logic-corpus.json
// (pythonLogicCorpus.test.ts); this file pins how this host runs it.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../../../vendor/zipp-wasm/zipp_wasm.js';
import { runEval, SandboxGuestError, type EvalKind } from './zipp-host';

const CASE_TIMEOUT_MS = 60_000;
const CONTEXT = { inputs: { n: 2, secret: 'context-sentinel-7f3a' }, event: null, app: null, nodes: {}, upstream: null, kv: {} };

const spies = {
  initPythonProject: vi.spyOn(Engine.prototype, 'initPythonProject'),
  pythonCall: vi.spyOn(Engine.prototype, 'pythonCall'),
  setInstructionBudget: vi.spyOn(Engine.prototype, 'setInstructionBudget'),
  dispose: vi.spyOn(Engine.prototype, 'dispose'),
  initScript: vi.spyOn(Engine.prototype, 'initScript'),
  initSource: vi.spyOn(Engine.prototype, 'initSource'),
  evalInContext: vi.spyOn(Engine.prototype, 'evalInContext'),
  takeHostRequests: vi.spyOn(Engine.prototype, 'takeHostRequests'),
  takeUi: vi.spyOn(Engine.prototype, 'takeUi'),
  setPythonInput: vi.spyOn(Engine.prototype, 'setPythonInput'),
  setSyncHostCapabilities: vi.spyOn(Engine.prototype, 'setSyncHostCapabilities'),
  setDbBridge: vi.spyOn(Engine.prototype, 'setDbBridge'),
  setLocalStorageBridge: vi.spyOn(Engine.prototype, 'setLocalStorageBridge'),
};

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockClear();
});
afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
});

/** The logic_block.py text each attempt compiled, in order. */
const attempts = (): string[] =>
  spies.initPythonProject.mock.calls.map(([files]) => (files as Record<string, string>)['logic_block.py']);
const isExpressionAttempt = (block: string) => block.includes('def __formlogic_value__():');

async function python(kind: EvalKind, source: string, context: Record<string, unknown> = CONTEXT): Promise<unknown> {
  return runEval(kind, source, context, { language: 'python' });
}

async function failure(kind: EvalKind, source: string): Promise<unknown> {
  try {
    await python(kind, source);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${kind} ${JSON.stringify(source)} to fail`);
}

describe('zipp-host: language selection', () => {
  it('runs JavaScript when no language is given, or JavaScript is', async () => {
    await expect(runEval('flow', 'inputs.n * 2', CONTEXT)).resolves.toBe(4);
    await expect(runEval('flow', 'inputs.n * 2', CONTEXT, { language: 'javascript' })).resolves.toBe(4);
    expect(spies.initScript).toHaveBeenCalledTimes(2);
    expect(spies.initPythonProject).not.toHaveBeenCalled();
  });

  it('runs Python only for flow, condition, applogic and syntax', async () => {
    for (const kind of ['calc', 'validate', 'test'] as const) {
      const err = await failure(kind, '1');
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SandboxGuestError);
      expect((err as Error).message).toMatch(new RegExp(`not available for '${kind}'`));
    }
    expect(spies.initPythonProject).not.toHaveBeenCalled();
  });

  it('refuses a language it does not know, as a host error', async () => {
    const err = await runEval('flow', '1', CONTEXT, { language: 'ruby' as never }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandboxGuestError);
    expect((err as Error).message).toBe('Unknown logic language: ruby');
    expect(spies.initPythonProject).not.toHaveBeenCalled();
    expect(spies.initScript).not.toHaveBeenCalled();
  });
});

describe('zipp-host: one Python evaluation', () => {
  it('sets the instruction budget before the project, then calls the entry once, and disposes', async () => {
    await expect(python('flow', 'inputs["n"] * 2')).resolves.toBe(4);
    expect(spies.setInstructionBudget).toHaveBeenCalledWith(200_000_000);
    expect(spies.setInstructionBudget.mock.invocationCallOrder[0]).toBeLessThan(spies.initPythonProject.mock.invocationCallOrder[0]);
    expect(spies.initPythonProject).toHaveBeenCalledTimes(1);
    const [files, entry, argv] = spies.initPythonProject.mock.calls[0];
    expect(Object.keys(files as object).sort()).toEqual(['formlogic.py', 'logic_block.py', 'main.py']);
    expect(entry).toBe('main');
    expect(argv).toEqual([]);
    expect(spies.pythonCall).toHaveBeenCalledTimes(1);
    expect(spies.pythonCall.mock.calls[0][0]).toBe('__formlogic_run__');
    expect(spies.dispose).toHaveBeenCalledTimes(1);
  });

  it('uses no JavaScript entry point, bridge, capability or host channel', async () => {
    await python('flow', 'result = inputs["n"]');
    await python('condition', 'inputs["n"] > 1');
    await python('applogic', 'def run(ctx):\n    return {"n": ctx["inputs"]["n"]}');
    await python('syntax', 'x = 1');
    for (const name of ['initScript', 'initSource', 'evalInContext', 'takeHostRequests', 'takeUi', 'setPythonInput', 'setSyncHostCapabilities', 'setDbBridge', 'setLocalStorageBridge'] as const) {
      expect(spies[name], name).not.toHaveBeenCalled();
    }
  });

  it('passes the context only as the entry argument, as the JSON the JavaScript path would parse', async () => {
    const context = { ...CONTEXT, inputs: { ...CONTEXT.inputs, when: new Date(0), gone: undefined } };
    await expect(python('flow', '[inputs["when"], "gone" in inputs, inputs["secret"]]', context)).resolves.toEqual([
      '1970-01-01T00:00:00.000Z',
      false,
      'context-sentinel-7f3a',
    ]);
    const files = spies.initPythonProject.mock.calls[0][0] as Record<string, string>;
    for (const text of Object.values(files)) expect(text).not.toContain('context-sentinel-7f3a');
    expect(spies.pythonCall.mock.calls[0][1]).toEqual([JSON.parse(JSON.stringify(context))]);
  });

  it('compiles a syntax check and calls nothing', async () => {
    await expect(python('syntax', 'raise SystemExit(1)')).resolves.toBeNull();
    expect(spies.initPythonProject).toHaveBeenCalledTimes(1);
    expect(spies.pythonCall).not.toHaveBeenCalled();
  });

  it('carries a 5000-row context across', async () => {
    const rows = Array.from({ length: 5000 }, (_, n) => ({ n, answers: { note: 'x'.repeat(50) } }));
    await expect(python('flow', 'result = sum(1 for r in nodes["rows"] if r["n"] % 2 == 0)', { ...CONTEXT, nodes: { rows } })).resolves.toBe(2500);
  }, CASE_TIMEOUT_MS);
});

describe('zipp-host: flow attempts', () => {
  it('runs an expression in one attempt', async () => {
    await expect(python('flow', 'inputs["n"] + 40 # one attempt')).resolves.toBe(42);
    expect(attempts().map(isExpressionAttempt)).toEqual([true]);
  });

  it('retries statements as a module once, then remembers the source', async () => {
    const source = 'x = inputs["n"]\nresult = x * 3 # remembered';
    await expect(python('flow', source)).resolves.toBe(6);
    expect(attempts().map(isExpressionAttempt)).toEqual([true, false]);
    expect(spies.pythonCall).toHaveBeenCalledTimes(1);
    expect(spies.dispose).toHaveBeenCalledTimes(2);

    spies.initPythonProject.mockClear();
    await expect(python('flow', source)).resolves.toBe(6);
    expect(attempts().map(isExpressionAttempt)).toEqual([false]);
  });

  it('does not remember a source over 64 KiB, which pays the failed compile each time', async () => {
    const source = `result = inputs["n"]\n# ${'x'.repeat(64 * 1024)}`;
    await expect(python('flow', source)).resolves.toBe(2);
    await expect(python('flow', source)).resolves.toBe(2);
    expect(attempts().map(isExpressionAttempt)).toEqual([true, false, true, false]);
  }, CASE_TIMEOUT_MS);

  it('does not retry an expression that compiled and then raised', async () => {
    const err = await failure('flow', 'nodes["missing"] # raised');
    expect(err).toBeInstanceOf(SandboxGuestError);
    expect(attempts().map(isExpressionAttempt)).toEqual([true]);
    expect(spies.pythonCall).toHaveBeenCalledTimes(1);
  });

  it('runs a block with no code as a module, whose value is None', async () => {
    await expect(python('flow', '# a note\n\n   # another\n')).resolves.toBeNull();
    expect(attempts().map(isExpressionAttempt)).toEqual([false]);
  });

  it('gives conditions and app logic a single attempt', async () => {
    expect(await failure('condition', 'x = 1')).toBeInstanceOf(SandboxGuestError);
    expect(spies.initPythonProject).toHaveBeenCalledTimes(1);
    spies.initPythonProject.mockClear();
    await expect(python('applogic', 'x = 1')).resolves.toBeNull();
    expect(spies.initPythonProject).toHaveBeenCalledTimes(1);
  });
});

describe('zipp-host: Python failures', () => {
  it("reports guest errors as SandboxGuestError in the author's lines, without the driver", async () => {
    const err = await failure('flow', 'a = 1\nb = nodes["missing"]');
    expect(err).toBeInstanceOf(SandboxGuestError);
    const message = (err as Error).message;
    expect(message).toMatch(/^KeyError: 'missing' \(line 2\)/);
    expect(message).not.toMatch(/main\.py|formlogic\.py|logic_block\.py/);
  });

  // The instruction budget (a resource error, never a guest error) is a corpus case.
  it('reports a result too large to cross as a host error', async () => {
    const err = await failure('flow', 'result = "x" * (17 * 1024 * 1024)');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandboxGuestError);
    expect((err as Error).message).toMatch(/conversion string limit/);
  }, CASE_TIMEOUT_MS);

  it('keeps working after a failed evaluation', async () => {
    await failure('flow', 'raise ValueError("x")');
    await expect(python('flow', 'inputs["n"]')).resolves.toBe(2);
  });
});
