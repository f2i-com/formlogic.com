// @vitest-environment node
//
// OAIY leg of the cross-host logic parity harness: FormLogic's two shared corpora run
// through a REAL `oaiy script` CLI, on OAIY's own ZIPP engine, and held to the same
// pinned expectations pythonLogicCorpus.test.ts and corpusParity.test.ts hold the browser
// host to. It is the file profileRunnerMirror.test.ts names as "what would make it real":
// the mirror there PORTS a runner that lives in another repository, this one drives it.
//
// Skipped unless `OAIY_CLI` names an `oaiy.mjs`. It is REQUIRED in the `oaiy-parity` CI
// job, which installs the CLI from a frozen release record; nothing here resolves,
// downloads or pins a release, and no tag or sha appears anywhere in this file. Engine
// identity is read as DATA from two places and compared: `oaiy-cli.json` (written by
// oaiy.com's `pack-cli-asset.mjs` from the CLI's own `capabilities --json`) beside the
// CLI, and `vendor/zipp-wasm/SOURCE.json` for the engine FormLogic has installed.
//
// WHAT IS COMPARED, AND WHAT IS NOT. Per case: the outcome CLASS first, then the payload.
//
//   {ok: true, value}  no errorKind, and canonicalJson(value) equal. This is a TOTAL
//                      comparison and it rests on a standing assumption: both hosts
//                      sanitise the value out of the guest the same way (zipp-host.ts's
//                      sanitizeOut, which oaiy-core's sanitizeScriptValue was copied
//                      from). A `value` diff therefore cannot by itself tell an ENGINE
//                      divergence from a SANITISER one - it says the two hosts disagree,
//                      not which one is wrong.
//   {threw: <regex>}   errorKind in {guest, source} - the two kinds zipp-host.ts:496
//                      turns into SandboxGuestError - and the regex is matched against
//                      authorMessage(mapAuthorLines(error, mode, source), source), the
//                      two presentation passes runPython:497 applies. Those are HOST code
//                      and are never served, so the test applies them here. Raw engine
//                      text and host-specific prefixes are NOT compared: they legitimately
//                      differ between hosts, and 23 of the 58 Python cases pin an author
//                      LOCATION rather than engine wording.
//   {resource: <regex>} errorKind 'resource', regex against the raw error.
//
// errorKind 'timeout' is NEVER a pass: it means this file's budget plumbing is wrong, not
// that the engines disagree. errorKind in {host, prepare, unsupported}, a whole-request
// refusal, a protocol error line, a reply that never arrives or a dead child are all
// `harness-failed`, which - exactly as in the two model files - fails the case on every
// assertion kind including `agree`. A harness that cannot obtain an answer must never be
// able to certify agreement.
//
// TRANSPORT. `--serve`: one warm worker answering NDJSON `{op:'batch',id,request}` on
// stdin, one batch per case per phase. ~215 one-shot `--request` spawns would dominate the
// run; one `--request` case is kept so both code paths are covered by every run.
// A STRUCTURAL LIMIT OF THE TRANSPORT, recorded in both artifacts: values cross as JSON
// text, so NaN, Infinity and -0 arrive as null, null and 0. canonicalJson's finer tokens
// (corpusParity.test.ts design point 2) can never fire on this side. No corpus case pins
// null, so nothing silently passes today; a future case that did would need another wire.
//
// THE PYTHON MAPPING is pythonContract.ts's, unfolded HERE rather than by the runner: the
// job carries `files`/`entry`/`call` from projectFiles(), so what is under test is the
// ENGINE plus FormLogic's own presentation. (The other reading - a job that NAMES
// `profile.python.modes` and lets the runner wrap and renumber - is a different claim
// about the runner's arithmetic, and profileRunnerMirror.test.ts is where it lives.) The
// per-mode `call` is still read from the served profile, because it is genuinely per-mode:
// the `syntax` entry deliberately defines `__formlogic_compiled__` and not the contract's
// shared call, and a caller of the wrong one would run the author's top level during a
// syntax check.
//
// TWO PHASES, mirroring runPython:485-494. Attempt 1 for every case at modesFor(...)[0];
// a `flow` case that answers errorKind 'source' gets a second batch at modesFor(...)[1]
// (flowModule). The envelope's own `fallbackOnSourceError` is deliberately NOT used: the
// reply carries no mode, and both presentation passes depend on the mode (LINE_OFFSETS is
// 3 for flowExpression and condition, 1 for flowModule), so the test has to know which
// attempt produced the text it is matching.
//
// KNOWN DIVERGENCE, RECORDED AND NOT PAPERED OVER. zipp-host.ts:490 falls back only when
// the `source` error came from the INIT phase; the envelope reports no phase, so a
// runtime-phase `source` error would fall back here and not in the browser. Every fallback
// this run took is recorded in the artifact under `divergences.sourcePhaseUnknown`, with
// attempt 1's raw text, so a reviewer can judge compile-vs-runtime for each one. The fix
// is a `phase` on the result (owner ask O2-2), not a change here.
//
// THE JAVASCRIPT MODE IS PER TEMPLATE, not one blanket `program`. buildProgram
// (zipp-host.ts:216-294) has four templates for the seven EvalKinds, and only the BODY
// crosses - never the template, which opens with the prelude and replies through
// FormLogic's own `__emit`, a channel that would collide with the runner's. The prelude
// crosses as the served profile's `preamble` (which makes every JS case a test of PR-B on
// a real runner: a refused profile is a finding, not a skip) and the context crosses as
// the job's `globals`, whose identifier/`__`-prefix/`__proto__` filter is the same rule
// BOOTSTRAP applies.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTRACT_ID,
  ENTRY_MODULE,
  authorMessage,
  isPythonKind,
  mapAuthorLines,
  modesFor,
  projectFiles,
  type PythonKind,
  type PythonMode,
} from './python/pythonContract';
// Type-only: importing zipp-host's runtime would instantiate the browser engine, which
// this file never uses. The kinds are the same seven all the same.
import type { EvalKind } from './zipp-host';
import { getNodeSpec } from '../../components/flows/editor/nodeCatalog';
import zippSource from '../../../vendor/zipp-wasm/SOURCE.json';

// ── Where everything lives ───────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
// src/lib/formlogic -> src/lib -> src -> ui -> formlogic -> <repo root>
const REPO_ROOT = resolve(HERE, '../../../../..');

/** The CLI under test. Absent: the whole suite is skipped (CI sets it, and requires it). */
const CLI_PATH = process.env.OAIY_CLI ?? '';
/** `pack-cli-asset.mjs` writes this beside the CLI, verbatim from `oaiy capabilities --json`. */
const CLI_RECORD_PATH = process.env.OAIY_CLI_RECORD ?? (CLI_PATH ? join(dirname(CLI_PATH), 'oaiy-cli.json') : '');

