import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, copyFile, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { checkAppEditors } from './check-app-editors.mjs';
import { runtimeIdentity, writeRuntimeManifest } from './hosted-runtime-artifact.mjs';
import { writeZippTree, zippReleaseFixture } from './zipp-release-fixture.mjs';

const release = zippReleaseFixture();
const wasm = release.wasm;
const expected = runtimeIdentity(release.source);
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

/** The check scripts copied into a repository-shaped folder, so the engine tree and journal they look for are this fixture's. */
async function prebuildRoot(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-prebuild-journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const here = dirname(fileURLToPath(import.meta.url));
  const ui = resolve(root, 'formlogic/ui');
  await mkdir(resolve(ui, 'scripts'), { recursive: true });
  for (const name of ['check-hosted-runtime.mjs', 'check-app-editors.mjs', 'hosted-runtime-artifact.mjs', 'softn-protocol.mjs']) await copyFile(resolve(here, name), resolve(ui, 'scripts', name));
  await mkdir(resolve(ui, 'src/lib/softn'), { recursive: true });
  await copyFile(resolve(here, '../src/lib/softn/protocol.json'), resolve(ui, 'src/lib/softn/protocol.json'));
  await writeZippTree(resolve(ui, 'vendor/zipp-wasm'), release.files);
  await mkdir(resolve(ui, 'public/hosted-runtime'), { recursive: true });
  await writeFile(resolve(ui, 'public/hosted-runtime/index.html'), '<script></script>');
  await writeRuntimeManifest(resolve(ui, 'public/hosted-runtime'), expected);
  await cp(await fixture(t), resolve(ui, 'public/app-editors'), { recursive: true });
  const checks = () => ['check-hosted-runtime.mjs', 'check-app-editors.mjs'].map(script => ({ script, ...spawnSync(process.execPath, [resolve(ui, 'scripts', script)], { cwd: ui, encoding: 'utf8' }) }));
  return { root, ui, checks };
}

test('the prebuild checks refuse while the fetcher\'s promotion journal exists, and pass whole trees without one', async t => {
  const { root, checks } = await prebuildRoot(t);
  for (const { script, status, stderr } of checks()) assert.equal(status, 0, `${script} refused whole trees: ${stderr}`);
  await mkdir(resolve(root, '.runtime-source/softn-release'), { recursive: true });
  await writeFile(resolve(root, '.runtime-source/softn-release/promotion.json'), '{}');
  for (const { script, status, stderr } of checks()) {
    assert.notEqual(status, 0, `${script} passed during an unfinished promotion`);
    assert.match(stderr, /promotion\.json exists.*Run node scripts\/fetch-softn-release\.mjs/);
  }
});

test('the prebuild checks name the fetch when the generated engine tree is missing, and refuse one that is not a ZIPP release', async t => {
  const { ui, checks } = await prebuildRoot(t);
  await rm(resolve(ui, 'vendor/zipp-wasm/SOURCE.json'));
  for (const { script, status, stderr } of checks()) {
    assert.notEqual(status, 0, `${script} passed without an engine`);
    assert.match(stderr, /ZIPP browser engine \(formlogic\/ui\/vendor\/zipp-wasm\) is missing or is not a ZIPP release\. Run node scripts\/fetch-softn-release\.mjs/, script);
  }
  // The committed-era local build: right bytes, but no release it came from.
  const local = { version: release.source.version, sha256: release.source.sha256, revision: release.source.revision, build: 'local' };
  await writeFile(resolve(ui, 'vendor/zipp-wasm/SOURCE.json'), JSON.stringify(local));
  for (const { script, status, stderr } of checks()) {
    assert.notEqual(status, 0, `${script} accepted a local build`);
    assert.match(stderr, /build is local, not release/, script);
  }
});
