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
 * refusing a mixture of two releases).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { writeArchive, readArchive } from './lib/archive.mjs';
import { fetchSoftnRelease, checkInstalled, resolveRelease, resolveOnly, recoverPromotion, loadFrozen, parseSidecar, ReleaseError, FROZEN_FORMAT } from './fetch-softn-release.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WASM = Buffer.from('fixture zipp engine bytes');
const ZIPP = { version: '0.0.18', sha256: sha256(WASM), revision: 'a'.repeat(40) };
const PROTOCOLS = { nativeProtocol: 1, recordEvents: 1, editorBridge: 1 };
const ADAPTER = '/** fixture adapter */\r\nexport const project = 1;\r\n';
const adapterSha = sha256(ADAPTER.replace(/\r\n/g, '\n'));
const COMMIT = 'b'.repeat(40);
const OTHER_COMMIT = 'c'.repeat(40);

function runtimeManifest(files) {
  const digests = {};
  for (const [name, data] of Object.entries(files)) digests[name] = sha256(data);
  return Buffer.from(JSON.stringify({ formatVersion: 1, zipp: { version: ZIPP.version, sha256: ZIPP.sha256 }, files: digests }, null, 2) + '\n');
}

/** The archive's entries, per the contract; `mutate` edits them before the manifest is computed. */
function archiveEntries({ tag = 'v0.0.13', commit = COMMIT, zipp = ZIPP, protocols = PROTOCOLS, adapter = ADAPTER, wasm = WASM, hostedCode = 'export const hosted = true;' } = {}) {
  const entries = {};
  const put = (name, data) => { entries[name] = Buffer.isBuffer(data) ? data : Buffer.from(data); };
  put('README.md', '# Softn runtime for FormLogic\n');
  // hosted runtime
  const hosted = { 'index.html': Buffer.from('<script src="./assets/app.js"></script>'), 'assets/app.js': Buffer.from(hostedCode), 'README.txt': Buffer.from('fixture') };
  for (const [n, d] of Object.entries(hosted)) put(`hosted-runtime/${n}`, d);
  put('hosted-runtime/runtime-manifest.json', runtimeManifest(hosted));
  // app editors
  const editors = {};
  for (const editor of ['builder', 'studio']) {
    const files = { 'index.html': Buffer.from(`<script src="./assets/${editor}.js"></script>`), [`assets/${editor}.js`]: Buffer.from(`export const ${editor} = 1;`), 'assets/zipp_wasm_bg-abc.wasm': wasm };
    for (const [n, d] of Object.entries(files)) editors[`${editor}/${n}`] = d;
    editors[`${editor}/runtime-manifest.json`] = runtimeManifest(files);
  }
  editors['manifest.json'] = Buffer.from(JSON.stringify({ protocol: protocols.editorBridge, editors: ['builder', 'studio'], builtAt: '2026-09-15T00:00:00Z' }));
  for (const [n, d] of Object.entries(editors)) put(`app-editors/${n}`, d);
  put('app-editors/runtime-manifest.json', runtimeManifest(editors));
  // native runtime
  const modules = {};
  for (const name of ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'record-events.mjs']) modules[name] = Buffer.from(`// ${name}\n`);
  modules['host-protocol.json'] = Buffer.from(JSON.stringify({ nativeProtocol: protocols.nativeProtocol, recordEvents: protocols.recordEvents, minimumNode: '24.19.0' }));
  const moduleDigests = {};
  for (const [n, d] of Object.entries(modules)) { put(`native-runtime/${n}`, d); moduleDigests[n] = sha256(d); }
  put('native-runtime/wasm/zipp_wasm.mjs', 'export default {};');
  put('native-runtime/wasm/zipp_wasm_bg.wasm', wasm);
  put('native-runtime/wasm/SOURCE.json', JSON.stringify(zipp));
  put('native-runtime/LICENSE', 'Apache-2.0 fixture licence');
  put('native-runtime/NOTICE', 'fixture notice');
  put('native-runtime/ZIPP-THIRD-PARTY-LICENSES.txt', 'third party');
  put('native-runtime/provenance.json', JSON.stringify({ source: 'softn.com/apps/softn-host-php/runtime', nativeProtocol: protocols.nativeProtocol, zipp, modules: moduleDigests }, null, 2));
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