const PROFILE_PATH =
  process.env.FORMLOGIC_SCRIPT_PROFILE ?? join(REPO_ROOT, 'formlogic', 'backend', 'resources', 'formlogic-script-profile.json');
const PY_CORPUS_PATH =
  process.env.FORMLOGIC_PYTHON_CORPUS ?? join(REPO_ROOT, 'docs', 'contracts', 'formlogic-python-logic-corpus.json');
const JS_CORPUS_PATH =
  process.env.FORMLOGIC_PARITY_CORPUS ?? join(REPO_ROOT, 'docs', 'contracts', 'formlogic-expression-corpus.json');
const PY_ARTIFACT_PATH =
  process.env.FORMLOGIC_OAIY_PYTHON_OUT ?? join(REPO_ROOT, 'test-results', 'parity', 'python-logic-oaiy.json');
const JS_ARTIFACT_PATH = process.env.FORMLOGIC_OAIY_PARITY_OUT ?? join(REPO_ROOT, 'test-results', 'parity', 'oaiy.json');
const SMOKE_REQUEST_PATH = join(REPO_ROOT, 'test-results', 'parity', 'oaiy-request-smoke.json');

/**
 * A runaway Python loop spends the whole 200M-step budget (seconds, not milliseconds) and
 * the CLI's watchdog only fires at budgetMs + 1500ms grace, so vitest must outlast both.
 */
const CASE_TIMEOUT_MS = 90_000;
const STARTUP_TIMEOUT_MS = 120_000;

// ── The documents, all read as data ──────────────────────────────────────────

const installedZipp = zippSource as { release?: string; revision?: string; sha256: string };

interface ProfileMode {
  name: string;
  files: Record<string, string>;
  block: string;
  before: string;
  after: string;
  lineOffset: number;
  call?: string;
}
interface ScriptProfile {
  v: 1;
  preamble: string;
  preambleSha256: string;
  instructionSteps: number;
  python: { contract: string; files: Record<string, string>; entry: string; call: string; modes: ProfileMode[] };
}

const PROFILE: ScriptProfile = (() => {
  let raw: string;
  try {
    raw = readFileSync(PROFILE_PATH, 'utf8');
  } catch {
    // Deliberately NOT a skip: without the served profile the JS leg has no prelude and
    // the Python modes have no per-mode call, and a parity suite that asserts nothing is
    // worse than none. Regenerate with: npm run build:script-profile
    throw new Error(`The served leaf-script profile is not at ${PROFILE_PATH}. Regenerate it: npm run build:script-profile`);
  }
  const parsed = JSON.parse(raw) as ScriptProfile;
  if (parsed.python?.contract !== CONTRACT_ID) {
    throw new Error(`The served profile carries contract ${parsed.python?.contract}, not ${CONTRACT_ID}.`);
  }
  return parsed;
})();

/**
 * The function each mode's entry module actually defines. Per-mode because `syntax`'s is
 * deliberately not the contract's shared call (python/entry-syntax.py says why), and
 * calling the wrong one would execute the author's top level during a syntax check.
 */
const MODE_CALL: Readonly<Record<string, string>> = Object.freeze(
  // `modes` is optional in the schema: a BARE profile is still a valid profile, and it must
  // reach pythonJob's named error rather than crash this file at import.
  Object.fromEntries((PROFILE.python.modes ?? []).map((mode) => [mode.name, mode.call ?? PROFILE.python.call]))
);

/** The same 200M as zipp-host.ts:109, read from the document generated out of it. */
const INSTRUCTION_STEPS = PROFILE.instructionSteps;

type Expectation = { ok: true; value: unknown } | { threw: string } | { resource: string };

interface PythonCase {
  id: string;
  kind: string;
  source: string;
  context: Record<string, unknown>;
  expect: Expectation;
}

const PY_CORPUS_RAW = readFileSync(PY_CORPUS_PATH, 'utf8');
const PY_CORPUS: { contract: string; version: number; cases: PythonCase[] } = (() => {
  const parsed = JSON.parse(PY_CORPUS_RAW) as { contract: string; version: number; cases: PythonCase[] };
  if (parsed.contract !== CONTRACT_ID) throw new Error(`Corpus contract ${parsed.contract} is not ${CONTRACT_ID}.`);
  if (parsed.version !== 1) throw new Error(`Unsupported corpus version ${parsed.version} (this harness understands 1).`);
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) throw new Error(`Corpus at ${PY_CORPUS_PATH} has no cases.`);
  return parsed;
})();

type JsExpectation = { ok: true; value: unknown } | { ok: false } | { agree: true };

interface JsCorpusCase {
  id: string;
  kind: string;
  source: string;
  expression: string;
  context: Record<string, unknown>;
  expect: JsExpectation;
}

const JS_CORPUS_RAW = readFileSync(JS_CORPUS_PATH, 'utf8');
const JS_CORPUS: { version: number; cases: JsCorpusCase[] } = (() => {
  const parsed = JSON.parse(JS_CORPUS_RAW) as { version: number; cases: JsCorpusCase[] };
  if (parsed.version !== 1) throw new Error(`Unsupported corpus version ${parsed.version} (this harness understands 1).`);
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) throw new Error(`Corpus at ${JS_CORPUS_PATH} has no cases.`);
  return parsed;
})();

interface CliRecord {
  version: string;
  protocols: Record<string, number>;
  engine: { name: string; release: string; version: string; revision: string; wasmSha256: string; languages: string[]; status: string };
  script: { languages: string[]; defaultBudgetMs: number; maxBudgetMs: number };
}

/** Read only when the suite runs; a missing record is a failure there, never a skip. */
const CLI_RECORD: CliRecord | null = CLI_PATH
  ? (() => {
      try {
        return JSON.parse(readFileSync(CLI_RECORD_PATH, 'utf8')) as CliRecord;
      } catch {
        throw new Error(
          `OAIY_CLI is ${CLI_PATH} but its record is not at ${CLI_RECORD_PATH}. ` +
            'Every OAIY CLI asset carries oaiy-cli.json beside it; without it the engine under test cannot be identified.'
        );
      }
    })()
  : null;

/**
 * The schema maximum, and the reason the single `resource` case and every long case answer
 * as themselves: `oaiy script` kills at `budgetMs ?? 1000` plus a 1500ms grace, so at the
 * default the browser host's instruction budget (seconds of work) comes back `timeout` -
 * a difference in the harness reported as one in the engine.
 */
