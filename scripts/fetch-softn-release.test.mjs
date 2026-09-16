/**
 * scripts/fetch-softn-release.mjs against an archive built to the contract
 * (softn.com/scripts/package-formlogic-runtime.mjs writes the real one): what
 * is refused, what is installed, and what --check finds afterwards. A
 * temporary FormLogic-shaped root stands in for the repository so nothing
 * here touches the tree.
 *
 * Two groups of regressions come from the 0.1.6 release-readiness review:
 * FL-S01 (one frozen release per run: the frozen record pins tag, commit,
 * asset and digest, and every drift is refused) and FL-S05 (one generation
 * per install: staged whole, promoted whole, recorded with a complete
 * inventory, recovered deterministically after an interruption, and --check
 * refusing a mixture of two releases). The review of that work added the
 * rest of FL-S05's group: a failed promotion rolled back in process, journal
 * and record written whole, a journal that names nothing kept rather than
 * discarded, and a copy fallback that no kill can turn into a partial tree
 * taken for a whole one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp, rename, symlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { writeArchive, readArchive } from './lib/archive.mjs';
import { fetchSoftnRelease, checkInstalled, resolveRelease, resolveOnly, recoverPromotion, loadFrozen, parseSidecar, ReleaseError, SimulatedCrash, FROZEN_FORMAT } from './fetch-softn-release.mjs';
import { assertNoInterruptedPromotion } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';
import { zippReleaseFixture, zippEngineWasm, wasmModule } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The ZIPP release the fixture Softn releases ship, unless a test names another. */
const ZIPP_RELEASE = zippReleaseFixture();
const ZIPP_NEXT = zippReleaseFixture({ version: '0.0.19', revision: 'd'.repeat(40) });
const PROTOCOLS = { nativeProtocol: 1, recordEvents: 1, editorBridge: 1, hostedEngines: 1, logicLanguages: 1 };
const ADAPTER = '/** fixture adapter */\r\nexport const project = 1;\r\n';
const adapterSha = sha256(ADAPTER.replace(/\r\n/g, '\n'));
const COMMIT = 'b'.repeat(40);
const OTHER_COMMIT = 'c'.repeat(40);

function runtimeManifest(files, zipp, advertised = {}) {
  const digests = {};
  for (const [name, data] of Object.entries(files)) digests[name] = sha256(data);
  return Buffer.from(JSON.stringify({ formatVersion: 1, zipp: { version: zipp.version, sha256: zipp.sha256 }, ...advertised, files: digests }, null, 2) + '\n');
}

/**
 * The archive's entries, per the contract (softn.com/scripts/package-formlogic-runtime.mjs):
 * the zipp/ tree, and the same engine in the native runtime and, as hashed and
 * core-runtime assets, in the hosted runtime and both editors.
 */
// `advertised` is what hosted-runtime/runtime-manifest.json says this runtime serves. The default
// carries `python-logic/1` because the default `protocols` speak logicLanguages: the fetcher
// refuses an archive that declares the protocol without advertising the feature.
function archiveEntries({ tag = 'v0.0.13', commit = COMMIT, zippRelease = ZIPP_RELEASE, protocols = PROTOCOLS, adapter = ADAPTER, hostedCode = 'export const hosted = true;', advertised = { features: ['python-logic/1'] } } = {}) {
  const entries = {};
  const put = (name, data) => { entries[name] = Buffer.isBuffer(data) ? data : Buffer.from(data); };
  const { wasm, source, record: zipp } = zippRelease;
  put('README.md', '# Softn runtime for FormLogic\n');
  // the ZIPP release, as Softn installed it
  for (const [n, d] of Object.entries(zippRelease.files)) put(`zipp/${n}`, d);
  // hosted runtime
  // Two entry documents, as `protocols.hostedEngines` declares: host.html is index.html with the
  // one attribute that selects the host-JavaScript engine and its weaker policy.
  // Two entry documents, as `protocols.hostedEngines` declares, shaped like the real ones: the
  // same shell script, and one attribute on <html> that is the whole difference between them.
  const hosted = { 'index.html': Buffer.from('<!doctype html><html><body><script src="./assets/app.js"></script></body></html>'), 'host.html': Buffer.from('<!doctype html><html data-softn-logic-engine="host-js"><body><script src="./assets/app.js"></script></body></html>'), 'assets/app.js': Buffer.from(hostedCode), 'assets/zipp_wasm_bg-hosted.wasm': wasm, 'assets/core-runtime/zipp_wasm_bg.wasm': wasm, 'README.txt': Buffer.from('fixture') };
  for (const [n, d] of Object.entries(hosted)) put(`hosted-runtime/${n}`, d);
  put('hosted-runtime/runtime-manifest.json', runtimeManifest(hosted, zipp, advertised));
  // app editors
  const editors = {};
  for (const editor of ['builder', 'studio']) {
    const files = { 'index.html': Buffer.from(`<script src="./assets/${editor}.js"></script>`), [`assets/${editor}.js`]: Buffer.from(`export const ${editor} = 1;`), 'assets/zipp_wasm_bg-abc.wasm': wasm, 'assets/core-runtime/zipp_wasm_bg.wasm': wasm };
    for (const [n, d] of Object.entries(files)) editors[`${editor}/${n}`] = d;
    editors[`${editor}/runtime-manifest.json`] = runtimeManifest(files, zipp);
  }
  editors['manifest.json'] = Buffer.from(JSON.stringify({ protocol: protocols.editorBridge, editors: ['builder', 'studio'], builtAt: '2026-09-15T00:00:00Z' }));
  for (const [n, d] of Object.entries(editors)) put(`app-editors/${n}`, d);
  put('app-editors/runtime-manifest.json', runtimeManifest(editors, zipp));
  // native runtime
  const modules = {};
  for (const name of ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'record-events.mjs']) modules[name] = Buffer.from(`// ${name}\n`);
  modules['host-protocol.json'] = Buffer.from(JSON.stringify({ nativeProtocol: protocols.nativeProtocol, recordEvents: protocols.recordEvents, minimumNode: '24.19.0' }));
  const moduleDigests = {};
  for (const [n, d] of Object.entries(modules)) { put(`native-runtime/${n}`, d); moduleDigests[n] = sha256(d); }
  put('native-runtime/wasm/zipp_wasm.mjs', zippRelease.glue);
  put('native-runtime/wasm/zipp_wasm_bg.wasm', wasm);
  put('native-runtime/wasm/SOURCE.json', JSON.stringify(source));
  put('native-runtime/LICENSE', 'Apache-2.0 fixture licence');
  put('native-runtime/NOTICE', 'fixture notice');
  put('native-runtime/ZIPP-THIRD-PARTY-LICENSES.txt', zippRelease.files['THIRD_PARTY_LICENSES.txt']);
  put('native-runtime/provenance.json', JSON.stringify({ source: 'softn.com/apps/softn-host-php/runtime', nativeProtocol: protocols.nativeProtocol, zipp: source, modules: moduleDigests }, null, 2));
  // adapter
  put('adapter/formlogic.ts', adapter);
  put('adapter/provenance.json', JSON.stringify({ source: 'softn.com/packages/@softn/core/src/integrations/formlogic.ts', license: 'Apache-2.0', sha256: sha256(adapter.replace(/\r\n/g, '\n')) }));
  return { entries, tag, commit, zipp, protocols, adapter };
}

function releaseManifest({ entries, tag, commit, zipp, protocols, adapter }) {
  const files = {};
  for (const name of Object.keys(entries).sort()) files[name] = sha256(entries[name]);
  return Buffer.from(JSON.stringify({
    formatVersion: 1, tag, commit, version: tag.slice(1), builtAt: '2026-09-15T00:00:00Z',
    zipp, protocols, adapter: { path: 'adapter/formlogic.ts', sha256: sha256(adapter.replace(/\r\n/g, '\n')) }, files,
  }, null, 2) + '\n');
}

/**
 * `edit` changes entries (or the release's zipp record) before the manifest
 * is computed, so the archive stays self-consistent and only the edit's
 * subject can be refused; `tamper` changes entries after it.
 */
