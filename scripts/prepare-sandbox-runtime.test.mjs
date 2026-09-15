/**
 * .github/actions/prepare-sandbox-runtime and where the workflows use it. The
 * server sandbox is not in git, so every job that runs the PHP suites must get
 * it from this action first (built in the job, or installed from this run's
 * sandbox jobs), and end on the PHP preflight, or the sandbox suites would
 * skip and the job pass. The action's input check runs here the way a runner
 * runs it: its own script under bash, env from the inputs, GITHUB_OUTPUT in a
 * temporary directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = (path) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
const action = text('.github/actions/prepare-sandbox-runtime/action.yml');
const workflows = Object.fromEntries(['ci.yml', 'package.yml', 'e2e.yml'].map((name) => [name, text(`.github/workflows/${name}`)]));

// On Windows the `bash` on PATH may be WSL's, which cannot open Windows paths; Git's own bash can.
const gitBash = process.platform === 'win32' ? resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() || '.', '../../../bin/bash.exe') : null;
const BASH = gitBash && existsSync(gitBash) ? gitBash : 'bash';

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

/** A job's text: from `  <id>:` to the next job. */
function job(source, id) {
  const start = source.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `no job ${id}`);
  const next = source.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next + 1);
}

/** Each use of the sandbox action in a job: its `with:` map and where in the job it sits. */
function sandboxCalls(jobText) {
  return [...jobText.matchAll(/uses: \.\/\.github\/actions\/prepare-sandbox-runtime\n/g)].map((at) => ({
    at: at.index,
    with: Object.fromEntries(block(jobText.slice(at.index), 'with').split('\n').filter(Boolean).map((line) => line.split(/: (.*)/s).slice(0, 2))),
  }));
}

