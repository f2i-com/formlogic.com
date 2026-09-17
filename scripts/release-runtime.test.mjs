/**
 * What scripts/package-dist.mjs holds a UI build and the zip to, from
 * scripts/release-runtime.mjs: every ZIPP engine the build emitted is the
 * installed release's (found by content, whatever its name), and the zip
 * carries that engine's licences and identity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { checkDistEngines, zippLicensesText, engineIdentity } from './release-runtime.mjs';
import { wasmModule, writeZippTree, zippEngineWasm, zippReleaseFixture } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';

const RELEASE = zippReleaseFixture();

async function tree(t, files) {
  const dir = await mkdtemp(resolve(tmpdir(), 'formlogic-release-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(resolve(dir, path)), { recursive: true });
    await writeFile(resolve(dir, path), data);
  }
  return dir;
}

/** A UI build as Vite writes it: the app's hashed engine, the hosted runtime's and editors' copies, other wasm and assets. */
const uiDist = (extra = {}) => ({
  'index.html': '<!doctype html>',
  'assets/index-abc.js': 'export {};',
  'assets/zipp_wasm_bg-CAyqw9Mx.wasm': RELEASE.wasm,
  'hosted-runtime/assets/core-runtime/zipp_wasm_bg.wasm': RELEASE.wasm,
  'app-editors/studio/assets/zipp_wasm_bg-CAyqw9Mx.wasm': RELEASE.wasm,
  'assets/ort-wasm-simd-threaded.wasm': wasmModule(['run', 'memory_usage'], 'onnxruntime'),
  'assets/tiny.wasm': Buffer.from([0x00, 0x61]),
  ...extra,
});

test('checkDistEngines finds every engine copy by content and requires the app\'s hashed engine among them', async (t) => {
  const dist = await tree(t, uiDist());
  assert.deepEqual(await checkDistEngines(dist, RELEASE.source), ['app-editors/studio/assets/zipp_wasm_bg-CAyqw9Mx.wasm', 'assets/zipp_wasm_bg-CAyqw9Mx.wasm', 'hosted-runtime/assets/core-runtime/zipp_wasm_bg.wasm']);
});

test('checkDistEngines refuses an engine other than the installed release, under the engine\'s name or any other', async (t) => {
  const other = zippReleaseFixture({ version: '0.0.17', revision: 'c'.repeat(40) });
  const fake = await tree(t, uiDist({ 'assets/zipp_wasm_bg-fake.wasm': other.wasm }));
  await assert.rejects(checkDistEngines(fake, RELEASE.source), /formlogic\/ui\/dist\/assets\/zipp_wasm_bg-fake\.wasm is a ZIPP engine \([0-9a-f]{12}\) other than the installed ZIPP v0\.0\.18 \([0-9a-f]{12}\); rebuild the UI/);
  const renamed = await tree(t, uiDist({ 'assets/chunks/engine-9f8e.bin': zippEngineWasm('a stale engine under another name') }));
  await assert.rejects(checkDistEngines(renamed, RELEASE.source), /assets\/chunks\/engine-9f8e\.bin is a ZIPP engine/);
});

test('checkDistEngines refuses a build without the app\'s own engine, and does not follow the staged backend', async (t) => {
  const { 'assets/zipp_wasm_bg-CAyqw9Mx.wasm': _app, ...withoutApp } = uiDist();
  const dist = await tree(t, withoutApp);
  await assert.rejects(checkDistEngines(dist, RELEASE.source), /formlogic\/ui\/dist has no assets\/zipp_wasm_bg-\*\.wasm engine \(found: app-editors\/studio\/assets\/zipp_wasm_bg-CAyqw9Mx\.wasm, hosted-runtime\/assets\/core-runtime\/zipp_wasm_bg\.wasm\)/);
  // api/ is the backend, packaged and checked separately (checkNativeRuntime).
  const withApi = await tree(t, uiDist({ 'api/resources/softn-native/wasm/zipp_wasm_bg.wasm': zippEngineWasm('checked elsewhere') }));
  assert.equal((await checkDistEngines(withApi, RELEASE.source)).length, 3);
});

