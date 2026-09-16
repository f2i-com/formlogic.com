// @vitest-environment node
//
// The served profile, run the way a consumer runs it - and held to the same author line numbers
// the browser host answers with.
//
// WHAT THIS IS. `docs/contracts/formlogic-python-logic-corpus.json` states what FormLogic's
// Python means, including where an error happened: `KeyError: 'missing' (line 1)`, a syntax error
// at `(line 2, col N)`, and a traceback with no driver filename in it. pythonLogicCorpus.test.ts
// proves the BROWSER host answers that. This proves the other path does too: the document at
// backend/resources/formlogic-script-profile.json, unfolded by a runner that has never heard of
// FormLogic, on the same engine, over the same corpus cases - and then run through FormLogic's own
// authorMessage, which is all a consumer has to add.
//
// WHAT IS REAL HERE AND WHAT IS NOT. Real: the served bytes (read from the artifact, not from
// pythonContract.ts - a wrong `lineOffset` in the document fails this file), the installed ZIPP
// engine, the job src/lib/oaiy/scriptJob.ts builds, the corpus, and authorMessage. NOT real: the
// runner. OAIY's `runPythonModes`/`mapAuthorLines` live in another repository and no release
// carries them yet, so `mirrorRunner` below is a PORT of them, written from the schema's own
// description of `lineOffset` and `modes` (protocol/v1/script-profile.schema.json,
// script-request.schema.json, vendored beside this file). A port can agree with a wrong reading
// of the spec; it cannot catch a runner that does something the spec does not say.
//
// HOW FAITHFUL THE PORT IS, MEASURED ONCE. On 2026-09-17 the real `runScriptRequest` from
// oaiy.com 903e0a10 was bundled OUT OF TREE (read-only, into a scratchpad) and run over this
// same served document on this same installed engine: for all twelve cases below it produced
// BYTE-IDENTICAL results to the port here, before FormLogic's own presentation pass. That is a
// measurement of one revision at one moment, not a gate - nothing in this repository re-runs it.
//
// WHAT WOULD MAKE IT REAL. A parity job that runs the same corpus through `oaiy script` with this
// profile and compares the two artifacts, as the Softn value-corpus job already does for ZIPP.
// That is blocked on an OAIY release carrying the mode-aware runner; until then this file is the
// closest FormLogic can get from inside its own repository, and says so.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../../../vendor/zipp-wasm/zipp_wasm.js';
import { SandboxGuestError, engineLanguages, runEval, warmUp, type EvalKind } from '../formlogic/zipp-host';
import { authorMessage } from '../formlogic/python/pythonContract';
import { pythonModeJob, type PythonModeJob } from './scriptJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const CASE_TIMEOUT_MS = 60_000;

interface ProfileMode {
  name: string;
  files: Record<string, string>;
  block: string;
  before: string;
  after: string;
  lineOffset: number;
  call?: string;
}
interface Profile {
  instructionSteps: number;
  python: { contract: string; files: Record<string, string>; entry: string; call: string; modes: ProfileMode[] };
}
interface CorpusCase {
  id: string;
  kind: string;
  source: string;
  context: Record<string, unknown>;
  expect: { ok: true; value: unknown } | { threw: string } | { resource: string };
}

const PROFILE: Profile = JSON.parse(
  readFileSync(join(REPO_ROOT, 'formlogic', 'backend', 'resources', 'formlogic-script-profile.json'), 'utf8'),
) as Profile;
const CORPUS: { cases: CorpusCase[] } = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs', 'contracts', 'formlogic-python-logic-corpus.json'), 'utf8'),
) as { cases: CorpusCase[] };

/**
 * Every corpus case whose expectation is about WHERE the error is - the ones the whole widening
 * exists for. A value case would prove nothing here: the runner's own output sanitiser is not
 * FormLogic's and softn.com already holds the value corpus.
 */
const LINE_CASES = [
  'flow-syntax-error-author-line',
  'flow-runtime-error-author-line',
  'flow-expression-runtime-error-author-line',
  'flow-raise-author-line',
  'flow-no-driver-frames',
  'flow-await-unsupported',
  'flow-top-level-return',
  'condition-statement-refused',
  'condition-runtime-error-author-line',
  'condition-multiline-error-reports-first-line',
  'applogic-runtime-error-author-line',
  'syntax-error',
];

const caseById = (id: string): CorpusCase => {
  const found = CORPUS.cases.find((c) => c.id === id);
  if (!found) throw new Error(`the corpus has no case ${JSON.stringify(id)} - it was renamed or removed`);
  return found;
};

