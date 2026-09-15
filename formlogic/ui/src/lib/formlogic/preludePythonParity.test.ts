// @vitest-environment node
//
// The prelude helpers mean the same thing in both languages: one table of calls, run
// through prelude.js (kind 'calc', as form logic runs it) and through formlogic.py's port
// (kind 'flow', language 'python'), on the real engine, compared call by call. A helper's
// JavaScript quirks are the specification here: typeof checks that refuse booleans,
// Math.round's halves, UTF-16 lengths, array-like objects, includes()' SameValueZero.
//
// format.* is JavaScript only (it depends on number formatting Python does not share), and
// sum/count stay unexported so the star import leaves Python's sum() and list.count() alone.
import { beforeAll, describe, expect, it } from 'vitest';
import PRELUDE from './prelude.js?raw';
import { runEval } from './zipp-host';

const CASE_TIMEOUT_MS = 60_000;

/** JavaScript name -> Python name, where they differ. */
const PYTHON_NAMES: Record<string, string> = { isEmpty: 'is_empty', isNotEmpty: 'is_not_empty' };
const JAVASCRIPT_ONLY = ['format', 'sum', 'count'];

const ARRAY_LIKE_EMPTY = { length: 0 };
const ARRAY_LIKE = { length: 2, 0: 4, 1: 6 };

