import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { artifactFiles, assertNoInterruptedPromotion, checkEntryDocuments, checkRuntimeArtifact, checkZippTree, checkZippVariantTree, installRuntimeArtifact, isZippEngineWasm, LINKED_ASSET, writeRuntimeManifest, zippReleaseIdentity, zippVariantIdentity } from './hosted-runtime-artifact.mjs';
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

test('checkZippTree holds BUILD-INFO to the recorded commit, build and toolchain, and RELEASE-SHA256SUMS to the recorded release sums and bundle', async () => {
  const release = zippReleaseFixture();
  const movedCommit = zippReleaseFixture({ buildInfo: text => text.replace(/commit=\w+/, `commit=${'d'.repeat(40)}`) });
  await assert.rejects(checkZippTree(zippTreeMap(movedCommit.files), movedCommit.record), /BUILD-INFO\.txt commit is "d{40}"; SOURCE\.json revision is "a{40}"/);
  const jsOnly = zippReleaseFixture({ buildInfo: text => text.replace('variant=javascript-python', 'variant=javascript').replace('stack-bytes=16777216', 'stack-bytes=1048576') });
  await assert.rejects(checkZippTree(zippTreeMap(jsOnly.files), jsOnly.record), /BUILD-INFO\.txt variant is "javascript"; SOURCE\.json variant is "javascript-python"/);
  const smallStack = zippReleaseFixture({ buildInfo: text => text.replace('stack-bytes=16777216', 'stack-bytes=1048576') });
  await assert.rejects(checkZippTree(zippTreeMap(smallStack.files), smallStack.record), /stack-bytes is 1048576; SOURCE\.json stackBytes is 16777216/);
  // The server sandbox is built with the toolchain the record names, so the record must be the bundle's.
  const otherToolchain = zippReleaseFixture({ buildInfo: text => text.replace('rustc=rustc 1.92.0 (fixture)', 'rustc=rustc 1.93.0 (fixture)') });
  await assert.rejects(checkZippTree(zippTreeMap(otherToolchain.files), otherToolchain.record), /BUILD-INFO\.txt rustc is "rustc 1\.93\.0 \(fixture\)"; SOURCE\.json rustc is "rustc 1\.92\.0 \(fixture\)"/);
  const releaseSums = release.files['RELEASE-SHA256SUMS'];
  await assert.rejects(checkZippTree(edited(release, { 'RELEASE-SHA256SUMS': Buffer.concat([releaseSums, Buffer.from(`${'0'.repeat(64)}  extra.zip\n`)]) }), release.record), /RELEASE-SHA256SUMS is not the ZIPP v0\.0\.18 SHA256SUMS SOURCE\.json records/);
  const wrongBundle = Buffer.from(releaseSums.toString().replace(release.source.bundleSha256, 'e'.repeat(64)));
  await assert.rejects(checkZippTree(edited(release, { 'RELEASE-SHA256SUMS': wrongBundle }, source => ({ ...source, sumsSha256: sha256(wrongBundle) })), {}), /does not list zipp-wasm-0\.0\.18-web-python\.zip with the digest SOURCE\.json records/);
});

