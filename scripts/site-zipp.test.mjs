// node --test scripts/site-zipp.test.mjs
// The site's ZIPP (site-zipp.mjs): the Softn release's by default, or the release zipp-release.json
// pins, installed by the installer the Softn release archive carries, only where the Softn runtime
// and editors run a ZIPP of the site's own; refused, with nothing changed, everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeArchive } from './lib/archive.mjs';
import { writeZippTree, zippModuleReleaseFixture } from '../formlogic/ui/scripts/zipp-release-fixture.mjs';
import { assertRunsSiteZipp, checkSiteZipp, glueExports, installSiteZipp, readPin, sitePaths, siteZippSource, withSiteZipp } from './site-zipp.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quiet = { log: () => {} };
const SOFTN = zippModuleReleaseFixture({ version: '0.0.33', revision: 'c'.repeat(40) });
const OWN = zippModuleReleaseFixture({ version: '0.0.34', revision: 'd'.repeat(40) });
const write = (file, bytes) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); };

/**
 * A FormLogic tree with Softn installed: its ZIPP trees, the runtime's and the editors' manifests,
 * the runtime's torch copy, and current.json naming the kept archive, whose zipp-tools/ installer
 * writes `OWN` (or does `installer`).
 */
async function site(t, { features = ['host-zipp/1', 'python-logic/1'], editorFeatures = ['host-zipp/1'], needed = ['default', 'Engine'], tools = true, installer } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'site-zipp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = sitePaths(root);
  await writeZippTree(paths.softn, SOFTN.files);
  await writeZippTree(paths.softnWeb, SOFTN.webFiles);
  write(join(paths.hostedRuntime, 'assets/core-runtime/zipp_torch.wasm'), SOFTN.torchWasm);
  write(join(paths.hostedRuntime, 'runtime-manifest.json'), JSON.stringify({ formatVersion: 1, zipp: { version: SOFTN.source.version, sha256: SOFTN.source.sha256 }, features, zippGlueExports: needed, files: {} }));
  write(join(paths.appEditors, 'manifest.json'), JSON.stringify({ protocol: 1, editors: ['builder', 'studio'], features: editorFeatures }));
  // The installer: the pinned release's three trees, written where ZIPP_OUT and its siblings say.
  const trees = { zipp: OWN.files, 'zipp-web': OWN.webFiles, 'zipp-torch': OWN.torchFiles };
  const encoded = Object.fromEntries(Object.entries(trees).map(([name, files]) => [name, Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]))]));
  const script = installer ?? `import { mkdirSync, writeFileSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\nconst out = process.env.ZIPP_OUT;\nconst trees = ${JSON.stringify(encoded)};\nif (process.argv[2] !== process.env.ZIPP_RELEASE || !process.env.ZIPP_SUMS_SHA256 || !process.env.ZIPP_CACHE_DIR) { console.error('bad call'); process.exit(1); }\nfor (const [name, files] of Object.entries(trees)) for (const [path, data] of Object.entries(files)) { const file = join(name === 'zipp' ? out : out.replace(/zipp$/, name), path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(data, 'base64')); }\n`;
  const entries = new Map([['softn-release.json', Buffer.from('{}')], ...(tools ? [['zipp-tools/scripts/fetch-zipp-release.mjs', Buffer.from(script)], ['zipp-tools/zipp-notices/THIRD_PARTY_LICENSES.txt', Buffer.from('notices')]] : [])]);
  const archive = join(paths.releases, 'v0.0.37', 'softn-formlogic-runtime-v0.0.37.zip');
  mkdirSync(dirname(archive), { recursive: true });
  writeArchive(entries, archive);
  write(join(paths.releases, 'current.json'), JSON.stringify({ tag: 'v0.0.37', archive: 'softn-formlogic-runtime-v0.0.37.zip', sha256: sha256(readFileSync(archive)), zipp: SOFTN.record }));
  return { root, paths };
}
const pin = (root, value = { release: OWN.source.release, sumsSha256: OWN.source.sumsSha256 }) => writeFileSync(join(root, 'zipp-release.json'), JSON.stringify(value));

test("without a pin the site's ZIPP is the Softn release's, copied with its variant and torch package", async (t) => {
  const { root, paths } = await site(t);
  const record = await installSiteZipp({ root, ...quiet });
  assert.equal(record.source, 'softn');
  assert.equal(record.sha256, SOFTN.source.sha256);
  assert.deepEqual(readFileSync(join(paths.site, 'zipp_wasm_bg.wasm')), Buffer.from(SOFTN.wasm));
  assert.deepEqual(readFileSync(join(paths.siteTorch, 'zipp_torch.wasm')), Buffer.from(SOFTN.torchWasm));
  const checked = await checkSiteZipp({ root });
  assert.equal(checked.differs, false);
  assert.equal(siteZippSource(root).sha256, SOFTN.source.sha256);
  assert.equal(withSiteZipp({ tag: 'v0.0.37', zipp: { release: 'other' } }, root).zipp.sha256, SOFTN.source.sha256);
});

