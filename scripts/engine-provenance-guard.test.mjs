/**
 * scripts/engine-provenance-guard.mjs over temporary git repositories: what a
 * tracked file may not be (an engine or launcher binary, anything under
 * formlogic/ui/vendor, a zipp_wasm* file, a zipp.org pin in a Cargo.toml),
 * and the sandbox files still allowed until the sandbox is built in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_ALLOWLIST, binaryKind, cargoViolations, findViolations } from './engine-provenance-guard.mjs';
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

test('a repository with no engines passes, and the sandbox files still allowed pass', async (t) => {
  const { root } = await repo(t, {
    ...clean,
    [BINARY_ALLOWLIST[0]]: ELF,
    [BINARY_ALLOWLIST[1]]: pe(),
    [BINARY_ALLOWLIST[2]]: zippEngineWasm('guest stand-in'),
    'formlogic/runtime/guest/Cargo.toml': GUEST_TOML,
    'formlogic/runtime/host/Cargo.toml': '[package]\nname = "formlogic-runtime"\n\n[dependencies]\nwasmtime = { version = "44", default-features = false }\n',
  });
  assert.deepEqual(findViolations({ root }), []);
  assert.deepEqual(BINARY_ALLOWLIST, ['formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64', 'formlogic/backend/bin/runtime/formlogic-runtime-windows-x86_64.exe', 'formlogic/runtime/host/formlogic-runtime-guest.wasm'], 'exactly the three sandbox files');
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

test('a Cargo.toml may not pin a zipp.org source; the guest stays exempt until the sandbox is built from ZIPP source', async (t) => {
  assert.deepEqual(cargoViolations('[dependencies]\nzipp-vm = { path = "../../../.runtime-source/zipp/src/crates/zipp-vm", default-features = false }\n'), []);
  assert.deepEqual(cargoViolations('[dependencies.zipp-regress]\npath = ".runtime-source/zipp/src/crates/zipp-regress"\n'), []);
  assert.match(cargoViolations(GUEST_TOML).join('\n'), /names a zipp\.org source/);
  assert.match(cargoViolations('[dependencies]\nzipp-vm = { git = "https://example.test/mirror.git", tag = "v0.0.18" }\n').join('\n'), /takes zipp-vm other than as a path into \.runtime-source\/zipp\/src/);
  assert.match(cargoViolations('[dev-dependencies]\nzipp-regress = "0.11"\n').join('\n'), /takes zipp-regress other than as a path/);
  assert.match(cargoViolations('[patch."https://github.com/f2i-com/zipp.org"]\nzipp-vm = { path = "../zipp.org/crates/zipp-vm" }\n').join('\n'), /patches a zipp\.org source/);
  assert.match(cargoViolations('[dependencies.zipp-vm]\ngit = "https://example.test/zipp"\n').join('\n'), /\[dependencies\.zipp-vm\] does not take zipp-vm as a path/);
  assert.deepEqual(cargoViolations('# zipp.org is where the engine is developed\n[dependencies]\nserde = "1"\n'), [], 'a comment is not a source');

  const { root } = await repo(t, { ...clean, 'formlogic/runtime/guest/Cargo.toml': GUEST_TOML, 'formlogic/runtime/probe/Cargo.toml': GUEST_TOML });
  const violations = findViolations({ root });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0], /^formlogic\/runtime\/probe\/Cargo\.toml: names a zipp\.org source/);
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
  assert.match(passed.stdout, /no tracked engine binaries or zipp\.org pins/);
});
