#!/usr/bin/env node
/**
 * Take the Softn runtime FormLogic embeds from Softn's GitHub release, not
 * from a source build.
 *
 * Every Softn release (tag v*) carries `softn-formlogic-runtime-<tag>.zip`:
 * the hosted app runtime, the two embedded editors, the native backend
 * runtime and the FormLogic adapter source, built once by Softn's release
 * workflow and verified there. This script fetches the latest release (or the
 * one SOFTN_RELEASE names), proves the archive is the one the release page
 * describes and that it fits THIS FormLogic (same ZIPP engine bytes, same
 * protocol versions, the adapter this tree has vendored), and installs the
 * three generated trees where the build and the tests expect them:
 *
 *   hosted-runtime/  -> formlogic/ui/public/hosted-runtime/
 *   app-editors/     -> formlogic/ui/public/app-editors/
 *   native-runtime/  -> formlogic/backend/resources/softn-native/
 *
 *   node scripts/fetch-softn-release.mjs                 latest release
 *   SOFTN_RELEASE=v0.0.13 node scripts/fetch-softn-release.mjs   one release
 *   SOFTN_RELEASE_ARCHIVE=path/to.zip node scripts/fetch-softn-release.mjs  a local archive (its .sha256 beside it, when present)
 *   node scripts/fetch-softn-release.mjs --check         verify an existing install, no download
 *   node scripts/fetch-softn-release.mjs --sync-adapter  also refresh the vendored adapter from the release
 *
 * GITHUB_TOKEN / GH_TOKEN, when set, authenticate the API calls (the
 * unauthenticated limit is enough for a laptop, not for a busy CI account).
 * Downloads land under .runtime-source/softn-release/<tag>/ (ignored by git)
 * and are reused when their digest still matches. The record of what is
 * installed is .runtime-source/softn-release/current.json, which
 * scripts/ecosystem-manifest.mjs reads.
 *
 * Developers who want to run against a local Softn checkout instead keep the
 * source path: SOFTN_REPO with formlogic/ui `npm run build:hosted-runtime`,
 * `npm run build:app-editors` and scripts/prepare-native-runtime.mjs.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive } from './lib/archive.mjs';
import { runtimeIdentity, assertMatchingRuntime, installRuntimeArtifact, checkRuntimeArtifact } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';
import { checkAppEditors } from '../formlogic/ui/scripts/check-app-editors.mjs';
import { checkNativeRuntime } from './release-runtime.mjs';
import { writeAdapter, adapterDigest, ADAPTER_SOURCE } from '../formlogic/ui/scripts/sync-softn.mjs';

export const RELEASE_REPOSITORY = 'f2i-com/softn.com';
export const ASSET_PATTERN = /^softn-formlogic-runtime-.+\.zip$/;
const NATIVE_MODULES = ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'host-protocol.json', 'record-events.mjs'];
const NATIVE_EXTRA = ['wasm/zipp_wasm.mjs', 'wasm/zipp_wasm_bg.wasm', 'wasm/SOURCE.json', 'LICENSE', 'NOTICE', 'ZIPP-THIRD-PARTY-LICENSES.txt', 'provenance.json'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A refusal the operator can act on; the CLI prints it and exits 1. */
export class ReleaseError extends Error {}

function defaultPaths(root) {
  return {
    root,
    protocolFile: resolve(root, 'formlogic/ui/src/lib/softn/protocol.json'),
    zippSource: resolve(root, 'formlogic/ui/vendor/zipp-wasm/SOURCE.json'),
    adapterDir: resolve(root, 'formlogic/ui/src/lib/softn'),
    hostedRuntime: resolve(root, 'formlogic/ui/public/hosted-runtime'),
    appEditors: resolve(root, 'formlogic/ui/public/app-editors'),
    nativeRuntime: resolve(root, 'formlogic/backend/resources/softn-native'),
    cache: resolve(root, '.runtime-source/softn-release'),
  };
}

// ── Resolving and downloading ────────────────────────────────────────────────

function apiHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'formlogic-fetch-softn-release', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The release's asset descriptors from the GitHub API: latest, or the tag named. */
export async function resolveRelease({ tag, token, fetchImpl = fetch, repository = RELEASE_REPOSITORY }) {
  const url = tag ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}` : `https://api.github.com/repos/${repository}/releases/latest`;
  const response = await fetchImpl(url, { headers: apiHeaders(token) });
  if (response.status === 404) throw new ReleaseError(tag ? `Softn has no release tagged ${tag} (${repository}).` : `Softn (${repository}) has no published release yet.`);
  if (!response.ok) throw new ReleaseError(`GitHub answered ${response.status} for ${url}${token ? '' : ' (set GITHUB_TOKEN if the unauthenticated rate limit is exhausted)'}.`);
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archive = assets.find((a) => ASSET_PATTERN.test(a.name));
  if (!archive) {
    throw new ReleaseError(`Softn release ${release.tag_name} carries no softn-formlogic-runtime-*.zip asset (assets: ${assets.map((a) => a.name).join(', ') || 'none'}). FormLogic needs a Softn release built with the FormLogic runtime archive; pin an older one with SOFTN_RELEASE=<tag> or wait for the next release.`);
  }
  const sidecar = assets.find((a) => a.name === `${archive.name}.sha256`);
  return { tag: release.tag_name, commit: release.target_commitish ?? null, archive, sidecar, htmlUrl: release.html_url };
}

