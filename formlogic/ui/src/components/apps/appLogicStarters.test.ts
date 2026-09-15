// @vitest-environment node
//
// The App logic editor's starters on the REAL installed ZIPP engine (zipp-host runEval, minus
// the Worker Vitest doesn't have): every JavaScript starter and its Python twin
// (formlogic-python/1) return the same result for the editor's Test-run ctx, so an author who
// starts in either language starts from the same working script.
import { beforeAll, describe, expect, it } from 'vitest';
import { runEval } from '../../lib/formlogic/zipp-host';
import { BLANK_SOURCES, SAMPLE_CTX, STARTERS } from './appLogicStarters';
import type { CustomAppLogicHookName } from '../../types/customAppLogic';

const CASE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await runEval('calc', '1 + 1', {});
}, CASE_TIMEOUT_MS);

const HOOKS = Object.keys(STARTERS.javascript) as CustomAppLogicHookName[];

describe('App logic starters (JavaScript and Python)', () => {
  it('cover the same hooks in both languages', () => {
    expect(Object.keys(STARTERS.python).sort()).toEqual([...HOOKS].sort());
  });

  it.each(HOOKS)('%s: the Python starter returns what the JavaScript one does', async (hook) => {
    const ctx = { hook, ...SAMPLE_CTX, storage: {} };
    const js = await runEval('applogic', STARTERS.javascript[hook], ctx);
    const python = await runEval('applogic', STARTERS.python[hook], ctx, { language: 'python' });
    expect(js).toBeTypeOf('object');
    expect(python).toEqual(js);
  }, CASE_TIMEOUT_MS);

  // A form field holds whatever the member typed. JavaScript's Number('abc') is NaN, NaN < 15 is
  // false, so the JavaScript starter lets the submission through; Python's float('abc') raises,
  // which would turn a stray letter into a script error. The twins agree on every value.
  it.each<[unknown, string]>([
    ['', 'blank'], ['abc', 'not a number'], ['12', 'low, as text'], ['40', 'fine, as text'], [null, 'null'],
    [true, 'a boolean'], [[], 'a list'], [{ litres: 3 }, 'an object'], [8, 'low'], [60, 'fine'],
  ])('onBeforeSubmit agrees with JavaScript for fuel_percent %j (%s)', async (fuel) => {
    const ctx = { hook: 'onBeforeSubmit', ...SAMPLE_CTX, answers: { ...SAMPLE_CTX.answers, fuel_percent: fuel }, storage: {} };
    const js = await runEval('applogic', STARTERS.javascript.onBeforeSubmit, ctx);
    const python = await runEval('applogic', STARTERS.python.onBeforeSubmit, ctx, { language: 'python' });
    expect(python).toEqual(js);
  }, CASE_TIMEOUT_MS);

  it('the blank scripts compile and run in their language', async () => {
    const ctx = { hook: 'onAppStart', ...SAMPLE_CTX, storage: {} };
    await expect(runEval('applogic', BLANK_SOURCES.javascript, ctx)).resolves.toBeUndefined();
    await expect(runEval('applogic', BLANK_SOURCES.python, ctx, { language: 'python' })).resolves.toEqual({});
  }, CASE_TIMEOUT_MS);
});