const BUDGET_MS = CLI_RECORD?.script.maxBudgetMs ?? 60_000;

// ── Canonical encoding ───────────────────────────────────────────────────────

/**
 * Sorted-key, information-preserving JSON, the same encoder corpusParity.test.ts uses on
 * the browser side so the two artifacts diff. Finer than JSON.stringify by design; see the
 * transport note in the header for why the finer tokens cannot fire on this side.
 */
function canonicalJson(value: unknown): string {
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
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return '"@nontransferable"';
}

// ── The wire ─────────────────────────────────────────────────────────────────

type ScriptOk = { id: string; ok: true; value?: unknown };
type ScriptFailed = { id: string; ok: false; errorKind: string; error: string };
type ScriptJobResult = ScriptOk | ScriptFailed;
type EngineIdentity = { name: string; release: string; version: string; revision: string; wasmSha256: string; languages: string[] };
type ScriptResponse =
  | { v: 1; engine: EngineIdentity; results: ScriptJobResult[] }
  | { v: 1; error: { code: string; message: string } };

/**
 * One `oaiy script --serve` child, one batch at a time, ids matched by a pending map. The
 * envelope serves batches in arrival order on ONE warm worker, so a batch sent while
 * another runs waits rather than being refused; every caller here still awaits its own.
 *
 * Everything fails closed: a protocol `error` line, a child that dies with batches in
 * flight, or a reply for an id nobody is waiting on all reject rather than resolve, and a
 * rejection reaches the case as `harness-failed`.
 */
class ServeClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve: (r: ScriptResponse) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private dead: Error | null = null;
  readonly stderr: string[] = [];
  /** The engine identity the replies themselves carried, as opposed to the CLI's record. */
  engineFromReplies: EngineIdentity | null = null;

  constructor(cliPath: string) {
    this.child = spawn(process.execPath, [cliPath, 'script', '--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = this.child.stdout;
    const err = this.child.stderr;
    if (!out || !err || !this.child.stdin) throw new Error('oaiy script --serve was spawned without its pipes');
    createInterface({ input: out, crlfDelay: Infinity }).on('line', (line) => this.onLine(line));
    createInterface({ input: err, crlfDelay: Infinity }).on('line', (line) => {
      // Diagnostics only - stdout carries the protocol. Kept for a failure message.
      if (this.stderr.length < 200) this.stderr.push(line);
    });
    this.child.on('error', (e) => this.die(new Error(`the oaiy script child failed: ${e.message}`)));
    this.child.on('exit', (code, signal) => this.die(new Error(`the oaiy script child exited (code ${code}, signal ${signal})`)));
  }

  private die(error: Error): void {
    this.dead ??= error;
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let message: { op?: string; id?: unknown; result?: ScriptResponse; engine?: EngineIdentity; error?: { code: string; message: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.die(new Error(`oaiy script wrote a line that is not JSON: ${line.slice(0, 300)}`));
      return;
    }
    const id = typeof message.id === 'string' ? message.id : null;
    if (message.op === 'result' && id) {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (!waiter) return;
      const result = message.result as ScriptResponse;
      if ('engine' in result) this.engineFromReplies ??= result.engine;
      waiter.resolve(result);
      return;
    }
    if (message.op === 'error') {
      const text = `oaiy script refused a line (${message.error?.code}): ${message.error?.message}`;
      if (id && this.pending.has(id)) {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(new Error(text));
      } else {
        this.die(new Error(text));
      }
      return;
    }
    if (message.op === 'pong') return;
    this.die(new Error(`oaiy script wrote an unknown line: ${line.slice(0, 300)}`));
  }

  /** Send one request and await its whole response (or the refusal object, verbatim). */
  batch(request: unknown): Promise<ScriptResponse> {
    if (this.dead) return Promise.reject(this.dead);
    const id = `b${++this.seq}`;
    return new Promise<ScriptResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin?.write(`${JSON.stringify({ op: 'batch', id, request })}\n`, (e) => {
        if (e) {
          this.pending.delete(id);
          reject(new Error(`could not write a batch to oaiy script: ${e.message}`));
        }
      });
    });
  }

  /** `shutdown` answers every batch already received, terminates the worker and exits 0. */
  async shutdown(): Promise<void> {
    if (this.dead) return;
    await new Promise<void>((done) => {
      this.child.once('exit', () => done());
      this.child.stdin?.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
      this.child.stdin?.end();
      setTimeout(() => {
        this.child.kill();
        done();
      }, 10_000).unref?.();
    });
  }
}

let client: ServeClient | null = null;