// ---------------------------------------------------------------------------
// The mirror: what a mode-aware runner does, and nothing FormLogic-specific.
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `script-profile.schema.json` `$defs/pythonMode.lineOffset`, implemented from its words:
 *
 *   "Engine line N in `block` is author line N - lineOffset, capped at the author's last line.
 *    Where `before` ends in a newline, N == lineOffset is author line 1 as well, because Python
 *    reports a multi-line statement at the line that opens it. Any line above that is left
 *    exactly as the engine wrote it... Columns are never adjusted... and a character offset in a
 *    `(at offset K)` location is rebased by the UTF-16 length of `before`."
 *
 * Nothing here knows what a mode MEANS: `name` is a lookup key, the block keeps its file name,
 * and no frame is dropped or reworded. That is the requester's pass, not the runner's.
 */
function mirrorMapAuthorLines(text: string, mode: ProfileMode, source: string): string {
  const block = escapeRegExp(mode.block);
  const authorLines = Math.max(1, source.split(/\r\n|\r|\n/).length);
  const splice = mode.before.endsWith('\n') ? mode.lineOffset : mode.lineOffset + 1;
  const line = (engineLine: number): number | null =>
    engineLine < splice ? null : Math.min(authorLines, Math.max(1, engineLine - mode.lineOffset));
  return text
    .replace(new RegExp(`(^|\\n)(${block}: .*?) \\(at offset (\\d+)\\)`, 'g'), (whole, lead: string, head: string, k: string) => {
      const at = Number(k) - mode.before.length;
      return at < 0 ? whole : `${lead}${head} (at offset ${Math.min(source.length, at)})`;
    })
    .replace(new RegExp(`File "${block}", line (\\d+)`, 'g'), (whole, n: string) => {
      const at = line(Number(n));
      return at === null ? whole : `File "${mode.block}", line ${at}`;
    })
    .replace(new RegExp(`${block}:(\\d+)(?::(\\d+))?`, 'g'), (whole, n: string, col?: string) => {
      const at = line(Number(n));
      return at === null ? whole : `${mode.block}:${at}${col ? `:${col}` : ''}`;
    });
}

type MirrorResult = { ok: true; value: unknown } | { ok: false; errorKind: string; error: string };

/**
 * One job, unfolded from the profile and run: for each named mode, in order, the project is the
 * contract's files, the mode's files over them, and `before` + the job's source + `after` in the
 * mode's block file. The next mode is tried ONLY when the engine said `source` while the project
 * was initialising - its own words for "nothing of yours ran". The failure reported is the LAST
 * attempt's, with THAT mode's lineOffset applied.
 */
function mirrorRunner(job: PythonModeJob, profile: Profile): MirrorResult {
  const contract = profile.python;
  let last: { result: Extract<MirrorResult, { ok: false }>; phase: string; mode: ProfileMode } | undefined;
  for (const name of job.modes) {
    const mode = contract.modes.find((m) => m.name === name);
    if (!mode) throw new Error(`the profile defines no mode named ${JSON.stringify(name)}: a consumer refuses the whole request`);
    const files = { ...contract.files, ...mode.files, [mode.block]: mode.before + job.source + mode.after };
    const engine = new Engine();
    let phase: 'init' | 'run' = 'init';
    try {
      engine.setInstructionBudget(profile.instructionSteps);
      engine.initPythonProject(files, contract.entry, []);
      phase = 'run';
      engine.renewInstructionBudget?.();
      return { ok: true, value: engine.pythonCall(mode.call ?? contract.call, JSON.parse(JSON.stringify(job.args)) as unknown[]) };
    } catch (err) {
      let kind = 'host';
      try {
        kind = engine.lastErrorKind();
      } catch {
        // nothing to classify with
      }
      const error = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      last = { result: { ok: false, errorKind: kind, error }, phase, mode };
      if (!(phase === 'init' && kind === 'source')) break;
    } finally {
      try {
        engine.dispose();
      } catch {
        // a source or resource failure has already torn it down
      }
    }
  }
  const { result, mode } = last!;
  return { ...result, error: mirrorMapAuthorLines(result.error, mode, job.source) };
}

/** What a consumer would SHOW: the runner's answer, through FormLogic's own presentation pass. */
function throughTheProfile(kind: string, source: string, context: unknown): MirrorResult {
  const out = mirrorRunner(pythonModeJob(`corpus-${kind}`, kind as never, source, context), PROFILE);
  return out.ok ? out : { ...out, error: authorMessage(out.error, source) };
}

/** What the browser host answers for the same case. */
async function throughTheHost(kind: string, source: string, context: unknown): Promise<MirrorResult> {
  try {
    return { ok: true, value: await runEval(kind as EvalKind, source, (context ?? {}) as Record<string, unknown>, { language: 'python' }) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, errorKind: err instanceof SandboxGuestError ? 'guest' : 'host', error };
  }
}

