import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { artifactFiles, assertNoInterruptedPromotion, checkRuntimeArtifact, checkZippTree, installRuntimeArtifact, isZippEngineWasm, LINKED_ASSET, writeRuntimeManifest, zippReleaseIdentity } from './hosted-runtime-artifact.mjs';
import { wasmModule, writeZippTree, zippEngineWasm, zippReleaseFixture, zippTreeMap } from './zipp-release-fixture.mjs';

const identity = { version: '0.0.17', sha256: 'a'.repeat(64) };

async function fixture(t) {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(resolve(base, 'formlogic-hosted-runtime-test-'));
  assert.equal(dirname(directory), base);
  assert.ok(basename(directory).startsWith('formlogic-hosted-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, 'assets'));
  await writeFile(resolve(directory, 'index.html'), '<script src="./assets/app.js"></script>');
  await writeFile(resolve(directory, 'assets/app.js'), 'export const ready = true;');
  await writeRuntimeManifest(directory, identity);
  return directory;
}

test('accepts a complete build with the same engine identity', async t => {
  const directory = await fixture(t);
  const manifest = await checkRuntimeArtifact(directory, identity);
  assert.deepEqual(manifest.zipp, identity);
  assert.deepEqual(Object.keys(manifest.files), ['assets/app.js', 'index.html']);
});

test('rejects a stale hosted build even when its index still exists', async t => {
  const directory = await fixture(t);
  await assert.rejects(checkRuntimeArtifact(directory, { ...identity, sha256: 'b'.repeat(64) }), /versions do not match/);
});

test('rejects incomplete or modified assets', async t => {
  const directory = await fixture(t);
  await writeFile(resolve(directory, 'assets/app.js'), 'broken build');
  await assert.rejects(checkRuntimeArtifact(directory, identity), /asset has changed/);
  await rm(resolve(directory, 'assets/app.js'));
  await assert.rejects(checkRuntimeArtifact(directory, identity), /missing or stale/);
});

test('rejects obsolete hashed files left behind by a previous build', async t => {
  const directory = await fixture(t);
  await writeFile(resolve(directory, 'assets/old-runtime.js'), 'obsolete');
  await assert.rejects(checkRuntimeArtifact(directory, identity), /missing or stale/);
});

test('lists a tree with or without its root manifest, and refuses a link with a code callers can recognise', async t => {
  const directory = await fixture(t);
  await mkdir(resolve(directory, 'editor'));
  await writeFile(resolve(directory, 'editor/runtime-manifest.json'), '{}');
  assert.deepEqual(await artifactFiles(directory), ['assets/app.js', 'editor/runtime-manifest.json', 'index.html']);
  assert.deepEqual(await artifactFiles(directory, { includeManifest: true }), ['assets/app.js', 'editor/runtime-manifest.json', 'index.html', 'runtime-manifest.json']);
  await symlink(resolve(directory, 'assets'), resolve(directory, 'linked'), 'junction');
  await assert.rejects(artifactFiles(directory), error => error.code === LINKED_ASSET && /must not contain links: linked/.test(error.message));
  await assert.rejects(checkRuntimeArtifact(directory, identity), /must not contain links/);
});

test('refuses while the fetcher has an unfinished promotion, and passes a tree with no .runtime-source', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-promotion-journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assertNoInterruptedPromotion(root);
  await mkdir(resolve(root, '.runtime-source/softn-release'), { recursive: true });
  assertNoInterruptedPromotion(root);
  await writeFile(resolve(root, '.runtime-source/softn-release/promotion.json'), '{');
  assert.throws(() => assertNoInterruptedPromotion(root), /promotion\.json exists.*Run node scripts\/fetch-softn-release\.mjs/);
});

test('copies and re-verifies a staged build when Windows locks directory rename', async t => {
  const staged = await fixture(t);
  const output = await fixture(t);
  await writeFile(resolve(output, 'assets/app.js'), 'old build');
  let moves = 0;
  await installRuntimeArtifact(staged, output, identity, async () => {
    moves++;
    throw Object.assign(new Error('Directory in use'), { code: 'EPERM' });
  });
  assert.equal(moves, 1);
  assert.equal(await readFile(resolve(output, 'assets/app.js'), 'utf8'), 'export const ready = true;');
  await checkRuntimeArtifact(output, identity);
});

test('does not hide unrelated filesystem failures behind the Windows fallback', async t => {
  const staged = await fixture(t);
  const output = await fixture(t);
  await assert.rejects(installRuntimeArtifact(staged, output, identity, async () => {
    throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' });
  }), /Disk unavailable/);
});

// ── The ZIPP engine tree Softn ships (zipp/, installed as vendor/zipp-wasm) ──

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The tree with one file replaced, SOURCE.json optionally rewritten. */
function edited(release, changes = {}, source = null) {
  const files = { ...release.files, ...changes };
  if (source) files['SOURCE.json'] = Buffer.from(JSON.stringify(source(structuredClone(release.source))));
  return zippTreeMap(files);
}

test('zippReleaseIdentity accepts a release record and refuses a local build or a record without its release', () => {
  const { source, record } = zippReleaseFixture();
  assert.deepEqual(zippReleaseIdentity(record), record);
  assert.notEqual(zippReleaseIdentity(record), record, 'a copy, not the caller\'s object');
  assert.deepEqual(zippReleaseIdentity(source), source);
  assert.throws(() => zippReleaseIdentity({ ...record, build: 'local' }), /build is local, not release/);
  assert.throws(() => zippReleaseIdentity({ ...record, release: undefined }), /release \(none\) is not a vX\.Y\.Z tag/);
  assert.throws(() => zippReleaseIdentity({ ...record, release: 'v0.0.19' }), /release v0\.0\.19 is not version 0\.0\.18/);
  assert.throws(() => zippReleaseIdentity({ ...record, revision: undefined }), /revision is not a 40-hex commit/);
  for (const key of ['bundleSha256', 'sumsSha256', 'glueSha256']) assert.throws(() => zippReleaseIdentity({ ...record, [key]: 'abc' }), new RegExp(`${key} is not a SHA-256`));
  // What Softn v0.0.13 and v0.0.14 recorded.
  assert.throws(() => zippReleaseIdentity({ version: '0.0.18', sha256: 'a'.repeat(64), revision: 'b'.repeat(40) }), /not an engine taken from a ZIPP release/);
  assert.throws(() => zippReleaseIdentity(undefined), /missing/);
});

test('isZippEngineWasm finds the engine by its exports, under any name, and ignores other modules and non-wasm bytes', () => {
  const engine = zippEngineWasm('any');
  assert.ok(new WebAssembly.Module(engine), 'the fixture is a valid module');
  assert.equal(isZippEngineWasm(engine), true);
  assert.equal(isZippEngineWasm(new Uint8Array(engine)), true);
  assert.equal(isZippEngineWasm(wasmModule(['run', 'memory_usage'])), false, 'other exports');
  assert.equal(isZippEngineWasm(wasmModule(['zippProfile', 'zipp_start'])), false, 'two of the three names are not the engine');
  assert.equal(isZippEngineWasm(Buffer.from('fixture zipp engine bytes')), false);
  assert.equal(isZippEngineWasm(engine.subarray(0, 30)), false, 'cut inside the export section');
  // Damage after the exports is still an engine copy, so the digest comparison, not the scan, refuses it.
  assert.equal(isZippEngineWasm(engine.subarray(0, engine.length - 12)), true, 'cut after the export section');
  assert.equal(isZippEngineWasm(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])), false, 'a component, not a core module');
  assert.equal(isZippEngineWasm(null), false);
});

