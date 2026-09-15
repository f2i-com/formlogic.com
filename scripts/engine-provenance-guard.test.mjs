/**
 * scripts/engine-provenance-guard.mjs over temporary git repositories: what a
 * tracked file may not be (an engine or launcher binary, the sandbox's
 * included, anything under formlogic/ui/vendor, a zipp_wasm* file, a zipp.org
 * pin in a Cargo.toml, ZIPP fetched anywhere under .github but the sandbox action).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_ALLOWLIST, ZIPP_CHECKOUT_ACTION, binaryKind, cargoViolations, findViolations, zippFetchViolations } from './engine-provenance-guard.mjs';
import { zippEngineWasm } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, ...new Array(56).fill(0)]);
function pe() {
  const bytes = Buffer.alloc(0x100);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'latin1');
  return bytes;
}
const GUEST_TOML = '[package]\nname = "formlogic-runtime-guest"\n\n[dependencies]\nzipp-vm = { git = "https://github.com/f2i-com/zipp.org", rev = "127477bd667eaf264a403ebd41c617b857574de2", default-features = false }\n';
const GUEST_PATH_TOML = '[package]\nname = "formlogic-runtime-guest"\n\n[dependencies]\nzipp-vm = { path = "../../../.runtime-source/zipp/src/crates/zipp-vm", default-features = false, features = ["safe-sandbox", "wasm-no-fs-loader", "wasm-single-agent"] }\nserde_json = "1"\n';
const SANDBOX_BINARIES = ['formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64', 'formlogic/backend/bin/runtime/formlogic-runtime-windows-x86_64.exe', 'formlogic/runtime/host/formlogic-runtime-guest.wasm'];
const ZIPP_CHECKOUT_STEP = '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          repository: f2i-com/zipp.org\n          ref: refs/tags/v0.0.18\n          path: .runtime-source/zipp/src\n';

/** A repository with `files` added to its index (nothing committed is needed: the guard reads what is tracked). */
async function repo(t, files) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-provenance-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), data);
  }
  git('add', '-A');
  return { root, git };
}