async function writeFixtureArchive(dir, options = {}, tamper = null, edit = null) {
  const build = archiveEntries(options);
  if (edit) edit(build.entries, build);
  build.entries['softn-release.json'] = releaseManifest(build);
  if (tamper) tamper(build.entries);
  const out = resolve(dir, `softn-formlogic-runtime-${build.tag}.zip`);
  const written = writeArchive(build.entries, out, { stamp: new Date('2026-09-15T00:00:00Z') });
  return { path: out, sha256: written.sha256, tag: build.tag, commit: build.commit };
}

/**
 * A FormLogic-shaped root: the files the fetcher reads and the folders it
 * writes. It names no ZIPP: the engine tree is the release's to install.
 */
async function formlogicRoot(t, { adapterSha256 = adapterSha, protocols = PROTOCOLS } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-fetch-softn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'formlogic/ui/src/lib/softn'), { recursive: true });
  await mkdir(resolve(root, 'formlogic/ui/public'), { recursive: true });
  await mkdir(resolve(root, 'formlogic/backend/resources'), { recursive: true });
  await writeFile(resolve(root, 'formlogic/ui/src/lib/softn/protocol.json'), JSON.stringify(protocols));
  await writeFile(resolve(root, 'formlogic/ui/src/lib/softn/provenance.json'), JSON.stringify({ source: 'softn.com/packages/@softn/core/src/integrations/formlogic.ts', license: 'Apache-2.0', sha256: adapterSha256 }));
  await writeFile(resolve(root, 'formlogic/ui/src/lib/softn/project.ts'), '// Vendored from SoftN.\n' + ADAPTER.replace(/\r\n/g, '\n'));
  return root;
}

const quiet = { log: () => {} };
const hostedFile = (root) => resolve(root, 'formlogic/ui/public/hosted-runtime/assets/app.js');
const engineFile = (root, name = 'zipp_wasm_bg.wasm') => resolve(root, 'formlogic/ui/vendor/zipp-wasm', name);
const paths = (root) => ({ cache: resolve(root, '.runtime-source/softn-release'), zippWasm: resolve(root, 'formlogic/ui/vendor/zipp-wasm'), hostedRuntime: resolve(root, 'formlogic/ui/public/hosted-runtime'), appEditors: resolve(root, 'formlogic/ui/public/app-editors'), nativeRuntime: resolve(root, 'formlogic/backend/resources/softn-native') });

/**
 * A GitHub API stand-in: releases by tag (with `latest` naming one of them),
 * annotated tags pointing at commits, and asset downloads. `downloads`
 * records every URL fetched that was not an API lookup.
 */
function githubApi({ latest, releases, tagCommits, assetIds = {} }) {
  const downloads = [];
  const releaseJson = (tag, id = 1) => {
    const r = releases[tag];
    return JSON.stringify({ tag_name: tag, target_commitish: r.targetCommitish ?? 'main', html_url: `https://example.test/${tag}`, assets: [
      { id: assetIds[tag] ?? 100, name: `softn-formlogic-runtime-${tag}.zip`, browser_download_url: `https://example.test/${tag}/zip`, url: `https://api.example.test/${tag}/zip` },
      { id: (assetIds[tag] ?? 100) + 1, name: `softn-formlogic-runtime-${tag}.zip.sha256`, browser_download_url: `https://example.test/${tag}/sha`, url: `https://api.example.test/${tag}/sha` },
    ] });
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/releases/latest')) return latest && releases[latest] ? new Response(releaseJson(latest), { status: 200 }) : new Response('', { status: 404 });
    let m = /\/releases\/tags\/([^/]+)$/.exec(url);
    if (m) { const tag = decodeURIComponent(m[1]); return releases[tag] ? new Response(releaseJson(tag), { status: 200 }) : new Response('', { status: 404 }); }
    m = /\/git\/ref\/tags\/([^/]+)$/.exec(url);
    if (m) { const tag = decodeURIComponent(m[1]); return tagCommits[tag] ? new Response(JSON.stringify({ object: { type: 'tag', sha: `tagobject-${tag}` } }), { status: 200 }) : new Response('', { status: 404 }); }
    m = /\/git\/tags\/tagobject-(.+)$/.exec(url);
    if (m) return new Response(JSON.stringify({ object: { type: 'commit', sha: tagCommits[m[1]] } }), { status: 200 });
    downloads.push(url);
    m = /example\.test\/([^/]+)\/(zip|sha)$/.exec(url);
    if (m && releases[m[1]]) return new Response(m[2] === 'zip' ? releases[m[1]].zip : releases[m[1]].sidecar, { status: 200 });
    return new Response('', { status: 404 });
  };
  return { fetchImpl, downloads };
}
async function served(dir, options = {}) {
  const fixture = await writeFixtureArchive(dir, options);
  return { zip: await readFile(fixture.path), sidecar: `${fixture.sha256}  softn-formlogic-runtime-${fixture.tag}.zip\n`, sha256: fixture.sha256, tag: fixture.tag, commit: fixture.commit, path: fixture.path };
}

// ── The archive against the contract and this tree ──────────────────────────

test('a local archive with a good sidecar installs all four trees and records what it installed', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root);
  const record = await fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet });
  assert.equal(record.tag, 'v0.0.13');
  assert.equal(record.commit, COMMIT);
  assert.equal(record.sha256, fixture.sha256);
  assert.deepEqual(record.protocols, PROTOCOLS);
  assert.equal(record.adapter.sha256, adapterSha);
  assert.deepEqual(record.zipp, ZIPP_RELEASE.record);
  // The browser engine is the release's zipp/ tree, byte for byte, at the path the UI imports.
  assert.deepEqual((await readdir(paths(root).zippWasm)).sort(), Object.keys(ZIPP_RELEASE.files).sort());
  assert.ok((await readFile(engineFile(root))).equals(ZIPP_RELEASE.wasm));
  assert.deepEqual(JSON.parse(await readFile(engineFile(root, 'SOURCE.json'), 'utf8')), ZIPP_RELEASE.source);
  assert.deepEqual(await readdir(resolve(root, 'formlogic/ui/vendor')), ['zipp-wasm'], 'no staging or previous engine tree is left behind');
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/index.html')));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/runtime-manifest.json')));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/app-editors/studio/index.html')));
  assert.ok(existsSync(resolve(root, 'formlogic/backend/resources/softn-native/runner.mjs')));
  const provenance = JSON.parse(await readFile(resolve(root, 'formlogic/backend/resources/softn-native/provenance.json'), 'utf8'));
  assert.deepEqual(provenance.release, { tag: 'v0.0.13', commit: COMMIT });
  assert.equal(provenance.nativeProtocol, 1);
  // A release that advertises no ENGINES stamps only what it does advertise; the backend reads
  // hostedRuntime.engines and fails closed to zipp-web-python when it is absent. The feature list
  // is here because a runtime speaking logicLanguages must advertise it to be installable at all.
  assert.deepEqual(provenance.hostedRuntime, { features: ['python-logic/1'], protocols: PROTOCOLS });
  // No staging or previous directories are left behind.
  const publicEntries = await readdir(resolve(root, 'formlogic/ui/public'));
  assert.deepEqual(publicEntries.sort(), ['app-editors', 'hosted-runtime']);
  assert.deepEqual((await readdir(resolve(root, 'formlogic/backend/resources'))).sort(), ['softn-native']);
  const current = JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8'));
  assert.equal(current.tag, 'v0.0.13');
  // The generation is recorded file by file.
  assert.deepEqual(Object.keys(current.generation.inventory).sort(), ['app-editors', 'hosted-runtime', 'native-runtime', 'zipp-wasm']);
  assert.equal(current.generation.inventory['hosted-runtime']['assets/app.js'], sha256('export const hosted = true;'));
  assert.equal(current.generation.inventory['zipp-wasm']['zipp_wasm_bg.wasm'], ZIPP_RELEASE.source.sha256);
  assert.ok(current.generation.inventory['native-runtime']['provenance.json']);
  assert.equal(current.generation.transformed['native-runtime/provenance.json'].transformation, 'release: {tag, commit} and hostedRuntime added');
  assert.ok(!existsSync(resolve(root, '.runtime-source/softn-release/promotion.json')), 'no journal outlives a completed install');
  // --check finds the install intact, and finds a modified asset.
  await checkInstalled({ root, ...quiet });
  await writeFile(hostedFile(root), 'tampered');
  await assert.rejects(checkInstalled({ root, ...quiet }), /hosted-runtime is not the generation .*changed: assets\/app\.js/);
});

