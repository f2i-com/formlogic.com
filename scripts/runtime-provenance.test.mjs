/**
 * scripts/runtime-provenance.mjs over a fixture tree: SOURCE.json is merged
 * from the records each build step leaves (possibly in different CI jobs),
 * and the check refuses a launcher or guest that is not the one recorded, a
 * sandbox built from another ZIPP than the installed Softn release names, and
 * a Softn archive other than the installed (or frozen) one (`--deployed`
 * leaves out those build inputs). The toolchain is ZIPP's release toolchain,
 * and the Linux launcher must be a static x86-64 ELF.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { LAUNCHERS, buildContext, buildInfoRustc, checkSandbox, elfLinkage, guestFeatures, mergeProvenance, pruneLauncher, runtimePaths, rustcInfo, toolchain, toolchainOf, wasmtimeVersion, writeFragment, writeProvenance } from './runtime-provenance.mjs';
import { smokeValue } from './runtime-smoke.mjs';
import { zippReleaseFixture } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'runtime-provenance.mjs');
const builtLinuxLauncher = resolve(dirname(fileURLToPath(import.meta.url)), '../formlogic/backend/bin/runtime', LAUNCHERS.linux.artifact);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REVISION = 'c'.repeat(40);
const RUSTC_WINDOWS = 'rustc 1.92.0 (ded5c06cf 2025-12-08)\nbinary: rustc\ncommit-hash: ded5c06cf\nhost: x86_64-pc-windows-msvc\nrelease: 1.92.0\nLLVM version: 21.1.3\n';
const RUSTC_LINUX = RUSTC_WINDOWS.replace('x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu');
const GUEST_TOML = '[package]\nname = "formlogic-runtime-guest"\n\n[dependencies]\nzipp-vm = { path = "../../../.runtime-source/zipp/src/crates/zipp-vm", default-features = false, features = ["safe-sandbox", "wasm-no-fs-loader", "wasm-single-agent"] }\nserde_json = "1"\n';
const HOST_LOCK = 'version = 4\n\n[[package]]\nname = "wasmtime"\nversion = "44.0.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
const ciEnv = (runId, image = 'ubuntu24') => ({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: runId, GITHUB_REPOSITORY: 'f2i-com/formlogic.com', GITHUB_SERVER_URL: 'https://github.com', ImageOS: image, ImageVersion: '20260907.1' });
const FORMLOGIC = { commit: 'd'.repeat(40), dirty: false };

/** An x86-64 ELF header and two program headers: `type` 2 is static, 3 static-pie; `interpreter` adds the PT_INTERP a dynamically linked binary has. */
function elf({ type = 3, interpreter = false, machine = 62, label = '' } = {}) {
  const bytes = Buffer.alloc(64 + 2 * 56);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2; // 64-bit
  bytes[5] = 1; // little-endian
  bytes[6] = 1;
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(2, 56);
  bytes.writeUInt32LE(6, 64); // PT_PHDR
  bytes.writeUInt32LE(interpreter ? 3 : 1, 64 + 56); // PT_INTERP or PT_LOAD
  return Buffer.concat([bytes, Buffer.from(label)]);
}

/** A tree with Softn installed (naming ZIPP REVISION), its verified ZIPP source stamp, a built guest and both launchers. */
async function tree(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { record } = zippReleaseFixture({ revision: REVISION });
  const files = {
    '.runtime-source/softn-release/current.json': JSON.stringify({ tag: 'v0.0.15', commit: 'e'.repeat(40), sha256: 'a'.repeat(64), zipp: { ...record, rustc: 'rustc 1.92.0 (ded5c06cf 2025-12-08)' } }),
    '.runtime-source/zipp/source.json': JSON.stringify({ repository: 'https://github.com/f2i-com/zipp.org', release: record.release, version: record.version, revision: REVISION, cargoLockSha256: 'b'.repeat(64) }),
    'formlogic/runtime/guest/Cargo.toml': GUEST_TOML,
    'formlogic/runtime/guest/Cargo.lock': 'version = 4\n# generated from ZIPP\'s lock\n',
    'formlogic/runtime/host/Cargo.lock': HOST_LOCK,
    'formlogic/runtime/host/formlogic-runtime-guest.wasm': 'guest wasm',
    'formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64': elf({ label: 'linux launcher' }),
    'formlogic/backend/bin/runtime/formlogic-runtime-windows-x86_64.exe': 'windows launcher',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), text);
  }
  return root;
}