test('zippLicensesText is the notices file SOURCE.json names, then ZIPP\'s LICENSE-APACHE; a missing licence is refused', async (t) => {
  const dir = await tree(t, {});
  await writeZippTree(dir, RELEASE.files);
  const text = await zippLicensesText(dir, RELEASE.source);
  const notices = RELEASE.files['THIRD_PARTY_LICENSES.txt'].toString().trimEnd();
  assert.ok(text.startsWith(`${notices}\n\n${'='.repeat(78)}\nZIPP v0.0.18 (https://github.com/f2i-com/zipp.org) LICENSE-APACHE\n`), text);
  assert.ok(text.endsWith(RELEASE.files['LICENSE-APACHE'].toString()));
  const renamed = zippReleaseFixture({ noticesFile: 'NOTICE-THIRD-PARTY.txt' });
  const renamedDir = await tree(t, {});
  await writeZippTree(renamedDir, renamed.files);
  assert.ok((await zippLicensesText(renamedDir, renamed.source)).startsWith(notices));
  await rm(resolve(dir, 'LICENSE-APACHE'));
  await assert.rejects(zippLicensesText(dir, RELEASE.source), /formlogic\/ui\/vendor\/zipp-wasm\/LICENSE-APACHE is missing; the zip must carry the ZIPP engine's licences/);
});

test('engineIdentity names the installed release\'s ZIPP record and its Softn release, or the tree\'s own record from a source checkout', () => {
  const softnRelease = { tag: 'v0.0.15', sha256: 'e'.repeat(64), zipp: RELEASE.record };
  assert.deepEqual(engineIdentity(RELEASE.source, softnRelease), { zipp: RELEASE.record, softnRelease: { tag: 'v0.0.15', archiveSha256: 'e'.repeat(64) }, serverSandbox: null });
  assert.deepEqual(engineIdentity(RELEASE.source, null), { zipp: RELEASE.source, softnRelease: null, serverSandbox: null });
});

test('engineIdentity carries the server sandbox: its ZIPP release, the guest and each launcher\'s digest, and who built it', () => {
  const softnRelease = { tag: 'v0.0.15', sha256: 'e'.repeat(64), zipp: RELEASE.record };
  const sandbox = {
    zipp: { release: RELEASE.record.release, revision: RELEASE.record.revision, version: RELEASE.record.version, sumsSha256: RELEASE.record.sumsSha256 },
    guest: { artifact: 'formlogic-runtime-guest.wasm', sha256: '1'.repeat(64) },
    launchers: [{ artifact: 'formlogic-runtime-linux-x86_64', sha256: '2'.repeat(64) }, { artifact: 'formlogic-runtime-windows-x86_64.exe', sha256: '3'.repeat(64) }],
    build: { by: 'ci', runId: '7', runUrl: 'https://github.com/f2i-com/formlogic.com/actions/runs/7', builtAt: '2026-09-15T00:00:00.000Z' },
  };
  assert.deepEqual(engineIdentity(RELEASE.source, softnRelease, sandbox).serverSandbox, {
    zipp: { release: RELEASE.record.release, revision: RELEASE.record.revision },
    guestSha256: '1'.repeat(64),
    launchers: { 'formlogic-runtime-linux-x86_64': '2'.repeat(64), 'formlogic-runtime-windows-x86_64.exe': '3'.repeat(64) },
    build: { by: 'ci', runUrl: 'https://github.com/f2i-com/formlogic.com/actions/runs/7' },
  });
});

// ── The web variant in a build ──────────────────────────────────────────────
// An install with the variant tree puts a SECOND hashed assets/zipp_wasm_bg-*.wasm in the build
// (the same base name: Vite hashes the vendor file it globbed). That is the one place the
// variant's digest may appear, and it must appear there when the variant is installed.
const WITH_WEB = zippReleaseFixture({ webVariant: true });
const webDist = (extra = {}) => ({
  'index.html': '<!doctype html>',
  'assets/index-abc.js': 'export {};',
  'assets/zipp_wasm_bg-CAyqw9Mx.wasm': WITH_WEB.wasm,
  'assets/zipp_wasm_bg-DJYZzo8n.wasm': WITH_WEB.webWasm,
  'hosted-runtime/assets/core-runtime/zipp_wasm_bg.wasm': WITH_WEB.wasm,
  'app-editors/studio/assets/zipp_wasm_bg-CAyqw9Mx.wasm': WITH_WEB.wasm,
  ...extra,
});

test('checkDistEngines accepts the web variant as one more hashed app asset when the install carries it, and requires it then', async (t) => {
  const dist = await tree(t, webDist());
  assert.deepEqual(await checkDistEngines(dist, WITH_WEB.source, { web: WITH_WEB.variant }), ['app-editors/studio/assets/zipp_wasm_bg-CAyqw9Mx.wasm', 'assets/zipp_wasm_bg-CAyqw9Mx.wasm', 'assets/zipp_wasm_bg-DJYZzo8n.wasm', 'hosted-runtime/assets/core-runtime/zipp_wasm_bg.wasm']);
  // A build from before the variant was installed: rebuild, do not ship half an install.
  const { 'assets/zipp_wasm_bg-DJYZzo8n.wasm': _web, ...withoutWeb } = webDist();
  await assert.rejects(checkDistEngines(await tree(t, withoutWeb), WITH_WEB.source, { web: WITH_WEB.variant }), /formlogic\/ui\/dist has no assets\/zipp_wasm_bg-\*\.wasm carrying the installed ZIPP v0\.0\.18 web variant \([0-9a-f]{12}\); the build predates the variant's install/);
  // The variant alone is not the app's engine: the primary's hashed asset is still required.
  const { 'assets/zipp_wasm_bg-CAyqw9Mx.wasm': _app, ...onlyWeb } = webDist();
  await assert.rejects(checkDistEngines(await tree(t, onlyWeb), WITH_WEB.source, { web: WITH_WEB.variant }), /formlogic\/ui\/dist has no assets\/zipp_wasm_bg-\*\.wasm engine \(found: .*assets\/zipp_wasm_bg-DJYZzo8n\.wasm/);
  // Twice is a build nobody asked for.
  await assert.rejects(checkDistEngines(await tree(t, webDist({ 'assets/zipp_wasm_bg-again.wasm': WITH_WEB.webWasm })), WITH_WEB.source, { web: WITH_WEB.variant }), /carries the ZIPP web variant twice \(assets\/zipp_wasm_bg-DJYZzo8n\.wasm, assets\/zipp_wasm_bg-again\.wasm\)/);
});

test('checkDistEngines refuses the web variant under any other name or in any other tree, and as a second engine when the install has no variant', async (t) => {
  // The plan's negative: the web engine copied to another name in assets/.
  const renamed = await tree(t, webDist({ 'assets/other-fake.wasm': WITH_WEB.webWasm }));
  await assert.rejects(checkDistEngines(renamed, WITH_WEB.source, { web: WITH_WEB.variant }), /formlogic\/ui\/dist\/assets\/other-fake\.wasm is the installed ZIPP v0\.0\.18 web variant \([0-9a-f]{12}\) under a name other than the app's hashed engine asset \(assets\/zipp_wasm_bg-\*\.wasm\); the variant is served from that asset alone/);
  // The hosted runtime and the editors carry only the primary.
  const inHosted = await tree(t, webDist({ 'hosted-runtime/assets/zipp_wasm_bg-DJYZzo8n.wasm': WITH_WEB.webWasm }));
  await assert.rejects(checkDistEngines(inHosted, WITH_WEB.source, { web: WITH_WEB.variant }), /hosted-runtime\/assets\/zipp_wasm_bg-DJYZzo8n\.wasm is the installed ZIPP v0\.0\.18 web variant/);
  const inEditor = await tree(t, webDist({ 'app-editors/builder/assets/core-runtime/zipp_wasm_bg.wasm': WITH_WEB.webWasm }));
  await assert.rejects(checkDistEngines(inEditor, WITH_WEB.source, { web: WITH_WEB.variant }), /app-editors\/builder\/assets\/core-runtime\/zipp_wasm_bg\.wasm is the installed ZIPP v0\.0\.18 web variant/);
  // A third engine is refused naming both digests the build may carry.
  const stranger = await tree(t, webDist({ 'assets/zipp_wasm_bg-other.wasm': zippEngineWasm('a third engine') }));
  await assert.rejects(checkDistEngines(stranger, WITH_WEB.source, { web: WITH_WEB.variant }), /assets\/zipp_wasm_bg-other\.wasm is a ZIPP engine \([0-9a-f]{12}\) other than the installed ZIPP v0\.0\.18 \([0-9a-f]{12}\) or its web variant \([0-9a-f]{12}\)/);
  // No variant installed: the same build is a stale second engine, as it always was (the plan's round trip).
  await assert.rejects(checkDistEngines(await tree(t, webDist()), RELEASE.source), /assets\/zipp_wasm_bg-DJYZzo8n\.wasm is a ZIPP engine \([0-9a-f]{12}\) other than the installed ZIPP v0\.0\.18 \([0-9a-f]{12}\); rebuild the UI/);
});