test('a second fetch replaces a previous install cleanly', async (t) => {
  const root = await formlogicRoot(t);
  const first = await writeFixtureArchive(root);
  await fetchSoftnRelease({ root, archivePath: first.path, ...quiet });
  await writeFile(resolve(root, 'formlogic/ui/public/hosted-runtime/assets/stale.js'), 'from an older release');
  const again = await writeFixtureArchive(resolve(root, 'again'));
  await fetchSoftnRelease({ root, archivePath: again.path, ...quiet });
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/assets/stale.js')));
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime.previous')), 'the previous generation is dropped once the new one is recorded');
  await checkInstalled({ root, ...quiet });
});

test('a sidecar that does not match the archive is refused before anything is installed', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root);
  await writeFile(`${fixture.path}.sha256`, `${'0'.repeat(64)}  softn-formlogic-runtime-v0.0.13.zip\n`);
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), (e) => e instanceof ReleaseError && /sidecar/.test(e.message));
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')));
});

test('a file whose bytes differ from softn-release.json is refused', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root, {}, (entries) => { entries['hosted-runtime/assets/app.js'] = Buffer.from('not what the manifest says'); });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), /hosted-runtime\/assets\/app\.js has digest/);
});

test('a release with a new ZIPP installs with no change to this tree, and --check holds the engine tree to it', async (t) => {
  const root = await formlogicRoot(t);
  const first = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.15' });
  const next = await writeFixtureArchive(resolve(root, 'b'), { tag: 'v0.0.16', commit: OTHER_COMMIT, zippRelease: ZIPP_NEXT });
  await fetchSoftnRelease({ root, archivePath: first.path, ...quiet });
  const record = await fetchSoftnRelease({ root, archivePath: next.path, ...quiet });
  assert.deepEqual(record.zipp, ZIPP_NEXT.record);
  assert.ok((await readFile(engineFile(root))).equals(ZIPP_NEXT.wasm));
  assert.equal(JSON.parse(await readFile(engineFile(root, 'SOURCE.json'), 'utf8')).release, 'v0.0.19');
  await checkInstalled({ root, ...quiet });
  // A tampered installed engine file fails --check, and so does an engine tree from the other release.
  const bytes = await readFile(engineFile(root));
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(engineFile(root), bytes);
  await assert.rejects(checkInstalled({ root, ...quiet }), /zipp-wasm is not the generation current\.json records for Softn v0\.0\.16 \(changed: zipp_wasm_bg\.wasm\)/);
  await fetchSoftnRelease({ root, archivePath: next.path, ...quiet });
  const currentFile = resolve(root, '.runtime-source/softn-release/current.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  for (const [name, data] of Object.entries(ZIPP_RELEASE.files)) await writeFile(engineFile(root, name), data);
  current.generation.inventory['zipp-wasm'] = Object.fromEntries(Object.entries(ZIPP_RELEASE.files).map(([name, data]) => [name, sha256(data)]));
  await writeFile(currentFile, JSON.stringify(current));
  await assert.rejects(checkInstalled({ root, ...quiet }), /browser engine tree .* is not the ZIPP v0\.0\.19 Softn v0\.0\.16 records: .*version is "0\.0\.18"; the release records "0\.0\.19"/);
});

test('a Softn release without a zipp/ tree or a ZIPP release record is refused and names the first release that has them', async (t) => {
  const root = await formlogicRoot(t);
  const noTree = await writeFixtureArchive(resolve(root, 'no-tree'), { tag: 'v0.0.14' }, null, (entries) => { for (const name of Object.keys(entries)) if (name.startsWith('zipp/')) delete entries[name]; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: noTree.path, ...quiet }), (e) => e instanceof ReleaseError && /Softn v0\.0\.14 does not ship its ZIPP engine .*no zipp\/ tree.*needs Softn v0\.0\.15 or later/.test(e.message));
  // What v0.0.13 and v0.0.14 recorded: a local build, no release, no revision of a release.
  const localBuild = await writeFixtureArchive(resolve(root, 'local'), { tag: 'v0.0.14' }, null, (_entries, build) => { build.zipp = { version: '0.0.18', sha256: build.zipp.sha256, revision: 'e'.repeat(40), build: 'local' }; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: localBuild.path, ...quiet }), /does not ship its ZIPP engine .*release \(none\) is not a vX\.Y\.Z tag.*build is local, not release.*needs Softn v0\.0\.15 or later/);
  const noRevision = await writeFixtureArchive(resolve(root, 'no-revision'), {}, null, (_entries, build) => { build.zipp = { ...build.zipp }; delete build.zipp.revision; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: noRevision.path, ...quiet }), /revision is not a 40-hex commit/);
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/vendor')), 'nothing was installed by any refused archive');
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')));
});

test('the zipp/ tree must be the release the manifest records, and the native runtime must share its engine and glue', async (t) => {
  const root = await formlogicRoot(t);
  const refusedWith = async (label, pattern, edit) => {
    const fixture = await writeFixtureArchive(resolve(root, label), {}, null, edit);
    await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), (e) => e instanceof ReleaseError && pattern.test(e.message), label);
  };
  await refusedWith('record', /zipp\/ in Softn v0\.0\.13 is not the ZIPP v0\.0\.19 .*SOURCE\.json version is "0\.0\.18"; the release records "0\.0\.19"/, (_entries, build) => { build.zipp = ZIPP_NEXT.record; });
  await refusedWith('native-wasm', /native-runtime\/wasm\/zipp_wasm_bg\.wasm is a ZIPP engine .* other than the ZIPP v0\.0\.18 engine|engine bytes differ from the digest its manifest records/, (entries) => { entries['native-runtime/wasm/zipp_wasm_bg.wasm'] = ZIPP_NEXT.wasm; });
  await refusedWith('native-glue', /native-runtime\/wasm\/zipp_wasm\.mjs is not zipp\/zipp_wasm\.js/, (entries) => { entries['native-runtime/wasm/zipp_wasm.mjs'] = Buffer.from('export default {};'); });
  await refusedWith('native-source', /native-runtime\/wasm\/SOURCE\.json names ZIPP 0\.0\.19/, (entries) => { entries['native-runtime/wasm/SOURCE.json'] = Buffer.from(JSON.stringify(ZIPP_NEXT.source)); });
  const buildInfo = zippReleaseFixture({ buildInfo: (text) => text.replace(/commit=\w+/, `commit=${'f'.repeat(40)}`) });
  await refusedWith('build-info', /BUILD-INFO\.txt commit is "f{40}"; SOURCE\.json revision is "a{40}"/, (entries) => { entries['zipp/BUILD-INFO.txt'] = buildInfo.files['BUILD-INFO.txt']; entries['zipp/SHA256SUMS'] = buildInfo.files.SHA256SUMS; });
  await refusedWith('unlisted', /ships extra\.mjs, which ZIPP v0\.0\.18's bundle SHA256SUMS does not list/, (entries) => { entries['zipp/extra.mjs'] = Buffer.from('export {};'); });
  await refusedWith('release-sums', /RELEASE-SHA256SUMS is not the ZIPP v0\.0\.18 SHA256SUMS SOURCE\.json records/, (entries) => { entries['zipp/RELEASE-SHA256SUMS'] = Buffer.concat([entries['zipp/RELEASE-SHA256SUMS'], Buffer.from(`${'0'.repeat(64)}  extra.zip\n`)]); });
  await refusedWith('missing-declarations', /zipp\/ in Softn v0\.0\.13 .*missing zipp_wasm\.d\.ts/, (entries) => { delete entries['zipp/zipp_wasm.d.ts']; });
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/vendor')));
});