const defaults = Object.fromEntries([...block(action, 'inputs').matchAll(/^([\w-]+):\n(?:[ ].*\n)*?[ ]+default: '([^']*)'/gm)].map((m) => [m[1], m[2]]));
const wantedStep = action.slice(action.indexOf('\n      id: wanted\n'));
const envFromInputs = [...block(wantedStep, 'env').matchAll(/^(\w+): \$\{\{ inputs\.([\w-]+) \}\}$/gm)].map((m) => [m[1], m[2]]);

async function checkInputs(inputs) {
  const dir = await mkdtemp(resolve(tmpdir(), 'prepare-sandbox-runtime-'));
  try {
    const output = resolve(dir, 'github-output');
    await writeFile(output, '');
    const file = resolve(dir, 'step.sh');
    await writeFile(file, block(wantedStep, 'run'));
    const env = { ...process.env, GITHUB_OUTPUT: output };
    for (const [name, input] of envFromInputs) env[name] = inputs[input] ?? defaults[input] ?? '';
    const run = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', file], { env, encoding: 'utf8' });
    assert.ifError(run.error);
    return { status: run.status, log: run.stdout + run.stderr, outputs: (await readFile(output, 'utf8')).split('\n').filter(Boolean) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the action takes a mode, the launcher artifacts to install (sandbox-linux by default), and runs the PHP preflight unless told not to', () => {
  assert.deepEqual(Object.fromEntries(envFromInputs), { MODE: 'mode', ARTIFACTS: 'artifacts' });
  assert.equal(defaults.artifacts, 'sandbox-linux');
  assert.equal(defaults['php-preflight'], 'true');
  assert.match(block(action, 'inputs'), /^mode:\n(?:\s.*\n)*?\s+required: true/m);
});

test('build and install modes resolve which launcher artifacts to install; anything else fails the job', async () => {
  assert.deepEqual((await checkInputs({ mode: 'build', artifacts: '' })).outputs, ['linux=false', 'windows=false']);
  assert.deepEqual((await checkInputs({ mode: 'install' })).outputs, ['linux=true', 'windows=false']);
  assert.deepEqual((await checkInputs({ mode: 'install', artifacts: 'sandbox-linux sandbox-windows' })).outputs, ['linux=true', 'windows=true']);
  const none = await checkInputs({ mode: 'install', artifacts: '' });
  assert.equal(none.status, 1);
  assert.match(none.log, /::error::prepare-sandbox-runtime install mode names no launcher artifact/);
  const unknown = await checkInputs({ mode: 'install', artifacts: 'sandbox-linux sandbox-macos' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.log, /::error::prepare-sandbox-runtime cannot install 'sandbox-macos'/);
  const mode = await checkInputs({ mode: 'download' });
  assert.equal(mode.status, 1);
  assert.match(mode.log, /::error::prepare-sandbox-runtime mode is 'download'; expected build or install/);
});

test('build mode checks out ZIPP at the release current.json names and verifies it before building; install mode restores the execute bit', () => {
  const checkout = action.indexOf('repository: f2i-com/zipp.org');
  assert.ok(checkout > 0);
  assert.match(action, /ref: refs\/tags\/\$\{\{ steps\.zipp\.outputs\.release \}\}\n\s+path: \.runtime-source\/zipp\/src\n\s+fetch-depth: 1\n\s+persist-credentials: false/);
  assert.ok(action.indexOf('node scripts/zipp-source.mjs --identity') < checkout, 'the release comes from the installed Softn release');
  const verify = action.indexOf('node scripts/zipp-source.mjs --verify');
  const build = action.indexOf('bash scripts/build-runtime.sh guest linux smoke provenance');
  assert.ok(checkout < verify && verify < build, 'verified before anything builds from it');
  assert.match(action, /chmod \+x formlogic\/backend\/bin\/runtime\/formlogic-runtime-linux-x86_64\n\s+fi\n\s+node scripts\/runtime-provenance\.mjs provenance/);
  assert.match(action, /bash scripts\/build-runtime\.sh check/);
  assert.match(action, /if: inputs\.php-preflight == 'true'[\s\S]*SandboxRunner[\s\S]*isAvailable\(\)/);
  for (const uses of action.matchAll(/uses: ([^\s]+)/g)) assert.match(uses[1], /@[0-9a-f]{40}$/, `${uses[1]} is pinned by SHA`);
});

test('every job that runs the PHP suites gets the sandbox first, with the PHP preflight on', () => {
  const suites = [
    ['ci.yml', 'backend', { mode: 'build' }],
    ['package.yml', 'verify', { mode: 'install', artifacts: 'sandbox-linux' }],
    ['package.yml', 'php-floor', { mode: 'install', artifacts: 'sandbox-linux' }],
  ];
  for (const [workflow, id, expected] of suites) {
    const body = job(workflows[workflow], id);
    const calls = sandboxCalls(body);
    assert.equal(calls.length, 1, `${workflow} ${id} uses the sandbox action once`);
    assert.equal(calls[0].with.mode, expected.mode, `${workflow} ${id}`);
    if (expected.artifacts) assert.equal(calls[0].with.artifacts, expected.artifacts);
    assert.equal(calls[0].with['frozen-release-json'], '${{ needs.resolve.outputs.frozen }}');
    assert.equal(calls[0].with['php-preflight'], undefined, `${workflow} ${id} keeps the preflight`);
    const tests = body.indexOf('composer test');
    assert.ok(tests > calls[0].at, `${workflow} ${id}: the sandbox is in place before composer test`);
    assert.ok(body.indexOf('composer install') < calls[0].at, `${workflow} ${id}: composer install precedes the preflight`);
    assert.ok(body.indexOf('uses: ./.github/actions/prepare-hosted-runtime') < calls[0].at, `${workflow} ${id}: the Softn release is installed first`);
  }
  assert.match(job(workflows['ci.yml'], 'backend'), /runs-on: ubuntu-24\.04/);
});

test('package.yml builds the sandbox once per run, and packages only what that run built', () => {
  const pkg = workflows['package.yml'];
  const linux = job(pkg, 'sandbox-linux');
  assert.match(linux, /runs-on: ubuntu-24\.04/);
  assert.deepEqual(sandboxCalls(linux).map((call) => call.with), [{ mode: 'build', 'frozen-release-json': '${{ needs.resolve.outputs.frozen }}', 'php-preflight': "'false'" }]);
  for (const [name, paths] of [['sandbox-guest', ['formlogic/runtime/host/formlogic-runtime-guest.wasm', 'formlogic/runtime/guest/Cargo.lock', '.runtime-source/sandbox/guest.json']], ['sandbox-linux', ['formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64', '.runtime-source/sandbox/linux.json']]]) {
    const upload = linux.slice(linux.indexOf(`name: ${name}\n`));
    for (const path of paths) assert.ok(block(upload, 'path').includes(path), `${name} uploads ${path}`);
    assert.match(upload, /include-hidden-files: true/, `${name} keeps .runtime-source/sandbox`);
  }
  const windows = job(pkg, 'sandbox-windows');
  assert.match(windows, /runs-on: windows-2022\n\s+needs: sandbox-linux/);
  assert.match(windows, /name: sandbox-guest\n\s+path: \$\{\{ github\.workspace \}\}/);
  assert.ok(windows.indexOf('name: sandbox-guest') < windows.indexOf('bash scripts/build-runtime.sh windows smoke'));
  assert.match(windows, /name: sandbox-windows\n\s+path: \|\n\s+formlogic\/backend\/bin\/runtime\/formlogic-runtime-windows-x86_64\.exe\n\s+\.runtime-source\/sandbox\/windows\.json\n\s+include-hidden-files: true/);
  const packaging = job(pkg, 'package');
  assert.match(packaging, /needs: \[resolve, verify, e2e, php-floor, sandbox-linux, sandbox-windows\]/);
  assert.deepEqual(sandboxCalls(packaging).map((call) => call.with), [{ mode: 'install', artifacts: 'sandbox-linux sandbox-windows', 'frozen-release-json': '${{ needs.resolve.outputs.frozen }}', 'php-preflight': "'false'" }]);
  assert.ok(packaging.indexOf('prepare-sandbox-runtime') < packaging.indexOf('node scripts/package-dist.mjs --release'));
  const verify = job(pkg, 'verify');
  assert.ok(verify.indexOf('npm test') < verify.indexOf('node scripts/check-expression-parity.mjs'), 'the comparator runs after both legs');
  // What the action downloads is what package.yml uploads.
  for (const name of ['sandbox-guest', 'sandbox-linux', 'sandbox-windows']) {
    assert.match(action, new RegExp(`name: ${name}\\n\\s+path: \\$\\{\\{ github\\.workspace \\}\\}`));
    assert.match(pkg, new RegExp(`name: ${name}\\n\\s+path: \\|`));
  }
});

test('e2e.yml installs the calling run\'s launcher when given one and builds its own otherwise, decided by the input', () => {
  const e2e = workflows['e2e.yml'];
  assert.match(block(block(e2e, 'workflow_call'), 'inputs'), /^sandbox-artifact:\n(?:\s.*\n)*?\s+default: ''\n\s+type: string/m);
  const [call] = sandboxCalls(e2e);
  assert.deepEqual(call.with, { mode: "${{ inputs.sandbox-artifact != '' && 'install' || 'build' }}", artifacts: '${{ inputs.sandbox-artifact }}', 'frozen-release-json': '${{ inputs.frozen-release }}' });
  assert.ok(!/github\.event_name/.test(e2e), 'never the event name');
  assert.ok(e2e.indexOf('uses: ./.github/actions/prepare-hosted-runtime') < call.at && call.at < e2e.indexOf('php bin/provision-demo.php'));
  assert.match(workflows['package.yml'], /uses: \.\/\.github\/workflows\/e2e\.yml\n\s+with:\n\s+frozen-release: \$\{\{ needs\.resolve\.outputs\.frozen \}\}\n\s+sandbox-artifact: sandbox-linux\n/);
});
