/**
 * scripts/sync-zipp-from-softn.mjs (SOFTN_REPO source mode) against a
 * Softn-shaped checkout whose wasm-zipp/ is generated: the checkout's own
 * fetch-zipp-release.mjs --check must pass first, the tree copied is the whole
 * install, it must be one consistent ZIPP release, and a swap that fails
 * leaves the previous engine tree in place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { syncZippFromSoftn } from './sync-zipp-from-softn.mjs';
import { writeZippTree, zippReleaseFixture } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';

const quiet = { log: () => {} };
// Stands in for Softn's --check: it fails when the checkout has no install, or when told to.
const FETCHER = `import { existsSync } from 'node:fs';
if (!existsSync(new URL('../wasm-zipp/SOURCE.json', import.meta.url)) || existsSync(new URL('../wasm-zipp/.fail-check', import.meta.url))) { console.error('wasm-zipp is not an intact ZIPP release install'); process.exit(1); }
`;

async function roots(t, release = zippReleaseFixture()) {
  const dir = await mkdtemp(resolve(tmpdir(), 'formlogic-sync-zipp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const softnRepo = resolve(dir, 'softn.com');
  await mkdir(resolve(softnRepo, 'packages/@softn/core/scripts'), { recursive: true });
  await writeFile(resolve(softnRepo, 'packages/@softn/core/scripts/fetch-zipp-release.mjs'), FETCHER);
  await writeZippTree(resolve(softnRepo, 'packages/@softn/core/wasm-zipp'), release.files);
  // A checkout at or after Softn installs ZIPP's web build as a variant has wasm-zipp-web/ beside wasm-zipp/.
  if (release.webFiles) await writeZippTree(resolve(softnRepo, 'packages/@softn/core/wasm-zipp-web'), release.webFiles);
  return {
    softnRepo,
    destination: resolve(dir, 'formlogic/ui/vendor/zipp-wasm'),
    webDestination: resolve(dir, 'formlogic/ui/vendor/zipp-wasm-web'),
    wasmZipp: resolve(softnRepo, 'packages/@softn/core/wasm-zipp'),
    wasmZippWeb: resolve(softnRepo, 'packages/@softn/core/wasm-zipp-web'),
  };
}

async function sameTree(directory, files, message) {
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(files).sort(), message);
  for (const [name, bytes] of Object.entries(files)) assert.ok((await readFile(resolve(directory, name))).equals(bytes), `${message}: ${name}`);
}

const refused = (code, path) => Object.assign(new Error(`${code}: operation not permitted, rename '${path}'`), { code });
/** Every directory rename refused, as Windows refuses one while a watcher holds a file inside it. */
const lockedRename = (from) => Promise.reject(refused('EPERM', from));

test('copies the checkout\'s whole installed ZIPP release into the generated engine tree, replacing what was there', async (t) => {
  const release = zippReleaseFixture();
  const { softnRepo, destination } = await roots(t, release);
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, 'stale.js'), 'from another install');
  const source = await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  assert.equal(source.release, 'v0.0.18');
  await sameTree(destination, release.files, 'the engine tree is the install');
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm'], 'no staging or previous directory is left beside it');
});

test('follows the notices file SOURCE.json names, whatever it is called', async (t) => {
  const release = zippReleaseFixture({ notices: 'zipp-release', noticesFile: 'NOTICE-THIRD-PARTY.txt' });
  const { softnRepo, destination } = await roots(t, release);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await sameTree(destination, release.files, 'renamed notices');
  assert.ok(!existsSync(resolve(destination, 'THIRD_PARTY_LICENSES.txt')));
});

