// @vitest-environment node
//
// Flows logic_block evaluation (zipp-host kind 'flow', used by calculateValueForFlow)
// against the REAL vendored ZIPP engine — zipp-host runEval with the checked-in wasm
// bytes, minus the Worker Vitest doesn't have (same approach as corpusParity.test.ts).
//
// Authors write logic_block code in two styles: an expression, or statements whose
// completion value is the result, and a function body with a top-level `return` (the
// editor's own placeholder). Indirect eval alone rejects the second with "'return'
// outside of a function", which failed every run of a block written like the
// placeholder. The flow kind accepts both; the form kinds ('calc', 'condition') must NOT
// change, because form logic has to match the backend guest
// (docs/contracts/formlogic-expression-corpus.json). The flow condition node also stays
// on 'condition': the desktop runner evaluates conditions as expressions.
//
// The OAIY desktop runner (not ZIPP) parses a logic_block and accepts all of these too,
// but it also returns a trailing expression when no top-level `return` fires. Here a
// block with a top-level `return` runs as a plain function body, so that trailing
// expression is ignored; the mixed-style case below pins that gap.
import { beforeAll, describe, expect, it } from 'vitest';
import { runEval, SandboxGuestError } from './zipp-host';
import { getNodeSpec } from '../../components/flows/editor/nodeCatalog';

const CASE_TIMEOUT_MS = 20_000;

const CONTEXT = {
  inputs: { from: '+61491570156', durationSeconds: 12 },
  event: null,
  app: null,
  nodes: {
    customers: [
      { id: 'r1', answers: { phone: '+61400000000', name: 'Other' } },
      { id: 'r2', answers: { phone: '+61491570156', name: 'Ada' } },
    ],
  },
  upstream: null,
  kv: { greeting: 'Hello' },
};

async function guestError(kind: 'flow' | 'calc' | 'condition', code: string): Promise<SandboxGuestError> {
  try {
    await runEval(kind, code, CONTEXT);
  } catch (err) {
    if (err instanceof SandboxGuestError) return err;
    throw err;
  }
  throw new Error(`expected ${kind} evaluation of ${JSON.stringify(code)} to throw`);
}

describe('logic_block evaluation (kind flow) — both authoring styles on the real ZIPP engine', () => {
  beforeAll(async () => {
    const warm = await runEval('calc', '1 + 1', {});
    expect(warm, 'the ZIPP WASM module failed to evaluate a trivial expression').toBe(2);
  }, CASE_TIMEOUT_MS);

  it('evaluates an expression', async () => {
    await expect(runEval('flow', 'inputs.durationSeconds > 5', CONTEXT)).resolves.toBe(true);
    await expect(runEval('flow', 'kv.greeting + ", " + nodes.customers[1].answers.name', CONTEXT)).resolves.toBe('Hello, Ada');
  });

  it('takes the completion value of multi-statement code', async () => {
    const code = 'const c = nodes.customers.find(r => r.answers.phone === inputs.from);\n({ found: !!c, name: c ? c.answers.name : null })';
    await expect(runEval('flow', code, CONTEXT)).resolves.toEqual({ found: true, name: 'Ada' });
  });

  it('runs a function body with a top-level return over the same globals', async () => {
    const code = 'if (!inputs.from) return { found: false };\nconst c = nodes.customers.find(r => r.answers.phone === inputs.from);\nreturn { found: !!c, name: c?.answers?.name, greeting: kv.greeting, email: validators.email("a@b.co") };';
    await expect(runEval('flow', code, CONTEXT)).resolves.toEqual({ found: true, name: 'Ada', greeting: 'Hello', email: true });
    await expect(runEval('flow', 'return inputs.durationSeconds > 5;', CONTEXT)).resolves.toBe(true);
  });

  it("runs the editor's own logic_block placeholder", async () => {
    const placeholder = getNodeSpec('logic_block')?.properties.find((p) => p.key === 'expr')?.placeholder;
    expect(placeholder).toMatch(/\breturn\b/);
    await expect(runEval('flow', placeholder as string, CONTEXT)).resolves.toEqual({ found: true, name: 'Ada' });
  });

  it('ignores a trailing expression once the code has a top-level return (the gap from the desktop runner)', async () => {
    // Mixed style: the return fires, so its value is the result.
    const mixed = (limit: number) => `if (inputs.durationSeconds > ${limit}) return "big";\n"small"`;
    await expect(runEval('flow', mixed(5), CONTEXT)).resolves.toBe('big');
    // No return fires: a function body falls off its end, so the value is undefined
    // and the trailing "small" is dropped. The OAIY desktop runner returns "small" for
    // the same block; the logic_block help tells authors not to mix the two styles.
    await expect(runEval('flow', mixed(100), CONTEXT)).resolves.toBeUndefined();
  });

  it('does not treat a return inside a nested function as a function body', async () => {
    // Were these misrouted to the function-body path they would evaluate to undefined.
    await expect(runEval('flow', 'nodes.customers.map(function (r) { return r.answers.name; })', CONTEXT)).resolves.toEqual(['Other', 'Ada']);
    await expect(runEval('flow', '(function () { return inputs.durationSeconds * 2; })()', CONTEXT)).resolves.toBe(24);
    await expect(runEval('flow', 'function pick(r) { return r.id; }\npick(nodes.customers[0])', CONTEXT)).resolves.toBe('r1');
  });

  it('runs the author code exactly once — deciding the style executes nothing', async () => {
    await expect(runEval('flow', 'globalThis.runs = (globalThis.runs || 0) + 1;\nglobalThis.runs', CONTEXT)).resolves.toBe(1);
    await expect(runEval('flow', 'globalThis.runs = (globalThis.runs || 0) + 1;\nreturn globalThis.runs;', CONTEXT)).resolves.toBe(1);
  });

  it('still fails a genuine syntax error, with the message that fits it', async () => {
    const plain = await guestError('flow', '1 +');
    expect(plain.message).toBe((await guestError('calc', '1 +')).message);
    // A function body with a syntax error elsewhere is still a syntax error, reported as
    // that error: never as "'return' outside of a function", which would blame the return.
    for (const code of ['const a = ;\nreturn a;', 'return 1 +']) {
      expect((await guestError('flow', code)).message).not.toMatch(/'return' outside of a function/);
    }
    expect((await guestError('flow', '"use strict";\nreturn 0123;')).message).toMatch(/legacy octal/);
  });

  it('reports a runtime SyntaxError as the error it is, not as a function body', async () => {
    const err = await guestError('flow', "const raw = 'not json';\nJSON.parse(raw)");
    expect(err.message).toBe((await guestError('calc', "const raw = 'not json';\nJSON.parse(raw)")).message);
  });

  it('leaves the form kinds (and the flow condition node, which uses condition) unchanged: a top-level return still fails there', async () => {
    const code = 'return inputs.durationSeconds > 5;';
    const calc = await guestError('calc', code);
    const condition = await guestError('condition', code);
    expect(calc.message).toMatch(/'return' outside of a function/);
    expect(condition.message).toBe(calc.message);
    await expect(runEval('calc', 'inputs.durationSeconds > 5', CONTEXT)).resolves.toBe(true);
    await expect(runEval('condition', 'inputs.durationSeconds > 5', CONTEXT)).resolves.toBe(true);
  });
});
