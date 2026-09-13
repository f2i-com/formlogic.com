import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { checkAppEditors } from './check-app-editors.mjs';
import { writeRuntimeManifest } from './hosted-runtime-artifact.mjs';

const wasm = 'local fixture engine';
const expected = { version: 'test', sha256: createHash('sha256').update(wasm).digest('hex') };
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-editor-artifact-test-'));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ protocol: 1, editors: ['builder','studio'] }));
  for (const editor of ['builder','studio']) {
    const dir = resolve(root, editor);
    await mkdir(resolve(dir, 'assets'), { recursive: true });
    await writeFile(resolve(dir, 'index.html'), '<script src="./assets/app.js"></script>');
    await writeFile(resolve(dir, 'assets/app.js'), 'local fixture');
    await writeFile(resolve(dir, 'assets/zipp_wasm_bg.wasm'), wasm);
    await writeRuntimeManifest(dir, expected);
  }
  return root;
}
test('validates both complete editor builds', async t => { await checkAppEditors(await fixture(t), expected); });
test('refuses an editor with a missing JavaScript asset', async t => {
  const root = await fixture(t);
  await rm(resolve(root, 'studio/assets/app.js'));
  await assert.rejects(checkAppEditors(root, expected), /missing or stale/);
});
test('refuses mixed engine versions across editors', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'studio/assets/zipp_wasm_bg.wasm'), 'older engine');
  await writeRuntimeManifest(resolve(root, 'studio'), expected);
  await assert.rejects(checkAppEditors(root, expected), /incompatible ZIPP/);
});
