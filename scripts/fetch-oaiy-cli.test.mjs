/**
 * scripts/fetch-oaiy-cli.mjs against releases built to the contract
 * (oaiy.com/scripts/pack-cli-asset.mjs writes the real asset, release.yml
 * publishes the SHA256SUMS.txt and the attested evidence beside it): what is
 * refused, what is installed, and what the frozen record carries. Fixtures
 * only — no network, no oaiy.com checkout — and a temporary FormLogic-shaped
 * root stands in for the repository so nothing here touches the tree.
 *
 * The fixtures keep the real release's shapes (the `capabilities --json`
 * blocks, the evidence's `cli`/`verification`/`dependencyAudit`/`artifacts`,
 * the tarball's root-level SHA256SUMS) and none of its digests: every sha256
 * here is computed from the fixture's own bytes, because a digest literal in
 * a test is a pin, and the identity of a release is the frozen record's
 * business, never a constant in this tree.
 *
 * Two of these tests exist for mistakes that would pass every other one:
 * `run.languages` is ["javascript"] in a perfectly good release, so a Python
 * check that read it would refuse every release forever; and the frozen
 * digest comes from the release's own SHA256SUMS.txt, so `--resolve-only`
 * must never download the asset it is freezing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fetchOaiyCli, resolveOnly, resolveRelease, loadFrozen, untar, parseSums, ReleaseError, FROZEN_FORMAT, SUMS_FILE, CAPABILITIES_FILE } from './fetch-oaiy-cli.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quiet = { log: () => {} };
const TAG = 'v0.0.5';
const VERSION = '0.0.5';
const COMMIT = 'b'.repeat(40);
const OTHER_COMMIT = 'c'.repeat(40);
const ZIPP_REVISION = 'e'.repeat(40);
const RUN_ID = '35174653676';
/** What FormLogic speaks (formlogic/ui/src/lib/oaiy/protocol.json); `run` is deliberately not among them. */
const PROTOCOLS = { script: 1, profile: 1 };

// ── A release, shaped like the real one ─────────────────────────────────────

// The ustar writer from oaiy.com/scripts/pack-cli-asset.mjs (Apache-2.0),
// kept here so the fixtures are the format the real packer emits — headers
// with a correct checksum, a directory entry per folder, two zero blocks at
// the end. `type` is a parameter because the reader's refusals (a symbolic
// link, a pax header) can only be provoked by writing one.
function octal(n, width) { return n.toString(8).padStart(width - 1, '0') + '\0'; }
function tarHeader({ name, size = 0, mode = 0o644, type = '0', mtime = 0 }) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(mtime, 12), 136);
  block.write('        ', 148);
  block.write(type, 156, 1);
  block.write('ustar\0', 257);
  block.write('00', 263);
  block.write('root', 265, 32);
  block.write('root', 297, 32);
  block.write(octal(0, 8), 329);
  block.write(octal(0, 8), 337);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}
