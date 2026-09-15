// @vitest-environment node
//
// FormLogic's Python contract (formlogic-python/1) on the REAL engine: every case in
// docs/contracts/formlogic-python-logic-corpus.json through zipp-host's Python path
// (runEval with language 'python'), minus the Worker Vitest doesn't have. The corpus is
// host-neutral: another host of the contract (OAIY) runs the same file.
//
// Harness rules, as in corpusParity.test.ts: three outcomes plus the engine's limits, and a
// harness failure (no engine, no Python frontend, an unknown kind) is always a test failure.
// Nothing skips: an engine without Python fails here loudly, on the languages check and on
// every case.
//
// FORMLOGIC_ZIPP_WASM=<path to a zipp_wasm_bg.wasm> runs the suite on another build of the
// engine under the installed glue; the artifact then records that build, not SOURCE.json's.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLanguages, runEval, SandboxGuestError, warmUp, type EvalKind } from './zipp-host';
import { CONTRACT_ID } from './python/pythonContract';
import zippSource from '../../../vendor/zipp-wasm/SOURCE.json';

const installedZipp = zippSource as { release?: string; revision?: string; sha256: string };

type Expectation = { ok: true; value: unknown } | { threw: string } | { resource: string };

interface PythonCase {
  id: string;
  kind: string;
  source: string;
  context: Record<string, unknown>;
  expect: Expectation;
}

interface PythonCorpus {
  contract: string;
  version: number;
  cases: PythonCase[];
}

const KINDS: readonly EvalKind[] = ['flow', 'condition', 'applogic', 'syntax'];
// A runaway Python loop spends the whole 200M-step budget (seconds, not milliseconds), and
// vitest must never report that as its own timeout.
const CASE_TIMEOUT_MS = 60_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const CORPUS_PATH =
  process.env.FORMLOGIC_PYTHON_CORPUS ?? join(REPO_ROOT, 'docs', 'contracts', 'formlogic-python-logic-corpus.json');
const ARTIFACT_PATH =
  process.env.FORMLOGIC_PYTHON_CORPUS_OUT ?? join(REPO_ROOT, 'test-results', 'parity', 'python-logic-browser.json');
const ENGINE_OVERRIDE = process.env.FORMLOGIC_ZIPP_WASM;

const CORPUS_RAW = (() => {
  try {
    return readFileSync(CORPUS_PATH, 'utf8');
  } catch {
    throw new Error(`Python logic corpus not found at ${CORPUS_PATH}.`);
  }
})();
const CORPUS: PythonCorpus = (() => {
  const parsed = JSON.parse(CORPUS_RAW) as PythonCorpus;
  if (parsed.contract !== CONTRACT_ID) {
    throw new Error(`Corpus contract ${parsed.contract} is not ${CONTRACT_ID}.`);
  }
  if (parsed.version !== 1) throw new Error(`Unsupported corpus version ${parsed.version} (this harness understands 1).`);
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) throw new Error(`Corpus at ${CORPUS_PATH} has no cases.`);
  return parsed;
})();

/** Sorted-key JSON, so key order never reads as a difference. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return '"@undefined"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

type Outcome = 'ok' | 'threw' | 'resource' | 'harness-failed';

interface CaseRun {
  outcome: Outcome;
  value?: unknown;
  message?: string;
  durationMs: number;
}

async function runCase(corpusCase: PythonCase): Promise<CaseRun> {
  const startedAt = Date.now();
  if (!KINDS.includes(corpusCase.kind as EvalKind)) {
    return { outcome: 'harness-failed', message: `no Python kind "${corpusCase.kind}"`, durationMs: 0 };
  }
  try {
    const value = await runEval(corpusCase.kind as EvalKind, corpusCase.source, corpusCase.context ?? {}, { language: 'python' });
    return { outcome: 'ok', value, durationMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // SandboxGuestError is the guest's own error and nothing else is; an engine limit arrives
    // as the engine's message; anything else means no answer was obtained.
    const outcome: Outcome = err instanceof SandboxGuestError
      ? 'threw'
      : /exceeded its (instruction|memory|output) budget/.test(message) ? 'resource' : 'harness-failed';
    return { outcome, message, durationMs: Date.now() - startedAt };
  }
}

function describeExpectation(expectation: Expectation): string {
  if ('ok' in expectation) return 'ok';
  return 'threw' in expectation ? 'threw' : 'resource';
}

const results: Array<{ id: string; kind: string; expected: string; outcome: Outcome; status: 'pass' | 'fail'; value?: unknown; message?: string; durationMs: number }> = [];
let languages: string[] = [];
let engineDetail: Record<string, unknown> = {};

describe('formlogic-python/1 corpus — browser ZIPP web-python (real WASM)', () => {
  beforeAll(async () => {
    if (ENGINE_OVERRIDE) {
      const bytes = readFileSync(ENGINE_OVERRIDE);
      await warmUp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      engineDetail = { override: ENGINE_OVERRIDE, sha256: createHash('sha256').update(bytes).digest('hex') };
    } else {
      engineDetail = { release: installedZipp.release ?? null, revision: installedZipp.revision ?? null, sha256: installedZipp.sha256 };
    }
    languages = await engineLanguages();
    engineDetail.languages = languages;
  }, CASE_TIMEOUT_MS);

  it('the engine has the Python frontend', () => {
    expect(languages, 'this ZIPP build cannot run Python logic').toContain('python');
  });

  it('every case id is unique', () => {
    const ids = CORPUS.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const corpusCase of CORPUS.cases) {
    const expected = describeExpectation(corpusCase.expect);
    const label = corpusCase.source.replace(/\s+/g, ' ').slice(0, 90);
    it(`${corpusCase.id} [${corpusCase.kind}, ${expected}]: ${label}`, async () => {
      const run = await runCase(corpusCase);
      const record: (typeof results)[number] = { id: corpusCase.id, kind: corpusCase.kind, expected, outcome: run.outcome, status: 'fail', durationMs: run.durationMs };
      if (run.outcome === 'ok') record.value = run.value;
      else record.message = run.message;
      results.push(record);

      if (run.outcome === 'harness-failed') throw new Error(`harness failed to obtain a result: ${run.message}`);
      const expectation = corpusCase.expect;
      if ('ok' in expectation) {
        expect(run.outcome, `expected a value; got ${run.outcome}: ${run.message}`).toBe('ok');
        expect(canonicalJson(run.value)).toBe(canonicalJson(expectation.value));
      } else if ('threw' in expectation) {
        expect(run.outcome, `expected a guest error; got ${run.outcome} ${canonicalJson(run.value)}`).toBe('threw');
        expect(run.message).toMatch(new RegExp(expectation.threw));
      } else {
        expect(run.outcome, `expected an engine limit; got ${run.outcome}: ${run.message ?? canonicalJson(run.value)}`).toBe('resource');
        expect(run.message).toMatch(new RegExp(expectation.resource));
      }
      record.status = 'pass';
    }, CASE_TIMEOUT_MS);
  }

  afterAll(() => {
    const artifact = {
      schemaVersion: 1,
      engine: 'browser-zipp-python',
      contract: CONTRACT_ID,
      engineDetail: { host: 'ui/src/lib/formlogic/zipp-host.ts', zipp: engineDetail },
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
        harnessFailed: results.filter((r) => r.outcome === 'harness-failed').length,
      },
      results: [...results].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
    mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  });
});
