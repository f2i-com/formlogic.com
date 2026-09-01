// @vitest-environment node
//
// BROWSER leg of the cross-engine expression parity harness.
//
// FormLogic runs untrusted author-written JavaScript in three separate sandboxes
// (the PHP backend's qjs child process, this browser QuickJS-WASM VM, and the
// desktop flow runner). The product's central correctness claim is that one
// expression means one thing in all three. This file asserts that claim for the
// browser, against the shared corpus at
// docs/contracts/formlogic-expression-corpus.json.
//
// Why it has to be a REAL-engine test: every consumer of the browser engine
// swallows failure. engine.ts's calculateValue() degrades a broken expression to
// null on purpose, and the server mirror (ResponseService.php, "Fail OPEN to
// visible") turns a dead engine into a fully-visible, fully-submittable form. A
// regression here produces no error, no log line and no other failing test in
// the repo — only a value comparison catches it.
//
// Three design points, each of which a naive harness gets wrong:
//
//  1. THREE outcomes, never two. `ok`, `threw` (the guest raised — a legitimate,
//     assertable result) and `harness-failed` (the engine never ran the program:
//     wasm unavailable, interrupt budget hit, resource cap). `harness-failed` is
//     ALWAYS a test failure, including on `agree` cases; conflating it with
//     "empty" or with a guest throw is exactly how a broken engine certifies
//     itself green.
//
//  2. Comparison is by CANONICAL JSON encoding, and the encoder is deliberately
//     finer-grained than JSON.stringify. sanitizeOut() in zipp-host.ts passes
//     numbers through untouched, so this engine can return NaN/Infinity where the
//     PHP harness — which serialises its reply with JSON.stringify inside the
//     guest — records null. Comparing with JSON.stringify would encode NaN as
//     `null` and match a pinned `null`, hiding a real divergence. Non-finite
//     numbers, -0 and `undefined` therefore get distinct tokens.
//
//  3. The wasm module is instantiated ONCE. zipp-host memoises it in
//     `modulePromise`, so a single warm-up in beforeAll is all that is needed;
//     each case still gets a fresh runtime + context, exactly as production does.
//
// Every `agree` case (error text, locale output, host timezone — things no engine
// may be declared the winner of) is RECORDED to a machine-readable artifact
// rather than asserted, so a cross-engine differ can compare the runs. The
// artifact shape below is the shared contract: the PHP and Rust legs emit the
// same document with a different `engine` value, and the `canonical` string is
// the language-independent thing that gets diffed.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEval, SandboxGuestError, type EvalKind } from './zipp-host';

// ── Shared corpus contract ───────────────────────────────────────────────────

type CorpusExpectation = { ok: true; value: unknown } | { ok: false } | { agree: true };

interface CorpusCase {
  id: string;
  kind: string;
  source: string;
  expression: string;
  context: Record<string, unknown>;
  expect: CorpusExpectation;
}

interface Corpus {
  version: number;
  cases: CorpusCase[];
}

/**
 * Corpus `kind` -> browser EvalKind.
 *
 * `expression` maps to 'calc' for a verified reason, not an arbitrary one:
 * buildProgram() in zipp-host.ts special-cases only 'syntax' and 'applogic';
 * 'condition' | 'calc' | 'validate' | 'test' all fall through to the identical
 * `${PRELUDE}\n${BOOTSTRAP}\n${expression}` program, so the choice among those
 * four cannot affect a result. ('syntax' IS different — parse-only, no context
 * injected, no backend or desktop counterpart — which is why the corpus has no
 * syntax-kind cases and this map has no entry that would silently accept one.)
 */
const EVAL_KIND_BY_CORPUS_KIND: Record<string, EvalKind> = {
  expression: 'calc',
  applogic: 'applogic',
};

// Matches the budget the corpus expectations were captured under
// (build-expression-corpus.php passes 15000ms to evaluateBatch), so a case that
// is merely slow is never misreported as a semantic difference.
const EVAL_BUDGET_MS = 15_000;
// Must exceed EVAL_BUDGET_MS, or vitest kills the case before the engine's own
// interrupt fires and a budget overrun is misreported as a test timeout.
const CASE_TIMEOUT_MS = 20_000;

const HERE = dirname(fileURLToPath(import.meta.url));
// src/lib/formlogic -> src/lib -> src -> ui -> formlogic -> <repo root>
const REPO_ROOT = resolve(HERE, '../../../../..');
const CORPUS_PATH =
  process.env.FORMLOGIC_PARITY_CORPUS ??
  join(REPO_ROOT, 'docs', 'contracts', 'formlogic-expression-corpus.json');