/** Records the guest and both launchers the way one CI run does (guest and Linux in one job, Windows in another). */
function recordAll(root, { runId = '42' } = {}) {
  writeFragment(root, 'guest', { rustcVerbose: RUSTC_LINUX, env: ciEnv(runId) });
  writeFragment(root, 'linux', { rustcVerbose: RUSTC_LINUX, env: ciEnv(runId) });
  writeFragment(root, 'windows', { rustcVerbose: RUSTC_WINDOWS, env: ciEnv(runId, 'win22') });
}

const withoutBuiltAt = (source) => ({ ...source, build: { ...source.build, builtAt: null } });

test('the records of one CI run merge into SOURCE.json, and only the build time differs between two merges', async (t) => {
  const root = await tree(t);
  recordAll(root);
  const first = writeProvenance(root, { formlogic: FORMLOGIC, now: new Date('2026-09-15T00:00:00Z') });
  const second = writeProvenance(root, { formlogic: FORMLOGIC, now: new Date('2026-09-16T00:00:00Z') });
  assert.notEqual(first.build.builtAt, second.build.builtAt);
  assert.deepEqual(withoutBuiltAt(first), withoutBuiltAt(second));
  assert.deepEqual(JSON.parse(await readFile(runtimePaths(root).source, 'utf8')), second);
  assert.deepEqual(first.zipp, { repository: 'https://github.com/f2i-com/zipp.org', release: 'v0.0.18', version: '0.0.18', revision: REVISION, sumsSha256: zippReleaseFixture({ revision: REVISION }).record.sumsSha256, cargoLock: 'Cargo.lock', cargoLockSha256: 'b'.repeat(64) });
  assert.deepEqual(first.softnRelease, { tag: 'v0.0.15', commit: 'e'.repeat(40), archiveSha256: 'a'.repeat(64) });
  assert.deepEqual(first.formlogic, FORMLOGIC);
  assert.deepEqual(first.guest, {
    artifact: 'formlogic-runtime-guest.wasm', sha256: sha256('guest wasm'), target: 'wasm32-wasip1', rustc: 'rustc 1.92.0 (ded5c06cf 2025-12-08)', rustcHost: 'x86_64-unknown-linux-gnu',
    cargoLockSha256: sha256('version = 4\n# generated from ZIPP\'s lock\n'), defaultFeatures: false, features: ['safe-sandbox', 'wasm-no-fs-loader', 'wasm-single-agent'], runner: 'ubuntu24/20260907.1',
  });
  assert.deepEqual(first.host, { wasmtime: '44.0.3' });
  assert.deepEqual(first.launchers.map((launcher) => [launcher.artifact, launcher.target, launcher.linkage ?? null, launcher.runner]), [
    ['formlogic-runtime-linux-x86_64', 'x86_64-unknown-linux-musl', 'static-pie', 'ubuntu24/20260907.1'],
    ['formlogic-runtime-windows-x86_64.exe', 'x86_64-pc-windows-msvc', null, 'win22/20260907.1'],
  ]);
  assert.ok(first.launchers.every((launcher) => launcher.guestSha256 === sha256('guest wasm')));
  assert.deepEqual({ ...first.build, builtAt: null }, { by: 'ci', runId: '42', runUrl: 'https://github.com/f2i-com/formlogic.com/actions/runs/42', builtAt: null });
  assert.equal((await checkSandbox(root, { require: ['linux', 'windows'], ci: true, frozen: null })).zipp.revision, REVISION);
});