test('every ZIPP engine in the archive is found by its content: a stray engine under another name is refused, and so is a missing known copy', async (t) => {
  const root = await formlogicRoot(t);
  const stray = await writeFixtureArchive(resolve(root, 'stray'), {}, null, (entries) => { entries['hosted-runtime/assets/other-abc.wasm'] = zippEngineWasm('a stray older engine'); });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: stray.path, ...quiet }), /hosted-runtime\/assets\/other-abc\.wasm is a ZIPP engine \([0-9a-f]{12}\) other than the ZIPP v0\.0\.18 engine/);
  // A wasm that is not the engine (onnxruntime ships several) is none of the scan's business.
  const unrelated = await writeFixtureArchive(resolve(root, 'unrelated'), {}, null, (entries) => { entries['extras/ort-wasm-simd-threaded.wasm'] = wasmModule(['run', 'memory_usage'], 'onnxruntime'); });
  await fetchSoftnRelease({ root, archivePath: unrelated.path, ...quiet });
  await checkInstalled({ root, ...quiet });
  const missingCopy = await writeFixtureArchive(resolve(root, 'renamed'), {}, null, (entries) => {
    // The editors' hashed engines replaced by bytes the scan does not recognise: the known copies are not all found.
    for (const editor of ['builder', 'studio']) entries[`app-editors/${editor}/assets/zipp_wasm_bg-abc.wasm`] = Buffer.from('not a module');
  });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: missingCopy.path, ...quiet }), /No ZIPP engine copy matches app-editors\/builder\/assets\/zipp_wasm_bg-\*\.wasm, app-editors\/studio\/assets\/zipp_wasm_bg-\*\.wasm in/);
  // Every known copy is required, not one per folder: a release without the hosted runtime's core-runtime engine
  // would install here and fail only at packaging (checkReleaseRuntime).
  const noCoreRuntime = await writeFixtureArchive(resolve(root, 'no-core-runtime'), {}, null, (entries) => { delete entries['hosted-runtime/assets/core-runtime/zipp_wasm_bg.wasm']; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: noCoreRuntime.path, ...quiet }), (e) => e instanceof ReleaseError && /No ZIPP engine copy matches hosted-runtime\/assets\/core-runtime\/zipp_wasm_bg\.wasm in Softn v0\.0\.13 \(found: .*hosted-runtime\/assets\/zipp_wasm_bg-hosted\.wasm/.test(e.message));
  const noEditorCore = await writeFixtureArchive(resolve(root, 'no-editor-core'), {}, null, (entries) => { delete entries['app-editors/studio/assets/core-runtime/zipp_wasm_bg.wasm']; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: noEditorCore.path, ...quiet }), /No ZIPP engine copy matches app-editors\/studio\/assets\/core-runtime\/zipp_wasm_bg\.wasm in/);
  const noLicense = await writeFixtureArchive(resolve(root, 'no-license'), {}, null, (entries) => { delete entries['zipp/LICENSE-APACHE']; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: noLicense.path, ...quiet }), /zipp\/ in Softn v0\.0\.13 .*missing LICENSE-APACHE/);
});

test('a release speaking another protocol version is refused', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root, { protocols: { ...PROTOCOLS, nativeProtocol: 2 } });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), /speaks nativeProtocol 2; this FormLogic speaks 1/);
});

test('a Softn from before the second hosted-runtime document is refused: it speaks no hostedEngines', async (t) => {
  // This tree serves host.html for the host-js engine, so an archive whose runtime has only the
  // one entry document cannot supply what an owner's choice would mount. The pairing is the
  // ordinary protocol rule, and the refusal names the key and both versions.
  const root = await formlogicRoot(t);
  const { hostedEngines: _dropped, ...older } = PROTOCOLS;
  const fixture = await writeFixtureArchive(root, { protocols: older });
  await assert.rejects(
    fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }),
    /Softn v0\.0\.13 speaks hostedEngines undefined; this FormLogic speaks 1\./
  );
  // And nothing was installed from it.
  assert.equal(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/index.html')), false);
});

test('an install that predates hostedEngines fails --check rather than passing as intact', async (t) => {
  // The same rule on the read path: a tree whose current.json records the older protocol set is
  // a runtime this FormLogic would only half use, and --check says so instead of vouching for it.
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root);
  await fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet });
  await checkInstalled({ root, ...quiet });
  const currentFile = resolve(paths(root).cache, 'current.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  delete current.protocols.hostedEngines;
  await writeFile(currentFile, JSON.stringify(current));
  await assert.rejects(
    checkInstalled({ root, ...quiet }),
    /The installed Softn v0\.0\.13 speaks hostedEngines undefined; this tree speaks 1\. Fetch again\./
  );
});

test('a Softn from before the .py logic rule is refused: it speaks no logicLanguages', async (t) => {
  // This tree derives an app's logic languages from its client file NAMES and clamps a `.py` app
  // onto zipp-web-python (backend RuntimeEngineService::languagesOf). A runtime that does not
  // follow the same rule would inline that file as JavaScript, so it is never installed.
  const root = await formlogicRoot(t);
  const { logicLanguages: _dropped, ...older } = PROTOCOLS;
  const fixture = await writeFixtureArchive(root, { protocols: older });
  await assert.rejects(
    fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }),
    /Softn v0\.0\.13 speaks logicLanguages undefined; this FormLogic speaks 1\./
  );
  assert.equal(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/index.html')), false);
});

test('an install that predates logicLanguages fails --check rather than passing as intact', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root);
  await fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet });
  await checkInstalled({ root, ...quiet });
  const currentFile = resolve(paths(root).cache, 'current.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  delete current.protocols.logicLanguages;
  await writeFile(currentFile, JSON.stringify(current));
  await assert.rejects(
    checkInstalled({ root, ...quiet }),
    /The installed Softn v0\.0\.13 speaks logicLanguages undefined; this tree speaks 1\. Fetch again\./
  );
});

test('an archive that speaks logicLanguages but advertises no python-logic/1 is refused before it installs', async (t) => {
  // The protocol number and the runtime manifest's feature list are two halves of one claim, and
  // the SERVER reads the feature (through the provenance stamp) before it will serve a member an
  // app with Python logic. An archive carrying one without the other would install cleanly and
  // then refuse every Python app.
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root, { advertised: { engines: ['zipp-web-python', 'host-js'] } });
  await assert.rejects(
    fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }),
    /speaks logicLanguages 1 but its hosted-runtime\/runtime-manifest\.json does not advertise python-logic\/1/
  );
  assert.equal(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/index.html')), false);
});

test('an archive that speaks hostedEngines but ships no host.html is refused before it installs', async (t) => {
  // The protocol number is a claim about the archive's documents; HostedAppFrame mounts
  // /hosted-runtime/host.html by name, so a missing one would be a 404 in a member's frame.
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root, {}, null, (entries) => { delete entries['hosted-runtime/host.html']; });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), /The archive has no hosted-runtime\/host\.html\./);
});

test('an adapter this tree has not vendored fails naming --sync-adapter, and --sync-adapter vendors it', async (t) => {
  const root = await formlogicRoot(t, { adapterSha256: 'd'.repeat(64) });
  const fixture = await writeFixtureArchive(root);
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), /--sync-adapter/);
  const record = await fetchSoftnRelease({ root, archivePath: fixture.path, syncAdapter: true, ...quiet });
  assert.equal(record.adapter.sha256, adapterSha);
  const provenance = JSON.parse(await readFile(resolve(root, 'formlogic/ui/src/lib/softn/provenance.json'), 'utf8'));
  assert.equal(provenance.sha256, adapterSha);
  const vendored = await readFile(resolve(root, 'formlogic/ui/src/lib/softn/project.ts'), 'utf8');
  assert.ok(vendored.startsWith('// Vendored from SoftN.'));
  assert.ok(vendored.endsWith('export const project = 1;' + String.fromCharCode(10)), 'LF line endings, the body after the header');
  assert.equal(await readFile(resolve(root, 'formlogic/ui/src/lib/softn/LICENSE'), 'utf8'), 'Apache-2.0 fixture licence');
  await checkInstalled({ root, ...quiet });
});

test('parseSidecar reads the "<sha256>  <file>" line and refuses another file name', () => {
  assert.equal(parseSidecar(`${'e'.repeat(64)}  softn-formlogic-runtime-v1.zip\n`, 'softn-formlogic-runtime-v1.zip'), 'e'.repeat(64));
  assert.throws(() => parseSidecar(`${'e'.repeat(64)}  other.zip\n`, 'softn-formlogic-runtime-v1.zip'), /names other\.zip/);
  assert.throws(() => parseSidecar('garbage', 'x.zip'), /not a/);
});

