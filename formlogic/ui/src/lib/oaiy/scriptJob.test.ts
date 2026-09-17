// @vitest-environment node
//
// The Python job FormLogic asks a consumer to run, held to OAIY's request schema
// (oaiy.com protocol/v1/script-request.schema.json, `$defs/pythonJob`).
//
// The schema's `if/then/else` is the whole reason this shape is narrow: a job that names `modes`
// REQUIRES `source` and forbids `files`, `entry`, `call` and `fallbackOnSourceError`, because two
// ways to build one project is an ambiguity the runner refuses rather than resolves. A request
// with ANY malformed job is refused WHOLE and nothing in it runs - so one stray key here costs
// every other job in the batch, and that is what these tests guard.
import { describe, expect, it } from 'vitest';
import { BLOCK_WRAPPERS, modesFor } from '../formlogic/python/pythonContract';
import { PYTHON_JOB_KEYS, pythonModeJob } from './scriptJob';

const CTX = { inputs: { n: 2 }, nodes: {}, kv: {} };

describe('pythonModeJob', () => {
  it('carries exactly the keys a mode job may carry, and none of the four it may not', () => {
    const job = pythonModeJob('node-7', 'flow', 'inputs["n"]', CTX);
    expect(Object.keys(job)).toEqual([...PYTHON_JOB_KEYS]);
    for (const refused of ['files', 'entry', 'call', 'fallbackOnSourceError']) {
      expect(refused in job, `${refused} beside modes refuses the whole request`).toBe(false);
    }
    expect(job).toEqual({
      id: 'node-7',
      language: 'python',
      mode: 'python-project',
      modes: ['flowExpression', 'flowModule'],
      source: 'inputs["n"]',
      args: [CTX],
    });
  });

  it('names the modes the browser host would try, in the order it would try them', () => {
    // Not a second opinion about the chain: the same modesFor the host calls, so a job and a
    // browser evaluation of the same block attempt the same wrappings in the same order.
    for (const [kind, source] of [
      ['flow', 'inputs["n"]'],
      ['flow', '# only a comment\n\n'],
      ['flow', ''],
      ['condition', 'inputs["n"] > 1'],
      ['applogic', 'def run(ctx):\n    return 1'],
      ['syntax', 'x = 1'],
    ] as const) {
      expect(pythonModeJob('j', kind, source, CTX).modes, `${kind}: ${JSON.stringify(source)}`).toEqual(
        [...modesFor(kind, source)],
      );
    }
  });

  it('every mode it names is a mode the profile defines', () => {
    // A job naming a mode the profile does not define refuses the whole request.
    const defined = new Set(Object.keys(BLOCK_WRAPPERS));
    for (const kind of ['flow', 'condition', 'applogic', 'syntax'] as const) {
      for (const mode of pythonModeJob('j', kind, 'x = 1', CTX).modes) expect(defined.has(mode), mode).toBe(true);
    }
  });

  it('passes the context as the entry function\'s one argument, and nothing to the syntax call', () => {
    // `syntax`'s mode overrides the call with the one its own entry defines, which takes no
    // argument (it runs nothing); every other mode answers __formlogic_run__(ctx).
    expect(pythonModeJob('j', 'syntax', 'x = 1', CTX).args).toEqual([]);
    expect(pythonModeJob('j', 'condition', 'x', CTX).args).toEqual([CTX]);
  });

  it('sends the same JSON view of the context the browser host parses in the guest', () => {
    // A Date becomes its string and an undefined member drops out, here as in zipp-host, so both
    // languages and both hosts see the same values - and `args` crosses as JSON either way.
    const job = pythonModeJob('j', 'flow', 'x', { when: new Date('2026-09-17T00:00:00.000Z'), gone: undefined, n: 1 });
    expect(job.args).toEqual([{ when: '2026-09-17T00:00:00.000Z', n: 1 }]);
    // A copy, not the caller's object: a job is data that has already left.
    const context = { n: 1 };
    const held = pythonModeJob('j', 'flow', 'x', context).args[0] as { n: number };
    context.n = 2;
    expect(held.n).toBe(1);
  });

  it('refuses a job the consumer would refuse, here rather than there', () => {
    // An id outside the schema's 1..128, or a kind with no Python contract: the whole request
    // would be refused on arrival, with every other job in it.
    expect(() => pythonModeJob('', 'flow', 'x', CTX)).toThrow(/id/);
    expect(() => pythonModeJob('j'.repeat(129), 'flow', 'x', CTX)).toThrow(/id/);
    expect(() => pythonModeJob('j', 'calc' as never, 'x', CTX)).toThrow(/calc/);
  });
});
