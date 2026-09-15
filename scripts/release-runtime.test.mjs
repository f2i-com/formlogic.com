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
  assert.deepEqual(engineIdentity(RELEASE.source, softnRelease), { zipp: RELEASE.record, softnRelease: { tag: 'v0.0.15', archiveSha256: 'e'.repeat(64) } });
  assert.deepEqual(engineIdentity(RELEASE.source, null), { zipp: RELEASE.source, softnRelease: null });
});