test('resolveRelease names the tag when the release has no FormLogic runtime asset', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ tag_name: 'v0.0.12', assets: [{ name: 'softn-website-v0.0.12.zip' }] }), { status: 200 });
  await assert.rejects(resolveRelease({ tag: null, token: null, fetchImpl }), /release v0\.0\.12 carries no softn-formlogic-runtime-\*\.zip/);
  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(resolveRelease({ tag: 'v9.9.9', token: null, fetchImpl: missing }), /no release tagged v9\.9\.9/);
});

test('a release fetched through the API is downloaded once, verified by its sidecar, and reused next time', async (t) => {
  const root = await formlogicRoot(t);
  const a = await served(resolve(root, 'served'));
  const api = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': COMMIT } });
  const record = await fetchSoftnRelease({ root, fetchImpl: api.fetchImpl, token: null, ...quiet });
  assert.equal(record.source, 'https://example.test/v0.0.13');
  assert.equal(record.tagCommit, COMMIT);
  assert.ok(existsSync(resolve(root, '.runtime-source/softn-release/v0.0.13/softn-formlogic-runtime-v0.0.13.zip')));
  assert.deepEqual(api.downloads, ['https://example.test/v0.0.13/sha', 'https://example.test/v0.0.13/zip']);
  await fetchSoftnRelease({ root, fetchImpl: api.fetchImpl, token: null, ...quiet });
  assert.deepEqual(api.downloads, ['https://example.test/v0.0.13/sha', 'https://example.test/v0.0.13/zip', 'https://example.test/v0.0.13/sha'], 'the archive is reused when its digest still matches');
});

// ── FL-S01: one release per run ─────────────────────────────────────────────

test('the tag commit comes from the annotated tag, not the release page\'s target_commitish', async (t) => {
  const root = await formlogicRoot(t);
  const a = await served(resolve(root, 'served'));
  a.targetCommitish = 'main';
  const api = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': COMMIT } });
  const resolved = await resolveRelease({ tag: null, token: null, fetchImpl: api.fetchImpl });
  assert.equal(resolved.commit, COMMIT);
  assert.equal(resolved.targetCommitish, 'main');
});

test('an archive not built from the commit the tag points at is refused', async (t) => {
  const root = await formlogicRoot(t);
  const a = await served(resolve(root, 'served'));
  const api = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': OTHER_COMMIT } });
  await assert.rejects(fetchSoftnRelease({ root, fetchImpl: api.fetchImpl, token: null, ...quiet }), /built from bbbbbbbbbbbb, but tag v0\.0\.13 points at cccccccccccc/);
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')));
});

test('--resolve-only freezes the release from the release page and its sidecar, downloading only the sidecar', async (t) => {
  const root = await formlogicRoot(t);
  const a = await served(resolve(root, 'served'));
  const api = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': COMMIT }, assetIds: { 'v0.0.13': 4242 } });
  const frozen = await resolveOnly({ root, fetchImpl: api.fetchImpl, token: null, frozenPath: 'frozen/softn.json', ...quiet });
  assert.equal(frozen.formatVersion, FROZEN_FORMAT);
  assert.equal(frozen.tag, 'v0.0.13');
  assert.equal(frozen.tagCommit, COMMIT);
  assert.equal(frozen.assetId, 4242);
  assert.equal(frozen.assetName, 'softn-formlogic-runtime-v0.0.13.zip');
  assert.equal(frozen.archiveSha256, a.sha256);
  assert.deepEqual(api.downloads, ['https://example.test/v0.0.13/sha']);
  const onDisk = await loadFrozen('frozen/softn.json', root);
  assert.deepEqual(onDisk, frozen);
  await assert.rejects(loadFrozen('frozen/missing.json', root), /does not exist; run .*--resolve-only/);
});

test('with a frozen record the run installs the frozen release even after latest moved on, and a rerun installs it again', async (t) => {
  const root = await formlogicRoot(t);
  const a = await served(resolve(root, 'served-a'), { tag: 'v0.0.13' });
  const b = await served(resolve(root, 'served-b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";' });
  const before = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': COMMIT } });
  await resolveOnly({ root, fetchImpl: before.fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet });
  // Between the resolve and the install, Softn publishes v0.0.14.
  const after = githubApi({ latest: 'v0.0.14', releases: { 'v0.0.13': a, 'v0.0.14': b }, tagCommits: { 'v0.0.13': COMMIT, 'v0.0.14': OTHER_COMMIT } });
  const record = await fetchSoftnRelease({ root, fetchImpl: after.fetchImpl, token: null, frozen: 'frozen.json', ...quiet });
  assert.equal(record.tag, 'v0.0.13');
  assert.equal(record.sha256, a.sha256);
  assert.equal(record.frozen.archiveSha256, a.sha256);
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = true;');
  assert.ok(!after.downloads.some((u) => u.includes('v0.0.14')), 'nothing of the newer release was fetched');
  // Without the record, the same API serves latest: the newer release.
  const latest = await fetchSoftnRelease({ root, fetchImpl: after.fetchImpl, token: null, ...quiet });
  assert.equal(latest.tag, 'v0.0.14');
  // A rerun of a frozen job puts the frozen release back, from the cache.
  const downloadsBefore = after.downloads.length;
  const again = await fetchSoftnRelease({ root, fetchImpl: after.fetchImpl, token: null, frozen: 'frozen.json', ...quiet });
  assert.equal(again.tag, 'v0.0.13');
  assert.deepEqual(after.downloads.slice(downloadsBefore), ['https://example.test/v0.0.13/sha'], 'only the sidecar is re-read; the archive is reused');
  await checkInstalled({ root, frozen: 'frozen.json', ...quiet });
});

test('a frozen record refuses another tag, the right tag at the wrong commit, and replaced asset bytes', async (t) => {
  const root = await formlogicRoot(t);
  const a = await served(resolve(root, 'served-a'), { tag: 'v0.0.13' });
  const api = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': COMMIT } });
  await resolveOnly({ root, fetchImpl: api.fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet });
  // Another tag named explicitly.
  await assert.rejects(fetchSoftnRelease({ root, fetchImpl: api.fetchImpl, token: null, frozen: 'frozen.json', tag: 'v0.0.14', ...quiet }), /SOFTN_RELEASE names v0\.0\.14 but the frozen release record .* names v0\.0\.13/);
  // The tag moved to another commit.
  const moved = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': a }, tagCommits: { 'v0.0.13': OTHER_COMMIT } });
  await assert.rejects(fetchSoftnRelease({ root, fetchImpl: moved.fetchImpl, token: null, frozen: 'frozen.json', ...quiet }), /now points at cccccccccccc; the frozen record says bbbbbbbbbbbb/);
  // The asset was replaced by other bytes (with a matching sidecar).
  const replaced = await served(resolve(root, 'served-replaced'), { tag: 'v0.0.13', hostedCode: 'export const hosted = "replaced";' });
  const swapped = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': replaced }, tagCommits: { 'v0.0.13': COMMIT } });
  await assert.rejects(fetchSoftnRelease({ root, fetchImpl: swapped.fetchImpl, token: null, frozen: 'frozen.json', ...quiet }), /now publishes .* the frozen record says .* The asset was replaced/);
  // The asset is gone from the release.
  const bare = githubApi({ latest: 'v0.0.13', releases: { 'v0.0.13': { ...a } }, tagCommits: { 'v0.0.13': COMMIT }, assetIds: { 'v0.0.13': 999 } });
  const frozenRecord = JSON.parse(await readFile(resolve(root, 'frozen.json'), 'utf8'));
  frozenRecord.assetId = 100; // the record's asset id; the release now carries id 999 under the same name
  await writeFile(resolve(root, 'frozen-id.json'), JSON.stringify(frozenRecord));
  await assert.rejects(fetchSoftnRelease({ root, fetchImpl: bare.fetchImpl, token: null, frozen: 'frozen-id.json', ...quiet }), /no longer carries the frozen asset .*\(id 100\)/);
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')), 'nothing was installed by any refused attempt');
  // A local archive is held to the record as well.
  const other = await writeFixtureArchive(resolve(root, 'local-other'), { tag: 'v0.0.13', hostedCode: 'export const hosted = "local";' });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: other.path, frozen: 'frozen.json', ...quiet }), /not the frozen .* Refusing to install replacement bytes/);
  const same = await writeFixtureArchive(resolve(root, 'local-same'), { tag: 'v0.0.13' });
  const record = await fetchSoftnRelease({ root, archivePath: same.path, frozen: 'frozen.json', ...quiet });
  assert.equal(record.sha256, a.sha256);
  // And --check with a record for another release refuses the install.
  const otherFrozen = { ...frozenRecord, assetId: null, archiveSha256: 'f'.repeat(64) };
  await writeFile(resolve(root, 'frozen-other.json'), JSON.stringify(otherFrozen));
  await assert.rejects(checkInstalled({ root, frozen: 'frozen-other.json', ...quiet }), /not the frozen/);
});