const ARTIFACT_PATH =
  process.env.FORMLOGIC_PARITY_OUT ??
  join(REPO_ROOT, 'test-results', 'parity', 'browser.json');

// ── Canonical encoding (design point 2) ──────────────────────────────────────

/**
 * Deterministic, information-preserving encoding used for BOTH sides of every
 * comparison and for the artifact's `canonical` field. Object keys are sorted so
 * key order — which QuickJS, PHP and serde each choose independently — can never
 * masquerade as a divergence. Values JSON cannot represent get explicit tokens so
 * they can never silently collapse into `null`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '"@undefined"';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    const n = value as number;
    if (Number.isNaN(n)) return '"@NaN"';
    if (n === Infinity) return '"@Infinity"';
    if (n === -Infinity) return '"@-Infinity"';
    if (Object.is(n, -0)) return '"@-0"';
    return String(n);
  }
  if (t === 'bigint') return `"@bigint:${(value as bigint).toString()}"`;
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // Functions/symbols: sanitizeOut already drops these to null. If one ever
  // reaches here, say so rather than encoding it as something it is not.
  return '"@nontransferable"';
}

// ── Outcome classification (design point 1) ──────────────────────────────────

type Outcome = 'ok' | 'threw' | 'harness-failed';

interface CaseRun {
  outcome: Outcome;
  value?: unknown;
  canonical?: string;
  error?: { name: string; message: string };
  durationMs: number;
}

/**
 * A guest exception and an engine that never ran the program are different facts.
 * zipp-host raises SandboxGuestError for EVERY guest throw and nothing else does
 * (ctx.unwrapResult builds one and copies the guest error's name/message onto
 * it), so `instanceof` is an exact discriminator. NOTE it is reachable only via
 * the `errors` namespace — the package has no top-level `QuickJSUnwrapError`
 * export, and importing one yields `undefined`, which would silently classify
 * every guest throw as a harness failure. There is one carve-out: the
 * interrupt handler and the memory cap also surface as guest-shaped
 * InternalErrors, and those mean "we never got an answer", not "the program
 * threw". Note that a genuine guest RangeError ("Maximum call stack size
 * exceeded") stays classified as `threw`, because it is one.
 */
function classify(err: unknown): { outcome: Outcome; name: string; message: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof SandboxGuestError)) {
    // Module instantiation failure, a bug in this harness, anything non-guest.
    return { outcome: 'harness-failed', name, message };
  }
  if (/interrupt|out of memory/i.test(message)) {
    return { outcome: 'harness-failed', name, message };
  }
  return { outcome: 'threw', name, message };
}

async function runCase(corpusCase: CorpusCase): Promise<CaseRun> {
  const kind = EVAL_KIND_BY_CORPUS_KIND[corpusCase.kind];
  if (!kind) {
    // A corpus kind this engine has no mapping for is a corpus/harness defect,
    // not a result. Report it as harness-failed so it can never read as a pass.
    return {
      outcome: 'harness-failed',
      error: {
        name: 'UnmappedCorpusKind',
        message: `no EvalKind for corpus kind "${corpusCase.kind}"`,
      },
      durationMs: 0,
    };
  }
  const startedAt = Date.now();
  try {
    const value = await runEval(kind, corpusCase.expression, corpusCase.context ?? {}, {
      budgetMs: EVAL_BUDGET_MS,
    });
    return {
      outcome: 'ok',
      value,
      canonical: canonicalJson(value),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const { outcome, name, message } = classify(err);
    return { outcome, error: { name, message }, durationMs: Date.now() - startedAt };
  }
}

// ── Artifact: the shared machine-readable run document ───────────────────────

type Assertion = 'pinned' | 'must-throw' | 'agree';
type Status = 'pass' | 'fail' | 'recorded';

interface ResultRecord {
  id: string;
  kind: string;
  source: string;
  assertion: Assertion;
  outcome: Outcome;
  status: Status;
  canonical?: string;
  value?: unknown;
  expectedCanonical?: string;
  error?: { name: string; message: string };
  durationMs: number;
}

const results: ResultRecord[] = [];

function assertionOf(expectation: CorpusExpectation): Assertion {
  if ('agree' in expectation) return 'agree';
  return expectation.ok ? 'pinned' : 'must-throw';
}

function readCorpusRaw(): string {
  try {
    return readFileSync(CORPUS_PATH, 'utf8');
  } catch {
    // Deliberately NOT a skip. A missing corpus means this suite asserts
    // nothing, and a silently-skipping parity suite is worse than none.
    throw new Error(
      `Expression parity corpus not found at ${CORPUS_PATH}.\n` +
        'Regenerate it with:  php formlogic/backend/scripts/build-expression-corpus.php'
    );
  }
}

const CORPUS_RAW = readCorpusRaw();
const CORPUS: Corpus = (() => {
  const parsed = JSON.parse(CORPUS_RAW) as Corpus;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported corpus version ${parsed.version} (this harness understands 1).`);
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Corpus at ${CORPUS_PATH} contains no cases.`);
  }
  return parsed;
})();