const clean = { 'README.md': '# FormLogic\n', 'formlogic/ui/src/main.ts': 'export {};\n', 'formlogic/ui/public/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'docs/MZ.md': 'MZ is not a program without a PE signature\n' };

test('binaryKind reads wasm, ELF and PE headers, and not an MZ without a PE signature', () => {
  assert.equal(binaryKind(zippEngineWasm()), 'wasm');
  assert.equal(binaryKind(ELF), 'ELF');
  assert.equal(binaryKind(pe()), 'PE');
  const mzOnly = pe();
  mzOnly.write('XX', 0x80, 'latin1');
  assert.equal(binaryKind(mzOnly), null);
  assert.equal(binaryKind(Buffer.from('MZ')), null);
  assert.equal(binaryKind(Buffer.from('export {};')), null);
});

test('a repository with no engines passes: the guest takes zipp-vm by path, and the sandbox comes from its build', async (t) => {
  const { root } = await repo(t, {
    ...clean,
    'formlogic/runtime/guest/Cargo.toml': GUEST_PATH_TOML,
    'formlogic/runtime/host/Cargo.toml': '[package]\nname = "formlogic-runtime"\n\n[dependencies]\nwasmtime = { version = "44", default-features = false }\n',
    [ZIPP_CHECKOUT_ACTION]: `name: Build or install the server sandbox\nruns:\n  using: composite\n  steps:\n${ZIPP_CHECKOUT_STEP}`,
  });
  assert.deepEqual(findViolations({ root }), []);
  assert.deepEqual(BINARY_ALLOWLIST, [], 'nothing is allowed: the sandbox is built, not committed');
});

test('the sandbox launchers and guest fail like any tracked binary', async (t) => {
  const { root } = await repo(t, { ...clean, [SANDBOX_BINARIES[0]]: ELF, [SANDBOX_BINARIES[1]]: pe(), [SANDBOX_BINARIES[2]]: zippEngineWasm('guest stand-in') });
  const violations = findViolations({ root }).join('\n');
  assert.match(violations, /formlogic-runtime-linux-x86_64: a tracked ELF binary/);
  assert.match(violations, /formlogic-runtime-windows-x86_64\.exe: a tracked PE binary/);
  assert.match(violations, /formlogic-runtime-guest\.wasm: a tracked wasm binary/);
});

test('a tracked wasm under any name, ELF, PE or *.cwasm fails', async (t) => {
  const { root } = await repo(t, { ...clean, 'formlogic/ui/public/assets/engine.bin': zippEngineWasm(), 'tools/runner': ELF, 'tools/runner.exe': pe(), 'formlogic/runtime/host/guest.cwasm': 'precompiled' });
  const violations = findViolations({ root });
  assert.equal(violations.length, 4, violations.join('\n'));
  assert.match(violations.join('\n'), /engine\.bin: a tracked wasm binary/);
  assert.match(violations.join('\n'), /tools\/runner: a tracked ELF binary/);
  assert.match(violations.join('\n'), /tools\/runner\.exe: a tracked PE binary/);
  assert.match(violations.join('\n'), /guest\.cwasm: a precompiled wasm module/);
});

test('anything tracked under formlogic/ui/vendor fails, and so does a zipp_wasm* file anywhere', async (t) => {
  const { root } = await repo(t, { ...clean, 'formlogic/ui/vendor/zipp-wasm/README.md': '# engine notes\n', 'packages/copy/zipp_wasm.js': 'export default function init() {}\n', 'types/zipp_wasm.d.ts': 'export {};\n' });
  const violations = findViolations({ root }).join('\n');
  assert.match(violations, /formlogic\/ui\/vendor\/zipp-wasm\/README\.md: formlogic\/ui\/vendor is generated/);
  assert.match(violations, /packages\/copy\/zipp_wasm\.js: a ZIPP engine file/);
  assert.match(violations, /types\/zipp_wasm\.d\.ts: a ZIPP engine file/);
});

test('a tracked file deleted from the working tree is still held to what the index tracks', async (t) => {
  const { root } = await repo(t, { ...clean, 'formlogic/ui/public/assets/zipp-copy.bin': zippEngineWasm() });
  await rm(resolve(root, 'formlogic/ui/public/assets/zipp-copy.bin'));
  assert.match(findViolations({ root }).join('\n'), /zipp-copy\.bin: a tracked wasm binary/);
});

test('a Cargo.toml may not pin a zipp.org source, the guest\'s included', async (t) => {
  assert.deepEqual(cargoViolations('[dependencies]\nzipp-vm = { path = "../../../.runtime-source/zipp/src/crates/zipp-vm", default-features = false }\n'), []);
  assert.deepEqual(cargoViolations('[dependencies.zipp-regress]\npath = ".runtime-source/zipp/src/crates/zipp-regress"\n'), []);
  assert.match(cargoViolations(GUEST_TOML).join('\n'), /names a zipp\.org source/);
  assert.match(cargoViolations('[dependencies]\nzipp-vm = { git = "https://example.test/mirror.git", tag = "v0.0.18" }\n').join('\n'), /takes zipp-vm other than as a path into \.runtime-source\/zipp\/src/);
  assert.match(cargoViolations('[dev-dependencies]\nzipp-regress = "0.11"\n').join('\n'), /takes zipp-regress other than as a path/);
  assert.match(cargoViolations('[patch."https://github.com/f2i-com/zipp.org"]\nzipp-vm = { path = "../zipp.org/crates/zipp-vm" }\n').join('\n'), /patches a zipp\.org source/);
  assert.match(cargoViolations('[dependencies.zipp-vm]\ngit = "https://example.test/zipp"\n').join('\n'), /\[dependencies\.zipp-vm\] does not take zipp-vm as a path/);
  assert.deepEqual(cargoViolations('# zipp.org is where the engine is developed\n[dependencies]\nserde = "1"\n'), [], 'a comment is not a source');

  assert.deepEqual(cargoViolations(GUEST_PATH_TOML), [], 'the guest\'s path dependency');

  const { root } = await repo(t, { ...clean, 'formlogic/runtime/guest/Cargo.toml': GUEST_TOML, 'formlogic/runtime/probe/Cargo.toml': '[dependencies]\nzipp-vm = { path = "../engines/zipp/crates/zipp-vm" }\n' });
  const violations = findViolations({ root });
  assert.equal(violations.length, 2, violations.join('\n'));
  assert.match(violations[0], /^formlogic\/runtime\/guest\/Cargo\.toml: names a zipp\.org source/);
  assert.match(violations[1], /^formlogic\/runtime\/probe\/Cargo\.toml: takes zipp-vm other than as a path into \.runtime-source\/zipp\/src/);
});

test('only the sandbox action checks out f2i-com/zipp.org', async (t) => {
  const workflow = `name: CI\non: workflow_dispatch\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n${ZIPP_CHECKOUT_STEP}`;
  const { root } = await repo(t, {
    ...clean,
    [ZIPP_CHECKOUT_ACTION]: `runs:\n  using: composite\n  steps:\n${ZIPP_CHECKOUT_STEP}`,
    '.github/workflows/ci.yml': workflow,
    '.github/actions/other/action.yaml': `runs:\n  using: composite\n  steps:\n${ZIPP_CHECKOUT_STEP.replace('f2i-com/zipp.org', "'F2I-com/zipp.org.git'")}`,
    '.github/workflows/notes.yml': '# repository: f2i-com/zipp.org is where the engine is developed\nname: Notes\n',
  });
  const violations = findViolations({ root });
  assert.equal(violations.length, 2, violations.join('\n'));
  assert.match(violations[0], /^\.github\/actions\/other\/action\.yaml: checks out f2i-com\/zipp\.org: repository: 'F2I-com\/zipp\.org\.git' \(only \.github\/actions\/prepare-sandbox-runtime\/action\.yml fetches ZIPP/);
  assert.match(violations[1], /^\.github\/workflows\/ci\.yml: checks out f2i-com\/zipp\.org/);
});

test('no other step under .github fetches ZIPP: not by clone, gh, curl or wget, an unreadable checkout, or the scripts that clone it', async (t) => {
  const fetches = [
    ['git clone --depth 1 https://github.com/f2i-com/zipp.org .runtime-source/zipp/src', /fetches from f2i-com\/zipp\.org: git clone/],
    ['git clone git@github.com:F2I-com/zipp.org.git', /fetches from f2i-com\/zipp\.org/],
    ['gh release download v0.0.18 -R f2i-com/zipp.org -p "*.zip"', /fetches from f2i-com\/zipp\.org: gh release download/],
    ['gh api repos/f2i-com/zipp.org/tarball/v0.0.18 > zipp.tgz', /fetches from f2i-com\/zipp\.org: gh api/],
    ['curl -fsSL https://api.github.com/repos/f2i-com/zipp.org/releases/latest', /fetches from f2i-com\/zipp\.org: curl/],
    ['wget -q https://codeload.github.com/f2i-com/zipp.org/tar.gz/refs/tags/v0.0.18', /fetches from f2i-com\/zipp\.org: wget/],
    ['node scripts/zipp-source.mjs', /clones ZIPP source \(scripts\/zipp-source\.mjs without --identity, --verify or --seed-lock\)/],
    ['ZIPP_SOURCE_DIR=../zipp.org node scripts/zipp-source.mjs --root "$GITHUB_WORKSPACE"', /clones ZIPP source \(scripts\/zipp-source\.mjs/],
    ['bash scripts/build-runtime.sh all', /clones ZIPP source \(scripts\/build-runtime\.sh all\)/],
    ['bash scripts/build-runtime.sh zipp-source guest linux && echo done', /clones ZIPP source \(scripts\/build-runtime\.sh zipp-source guest linux\)/],
    ['bash scripts/build-runtime.sh', /clones ZIPP source \(scripts\/build-runtime\.sh with no step, which is all\)/],
  ];
  const workflow = (lines) => `name: Elsewhere\non: workflow_dispatch\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Build\n        run: |\n${lines.map((line) => `          ${line}\n`).join('')}`;
  for (const [line, reason] of fetches) {
    assert.equal(zippFetchViolations(workflow([line])).length, 1, line);
    assert.match(zippFetchViolations(workflow([line]))[0], reason, line);
  }
  // A checkout whose repository the guard cannot read could be ZIPP's; this repository's own name cannot.
  const checkout = (repository) => `    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          repository: ${repository}\n`;
  assert.match(zippFetchViolations(checkout('${{ inputs.engine-repository }}')).join('\n'), /checks out a repository named by an expression, which could be f2i-com\/zipp\.org \(name it literally\)/);
  assert.match(zippFetchViolations(checkout("'${{ format('{0}/{1}', 'f2i-com', 'zipp.org') }}'")).join('\n'), /named by an expression/);
  assert.deepEqual(zippFetchViolations(checkout('${{ github.repository }}')), []);
  assert.deepEqual(zippFetchViolations(checkout('f2i-com/softn.com')), []);
  // What the workflows do run, and prose about ZIPP, is not a fetch.
  assert.deepEqual(zippFetchViolations(workflow([
    'node scripts/zipp-source.mjs --identity',
    'node scripts/zipp-source.mjs --verify',
    'node --test scripts/zipp-source.test.mjs scripts/runtime-provenance.test.mjs',
    'bash scripts/build-runtime.sh guest linux smoke provenance',
    'bash scripts/build-runtime.sh windows smoke',
    'bash scripts/build-runtime.sh check',
    '# git clone https://github.com/f2i-com/zipp.org is what the sandbox action does instead',
    'echo "the engine is developed at zipp.org" # f2i-com/zipp.org',
  ])), []);

  // In a repository: every file under .github that runs, the sandbox action and prose aside.
  const { root } = await repo(t, {
    ...clean,
    [ZIPP_CHECKOUT_ACTION]: `runs:\n  using: composite\n  steps:\n${ZIPP_CHECKOUT_STEP}      - run: node scripts/zipp-source.mjs --verify\n        shell: bash\n`,
    '.github/workflows/ci.yml': workflow(['bash scripts/build-runtime.sh check']),
    '.github/workflows/nightly.yml': workflow(['gh release download -R f2i-com/zipp.org']),
    '.github/scripts/engine.sh': '#!/usr/bin/env bash\ncurl -L https://github.com/f2i-com/zipp.org/archive/refs/tags/v0.0.18.tar.gz | tar -xz\n',
    '.github/README.md': 'CI builds the sandbox from https://github.com/f2i-com/zipp.org, in the sandbox action.\n',
  });
  const violations = findViolations({ root });
  assert.equal(violations.length, 2, violations.join('\n'));
  assert.match(violations[0], /^\.github\/scripts\/engine\.sh: fetches from f2i-com\/zipp\.org: curl -L/);
  assert.match(violations[1], /^\.github\/workflows\/nightly\.yml: fetches from f2i-com\/zipp\.org: gh release download -R f2i-com\/zipp\.org \(only \.github\/actions\/prepare-sandbox-runtime\/action\.yml fetches ZIPP/);
});

test('the workflows and actions this repository tracks fetch ZIPP only in the sandbox action', () => {
  const tracked = execFileSync('git', ['-C', resolve(here, '..'), 'ls-files', '.github'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tracked.some((path) => path.startsWith('.github/workflows/')), 'the workflows are tracked');
  for (const path of tracked.filter((candidate) => candidate !== ZIPP_CHECKOUT_ACTION && !candidate.endsWith('.md'))) {
    assert.deepEqual(zippFetchViolations(readFileSync(resolve(here, '..', path), 'utf8')), [], path);
  }
  const action = readFileSync(resolve(here, '..', ZIPP_CHECKOUT_ACTION), 'utf8');
  assert.ok(zippFetchViolations(action).length > 0, 'the one action that does fetch it reads as fetching it');
});

test('the CLI exits non-zero naming each violation, and zero on a clean repository', async (t) => {
  const script = resolve(here, 'engine-provenance-guard.mjs');
  const bad = await repo(t, { ...clean, 'formlogic/ui/vendor/zipp-wasm/zipp_wasm_bg.wasm': zippEngineWasm() });
  const failed = spawnSync(process.execPath, [script, '--root', bad.root], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /formlogic\/ui\/vendor\/zipp-wasm\/zipp_wasm_bg\.wasm: formlogic\/ui\/vendor is generated/);
  assert.match(failed.stderr, /zipp_wasm_bg\.wasm: a tracked wasm binary/);
  const good = await repo(t, clean);
  const passed = spawnSync(process.execPath, [script, '--root', good.root], { encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /no tracked engine binaries, zipp\.org pins or ZIPP fetches outside/);
});