// ── FL-S05: one generation per install ──────────────────────────────────────

test('a failure before the second tree is promoted leaves the old generation whole after recovery, and --check names the interruption first', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  const b = await writeFixtureArchive(resolve(root, 'b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";', zippRelease: ZIPP_NEXT });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'promote:app-editors', ...quiet }), /injected failure before promoting app-editors/);
  // Mid-promotion: the engine and the hosted runtime are already B, the editors still A, and the journal says so.
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";');
  assert.ok((await readFile(engineFile(root))).equals(ZIPP_NEXT.wasm));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime.previous')));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/vendor/zipp-wasm.previous')));
  assert.ok(existsSync(resolve(root, '.runtime-source/softn-release/promotion.json')));
  await assert.rejects(checkInstalled({ root, ...quiet }), /interrupted mid-promotion/);
  assert.equal(JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8')).tag, 'v0.0.13', 'the record still names the old generation');
  // The next run resolves it before doing anything else: all A again, the engine included.
  const outcome = await recoverPromotion(paths(root));
  assert.equal(outcome.outcome, 'rolled-back');
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = true;');
  assert.ok((await readFile(engineFile(root))).equals(ZIPP_RELEASE.wasm), 'vendor/zipp-wasm is put back from vendor/zipp-wasm.previous');
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime.previous')));
  assert.deepEqual((await readdir(resolve(root, 'formlogic/ui/public'))).sort(), ['app-editors', 'hosted-runtime'], 'no staging directory survives');
  assert.deepEqual(await readdir(resolve(root, 'formlogic/ui/vendor')), ['zipp-wasm'], 'no engine staging or previous directory survives');
  await checkInstalled({ root, ...quiet });
  // And an ordinary fetch after such a failure recovers first, then installs B whole.
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'promote:native-runtime', ...quiet }));
  const record = await fetchSoftnRelease({ root, archivePath: b.path, ...quiet });
  assert.equal(record.tag, 'v0.0.14');
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";');
  assert.ok((await readFile(engineFile(root))).equals(ZIPP_NEXT.wasm));
  await checkInstalled({ root, ...quiet });
});

test('a failure before the generation is recorded is completed on the next run: every tree was already new', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  const b = await writeFixtureArchive(resolve(root, 'b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";', zippRelease: ZIPP_NEXT });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'record', ...quiet }), /before recording/);
  assert.equal(JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8')).tag, 'v0.0.13');
  const outcome = await recoverPromotion(paths(root));
  assert.equal(outcome.outcome, 'completed');
  assert.equal(outcome.tag, 'v0.0.14');
  const current = JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8'));
  assert.equal(current.tag, 'v0.0.14');
  assert.ok(!existsSync(resolve(root, 'formlogic/backend/resources/softn-native.previous')));
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/vendor/zipp-wasm.previous')));
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";');
  assert.ok((await readFile(engineFile(root))).equals(ZIPP_NEXT.wasm));
  await checkInstalled({ root, ...quiet });
  assert.equal(await recoverPromotion(paths(root)), null, 'nothing left to recover');
});

test('a first install that fails mid-promotion is rolled back to nothing installed', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: a.path, failAt: 'promote:native-runtime', ...quiet }));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')));
  assert.ok(existsSync(paths(root).zippWasm));
  assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
  assert.ok(!existsSync(paths(root).zippWasm));
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')));
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/app-editors')));
  await assert.rejects(checkInstalled({ root, ...quiet }), /No Softn release is installed/);
});

test('two releases with the same engine and protocols cannot be mixed: --check holds every file to the recorded generation', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  const b = await writeFixtureArchive(resolve(root, 'b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";' });
  await fetchSoftnRelease({ root, archivePath: b.path, ...quiet });
  await checkInstalled({ root, ...quiet });
  // Put A's hosted runtime (self-consistent: its own runtime-manifest.json) over B's.
  const { entries } = readArchive(await readFile(a.path));
  const hosted = resolve(root, 'formlogic/ui/public/hosted-runtime');
  await rm(hosted, { recursive: true, force: true });
  for (const [name, entry] of entries) {
    if (!name.startsWith('hosted-runtime/')) continue;
    const target = resolve(hosted, name.slice('hosted-runtime/'.length));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, entry.data);
  }
  await assert.rejects(checkInstalled({ root, ...quiet }), /hosted-runtime is not the generation current\.json records for Softn v0\.0\.14 \(changed: assets\/app\.js, runtime-manifest\.json\)/);
  // An extra file and a missing file are found too.
  await fetchSoftnRelease({ root, archivePath: b.path, ...quiet });
  await writeFile(resolve(root, 'formlogic/backend/resources/softn-native/extra.mjs'), '// left behind');
  await assert.rejects(checkInstalled({ root, ...quiet }), /native-runtime is not the generation .*not in the recorded generation: extra\.mjs/);
  await rm(resolve(root, 'formlogic/backend/resources/softn-native/extra.mjs'));
  await rm(resolve(root, 'formlogic/ui/public/app-editors/studio/README.txt'), { force: true });
  await rm(resolve(root, 'formlogic/ui/public/app-editors/manifest.json'));
  await assert.rejects(checkInstalled({ root, ...quiet }), /app-editors is not the generation .*missing: manifest\.json/);
});

test('the transformed provenance is held to the archive\'s content plus the recorded release, and stale staging is swept', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await mkdir(resolve(root, 'formlogic/ui/public/.hosted-runtime-leftover'), { recursive: true });
  await writeFile(resolve(root, 'formlogic/ui/public/.hosted-runtime-leftover/index.html'), 'from a crashed run');
  await mkdir(resolve(root, 'formlogic/ui/vendor/.zipp-wasm-leftover'), { recursive: true });
  await writeFile(resolve(root, 'formlogic/ui/vendor/.zipp-wasm-leftover/zipp_wasm_bg.wasm'), 'from a crashed run');
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  assert.deepEqual((await readdir(resolve(root, 'formlogic/ui/public'))).sort(), ['app-editors', 'hosted-runtime']);
  assert.deepEqual(await readdir(resolve(root, 'formlogic/ui/vendor')), ['zipp-wasm']);
  const file = resolve(root, 'formlogic/backend/resources/softn-native/provenance.json');
  const provenance = JSON.parse(await readFile(file, 'utf8'));
  // Same bytes reformatted: the inventory digest changes, so --check refuses it (an edit is an edit).
  await writeFile(file, JSON.stringify(provenance));
  await assert.rejects(checkInstalled({ root, ...quiet }), /native-runtime is not the generation .*changed: provenance\.json/);
  // A record whose inventory was made to accept an edited provenance still fails the content check.
  const currentFile = resolve(root, '.runtime-source/softn-release/current.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  provenance.modules['runner.mjs'] = 'e'.repeat(64);
  await writeFile(file, JSON.stringify(provenance, null, 2) + '\n');
  current.generation.inventory['native-runtime']['provenance.json'] = sha256(await readFile(file));
  await writeFile(currentFile, JSON.stringify(current));
  await assert.rejects(checkInstalled({ root, ...quiet }), /beyond the recorded transformation|module is missing or changed/);
});

