/**
 * scripts/ecosystem-manifest.mjs in a FormLogic-shaped temporary root: the
 * ZIPP release is recorded, not pinned. A manifest generated with one ZIPP
 * release still passes --check once a Softn release ships another (the tree,
 * current.json and the native runtime all moving together), while the
 * equal-bytes invariants between them still fail it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeZippTree, zippReleaseFixture } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROTOCOLS = { nativeProtocol: 1, recordEvents: 1, editorBridge: 1, hostedEngines: 1, logicLanguages: 1 };
const ADAPTER_BODY = 'export const project = 1;\n';

async function put(root, path, data) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), data);
}

/** Install one ZIPP release everywhere a release install puts it: the engine tree, current.json and the native runtime. */
async function install(root, release) {
  await rm(resolve(root, 'formlogic/ui/vendor/zipp-wasm'), { recursive: true, force: true });
  await writeZippTree(resolve(root, 'formlogic/ui/vendor/zipp-wasm'), release.files);
  await put(root, '.runtime-source/softn-release/current.json', JSON.stringify({ tag: 'v0.0.15', commit: 'b'.repeat(40), sha256: 'c'.repeat(64), protocols: PROTOCOLS, zipp: release.record, adapter: { sha256: sha256(ADAPTER_BODY) }, xdb: null }));
  await put(root, 'formlogic/backend/resources/softn-native/host-protocol.json', JSON.stringify({ ...PROTOCOLS, minimumNode: '24.19.0' }));
  await put(root, 'formlogic/backend/resources/softn-native/wasm/zipp_wasm_bg.wasm', release.wasm);
  await put(root, 'formlogic/backend/resources/softn-native/provenance.json', JSON.stringify({ source: 'softn.com/apps/softn-host-php/runtime', nativeProtocol: 1, zipp: release.source, modules: {}, release: { tag: 'v0.0.15', commit: 'b'.repeat(40) } }));
}

async function manifestRoot(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-ecosystem-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts'), { recursive: true });
  await copyFile(resolve(here, 'ecosystem-manifest.mjs'), resolve(root, 'scripts/ecosystem-manifest.mjs'));
  for (const name of ['softn-protocol.mjs', 'hosted-runtime-artifact.mjs']) await put(root, `formlogic/ui/scripts/${name}`, await readFile(resolve(here, `../formlogic/ui/scripts/${name}`)));
  await put(root, 'formlogic/ui/src/lib/softn/protocol.json', JSON.stringify(PROTOCOLS));
  await put(root, 'formlogic/ui/src/lib/softn/provenance.json', JSON.stringify({ source: 'softn.com/packages/@softn/core/src/integrations/formlogic.ts', license: 'Apache-2.0', sha256: sha256(ADAPTER_BODY) }));
  await put(root, 'formlogic/ui/src/lib/softn/project.ts', `// Vendored from SoftN.\n${ADAPTER_BODY}`);
  await put(root, 'formlogic/backend/src/Services/AccountBackupService.php', '<?php\n    public const FORMAT_VERSION = 2;\n    public const SUPPORTED_FORMAT_VERSIONS = [1, 2];\n');
  await put(root, 'formlogic/backend/src/Database/SQLiteConnection.php', '<?php\n    private const SCHEMA_VERSION = 4;\n');
  const run = (...args) => runWith({}, ...args);
  const runWith = (env, ...args) => spawnSync(process.execPath, [resolve(root, 'scripts/ecosystem-manifest.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, SOFTN_REPO: '', SOFTN_FROZEN: '', XDB_REPO: resolve(root, 'no-xdb-checkout'), ...env } });
  return { root, run, runWith };
}

/** A Softn source checkout (SOFTN_REPO) that installed `release` with fetch:zipp, beside the FormLogic root. */
async function softnCheckout(root, release) {
  const softn = resolve(root, 'softn.com');
  await put(softn, '.github/scripts/checkout-xdb.sh', `XDB_COMMIT="${'f'.repeat(40)}"\n`);
  await put(softn, 'apps/softn-host-php/runtime/host-protocol.json', JSON.stringify({ ...PROTOCOLS, minimumNode: '24.19.0' }));
  await put(softn, 'apps/softn-loader/src-tauri/Cargo.toml', '[dependencies]\nxdb = { path = "../../../../xdb.org" }\n');
  await put(softn, 'packages/@softn/core/src/integrations/formlogic.ts', ADAPTER_BODY);
  await writeZippTree(resolve(softn, 'packages/@softn/core/wasm-zipp'), release.files);
  return softn;
}

test('a manifest written with one ZIPP release passes --check after a Softn release moves every copy to another', async (t) => {
  const { root, run } = await manifestRoot(t);
  const first = zippReleaseFixture();
  await install(root, first);
  const written = run();
  assert.equal(written.status, 0, written.stderr);
  const manifest = JSON.parse(await readFile(resolve(root, 'docs/ecosystem/compatibility-manifest.json'), 'utf8'));
  assert.match(manifest.components.zipp.pinnedBy, /^the installed Softn release \(softn-release\.json zipp\), installed at formlogic\/ui\/vendor\/zipp-wasm \(generated\)$/);
  assert.equal(manifest.components.zipp.release, 'v0.0.18');
  assert.equal(manifest.components.zipp.sumsSha256, first.source.sumsSha256);
  assert.equal(manifest.components.zipp.bundleSha256, first.source.bundleSha256);
  assert.deepEqual(manifest.problems, []);
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.stderr);

  // Nothing re-pins: a different, consistent ZIPP identity everywhere still passes against the committed manifest.
  await install(root, zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40) }));
  const moved = run('--check');
  assert.equal(moved.status, 0, `a new ZIPP release must not make the manifest stale: ${moved.stderr}`);
  assert.match(moved.stdout, /zipp v0\.0\.19@dddddddddddd/);
});