test('refuses when the checkout\'s wasm-zipp/ was never installed or fails Softn\'s own check, naming npm run fetch:zipp', async (t) => {
  const { softnRepo, destination, wasmZipp } = await roots(t);
  await writeFile(resolve(wasmZipp, '.fail-check'), '');
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /wasm-zipp\/ is generated: run npm run fetch:zipp there first .*--check failed: wasm-zipp is not an intact ZIPP release install/);
  await rm(wasmZipp, { recursive: true, force: true });
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /run npm run fetch:zipp there first/);
  await rm(resolve(softnRepo, 'packages/@softn/core/scripts/fetch-zipp-release.mjs'));
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /run npm run fetch:zipp there first .*predates Softn installing ZIPP from a release/);
  assert.ok(!existsSync(destination), 'nothing was written');
});

test('refuses an installed set that is incomplete or not one consistent ZIPP release, and leaves the engine tree as it was', async (t) => {
  const release = zippReleaseFixture();
  const { softnRepo, destination, wasmZipp } = await roots(t, release);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await writeFile(resolve(wasmZipp, 'zipp_wasm.d.ts'), 'export {};');
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /zipp_wasm\.d\.ts differs from ZIPP v0\.0\.18's bundle SHA256SUMS/);
  await writeFile(resolve(wasmZipp, 'zipp_wasm.d.ts'), release.files['zipp_wasm.d.ts']);
  await writeFile(resolve(wasmZipp, 'extra.mjs'), 'export {};');
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /ships extra\.mjs, which ZIPP v0\.0\.18's bundle SHA256SUMS does not list/);
  await rm(resolve(wasmZipp, 'RELEASE-SHA256SUMS'));
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /lacks RELEASE-SHA256SUMS/);
  await rm(resolve(wasmZipp, 'THIRD_PARTY_LICENSES.txt'));
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /lacks RELEASE-SHA256SUMS, THIRD_PARTY_LICENSES\.txt/);
  await sameTree(destination, release.files, 'the previous engine tree');
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm']);
});

test('when Windows keeps refusing the directory renames, the swap copies instead and still leaves one whole tree', async (t) => {
  const first = zippReleaseFixture();
  const next = zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40) });
  const { softnRepo, destination, wasmZipp } = await roots(t, first);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await rm(wasmZipp, { recursive: true, force: true });
  await writeZippTree(wasmZipp, next.files);
  const source = await syncZippFromSoftn({ softnRepo, destination, ops: { rename: lockedRename }, ...quiet });
  assert.equal(source.release, 'v0.0.19');
  await sameTree(destination, next.files, 'the new engine tree, copied');
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm'], 'no staging or previous directory is left beside it');
});

test('a move that fails mid-swap puts the previous engine tree back, byte for byte', async (t) => {
  const first = zippReleaseFixture();
  const next = zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40) });
  const { softnRepo, destination, wasmZipp } = await roots(t, first);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await rm(wasmZipp, { recursive: true, force: true });
  await writeZippTree(wasmZipp, next.files);
  // The rename is refused and the copy of the staged tree dies partway: a disk error, not a lock.
  const ops = {
    rename: lockedRename,
    cp: async (from, to, options) => {
      if (!basename(from).startsWith('.zipp-wasm-')) return cp(from, to, options);
      await mkdir(to, { recursive: true });
      await writeFile(resolve(to, 'zipp_wasm.js'), next.files['zipp_wasm.js']);
      throw Object.assign(new Error('EIO: i/o error, copyfile'), { code: 'EIO' });
    },
  };
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ops, ...quiet }), /EIO: i\/o error/);
  await sameTree(destination, first.files, 'the previous engine tree is back');
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm'], 'no staging or previous directory is left beside it');
  // With the rename working and the tree promoted, a promoted tree that fails its check is rolled back too.
  const failingCheck = { rename: async (from, to) => { await rename(from, to); if (basename(from).startsWith('.zipp-wasm-')) await writeFile(resolve(to, 'zipp_wasm_bg.wasm'), 'cut short'); } };
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ops: failingCheck, ...quiet }), /zipp_wasm_bg\.wasm differs from ZIPP v0\.0\.19's bundle SHA256SUMS/);
  await sameTree(destination, first.files, 'the previous engine tree is back after a failed check');
});

