// @vitest-environment node
//
// The JavaScript program zipp-host hands the engine, pinned per kind. Python logic
// (formlogic-python/1) is a separate path, and adding it must leave every JavaScript
// evaluation byte for byte as it was: the form kinds must keep matching the backend guest
// (docs/contracts/formlogic-expression-corpus.json), and a stored flow must keep meaning
// what it meant. The prelude is the canonical module with its own sync and parity checks, so
// it is replaced by a marker and the snapshot stays readable.
import { afterAll, describe, expect, it, vi } from 'vitest';
import PRELUDE from './prelude.js?raw';
import { Engine } from '../../../vendor/zipp-wasm/zipp_wasm.js';
import { runEval, type EvalKind } from './zipp-host';

const CASE_TIMEOUT_MS = 20_000;
const CONTEXT = { inputs: { n: 2 }, note: 'a "quoted" </script> value' };
const RUN_APP_LOGIC = 'function run(ctx) { return { n: ctx.inputs.n }; }';

const CASES: Array<{ kind: EvalKind; source: string; value: unknown }> = [
  { kind: 'condition', source: 'inputs.n * 2', value: 4 },
  { kind: 'calc', source: 'inputs.n * 2', value: 4 },
  { kind: 'validate', source: 'inputs.n * 2', value: 4 },
  { kind: 'test', source: 'inputs.n * 2', value: 4 },
  { kind: 'syntax', source: 'inputs.n * 2', value: null },
  { kind: 'applogic', source: RUN_APP_LOGIC, value: { n: 2 } },
  { kind: 'flow', source: 'inputs.n * 2', value: 4 },
];

const initScript = vi.spyOn(Engine.prototype, 'initScript');
afterAll(() => initScript.mockRestore());

describe('zipp-host JavaScript program text', () => {
  it.each(CASES)('$kind', async ({ kind, source, value }) => {
    initScript.mockClear();
    await expect(runEval(kind, source, CONTEXT)).resolves.toEqual(value);
    expect(initScript).toHaveBeenCalledTimes(1);
    const program = initScript.mock.calls[0][0];
    expect(program.split(PRELUDE).length - 1, 'the prelude is compiled exactly once').toBe(1);
    expect(program.replace(PRELUDE, '<PRELUDE>')).toMatchSnapshot();
  }, CASE_TIMEOUT_MS);
});