/** `entries` is path -> Buffer for files; `extra` appends raw headers (a link, a device) the reader must refuse. */
function tarball(entries, extra = []) {
  const parts = [];
  const dirs = new Set();
  for (const name of Object.keys(entries)) {
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'));
  }
  for (const dir of [...dirs].sort()) parts.push(tarHeader({ name: `${dir}/`, mode: 0o755, type: '5' }));
  for (const [name, bytes] of Object.entries(entries)) {
    parts.push(tarHeader({ name, size: bytes.length }));
    parts.push(bytes);
    const pad = (512 - (bytes.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  for (const header of extra) parts.push(tarHeader(header));
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

/** The CLI's own files, as pack-cli-asset.mjs stages them. */
function cliFiles(body = 'export const oaiy = 1;\n') {
  return {
    'oaiy.mjs': Buffer.from(`#!/usr/bin/env node\n${body}`),
    'oaiy-zipp-worker.mjs': Buffer.from('export const zippWorker = 1;\n'),
    'oaiy-script-worker.mjs': Buffer.from('export const scriptWorker = 1;\n'),
    'node_modules/undici/index.js': Buffer.from('module.exports = {};\n'),
    'zipp/SOURCE.json': Buffer.from(JSON.stringify({ release: 'v0.0.19', revision: ZIPP_REVISION }, null, 2) + '\n'),
    'zipp/zipp_wasm_bg.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  };
}

/**
 * `oaiy capabilities --json` as the CLI prints it and the packer writes it
 * into the asset verbatim. `run.languages` is the typed literal of the
 * `oaiy run` lane and stays ["javascript"] even when the engine runs Python;
 * `engine.languages` and `script.languages` are the engine's own list.
 */
function capabilitiesReport(files, { engine = {}, protocols = { run: 1, script: 1, profile: 1 }, languages = ['javascript', 'python'] } = {}) {
  return {
    version: '0.2.0',
    protocols,
    engine: {
      name: 'zipp',
      release: 'v0.0.19',
      version: '0.0.19',
      revision: ZIPP_REVISION,
      variant: 'javascript-python',
      bundle: 'zipp-wasm-0.0.19-web-python.zip',
      wasmSha256: sha256(files['zipp/zipp_wasm_bg.wasm']),
      glueSha256: sha256(files['oaiy-zipp-worker.mjs']),
      languages,
      status: 'ready',
      ...engine,
    },
    run: { languages: ['javascript'], defaultInstructionSteps: 50000000, maxInstructionSteps: 2000000000 },
    script: { languages, defaultBudgetMs: 1000, maxBudgetMs: 60000 },
  };
}

/**
 * The asset: the CLI's files, `oaiy-cli.json`, and a root-level SHA256SUMS
 * over every file but itself. `tamper` edits the entry map after the sums are
 * written, which is how a file that disagrees with the manifest, a missing
 * one and an extra one are made.
 */
function cliAsset({ capabilities = null, files = cliFiles(), tamper = null, extraHeaders = [] } = {}) {
  const report = capabilities ?? capabilitiesReport(files);
  const entries = { ...files, [CAPABILITIES_FILE]: Buffer.from(JSON.stringify(report, null, 2) + '\n') };
  const sums = Object.keys(entries).sort().map((name) => `${sha256(entries[name])}  ${name}\n`).join('');
  entries[SUMS_FILE] = Buffer.from(sums);
  if (tamper) tamper(entries);
  const archive = gzipSync(tarball(entries, extraHeaders));
  return { archive, sha256: sha256(archive), capabilities: report, name: `oaiy-cli-${VERSION}.tar.gz` };
}

/** The evidence the linux leg writes and attest-release-evidence.mjs stamps. */
function evidenceFor(asset, { revision = COMMIT, verification = {}, dependencyAudit = {}, cli = {}, artifacts = null } = {}) {
  return {
    component: 'desktop+headless',
    version: VERSION,
    revision,
    target: 'linux',
    cli: { asset: asset.name, sha256: asset.sha256, protocols: asset.capabilities.protocols, engine: asset.capabilities.engine, run: asset.capabilities.run, script: asset.capabilities.script, ...cli },
    verification: { status: 'verified', result: 'success', revision, run: { id: RUN_ID, attempt: '1' }, attestedAt: '2026-09-17T02:43:21.936Z', ...verification },
    dependencyAudit: { status: 'pass', tool: 'npm audit --audit-level=high', level: 'high', revision, run: { id: RUN_ID, attempt: '1' }, ...dependencyAudit },
    artifacts: artifacts ?? [{ name: asset.name, sha256: asset.sha256 }, { name: `oaiy-desktop-${VERSION}-linux-amd64.deb`, sha256: sha256('deb') }],
    builtAt: '2026-09-17T02:42:02.735Z',
  };
}

/**
 * A published release: the CLI asset, the evidence files, SHA256SUMS.txt over
 * everything, and the installers a real release also carries. `assets` is
 * what the API answers with; `bytes` is what a download returns.
 */
function publishedRelease({ tag = TAG, commit = COMMIT, asset = cliAsset(), evidence = null, withCli = true, withEvidence = true, withSums = true, sumsFor = null, digest = null } = {}) {
  const evidenceJson = evidence ?? evidenceFor(asset, { revision: commit });
  const bytes = new Map();
  const names = [];
  if (withCli) { bytes.set(asset.name, asset.archive); names.push(asset.name); }
  for (const installer of [`oaiy-desktop-${VERSION}-linux-amd64.deb`, `oaiy-server-${VERSION}-linux-x86_64.tar.gz`, `oaiy-web-${VERSION}.zip`]) {
    bytes.set(installer, Buffer.from(`${installer} fixture`));
    names.push(installer);
  }
  if (withEvidence) {
    const text = Buffer.from(JSON.stringify(evidenceJson, null, 2) + '\n');
    bytes.set('release-evidence-linux.json', text);
    names.push('release-evidence-linux.json');
  }
  if (withSums) {
    const covered = sumsFor ?? [...bytes.keys()];
    bytes.set('SHA256SUMS.txt', Buffer.from(covered.map((name) => `${sha256(bytes.get(name) ?? Buffer.from(name))}  ${name}\n`).join('')));
    names.push('SHA256SUMS.txt');
  }
  const assets = names.map((name, index) => ({
    id: 1000 + index,
    name,
    browser_download_url: `https://example.test/${tag}/${name}`,
    url: `https://api.example.test/${tag}/${name}`,
    ...(name === asset.name && digest !== false ? { digest: `sha256:${digest ?? asset.sha256}` } : {}),
  }));
  return { tag, commit, asset, evidence: evidenceJson, assets, bytes };
}

/**
 * A GitHub API stand-in: releases by tag (with `latest` naming one of them),
 * annotated tags pointing at commits, and asset downloads. `requests` records
 * every URL asked for, which is how "the asset was never downloaded" and
 * "no older release was ever asked for" are asserted.
 */
function githubApi({ latest = null, releases = {}, tagCommits = {} } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/releases/latest')) return latest && releases[latest] ? new Response(releaseJson(releases[latest]), { status: 200 }) : new Response('', { status: 404 });
    let m = /\/releases\/tags\/([^/]+)$/.exec(url);
    if (m) { const release = releases[decodeURIComponent(m[1])]; return release ? new Response(releaseJson(release), { status: 200 }) : new Response('', { status: 404 }); }
    m = /\/git\/ref\/tags\/([^/]+)$/.exec(url);
    if (m) { const tag = decodeURIComponent(m[1]); return tagCommits[tag] ? new Response(JSON.stringify({ object: { type: 'tag', sha: `tagobject-${tag}` } }), { status: 200 }) : new Response('', { status: 404 }); }
    m = /\/git\/tags\/tagobject-(.+)$/.exec(url);
    if (m) return new Response(JSON.stringify({ object: { type: 'commit', sha: tagCommits[m[1]] } }), { status: 200 });
    m = /example\.test\/([^/]+)\/(.+)$/.exec(url);
    if (m && releases[m[1]]?.bytes.has(decodeURIComponent(m[2]))) return new Response(releases[m[1]].bytes.get(decodeURIComponent(m[2])), { status: 200 });
    return new Response('', { status: 404 });
  };
  const releaseJson = (release) => JSON.stringify({ tag_name: release.tag, target_commitish: 'main', html_url: `https://example.test/${release.tag}`, assets: release.assets });
  return { fetchImpl, requests };
}

/** One release, served as latest and by tag, with its annotated tag resolving to its commit. */
function serving(release) {
  return githubApi({ latest: release.tag, releases: { [release.tag]: release }, tagCommits: { [release.tag]: release.commit } });
}

/** A FormLogic-shaped root: the one file the fetcher reads from the tree, and the folders it writes. */
async function formlogicRoot(t, { protocols = PROTOCOLS } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-fetch-oaiy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'formlogic/ui/src/lib/oaiy'), { recursive: true });
  await writeFile(resolve(root, 'formlogic/ui/src/lib/oaiy/protocol.json'), JSON.stringify(protocols, null, 2) + '\n');
  return root;
}
const installed = (root, name = '') => resolve(root, '.runtime-source/oaiy-cli/cli', name);
const currentRecord = async (root) => JSON.parse(await readFile(resolve(root, '.runtime-source/oaiy-cli/current.json'), 'utf8'));

// ── What a good release does ────────────────────────────────────────────────

test('a release carrying the CLI asset installs it, records what it installed, and reuses the download', async (t) => {
  const root = await formlogicRoot(t);
  const release = publishedRelease();
  const api = serving(release);
  const record = await fetchOaiyCli({ root, fetchImpl: api.fetchImpl, token: null, ...quiet });

  assert.equal(record.tag, TAG);
  assert.equal(record.tagCommit, COMMIT);
  assert.equal(record.source, 'release');
  assert.equal(record.assetSha256, release.asset.sha256);
  assert.equal(record.evidence.runId, RUN_ID);
  assert.equal(record.capabilities.engine.release, 'v0.0.19');
  assert.deepEqual(record.capabilities.protocols, { run: 1, script: 1, profile: 1 }, 'the record keeps OAIY\'s whole protocol map, including the run FormLogic does not speak');
  assert.equal(record.install.dir, '.runtime-source/oaiy-cli/cli');

  // The install is the asset's files, at the paths the parity test spawns.
  assert.ok(existsSync(installed(root, 'oaiy.mjs')));
  assert.ok(existsSync(installed(root, 'zipp/zipp_wasm_bg.wasm')));
  assert.ok(existsSync(installed(root, 'node_modules/undici/index.js')));
  assert.equal(JSON.parse(await readFile(installed(root, CAPABILITIES_FILE), 'utf8')).engine.status, 'ready');
  assert.deepEqual((await readdir(installed(root))).sort(), [SUMS_FILE, CAPABILITIES_FILE, 'node_modules', 'oaiy-script-worker.mjs', 'oaiy-zipp-worker.mjs', 'oaiy.mjs', 'zipp'].sort());
  assert.ok(!(await readdir(resolve(root, '.runtime-source/oaiy-cli'))).some((name) => name.startsWith('.oaiy-cli-') || name.endsWith('.previous')), 'no staging or previous tree outlives the install');

  // A second run downloads the release records again (they are how a replaced
  // asset is caught) but not the three megabytes it already has intact.
  const before = api.requests.filter((url) => url.endsWith(release.asset.name)).length;
  await fetchOaiyCli({ root, fetchImpl: api.fetchImpl, token: null, ...quiet });
  assert.equal(api.requests.filter((url) => url.endsWith(release.asset.name)).length, before, 'the asset is reused while its digest still matches');
});

test('a release whose engine runs Python installs although run.languages is JavaScript alone', async (t) => {
  // The regression this test exists for: `run.languages` is the typed literal
  // ["javascript"] of the `oaiy run` lane in every release ever built, so a
  // Python check that read it would refuse them all. The engine's own list is
  // what says whether Python runs.
  const root = await formlogicRoot(t);
  const release = publishedRelease();
  assert.deepEqual(release.asset.capabilities.run.languages, ['javascript'], 'the fixture is the shape the real release has');
  assert.deepEqual(release.asset.capabilities.engine.languages, ['javascript', 'python']);
  const record = await fetchOaiyCli({ root, fetchImpl: serving(release).fetchImpl, token: null, ...quiet });
  assert.deepEqual(record.capabilities.engine.languages, ['javascript', 'python']);
});

test('a second install replaces the first, leaving no file of the previous one', async (t) => {
  const root = await formlogicRoot(t);
  const first = publishedRelease();
  await fetchOaiyCli({ root, fetchImpl: serving(first).fetchImpl, token: null, ...quiet });
  await writeFile(installed(root, 'left-over.mjs'), 'from the previous install');

  const files = cliFiles('export const oaiy = 2;\n');
  const next = publishedRelease({ tag: 'v0.0.6', commit: OTHER_COMMIT, asset: cliAsset({ files }) });
  const record = await fetchOaiyCli({ root, tag: 'v0.0.6', fetchImpl: githubApi({ latest: 'v0.0.6', releases: { 'v0.0.6': next }, tagCommits: { 'v0.0.6': OTHER_COMMIT } }).fetchImpl, token: null, ...quiet });
  assert.equal(record.tag, 'v0.0.6');
  assert.ok(!existsSync(installed(root, 'left-over.mjs')));
  assert.match(await readFile(installed(root, 'oaiy.mjs'), 'utf8'), /export const oaiy = 2;/);
});

// ── One release per run: the frozen record ──────────────────────────────────

test('--resolve-only freezes the digest the release publishes, without downloading the asset', async (t) => {
  const root = await formlogicRoot(t);
  const release = publishedRelease();
  const api = serving(release);
  const frozen = await resolveOnly({ root, fetchImpl: api.fetchImpl, token: null, frozenPath: 'oaiy-cli-frozen.json', ...quiet });

  assert.equal(frozen.formatVersion, FROZEN_FORMAT);
  assert.equal(frozen.source, 'release');
  assert.equal(frozen.tag, TAG);
  assert.equal(frozen.tagCommit, COMMIT, 'the commit the annotated tag points at, not the release\'s target_commitish');
  assert.equal(frozen.assetName, release.asset.name);
  assert.equal(frozen.assetSha256, release.asset.sha256);
  assert.equal(frozen.assetId, release.assets.find((a) => a.name === release.asset.name).id);
  assert.equal(frozen.evidenceAssetId, release.assets.find((a) => a.name === 'release-evidence-linux.json').id);
  // The digest is the release's own record of the bytes, so freezing it must
  // not involve the bytes: a run that downloaded and hashed them would freeze
  // whatever it was served, which is exactly what freezing is meant to stop.
  assert.ok(!api.requests.some((url) => url.endsWith(release.asset.name)), 'the asset itself is never downloaded to freeze it');
  assert.deepEqual(JSON.parse(await readFile(resolve(root, 'oaiy-cli-frozen.json'), 'utf8')), frozen);

  const record = await fetchOaiyCli({ root, frozen: 'oaiy-cli-frozen.json', fetchImpl: api.fetchImpl, token: null, ...quiet });
  assert.equal(record.frozen.assetSha256, release.asset.sha256);
  assert.equal(record.tag, TAG);
});

test('a frozen run refuses a release whose asset, tag or evidence moved under it', async (t) => {
  const root = await formlogicRoot(t);
  const release = publishedRelease();
  const frozen = await resolveOnly({ root, fetchImpl: serving(release).fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet });

  // The asset was replaced: same name, other bytes, so the release's own sums say something else.
  const replaced = publishedRelease({ asset: cliAsset({ files: cliFiles('export const oaiy = 99;\n') }) });
  await assert.rejects(fetchOaiyCli({ root, frozen: 'frozen.json', fetchImpl: serving(replaced).fetchImpl, token: null, ...quiet }), /now publishes oaiy-cli-0\.0\.5\.tar\.gz with digest .*The asset was replaced since this run resolved it\./);

  // The tag moved to another commit.
  const moved = githubApi({ latest: TAG, releases: { [TAG]: release }, tagCommits: { [TAG]: OTHER_COMMIT } });
  await assert.rejects(fetchOaiyCli({ root, frozen: 'frozen.json', fetchImpl: moved.fetchImpl, token: null, ...quiet }), /Tag v0\.0\.5 now points at cccccccccccc; the frozen record says bbbbbbbbbbbb\./);

  // The evidence was re-uploaded: the release is the same, the file this run
  // froze is not the file it would now read.
  const reuploaded = publishedRelease();
  reuploaded.assets.find((asset) => asset.name === 'release-evidence-linux.json').id += 500;
  await assert.rejects(fetchOaiyCli({ root, frozen: 'frozen.json', fetchImpl: serving(reuploaded).fetchImpl, token: null, ...quiet }), /now publishes a different release-evidence-linux\.json \(id \d+\) from the one this run froze \(id \d+\)/);

  // The asset is gone from the release entirely.
  const without = publishedRelease({ withCli: false });
  await assert.rejects(fetchOaiyCli({ root, frozen: 'frozen.json', fetchImpl: serving(without).fetchImpl, token: null, ...quiet }), /carries no oaiy-cli-\*\.tar\.gz asset/);

  assert.equal(frozen.tag, TAG);
  assert.ok(!existsSync(installed(root, 'oaiy.mjs')), 'nothing is installed by a refused run');
});

test('a frozen record packed from a local checkout is a developer\'s, and CI refuses it', async (t) => {
  const root = await formlogicRoot(t);
  const local = { formatVersion: FROZEN_FORMAT, source: 'local', tag: 'local:../oaiy.com', tagCommit: null, assetName: 'oaiy-cli-local.tar.gz', assetSha256: null };
  await writeFile(resolve(root, 'local-frozen.json'), JSON.stringify(local));
  assert.equal((await loadFrozen('local-frozen.json', root, { inCi: false })).source, 'local');
  await assert.rejects(loadFrozen('local-frozen.json', root, { inCi: true }), /packed from a local OAIY checkout \(source: "local"\); CI installs published releases only\./);
  await assert.rejects(loadFrozen('missing.json', root, { inCi: false }), /does not exist; run node scripts\/fetch-oaiy-cli\.mjs --resolve-only/);

  // And a run that has frozen a release does not quietly pack a checkout instead.
  const release = publishedRelease();
  await resolveOnly({ root, fetchImpl: serving(release).fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet });
  await assert.rejects(fetchOaiyCli({ root, frozen: 'frozen.json', oaiyRepo: '../oaiy.com', fetchImpl: serving(release).fetchImpl, token: null, ...quiet }), /OAIY_REPO packs the CLI from \.\.\/oaiy\.com while the frozen release record for this run names v0\.0\.5; one run installs one CLI\./);
});

// ── The release that has no CLI asset: refuse, never walk back ──────────────

test('a release without the CLI asset is refused in both --resolve-only and a fetch, and no older release is tried', async (t) => {
  // The published shape before the CLI was packed: the installers and a
  // SHA256SUMS.txt, no oaiy-cli-*.tar.gz and no evidence file at all.
  // Walking back to an older release would adopt an engine the owner did not
  // choose, and every older release lacks the asset too, so the walk could
  // only end in this same refusal one tag later.
  const root = await formlogicRoot(t);
  const older = publishedRelease({ tag: 'v0.0.3', commit: OTHER_COMMIT, withCli: false, withEvidence: false });
  const latest = publishedRelease({ tag: 'v0.0.4', commit: COMMIT, withCli: false, withEvidence: false });
  const api = githubApi({ latest: 'v0.0.4', releases: { 'v0.0.4': latest, 'v0.0.3': older }, tagCommits: { 'v0.0.4': COMMIT, 'v0.0.3': OTHER_COMMIT } });

  const expected = /OAIY release v0\.0\.4 carries no oaiy-cli-\*\.tar\.gz asset \(assets: .*\)\. FormLogic needs an OAIY release built with the standalone CLI asset; pin an older one with OAIY_CLI_RELEASE=<tag> or wait for the next release\./;
  await assert.rejects(resolveOnly({ root, fetchImpl: api.fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet }), expected);
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: api.fetchImpl, token: null, ...quiet }), (error) => {
    assert.ok(error instanceof ReleaseError, `a release error, not a crash: ${error}`);
    assert.match(error.message, expected);
    return true;
  });
  assert.ok(!api.requests.some((url) => url.includes('v0.0.3')), 'the older release is never asked for');
  assert.ok(!existsSync(resolve(root, 'frozen.json')), 'a release that cannot be used is not frozen either');
});