test('a pinned release is installed by the Softn release\'s own installer, and the site runs it', async (t) => {
  const { root, paths } = await site(t);
  pin(root);
  const record = await installSiteZipp({ root, ...quiet });
  assert.equal(record.source, 'pin');
  assert.equal(record.release, 'v0.0.34');
  assert.deepEqual(record.softnZipp, { release: 'v0.0.33', sha256: SOFTN.source.sha256 });
  assert.deepEqual(readFileSync(join(paths.site, 'zipp_wasm_bg.wasm')), Buffer.from(OWN.wasm));
  assert.deepEqual(readFileSync(join(paths.siteTorch, 'zipp_torch.wasm')), Buffer.from(OWN.torchWasm));
  // The Softn release's own trees are as it shipped them.
  assert.deepEqual(readFileSync(join(paths.softn, 'zipp_wasm_bg.wasm')), Buffer.from(SOFTN.wasm));
  const checked = await checkSiteZipp({ root });
  assert.equal(checked.differs, true);
  assert.equal(checked.site.release, 'v0.0.34');
  // Taking the pin away is a change the check names until the site's ZIPP is installed again.
  rmSync(join(root, 'zipp-release.json'));
  await assert.rejects(checkSiteZipp({ root }), /with no zipp-release\.json it must be the Softn release's/);
  await installSiteZipp({ root, ...quiet });
  assert.equal((await checkSiteZipp({ root })).differs, false);
});

test('refused, with the site\'s ZIPP unchanged: a runtime or editors that cannot run it, a glue without a name it calls, an archive without the installer, a failed install', async (t) => {
  for (const [options, reason] of [
    [{ features: ['python-logic/1'] }, /cannot run a ZIPP of the site's own/],
    [{ editorFeatures: [] }, /cannot run a ZIPP of the site's own/],
    [{ needed: ['default', 'Engine', 'zippProfile'] }, /does not export zippProfile, which the installed Softn runtime calls/],
    [{ tools: false }, /carries no ZIPP installer/],
    [{ installer: 'console.error("download refused"); process.exit(1);\n' }, /was not installed: download refused/],
  ]) {
    const { root, paths } = await site(t, options);
    await installSiteZipp({ root, ...quiet });
    pin(root);
    await assert.rejects(installSiteZipp({ root, ...quiet }), reason);
    assert.deepEqual(readFileSync(join(paths.site, 'zipp_wasm_bg.wasm')), Buffer.from(SOFTN.wasm), 'the Softn release\'s ZIPP is still the site\'s');
    assert.deepEqual(readdirSync(dirname(paths.staging)).filter((name) => name === 'site-zipp-stage' && readdirSync(paths.staging).length), [], 'no staging left behind');
  }
});

test('a pin is a release and the digest of its SHA256SUMS, and an archive is held to the digest current.json records', async (t) => {
  const { root, paths } = await site(t);
  assert.equal(readPin(root), null);
  for (const bad of [{ release: '0.0.34', sumsSha256: 'a'.repeat(64) }, { release: 'v0.0.34' }, { release: 'v0.0.34', sumsSha256: 'A'.repeat(64) }]) {
    pin(root, bad);
    assert.throws(() => readPin(root), /must name a ZIPP release/);
  }
  pin(root, { release: 'v0.0.34', sumsSha256: 'f'.repeat(64) });
  await assert.rejects(installSiteZipp({ root, ...quiet }), /names v0\.0\.34 \(ffffffffffff\)/);
  pin(root);
  writeFileSync(join(paths.releases, 'v0.0.37', 'softn-formlogic-runtime-v0.0.37.zip'), 'changed');
  await assert.rejects(installSiteZipp({ root, ...quiet }), /archive of the installed Softn release v0\.0\.37 \([0-9a-f]{12}\) is not kept/);
});

test("a glue's exports are read from its text, as wasm-bindgen writes them", () => {
  assert.deepEqual([...glueExports('export default async function init() {}\nexport class Engine {}\nexport function zippProfile() {}\nexport const x = 1;\nexport { a as accelGuestCall, b };\n')].sort(), ['Engine', 'accelGuestCall', 'b', 'default', 'x', 'zippProfile'].sort());
  assert.throws(() => assertRunsSiteZipp({ hostedRuntime: '/nowhere', appEditors: '/nowhere' }, '', 'v0'), /ENOENT/);
});

test('a pinned ZIPP already in place is kept without asking the installer again (offline), and set aside in a Softn source checkout', async (t) => {
  const { root } = await site(t);
  pin(root);
  await installSiteZipp({ root, ...quiet });
  // The installer would now fail: the second run must not need it.
  const { paths } = { paths: sitePaths(root) };
  const current = JSON.parse(readFileSync(join(paths.releases, 'current.json'), 'utf8'));
  writeFileSync(join(paths.releases, 'current.json'), JSON.stringify({ ...current, sha256: 'e'.repeat(64) }));
  const again = await installSiteZipp({ root, ...quiet });
  assert.equal(again.source, 'pin');
  assert.equal(again.release, 'v0.0.34');
  // A source checkout (SOFTN_REPO) builds a runtime that declares nothing: the pin is set aside there.
  process.env.SOFTN_REPO = root;
  t.after(() => { delete process.env.SOFTN_REPO; });
  const said = [];
  const record = await installSiteZipp({ root, log: (line) => said.push(line) });
  assert.equal(record.source, 'softn');
  assert.match(said.join('\n'), /set aside in a Softn source checkout/);
  assert.equal((await checkSiteZipp({ root })).differs, false);
});

test("without a pin, the Softn release's torch package is the runtime's copy only when it is the recorded one", async (t) => {
  const { root, paths } = await site(t);
  writeFileSync(join(paths.hostedRuntime, 'assets/core-runtime/zipp_torch.wasm'), 'another torch');
  await assert.rejects(installSiteZipp({ root, ...quiet }), /torch package \([0-9a-f]{12}\) is not installed/);
  assert.equal(siteZippSource(root), null, 'nothing was put in place');
});