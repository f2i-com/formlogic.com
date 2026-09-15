/**
 * scripts/fetch-softn-release.mjs against an archive built to the contract
 * (softn.com/scripts/package-formlogic-runtime.mjs writes the real one): what
 * is refused, what is installed, and what --check finds afterwards. A
 * temporary FormLogic-shaped root stands in for the repository so nothing
 * here touches the tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { writeArchive } from './lib/archive.mjs';
import { fetchSoftnRelease, checkInstalled, resolveRelease, parseSidecar, ReleaseError } from './fetch-softn-release.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WASM = Buffer.from('fixture zipp engine bytes');
const ZIPP = { version: '0.0.18', sha256: sha256(WASM), revision: 'a'.repeat(40) };
const PROTOCOLS = { nativeProtocol: 1, recordEvents: 1, editorBridge: 1 };
const ADAPTER = '/** fixture adapter */\r\nexport const project = 1;\r\n';
const adapterSha = sha256(ADAPTER.replace(/\r\n/g, '\n'));
const COMMIT = 'b'.repeat(40);

function runtimeManifest(files) {
  const digests = {};
  for (const [name, data] of Object.entries(files)) digests[name] = sha256(data);
  return Buffer.from(JSON.stringify({ formatVersion: 1, zipp: { version: ZIPP.version, sha256: ZIPP.sha256 }, files: digests }, null, 2) + '\n');
}

/** The archive's entries, per the contract; `mutate` edits them before the manifest is computed. */
function archiveEntries({ tag = 'v0.0.13', zipp = ZIPP, protocols = PROTOCOLS, adapter = ADAPTER, wasm = WASM } = {}) {
  const entries = {};
  const put = (name, data) => { entries[name] = Buffer.isBuffer(data) ? data : Buffer.from(data); };
  put('README.md', '# Softn runtime for FormLogic\n');
  // hosted runtime
  const hosted = { 'index.html': Buffer.from('<script src="./assets/app.js"></script>'), 'assets/app.js': Buffer.from('export const hosted = true;'), 'README.txt': Buffer.from('fixture') };
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
  return { entries, tag, zipp, protocols, adapter };
}

function releaseManifest({ entries, tag, zipp, protocols, adapter }) {
  const files = {};
  for (const name of Object.keys(entries).sort()) files[name] = sha256(entries[name]);
  return Buffer.from(JSON.stringify({
    formatVersion: 1, tag, commit: COMMIT, version: tag.slice(1), builtAt: '2026-09-15T00:00:00Z',
    zipp, protocols, adapter: { path: 'adapter/formlogic.ts', sha256: sha256(adapter.replace(/\r\n/g, '\n')) }, files,
  }, null, 2) + '\n');
}

async function writeFixtureArchive(dir, options = {}, tamper = null) {
  const build = archiveEntries(options);
  build.entries['softn-release.json'] = releaseManifest(build);
  if (tamper) tamper(build.entries);
  const out = resolve(dir, `softn-formlogic-runtime-${build.tag}.zip`);
  const written = writeArchive(build.entries, out, { stamp: new Date('2026-09-15T00:00:00Z') });
  return { path: out, sha256: written.sha256, tag: build.tag };
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
  // No staging directories are left behind.
  const publicEntries = await readdir(resolve(root, 'formlogic/ui/public'));
  assert.deepEqual(publicEntries.sort(), ['app-editors', 'hosted-runtime']);
  const current = JSON.parse(await readFile(resolve(root, '.runtime-source/softn-release/current.json'), 'utf8'));
  assert.equal(current.tag, 'v0.0.13');
  // --check finds the install intact, and finds a modified asset.
  await checkInstalled({ root, ...quiet });
  await writeFile(resolve(root, 'formlogic/ui/public/hosted-runtime/assets/app.js'), 'tampered');
  await assert.rejects(checkInstalled({ root, ...quiet }), /asset has changed/);
});

test('a second fetch replaces a previous install cleanly', async (t) => {
  const root = await formlogicRoot(t);
  const first = await writeFixtureArchive(root);
  await fetchSoftnRelease({ root, archivePath: first.path, ...quiet });
  await writeFile(resolve(root, 'formlogic/ui/public/hosted-runtime/assets/stale.js'), 'from an older release');
  const again = await writeFixtureArchive(resolve(root, 'again'));
  await fetchSoftnRelease({ root, archivePath: again.path, ...quiet });
  assert.ok(!existsSync(resolve(root, 'formlogic/ui/public/hosted-runtime/assets/stale.js')));
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
  const fixture = await writeFixtureArchive(resolve(root, 'served'));
  const zip = await readFile(fixture.path);
  const sidecar = `${fixture.sha256}  softn-formlogic-runtime-v0.0.13.zip\n`;
  const downloads = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v0.0.13', target_commitish: COMMIT, html_url: 'https://example.test/rel', assets: [
      { name: 'softn-formlogic-runtime-v0.0.13.zip', browser_download_url: 'https://example.test/zip', url: 'https://api.example.test/zip' },
      { name: 'softn-formlogic-runtime-v0.0.13.zip.sha256', browser_download_url: 'https://example.test/sha', url: 'https://api.example.test/sha' },
    ] }), { status: 200 });
    downloads.push(url);
    if (url.endsWith('/zip')) return new Response(zip, { status: 200 });
    if (url.endsWith('/sha')) return new Response(sidecar, { status: 200 });
    return new Response('', { status: 404 });
  };
  const record = await fetchSoftnRelease({ root, fetchImpl, token: null, ...quiet });
  assert.equal(record.source, 'https://example.test/rel');
  assert.ok(existsSync(resolve(root, '.runtime-source/softn-release/v0.0.13/softn-formlogic-runtime-v0.0.13.zip')));
  assert.deepEqual(downloads, ['https://example.test/sha', 'https://example.test/zip']);
  await fetchSoftnRelease({ root, fetchImpl, token: null, ...quiet });
  assert.deepEqual(downloads, ['https://example.test/sha', 'https://example.test/zip', 'https://example.test/sha'], 'the archive is reused when its digest still matches');
});