test('a release that publishes the asset without covering it in SHA256SUMS.txt is its own refusal', async (t) => {
  const root = await formlogicRoot(t);
  const asset = cliAsset();
  // SHA256SUMS.txt covering everything except the CLI asset: there is no
  // release-side digest for the bytes, which is never a "nothing to check,
  // continue".
  const uncovered = publishedRelease({ asset, sumsFor: [`oaiy-desktop-${VERSION}-linux-amd64.deb`, 'release-evidence-linux.json'] });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(uncovered).fetchImpl, token: null, ...quiet }), /SHA256SUMS\.txt does not cover oaiy-cli-0\.0\.5\.tar\.gz; the release publishes the asset without publishing its digest/);

  const noSums = publishedRelease({ asset, withSums: false });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(noSums).fetchImpl, token: null, ...quiet }), /carries oaiy-cli-0\.0\.5\.tar\.gz but no SHA256SUMS\.txt; there is no release-side digest/);
});

test('bytes that are not the ones the release publishes are refused', async (t) => {
  const root = await formlogicRoot(t);
  const release = publishedRelease();
  // The release page's records stay as they are; the download answers with
  // another build of the same asset.
  release.bytes.set(release.asset.name, cliAsset({ files: cliFiles('export const oaiy = 3;\n') }).archive);
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(release).fetchImpl, token: null, ...quiet }), /downloaded as [0-9a-f]{12}, but OAIY release v0\.0\.5 publishes [0-9a-f]{12}/);
  assert.ok(!existsSync(installed(root, 'oaiy.mjs')));
});