async function writeFixtureArchive(dir, options = {}, tamper = null) {
  const build = archiveEntries(options);
  build.entries['softn-release.json'] = releaseManifest(build);
  if (tamper) tamper(build.entries);
  const out = resolve(dir, `softn-formlogic-runtime-${build.tag}.zip`);
  const written = writeArchive(build.entries, out, { stamp: new Date('2026-09-15T00:00:00Z') });
  return { path: out, sha256: written.sha256, tag: build.tag, commit: build.commit };
}

/** A FormLogic-shaped root: the files the fetcher reads and the folders it writes. */
async function formlogicRoot(t, { adapterSha256 = adapterSha, zipp = ZIPP, protocols = PROTOCOLS } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-fetch-softn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'formlogic/ui/src/lib/softn'), { recursive: true });
  await mkdir(resolve(root, 'formlogic/ui/vendor/zipp-wasm'), { recursive: true });
  await mkdir(resolve(root, 'formlogic/ui/public'), { recursive: true });
  await mkdir(resolve(root, 'formlogic/backend/resources'), { recursive: true });
  await writeFile(resolve(root, 'formlogic/ui/src/lib/softn/protocol.json'), JSON.stringify(protocols));
  await writeFile(resolve(root, 'formlogic/ui/src/lib/softn/provenance.json'), JSON.stringify({ source: 'softn.com/packages/@softn/core/src/integrations/formlogic.ts', license: 'Apache-2.0', sha256: adapterSha256 }));
  await writeFile(resolve(root, 'formlogic/ui/src/lib/softn/project.ts'), '// Vendored from SoftN.\n' + ADAPTER.replace(/\r\n/g, '\n'));
  await writeFile(resolve(root, 'formlogic/ui/vendor/zipp-wasm/SOURCE.json'), JSON.stringify(zipp));
  await writeFile(resolve(root, 'formlogic/ui/vendor/zipp-wasm/zipp_wasm_bg.wasm'), WASM);
  return root;
}

const quiet = { log: () => {} };
const hostedFile = (root) => resolve(root, 'formlogic/ui/public/hosted-runtime/assets/app.js');
const paths = (root) => ({ cache: resolve(root, '.runtime-source/softn-release'), hostedRuntime: resolve(root, 'formlogic/ui/public/hosted-runtime'), appEditors: resolve(root, 'formlogic/ui/public/app-editors'), nativeRuntime: resolve(root, 'formlogic/backend/resources/softn-native') });

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

test('a local archive with a good sidecar installs all three trees and records what it installed', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root);
  const record = await fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet });
  assert.equal(record.tag, 'v0.0.13');
  assert.equal(record.commit, COMMIT);
  assert.equal(record.sha256, fixture.sha256);
  assert.deepEqual(record.protocols, PROTOCOLS);
  assert.equal(record.adapter.sha256, adapterSha);
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/index.html')));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/runtime-manifest.json')));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/app-editors/studio/index.html')));
  assert.ok(existsSync(resolve(root, 'formlogic/backend/resources/softn-native/runner.mjs')));
  const provenance = JSON.parse(await readFile(resolve(root, 'formlogic/backend/resources/softn-native/provenance.json'), 'utf8'));
  assert.deepEqual(provenance.release, { tag: 'v0.0.13', commit: COMMIT });
  assert.equal(provenance.nativeProtocol, 1);
  // No staging or previous directories are left behind.
  const publicEntries = await readdir(resolve(root, 'formlogic/ui/public'));
  assert.deepEqual(publicEntries.sort(), ['app-editors', 'hosted-runtime']);
  assert.deepEqual((await readdir(resolve(root, 'formlogic/backend/resources'))).sort(), ['softn-native']);
  const current = JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8'));
  assert.equal(current.tag, 'v0.0.13');
  // The generation is recorded file by file.
  assert.deepEqual(Object.keys(current.generation.inventory).sort(), ['app-editors', 'hosted-runtime', 'native-runtime']);
  assert.equal(current.generation.inventory['hosted-runtime']['assets/app.js'], sha256('export const hosted = true;'));
  assert.ok(current.generation.inventory['native-runtime']['provenance.json']);
  assert.equal(current.generation.transformed['native-runtime/provenance.json'].transformation, 'release: {tag, commit} added');
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