// ── The two entry documents ─────────────────────────────────────────────────
// The shell writes its own Content-Security-Policy from one input: the engine attribute on
// <html>. host.html carries "host-js" and gets 'unsafe-eval'; index.html carries none and keeps
// the policy every hosted app has always run under. Both documents load the SAME shell, so a
// token grep over the entry chunk proves nothing (it is a conditional in a chunk both share) —
// what each document WRITES is evaluated in a real browser by scripts/check-zipp-sharing.mjs.
// What is checkable statically, and is checked here, is the one input and the shared shell.
async function entryFixture(t, { index, host } = {}) {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(resolve(base, 'formlogic-entry-documents-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shell = '<body><script type="module" src="./assets/main-abc.js"></script></body>';
  if (index !== null) await writeFile(resolve(directory, 'index.html'), index ?? `<!doctype html><html>${shell}</html>`);
  if (host !== null) await writeFile(resolve(directory, 'host.html'), host ?? `<!doctype html><html data-softn-logic-engine="host-js">${shell}</html>`);
  return directory;
}

test('accepts the hosted runtime\'s two entry documents: one shell, one attribute apart', async t => {
  await checkEntryDocuments(await entryFixture(t));
});

test('refuses a hosted runtime that carries only the document it has always had', async t => {
  // A Softn from before host.html, or a source build that dropped rollupOptions.input: an owner
  // choosing host-js would be mounted at a path that 404s.
  await assert.rejects(checkEntryDocuments(await entryFixture(t, { host: null })), /has no host\.html: it must carry both entry documents/);
  await assert.rejects(checkEntryDocuments(await entryFixture(t, { index: null })), /has no index\.html/);
});

test('refuses an index.html that declares an engine: its policy must stay the one it has always written', async t => {
  const directory = await entryFixture(t, { index: '<!doctype html><html data-softn-logic-engine="host-js"><body><script type="module" src="./assets/main-abc.js"></script></body></html>' });
  await assert.rejects(checkEntryDocuments(directory), /index\.html declares data-softn-logic-engine="host-js"; it must declare none/);
});

test('refuses a host.html that does not declare the one attribute that gives it its own policy', async t => {
  const shell = '<body><script type="module" src="./assets/main-abc.js"></script></body>';
  await assert.rejects(checkEntryDocuments(await entryFixture(t, { host: `<!doctype html><html>${shell}</html>` })), /host\.html declares data-softn-logic-engine=\(none\)/);
  // An attribute the shell does not know serves NO engine and gets the strict policy, so a
  // document carrying one is a runtime that would silently run nothing.
  await assert.rejects(checkEntryDocuments(await entryFixture(t, { host: `<!doctype html><html data-softn-logic-engine="host-js-worker">${shell}</html>` })), /must declare "host-js"/);
});

test('refuses two documents that do not run the same shell', async t => {
  // If the entry scripts differ, the attribute is not the only difference between them and
  // nothing here can say what the second document's policy would be.
  const directory = await entryFixture(t, { host: '<!doctype html><html data-softn-logic-engine="host-js"><body><script type="module" src="./assets/host-only-xyz.js"></script></body></html>' });
  await assert.rejects(checkEntryDocuments(directory), /both documents must run the same shell/);
});

test('refuses a document with no <html> element or no entry script at all', async t => {
  await assert.rejects(checkEntryDocuments(await entryFixture(t, { index: '<script src="./assets/main-abc.js"></script>' })), /index\.html has no <html> element/);
  await assert.rejects(checkEntryDocuments(await entryFixture(t, { index: '<!doctype html><html><body>nothing</body></html>' })), /index\.html loads no entry script/);
});

// ── The web variant tree ────────────────────────────────────────────────────
// Softn ships ZIPP's JavaScript-only web build as a VARIANT of the same release, in a top-level
// zipp-web/ tree of five files and no glue (it runs under the primary's zipp_wasm.js). What is
// checked is provenance: that it is the same release built again — same commit, same release
// sums, the primary named as its primary — and never the same bytes named twice.

/** The web tree with `changes`, and its SOURCE.json rewritten by `source` when given. */
function editedWeb(release, changes = {}, source = null) {
  const files = { ...release.webFiles, ...changes };
  if (source) files['SOURCE.json'] = Buffer.from(JSON.stringify(source(structuredClone(release.webSource))));
  return zippTreeMap(files);
}

test('zippVariantIdentity accepts the eight-key variant record and refuses a malformed one', () => {
  const { variant } = zippReleaseFixture({ webVariant: true });
  assert.deepEqual(zippVariantIdentity(variant), variant);
  assert.deepEqual(Object.keys(variant), ['bundle', 'bundleSha256', 'sha256', 'glueSha256', 'variant', 'languages', 'stackBytes', 'commit']);
  assert.throws(() => zippVariantIdentity(undefined), /The ZIPP web variant record is missing/);
  assert.throws(() => zippVariantIdentity({ ...variant, sha256: 'not hex' }), /sha256 is not a SHA-256/);
  assert.throws(() => zippVariantIdentity({ ...variant, commit: 'abc' }), /commit is not a 40-hex commit/);
  assert.throws(() => zippVariantIdentity({ ...variant, stackBytes: '1048576' }), /stackBytes is not a positive integer/);
  assert.throws(() => zippVariantIdentity({ ...variant, languages: 'javascript' }), /languages is not a list of names/);
  assert.throws(() => zippVariantIdentity({ ...variant, bundle: '../web.zip' }), /no bundle file name/);
});

test('checkZippVariantTree accepts a consistent web tree from a map or a directory, with or without the release sums, and the primary tree still passes with the variant recorded', async t => {
  const release = zippReleaseFixture({ webVariant: true });
  assert.deepEqual(Object.keys(release.webFiles).sort(), ['BUILD-INFO.txt', 'PROFILE.json', 'SHA256SUMS', 'SOURCE.json', 'zipp_wasm_bg.wasm']);
  assert.match(release.webFiles.SHA256SUMS.toString(), /host-sdk\/zipp-host\.mjs[\s\S]*LICENSE-APACHE[\s\S]*zipp_wasm\.js/, 'the web bundle sums list files Softn does not ship');
  assert.deepEqual(await checkZippVariantTree(zippTreeMap(release.webFiles), release.variant, release.record), release.webSource);
  assert.deepEqual(await checkZippVariantTree(zippTreeMap(release.webFiles), release.variant, release.source, { releaseSums: release.files['RELEASE-SHA256SUMS'] }), release.webSource);
  const directory = await mkdtemp(resolve(tmpdir(), 'formlogic-zipp-web-tree-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeZippTree(directory, release.webFiles);
  assert.deepEqual(await checkZippVariantTree(directory, release.variant, release.record), release.webSource);
  // The primary's record gained one key, `variants`, and the primary tree's SOURCE.json carries it: the existing check passes.
  assert.equal(Object.keys(release.record).at(-1), 'variants');
  assert.deepEqual(await checkZippTree(zippTreeMap(release.files), release.record), release.source);
  // And a primary tree that does NOT carry the variant the release records fails that check.
  const plain = zippReleaseFixture();
  await assert.rejects(checkZippTree(zippTreeMap(plain.files), release.record), /SOURCE\.json variants is \(absent\); the release records \{"web":/);
});

test('checkZippVariantTree refuses a tampered variant file and a variant not built from the release commit', async () => {
  const release = zippReleaseFixture({ webVariant: true });
  // Tampered bytes: the engine against the recorded digest, every other shipped file against the web bundle's sums.
  const replaced = zippEngineWasm('replaced');
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'zipp_wasm_bg.wasm': replaced }), release.variant, release.record), /web variant tree's zipp_wasm_bg\.wasm differs from ZIPP v0\.0\.18's web bundle SHA256SUMS/);
  // With the inner sums rewritten to match, the recorded digest is what refuses it.
  const resummed = Buffer.from(release.webFiles.SHA256SUMS.toString().replace(release.variant.sha256, sha256(replaced)));
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'zipp_wasm_bg.wasm': replaced, SHA256SUMS: resummed }), release.variant, release.record), /web variant tree's zipp_wasm_bg\.wasm differs from the recorded variant sha256/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'BUILD-INFO.txt': Buffer.from(`${release.webFiles['BUILD-INFO.txt']}extra=1\n`) }), release.variant, release.record), /web variant tree's BUILD-INFO\.txt differs from ZIPP v0\.0\.18's web bundle SHA256SUMS/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'PROFILE.json': Buffer.from('{}') }), release.variant, release.record), /web variant tree's PROFILE\.json differs from ZIPP v0\.0\.18's web bundle SHA256SUMS/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'zipp_wasm.js': release.webGlue }), release.variant, release.record), /web variant tree ships zipp_wasm\.js, which .* it runs under the primary's glue/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'extra.txt': Buffer.from('x') }), release.variant, release.record), /web variant tree ships extra\.txt, which ZIPP v0\.0\.18's web bundle SHA256SUMS does not list/);
  const { 'PROFILE.json': _profile, ...withoutProfile } = release.webFiles;
  await assert.rejects(checkZippVariantTree(zippTreeMap(withoutProfile), release.variant, release.record), /web variant tree is missing PROFILE\.json/);
  // The commit: in the record, in the tree's SOURCE.json, and in BUILD-INFO.
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), { ...release.variant, commit: 'd'.repeat(40) }, release.record), /web variant record was built from dddddddddddd; the release is aaaaaaaaaaaa/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, revision: 'd'.repeat(40) })), release.variant, release.record), /web variant tree's SOURCE\.json revision is "d{40}"; the release's is "a{40}"/);
  const movedCommit = zippReleaseFixture({ webVariant: true, webBuildInfo: text => text.replace(/commit=\w+/, `commit=${'d'.repeat(40)}`) });
  await assert.rejects(checkZippVariantTree(zippTreeMap(movedCommit.webFiles), movedCommit.variant, movedCommit.record), /web variant tree's BUILD-INFO\.txt commit is "d{40}"; SOURCE\.json revision is "a{40}"/);
  const bigStack = zippReleaseFixture({ webVariant: true, webBuildInfo: text => text.replace('stack-bytes=1048576', 'stack-bytes=16777216') });
  await assert.rejects(checkZippVariantTree(zippTreeMap(bigStack.webFiles), bigStack.variant, bigStack.record), /web variant tree's BUILD-INFO\.txt stack-bytes is 16777216; SOURCE\.json stackBytes is 1048576/);
});