test('a release whose two digest records disagree is not frozen', async (t) => {
  // GitHub's own digest for the uploaded asset and the release's
  // SHA256SUMS.txt are two independent statements about one file.
  const root = await formlogicRoot(t);
  const release = publishedRelease({ digest: 'a'.repeat(64) });
  await assert.rejects(resolveOnly({ root, fetchImpl: serving(release).fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet }), /the release contradicts itself and is not frozen/);
});

// ── The evidence ────────────────────────────────────────────────────────────

test('a release with no attested evidence is refused, naming the file', async (t) => {
  const root = await formlogicRoot(t);
  const release = publishedRelease({ withEvidence: false });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(release).fetchImpl, token: null, ...quiet }), /carries oaiy-cli-0\.0\.5\.tar\.gz but no release-evidence-linux\.json; the build that packed the CLI attested nothing/);
});

test('evidence that is unverified, unaudited, unattributed or from another revision is refused', async (t) => {
  const root = await formlogicRoot(t);
  const asset = cliAsset();
  const cases = [
    [{ verification: { status: 'unverified' } }, /records verification\.status "unverified", not "verified"/],
    [{ dependencyAudit: { status: 'pending' } }, /records dependencyAudit\.status "pending", not "pass"/],
    [{ verification: { run: {} } }, /is verified but names no verification\.run\.id/],
  ];
  for (const [overrides, expected] of cases) {
    const release = publishedRelease({ asset, evidence: evidenceFor(asset, { revision: COMMIT, ...overrides }) });
    await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(release).fetchImpl, token: null, ...quiet }), expected);
  }
  // Evidence for another revision: the release page's tag points one way, the evidence was built from another.
  const foreign = publishedRelease({ asset, evidence: evidenceFor(asset, { revision: OTHER_COMMIT }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(foreign).fetchImpl, token: null, ...quiet }), /was built from cccccccccccc, but tag v0\.0\.5 points at bbbbbbbbbbbb; the evidence is not this tag's build\./);
  assert.ok(!existsSync(installed(root, 'oaiy.mjs')));
});