const installedEngine = new URL('../vendor/zipp-wasm/zipp_wasm_bg.wasm', import.meta.url);
test('isZippEngineWasm recognises the real engine installed in this tree', { skip: !existsSync(installedEngine) && 'no engine installed (node scripts/fetch-softn-release.mjs)' }, () => {
  assert.equal(isZippEngineWasm(readFileSync(installedEngine)), true);
});

test('checkZippTree accepts a consistent tree from a directory or a map, with the release record or the whole SOURCE.json', async t => {
  const release = zippReleaseFixture();
  assert.deepEqual(await checkZippTree(zippTreeMap(release.files), release.record), release.source);
  assert.deepEqual(await checkZippTree(zippTreeMap(release.files), release.source), release.source);
  const directory = await mkdtemp(resolve(tmpdir(), 'formlogic-zipp-tree-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeZippTree(directory, release.files);
  assert.deepEqual(await checkZippTree(directory, release.record), release.source);
});

test('checkZippTree tolerates bundle files Softn does not ship, and exempts only curated notices from the bundle sums', async () => {
  const release = zippReleaseFixture();
  assert.match(release.files.SHA256SUMS.toString(), /gpu-lab\/LICENSE[\s\S]*host-sdk\/zipp-host\.mjs/, 'the sums list files the tree does not have');
  assert.ok(!release.files.SHA256SUMS.toString().includes('THIRD_PARTY_LICENSES.txt'));
  await checkZippTree(zippTreeMap(release.files), release.record);
  // Notices the bundle itself shipped are held to its sums like any other file.
  const shippedNotices = zippReleaseFixture({ notices: 'zipp-release' });
  await checkZippTree(zippTreeMap(shippedNotices.files), shippedNotices.record);
  await assert.rejects(checkZippTree(edited(release, {}, source => ({ ...source, notices: { ...source.notices, source: 'zipp-release' } })), release.record), /ships THIRD_PARTY_LICENSES\.txt, which ZIPP v0\.0\.18's bundle SHA256SUMS does not list/);
  await assert.rejects(checkZippTree(edited(release, { 'THIRD_PARTY_LICENSES.txt': Buffer.from('edited') }), release.record), /THIRD_PARTY_LICENSES\.txt is missing or differs from SOURCE\.json notices/);
  await assert.rejects(checkZippTree(edited(release, {}, source => { delete source.notices; return source; }), {}), /records no third-party notices/);
  // Notices under another name are followed, curated or shipped by the bundle.
  const renamed = zippReleaseFixture({ noticesFile: 'NOTICE-THIRD-PARTY.txt' });
  await checkZippTree(zippTreeMap(renamed.files), renamed.record);
  const renamedShipped = zippReleaseFixture({ notices: 'zipp-release', noticesFile: 'NOTICE-THIRD-PARTY.txt' });
  await checkZippTree(zippTreeMap(renamedShipped.files), renamedShipped.record);
});

test('checkZippTree refuses curated notices that would exempt a bundle file, or Softn\'s own record, from the bundle sums', async () => {
  const release = zippReleaseFixture();
  // A replaced declaration file named as the notices: without the refusal it would escape the sums, and tsc would trust it.
  const declarations = Buffer.from('declare const anything: any; export default anything;\n');
  const { 'THIRD_PARTY_LICENSES.txt': _notices, ...withoutNotices } = release.files;
  const shadowing = (name, bytes, source = 'softn-curated') => edited({ ...release, files: withoutNotices }, { [name]: bytes }, s => ({ ...s, notices: { file: name, source, sha256: sha256(bytes) } }));
  await assert.rejects(checkZippTree(shadowing('zipp_wasm.d.ts', declarations), release.record), /names zipp_wasm\.d\.ts as its softn-curated notices; that is a file of the ZIPP bundle/);
  await assert.rejects(checkZippTree(shadowing('zipp_wasm_bg.wasm.d.ts', declarations), release.record), /names zipp_wasm_bg\.wasm\.d\.ts as its softn-curated notices/);
  await assert.rejects(checkZippTree(shadowing('PROFILE.json', Buffer.from('{}')), release.record), /names PROFILE\.json as its softn-curated notices/);
  const buildInfo = Buffer.from(`${release.files['BUILD-INFO.txt']}extra=1\n`);
  await assert.rejects(checkZippTree(shadowing('BUILD-INFO.txt', buildInfo), release.record), /names BUILD-INFO\.txt as its softn-curated notices/);
  for (const name of ['SOURCE.json', 'SHA256SUMS', 'RELEASE-SHA256SUMS', 'LICENSE-APACHE']) {
    await assert.rejects(checkZippTree(edited({ ...release, files: withoutNotices }, {}, s => ({ ...s, notices: { ...s.notices, file: name, source: 'zipp-release' } })), release.record), new RegExp(`names ${name.replace('.', '\\.')} as its zipp-release notices`), name);
  }
});

test('checkZippTree refuses a missing declaration file or licence, a shipped file the bundle sums do not list, and an edited bundle file', async () => {
  const release = zippReleaseFixture();
  const { 'zipp_wasm.d.ts': _declarations, ...withoutDeclarations } = release.files;
  await assert.rejects(checkZippTree(zippTreeMap(withoutDeclarations), release.record), /missing zipp_wasm\.d\.ts/);
  const { 'LICENSE-APACHE': _license, ...withoutLicense } = release.files;
  await assert.rejects(checkZippTree(zippTreeMap(withoutLicense), release.record), /missing LICENSE-APACHE/);
  await assert.rejects(checkZippTree(edited(release, { 'extra.js': Buffer.from('not ZIPP\'s') }), release.record), /ships extra\.js, which ZIPP v0\.0\.18's bundle SHA256SUMS does not list/);
  await assert.rejects(checkZippTree(edited(release, { 'zipp_wasm.d.ts': Buffer.from('export {};') }), release.record), /zipp_wasm\.d\.ts differs from ZIPP v0\.0\.18's bundle SHA256SUMS/);
});

test('checkZippTree refuses a wasm or glue that is not the recorded one, and a record that is not the release\'s', async () => {
  const release = zippReleaseFixture();
  const other = zippReleaseFixture({ version: '0.0.19', revision: 'c'.repeat(40) });
  // Consistent with the bundle sums but not with SOURCE.json.
  await assert.rejects(checkZippTree(edited(release, {}, source => ({ ...source, sha256: other.source.sha256 })), {}), /zipp_wasm_bg\.wasm differs from SOURCE\.json sha256/);
  await assert.rejects(checkZippTree(edited(release, {}, source => ({ ...source, glueSha256: other.source.glueSha256 })), {}), /zipp_wasm\.js differs from SOURCE\.json glueSha256/);
  await assert.rejects(checkZippTree(zippTreeMap(release.files), other.record), /SOURCE\.json version is "0\.0\.18"; the release records "0\.0\.19"/);
  await assert.rejects(checkZippTree(zippTreeMap(release.files), { ...release.record, languages: ['javascript'] }), /SOURCE\.json languages is \["javascript","python"\]; the release records \["javascript"\]/);
  await assert.rejects(checkZippTree(edited(release, {}, source => ({ ...source, build: 'local' })), {}), /build is local, not release/);
});

test('checkZippTree holds BUILD-INFO to the recorded commit and build, and RELEASE-SHA256SUMS to the recorded release sums and bundle', async () => {
  const release = zippReleaseFixture();
  const movedCommit = zippReleaseFixture({ buildInfo: text => text.replace(/commit=\w+/, `commit=${'d'.repeat(40)}`) });
  await assert.rejects(checkZippTree(zippTreeMap(movedCommit.files), movedCommit.record), /BUILD-INFO\.txt commit is "d{40}"; SOURCE\.json revision is "a{40}"/);
  const jsOnly = zippReleaseFixture({ buildInfo: text => text.replace('variant=javascript-python', 'variant=javascript').replace('stack-bytes=16777216', 'stack-bytes=1048576') });
  await assert.rejects(checkZippTree(zippTreeMap(jsOnly.files), jsOnly.record), /BUILD-INFO\.txt variant is "javascript"; SOURCE\.json variant is "javascript-python"/);
  const smallStack = zippReleaseFixture({ buildInfo: text => text.replace('stack-bytes=16777216', 'stack-bytes=1048576') });
  await assert.rejects(checkZippTree(zippTreeMap(smallStack.files), smallStack.record), /stack-bytes is 1048576; SOURCE\.json stackBytes is 16777216/);
  const releaseSums = release.files['RELEASE-SHA256SUMS'];
  await assert.rejects(checkZippTree(edited(release, { 'RELEASE-SHA256SUMS': Buffer.concat([releaseSums, Buffer.from(`${'0'.repeat(64)}  extra.zip\n`)]) }), release.record), /RELEASE-SHA256SUMS is not the ZIPP v0\.0\.18 SHA256SUMS SOURCE\.json records/);
  const wrongBundle = Buffer.from(releaseSums.toString().replace(release.source.bundleSha256, 'e'.repeat(64)));
  await assert.rejects(checkZippTree(edited(release, { 'RELEASE-SHA256SUMS': wrongBundle }, source => ({ ...source, sumsSha256: sha256(wrongBundle) })), {}), /does not list zipp-wasm-0\.0\.18-web-python\.zip with the digest SOURCE\.json records/);
});