test('a sync that died with the previous tree set aside restores it on the next run, even one that is refused', async (t) => {
  const release = zippReleaseFixture();
  const { softnRepo, destination, wasmZipp } = await roots(t, release);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await rename(destination, `${destination}.previous`);
  await mkdir(resolve(destination, '..', '.zipp-wasm-crashed'), { recursive: true });
  await writeFile(resolve(wasmZipp, '.fail-check'), '');
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /--check failed/);
  await sameTree(destination, release.files, 'restored from zipp-wasm.previous');
  await rm(resolve(wasmZipp, '.fail-check'));
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm'], 'the crashed staging directory is swept');
});

// ── The web variant: a checkout at or after Softn installs ZIPP's JavaScript-only build beside the
// engine has wasm-zipp-web/ and a wasm-zipp/SOURCE.json that records variants.web. The sync installs
// it as formlogic/ui/vendor/zipp-wasm-web (the archive path's fifth tree) under the same variant
// check, and a checkout without the variant retires a web tree a previous sync or install left: the
// UI build globs that directory, and the prebuild checks refuse a record naming a variant with no
// tree beside it, or a tree the record does not describe.

test('a checkout whose release records a web variant installs wasm-zipp-web/ as the web variant tree beside the engine tree', async (t) => {
  const release = zippReleaseFixture({ webVariant: true });
  const { softnRepo, destination, webDestination } = await roots(t, release);
  const logged = [];
  const source = await syncZippFromSoftn({ softnRepo, destination, log: (m) => logged.push(m) });
  assert.equal(source.release, 'v0.0.18');
  assert.deepEqual(source.variants, { web: release.variant }, 'the engine record carries the variant');
  await sameTree(destination, release.files, 'the engine tree is the install');
  await sameTree(webDestination, release.webFiles, 'the web variant tree is the checkout\'s wasm-zipp-web/');
  assert.deepEqual((await readdir(resolve(destination, '..'))).sort(), ['zipp-wasm', 'zipp-wasm-web'], 'no staging or previous directory is left beside the two');
  assert.ok(logged.some((m) => new RegExp(`Synced ZIPP v0\\.0\\.18 .* and its web variant \\(${release.variant.sha256.slice(0, 12)}\\)`).test(m)), logged.join('\n'));
});

test('a checkout whose release records no web variant retires a stale web variant tree with the sync', async (t) => {
  const withVariant = zippReleaseFixture({ webVariant: true });
  const { softnRepo, destination, webDestination, wasmZipp, wasmZippWeb } = await roots(t, withVariant);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  assert.ok(existsSync(webDestination));
  // The checkout moves to a release without the variant (an older ZIPP, or Softn no longer shipping it).
  const plain = zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40) });
  await rm(wasmZipp, { recursive: true, force: true });
  await rm(wasmZippWeb, { recursive: true, force: true });
  await writeZippTree(wasmZipp, plain.files);
  const logged = [];
  const source = await syncZippFromSoftn({ softnRepo, destination, log: (m) => logged.push(m) });
  assert.equal(source.release, 'v0.0.19');
  assert.equal(source.variants, undefined);
  await sameTree(destination, plain.files, 'the engine tree is the new install');
  assert.ok(!existsSync(webDestination), 'the stale web variant tree does not survive the sync');
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm'], 'nothing is left beside the engine tree');
  assert.ok(logged.some((m) => /retired .*zipp-wasm-web: the checkout's ZIPP v0\.0\.19 records no web variant/.test(m)), logged.join('\n'));
  // A retire that died with the web tree set aside is resolved on the next run, even one that is refused.
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await mkdir(`${webDestination}.previous`, { recursive: true });
  await writeFile(resolve(`${webDestination}.previous`, 'zipp_wasm_bg.wasm'), 'stale');
  await writeFile(resolve(wasmZipp, '.fail-check'), '');
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /--check failed/);
  assert.ok(existsSync(resolve(webDestination, 'zipp_wasm_bg.wasm')), 'the set-aside web tree is put back before the refusal');
  await rm(resolve(wasmZipp, '.fail-check'));
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  assert.deepEqual(await readdir(resolve(destination, '..')), ['zipp-wasm'], 'and retired again by the sync that succeeds');
});