test('evidence that does not record the asset at the published digest is refused', async (t) => {
  const root = await formlogicRoot(t);
  const asset = cliAsset();
  const noArtifact = publishedRelease({ asset, evidence: evidenceFor(asset, { artifacts: [{ name: `oaiy-web-${VERSION}.zip`, sha256: sha256('web') }] }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(noArtifact).fetchImpl, token: null, ...quiet }), /records 1 artifacts and oaiy-cli-0\.0\.5\.tar\.gz is not among them/);

  const otherDigest = publishedRelease({ asset, evidence: evidenceFor(asset, { artifacts: [{ name: asset.name, sha256: 'd'.repeat(64) }] }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(otherDigest).fetchImpl, token: null, ...quiet }), /records oaiy-cli-0\.0\.5\.tar\.gz at dddddddddddd; the release publishes/);

  const otherCli = publishedRelease({ asset, evidence: evidenceFor(asset, { cli: { sha256: 'd'.repeat(64) } }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(otherCli).fetchImpl, token: null, ...quiet }), /records cli\.sha256 dddddddddddd; the release publishes/);
});

// ── The tarball's own manifest ──────────────────────────────────────────────

test('an asset whose files disagree with its own SHA256SUMS is refused, file by file', async (t) => {
  const root = await formlogicRoot(t);
  const changed = cliAsset({ tamper: (entries) => { entries['oaiy.mjs'] = Buffer.from('#!/usr/bin/env node\nother bytes\n'); } });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: changed })).fetchImpl, token: null, ...quiet }), /oaiy\.mjs in oaiy-cli-0\.0\.5\.tar\.gz has digest [0-9a-f]{12}; its SHA256SUMS records [0-9a-f]{12}/);

  const missing = cliAsset({ tamper: (entries) => { delete entries['zipp/SOURCE.json']; } });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: missing })).fetchImpl, token: null, ...quiet }), /SHA256SUMS lists zipp\/SOURCE\.json, which is not in the asset/);

  const extra = cliAsset({ tamper: (entries) => { entries['zipp/extra.mjs'] = Buffer.from('not described anywhere\n'); } });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: extra })).fetchImpl, token: null, ...quiet }), /zipp\/extra\.mjs is in oaiy-cli-0\.0\.5\.tar\.gz but not in its SHA256SUMS/);

  const noSums = cliAsset({ tamper: (entries) => { delete entries[SUMS_FILE]; } });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: noSums })).fetchImpl, token: null, ...quiet }), /carries no SHA256SUMS; the asset describes none of its own files/);
});

