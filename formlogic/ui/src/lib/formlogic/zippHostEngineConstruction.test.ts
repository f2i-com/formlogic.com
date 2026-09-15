// @vitest-environment node
//
// A trap can also come from building the Engine itself (a panic in the engine's constructor
// surfaces as a WebAssembly "unreachable"), and it leaves the instance just as unusable as a trap
// mid-evaluation. Construction therefore sits inside the same guard on both paths: the trap is
// reported as a host error, the instance is refused from then on, and it reports itself over any
// retention budget so engine.ts replaces the Worker. The JavaScript program text is unchanged
// (zippHostProgram.test.ts pins it). Each case loads a fresh zipp-host, since a trap poisons
// the module for good.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const trap = vi.hoisted(() => ({ next: false }));

vi.mock('../../../vendor/zipp-wasm/zipp_wasm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../vendor/zipp-wasm/zipp_wasm.js')>();
  class TrappingEngine extends actual.Engine {
    constructor() {
      if (trap.next) {
        trap.next = false;
        throw new WebAssembly.RuntimeError('unreachable');
      }
      super();
    }
  }
  return { ...actual, Engine: TrappingEngine };
});

async function freshHost() {
  vi.resetModules();
  const host = await import('./zipp-host');
  const { INSTANCE_RETAINED_BUDGET_BYTES } = await import('./engine');
  return { ...host, INSTANCE_RETAINED_BUDGET_BYTES };
}

beforeEach(() => {
  trap.next = false;
});

describe('zipp-host when constructing the Engine traps', () => {
  it.each([
    ['JavaScript', { kind: 'calc' as const, source: '1 + 1', options: {} }],
    ['Python', { kind: 'flow' as const, source: '1 + 1', options: { language: 'python' as const } }],
  ])('%s: a host error, the instance refused, and a new Worker asked for', async (_name, { kind, source, options }) => {
    const { runEval, instanceUsage, SandboxGuestError, INSTANCE_RETAINED_BUDGET_BYTES } = await freshHost();
    await expect(runEval(kind, source, {}, options)).resolves.toBe(2);
    expect(instanceUsage().trapped).toBeUndefined();

    trap.next = true;
    const err = await runEval(kind, source, {}, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandboxGuestError);
    expect(err).not.toBeInstanceOf(WebAssembly.RuntimeError);
    expect((err as Error).message).toMatch(/stopped on an internal error/);

    const usage = instanceUsage();
    expect(usage.trapped).toBe(true);
    expect(usage.retainedBytes).toBeGreaterThanOrEqual(INSTANCE_RETAINED_BUDGET_BYTES);
    // Nothing more runs on it, in either language.
    await expect(runEval('calc', '1 + 1', {})).rejects.toThrow(/stopped on an internal error/);
    await expect(runEval('flow', '1', {}, { language: 'python' })).rejects.toThrow(/stopped on an internal error/);
  }, 30_000);
});

// App-logic scripts and flow nodes treat an absent, null or '' language as JavaScript, as the
// server does (CustomLogicSanitizer, FlowLogicLanguages). Any other unknown value is refused,
// never run as JavaScript.
describe('zipp-host language values', () => {
  it("runs null and '' as JavaScript and refuses other unknown names", async () => {
    const { runEval, SandboxGuestError } = await freshHost();
    await expect(runEval('flow', 'inputs.n * 2', { inputs: { n: 2 } }, { language: null as never })).resolves.toBe(4);
    await expect(runEval('flow', 'inputs.n * 2', { inputs: { n: 2 } }, { language: '' as never })).resolves.toBe(4);
    await expect(runEval('flow', 'inputs.n * 2', { inputs: { n: 2 } }, { language: undefined })).resolves.toBe(4);
    for (const unknown of ['py', 'Python', 'python3', 'ruby']) {
      const err = await runEval('flow', 'inputs.n * 2', { inputs: { n: 2 } }, { language: unknown as never }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SandboxGuestError);
      expect((err as Error).message).toBe(`Unknown logic language: ${unknown}`);
    }
  }, 30_000);
});