describe('cross-engine expression parity — browser zipp (real WASM)', () => {
  beforeAll(async () => {
    // Instantiating the wasm module is the expensive part; zipp-host memoises
    // it in `modulePromise`, so this one warm-up is what makes the other ~140
    // cases cheap. Each case still builds its own fresh runtime + context.
    const warm = await runEval('calc', '1 + 1', {}, { budgetMs: EVAL_BUDGET_MS });
    expect(warm, 'the QuickJS WASM module failed to evaluate a trivial expression').toBe(2);
  }, CASE_TIMEOUT_MS);

  it('every corpus case id is unique', () => {
    const ids = CORPUS.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const corpusCase of CORPUS.cases) {
    const assertion = assertionOf(corpusCase.expect);
    const label = corpusCase.expression.replace(/\s+/g, ' ').slice(0, 110);
    const title = `${corpusCase.id} [${assertion}] ${corpusCase.source}: ${label}`;

    it(
      title,
      async () => {
        const run = await runCase(corpusCase);
        const record: ResultRecord = {
          id: corpusCase.id,
          kind: corpusCase.kind,
          source: corpusCase.source,
          assertion,
          outcome: run.outcome,
          status: 'fail',
          durationMs: run.durationMs,
        };
        if (run.outcome === 'ok') {
          record.value = run.value;
          record.canonical = run.canonical;
        } else if (run.error) {
          record.error = run.error;
        }
        results.push(record);

        // A harness failure is never a result. Fail loudly on every assertion
        // kind, so "the engine could not run" can never read as agreement.
        if (run.outcome === 'harness-failed') {
          throw new Error(
            `harness failed to obtain a result (${run.error?.name}: ${run.error?.message})`
          );
        }

        if (assertion === 'agree') {
          // Engine-defined by construction (locale output, host timezone, error
          // text). Nothing is asserted; the outcome is recorded so a cross-engine
          // differ compares the runs against each other rather than blessing one
          // engine's arbitrary answer as the specification.
          record.status = 'recorded';
          return;
        }

        if (assertion === 'must-throw') {
          expect(run.outcome, `expected the guest to throw; it returned ${run.canonical}`).toBe(
            'threw'
          );
          record.status = 'pass';
          return;
        }

        const expected = (corpusCase.expect as { ok: true; value: unknown }).value;
        const expectedCanonical = canonicalJson(expected);
        record.expectedCanonical = expectedCanonical;
        expect(
          run.outcome,
          `expected a value; the guest threw ${run.error?.name}: ${run.error?.message}`
        ).toBe('ok');
        expect(run.canonical, 'canonical-JSON value differs from the corpus expectation').toBe(
          expectedCanonical
        );
        record.status = 'pass';
      },
      CASE_TIMEOUT_MS
    );
  }

  afterAll(() => {
    const artifact = {
      schemaVersion: 1,
      engine: 'browser-zipp',
      engineDetail: {
        host: 'ui/src/lib/formlogic/zipp-host.ts',
        variant: 'zipp-wasm (vendored; see ui/vendor/zipp-wasm/README.md)',
        prelude: 'ui/src/lib/formlogic/prelude.js',
        budgetMs: EVAL_BUDGET_MS,
      },
      corpus: {
        path: CORPUS_PATH,
        version: CORPUS.version,
        caseCount: CORPUS.cases.length,
        sha256: createHash('sha256').update(CORPUS_RAW).digest('hex'),
      },
      generatedAt: new Date().toISOString(),
      summary: {
        cases: CORPUS.cases.length,
        recorded: results.length,
        pass: results.filter((r) => r.status === 'pass').length,
        fail: results.filter((r) => r.status === 'fail').length,
        agreeRecorded: results.filter((r) => r.status === 'recorded').length,
        ok: results.filter((r) => r.outcome === 'ok').length,
        threw: results.filter((r) => r.outcome === 'threw').length,
        harnessFailed: results.filter((r) => r.outcome === 'harness-failed').length,
      },
      // Sorted by id so two runs of the same engine diff cleanly.
      results: [...results].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
    mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  });
});
