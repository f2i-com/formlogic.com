import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dataPortReadiness, dataPlanFrom, isArtifactRef, type DataPlan, type NodeOutcome } from './dataPorts';

/**
 * RUN-302/RUN-303 conformance: the TypeScript leg asserts the SHARED corpus that the PHP
 * resolver asserts. If the two ever disagree, one of these suites fails — which is the whole
 * point of keeping the cases in docs/contracts rather than in either language's tests.
 */
const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(resolve(here, '../../../../../docs/contracts/fixtures/flow-data-port-cases.json'), 'utf8')
) as {
  cases: Array<{
    name: string;
    why: string;
    plan: DataPlan;
    outcomes: Record<string, NodeOutcome>;
    node: string;
    expect: {
      verdict: string;
      inputs?: Record<string, unknown>;
      artifactInputs?: string[];
      waitingOn?: string[];
      unsatisfied?: string[];
      reason?: string;
    };
  }>;
};

describe('data port readiness (shared conformance corpus)', () => {
  it('has cases to assert', () => {
    expect(corpus.cases.length).toBeGreaterThan(10);
  });

  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      const result = dataPortReadiness(testCase.plan, testCase.outcomes, testCase.node);
      expect(result.verdict, testCase.why).toBe(testCase.expect.verdict);

      if (testCase.expect.inputs !== undefined) {
        expect(result.inputs).toEqual(testCase.expect.inputs);
      }
      if (testCase.expect.artifactInputs !== undefined) {
        expect(result.artifactInputs).toEqual(testCase.expect.artifactInputs);
      }
      if (testCase.expect.waitingOn !== undefined) {
        expect(result.waitingOn).toEqual(testCase.expect.waitingOn);
      }
      if (testCase.expect.unsatisfied !== undefined) {
        expect(result.unsatisfied).toEqual(testCase.expect.unsatisfied);
      }
      if (testCase.expect.reason !== undefined) {
        expect(result.reason).toBe(testCase.expect.reason);
      }
    });
  }
});

describe('dataPlanFrom', () => {
  it('reads only data edges, and only complete ones', () => {
    const plan = dataPlanFrom({
      edges: [
        // A control edge carries no data wiring, however it is handled.
        { kind: 'control', source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' },
        { kind: 'data', source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'text' },
        // Incomplete: no target handle means no port to fill.
        { kind: 'data', source: 'a', target: 'c', sourceHandle: 'out' },
      ],
    });
    expect(plan).toEqual({ b: { text: { node: 'a', port: 'out' } } });
  });

  it('is deterministic when a corrupt graph double-wires one port', () => {
    // Ambiguous fan-in is refused at compile; if one reaches here anyway, every runtime must
    // pick the same producer rather than depending on iteration order.
    const edges = [
      { kind: 'data', source: 'first', target: 'z', sourceHandle: 'out', targetHandle: 'in' },
      { kind: 'data', source: 'second', target: 'z', sourceHandle: 'out', targetHandle: 'in' },
    ];
    expect(dataPlanFrom({ edges })).toEqual({ z: { in: { node: 'first', port: 'out' } } });
  });

  it('produces an empty plan for a legacy graph', () => {
    expect(dataPlanFrom({ edges: [{ source: 'a', target: 'b' }] })).toEqual({});
    expect(dataPlanFrom(null)).toEqual({});
  });
});

describe('isArtifactRef', () => {
  it('recognises the handle shape and nothing else', () => {
    expect(isArtifactRef({ $artifact: 'art_abcdefghijklmnopqrstuvwx' })).toBe(true);
    for (const notRef of [null, undefined, 'art_abc', 42, [], {}, { $artifact: 'nope' }, { $artifact: 7 }]) {
      expect(isArtifactRef(notRef)).toBe(false);
    }
  });
});
