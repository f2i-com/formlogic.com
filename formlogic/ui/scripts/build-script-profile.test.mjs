// What build-script-profile.mjs must REFUSE, over synthetic sources - no network, no build.
//
// The generator's whole job is to be the last place a bad profile can be stopped. Once the
// document is committed and served, the failure is remote: a Desktop refuses it, or worse
// accepts it and runs different bytes than the browser does. Each case here is a refusal that
// would otherwise reach that far.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PATHS, buildProfile, lf, main, preambleCollision, serialize, sha256Hex } from './build-script-profile.mjs';

const here = resolve(fileURLToPath(import.meta.url), '..');
const vendored = JSON.parse(readFileSync(DEFAULT_PATHS.vendored, 'utf8'));

/** A sandbox holding real zipp-host/pythonContract sources and whatever prelude a case needs. */
function sandbox(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fl-script-profile-'));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const paths = { ...DEFAULT_PATHS, out: join(dir, 'out', 'formlogic-script-profile.json') };
  for (const [key, content] of Object.entries(overrides)) {
    const file = join(dir, `${key}.src`);
    writeFileSync(file, content, 'utf8');
    paths[key] = file;
  }
  return { dir, paths };
}

const failure = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return null;
};

test('--check fails, naming the field, when the committed artifact has drifted', () => {
  const { paths } = sandbox();
  writeFileSync(paths.out, serialize(buildProfile(paths)), 'utf8');
  assert.equal(failure(() => main(['--check', '--out', paths.out])), null, 'a freshly written artifact must pass --check');

  // The drift that matters: someone edits the prelude and forgets to regenerate. Simulate it
  // from the other end - the artifact holds yesterday's preamble - because that is exactly what
  // a stale commit looks like.
  const stale = JSON.parse(readFileSync(paths.out, 'utf8'));
  stale.preamble = `${stale.preamble}\nfunction __staleHelper() { return 1; }\n`;
  stale.preambleSha256 = sha256Hex(stale.preamble);
  writeFileSync(paths.out, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

  const message = failure(() => main(['--check', '--out', paths.out]));
  assert.ok(message, '--check must fail on a drifted artifact');
  assert.match(message, /is stale/);
  assert.match(message, /preamble, preambleSha256 differ/);
});

test('--check fails when the artifact was never generated', () => {
  const { dir, paths } = sandbox();
  const missing = join(dir, 'out', 'absent.json');
  const message = failure(() => main(['--check', '--out', missing]));
  assert.match(message, /has not been generated/);
  assert.ok(!paths.out.includes('absent'));
});

test('a prelude declaring a name OAIY binds is refused, at any indentation', () => {
  const real = lf(readFileSync(DEFAULT_PATHS.prelude, 'utf8'));

  // Top level, and nested three deep. OAIY's scan is a TEXT scan leading with `^[ \t]*`, so it
  // sees both - a `host` that shadows nothing is still a refusal there, and this refuses it in
  // the same place OAIY would.
  for (const [where, prelude] of [
    ['top level', `${real}\nvar host = { call: function () {} };\n`],
    ['nested', `${real}\nfunction helper() {\n  if (true) {\n    var localStorage = {};\n    return localStorage;\n  }\n}\n`],
    ['lexical shim redeclaration', `${real}\nconst fetch = function () {};\n`],
  ]) {
    const { paths } = sandbox({ prelude });
    const message = failure(() => buildProfile(paths));
    assert.ok(message, `a ${where} collision must be refused`);
    assert.match(message, /preamble (declares|redeclares)/);
  }

  // `var fetch` is a LEGAL replacement of a guest shim, which OAIY allows on purpose. Refusing
  // it here would be stricter than the consumer and would block a deliberate choice.
  const { paths } = sandbox({ prelude: `${real}\nvar fetch = function () {};\n` });
  assert.equal(preambleCollision(lf(readFileSync(paths.prelude, 'utf8')), vendored), null);
});

test("today's prelude collides with nothing, under OAIY's own indent-tolerant scan", () => {
  assert.equal(preambleCollision(lf(readFileSync(DEFAULT_PATHS.prelude, 'utf8')), vendored), null);
});

test('CRLF sources produce an LF document and a checkout-independent digest', () => {
  const prelude = lf(readFileSync(DEFAULT_PATHS.prelude, 'utf8'));
  const python = lf(readFileSync(DEFAULT_PATHS.python, 'utf8'));
  const crlf = (text) => text.replace(/\n/g, '\r\n');

  const fromLf = buildProfile(sandbox({ prelude, python }).paths);
  const fromCrlf = buildProfile(sandbox({ prelude: crlf(prelude), python: crlf(python) }).paths);

  assert.deepEqual(fromCrlf, fromLf, 'a Windows checkout must generate the same document as a Linux one');
  assert.ok(!/\r/.test(fromCrlf.preamble), 'the served preamble must be LF-only');
  assert.ok(!/\r/.test(fromCrlf.python.files['formlogic.py']), 'every served python file must be LF-only');
  assert.equal(fromCrlf.preambleSha256, sha256Hex(fromCrlf.preamble));
});

test('a renamed or moved source constant stops the build instead of being guessed', () => {
  const cases = [
    ['zippHost', 'const INSTRUCTION_BUDGET_STEPS = 200_000_000;', 'const INSTRUCTION_BUDGET_LIMIT = 200_000_000;', /instructionSteps:/],
    ['contract', "export const ENTRY_FUNCTION = '__formlogic_run__';", "const ENTRY_FUNCTION = '__formlogic_run__';", /python\.call:/],
  ];
  for (const [key, from, to, expected] of cases) {
    const source = lf(readFileSync(DEFAULT_PATHS[key], 'utf8'));
    assert.ok(source.includes(from), `${key} no longer contains ${JSON.stringify(from)} - update this test with it`);
    const { paths } = sandbox({ [key]: source.replace(from, to) });
    const message = failure(() => buildProfile(paths));
    assert.ok(message, `a renamed constant in ${key} must be refused`);
    assert.match(message, expected);
  }
});

test('the document carries guest data only - no FormLogic host identifier crosses', () => {
  // The driver is host code and stays here: the engine construction, the budget call, the mode
  // selection, the reply channel and the author-message rewrite. If one of these ever appears
  // in the served bytes, FormLogic has started shipping its host to someone else's machine.
  const hostOnly = [
    'attemptPython', 'runPython', 'initPythonProject', 'setInstructionBudget', 'zippInstanceUsage',
    'buildProgram', 'EMIT_PREAMBLE', 'BOOTSTRAP', 'sanitizeOut', 'authorMessage',
    'projectFiles', 'blockSource', 'BLOCK_WRAPPERS', 'LINE_OFFSETS', 'modesFor',
    '__emit', '__replies', '__ctxJson', '__asBody', '__formlogic_value__', '__formlogic_condition__',
  ];
  const served = readFileSync(resolve(here, '../../backend/resources/formlogic-script-profile.json'), 'utf8');
  for (const name of hostOnly) {
    assert.ok(!served.includes(name), `the served profile names the host-only identifier ${name}`);
  }
});