const TABLE: Array<[fn: string, args: unknown[]]> = [
  ['validators.email', ['a@b.co']],
  ['validators.email', ['A.B+c@x-y.io']],
  ['validators.email', ['a@b']],
  ['validators.email', ['a@b.co\n']],
  ['validators.email', [' a@b.co']],
  ['validators.email', [5]],
  ['validators.email', [null]],
  ['validators.email', []],
  ['validators.phone', ['+61 (400) 000-000']],
  ['validators.phone', ['0400 000 000']],
  ['validators.phone', ['123']],
  ['validators.phone', ['+1234567890123456']],
  ['validators.phone', ['+61-400-000-000\n']],
  ['validators.phone', [61400000000]],
  ['validators.url', ['https://example.com']],
  ['validators.url', ['http://a.bc/x y']],
  ['validators.url', ['ftp://x.com']],
  ['validators.url', ['https://x.c']],
  ['validators.url', [null]],
  ['validators.minLength', ['abc', 3]],
  ['validators.minLength', ['ab', 3]],
  ['validators.minLength', ['\u{1F600}\u{1F600}', 3]],
  ['validators.minLength', ['abc', '3']],
  ['validators.minLength', ['abc', true]],
  ['validators.minLength', [3, 1]],
  ['validators.maxLength', ['abcd', 3]],
  ['validators.maxLength', ['abc', 3]],
  ['validators.maxLength', ['\u{1F600}', 1]],
  ['validators.maxLength', ['abc']],
  ['validators.pattern', ['abc', '^a']],
  ['validators.pattern', ['abc', 'c$']],
  ['validators.pattern', ['abc', '^b']],
  ['validators.pattern', ['a1', '^[a-z]\\d$']],
  ['validators.pattern', ['abc', 5]],
  ['validators.pattern', ['x', 'x'.repeat(501)]],
  ['validators.pattern', ['abc', '(']],
  ['validators.required', [null]],
  ['validators.required', ['']],
  ['validators.required', ['  \t']],
  ['validators.required', ['x']],
  ['validators.required', [[]]],
  ['validators.required', [[0]]],
  ['validators.required', [0]],
  ['validators.required', [false]],
  ['validators.required', [{}]],
  ['validators.required', [ARRAY_LIKE_EMPTY]],
  ['validators.required', [ARRAY_LIKE]],
  ['validators.min', [5, 3]],
  ['validators.min', [3, 3]],
  ['validators.min', [2, 3]],
  ['validators.min', [true, 0]],
  ['validators.min', ['5', 3]],
  ['validators.max', [5, 3]],
  ['validators.max', [3, 3]],
  ['validators.max', [2.5, 3]],
  ['validators.max', [false, 1]],
  ['compliance.regBICheck', [25, 'Conservative']],
  ['compliance.regBICheck', [35, 'conservative']],
  ['compliance.regBICheck', [50, 'MODERATE']],
  ['compliance.regBICheck', [60, 'aggressive']],
  ['compliance.regBICheck', [80, 'speculative']],
  ['compliance.regBICheck', [50, 'unknown']],
  ['compliance.regBICheck', ['50', 'moderate']],
  ['compliance.regBICheck', [true, 'moderate']],
  ['compliance.suitabilityScore', [40, 100000, 750000, 3, 4]],
  ['compliance.suitabilityScore', [25, 250000, 1000000, 7, 20]],
  ['compliance.suitabilityScore', [90, 0, 0, 0, 0]],
  ['compliance.suitabilityScore', [33.3, 123456, 654321, 4.5, 12.5]],
  ['compliance.suitabilityScore', [40, '1', 1, 1, 1]],
  ['compliance.amlFlag', [15000, 3]],
  ['compliance.amlFlag', [9000, 4]],
  ['compliance.amlFlag', [9000, 3]],
  ['compliance.amlFlag', [100, 60]],
  ['compliance.amlFlag', [3000, 40]],
  ['compliance.amlFlag', [5000]],
  ['compliance.amlFlag', [9000, true]],
  ['compliance.amlFlag', ['x']],
  ['compliance.kycComplete', ['a', 'b']],
  ['compliance.kycComplete', ['a', null]],
  ['compliance.kycComplete', ['a', ' ']],
  ['compliance.kycComplete', []],
  ['compliance.kycComplete', [0, false]],
  ['compliance.nigoCheck', ['a', null, ' ', 'b', '']],
  ['compliance.nigoCheck', []],
  ['compliance.nigoCheck', ['x']],
  ['compliance.accreditedInvestor', [250000, 0]],
  ['compliance.accreditedInvestor', [0, 2000000]],
  ['compliance.accreditedInvestor', [200000, 1000000]],
  ['compliance.accreditedInvestor', ['x', 1]],
  ['compliance.wholesaleClient', [250000, 0]],
  ['compliance.wholesaleClient', [0, 2500000]],
  ['compliance.wholesaleClient', [100, 100]],
  ['compliance.austracFlag', [15000, 0]],
  ['compliance.austracFlag', [8500, 5]],
  ['compliance.austracFlag', [2001, 50]],
  ['compliance.austracFlag', [2001, 51]],
  ['compliance.austracFlag', [null, 99]],
  ['compliance.tfnValid', ['123-456-789']],
  ['compliance.tfnValid', ['123456789']],
  ['compliance.tfnValid', ['  123456789  ']],
  ['compliance.tfnValid', ['123 456 789']],
  ['compliance.tfnValid', ['12345678']],
  ['compliance.tfnValid', [123456789]],
  ['finance.compoundInterest', [1000, 0.05, 10]],
  ['finance.compoundInterest', [2500.5, 0.035, 7]],
  ['finance.compoundInterest', [100, 0, 5]],
  ['finance.compoundInterest', [1000, -1, 2]],
  ['finance.compoundInterest', [0.125, 0, 1]],
  ['finance.compoundInterest', ['1', 0.05, 1]],
  ['finance.aumFee', [750000]],
  ['finance.aumFee', [1000000]],
  ['finance.aumFee', [3000000]],
  ['finance.aumFee', [12000000]],
  ['finance.aumFee', [0]],
  ['finance.aumFee', [-5]],
  ['finance.aumFee', ['x']],
  ['finance.riskScore', [40, 20, 7]],
  ['finance.riskScore', [25.5, 10, 3]],
  ['finance.riskScore', [99, 0, 0]],
  ['finance.riskScore', [30, 'x', 1]],
  ['finance.portfolioAllocation', [1]],
  ['finance.portfolioAllocation', [50]],
  ['finance.portfolioAllocation', [100]],
  ['finance.portfolioAllocation', [72.5]],
  ['finance.portfolioAllocation', [150]],
  ['finance.portfolioAllocation', [-3]],
  ['finance.portfolioAllocation', ['x']],
  ['finance.transferFee', [400, 'schwab']],
  ['finance.transferFee', [1000, 'Schwab']],
  ['finance.transferFee', [1000, 'Fidelity']],
  ['finance.transferFee', [1000, 'vanguard']],
  ['finance.transferFee', [1000, 'other']],
  ['finance.transferFee', [1000, null]],
  ['finance.transferFee', [1000]],
  ['finance.transferFee', ['x', 'schwab']],
  ['finance.auAumFee', [400000]],
  ['finance.auAumFee', [1500000]],
  ['finance.auAumFee', [6000000]],
  ['finance.auAumFee', [0]],
  ['finance.auTransferFee', [1000, 'HUB24']],
  ['finance.auTransferFee', [1000, 'BT Panorama']],
  ['finance.auTransferFee', [1000, 'macquarie']],
  ['finance.auTransferFee', [1000, 'other']],
  ['finance.auTransferFee', [1000, null]],
  ['safety.riskMatrix', [3, 4]],
  ['safety.riskMatrix', [2.5, 3]],
  ['safety.riskMatrix', [0, 9]],
  ['safety.riskMatrix', [5.4, 1.5]],
  ['safety.riskMatrix', ['3', 4]],
  ['safety.riskLevel', [25]],
  ['safety.riskLevel', [12]],
  ['safety.riskLevel', [19.99]],
  ['safety.riskLevel', [5]],
  ['safety.riskLevel', [1]],
  ['safety.riskLevel', [0]],
  ['safety.riskLevel', ['x']],
  ['safety.controlEffectiveness', ['Elimination']],
  ['safety.controlEffectiveness', ['ppe']],
  ['safety.controlEffectiveness', ['other']],
  ['safety.controlEffectiveness', [3]],
  ['safety.residualRisk', [20, 'engineering']],
  ['safety.residualRisk', [12, 'PPE']],
  ['safety.residualRisk', [7.5, 'administrative']],
  ['safety.residualRisk', [2.5, 'none']],
  ['safety.residualRisk', ['x', 'ppe']],
  ['isEmpty', [null]],
  ['isEmpty', ['']],
  ['isEmpty', ['  ']],
  ['isEmpty', [' ﻿']],
  ['isEmpty', ['x']],
  ['isEmpty', [[]]],
  ['isEmpty', [[0]]],
  ['isEmpty', [0]],
  ['isEmpty', [false]],
  ['isEmpty', [{}]],
  ['isEmpty', [ARRAY_LIKE_EMPTY]],
  ['isEmpty', [ARRAY_LIKE]],
  ['isNotEmpty', [null]],
  ['isNotEmpty', ['x']],
  ['isNotEmpty', [[]]],
  ['contains', [[1, 2], 2]],
  ['contains', [[1], true]],
  ['contains', [[true], 1]],
  ['contains', [['a'], 'a']],
  ['contains', [[1], '1']],
  ['contains', [[1.5], 1.5]],
  ['contains', [[null], null]],
  ['contains', [[[1]], [1]]],
  ['contains', ['abc', 'a']],
  ['contains', [null, 1]],
  ['contains', [ARRAY_LIKE, 4]],
  ['avg', [[1, 2, 3]]],
  ['avg', [[1, true, 3]]],
  ['avg', [['1', 2]]],
  ['avg', [[1.5, 2.5]]],
  ['avg', [['a']]],
  ['avg', [[]]],
  ['avg', ['x']],
  ['avg', [ARRAY_LIKE]],
];