test('an asset carrying a link, or missing the CLI itself, is refused rather than quietly unpacked', async (t) => {
  const root = await formlogicRoot(t);
  // A symbolic link is a name whose bytes the manifest never saw; an
  // extractor that skipped it would call the archive complete.
  const linked = cliAsset({ extraHeaders: [{ name: 'oaiy-link.mjs', type: '2' }] });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: linked })).fetchImpl, token: null, ...quiet }), /oaiy-link\.mjs is a symbolic link; the OAIY CLI asset carries regular files only/);

  const pax = cliAsset({ extraHeaders: [{ name: 'PaxHeaders/oaiy.mjs', type: 'x' }] });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: pax })).fetchImpl, token: null, ...quiet }), /is a pax header; the OAIY CLI asset carries regular files only/);

  // Every digest checks, and there is no CLI to run.
  const files = cliFiles();
  delete files['oaiy.mjs'];
  const headless = cliAsset({ files, capabilities: capabilitiesReport({ ...cliFiles() }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: headless })).fetchImpl, token: null, ...quiet }), /is missing oaiy\.mjs; it is not an OAIY CLI/);
});

test('untar refuses what it cannot account for, and parseSums refuses a line it cannot read', () => {
  const bytes = Buffer.from('a file\n');
  const good = untar(tarball({ 'a/b.txt': bytes }));
  assert.deepEqual([...good.keys()], ['a/b.txt'], 'directory entries are not files');
  assert.ok(good.get('a/b.txt').equals(bytes));
  assert.throws(() => untar(tarball({ '../escape.txt': bytes })), /is an absolute or escaping path/);
  assert.throws(() => untar(Buffer.alloc(512, 0x41)), /is not a ustar archive/);
  assert.throws(() => untar(tarball({})), /holds no files/);
  assert.equal(parseSums(`${'a'.repeat(64)}  x.mjs\n`, 'a manifest').get('x.mjs'), 'a'.repeat(64));
  assert.throws(() => parseSums('not a sums line\n', 'a manifest'), /has a line that is not "<sha256>  <file>"/);
  assert.throws(() => parseSums(`${'a'.repeat(64)}  x.mjs\n${'b'.repeat(64)}  x.mjs\n`, 'a manifest'), /lists x\.mjs twice/);
});