test('the engines and features the hosted runtime advertises are stamped into the native provenance, and --check holds it to them', async (t) => {
  const root = await formlogicRoot(t);
  const advertised = { engines: ['host-js', 'zipp-web-python'], features: ['python-logic/1'] };
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13', advertised });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  const file = resolve(root, 'formlogic/backend/resources/softn-native/provenance.json');
  const provenance = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(provenance.hostedRuntime, { engines: ['host-js', 'zipp-web-python'], features: ['python-logic/1'], protocols: PROTOCOLS });
  // Everything else about the native runtime is unchanged by the stamp.
  assert.equal(provenance.modules['runner.mjs'], sha256('// runner.mjs\n'));
  assert.deepEqual(provenance.release, { tag: 'v0.0.13', commit: COMMIT });
  await checkInstalled({ root, ...quiet });
  // The stamp is inside the recorded generation: editing it is an edit like any other.
  provenance.hostedRuntime.engines.push('zipp-web');
  await writeFile(file, JSON.stringify(provenance, null, 2) + '\n');
  await assert.rejects(checkInstalled({ root, ...quiet }), /native-runtime is not the generation .*changed: provenance\.json/);
});

test('a generation recorded before the hostedRuntime stamp still passes --check', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  // Reproduce a pre-E0 install exactly: no hostedRuntime on disk, the older transformation string.
  const file = resolve(root, 'formlogic/backend/resources/softn-native/provenance.json');
  const { hostedRuntime: _dropped, ...older } = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify(older, null, 2) + '\n');
  const currentFile = resolve(root, '.runtime-source/softn-release/current.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  current.generation.inventory['native-runtime']['provenance.json'] = sha256(await readFile(file));
  current.generation.transformed['native-runtime/provenance.json'].transformation = 'release: {tag, commit} added';
  await writeFile(currentFile, JSON.stringify(current));
  await checkInstalled({ root, ...quiet });
});

test('an install recorded by an earlier fetcher without an inventory is told to fetch again', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  const currentFile = resolve(root, '.runtime-source/softn-release/current.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  delete current.generation;
  await writeFile(currentFile, JSON.stringify(current));
  await assert.rejects(checkInstalled({ root, ...quiet }), /records no generation inventory/);
});

test('a link inside an installed tree is refused by --check as a release error', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  await symlink(resolve(root, 'a'), resolve(root, 'formlogic/backend/resources/softn-native/linked'), 'junction');
  await assert.rejects(checkInstalled({ root, ...quiet }), (e) => e instanceof ReleaseError && /must not contain links: linked/.test(e.message));
});

// ── FL-S05: failures, kills and the copy fallback ───────────────────────────

const journalPath = (root) => resolve(root, '.runtime-source/softn-release/promotion.json');
const refused = (code, path) => Object.assign(new Error(`${code}: operation refused, rename '${path}'`), { code });
/** Every directory rename refused, as a Windows watcher over the trees (and over any copy of them) refuses it, so every move copies; only a JSON write's rename goes through. */
const lockedRename = (from, to) => (from.endsWith('.tmp') ? rename(from, to) : Promise.reject(refused('EPERM', from)));

/** Remove one file under a directory: what a copy or a removal killed partway leaves. */
async function dropOneFile(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  const file = (await readdir(dir, { recursive: true, withFileTypes: true })).find((entry) => entry.isFile());
  if (file) await rm(resolve(file.parentPath, file.name));
}

/**
 * Promotion filesystem operations that die (SimulatedCrash) at call number
 * `kill`, having done part of it: a copy missing a file, a removal that
 * removed one, a write cut short. A run with no kill counts the kill points.
 */
function killingOps(kill) {
  const run = { calls: 0, copies: 0 };
  const step = async (label, done, partial = async () => {}) => {
    if (++run.calls !== kill) return done();
    await partial();
    throw new SimulatedCrash(`killed during ${label} (call ${kill})`);
  };
  run.ops = {
    rename: (from, to) => step(`rename ${from}`, () => lockedRename(from, to)),
    cp: (from, to, options) => { run.copies++; return step(`cp ${from}`, () => cp(from, to, options), async () => { await cp(from, to, options); await dropOneFile(to); }); },
    rm: (path, options) => step(`rm ${path}`, () => rm(path, options), () => dropOneFile(path)),
    writeFile: (file, data) => step(`write ${file}`, () => writeFile(file, data), () => writeFile(file, String(data).slice(0, 40))),
  };
  return run;
}

/** Releases A and B (other ZIPP releases, other bytes), and roots with A installed. */
async function releasesAB(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'formlogic-fetch-softn-archives-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await writeFixtureArchive(resolve(dir, 'a'), { tag: 'v0.0.13' });
  const b = await writeFixtureArchive(resolve(dir, 'b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";', zippRelease: ZIPP_NEXT });
  const installedA = async () => { const root = await formlogicRoot(t); await fetchSoftnRelease({ root, archivePath: a.path, ...quiet }); return root; };
  return { a, b, installedA };
}

/** One whole generation and nothing beside it (no .previous, partial copy or staging folder): --check holds every tree to the record. Returns its tag. */
async function wholeGeneration(root, message) {
  const record = await checkInstalled({ root, ...quiet });
  const isA = record.tag === 'v0.0.13';
  assert.equal(await readFile(hostedFile(root), 'utf8'), isA ? 'export const hosted = true;' : 'export const hosted = "b";', message);
  assert.ok((await readFile(engineFile(root))).equals(isA ? ZIPP_RELEASE.wasm : ZIPP_NEXT.wasm), `${message}: the engine is the generation's`);
  assert.deepEqual((await readdir(resolve(root, 'formlogic/ui/public'))).sort(), ['app-editors', 'hosted-runtime'], message);
  assert.deepEqual(await readdir(resolve(root, 'formlogic/ui/vendor')), ['zipp-wasm'], message);
  assert.deepEqual(await readdir(resolve(root, 'formlogic/backend/resources')), ['softn-native'], message);
  return record.tag;
}

test('a move refused mid-promotion is rolled back before the run ends: the old generation whole, no journal, nothing beside the trees', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const editors = paths(root).appEditors;
  const messages = [];
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops: { rename: (from, to) => (from === editors ? Promise.reject(refused('EBUSY', from)) : rename(from, to)) }, log: (m) => messages.push(m) }), /EBUSY/);
  assert.ok(messages.some((m) => /rolled back the install of Softn v0\.0\.14 \(failed: EBUSY/.test(m)));
  assert.ok(!existsSync(journalPath(root)), 'no journal outlives a rolled-back run');
  assert.equal(await wholeGeneration(root, 'rolled back in process'), 'v0.0.13');
  assertNoInterruptedPromotion(root);
});

test('a promoted tree failing its check is rolled back before the run ends', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const hosted = paths(root).hostedRuntime;
  // The staged tree passed; the tree moved in does not (something wrote into it once it was in place).
  const tampering = async (from, to) => {
    await rename(from, to);
    if (to === hosted && basename(from).startsWith('.hosted-runtime-')) await writeFile(hostedFile(root), 'junk');
  };
  const messages = [];
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops: { rename: tampering }, log: (m) => messages.push(m) }), /asset has changed: assets\/app\.js/);
  assert.ok(messages.some((m) => /rolled back the install of Softn v0\.0\.14 \(failed: The hosted runtime asset has changed/.test(m)));
  assert.ok(!existsSync(journalPath(root)), 'no journal outlives a rolled-back run');
  assert.equal(await wholeGeneration(root, 'rolled back after a failed check'), 'v0.0.13');
});

test('a failed promotion is rolled back by copying when every directory rename is refused, as under a dev server watching public/', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const editors = paths(root).appEditors;
  const ops = {
    rename: lockedRename,
    cp: async (from, to, options) => {
      await cp(from, to, options);
      if (to !== editors || !basename(from).startsWith('.app-editors-')) return;
      await dropOneFile(to);
      throw Object.assign(new Error(`ENOSPC: no space left on device, copyfile '${from}'`), { code: 'ENOSPC' });
    },
  };
  const messages = [];
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops, log: (m) => messages.push(m) }), /ENOSPC/);
  assert.ok(messages.some((m) => /rolled back the install of Softn v0\.0\.14 \(failed: ENOSPC/.test(m)));
  assert.ok(!existsSync(journalPath(root)));
  assert.equal(await wholeGeneration(root, 'rolled back by copying'), 'v0.0.13');
});