/** The one job of a one-job batch, or a harness error naming why there is none. */
async function runOneJob(request: unknown): Promise<ScriptJobResult> {
  if (!client) throw new Error('the oaiy script client was never started');
  const response = await client.batch(request);
  if ('error' in response) {
    throw new Error(`the request was refused whole (${response.error.code}): ${response.error.message}`);
  }
  if (!Array.isArray(response.results) || response.results.length !== 1) {
    throw new Error(`expected exactly one result, got ${JSON.stringify(response.results).slice(0, 300)}`);
  }
  return response.results[0];
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

type Outcome = 'ok' | 'threw' | 'resource' | 'timeout' | 'harness-failed';

/** Kinds that are the guest's own answer; zipp-host.ts:496-497 turns both into SandboxGuestError. */
const GUEST_KINDS = new Set(['guest', 'source']);

// ── Python leg ───────────────────────────────────────────────────────────────

interface PythonAttemptRecord {
  mode: PythonMode;
  ok: boolean;
  errorKind?: string;
  /** Raw, as the engine wrote it: the presentation passes are applied separately. */
  error?: string;
}

interface PythonRun {
  outcome: Outcome;
  mode: PythonMode;
  value?: unknown;
  /** For `threw`: after both presentation passes. For everything else: the raw text. */
  message?: string;
  raw?: string;
  attempts: PythonAttemptRecord[];
  durationMs: number;
}

/**
 * pythonContract.ts's whole mapping onto `python-project`, with the two figures that are
 * load-bearing rather than decorative attached to every job.
 */
function pythonJob(id: string, mode: PythonMode, kind: PythonKind, source: string, context: unknown): Record<string, unknown> {
  const call = MODE_CALL[mode];
  if (!call) throw new Error(`the served profile defines no mode ${JSON.stringify(mode)}; regenerate it`);
  return {
    id,
    language: 'python',
    mode: 'python-project',
    files: projectFiles(mode, source),
    entry: ENTRY_MODULE,
    call,
    // The JSON view zipp-host.ts:484 takes: a Date becomes its string, an undefined member
    // drops out. `syntax` passes nothing - its call takes no argument, because the compile
    // the project did at init IS the check and no author statement may run.
    args: kind === 'syntax' ? [] : [JSON.parse(JSON.stringify(context ?? {})) as unknown],
    budgetMs: BUDGET_MS,
    instructionSteps: INSTRUCTION_STEPS,
  };
}

async function runPythonCase(corpusCase: PythonCase): Promise<PythonRun> {
  const startedAt = Date.now();
  const attempts: PythonAttemptRecord[] = [];
  const kind = corpusCase.kind;
  if (!isPythonKind(kind)) {
    return { outcome: 'harness-failed', mode: 'flowModule', message: `no Python kind "${kind}"`, attempts, durationMs: 0 };
  }
  const modes = modesFor(kind, corpusCase.source);
  const attempt = async (mode: PythonMode): Promise<ScriptJobResult> => {
    const result = await runOneJob({
      v: 1,
      jobs: [pythonJob(corpusCase.id, mode, kind, corpusCase.source, corpusCase.context)],
    });
    attempts.push(
      result.ok ? { mode, ok: true } : { mode, ok: false, errorKind: result.errorKind, error: result.error }
    );
    return result;
  };

  let mode = modes[0];
  let result: ScriptJobResult;
  try {
    result = await attempt(mode);
    // runPython:490's second phase. The browser host takes it only when the `source` error
    // came from the INIT phase; the envelope reports no phase, so this takes it on any
    // `source`. Every fallback is recorded as a divergence rather than reasoned away.
    if (!result.ok && result.errorKind === 'source' && modes.length > 1) {
      mode = modes[1];
      result = await attempt(mode);
    }
  } catch (err) {
    return {
      outcome: 'harness-failed',
      mode,
      message: err instanceof Error ? err.message : String(err),
      attempts,
      durationMs: Date.now() - startedAt,
    };
  }

  const durationMs = Date.now() - startedAt;
  if (result.ok) return { outcome: 'ok', mode, value: result.value, attempts, durationMs };
  if (GUEST_KINDS.has(result.errorKind)) {
    // The two passes runPython:497 applies, in the order it applies them: the mode's own
    // line arithmetic, then FormLogic's dropping and renaming over lines already the
    // author's. Both are host code; neither is ever served.
    const message = authorMessage(mapAuthorLines(result.error, mode, corpusCase.source), corpusCase.source);
    return { outcome: 'threw', mode, message, raw: result.error, attempts, durationMs };
  }
  if (result.errorKind === 'resource') {
    return { outcome: 'resource', mode, message: result.error, raw: result.error, attempts, durationMs };
  }
  if (result.errorKind === 'timeout') {
    return { outcome: 'timeout', mode, message: result.error, raw: result.error, attempts, durationMs };
  }
  return {
    outcome: 'harness-failed',
    mode,
    message: `errorKind ${result.errorKind}: ${result.error}`,
    raw: result.error,
    attempts,
    durationMs,
  };
}

interface PythonRecord {
  id: string;
  kind: string;
  expected: string;
  outcome: Outcome;
  status: 'pass' | 'fail';
  mode: PythonMode;
  value?: unknown;
  canonical?: string;
  expectedCanonical?: string;
  message?: string;
  raw?: string;
  attempts: PythonAttemptRecord[];
  durationMs: number;
}

const pythonResults: PythonRecord[] = [];
/** Cases whose second phase this host took and the browser might not have. See the header. */
const sourcePhaseFallbacks: Array<{ id: string; kind: string; attempt1: PythonAttemptRecord; fellBackTo: PythonMode }> = [];

function describeExpectation(expectation: Expectation): string {
  if ('ok' in expectation) return 'ok';
  return 'threw' in expectation ? 'threw' : 'resource';
}

// ── JavaScript leg ───────────────────────────────────────────────────────────

/**
 * buildProgram's four templates, as the seven EvalKinds map onto OAIY's five JS modes.
 * Per template, never one blanket `program`:
 *
 *   syntax   (zipp-host.ts:220-232) `new Function("return (" + expr + ")")`, never invoked
 *                                   -> `parse`
 *   applogic (:234-248)             the script declares run(ctx); __run(__ctx) is the value
 *                                   -> `entry`, entry 'run', args [ctx]
 *   flow     (:249-286)             the parse probe that decides script-or-function-body
 *                                   -> `auto`, which is byte-for-byte that probe
 *   the rest (:288-294)             `(0, eval)(expr)` for the completion value
 *                                   -> `program`
 */
const OAIY_MODE_BY_KIND: Readonly<Record<EvalKind, 'parse' | 'entry' | 'auto' | 'program'>> = Object.freeze({
  syntax: 'parse',
  applogic: 'entry',
  flow: 'auto',
  condition: 'program',
  calc: 'program',
  validate: 'program',
  test: 'program',
});

/** The name buildProgram's applogic template looks for (zipp-host.ts:246). */
const APPLOGIC_ENTRY = 'run';

/**
 * Corpus `kind` -> EvalKind, the same map corpusParity.test.ts uses and for the same
 * reason: 'condition' | 'calc' | 'validate' | 'test' share one template, so the choice
 * among them cannot affect a result, and a kind with no entry here is a harness failure
 * rather than a silent pass.
 */
const EVAL_KIND_BY_CORPUS_KIND: Readonly<Record<string, EvalKind>> = Object.freeze({
  expression: 'calc',
  applogic: 'applogic',
});

function jsJob(id: string, kind: EvalKind, source: string, context: Record<string, unknown>): Record<string, unknown> {
  const mode = OAIY_MODE_BY_KIND[kind];
  const job: Record<string, unknown> = { id, mode, source, budgetMs: BUDGET_MS };
  if (mode === 'entry') {
    // The applogic template installs no globals: the context reaches the script only as
    // run's argument. `entry` is the mode that does the same.
    job.entry = APPLOGIC_ENTRY;
    job.args = [JSON.parse(JSON.stringify(context ?? {})) as unknown];
  } else if (mode !== 'parse') {
    job.globals = JSON.parse(JSON.stringify(context ?? {})) as unknown;
  }
  // `parse` gets nothing: buildProgram's syntax template injects '{}' and never runs the
  // expression, so a context there would be a difference this file invented.
  return job;
}

interface JsRun {
  outcome: Outcome;
  value?: unknown;
  canonical?: string;
  message?: string;
  errorKind?: string;
  durationMs: number;
}

async function runJsCase(id: string, kind: EvalKind, source: string, context: Record<string, unknown>): Promise<JsRun> {
  const startedAt = Date.now();
  let result: ScriptJobResult;
  try {
    result = await runOneJob({ v: 1, profile: PROFILE, jobs: [jsJob(id, kind, source, context)] });
  } catch (err) {
    return { outcome: 'harness-failed', message: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt };
  }
  const durationMs = Date.now() - startedAt;
  if (result.ok) return { outcome: 'ok', value: result.value, canonical: canonicalJson(result.value), durationMs };
  if (GUEST_KINDS.has(result.errorKind)) {
    // No rewriting on this leg: the JavaScript path throws the guest's own message
    // (zipp-host.ts:376) and nothing renames it, so the raw text IS what FormLogic reports.
    return { outcome: 'threw', message: result.error, errorKind: result.errorKind, durationMs };
  }
  if (result.errorKind === 'timeout') return { outcome: 'timeout', message: result.error, errorKind: result.errorKind, durationMs };
  // An engine ceiling is not a guest throw: it means no answer was obtained, which is what
  // corpusParity.test.ts's classify() decided for the browser side too.
  return { outcome: 'harness-failed', message: result.error, errorKind: result.errorKind, durationMs };
}

/**
 * The flowEval.test.ts table, transcribed. Those assertions are pinned against the real
 * browser engine in that file, which makes them expectations here in exactly the way the
 * corpus is: the shared corpora carry no `flow` and no JavaScript `applogic`/`syntax`
 * cases, so `auto` would otherwise never be exercised.
 */
const FLOW_CONTEXT: Record<string, unknown> = {
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

type FlowExpectation = { ok: true; value: unknown } | { threw: string } | { threwNot: string };

interface FlowCase {
  id: string;
  kind: EvalKind;
  source: string;
  expect: FlowExpectation;
}

const LOGIC_BLOCK_PLACEHOLDER: string =
  getNodeSpec('logic_block')?.properties.find((p) => p.key === 'expr')?.placeholder ?? '';

const mixed = (limit: number): string => `if (inputs.durationSeconds > ${limit}) return "big";\n"small"`;

const FLOW_CASES: readonly FlowCase[] = [
  { id: 'flow-expression-comparison', kind: 'flow', source: 'inputs.durationSeconds > 5', expect: { ok: true, value: true } },
  {
    id: 'flow-expression-concat',
    kind: 'flow',
    source: 'kv.greeting + ", " + nodes.customers[1].answers.name',
    expect: { ok: true, value: 'Hello, Ada' },
  },
  {
    id: 'flow-completion-value',
    kind: 'flow',
    source: 'const c = nodes.customers.find(r => r.answers.phone === inputs.from);\n({ found: !!c, name: c ? c.answers.name : null })',
    expect: { ok: true, value: { found: true, name: 'Ada' } },
  },
  {
    id: 'flow-function-body-return',
    kind: 'flow',
    source:
      'if (!inputs.from) return { found: false };\nconst c = nodes.customers.find(r => r.answers.phone === inputs.from);\nreturn { found: !!c, name: c?.answers?.name, greeting: kv.greeting, email: validators.email("a@b.co") };',
    expect: { ok: true, value: { found: true, name: 'Ada', greeting: 'Hello', email: true } },
  },
  { id: 'flow-bare-return', kind: 'flow', source: 'return inputs.durationSeconds > 5;', expect: { ok: true, value: true } },
  {
    id: 'flow-editor-placeholder',
    kind: 'flow',
    source: LOGIC_BLOCK_PLACEHOLDER,
    expect: { ok: true, value: { found: true, name: 'Ada' } },
  },
  { id: 'flow-mixed-style-return-fires', kind: 'flow', source: mixed(5), expect: { ok: true, value: 'big' } },
  // No return fires, so a function body falls off its end: the trailing expression is
  // dropped and the value is undefined. The desktop runner returns "small" for the same
  // block - the gap flowEval.test.ts pins, carried over here.
  { id: 'flow-mixed-style-no-return', kind: 'flow', source: mixed(100), expect: { ok: true, value: undefined } },
  {
    id: 'flow-nested-return-in-callback',
    kind: 'flow',
    source: 'nodes.customers.map(function (r) { return r.answers.name; })',
    expect: { ok: true, value: ['Other', 'Ada'] },
  },
  { id: 'flow-nested-return-in-iife', kind: 'flow', source: '(function () { return inputs.durationSeconds * 2; })()', expect: { ok: true, value: 24 } },
  {
    id: 'flow-nested-return-in-declaration',
    kind: 'flow',
    source: 'function pick(r) { return r.id; }\npick(nodes.customers[0])',
    expect: { ok: true, value: 'r1' },
  },
  {
    id: 'flow-runs-once-completion',
    kind: 'flow',
    source: 'globalThis.runs = (globalThis.runs || 0) + 1;\nglobalThis.runs',
    expect: { ok: true, value: 1 },
  },
  {
    id: 'flow-runs-once-body',
    kind: 'flow',
    source: 'globalThis.runs = (globalThis.runs || 0) + 1;\nreturn globalThis.runs;',
    expect: { ok: true, value: 1 },
  },
  { id: 'flow-syntax-error-plain', kind: 'flow', source: '1 +', expect: { threwNot: "'return' outside of a function" } },
  { id: 'calc-syntax-error-plain', kind: 'calc', source: '1 +', expect: { threwNot: "'return' outside of a function" } },
  { id: 'flow-body-syntax-error-elsewhere', kind: 'flow', source: 'const a = ;\nreturn a;', expect: { threwNot: "'return' outside of a function" } },
  { id: 'flow-body-syntax-error-trailing', kind: 'flow', source: 'return 1 +', expect: { threwNot: "'return' outside of a function" } },
  { id: 'flow-legacy-octal', kind: 'flow', source: '"use strict";\nreturn 0123;', expect: { threw: 'legacy octal' } },
  {
    id: 'flow-runtime-syntax-error',
    kind: 'flow',
    source: "const raw = 'not json';\nJSON.parse(raw)",
    expect: { threwNot: "'return' outside of a function" },
  },
  {
    id: 'calc-runtime-syntax-error',
    kind: 'calc',
    source: "const raw = 'not json';\nJSON.parse(raw)",
    expect: { threwNot: "'return' outside of a function" },
  },
  { id: 'calc-top-level-return', kind: 'calc', source: 'return inputs.durationSeconds > 5;', expect: { threw: "'return' outside of a function" } },
  {
    id: 'condition-top-level-return',
    kind: 'condition',
    source: 'return inputs.durationSeconds > 5;',
    expect: { threw: "'return' outside of a function" },
  },
  { id: 'calc-expression-comparison', kind: 'calc', source: 'inputs.durationSeconds > 5', expect: { ok: true, value: true } },
  { id: 'condition-expression-comparison', kind: 'condition', source: 'inputs.durationSeconds > 5', expect: { ok: true, value: true } },
];

/**
 * The claims flowEval.test.ts makes about two kinds agreeing, which no single case can
 * carry. Asserted after the table has run, from the messages it recorded.
 */
const FLOW_MESSAGE_PAIRS: ReadonlyArray<{ a: string; b: string; why: string }> = [
  { a: 'flow-syntax-error-plain', b: 'calc-syntax-error-plain', why: 'a plain syntax error reads the same in a flow block and a calculation' },
  {
    a: 'flow-runtime-syntax-error',
    b: 'calc-runtime-syntax-error',
    why: 'a runtime SyntaxError is reported as the error it is, not as a function body',
  },
  { a: 'calc-top-level-return', b: 'condition-top-level-return', why: 'the form kinds still refuse a top-level return, identically' },
];

interface JsRecord {
  id: string;
  kind: string;
  source: string;
  assertion: 'pinned' | 'must-throw' | 'agree' | 'flow-table';
  mode: string;
  outcome: Outcome;
  status: 'pass' | 'fail' | 'recorded';
  value?: unknown;
  canonical?: string;
  expectedCanonical?: string;
  errorKind?: string;
  message?: string;
  durationMs: number;
}

const jsResults: JsRecord[] = [];
const jsMessages = new Map<string, string>();

// ── Suites ───────────────────────────────────────────────────────────────────

const suite = CLI_PATH ? describe : describe.skip;

suite('OAIY leaf-script parity — the shared corpora on a real `oaiy script`', () => {
  beforeAll(async () => {
    client = new ServeClient(CLI_PATH);
    // One trivial batch proves the worker is warm and the engine loaded before any case
    // is timed; a failure here names the CLI rather than blaming a corpus case.
    const probe = await runOneJob({ v: 1, jobs: [{ id: 'warm', mode: 'program', source: '1 + 1', budgetMs: BUDGET_MS }] });
    expect(probe, `oaiy script could not evaluate 1 + 1: ${JSON.stringify(probe)}`).toMatchObject({ ok: true, value: 2 });
  }, STARTUP_TIMEOUT_MS);

  // ── The ZIPP precondition: one it(), both figures read as data, never a skip ──
  //
  // The corpus pins results the installed engine produces - `zipp-defect-cross-module-setattr`
  // expects {ok: true, value: 1} because ZIPP v0.0.19 fixed what v0.0.18 raised on. A CLI
  // built against an older engine will fail cases for a reason that has nothing to do with
  // either host, so it is named here in one line, and every case still runs: skipping is
  // how a broken engine certifies itself green.
  it('the CLI under test runs the ZIPP release FormLogic has installed', () => {
    const cliRelease = CLI_RECORD?.engine.release ?? null;
    const installedRelease = installedZipp.release ?? null;
    expect(cliRelease, `oaiy-cli.json (${CLI_RECORD_PATH}) names no engine release`).toBeTruthy();
    expect(installedRelease, `vendor/zipp-wasm/SOURCE.json names no engine release`).toBeTruthy();
    expect(
      cliRelease,
      `the OAIY CLI runs ZIPP ${cliRelease} (revision ${CLI_RECORD?.engine.revision}) but FormLogic has ZIPP ` +
        `${installedRelease} (revision ${installedZipp.revision}) installed. The corpora pin what the installed ` +
        'engine means; cut the OAIY release from a revision that installs the same one.'
    ).toBe(installedRelease);
  });

  describe('formlogic-python/1 corpus — OAIY `oaiy script`, python-project jobs', () => {
    it('every Python case id is unique', () => {
      const ids = PY_CORPUS.cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    for (const corpusCase of PY_CORPUS.cases) {
      const expected = describeExpectation(corpusCase.expect);
      const label = corpusCase.source.replace(/\s+/g, ' ').slice(0, 90);
      it(
        `${corpusCase.id} [${corpusCase.kind}, ${expected}]: ${label}`,
        async () => {
          const run = await runPythonCase(corpusCase);
          const record: PythonRecord = {
            id: corpusCase.id,
            kind: corpusCase.kind,
            expected,
            outcome: run.outcome,
            status: 'fail',
            mode: run.mode,
            attempts: run.attempts,
            durationMs: run.durationMs,
          };
          if (run.outcome === 'ok') {
            record.value = run.value;
            record.canonical = canonicalJson(run.value);
          } else {
            record.message = run.message;
            if (run.raw !== undefined) record.raw = run.raw;
          }
          pythonResults.push(record);
          if (run.attempts.length > 1) {
            sourcePhaseFallbacks.push({
              id: corpusCase.id,
              kind: corpusCase.kind,
              attempt1: run.attempts[0],
              fellBackTo: run.mode,
            });
          }

          if (run.outcome === 'harness-failed') throw new Error(`harness failed to obtain a result: ${run.message}`);
          if (run.outcome === 'timeout') {
            throw new Error(
              `the job answered errorKind 'timeout' (budgetMs ${BUDGET_MS}): that is this harness's budget plumbing, ` +
                `never an engine result. ${run.message}`
            );
          }

          const expectation = corpusCase.expect;
          if ('ok' in expectation) {
            record.expectedCanonical = canonicalJson(expectation.value);
            expect(run.outcome, `expected a value; got ${run.outcome}: ${run.message}`).toBe('ok');
            expect(record.canonical, 'canonical-JSON value differs from the corpus expectation').toBe(record.expectedCanonical);
          } else if ('threw' in expectation) {
            expect(run.outcome, `expected a guest error; got ${run.outcome} ${record.canonical ?? run.message}`).toBe('threw');
            expect(run.message, `raw engine text was: ${run.raw}`).toMatch(new RegExp(expectation.threw));
          } else {
            expect(run.outcome, `expected an engine limit; got ${run.outcome}: ${run.message ?? record.canonical}`).toBe('resource');
            expect(run.message).toMatch(new RegExp(expectation.resource));
          }
          record.status = 'pass';
        },
        CASE_TIMEOUT_MS
      );
    }
  });

  describe('formlogic expression corpus — OAIY `oaiy script`, JavaScript jobs', () => {
    it('every JavaScript case id is unique', () => {
      const ids = [...JS_CORPUS.cases.map((c) => c.id), ...FLOW_CASES.map((c) => c.id)];
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("the editor's logic_block placeholder is still a function body", () => {
      expect(LOGIC_BLOCK_PLACEHOLDER, 'nodeCatalog has no logic_block expr placeholder').toMatch(/\breturn\b/);
    });

    for (const corpusCase of JS_CORPUS.cases) {
      const assertion: JsRecord['assertion'] = 'agree' in corpusCase.expect ? 'agree' : corpusCase.expect.ok ? 'pinned' : 'must-throw';
      const label = corpusCase.expression.replace(/\s+/g, ' ').slice(0, 110);
      it(
        `${corpusCase.id} [${assertion}] ${corpusCase.source}: ${label}`,
        async () => {
          const kind = EVAL_KIND_BY_CORPUS_KIND[corpusCase.kind];
          const record: JsRecord = {
            id: corpusCase.id,
            kind: corpusCase.kind,
            source: corpusCase.source,
            assertion,
            mode: kind ? OAIY_MODE_BY_KIND[kind] : 'unmapped',
            outcome: 'harness-failed',
            status: 'fail',
            durationMs: 0,
          };
          if (!kind) {
            // A corpus kind with no template is a corpus/harness defect, not a result.
            jsResults.push({ ...record, message: `no EvalKind for corpus kind "${corpusCase.kind}"` });
            throw new Error(`no EvalKind for corpus kind "${corpusCase.kind}"`);
          }
          const run = await runJsCase(corpusCase.id, kind, corpusCase.expression, corpusCase.context ?? {});
          record.outcome = run.outcome;
          record.durationMs = run.durationMs;
          if (run.outcome === 'ok') {
            record.value = run.value;
            record.canonical = run.canonical;
          } else {
            record.message = run.message;
            record.errorKind = run.errorKind;
          }
          jsResults.push(record);
          if (run.message !== undefined) jsMessages.set(corpusCase.id, run.message);

          if (run.outcome === 'harness-failed') throw new Error(`harness failed to obtain a result: ${run.message}`);
          if (run.outcome === 'timeout') throw new Error(`the job answered errorKind 'timeout' (budgetMs ${BUDGET_MS}): ${run.message}`);

          if (assertion === 'agree') {
            // Engine-defined by construction (host timezone, locale output, error text).
            // Recorded so a differ compares the runs; never asserted, because neither
            // engine may be declared the winner of one of these.
            record.status = 'recorded';
            return;
          }
          if (assertion === 'must-throw') {
            expect(run.outcome, `expected the guest to throw; it returned ${run.canonical}`).toBe('threw');
            record.status = 'pass';
            return;
          }
          const expectedCanonical = canonicalJson((corpusCase.expect as { ok: true; value: unknown }).value);
          record.expectedCanonical = expectedCanonical;
          expect(run.outcome, `expected a value; the guest threw: ${run.message}`).toBe('ok');
          expect(run.canonical, 'canonical-JSON value differs from the corpus expectation').toBe(expectedCanonical);
          record.status = 'pass';
        },
        CASE_TIMEOUT_MS
      );
    }

    for (const flowCase of FLOW_CASES) {
      const label = flowCase.source.replace(/\s+/g, ' ').slice(0, 110);
      it(
        `${flowCase.id} [flow-table, ${flowCase.kind}]: ${label}`,
        async () => {
          const run = await runJsCase(flowCase.id, flowCase.kind, flowCase.source, FLOW_CONTEXT);
          const record: JsRecord = {
            id: flowCase.id,
            kind: flowCase.kind,
            source: 'flowEval.test.ts',
            assertion: 'flow-table',
            mode: OAIY_MODE_BY_KIND[flowCase.kind],
            outcome: run.outcome,
            status: 'fail',
            durationMs: run.durationMs,
          };
          if (run.outcome === 'ok') {
            record.value = run.value;
            record.canonical = run.canonical;
          } else {
            record.message = run.message;
            record.errorKind = run.errorKind;
          }
          jsResults.push(record);
          if (run.message !== undefined) jsMessages.set(flowCase.id, run.message);

          if (run.outcome === 'harness-failed') throw new Error(`harness failed to obtain a result: ${run.message}`);
          if (run.outcome === 'timeout') throw new Error(`the job answered errorKind 'timeout' (budgetMs ${BUDGET_MS}): ${run.message}`);

          if ('ok' in flowCase.expect) {
            const expectedCanonical = canonicalJson(flowCase.expect.value);
            record.expectedCanonical = expectedCanonical;
            expect(run.outcome, `expected a value; the guest threw: ${run.message}`).toBe('ok');
            expect(run.canonical, 'canonical-JSON value differs from the flowEval expectation').toBe(expectedCanonical);
          } else if ('threw' in flowCase.expect) {
            expect(run.outcome, `expected a guest error; got ${run.outcome} ${run.canonical}`).toBe('threw');
            expect(run.message).toMatch(new RegExp(flowCase.expect.threw));
          } else {
            expect(run.outcome, `expected a guest error; got ${run.outcome} ${run.canonical}`).toBe('threw');
            expect(run.message, 'the guest threw, but with the message that blames the wrong thing').not.toMatch(
              new RegExp(flowCase.expect.threwNot)
            );
          }
          record.status = 'pass';
        },
        CASE_TIMEOUT_MS
      );
    }

    for (const pair of FLOW_MESSAGE_PAIRS) {
      it(`${pair.a} and ${pair.b} report the same text: ${pair.why}`, () => {
        const a = jsMessages.get(pair.a);
        const b = jsMessages.get(pair.b);
        expect(a, `${pair.a} recorded no error message`).toBeTruthy();
        expect(b, `${pair.b} recorded no error message`).toBeTruthy();
        expect(a).toBe(b);
      });
    }
  });

  describe('`--request`, the other transport', () => {
    it(
      'one request from a file answers exactly what `--serve` answered for the same jobs',
      async () => {
        const pythonCase = PY_CORPUS.cases.find((c) => c.kind === 'flow' && 'ok' in c.expect);
        const jsCase = JS_CORPUS.cases.find((c) => 'ok' in c.expect && c.expect.ok === true);
        expect(pythonCase, 'the Python corpus has no ok-valued flow case to smoke with').toBeTruthy();
        expect(jsCase, 'the expression corpus has no ok-valued case to smoke with').toBeTruthy();
        const py = pythonCase as PythonCase;
        const js = jsCase as JsCorpusCase;
        const request = {
          v: 1,
          profile: PROFILE,
          jobs: [
            pythonJob('smoke-python', modesFor('flow', py.source)[0], 'flow', py.source, py.context),
            jsJob('smoke-javascript', EVAL_KIND_BY_CORPUS_KIND[js.kind], js.expression, js.context ?? {}),
          ],
        };

        if (!client) throw new Error('the oaiy script client was never started');
        const served = await client.batch(request);
        expect('results' in served, `--serve refused the smoke request: ${JSON.stringify(served)}`).toBe(true);
        // Both jobs must have COMPLETED, not merely have failed identically: two transports
        // agreeing on an error would cover the wire and leave the evaluation untested.
        expect(
          (served as { results: ScriptJobResult[] }).results.every((r) => r.ok),
          `the smoke jobs did not both run: ${JSON.stringify((served as { results: ScriptJobResult[] }).results)}`
        ).toBe(true);

        mkdirSync(dirname(SMOKE_REQUEST_PATH), { recursive: true });
        writeFileSync(SMOKE_REQUEST_PATH, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
        const oneShot = await new Promise<string>((done, fail) => {
          const child = spawn(process.execPath, [CLI_PATH, 'script', '--request', SMOKE_REQUEST_PATH], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let out = '';
          let err = '';
          child.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8');
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            err += chunk.toString('utf8');
          });
          child.on('error', (e) => fail(e));
          child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`oaiy script --request exited ${code}: ${err || out}`))));
        });
        const parsed = JSON.parse(oneShot) as ScriptResponse;
        expect('results' in parsed, `--request refused the smoke request: ${oneShot.slice(0, 400)}`).toBe(true);
        // The two transports are the same envelope over one engine; only the process
        // lifetime differs, so the results must be identical, not merely compatible.
        expect(canonicalJson((parsed as { results: ScriptJobResult[] }).results)).toBe(
          canonicalJson((served as { results: ScriptJobResult[] }).results)
        );
      },
      CASE_TIMEOUT_MS
    );
  });
});

// ── Artifacts ────────────────────────────────────────────────────────────────
//
// Two documents in the shapes the browser legs already emit, so a cross-engine differ
// compares the runs instead of blessing one engine's answer: python-logic-oaiy.json beside
// python-logic-browser.json, oaiy.json beside browser.json. Each carries the extra blocks
// this leg alone can report - every attempt, the transport's limits and the phase
// divergence the envelope cannot yet resolve.

afterAll(async () => {
  if (!client) return;
  const engineDetail = {
    cli: CLI_PATH,
    cliRecord: CLI_RECORD_PATH,
    cliVersion: CLI_RECORD?.version ?? null,
    protocols: CLI_RECORD?.protocols ?? null,
    // The engine the CLI's own record names, and the one its replies named. A difference
    // between them is a finding about the install, not about either corpus.
    engineFromRecord: CLI_RECORD?.engine ?? null,
    engineFromReplies: client.engineFromReplies,
    installedZipp: { release: installedZipp.release ?? null, revision: installedZipp.revision ?? null, sha256: installedZipp.sha256 },
    budgetMs: BUDGET_MS,
    instructionSteps: INSTRUCTION_STEPS,
    profile: { path: PROFILE_PATH, preambleSha256: PROFILE.preambleSha256, contract: PROFILE.python.contract },
  };
  const transport = {
    mode: 'oaiy script --serve (NDJSON, one warm worker)',
    alsoCovered: 'oaiy script --request (one case)',
    // Stated rather than implied: this leg's values cross as JSON text.
    valueEncoding: 'JSON over NDJSON: NaN and Infinity arrive as null, -0 as 0, so canonicalJson cannot report them here',
  };
  const stderr = client.stderr.slice(0, 50);
  await client.shutdown();

  mkdirSync(dirname(PY_ARTIFACT_PATH), { recursive: true });
  writeFileSync(
    PY_ARTIFACT_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        engine: 'oaiy-script-python',
        contract: CONTRACT_ID,
        engineDetail: { host: 'oaiy script (leaf-script envelope)', presentation: 'ui/src/lib/formlogic/python/pythonContract.ts', ...engineDetail },
        transport,
        corpus: {
          path: PY_CORPUS_PATH,
          version: PY_CORPUS.version,
          caseCount: PY_CORPUS.cases.length,
          sha256: createHash('sha256').update(PY_CORPUS_RAW).digest('hex'),
        },
        generatedAt: new Date().toISOString(),
        summary: {
          cases: PY_CORPUS.cases.length,
          recorded: pythonResults.length,
          pass: pythonResults.filter((r) => r.status === 'pass').length,
          fail: pythonResults.filter((r) => r.status === 'fail').length,
          ok: pythonResults.filter((r) => r.outcome === 'ok').length,
          threw: pythonResults.filter((r) => r.outcome === 'threw').length,
          resource: pythonResults.filter((r) => r.outcome === 'resource').length,
          timeout: pythonResults.filter((r) => r.outcome === 'timeout').length,
          harnessFailed: pythonResults.filter((r) => r.outcome === 'harness-failed').length,
        },
        divergences: {
          // zipp-host.ts:490 falls back only on a source error from the INIT phase; the
          // envelope reports no phase. Each entry is a case where this leg's fallback may
          // not be one the browser would take. Owner ask O2-2 is a `phase` on the result.
          sourcePhaseUnknown: sourcePhaseFallbacks,
        },
        stderr,
        results: [...pythonResults].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  writeFileSync(
    JS_ARTIFACT_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        engine: 'oaiy-script',
        engineDetail: { host: 'oaiy script (leaf-script envelope)', prelude: 'the served profile preamble', ...engineDetail },
        transport,
        modes: OAIY_MODE_BY_KIND,
        corpus: {
          path: JS_CORPUS_PATH,
          version: JS_CORPUS.version,
          caseCount: JS_CORPUS.cases.length,
          sha256: createHash('sha256').update(JS_CORPUS_RAW).digest('hex'),
          flowTable: { source: 'ui/src/lib/formlogic/flowEval.test.ts', caseCount: FLOW_CASES.length },
        },
        generatedAt: new Date().toISOString(),
        summary: {
          cases: JS_CORPUS.cases.length + FLOW_CASES.length,
          recorded: jsResults.length,
          pass: jsResults.filter((r) => r.status === 'pass').length,
          fail: jsResults.filter((r) => r.status === 'fail').length,
          agreeRecorded: jsResults.filter((r) => r.status === 'recorded').length,
          ok: jsResults.filter((r) => r.outcome === 'ok').length,
          threw: jsResults.filter((r) => r.outcome === 'threw').length,
          timeout: jsResults.filter((r) => r.outcome === 'timeout').length,
          harnessFailed: jsResults.filter((r) => r.outcome === 'harness-failed').length,
        },
        // Rows of the kind->mode table no shared corpus exercises: neither corpus carries
        // a JavaScript applogic or syntax case, so `entry` and `parse` are mapped and
        // unproven. Said here rather than left to be inferred from an empty result set.
        unexercised: ['applogic -> entry', 'syntax -> parse'],
        stderr,
        results: [...jsResults].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
});