test('a launcher or guest that is not the recorded one is refused', async (t) => {
  const root = await tree(t);
  recordAll(root);
  writeProvenance(root, { formlogic: FORMLOGIC });
  const { bin, guestWasm } = runtimePaths(root);
  await writeFile(resolve(bin, LAUNCHERS.linux.artifact), 'another linux launcher');
  await assert.rejects(checkSandbox(root, { frozen: null }), /formlogic-runtime-linux-x86_64 is [0-9a-f]{12}; SOURCE\.json records [0-9a-f]{12}/);
  assert.throws(() => writeProvenance(root, { formlogic: FORMLOGIC }), /formlogic-runtime-linux-x86_64 is not the launcher \.runtime-source\/sandbox\/linux\.json records/);
  await writeFile(resolve(bin, LAUNCHERS.linux.artifact), elf({ label: 'linux launcher' }));
  await writeFile(guestWasm, 'another guest');
  await assert.rejects(checkSandbox(root, { frozen: null }), /formlogic-runtime-guest\.wasm is [0-9a-f]{12}; SOURCE\.json records/);
  assert.throws(() => writeProvenance(root, { formlogic: FORMLOGIC }), /formlogic-runtime-guest\.wasm is not the guest \.runtime-source\/sandbox\/guest\.json records/);
});

test('a launcher built before the guest was rebuilt is refused, and so is one nobody recorded', async (t) => {
  const root = await tree(t);
  recordAll(root);
  const { guestWasm, bin } = runtimePaths(root);
  await writeFile(guestWasm, 'a rebuilt guest');
  writeFragment(root, 'guest', { rustcVerbose: RUSTC_LINUX, env: ciEnv('42') });
  writeFragment(root, 'linux', { rustcVerbose: RUSTC_LINUX, env: ciEnv('42') });
  assert.throws(() => writeProvenance(root, { formlogic: FORMLOGIC }), /formlogic-runtime-windows-x86_64\.exe embeds guest [0-9a-f]{12}, not the recorded guest [0-9a-f]{12}: rebuild it after the guest \(scripts\/build-runtime\.sh windows\)/);
  await rm(resolve(runtimePaths(root).fragments, 'windows.json'));
  writeProvenance(root, { formlogic: FORMLOGIC });
  await assert.rejects(checkSandbox(root, { frozen: null }), /formlogic-runtime-windows-x86_64\.exe is in bin\/runtime but not in SOURCE\.json/);
  await rm(resolve(bin, LAUNCHERS.windows.artifact));
  await checkSandbox(root, { frozen: null });
  await assert.rejects(checkSandbox(root, { frozen: null, require: ['linux', 'windows'] }), /the windows launcher is not recorded/);
});

