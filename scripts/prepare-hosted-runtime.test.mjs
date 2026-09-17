/**
 * The first step of .github/actions/prepare-hosted-runtime/action.yml, run the
 * way a runner runs it: the step's own script under bash, its env mapped from
 * the action's inputs (defaults applied), RUNNER_TEMP and GITHUB_OUTPUT in a
 * temporary directory. Nothing here touches the tree.
 *
 * Release-readiness FL-S01, finding 14: a run hands every job its frozen
 * record as JSON and the action writes the file both scripts read. The
 * per-job steps this replaced wrote a file even from an empty record, which
 * the fetcher refused as not JSON; so a record that arrives empty (a renamed
 * or mistyped output) must still fail the job, not install the latest release
 * with a compatibility-only check. Only a caller that sets allow-latest gets
 * the latest, and the workflows' call sites are held to that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = (path) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
const action = text('.github/actions/prepare-hosted-runtime/action.yml');

// On Windows the `bash` on PATH may be WSL's, which cannot open Windows paths;
// Git's own bash (beside the git on PATH) can.
const gitBash = process.platform === 'win32' ? resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() || '.', '../../../bin/bash.exe') : null;
const BASH = gitBash && existsSync(gitBash) ? gitBash : 'bash';

const RECORD = JSON.stringify({ formatVersion: 1, tag: 'v0.0.13', tagCommit: 'b'.repeat(40), assetName: 'softn-formlogic-runtime-v0.0.13.zip', archiveSha256: 'a'.repeat(64) }, null, 2);

/** The indented block under the first `key:` line of `source`, dedented. */
function block(source, key) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:`).test(line));
  assert.ok(start >= 0, `no ${key}:`);
  const indent = lines[start].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line);
  }
  const inner = Math.min(...body.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length));
  return body.map((line) => line.slice(inner)).join('\n').replace(/\n+$/, '\n');
}

const defaults = Object.fromEntries([...block(action, 'inputs').matchAll(/^([\w-]+):\n(?:[ ].*\n)*?[ ]+default: '([^']*)'/gm)].map((m) => [m[1], m[2]]));
assert.ok(action.includes('\n      id: frozen\n'), 'action.yml has no step with id: frozen');
const frozenStep = action.slice(action.indexOf('\n      id: frozen\n'));
const envFromInputs = [...block(frozenStep, 'env').matchAll(/^(\w+): \$\{\{ inputs\.([\w-]+) \}\}$/gm)].map((m) => [m[1], m[2]]);
const script = block(frozenStep, 'run');

/** Runs the step as a runner would for a call site passing `inputs`. */
async function runStep(inputs) {
  const dir = await mkdtemp(resolve(tmpdir(), 'prepare-hosted-runtime-'));
  try {
    const runnerTemp = resolve(dir, 'temp');
    const output = resolve(dir, 'github-output');
    await writeFile(output, '');
    await mkdir(runnerTemp);
    const file = resolve(dir, 'step.sh');
    await writeFile(file, script);
    const env = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output };
    for (const [name, input] of envFromInputs) env[name] = inputs[input] ?? defaults[input] ?? '';
    const run = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', file], { env, encoding: 'utf8' });
    assert.ifError(run.error);
    const written = `${runnerTemp}/softn-frozen.json`;
    return {
      status: run.status,
      log: run.stdout + run.stderr,
      outputs: (await readFile(output, 'utf8')).split('\n').filter(Boolean),
      written,
      record: existsSync(written) ? await readFile(written, 'utf8') : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the step reads both record inputs and allow-latest, which defaults to false', () => {
  assert.deepEqual(Object.fromEntries(envFromInputs), { SOFTN_FROZEN_JSON: 'frozen-release-json', SOFTN_FROZEN_PATH: 'frozen-release', SOFTN_ALLOW_LATEST: 'allow-latest' });
  assert.equal(defaults['allow-latest'], 'false');
  assert.equal(defaults['frozen-release-json'], '');
});

test('a record is written under RUNNER_TEMP, byte for byte as the per-job steps wrote it, and named for both scripts', async () => {
  for (const extra of [{}, { 'allow-latest': 'true' }]) {
    const result = await runStep({ 'frozen-release-json': RECORD, ...extra });
    assert.equal(result.status, 0, result.log);
    assert.equal(result.record, `${RECORD}\n`);
    assert.deepEqual(result.outputs, [`path=${result.written}`]);
  }
  // Both scripts and --exact follow that one output, so they cannot disagree.
  assert.equal(action.match(/SOFTN_FROZEN: \$\{\{ steps\.frozen\.outputs\.path \}\}/g)?.length, 2);
  assert.match(action, /ecosystem-manifest\.mjs --check \$\{\{ steps\.frozen\.outputs\.path != '' && '--exact' \|\| '' \}\}/);
});

test('a record path is passed through and nothing is written', async () => {
  const result = await runStep({ 'frozen-release': 'softn-frozen.json' });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.record, null);
  assert.deepEqual(result.outputs, ['path=softn-frozen.json']);
});

test('FL-S01: a record that arrives empty fails the job instead of installing the latest release', async () => {
  const result = await runStep({ 'frozen-release-json': '' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /::error::.*no frozen release record.*allow-latest/);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.record, null);
});

test('only allow-latest lets a job with no record install the latest release, unfrozen', async () => {
  const result = await runStep({ 'frozen-release-json': '', 'allow-latest': 'true' });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.outputs, ['path=']);
  assert.equal(result.record, null);
});

test('a record given both ways is refused', async () => {
  const result = await runStep({ 'frozen-release-json': RECORD, 'frozen-release': 'softn-frozen.json' });
  assert.equal(result.status, 1);
  assert.match(result.log, /::error::.*both frozen-release-json and frozen-release/);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.record, null);
});

test('every workflow job hands the action its run\'s record; only e2e.yml alone may install the latest', () => {
  const calls = [];
  for (const workflow of ['ci.yml', 'package.yml', 'e2e.yml']) {
    const source = text(`.github/workflows/${workflow}`);
    for (const at of source.matchAll(/uses: \.\/\.github\/actions\/prepare-hosted-runtime\n/g)) {
      const using = Object.fromEntries(block(source.slice(at.index), 'with').split('\n').filter(Boolean).map((line) => line.split(/: (.*)/s).slice(0, 2)));
      calls.push({ workflow, ...using });
    }
  }
  const FROZEN = '${{ needs.resolve.outputs.frozen }}';
  assert.deepEqual(calls, [
    { workflow: 'ci.yml', 'native-only': "'true'", 'frozen-release-json': FROZEN },
    { workflow: 'ci.yml', 'frozen-release-json': FROZEN },
    // The OAIY parity job. It compares the engine the CLI under test carries
    // against the one THIS tree runs, so it has to install that engine the same
    // frozen way every other job does, or the comparison is against nothing.
    { workflow: 'ci.yml', 'frozen-release-json': FROZEN },
    { workflow: 'package.yml', 'native-only': "'true'", 'frozen-release-json': FROZEN },
    { workflow: 'package.yml', 'frozen-release-json': FROZEN },
    { workflow: 'package.yml', 'native-only': "'true'", 'frozen-release-json': FROZEN },
    { workflow: 'package.yml', 'frozen-release-json': FROZEN },
    { workflow: 'e2e.yml', 'frozen-release-json': '${{ inputs.frozen-release }}', 'allow-latest': "${{ inputs.frozen-release == '' && 'true' || 'false' }}" },
  ]);
  assert.match(text('.github/workflows/package.yml'), /uses: \.\/\.github\/workflows\/e2e\.yml\n\s+with:\n\s+frozen-release: \$\{\{ needs\.resolve\.outputs\.frozen \}\}\n/);
});