const CASES = TABLE.map(([fn, args]) => ({ fn, py: PYTHON_NAMES[fn] ?? fn, args }));

// Each call is caught on its own, so one refusal cannot hide the rest; a refusal compares
// as {ok: false} whatever the error says in either language.
const JAVASCRIPT = `inputs.cases.map(function (c) {
  var path = c.fn.split(".");
  var fn = globalThis[path[0]];
  if (path.length > 1) fn = fn[path[1]];
  try { return { ok: true, value: fn.apply(null, c.args) }; } catch (e) { return { ok: false }; }
})`;
const PYTHON = `helpers = {"validators": validators, "compliance": compliance, "finance": finance, "safety": safety,
           "is_empty": is_empty, "is_not_empty": is_not_empty, "contains": contains, "avg": avg}
result = []
for case in inputs["cases"]:
    path = case["py"].split(".")
    fn = helpers[path[0]]
    if len(path) > 1:
        fn = getattr(fn, path[1])
    try:
        result.append({"ok": True, "value": fn(*case["args"])})
    except Exception:
        result.append({"ok": False})`;

type Outcome = { ok: boolean; value?: unknown };
let javascript: Outcome[] = [];
let python: Outcome[] = [];

/** JSON of an outcome: -0 and 0 are one number once either value leaves its engine. */
const encode = (outcome: Outcome | undefined) => JSON.stringify(outcome);

