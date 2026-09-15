import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, copyFile, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
test('the prebuild checks refuse while the fetcher\'s promotion journal exists, and pass whole trees without one', async t => {
  // The check scripts copied into a repository-shaped folder, so the journal they look for is this fixture's.
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-prebuild-journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const here = dirname(fileURLToPath(import.meta.url));
  const ui = resolve(root, 'formlogic/ui');
  await mkdir(resolve(ui, 'scripts'), { recursive: true });
  for (const name of ['check-hosted-runtime.mjs', 'check-app-editors.mjs', 'hosted-runtime-artifact.mjs', 'softn-protocol.mjs']) await copyFile(resolve(here, name), resolve(ui, 'scripts', name));
  await mkdir(resolve(ui, 'src/lib/softn'), { recursive: true });
  await copyFile(resolve(here, '../src/lib/softn/protocol.json'), resolve(ui, 'src/lib/softn/protocol.json'));
  await mkdir(resolve(ui, 'vendor/zipp-wasm'), { recursive: true });
  await writeFile(resolve(ui, 'vendor/zipp-wasm/SOURCE.json'), JSON.stringify(expected));
  await mkdir(resolve(ui, 'public/hosted-runtime'), { recursive: true });
  await writeFile(resolve(ui, 'public/hosted-runtime/index.html'), '<script></script>');
  await writeRuntimeManifest(resolve(ui, 'public/hosted-runtime'), expected);
  await cp(await fixture(t), resolve(ui, 'public/app-editors'), { recursive: true });
  const checks = () => ['check-hosted-runtime.mjs', 'check-app-editors.mjs'].map(script => ({ script, ...spawnSync(process.execPath, [resolve(ui, 'scripts', script)], { cwd: ui, encoding: 'utf8' }) }));
  for (const { script, status, stderr } of checks()) assert.equal(status, 0, `${script} refused whole trees: ${stderr}`);
  await mkdir(resolve(root, '.runtime-source/softn-release'), { recursive: true });
  await writeFile(resolve(root, '.runtime-source/softn-release/promotion.json'), '{}');
  for (const { script, status, stderr } of checks()) {
    assert.notEqual(status, 0, `${script} passed during an unfinished promotion`);
    assert.match(stderr, /promotion\.json exists.*Run node scripts\/fetch-softn-release\.mjs/);
  }
});