test('a journal or record rename refused for a moment is retried, not failed', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const refusedOnce = new Set();
  const flaky = (from, to) => {
    if (!from.endsWith('.tmp') || refusedOnce.has(from)) return rename(from, to);
    refusedOnce.add(from);
    return Promise.reject(refused('EBUSY', from));
  };
  await fetchSoftnRelease({ root, archivePath: b.path, ops: { rename: flaky }, ...quiet });
  assert.ok(['promotion.json', 'current.json'].every((name) => [...refusedOnce].some((file) => basename(file).startsWith(`${name}.`))), 'the journal and the record were each refused once');
  assert.ok(!existsSync(journalPath(root)));
  assert.equal(await wholeGeneration(root, 'installed through momentary refusals'), 'v0.0.14');
});

test('a rollback that fails too keeps the journal and names both failures; every check refuses until the next run resolves it', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const editors = paths(root).appEditors;
  const stuck = (from, to) => (from === editors || from.endsWith('.previous') ? Promise.reject(refused('EBUSY', from)) : rename(from, to));
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops: { rename: stuck }, ...quiet }), (e) => e instanceof ReleaseError && /failed mid-promotion \(EBUSY.*app-editors.*rolling it back failed too \(EBUSY.*zipp-wasm\.previous/.test(e.message));
  assert.ok(existsSync(journalPath(root)));
  await assert.rejects(checkInstalled({ root, ...quiet }), /interrupted mid-promotion/);
  assert.throws(() => assertNoInterruptedPromotion(root), /promotion\.json/);
  assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
  assert.equal(await wholeGeneration(root, 'resolved by the next run'), 'v0.0.13');
});

test('a cleanup failing after the generation is recorded is not rolled back: the next run completes it', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const previous = `${paths(root).hostedRuntime}.previous`;
  let removals = 0;
  const ops = { rm: (path, options) => (path === previous && ++removals === 2 ? Promise.reject(refused('EBUSY', path)) : rm(path, options)) };
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops, ...quiet }), /EBUSY/);
  assert.equal(JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8')).tag, 'v0.0.14');
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";', 'the recorded generation stays in place');
  assert.equal((await recoverPromotion(paths(root))).outcome, 'completed');
  assert.equal(await wholeGeneration(root, 'completed by the next run'), 'v0.0.14');
});

test('the journal is replaced whole: a run killed while writing it leaves the journal before, which recovery acts on', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  let journalWrites = 0;
  const ops = {
    writeFile: async (file, data) => {
      if (!basename(file).startsWith('promotion.json') || ++journalWrites !== 6) return writeFile(file, data);
      await writeFile(file, String(data).slice(0, 64));
      throw new SimulatedCrash('killed while writing promotion.json');
    },
  };
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops, ...quiet }), /killed while writing promotion\.json/);
  const journal = JSON.parse(await readFile(journalPath(root), 'utf8'));
  // Writes: staged, then promoting and promoted per tree; the sixth is the editors' promoting.
  assert.equal(journal.trees['zipp-wasm'].state, 'promoted');
  assert.equal(journal.trees['hosted-runtime'].state, 'promoted');
  assert.equal(journal.trees['app-editors'].state, 'staged');
  assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
  assert.equal(await wholeGeneration(root, 'recovered from the journal before the cut-short write'), 'v0.0.13');
});

test('a journal that names no trees is kept, and every check refuses, until an install records a complete generation', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  await writeFile(journalPath(root), '{"formatVersion":1,"startedAt":"2026-09-');
  const messages = [];
  assert.equal((await recoverPromotion(paths(root), (m) => messages.push(m))).outcome, 'kept-unresolvable-journal');
  assert.ok(existsSync(journalPath(root)));
  assert.ok(messages.some((m) => /promotion\.json names no trees .* it is kept/.test(m)));
  await assert.rejects(checkInstalled({ root, ...quiet }), /interrupted mid-promotion/);
  assert.throws(() => assertNoInterruptedPromotion(root), /promotion\.json/);
  // An install over it that is rolled back, in process or by the next run, puts the refusal back with the trees.
  const editors = paths(root).appEditors;
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops: { rename: (from, to) => (from === editors ? Promise.reject(refused('EBUSY', from)) : rename(from, to)) }, ...quiet }), /EBUSY/);
  assert.equal((await recoverPromotion(paths(root))).outcome, 'kept-unresolvable-journal');
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'promote:native-runtime', ...quiet }), SimulatedCrash);
  assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
  assert.equal((await recoverPromotion(paths(root))).outcome, 'kept-unresolvable-journal');
  await assert.rejects(checkInstalled({ root, ...quiet }), /interrupted mid-promotion/);
  // An install that records a complete generation replaces it.
  await fetchSoftnRelease({ root, archivePath: b.path, ...quiet });
  assert.ok(!existsSync(journalPath(root)));
  assert.equal(await wholeGeneration(root, 'installed over the kept journal'), 'v0.0.14');
});

test('a copy fallback killed while setting the old tree aside leaves a partial .previous the journal marks, so recovery drops it and keeps the intact old tree', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const root = await installedA();
  const hosted = paths(root).hostedRuntime;
  const ops = {
    rename: lockedRename,
    cp: async (from, to, options) => {
      await cp(from, to, options);
      if (from !== hosted) return;
      await dropOneFile(to);
      throw new SimulatedCrash('killed halfway through copying hosted-runtime aside');
    },
  };
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops, ...quiet }), /killed halfway/);
  assert.ok(existsSync(`${hosted}.previous`), 'the half copy is there under the .previous name');
  assert.equal(JSON.parse(await readFile(journalPath(root), 'utf8')).trees['hosted-runtime'].copyingAside, true);
  assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
  assert.equal(await wholeGeneration(root, 'recovered'), 'v0.0.13');
  await fetchSoftnRelease({ root, archivePath: b.path, ops: { rename: lockedRename }, ...quiet });
  assert.equal(await wholeGeneration(root, 'installed by copying'), 'v0.0.14');
});

test('a run killed at any point of a copy-fallback promotion is recovered to one whole generation', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const counted = killingOps(0);
  await fetchSoftnRelease({ root: await installedA(), archivePath: b.path, ops: counted.ops, ...quiet });
  assert.equal(counted.copies, 8, 'every tree (the engine, the hosted runtime, the editors, the native runtime) was set aside and moved in by copying');
  const tags = new Set();
  for (let kill = 1; kill <= counted.calls; kill++) {
    const root = await installedA();
    await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, ops: killingOps(kill).ops, ...quiet }), SimulatedCrash);
    await recoverPromotion(paths(root));
    tags.add(await wholeGeneration(root, `killed at call ${kill} of ${counted.calls}`));
  }
  assert.deepEqual([...tags].sort(), ['v0.0.13', 'v0.0.14'], 'kills before and after the generation was complete were both walked');
});

test('a recovery killed at any point of copying the old trees back still ends with the old generation whole', async (t) => {
  const { b, installedA } = await releasesAB(t);
  const interrupted = async () => {
    const root = await installedA();
    await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'promote:native-runtime', ops: { rename: lockedRename }, ...quiet }), SimulatedCrash);
    return root;
  };
  const counted = killingOps(0);
  const first = await interrupted();
  assert.equal((await recoverPromotion(paths(first), () => {}, counted.ops)).outcome, 'rolled-back');
  assert.equal(counted.copies, 3, 'the engine, the hosted runtime and the editors were copied back');
  for (let kill = 1; kill <= counted.calls; kill++) {
    const root = await interrupted();
    await assert.rejects(recoverPromotion(paths(root), () => {}, killingOps(kill).ops), SimulatedCrash);
    assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
    assert.equal(await wholeGeneration(root, `recovery killed at call ${kill} of ${counted.calls}`), 'v0.0.13');
  }
});

test('the developer paths still work: a local archive without a sidecar installs, and cp is not needed for the fixture', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await rm(`${a.path}.sha256`);
  const messages = [];
  const record = await fetchSoftnRelease({ root, archivePath: a.path, log: (m) => messages.push(m) });
  assert.equal(record.frozen, null);
  assert.ok(messages.some((m) => /no softn-formlogic-runtime-v0\.0\.13\.zip\.sha256 beside the local archive/.test(m)));
  await checkInstalled({ root, ...quiet });
  await cp(resolve(root, 'formlogic/ui/public/hosted-runtime'), resolve(root, 'copy'), { recursive: true });
  assert.ok(existsSync(resolve(root, 'copy/index.html')));
});