describe('prelude helpers: prelude.js (calc) and formlogic.py (flow, python) agree', () => {
  beforeAll(async () => {
    const context = { inputs: { cases: CASES } };
    javascript = (await runEval('calc', JAVASCRIPT, context)) as Outcome[];
    python = (await runEval('flow', PYTHON, context, { language: 'python' })) as Outcome[];
  }, CASE_TIMEOUT_MS);

  it('the table exercises every prelude helper Python has', async () => {
    // A helper added to prelude.js must be ported (and tabled) or named JavaScript-only here.
    const declared = [...PRELUDE.matchAll(/^(?:var (\w+) =|function (\w+)\()/gm)]
      .map((match) => match[1] ?? match[2])
      .filter((name) => !name.startsWith('__') && !JAVASCRIPT_ONLY.includes(name));
    expect(declared.sort()).toEqual(['avg', 'compliance', 'contains', 'finance', 'isEmpty', 'isNotEmpty', 'safety', 'validators']);
    const helpers = (await runEval('calc', `["validators", "compliance", "finance", "safety"]
      .map(function (ns) { return Object.keys(globalThis[ns]).map(function (k) { return ns + "." + k; }); })
      .reduce(function (a, b) { return a.concat(b); }, [])
      .concat(["isEmpty", "isNotEmpty", "contains", "avg"])`, {})) as string[];
    expect(new Set(TABLE.map(([fn]) => fn))).toEqual(new Set(helpers));
  });

  it('formlogic.py exports the context names, print and the helpers, and nothing JavaScript-only', async () => {
    const exported = (await runEval('flow', 'import formlogic\nresult = formlogic.__all__', {}, { language: 'python' })) as string[];
    expect(exported).toEqual([
      'inputs', 'event', 'app', 'nodes', 'upstream', 'kv', 'print',
      'validators', 'compliance', 'finance', 'safety',
      'is_empty', 'is_not_empty', 'contains', 'avg',
    ]);
    for (const name of JAVASCRIPT_ONLY) expect(exported).not.toContain(name);
  });

  it('both languages answered every call, with values rather than refusals', () => {
    expect(javascript).toHaveLength(CASES.length);
    expect(python).toHaveLength(CASES.length);
    // prelude.js refuses exactly these two (a bad pattern, an array-like with no includes()),
    // so a harness that failed every call cannot pass by agreeing with itself.
    const refused = CASES.filter((_c, index) => !javascript[index]?.ok).map((c) => `${c.fn}(${JSON.stringify(c.args)})`);
    expect(refused).toEqual(['validators.pattern(["abc","("])', 'contains([{"0":4,"1":6,"length":2},4])']);
  });

  it('the answers that tell the two languages apart are the JavaScript ones', () => {
    const answer = (fn: string, args: unknown[]) => python[CASES.findIndex((c) => c.fn === fn && JSON.stringify(c.args) === JSON.stringify(args))]?.value;
    expect(answer('safety.riskMatrix', [2.5, 3])).toBe(9); // Math.round(2.5) is 3; round(2.5) is 2
    expect(answer('safety.residualRisk', [2.5, 'none'])).toBe(3);
    expect(answer('validators.min', [true, 0])).toBe(false); // a bool is not a number
    expect(answer('avg', [[1, true, 3]])).toBe(2);
    expect(answer('contains', [[1], true])).toBe(false); // SameValueZero
    expect(answer('contains', [[[1]], [1]])).toBe(false);
    expect(answer('validators.minLength', ['\u{1F600}\u{1F600}', 3])).toBe(true); // UTF-16 length 4
    expect(answer('validators.email', ['a@b.co\n'])).toBe(false);
    expect(answer('isEmpty', [ARRAY_LIKE_EMPTY])).toBe(true);
    expect(answer('avg', [ARRAY_LIKE])).toBe(5);
    expect(answer('finance.compoundInterest', [1000, 0.05, 10])).toBe(1628.89);
    expect(answer('finance.portfolioAllocation', [72.5])).toBe('71:20:9');
  });

  it.each(CASES.map((c, index) => ({ ...c, index, label: `${c.fn}(${JSON.stringify(c.args).slice(1, -1)})` })))(
    '$label',
    ({ index }) => {
      expect(encode(python[index])).toBe(encode(javascript[index]));
    }
  );
});