// ── The engine inside, and this tree ────────────────────────────────────────

test('an asset whose capabilities differ from the release evidence is refused, naming the block', async (t) => {
  // The tarball says one thing about its engine and the release record
  // another: one of them describes a build that is not in this asset.
  const root = await formlogicRoot(t);
  const files = cliFiles();
  const asset = cliAsset({ files, capabilities: capabilitiesReport(files, { engine: { revision: 'f'.repeat(40) } }) });
  const release = publishedRelease({ asset, evidence: evidenceFor({ ...asset, capabilities: capabilitiesReport(files) }, { revision: COMMIT }) });
  release.evidence.cli.asset = asset.name;
  release.evidence.cli.sha256 = asset.sha256;
  release.bytes.set('release-evidence-linux.json', Buffer.from(JSON.stringify(release.evidence, null, 2) + '\n'));
  release.bytes.set('SHA256SUMS.txt', Buffer.from([...release.bytes.keys()].filter((n) => n !== 'SHA256SUMS.txt').map((name) => `${sha256(release.bytes.get(name))}  ${name}\n`).join('')));
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(release).fetchImpl, token: null, ...quiet }), /oaiy-cli\.json in oaiy-cli-0\.0\.5\.tar\.gz and release-evidence-linux\.json disagree about engine:/);
});