test('a release built with a different ZIPP engine is refused and says how to reconcile', async (t) => {
  const root = await formlogicRoot(t);
  const other = Buffer.from('another engine');
  const fixture = await writeFixtureArchive(root, { zipp: { version: '0.0.19', sha256: sha256(other), revision: 'c'.repeat(40) }, wasm: other });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), /built with ZIPP 0\.0\.19 .* vendors ZIPP 0\.0\.18 .*sync-zipp-from-softn|SOFTN_RELEASE/);
});

test('a release speaking another protocol version is refused', async (t) => {
  const root = await formlogicRoot(t);
  const fixture = await writeFixtureArchive(root, { protocols: { nativeProtocol: 2, recordEvents: 1, editorBridge: 1 } });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: fixture.path, ...quiet }), /speaks nativeProtocol 2; this FormLogic speaks 1/);
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
  const b = await writeFixtureArchive(resolve(root, 'b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";' });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'promote:app-editors', ...quiet }), /injected failure before promoting app-editors/);
  // Mid-promotion: the hosted runtime is already B, the editors still A, and the journal says so.
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";');
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime.previous')));
  assert.ok(existsSync(resolve(root, '.runtime-source/softn-release/promotion.json')));
  await assert.rejects(checkInstalled({ root, ...quiet }), /interrupted mid-promotion/);
  assert.equal(JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8')).tag, 'v0.0.13', 'the record still names the old generation');
  // The next run resolves it before doing anything else: all A again.
  const outcome = await recoverPromotion(paths(root));
  assert.equal(outcome.outcome, 'rolled-back');
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = true;');
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime.previous')));
  assert.deepEqual((await readdir(resolve(root, 'formlogic/ui/public'))).sort(), ['app-editors', 'hosted-runtime'], 'no staging directory survives');
  await checkInstalled({ root, ...quiet });
  // And an ordinary fetch after such a failure recovers first, then installs B whole.
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'promote:native-runtime', ...quiet }));
  const record = await fetchSoftnRelease({ root, archivePath: b.path, ...quiet });
  assert.equal(record.tag, 'v0.0.14');
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";');
  await checkInstalled({ root, ...quiet });
});

test('a failure before the generation is recorded is completed on the next run: all three trees were already new', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  const b = await writeFixtureArchive(resolve(root, 'b'), { tag: 'v0.0.14', commit: OTHER_COMMIT, hostedCode: 'export const hosted = "b";' });
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: b.path, failAt: 'record', ...quiet }), /before recording/);
  assert.equal(JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8')).tag, 'v0.0.13');
  const outcome = await recoverPromotion(paths(root));
  assert.equal(outcome.outcome, 'completed');
  assert.equal(outcome.tag, 'v0.0.14');
  const current = JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8'));
  assert.equal(current.tag, 'v0.0.14');
  assert.ok(!existsSync(resolve(root, 'formlogic/backend/resources/softn-native.previous')));
  assert.equal(await readFile(hostedFile(root), 'utf8'), 'export const hosted = "b";');
  await checkInstalled({ root, ...quiet });
  assert.equal(await recoverPromotion(paths(root)), null, 'nothing left to recover');
});

test('a first install that fails mid-promotion is rolled back to nothing installed', async (t) => {
  const root = await formlogicRoot(t);
  const a = await writeFixtureArchive(resolve(root, 'a'), { tag: 'v0.0.13' });
  await assert.rejects(fetchSoftnRelease({ root, archivePath: a.path, failAt: 'promote:native-runtime', ...quiet }));
  assert.ok(existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime')));
  assert.equal((await recoverPromotion(paths(root))).outcome, 'rolled-back');
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
  await fetchSoftnRelease({ root, archivePath: a.path, ...quiet });
  assert.deepEqual((await readdir(resolve(root, 'formlogic/ui/public'))).sort(), ['app-editors', 'hosted-runtime']);
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