test('checkZippVariantTree refuses a variant identical to the primary, one that runs Python, and one whose record or primary block is not the release\'s', async () => {
  const release = zippReleaseFixture({ webVariant: true });
  // The same bytes named twice: a fully re-recorded substitution (the primary in the variant tree, both digests rewritten) is refused by the record alone.
  const identical = zippReleaseFixture({ webVariant: true, webWasm: release.wasm });
  assert.equal(identical.variant.sha256, identical.source.sha256);
  await assert.rejects(checkZippVariantTree(zippTreeMap(identical.webFiles), identical.variant, identical.record), /names the primary engine's own digest; a variant is the same source built again, not the same bytes named twice/);
  // The primary's bytes in the variant tree under the genuine record: not the variant.
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'zipp_wasm_bg.wasm': release.wasm }), release.variant, release.record), /zipp_wasm_bg\.wasm differs from ZIPP v0\.0\.18's web bundle SHA256SUMS/);
  const primarySummed = Buffer.from(release.webFiles.SHA256SUMS.toString().replace(release.variant.sha256, release.source.sha256));
  await assert.rejects(checkZippVariantTree(editedWeb(release, { 'zipp_wasm_bg.wasm': release.wasm, SHA256SUMS: primarySummed }), release.variant, release.record), /zipp_wasm_bg\.wasm differs from the recorded variant sha256/);
  // zipp-web is the JavaScript-only build by definition: a variant that runs Python is not it.
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), { ...release.variant, languages: ['javascript', 'python'] }, release.record), /record is variant "javascript" with languages \["javascript","python"\]; zipp-web is the JavaScript-only build/);
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), { ...release.variant, variant: 'javascript-python' }, release.record), /record is variant "javascript-python"/);
  // The record's every key against the tree's SOURCE.json.
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), { ...release.variant, stackBytes: 2097152 }, release.record), /web variant tree's SOURCE\.json stackBytes is 1048576; the release records 2097152/);
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), { ...release.variant, glueSha256: 'e'.repeat(64) }, release.record), /web variant tree's SOURCE\.json glueSha256 is "[0-9a-f]{64}"; the release records "e{64}"/);
  // The tree must be the SAME release as the primary: version, release tag, release sums, build, toolchain.
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, sumsSha256: 'e'.repeat(64) })), release.variant, release.record), /web variant tree's SOURCE\.json sumsSha256 is "e{64}"; the release's is/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, version: '0.0.19', release: 'v0.0.19' })), release.variant, release.record), /web variant tree's SOURCE\.json version is "0\.0\.19"; the release's is "0\.0\.18"/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, build: 'local' })), release.variant, release.record), /web variant tree's SOURCE\.json build is "local"; the release's is "release"/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, rustc: 'rustc 1.93.0 (fixture)' })), release.variant, release.source), /web variant tree's SOURCE\.json rustc is "rustc 1\.93\.0 \(fixture\)"; the release's is "rustc 1\.92\.0 \(fixture\)"/);
  // The primary block names the engine this is a variant OF.
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, primary: { ...s.primary, sha256: 'e'.repeat(64) } })), release.variant, release.record), /web variant tree's SOURCE\.json primary is \{.*"sha256":"e{64}".*\}; the release's engine is zipp-wasm-0\.0\.18-web-python\.zip/);
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => { delete s.primary; return s; }), release.variant, release.record), /web variant tree's SOURCE\.json primary is \(absent\)/);
  // The release sums, when the caller has them: the recorded ZIPP SHA256SUMS, listing the web bundle with the recorded digest.
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), release.variant, release.record, { releaseSums: Buffer.from('not the sums\n') }), /RELEASE-SHA256SUMS has a line that is not/);
  const otherSums = Buffer.from(release.files['RELEASE-SHA256SUMS'].toString().replace(release.variant.bundleSha256, 'e'.repeat(64)));
  await assert.rejects(checkZippVariantTree(zippTreeMap(release.webFiles), release.variant, release.record, { releaseSums: otherSums }), /RELEASE-SHA256SUMS is not the ZIPP v0\.0\.18 SHA256SUMS the release records/);
  const primaryRecordWithOtherSums = { ...release.record, sumsSha256: sha256(otherSums) };
  await assert.rejects(checkZippVariantTree(editedWeb(release, {}, s => ({ ...s, sumsSha256: sha256(otherSums) })), release.variant, primaryRecordWithOtherSums, { releaseSums: otherSums }), /SHA256SUMS does not list zipp-wasm-0\.0\.18-web\.zip with the digest the variant record says/);
});