test('an engine that is not ready, or cannot run Python, is refused', async (t) => {
  const root = await formlogicRoot(t);
  const files = cliFiles();
  const unavailable = cliAsset({ files, capabilities: capabilitiesReport(files, { engine: { status: 'unavailable', reason: 'no wasm bundle installed' } }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: unavailable })).fetchImpl, token: null, ...quiet }), /reports status "unavailable" \(no wasm bundle installed\), not "ready"/);

  // A JavaScript-only engine: `engine.languages` and `script.languages` both
  // say so, and `run.languages` says what it always says.
  const jsOnly = cliAsset({ files, capabilities: capabilitiesReport(files, { languages: ['javascript'], engine: { variant: 'javascript' } }) });
  await assert.rejects(fetchOaiyCli({ root, fetchImpl: serving(publishedRelease({ asset: jsOnly })).fetchImpl, token: null, ...quiet }), /runs javascript; FormLogic's leaf scripts are Python as well as JavaScript, so a release whose engine\.languages lacks python is refused/);
  assert.ok(!existsSync(installed(root, 'oaiy.mjs')));
});

test('protocols are compared as a subset: a version FormLogic speaks must match, a protocol it does not speak is OAIY\'s business', async (t) => {
  const files = cliFiles();
  const behind = cliAsset({ files, capabilities: capabilitiesReport(files, { protocols: { run: 1, script: 1, profile: 2 } }) });
  const ahead = await formlogicRoot(t);
  await assert.rejects(fetchOaiyCli({ root: ahead, fetchImpl: serving(publishedRelease({ asset: behind })).fetchImpl, token: null, ...quiet }), /speaks profile 2; this FormLogic speaks 1 \(formlogic\/ui\/src\/lib\/oaiy\/protocol\.json\)/);

  // FormLogic claiming a protocol the CLI does not report at all.
  const claiming = await formlogicRoot(t, { protocols: { script: 1, profile: 1, sync: 3 } });
  await assert.rejects(fetchOaiyCli({ root: claiming, fetchImpl: serving(publishedRelease()).fetchImpl, token: null, ...quiet }), /speaks sync null; this FormLogic speaks 3/);

  // And the other way round: OAIY reporting `run`, which FormLogic's file does
  // not name, installs — FormLogic never drives an OAIY workflow.
  const root = await formlogicRoot(t);
  const record = await fetchOaiyCli({ root, fetchImpl: serving(publishedRelease()).fetchImpl, token: null, ...quiet });
  assert.equal(record.capabilities.protocols.run, 1);
});

test('resolveRelease and a fetch refuse a tag that does not exist, and a release page that is not there', async (t) => {
  const root = await formlogicRoot(t);
  const api = serving(publishedRelease());
  await assert.rejects(resolveRelease({ tag: 'v9.9.9', token: null, fetchImpl: api.fetchImpl }), /OAIY has no release tagged v9\.9\.9/);
  await assert.rejects(resolveRelease({ tag: null, token: null, fetchImpl: githubApi({}).fetchImpl }), /has no published release yet/);
  await assert.rejects(fetchOaiyCli({ root, tag: 'v9.9.9', fetchImpl: api.fetchImpl, token: null, ...quiet }), /OAIY has no release tagged v9\.9\.9/);
});

test('a run cannot name one release while the frozen record names another', async (t) => {
  const root = await formlogicRoot(t);
  const release = publishedRelease();
  await resolveOnly({ root, fetchImpl: serving(release).fetchImpl, token: null, frozenPath: 'frozen.json', ...quiet });
  await assert.rejects(fetchOaiyCli({ root, tag: 'v0.0.6', frozen: 'frozen.json', fetchImpl: serving(release).fetchImpl, token: null, ...quiet }), /OAIY_CLI_RELEASE names v0\.0\.6 but the frozen release record for this run names v0\.0\.5; one run installs one release\./);
});