test('a sandbox built from another ZIPP than the installed Softn release names is refused', async (t) => {
  const root = await tree(t);
  recordAll(root);
  writeProvenance(root, { formlogic: FORMLOGIC });
  const { current } = runtimePaths(root);
  const installed = JSON.parse(await readFile(current, 'utf8'));
  await writeFile(current, JSON.stringify({ ...installed, zipp: { ...installed.zipp, revision: '9'.repeat(40) } }));
  await assert.rejects(checkSandbox(root, { frozen: null }), /the sandbox was built from ZIPP v0\.0\.18 \(cccccccccccc\); the installed Softn release v0\.0\.15 names ZIPP v0\.0\.18 \(999999999999\)/);
  assert.throws(() => writeProvenance(root, { formlogic: FORMLOGIC }), /The guest was built from ZIPP v0\.0\.18 \(cccccccccccc\); the installed Softn release v0\.0\.15 names ZIPP v0\.0\.18 \(999999999999\)\. Rebuild it/);
  const cli = spawnSync(process.execPath, [script, 'check', '--root', root], { encoding: 'utf8', env: { ...process.env, SOFTN_FROZEN: '' } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^runtime-provenance: The server sandbox does not match its provenance:\n  - the sandbox was built from ZIPP/);
});

test('a Softn archive other than the installed one, or than the run froze, is refused', async (t) => {
  const root = await tree(t);
  recordAll(root);
  writeProvenance(root, { formlogic: FORMLOGIC });
  const frozenFile = resolve(root, 'frozen.json');
  const frozen = { formatVersion: 1, repository: 'f2i-com/softn.com', tag: 'v0.0.15', tagCommit: 'e'.repeat(40), assetName: 'softn-formlogic-runtime-v0.0.15.zip', archiveSha256: 'a'.repeat(64) };
  await writeFile(frozenFile, JSON.stringify(frozen));
  await checkSandbox(root, { frozen: frozenFile });
  await writeFile(frozenFile, JSON.stringify({ ...frozen, archiveSha256: 'f'.repeat(64) }));
  await assert.rejects(checkSandbox(root, { frozen: frozenFile }), /recorded against Softn archive aaaaaaaaaaaa; this run froze v0\.0\.15 \(ffffffffffff\): install that release, then record it again \(scripts\/build-runtime\.sh provenance\) if it names ZIPP v0\.0\.18, or rebuild it/);
  const { current } = runtimePaths(root);
  const installed = JSON.parse(await readFile(current, 'utf8'));
  // A newer Softn release naming the same ZIPP: no sandbox byte changed, so recording it again is the fix, not a rebuild.
  await writeFile(current, JSON.stringify({ ...installed, sha256: 'f'.repeat(64) }));
  await assert.rejects(checkSandbox(root, { frozen: null }), /recorded against Softn archive aaaaaaaaaaaa; the installed archive is ffffffffffff: it is still ZIPP v0\.0\.18's sandbox, so record it again \(scripts\/build-runtime\.sh provenance\)/);
  assert.equal(writeProvenance(root, { formlogic: FORMLOGIC }).softnRelease.archiveSha256, 'f'.repeat(64));
  await checkSandbox(root, { frozen: null });
  await writeFile(current, JSON.stringify({ ...installed, sha256: 'e'.repeat(64), zipp: { ...installed.zipp, revision: '9'.repeat(40) } }));
  await assert.rejects(checkSandbox(root, { frozen: null }), /the installed archive is eeeeeeeeeeee: rebuild it for the ZIPP release above/);
});

test('--deployed asks only what a running backend needs: the recorded launchers, of the installed release\'s ZIPP', async (t) => {
  const root = await tree(t);
  recordAll(root);
  writeProvenance(root, { formlogic: FORMLOGIC });
  const { current, guestWasm, bin } = runtimePaths(root);
  const installed = JSON.parse(await readFile(current, 'utf8'));
  // A source checkout given a release zip's bin/runtime: no guest, and a later Softn release naming the same ZIPP.
  await rm(guestWasm);
  await writeFile(current, JSON.stringify({ ...installed, tag: 'v0.0.16', sha256: 'f'.repeat(64) }));
  await assert.rejects(checkSandbox(root, { frozen: null }), /formlogic-runtime-guest\.wasm is missing/);
  await checkSandbox(root, { frozen: null, deployed: true, require: ['linux'] });
  const cli = spawnSync(process.execPath, [script, 'check', '--deployed', '--require', 'linux', '--root', root], { encoding: 'utf8', env: { ...process.env, SOFTN_FROZEN: '' } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^server sandbox OK to run: ZIPP v0\.0\.18/);
  await writeFile(resolve(bin, LAUNCHERS.linux.artifact), elf({ label: 'a launcher from somewhere else' }));
  await assert.rejects(checkSandbox(root, { frozen: null, deployed: true }), /formlogic-runtime-linux-x86_64 is [0-9a-f]{12}; SOURCE\.json records/);
  await writeFile(resolve(bin, LAUNCHERS.linux.artifact), elf({ label: 'linux launcher' }));
  await writeFile(current, JSON.stringify({ ...installed, zipp: { ...installed.zipp, revision: '9'.repeat(40) } }));
  await assert.rejects(checkSandbox(root, { frozen: null, deployed: true }), /the sandbox was built from ZIPP v0\.0\.18 \(cccccccccccc\); the installed Softn release v0\.0\.15 names ZIPP v0\.0\.18 \(999999999999\)/);
});

test('a local or mixed build is recorded as local, and a release takes only one CI run\'s', async (t) => {
  const root = await tree(t);
  recordAll(root);
  writeFragment(root, 'windows', { rustcVerbose: RUSTC_WINDOWS, env: {} });
  const mixed = writeProvenance(root, { formlogic: FORMLOGIC });
  assert.deepEqual({ ...mixed.build, builtAt: null }, { by: 'local', runId: null, runUrl: null, builtAt: null });
  assert.equal(mixed.launchers.find((launcher) => launcher.artifact === LAUNCHERS.windows.artifact).runner, 'local');
  await assert.rejects(checkSandbox(root, { frozen: null, ci: true }), /built by local, not by one CI run/);
  writeFragment(root, 'windows', { rustcVerbose: RUSTC_WINDOWS, env: ciEnv('43', 'win22') });
  assert.equal(writeProvenance(root, { formlogic: FORMLOGIC }).build.by, 'local', 'two runs are not one build');
});

test('a launcher `all` skips stays only if it embeds the guest just built, so the launchers it did build are still recorded', async (t) => {
  // Windows without Docker: `all` rebuilds the guest and the Windows launcher, skips Linux, then prunes linux and records.
  const root = await tree(t);
  recordAll(root);
  const { bin, guestWasm, fragments } = runtimePaths(root);
  const linux = resolve(bin, LAUNCHERS.linux.artifact);
  assert.deepEqual(pruneLauncher(root, 'linux'), [], 'same guest: the earlier Linux launcher is still this sandbox\'s');
  assert.ok(existsSync(linux));
  await writeFile(guestWasm, 'the guest of a newer ZIPP');
  writeFragment(root, 'guest', { rustcVerbose: RUSTC_WINDOWS, env: {} });
  await writeFile(resolve(bin, LAUNCHERS.windows.artifact), 'windows launcher, newer guest');
  writeFragment(root, 'windows', { rustcVerbose: RUSTC_WINDOWS, env: {} });
  assert.throws(() => writeProvenance(root, { formlogic: FORMLOGIC }), /formlogic-runtime-linux-x86_64 embeds guest [0-9a-f]{12}, not the recorded guest/, 'what `all` ran into before it pruned');
  assert.deepEqual(pruneLauncher(root, 'linux'), ['formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64', '.runtime-source/sandbox/linux.json']);
  assert.equal(existsSync(linux), false);
  const source = writeProvenance(root, { formlogic: FORMLOGIC });
  assert.deepEqual(source.launchers.map((launcher) => launcher.artifact), [LAUNCHERS.windows.artifact]);
  await checkSandbox(root, { frozen: null, require: ['windows'] });
  // A Linux launcher nobody recorded (copied in), or a record whose launcher is gone, is not this guest's either.
  await writeFile(linux, elf({ label: 'copied from somewhere' }));
  assert.deepEqual(pruneLauncher(root, 'linux'), ['formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64']);
  await writeFile(resolve(fragments, 'linux.json'), JSON.stringify({ formatVersion: 1, launcher: { artifact: LAUNCHERS.linux.artifact, sha256: 'f'.repeat(64), guestSha256: sha256('the guest of a newer ZIPP') }, build: { by: 'local' } }));
  assert.deepEqual(pruneLauncher(root, 'linux'), ['.runtime-source/sandbox/linux.json']);
  assert.deepEqual(pruneLauncher(root, 'linux'), [], 'nothing left to prune');
  const cli = spawnSync(process.execPath, [script, 'prune', 'linux', '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /no formlogic-runtime-linux-x86_64 to keep/);
  assert.throws(() => pruneLauncher(root, 'macos'), /Unknown launcher platform macos/);
});

test('the toolchain is ZIPP\'s release toolchain (its bundle\'s BUILD-INFO, which the Softn record must repeat), or the guest\'s where no Softn release is installed', async (t) => {
  const root = await tree(t);
  assert.equal(toolchain(root), '1.92.0', 'the Softn record alone');
  const { buildInfo, current } = runtimePaths(root);
  await mkdir(dirname(buildInfo), { recursive: true });
  await writeFile(buildInfo, 'version=0.0.18\r\ncommit=cccc\r\nrustc=rustc 1.92.0 (ded5c06cf 2025-12-08)\r\nwasm-bindgen=wasm-bindgen 0.2.126\r\n');
  assert.equal(toolchain(root), '1.92.0');
  // A Softn packaging slip: the record names a toolchain the bundle was not built with.
  const installed = JSON.parse(await readFile(current, 'utf8'));
  await writeFile(current, JSON.stringify({ ...installed, zipp: { ...installed.zipp, rustc: 'rustc 1.93.0 (01f6ddf75 2026-01-19)' } }));
  assert.throws(() => toolchain(root), /BUILD-INFO\.txt names rustc 1\.92\.0 \(ded5c06cf 2025-12-08\), but the Softn release's ZIPP record says rustc 1\.93\.0/);
  await writeFile(current, JSON.stringify({ ...installed, zipp: { ...installed.zipp, rustc: undefined } }));
  assert.equal(toolchain(root), '1.92.0', 'the bundle alone');
  writeFragment(root, 'guest', { rustcVerbose: RUSTC_LINUX.replace(/1\.92\.0/g, '1.93.1'), env: {} });
  await rm(current);
  await rm(buildInfo);
  assert.equal(toolchain(root), '1.93.1');
  await rm(runtimePaths(root).fragments, { recursive: true });
  assert.throws(() => toolchain(root), /Cannot tell which Rust toolchain to build with/);
  assert.throws(() => toolchainOf('cargo 1.92.0'), /No rustc version/);
});

test('the Linux launcher must be a static x86-64 ELF, read from its own headers', async (t) => {
  assert.equal(elfLinkage(elf({ type: 3 })), 'static-pie');
  assert.equal(elfLinkage(elf({ type: 2 })), 'static');
  assert.throws(() => elfLinkage(elf({ interpreter: true })), /dynamically linked \(it names an ELF interpreter\); it must be a static musl binary/);
  assert.throws(() => elfLinkage(elf({ machine: 183 })), /not a 64-bit little-endian x86-64 ELF/, 'aarch64');
  assert.throws(() => elfLinkage(elf({ type: 1 })), /ELF type 1, not an executable/);
  assert.throws(() => elfLinkage(Buffer.from('#!/bin/sh\necho 42\n')), /not an ELF binary/);
  assert.throws(() => elfLinkage(elf().subarray(0, 100)), /program headers are cut short/);
  const root = await tree(t);
  await writeFile(resolve(runtimePaths(root).bin, LAUNCHERS.linux.artifact), elf({ interpreter: true }));
  assert.throws(() => writeFragment(root, 'linux', { rustcVerbose: RUSTC_LINUX, env: {} }), /dynamically linked/);
  assert.equal(existsSync(resolve(runtimePaths(root).fragments, 'linux.json')), false, 'nothing recorded');
});

test('the Linux launcher this tree built reads as static-pie', { skip: !existsSync(builtLinuxLauncher) && 'no Linux launcher built (scripts/build-runtime.sh linux)' }, () => {
  assert.equal(elfLinkage(readFileSync(builtLinuxLauncher)), 'static-pie');
});

test('record parsers: rustc -Vv, features, wasmtime, BUILD-INFO rustc, who built it, the smoke frame', () => {
  assert.deepEqual(rustcInfo(RUSTC_WINDOWS.replace(/\n/g, '\r\n')), { rustc: 'rustc 1.92.0 (ded5c06cf 2025-12-08)', rustcHost: 'x86_64-pc-windows-msvc' });
  assert.throws(() => rustcInfo(''), /Not rustc -Vv output/);
  assert.deepEqual(guestFeatures(GUEST_TOML), { defaultFeatures: false, features: ['safe-sandbox', 'wasm-no-fs-loader', 'wasm-single-agent'] });
  assert.deepEqual(guestFeatures('[dependencies]\nzipp-vm = { path = "x" }\n'), { defaultFeatures: true, features: [] });
  assert.throws(() => guestFeatures('[dependencies]\nserde = "1"\n'), /no zipp-vm dependency/);
  assert.equal(wasmtimeVersion(HOST_LOCK.replace(/\n/g, '\r\n')), '44.0.3');
  assert.equal(buildInfoRustc('version=0.0.18\r\nrustc=rustc 1.92.0 (ded5c06cf 2025-12-08)\r\n'), 'rustc 1.92.0 (ded5c06cf 2025-12-08)');
  assert.equal(buildInfoRustc('version=0.0.18\n'), null);
  assert.deepEqual(buildContext({}), { by: 'local', runId: null, runUrl: null, runner: 'local' });
  assert.equal(smokeValue('{"type":"log"}\n{"type":"done","results":[{"id":"smoke","ok":true,"value":42}]}\n'), 42);
  assert.throws(() => smokeValue(''), /no done frame/);
  assert.throws(() => smokeValue('{"type":"done","results":[{"id":"smoke","ok":false,"error":"ReferenceError: validators is not defined"}]}'), /the job failed: .*validators is not defined/);
  assert.throws(() => mergeProvenance({ current: { tag: 'v0.0.14', zipp: { version: '0.0.18', sha256: 'a'.repeat(64) } }, guest: null, launchers: [], formlogic: FORMLOGIC, hostLockText: HOST_LOCK }), /The installed Softn release names no ZIPP release/);
});