test('--check still fails when the native runtime\'s engine bytes or the engine tree\'s record disagree with the release', async (t) => {
  const { root, run } = await manifestRoot(t);
  const release = zippReleaseFixture();
  await install(root, release);
  assert.equal(run().status, 0);
  await writeFile(resolve(root, 'formlogic/backend/resources/softn-native/wasm/zipp_wasm_bg.wasm'), zippReleaseFixture({ version: '0.0.19' }).wasm);
  const nativeBytes = run('--check');
  assert.notEqual(nativeBytes.status, 0);
  assert.match(nativeBytes.stderr, /the prepared native runtime wasm bytes differ from the installed browser engine's/);

  await install(root, release);
  const current = JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8'));
  current.zipp = { ...current.zipp, release: 'v0.0.17', sumsSha256: 'e'.repeat(64) };
  await writeFile(resolve(root, '.runtime-source/softn-release/current.json'), JSON.stringify(current));
  const recordDiffers = run('--check');
  assert.notEqual(recordDiffers.status, 0);
  assert.match(recordDiffers.stderr, /Softn v0\.0\.15 ships ZIPP v0\.0\.17@a{40} .* formlogic\/ui\/vendor\/zipp-wasm is v0\.0\.18@a{40} .*they differ in release, sumsSha256/);

  await install(root, release);
  await writeFile(resolve(root, 'formlogic/ui/vendor/zipp-wasm/zipp_wasm_bg.wasm'), 'edited');
  const treeBytes = run('--check');
  assert.notEqual(treeBytes.status, 0);
  assert.match(treeBytes.stderr, /the installed ZIPP engine bytes \([0-9a-f]{64}\) differ from its SOURCE\.json/);
});

test('without an installed engine tree the manifest names the fetch instead of failing on a missing file', async (t) => {
  const { root, run } = await manifestRoot(t);
  await install(root, zippReleaseFixture());
  await rm(resolve(root, 'formlogic/ui/vendor/zipp-wasm'), { recursive: true, force: true });
  const result = run('--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /formlogic\/ui\/vendor\/zipp-wasm is not installed \(it is generated\): run node scripts\/fetch-softn-release\.mjs/);
});

test('the engine tree carries the release record whatever order a JSON writer gave its keys', async (t) => {
  const { root, run } = await manifestRoot(t);
  const release = zippReleaseFixture();
  await install(root, release);
  assert.equal(run().status, 0);
  const file = resolve(root, '.runtime-source/softn-release/current.json');
  const current = JSON.parse(await readFile(file, 'utf8'));
  // softn-release.json zipp written with its keys, and its notices' keys, in the reverse order of zipp/SOURCE.json.
  const reversed = (value) => Object.fromEntries(Object.entries(value).reverse());
  current.zipp = reversed({ ...release.source, notices: reversed(release.source.notices) });
  await writeFile(file, JSON.stringify(current));
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.stderr);
  // A real difference in the nested record still fails.
  current.zipp = { ...current.zipp, notices: reversed({ ...release.source.notices, source: 'zipp-release' }) };
  await writeFile(file, JSON.stringify(current));
  const differs = run('--check');
  assert.notEqual(differs.status, 0);
  assert.match(differs.stderr, /they differ in notices/);
});

test('a SOFTN_REPO source checkout that installed the same ZIPP release passes --check against the committed release-mode manifest', async (t) => {
  const { root, run, runWith } = await manifestRoot(t);
  const release = zippReleaseFixture();
  await install(root, release);
  assert.equal(run().status, 0, 'the committed manifest describes the release install');
  const softn = await softnCheckout(root, release);
  const checked = runWith({ SOFTN_REPO: softn }, '--check');
  assert.equal(checked.status, 0, checked.stderr);
  // Only the texts naming the mode are set aside: another ZIPP in the checkout is still a problem.
  await writeZippTree(resolve(softn, 'packages/@softn/core/wasm-zipp'), zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40) }).files);
  const other = runWith({ SOFTN_REPO: softn }, '--check');
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /the Softn checkout installed ZIPP v0\.0\.19@d{40} .*Run node scripts\/sync-zipp-from-softn\.mjs/);
  // And release mode still compares pinnedBy.
  const manifestFile = resolve(root, 'docs/ecosystem/compatibility-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.components.zipp.pinnedBy = 'something else';
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  const released = run('--check');
  assert.notEqual(released.status, 0);
  assert.match(released.stderr, /components\.zipp\.pinnedBy: committed "something else"/);
});