test('a web variant tree that is not the variant the checkout records is refused by name, and both trees stay as they were', async (t) => {
  const release = zippReleaseFixture({ webVariant: true });
  const { softnRepo, destination, webDestination, wasmZippWeb } = await roots(t, release);
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  // Tampered in the checkout: refused while staging, before anything is swapped.
  await writeFile(resolve(wasmZippWeb, 'zipp_wasm_bg.wasm'), Buffer.concat([release.webWasm, Buffer.from([0])]));
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /Its wasm-zipp-web\/ is not the ZIPP v0\.0\.18 web variant its wasm-zipp\/SOURCE\.json records: The ZIPP web variant tree's zipp_wasm_bg\.wasm differs from ZIPP v0\.0\.18's web bundle SHA256SUMS\./);
  await writeFile(resolve(wasmZippWeb, 'zipp_wasm_bg.wasm'), release.webWasm);
  await writeFile(resolve(wasmZippWeb, 'zipp_wasm.js'), release.webGlue);
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /wasm-zipp-web\/ is not the ZIPP v0\.0\.18 web variant .*ships zipp_wasm\.js, which Softn does not ship for a variant/);
  await rm(resolve(wasmZippWeb, 'zipp_wasm.js'));
  // The primary swapped and the web tree cut short as it lands: both go back.
  const next = zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40), webVariant: true });
  await rm(resolve(softnRepo, 'packages/@softn/core/wasm-zipp'), { recursive: true, force: true });
  await rm(wasmZippWeb, { recursive: true, force: true });
  await writeZippTree(resolve(softnRepo, 'packages/@softn/core/wasm-zipp'), next.files);
  await writeZippTree(wasmZippWeb, next.webFiles);
  const cutShort = { rename: async (from, to) => { await rename(from, to); if (basename(from).startsWith('.zipp-wasm-web-')) await writeFile(resolve(to, 'BUILD-INFO.txt'), 'cut short'); } };
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ops: cutShort, ...quiet }), /wasm-zipp-web\/ is not the ZIPP v0\.0\.19 web variant .*BUILD-INFO\.txt differs from ZIPP v0\.0\.19's web bundle SHA256SUMS/);
  await sameTree(destination, release.files, 'the previous engine tree is back');
  await sameTree(webDestination, release.webFiles, 'the previous web variant tree is back');
  assert.deepEqual((await readdir(resolve(destination, '..'))).sort(), ['zipp-wasm', 'zipp-wasm-web'], 'no staging or previous directory is left beside the two');
  // With nothing in the way, the same checkout installs both.
  await syncZippFromSoftn({ softnRepo, destination, ...quiet });
  await sameTree(destination, next.files, 'the new engine tree');
  await sameTree(webDestination, next.webFiles, 'the new web variant tree');
});

test('a checkout whose SOURCE.json records a web variant but has no wasm-zipp-web/ is refused, and nothing is written', async (t) => {
  const release = zippReleaseFixture({ webVariant: true });
  const { softnRepo, destination, webDestination, wasmZippWeb } = await roots(t, release);
  await rm(wasmZippWeb, { recursive: true, force: true });
  await assert.rejects(syncZippFromSoftn({ softnRepo, destination, ...quiet }), /run npm run fetch:zipp there first .*Its wasm-zipp\/SOURCE\.json records variants\.web but it has no wasm-zipp-web\/ tree beside wasm-zipp\/\./);
  assert.ok(!existsSync(destination) && !existsSync(webDestination), 'nothing was written');
  assert.ok(!existsSync(resolve(destination, '..')), 'not even the vendor directory');
});