async function download(asset, target, token, fetchImpl) {
  // With a token the API asset URL is used (it serves private releases too);
  // without one the public download URL costs no API rate limit.
  const headers = apiHeaders(token);
  headers.Accept = 'application/octet-stream';
  const response = await fetchImpl(token && asset.url ? asset.url : asset.browser_download_url, { headers, redirect: 'follow' });
  if (!response.ok) throw new ReleaseError(`Downloading ${asset.name} failed: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes;
}

/** `<hex>  <file>` as the sidecar is written; the file name must be the archive's. */
export function parseSidecar(text, archiveName) {
  const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/m.exec(text.replace(/\r\n/g, '\n'));
  if (!match) throw new ReleaseError(`${archiveName}.sha256 is not a "<sha256>  <file>" line.`);
  if (match[2] !== archiveName) throw new ReleaseError(`${archiveName}.sha256 names ${match[2]}, not ${archiveName}.`);
  return match[1];
}

// ── Verifying the archive against the contract and against this tree ────────

function entryText(entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new ReleaseError(`The archive has no ${name}.`);
  return entry.data.toString('utf8');
}

/**
 * Read the archive as an extractor would, check every digest the release
 * manifest records, and check the release fits this tree: engine bytes,
 * protocol versions, and (reported, not enforced here) the adapter digest.
 */
export async function verifyArchive(zip, { sidecarDigest, paths, archiveName }) {
  const zipDigest = sha256(zip);
  if (sidecarDigest && sidecarDigest !== zipDigest) throw new ReleaseError(`${archiveName} does not match its .sha256 sidecar (archive ${zipDigest.slice(0, 12)}, sidecar ${sidecarDigest.slice(0, 12)}); the download is corrupt or not the file the release page describes.`);
  const { entries, problems } = readArchive(zip);
  if (problems.length) throw new ReleaseError(`${archiveName} does not read back as a sound zip:\n  ${problems.join('\n  ')}`);

  let release;
  try { release = JSON.parse(entryText(entries, 'softn-release.json')); }
  catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError(`softn-release.json is not JSON: ${error.message}`); }
  if (release.formatVersion !== 1) throw new ReleaseError(`softn-release.json formatVersion ${release.formatVersion} is not the 1 this FormLogic reads.`);
  for (const key of ['tag', 'commit', 'version']) if (typeof release[key] !== 'string' || !release[key]) throw new ReleaseError(`softn-release.json has no ${key}.`);
  if (!/^[0-9a-f]{40}$/.test(release.commit)) throw new ReleaseError(`softn-release.json commit is not a 40-hex revision.`);
  if (!release.files || typeof release.files !== 'object') throw new ReleaseError('softn-release.json lists no files.');

  // Every file in the archive is listed with the digest it has, and nothing listed is missing.
  const listed = new Set(Object.keys(release.files));
  for (const [name, entry] of entries) {
    if (name === 'softn-release.json' || name.endsWith('/')) continue;
    if (!listed.has(name)) throw new ReleaseError(`${name} is in the archive but not in softn-release.json.`);
    const digest = sha256(entry.data);
    if (digest !== release.files[name]) throw new ReleaseError(`${name} has digest ${digest.slice(0, 12)}, softn-release.json says ${String(release.files[name]).slice(0, 12)}.`);
    listed.delete(name);
  }
  if (listed.size) throw new ReleaseError(`softn-release.json lists files the archive lacks: ${[...listed].join(', ')}.`);

  // The engine: the release's ZIPP must be the one this tree vendors, byte for byte.
  const expected = runtimeIdentity(JSON.parse(await readFile(paths.zippSource, 'utf8')));
  const releaseZipp = release.zipp ?? {};
  if (releaseZipp.version !== expected.version || releaseZipp.sha256 !== expected.sha256) {
    throw new ReleaseError(`Softn ${release.tag} was built with ZIPP ${releaseZipp.version} (${String(releaseZipp.sha256).slice(0, 12)}); this FormLogic vendors ZIPP ${expected.version} (${expected.sha256.slice(0, 12)}). Update formlogic/ui/vendor/zipp-wasm to the same release (node scripts/sync-zipp-from-softn.mjs) or pin an older Softn with SOFTN_RELEASE=<tag>.`);
  }
  const wasm = entries.get('native-runtime/wasm/zipp_wasm_bg.wasm');
  if (!wasm) throw new ReleaseError('The archive has no native-runtime/wasm/zipp_wasm_bg.wasm.');
  if (sha256(wasm.data) !== expected.sha256) throw new ReleaseError('The archive\'s ZIPP engine bytes differ from the digest its manifest records.');
  const shippedSource = JSON.parse(entryText(entries, 'native-runtime/wasm/SOURCE.json'));
  assertMatchingRuntime(runtimeIdentity(shippedSource), expected);

  // The protocols: exactly what this FormLogic speaks.
  const protocol = JSON.parse(await readFile(paths.protocolFile, 'utf8'));
  const releaseProtocols = release.protocols ?? {};
  for (const key of ['nativeProtocol', 'recordEvents', 'editorBridge']) {
    if (releaseProtocols[key] !== protocol[key]) throw new ReleaseError(`Softn ${release.tag} speaks ${key} ${releaseProtocols[key]}; this FormLogic speaks ${protocol[key]}. A FormLogic that understands that protocol is needed, or an older Softn (SOFTN_RELEASE=<tag>).`);
  }
  const hostProtocol = JSON.parse(entryText(entries, 'native-runtime/host-protocol.json'));
  if (hostProtocol.nativeProtocol !== protocol.nativeProtocol || hostProtocol.recordEvents !== protocol.recordEvents) throw new ReleaseError('native-runtime/host-protocol.json disagrees with softn-release.json protocols.');

  // The adapter: its bytes, its provenance and the manifest must agree; whether
  // THIS tree has vendored the same copy is the caller's decision.
  const adapterText = entryText(entries, 'adapter/formlogic.ts');
  const adapterProvenance = JSON.parse(entryText(entries, 'adapter/provenance.json'));
  const adapterSha = adapterDigest(adapterText);
  if (adapterSha !== adapterProvenance.sha256 || adapterSha !== release.adapter?.sha256) throw new ReleaseError('adapter/formlogic.ts, adapter/provenance.json and softn-release.json disagree about the adapter digest.');
  if (adapterProvenance.source !== ADAPTER_SOURCE) throw new ReleaseError(`adapter/provenance.json names ${adapterProvenance.source}; expected ${ADAPTER_SOURCE}.`);

  for (const name of ['hosted-runtime/runtime-manifest.json', 'hosted-runtime/index.html', 'app-editors/manifest.json', 'app-editors/builder/runtime-manifest.json', 'app-editors/studio/runtime-manifest.json', 'native-runtime/provenance.json', ...NATIVE_MODULES.map((m) => `native-runtime/${m}`)]) {
    if (!entries.has(name)) throw new ReleaseError(`The archive has no ${name}.`);
  }
  return { release, entries, zipDigest, expected, adapterSha, adapterText };
}

// ── Installing ──────────────────────────────────────────────────────────────

function safeJoin(root, name) {
  const target = resolve(root, name);
  const fromRoot = relative(root, target);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new ReleaseError(`Archive entry escapes its folder: ${name}`);
  return target;
}

async function extractTree(entries, prefix, into) {
  await mkdir(into, { recursive: true });
  let count = 0;
  for (const [name, entry] of entries) {
    if (!name.startsWith(prefix) || name.endsWith('/')) continue;
    const target = safeJoin(into, name.slice(prefix.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    count++;
  }
  if (!count) throw new ReleaseError(`The archive has nothing under ${prefix}.`);
}

/**
 * A runtime-manifest.json over a whole tree (app-editors/, whose root has no
 * index.html), when the release carries one: every file listed is present
 * with its digest, and anything present but unlisted is a per-editor
 * runtime-manifest.json (which checkAppEditors verifies on its own). The
 * archive's own file digests already covered every byte; this pins the
 * folder's shape after installation.
 */
async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, path));
    else if (entry.isFile() && path !== 'runtime-manifest.json') files.push(path);
  }
  return files.sort();
}
export async function checkTreeManifest(directory, expected) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'runtime-manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new ReleaseError(`${basename(directory)}/runtime-manifest.json is invalid.`);
  assertMatchingRuntime(manifest.zipp, expected);
  const listed = Object.keys(manifest.files).sort();
  const present = await listFiles(directory);
  const unlisted = present.filter((path) => !(path in manifest.files) && !/(^|\/)runtime-manifest\.json$/.test(path));
  const missing = listed.filter((path) => !present.includes(path));
  if (unlisted.length || missing.length) throw new ReleaseError(`${basename(directory)}/runtime-manifest.json disagrees with the folder (unlisted: ${unlisted.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`);
  for (const path of listed) if (sha256(await readFile(safeJoin(directory, path))) !== manifest.files[path]) throw new ReleaseError(`${basename(directory)}/${path} differs from its manifest.`);
}

/** Replace `output` with `staged` (a verified sibling), as the builders do. */
async function promote(staged, output) {
  await rm(output, { recursive: true, force: true });
  try { await rename(staged, output); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    await cp(staged, output, { recursive: true });
    await rm(staged, { recursive: true, force: true });
  }
}

export async function installHostedRuntime(entries, expected, paths) {
  const publicDir = dirname(paths.hostedRuntime);
  await mkdir(publicDir, { recursive: true });
  const staged = await mkdtemp(resolve(publicDir, '.hosted-runtime-'));
  try {
    await extractTree(entries, 'hosted-runtime/', staged);
    await rm(paths.hostedRuntime, { recursive: true, force: true });
    await installRuntimeArtifact(staged, paths.hostedRuntime, expected);
  } finally { await rm(staged, { recursive: true, force: true }); }
}

export async function installAppEditors(entries, expected, paths) {
  const publicDir = dirname(paths.appEditors);
  await mkdir(publicDir, { recursive: true });
  const staged = await mkdtemp(resolve(publicDir, '.app-editors-'));
  try {
    await extractTree(entries, 'app-editors/', staged);
    // Per-editor manifests are required (checkAppEditors); a manifest over the
    // whole folder is checked when the release carries one.
    if (existsSync(resolve(staged, 'runtime-manifest.json'))) await checkTreeManifest(staged, expected);
    await checkAppEditors(staged, expected);
    await promote(staged, paths.appEditors);
    await checkAppEditors(paths.appEditors, expected);
  } finally { await rm(staged, { recursive: true, force: true }); }
}

export async function installNativeRuntime(entries, expected, paths, releaseInfo) {
  const parent = dirname(paths.nativeRuntime);
  await mkdir(parent, { recursive: true });
  const staged = await mkdtemp(resolve(parent, '.softn-native-'));
  try {
    await extractTree(entries, 'native-runtime/', staged);
    for (const name of [...NATIVE_MODULES, ...NATIVE_EXTRA]) if (!existsSync(resolve(staged, name))) throw new ReleaseError(`native-runtime/${name} is missing from the archive.`);
    const provenance = JSON.parse(await readFile(resolve(staged, 'provenance.json'), 'utf8'));
    provenance.release = { tag: releaseInfo.tag, commit: releaseInfo.commit };
    await writeFile(resolve(staged, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    await checkNativeRuntime(staged, expected);
    await promote(staged, paths.nativeRuntime);
    await checkNativeRuntime(paths.nativeRuntime, expected);
  } finally { await rm(staged, { recursive: true, force: true }); }
}

async function trackedAdapterDigest(paths) {
  const provenance = JSON.parse(await readFile(resolve(paths.adapterDir, 'provenance.json'), 'utf8'));
  return provenance.sha256;
}

// ── The whole run ───────────────────────────────────────────────────────────

/**
 * Fetch (or take the local archive), verify, install, and record. Returns the
 * record written to current.json.
 */
export async function fetchSoftnRelease({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  tag = process.env.SOFTN_RELEASE || null,
  archivePath = process.env.SOFTN_RELEASE_ARCHIVE || null,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  syncAdapter = false,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const paths = defaultPaths(root);
  let zip;
  let sidecarDigest = null;
  let archiveName;
  let archiveFile;
  let resolved = null;

  if (archivePath) {
    archiveFile = resolve(archivePath);
    archiveName = basename(archiveFile);
    if (!ASSET_PATTERN.test(archiveName)) throw new ReleaseError(`${archiveName} is not named softn-formlogic-runtime-<tag>.zip.`);
    zip = await readFile(archiveFile);
    if (existsSync(`${archiveFile}.sha256`)) sidecarDigest = parseSidecar(await readFile(`${archiveFile}.sha256`, 'utf8'), archiveName);
    else log(`no ${archiveName}.sha256 beside the local archive; its own manifest digests are still checked`);
  } else {
    resolved = await resolveRelease({ tag, token, fetchImpl });
    archiveName = resolved.archive.name;
    const dir = resolve(paths.cache, resolved.tag);
    archiveFile = resolve(dir, archiveName);
    if (!resolved.sidecar) throw new ReleaseError(`Softn release ${resolved.tag} has ${archiveName} but no ${archiveName}.sha256 beside it.`);
    const sidecarText = (await download(resolved.sidecar, `${archiveFile}.sha256`, token, fetchImpl)).toString('utf8');
    sidecarDigest = parseSidecar(sidecarText, archiveName);
    if (existsSync(archiveFile) && sha256(await readFile(archiveFile)) === sidecarDigest) {
      zip = await readFile(archiveFile);
      log(`reusing ${relative(root, archiveFile)} (digest matches the release)`);
    } else {
      log(`downloading ${archiveName} from Softn release ${resolved.tag}`);
      zip = await download(resolved.archive, archiveFile, token, fetchImpl);
    }
  }

  const { release, entries, zipDigest, expected, adapterSha } = await verifyArchive(zip, { sidecarDigest, paths, archiveName });
  if (resolved && resolved.tag !== release.tag) throw new ReleaseError(`The archive says it is ${release.tag}, the release page says ${resolved.tag}.`);
  const releaseInfo = { tag: release.tag, commit: release.commit, version: release.version };

  // The adapter this tree has vendored must be the release's; a difference is
  // a FormLogic change (a commit), never something CI does on its own.
  const tracked = await trackedAdapterDigest(paths);
  if (tracked !== adapterSha) {
    if (!syncAdapter) {
      throw new ReleaseError(`The vendored FormLogic adapter (formlogic/ui/src/lib/softn/project.ts, ${tracked.slice(0, 12)}) is not the one Softn ${release.tag} ships (${adapterSha.slice(0, 12)}). Run node scripts/fetch-softn-release.mjs --sync-adapter${tag ? ` with SOFTN_RELEASE=${tag}` : ''}, review the change and commit it.`);
    }
    await writeAdapter({ content: entries.get('adapter/formlogic.ts').data.toString('utf8'), license: entries.get('native-runtime/LICENSE').data, notice: entries.get('native-runtime/NOTICE').data, destination: paths.adapterDir });
    log(`vendored adapter refreshed from Softn ${release.tag} (${adapterSha.slice(0, 12)}); commit formlogic/ui/src/lib/softn`);
  }

  await installHostedRuntime(entries, expected, paths);
  await installAppEditors(entries, expected, paths);
  await installNativeRuntime(entries, expected, paths, releaseInfo);

  const record = {
    ...releaseInfo,
    archive: archiveName,
    sha256: zipDigest,
    source: resolved ? resolved.htmlUrl : archiveFile,
    zipp: release.zipp,
    protocols: release.protocols,
    adapter: { sha256: adapterSha },
    xdb: release.xdb ?? null,
    builtAt: release.builtAt ?? null,
    fetchedAt: new Date().toISOString(),
  };
  await mkdir(paths.cache, { recursive: true });
  await writeFile(resolve(paths.cache, 'current.json'), JSON.stringify(record, null, 2) + '\n');
  log(`Softn ${release.tag} (${release.commit.slice(0, 12)}) installed: hosted runtime, app editors, native runtime; ZIPP ${release.zipp.version}`);
  return record;
}

/** Verify what a previous run installed, without the network. */
export async function checkInstalled({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), log = console.log } = {}) {
  const paths = defaultPaths(root);
  const current = resolve(paths.cache, 'current.json');
  if (!existsSync(current)) throw new ReleaseError('No Softn release is installed (no .runtime-source/softn-release/current.json); run node scripts/fetch-softn-release.mjs.');
  const record = JSON.parse(await readFile(current, 'utf8'));
  const expected = runtimeIdentity(JSON.parse(await readFile(paths.zippSource, 'utf8')));
  if (record.zipp?.version !== expected.version || record.zipp?.sha256 !== expected.sha256) throw new ReleaseError(`The installed Softn ${record.tag} carries ZIPP ${record.zipp?.version}; this tree vendors ${expected.version}. Fetch again.`);
  const protocol = JSON.parse(await readFile(paths.protocolFile, 'utf8'));
  for (const key of ['nativeProtocol', 'recordEvents', 'editorBridge']) {
    if (record.protocols?.[key] !== protocol[key]) throw new ReleaseError(`The installed Softn ${record.tag} speaks ${key} ${record.protocols?.[key]}; this tree speaks ${protocol[key]}. Fetch again.`);
  }
  const tracked = await trackedAdapterDigest(paths);
  if (tracked !== record.adapter?.sha256) throw new ReleaseError(`The vendored adapter (${tracked.slice(0, 12)}) is not the one Softn ${record.tag} ships (${String(record.adapter?.sha256).slice(0, 12)}); run node scripts/fetch-softn-release.mjs --sync-adapter and commit.`);
  await checkRuntimeArtifact(paths.hostedRuntime, expected);
  await checkAppEditors(paths.appEditors, expected);
  await checkNativeRuntime(paths.nativeRuntime, expected);
  const provenance = JSON.parse(await readFile(resolve(paths.nativeRuntime, 'provenance.json'), 'utf8'));
  if (provenance.release?.tag !== record.tag) throw new ReleaseError(`The native runtime on disk is from ${provenance.release?.tag ?? 'a source build'}, current.json says ${record.tag}. Fetch again.`);
  log(`Softn ${record.tag} (${record.commit.slice(0, 12)}) is installed and intact.`);
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) await checkInstalled();
    else await fetchSoftnRelease({ syncAdapter: args.includes('--sync-adapter') });
  } catch (error) {
    if (error instanceof ReleaseError) { console.error(`fetch-softn-release: ${error.message}`); process.exit(1); }
    throw error;
  }
}