describe('the served profile, unfolded by a mirror of the mode-aware runner', () => {
  beforeAll(async () => {
    await warmUp();
    expect(await engineLanguages(), 'this ZIPP build cannot run Python logic').toContain('python');
  }, CASE_TIMEOUT_MS);

  it('the profile defines every mode a FormLogic job names', () => {
    // A job naming a mode the profile does not define refuses the WHOLE request, every other job
    // in it included. The two are generated from one source; this is the assertion that says so.
    const defined = new Set(PROFILE.python.modes.map((mode) => mode.name));
    for (const kind of ['flow', 'condition', 'applogic', 'syntax'] as const) {
      for (const source of ['inputs["n"]', 'a = 1\nresult = a', '']) {
        for (const name of pythonModeJob('j', kind, source, {}).modes) expect(defined.has(name), `${kind}: ${name}`).toBe(true);
      }
    }
  });

  for (const id of LINE_CASES) {
    const corpusCase = caseById(id);
    const expectation = corpusCase.expect;
    it(`${id}: both paths answer the author's own line`, async () => {
      expect('threw' in expectation, `${id} must be an error case`).toBe(true);
      const pattern = new RegExp((expectation as { threw: string }).threw);

      const viaProfile = throughTheProfile(corpusCase.kind, corpusCase.source, corpusCase.context ?? {});
      expect(viaProfile.ok, `${id} through the profile: expected a failure, got a value`).toBe(false);
      const fromProfile = (viaProfile as Extract<MirrorResult, { ok: false }>).error;

      const viaHost = await throughTheHost(corpusCase.kind, corpusCase.source, corpusCase.context ?? {});
      expect(viaHost.ok, `${id} through the browser host: expected a failure, got a value`).toBe(false);
      const fromHost = (viaHost as Extract<MirrorResult, { ok: false }>).error;

      // The corpus is the contract: BOTH paths must satisfy it...
      expect(fromProfile, `${id} through the profile`).toMatch(pattern);
      expect(fromHost, `${id} through the browser host`).toMatch(pattern);
      // ...and they must not merely both satisfy it, they must say the same thing.
      expect(fromProfile, `${id}: the two paths disagree`).toBe(fromHost);
    }, CASE_TIMEOUT_MS);
  }

  it('reports a location inside the wrapper as the wrapper\'s, never as the author\'s line 1', () => {
    // The tier the corpus cannot reach, because no author input puts an error on the wrapper's
    // own lines. A runner that clamped instead of leaving it alone would blame the author's first
    // line for `from formlogic import *`; FormLogic then renames the file away, so `line 2` here
    // is a wrapper line reported as itself, not an author line.
    const expression = PROFILE.python.modes.find((mode) => mode.name === 'flowExpression')!;
    expect(mirrorMapAuthorLines('ImportError: x (logic_block.py:2)', expression, 'a\nb')).toBe('ImportError: x (logic_block.py:2)');
    expect(mirrorMapAuthorLines('KeyError (logic_block.py:3)', expression, 'a\nb')).toBe('KeyError (logic_block.py:1)');
  });

  it('an empty flow block is None because the JOB names one mode, not because a phase failed', async () => {
    // Why modesFor asks whether the block has code. Through flowExpression an empty block is
    // `return (\n\n    )` - a valid empty TUPLE, not a compile failure - so a chain that always
    // began there would answer [] and never reach the module phase. Measured, not assumed:
    const bothPhases: PythonModeJob = { ...pythonModeJob('j', 'flow', '', {}), modes: ['flowExpression', 'flowModule'] };
    const wrong = mirrorRunner(bothPhases, PROFILE);
    expect(wrong.ok && wrong.value, 'an empty block through flowExpression is an empty tuple').toEqual([]);

    const job = pythonModeJob('j', 'flow', '', {});
    expect(job.modes, 'so the job names the module phase alone').toEqual(['flowModule']);
    const right = mirrorRunner(job, PROFILE);
    expect(right.ok && right.value).toBe(null);
    expect(await runEval('flow', '', {}, { language: 'python' }), 'and the browser host agrees').toBe(null);
  }, CASE_TIMEOUT_MS);

  it('a syntax job through a runner RUNS the block, which the browser host does not - the one divergence', async () => {
    // Measured on the installed engine, and reported rather than papered over. FormLogic's host
    // initialises the syntax project and calls NOTHING: compiling the block is the whole check.
    // A runner has no such rule - it calls `mode.call ?? python.call` for every mode - and the
    // syntax entry's `__formlogic_never__` is `import logic_block`, which executes the block's
    // top level. A block that only compiles (every corpus syntax case) cannot tell the two
    // apart; a block with a side effect can.
    const source = 'raise ValueError("the block ran")';
    const viaHost = await throughTheHost('syntax', source, {});
    expect(viaHost.ok && viaHost.value, 'the browser host compiles and runs nothing').toBe(null);

    const viaProfile = throughTheProfile('syntax', source, {});
    expect(viaProfile.ok, 'a runner calling the mode\'s call executes the block').toBe(false);
    expect((viaProfile as Extract<MirrorResult, { ok: false }>).error).toMatch(/ValueError: the block ran \(line 1\)/);
    // The line is still the author's, which is what this file is about: the divergence is WHETHER
    // the block runs, not where the error is reported.
  }, CASE_TIMEOUT_MS);
});
