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
 * One release per run (release-readiness FL-S01). A CI run that prepares the
 * runtime in several jobs must not let a Softn release published between two
 * of them change what the later job installs. So a run resolves the release
 * ONCE and freezes its identity — tag, the commit the annotated tag points at,
 * the asset and the archive's SHA-256 — in a small record every job then
 * consumes:
 *
 *   node scripts/fetch-softn-release.mjs --resolve-only --frozen softn-frozen.json
 *   node scripts/fetch-softn-release.mjs --frozen softn-frozen.json   (or SOFTN_FROZEN=<file>)
 *
 * With a frozen record the fetch never asks for "latest": it fetches the
 * frozen tag, requires the frozen asset, checks the bytes against the frozen
 * digest and checks the archive's own manifest names the frozen tag and
 * commit. Any drift is a hard failure naming both values.
 *
 * One generation per install (release-readiness FL-S05). The three trees are
 * staged and verified together, promoted together with the previous trees
 * kept until the new generation is recorded, and recorded with a complete
 * file inventory; an interrupted promotion is resolved deterministically on
 * the next run, and `--check` verifies every installed file against the
 * inventory, so a mixture of two releases with the same engine cannot pass
 * as an intact install.
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
import { runtimeIdentity, assertMatchingRuntime, checkRuntimeArtifact } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';
import { checkAppEditors } from '../formlogic/ui/scripts/check-app-editors.mjs';
import { checkNativeRuntime } from './release-runtime.mjs';
import { writeAdapter, adapterDigest, ADAPTER_SOURCE } from '../formlogic/ui/scripts/sync-softn.mjs';

export const RELEASE_REPOSITORY = 'f2i-com/softn.com';
export const ASSET_PATTERN = /^softn-formlogic-runtime-.+\.zip$/;
/** The frozen record's format; a record another version wrote is refused rather than guessed at. */
export const FROZEN_FORMAT = 1;
const NATIVE_MODULES = ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'host-protocol.json', 'record-events.mjs'];
const NATIVE_EXTRA = ['wasm/zipp_wasm.mjs', 'wasm/zipp_wasm_bg.wasm', 'wasm/SOURCE.json', 'LICENSE', 'NOTICE', 'ZIPP-THIRD-PARTY-LICENSES.txt', 'provenance.json'];
const PROVENANCE = 'native-runtime/provenance.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A digest of a JSON value that does not depend on key order or formatting. */
const canonicalDigest = (value) => sha256(JSON.stringify(sortKeys(value)));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

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
const currentRecordPath = (paths) => resolve(paths.cache, 'current.json');
const promotionJournalPath = (paths) => resolve(paths.cache, 'promotion.json');
export const DEFAULT_FROZEN_PATH = '.runtime-source/softn-release/frozen.json';

// ── Resolving and downloading ────────────────────────────────────────────────

function apiHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'formlogic-fetch-softn-release', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The commit a tag names. An annotated tag is its own object whose target is
 * the commit; a lightweight tag is the commit. Neither is the release's
 * `target_commitish`, which is whatever was typed when the release was made
 * (often a branch name) and says nothing about what the tag points at now.
 */
export async function resolveTagCommit({ tag, token, fetchImpl = fetch, repository = RELEASE_REPOSITORY }) {
  const ref = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, { headers: apiHeaders(token) });
  if (ref.status === 404) throw new ReleaseError(`Softn (${repository}) has no tag ${tag}; the release exists but its tag is gone.`);
  if (!ref.ok) throw new ReleaseError(`GitHub answered ${ref.status} resolving tag ${tag}.`);
  const object = (await ref.json()).object ?? {};
  if (object.type === 'commit') return object.sha;
  if (object.type !== 'tag') throw new ReleaseError(`Tag ${tag} points at a ${object.type ?? 'unknown'} object, not a commit or an annotated tag.`);
  const tagObject = await fetchImpl(`https://api.github.com/repos/${repository}/git/tags/${object.sha}`, { headers: apiHeaders(token) });
  if (!tagObject.ok) throw new ReleaseError(`GitHub answered ${tagObject.status} reading annotated tag ${tag}.`);
  const target = (await tagObject.json()).object ?? {};
  if (target.type !== 'commit' || !/^[0-9a-f]{40}$/.test(target.sha ?? '')) throw new ReleaseError(`Annotated tag ${tag} does not point at a commit.`);
  return target.sha;
}

/**
 * The release's asset descriptors from the GitHub API: latest, or the tag
 * named. `commit` is what the tag points at (see resolveTagCommit).
 */
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
  const commit = await resolveTagCommit({ tag: release.tag_name, token, fetchImpl, repository });
  return { tag: release.tag_name, commit, targetCommitish: release.target_commitish ?? null, archive, sidecar, assets, htmlUrl: release.html_url };
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

// ── The frozen record: one release per run ──────────────────────────────────

/**
 * Resolve the release (latest, or the tag named) and write the record every
 * later job consumes: the tag, the commit the tag points at, the asset, and
 * the archive digest the release page publishes. Only the sidecar is
 * downloaded here.
 */
export async function resolveOnly({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  tag = process.env.SOFTN_RELEASE || null,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = fetch,
  frozenPath = process.env.SOFTN_FROZEN || DEFAULT_FROZEN_PATH,
  log = console.log,
} = {}) {
  const paths = defaultPaths(root);
  const resolved = await resolveRelease({ tag, token, fetchImpl });
  if (!resolved.sidecar) throw new ReleaseError(`Softn release ${resolved.tag} has ${resolved.archive.name} but no ${resolved.archive.name}.sha256 beside it.`);
  const sidecarFile = resolve(paths.cache, resolved.tag, `${resolved.archive.name}.sha256`);
  const archiveSha256 = parseSidecar((await download(resolved.sidecar, sidecarFile, token, fetchImpl)).toString('utf8'), resolved.archive.name);
  const frozen = {
    formatVersion: FROZEN_FORMAT,
    repository: RELEASE_REPOSITORY,
    tag: resolved.tag,
    tagCommit: resolved.commit,
    assetId: resolved.archive.id ?? null,
    assetName: resolved.archive.name,
    sidecarAssetId: resolved.sidecar.id ?? null,
    archiveSha256,
    htmlUrl: resolved.htmlUrl ?? null,
    resolvedAt: new Date().toISOString(),
  };
  const target = resolve(root, frozenPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(frozen, null, 2) + '\n');
  log(`Softn ${frozen.tag} (${String(frozen.tagCommit).slice(0, 12)}) frozen: ${frozen.assetName} ${archiveSha256.slice(0, 12)} -> ${relative(root, target) || target}`);
  return frozen;
}

/** Read and validate a frozen record; `null` when no path is given. */
export async function loadFrozen(frozenPath, root) {
  if (!frozenPath) return null;
  if (typeof frozenPath === 'object') return validateFrozen(frozenPath, '(object)');
  const file = resolve(root, frozenPath);
  if (!existsSync(file)) throw new ReleaseError(`The frozen release record ${frozenPath} does not exist; run node scripts/fetch-softn-release.mjs --resolve-only --frozen ${frozenPath} first.`);
  let frozen;
  try { frozen = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new ReleaseError(`The frozen release record ${frozenPath} is not JSON: ${error.message}`); }
  return validateFrozen(frozen, frozenPath);
}
function validateFrozen(frozen, where) {
  if (frozen.formatVersion !== FROZEN_FORMAT) throw new ReleaseError(`The frozen release record ${where} has formatVersion ${frozen.formatVersion}; this fetcher writes ${FROZEN_FORMAT}.`);
  if (typeof frozen.tag !== 'string' || !/^v\d/.test(frozen.tag)) throw new ReleaseError(`The frozen release record ${where} names no tag.`);
  if (!/^[0-9a-f]{40}$/.test(frozen.tagCommit ?? '')) throw new ReleaseError(`The frozen release record ${where} has no 40-hex tagCommit.`);
  if (!/^[0-9a-f]{64}$/.test(frozen.archiveSha256 ?? '')) throw new ReleaseError(`The frozen release record ${where} has no 64-hex archiveSha256.`);
  if (typeof frozen.assetName !== 'string' || !ASSET_PATTERN.test(frozen.assetName)) throw new ReleaseError(`The frozen release record ${where} names no softn-formlogic-runtime-*.zip asset.`);
  return frozen;
}

/** The archive, its manifest and the release page must all say what the frozen record says. */
function assertFrozenIdentity(frozen, { tag, commit, zipDigest, archiveName }) {
  if (archiveName && frozen.assetName !== archiveName) throw new ReleaseError(`The frozen release record names ${frozen.assetName}; this archive is ${archiveName}.`);
  if (zipDigest && zipDigest !== frozen.archiveSha256) throw new ReleaseError(`The archive's digest ${zipDigest.slice(0, 12)} is not the frozen ${frozen.archiveSha256.slice(0, 12)}: the release's asset bytes are not the ones this run resolved. Refusing to install replacement bytes under the same release identity.`);
  if (tag && tag !== frozen.tag) throw new ReleaseError(`The archive says it is Softn ${tag}; the frozen release record for this run says ${frozen.tag}.`);
  if (commit && commit !== frozen.tagCommit) throw new ReleaseError(`The archive was built from ${commit.slice(0, 12)}; the frozen record says tag ${frozen.tag} points at ${frozen.tagCommit.slice(0, 12)}. The tag moved or the archive is not the tag's build.`);
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

  for (const name of ['hosted-runtime/runtime-manifest.json', 'hosted-runtime/index.html', 'app-editors/manifest.json', 'app-editors/builder/runtime-manifest.json', 'app-editors/studio/runtime-manifest.json', PROVENANCE, ...NATIVE_MODULES.map((m) => `native-runtime/${m}`)]) {
    if (!entries.has(name)) throw new ReleaseError(`The archive has no ${name}.`);
  }
  return { release, entries, zipDigest, expected, adapterSha, adapterText };
}

// ── Installing: one generation, staged whole, promoted whole ────────────────

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

/** Every file under a directory, sorted, as forward-slash paths; links are refused. */
async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new ReleaseError(`Generated runtime assets must not contain links: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(directory, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

/** path -> sha256 of every file in a tree: the generation's inventory. */
async function inventoryOf(directory) {
  const inventory = {};
  for (const path of await listFiles(directory)) inventory[path] = sha256(await readFile(safeJoin(directory, path)));
  return inventory;
}

/**
 * A runtime-manifest.json over a whole tree (app-editors/, whose root has no
 * index.html), when the release carries one: every file listed is present
 * with its digest, and anything present but unlisted is a per-editor
 * runtime-manifest.json (which checkAppEditors verifies on its own). The
 * archive's own file digests already covered every byte; this pins the
 * folder's shape after installation.
 */
export async function checkTreeManifest(directory, expected) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'runtime-manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new ReleaseError(`${basename(directory)}/runtime-manifest.json is invalid.`);
  assertMatchingRuntime(manifest.zipp, expected);
  const listed = Object.keys(manifest.files).sort();
  const present = (await listFiles(directory)).filter((path) => path !== 'runtime-manifest.json');
  const unlisted = present.filter((path) => !(path in manifest.files) && !/(^|\/)runtime-manifest\.json$/.test(path));
  const missing = listed.filter((path) => !present.includes(path));
  if (unlisted.length || missing.length) throw new ReleaseError(`${basename(directory)}/runtime-manifest.json disagrees with the folder (unlisted: ${unlisted.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`);
  for (const path of listed) if (sha256(await readFile(safeJoin(directory, path))) !== manifest.files[path]) throw new ReleaseError(`${basename(directory)}/${path} differs from its manifest.`);
}

/** Move a directory; Windows watchers can lock rename, so copy-then-remove is the fallback. */
async function moveDir(from, to) {
  try { await rename(from, to); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * The three trees a release installs, in promotion order. `prepare` edits a
 * staged tree before it is verified (the native runtime's provenance gains
 * the release it came from); `validate` is the same check the source
 * builders and `--check` apply.
 */
function generationTrees(paths, expected, releaseInfo) {
  return [
    {
      name: 'hosted-runtime', prefix: 'hosted-runtime/', destination: paths.hostedRuntime, stagePrefix: '.hosted-runtime-',
      validate: (dir) => checkRuntimeArtifact(dir, expected),
    },
    {
      name: 'app-editors', prefix: 'app-editors/', destination: paths.appEditors, stagePrefix: '.app-editors-',
      validate: async (dir) => {
        // Per-editor manifests are required (checkAppEditors); a manifest over
        // the whole folder is checked when the release carries one.
        if (existsSync(resolve(dir, 'runtime-manifest.json'))) await checkTreeManifest(dir, expected);
        await checkAppEditors(dir, expected);
      },
    },
    {
      name: 'native-runtime', prefix: 'native-runtime/', destination: paths.nativeRuntime, stagePrefix: '.softn-native-',
      prepare: async (dir) => {
        for (const name of [...NATIVE_MODULES, ...NATIVE_EXTRA]) if (!existsSync(resolve(dir, name))) throw new ReleaseError(`native-runtime/${name} is missing from the archive.`);
        const provenance = JSON.parse(await readFile(resolve(dir, 'provenance.json'), 'utf8'));
        provenance.release = { tag: releaseInfo.tag, commit: releaseInfo.commit };
        await writeFile(resolve(dir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
      },
      validate: (dir) => checkNativeRuntime(dir, expected),
    },
  ];
}

/** Staging directories a crashed run may have left beside the destinations. */
async function sweepStaging(trees) {
  for (const tree of trees) {
    const parent = dirname(tree.destination);
    if (!existsSync(parent)) continue;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(tree.stagePrefix)) await rm(resolve(parent, entry.name), { recursive: true, force: true });
    }
  }
}

/** Whether a directory holds exactly the inventory: same paths, same bytes. */
async function inventoryDiff(directory, inventory) {
  if (!existsSync(directory)) return { missing: Object.keys(inventory), unlisted: [], changed: [] };
  const present = await listFiles(directory);
  const missing = Object.keys(inventory).filter((path) => !present.includes(path)).sort();
  const unlisted = present.filter((path) => !(path in inventory));
  const changed = [];
  for (const path of present) if (path in inventory && sha256(await readFile(safeJoin(directory, path))) !== inventory[path]) changed.push(path);
  return { missing, unlisted, changed };
}
const intact = (diff) => !diff.missing.length && !diff.unlisted.length && !diff.changed.length;

/**
 * Resolve an interrupted promotion before anything else touches the trees.
 * A run that died mid-swap left promotion.json: every tree is either the new
 * generation (if all three are, the generation is completed by recording
 * it) or is put back from the `.previous` copy kept for exactly this, so the
 * result is all-old or all-new, never a mixture. Returns what it did.
 */
export async function recoverPromotion(paths, log = () => {}) {
  const journalFile = promotionJournalPath(paths);
  if (!existsSync(journalFile)) return null;
  let journal;
  try { journal = JSON.parse(await readFile(journalFile, 'utf8')); }
  catch { journal = null; }
  if (!journal || journal.formatVersion !== 1 || !journal.trees) {
    // An unreadable journal names nothing to put back; the trees are checked
    // against current.json by --check, and a fresh install replaces them.
    await rm(journalFile, { force: true });
    return { outcome: 'discarded-unreadable-journal' };
  }
  const names = Object.keys(journal.trees);
  // The journal is written before and after every swap, so each tree's state
  // says what happened to it, not what its bytes happen to look like (two
  // releases can share an identical tree; bytes alone cannot tell "promoted
  // with nothing before it" from "never touched").
  if (names.every((name) => journal.trees[name].state === 'promoted')) {
    for (const name of names) {
      const diff = await inventoryDiff(journal.trees[name].destination, journal.trees[name].inventory);
      if (!intact(diff)) return rollBack(journal, journalFile, paths, log, `${name} was promoted but is not the new generation`);
    }
    await mkdir(paths.cache, { recursive: true });
    await writeFile(currentRecordPath(paths), JSON.stringify(journal.record, null, 2) + '\n');
    for (const name of names) await rm(journal.trees[name].previous, { recursive: true, force: true });
    await rm(journalFile, { force: true });
    log(`completed the interrupted install of Softn ${journal.record.tag}: every tree was already the new generation`);
    return { outcome: 'completed', tag: journal.record.tag };
  }
  return rollBack(journal, journalFile, paths, log);
}

async function rollBack(journal, journalFile, paths, log, reason = 'the swap did not finish') {
  for (const [name, tree] of Object.entries(journal.trees)) {
    if (tree.state === 'promoted' || tree.state === 'promoting') {
      if (existsSync(tree.previous)) {
        // The old tree was set aside (and the new one may or may not be in place): put the old one back.
        await rm(tree.destination, { recursive: true, force: true });
        await moveDir(tree.previous, tree.destination);
      } else if (!tree.hadPrevious && existsSync(tree.destination)) {
        // Promoted with nothing before it (a first install): back to nothing.
        await rm(tree.destination, { recursive: true, force: true });
      }
      // hadPrevious without a .previous directory: the swap had not begun; the destination is still the old tree.
    }
    if (tree.staged && existsSync(tree.staged)) await rm(tree.staged, { recursive: true, force: true });
  }
  await rm(journalFile, { force: true });
  log(`rolled back the interrupted install of Softn ${journal.record?.tag ?? '(unknown)'} (${reason}): the previous generation is back in place`);
  return { outcome: 'rolled-back', tag: journal.record?.tag ?? null };
}

/**
 * Install the three trees as one generation: stage and verify all of them,
 * write the promotion journal, swap each destination (keeping the previous
 * tree beside it), record the generation with its complete inventory, and
 * only then drop the previous trees. `failAt` is a test hook: the name of
 * the step to die before ('promote:app-editors', 'record', ...).
 */
export async function installGeneration(entries, expected, paths, record, { failAt = null, log = () => {} } = {}) {
  const trees = generationTrees(paths, expected, record);
  await sweepStaging(trees);
  const staged = {};
  try {
    for (const tree of trees) {
      const parent = dirname(tree.destination);
      await mkdir(parent, { recursive: true });
      const dir = await mkdtemp(resolve(parent, tree.stagePrefix));
      staged[tree.name] = dir;
      await extractTree(entries, tree.prefix, dir);
      if (tree.prepare) await tree.prepare(dir);
      await tree.validate(dir);
    }
    // The archive's provenance.json is the one file the install transforms;
    // the record says exactly how, so --check can hold the installed copy to
    // both the inventory and the archive's content.
    const archiveProvenance = JSON.parse(entryText(entries, PROVENANCE));
    const transformed = {
      [PROVENANCE]: {
        transformation: 'release: {tag, commit} added',
        archiveSha256: sha256(entries.get(PROVENANCE).data),
        contentSha256: canonicalDigest(archiveProvenance),
        release: { tag: record.tag, commit: record.commit },
      },
    };
    const inventory = {};
    for (const tree of trees) inventory[tree.name] = await inventoryOf(staged[tree.name]);
    const full = { ...record, generation: { installedAt: new Date().toISOString(), inventory, transformed } };
    const journal = { formatVersion: 1, startedAt: new Date().toISOString(), record: full, trees: {} };
    for (const tree of trees) journal.trees[tree.name] = { state: 'staged', hadPrevious: existsSync(tree.destination), destination: tree.destination, staged: staged[tree.name], previous: `${tree.destination}.previous`, inventory: inventory[tree.name] };
    await mkdir(paths.cache, { recursive: true });
    const writeJournal = () => writeFile(promotionJournalPath(paths), JSON.stringify(journal, null, 2) + '\n');
    await writeJournal();

    for (const tree of trees) {
      if (failAt === `promote:${tree.name}`) throw new Error(`injected failure before promoting ${tree.name}`);
      const previous = `${tree.destination}.previous`;
      await rm(previous, { recursive: true, force: true });
      journal.trees[tree.name].state = 'promoting';
      await writeJournal();
      if (existsSync(tree.destination)) await moveDir(tree.destination, previous);
      await moveDir(staged[tree.name], tree.destination);
      staged[tree.name] = null;
      journal.trees[tree.name].staged = null;
      journal.trees[tree.name].state = 'promoted';
      await writeJournal();
      await tree.validate(tree.destination);
    }
    if (failAt === 'record') throw new Error('injected failure before recording the generation');
    await writeFile(currentRecordPath(paths), JSON.stringify(full, null, 2) + '\n');
    for (const tree of trees) await rm(`${tree.destination}.previous`, { recursive: true, force: true });
    await rm(promotionJournalPath(paths), { force: true });
    return full;
  } finally {
    // Whatever failed, no staging directory outlives the run. A failure after
    // the journal was written leaves the journal for the next run to resolve
    // (recoverPromotion); a failure before it changed nothing.
    for (const dir of Object.values(staged)) if (dir && existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }
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
  frozen = process.env.SOFTN_FROZEN || null,
  syncAdapter = false,
  fetchImpl = fetch,
  failAt = null,
  log = console.log,
} = {}) {
  const paths = defaultPaths(root);
  const frozenRecord = await loadFrozen(frozen, root);
  if (frozenRecord && tag && tag !== frozenRecord.tag) throw new ReleaseError(`SOFTN_RELEASE names ${tag} but the frozen release record for this run names ${frozenRecord.tag}; one run installs one release.`);
  const recovered = await recoverPromotion(paths, log);
  if (recovered?.outcome) log(`previous run: ${recovered.outcome}`);

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
    resolved = await resolveRelease({ tag: frozenRecord ? frozenRecord.tag : tag, token, fetchImpl });
    if (frozenRecord) {
      // The frozen asset, and only it: a release whose asset was replaced or
      // renamed since the run resolved it is not the release this run tests.
      const wanted = resolved.assets.find((a) => (frozenRecord.assetId != null && a.id != null ? a.id === frozenRecord.assetId : a.name === frozenRecord.assetName));
      if (!wanted || wanted.name !== frozenRecord.assetName) throw new ReleaseError(`Softn release ${resolved.tag} no longer carries the frozen asset ${frozenRecord.assetName}${frozenRecord.assetId != null ? ` (id ${frozenRecord.assetId})` : ''}; it carries ${resolved.assets.map((a) => a.name).join(', ') || 'nothing'}.`);
      resolved.archive = wanted;
      resolved.sidecar = resolved.assets.find((a) => a.name === `${wanted.name}.sha256`);
      if (resolved.commit && resolved.commit !== frozenRecord.tagCommit) throw new ReleaseError(`Tag ${resolved.tag} now points at ${resolved.commit.slice(0, 12)}; the frozen record says ${frozenRecord.tagCommit.slice(0, 12)}. The tag moved since this run resolved it.`);
    }
    archiveName = resolved.archive.name;
    const dir = resolve(paths.cache, resolved.tag);
    archiveFile = resolve(dir, archiveName);
    if (!resolved.sidecar) throw new ReleaseError(`Softn release ${resolved.tag} has ${archiveName} but no ${archiveName}.sha256 beside it.`);
    const sidecarText = (await download(resolved.sidecar, `${archiveFile}.sha256`, token, fetchImpl)).toString('utf8');
    sidecarDigest = parseSidecar(sidecarText, archiveName);
    if (frozenRecord && sidecarDigest !== frozenRecord.archiveSha256) throw new ReleaseError(`Softn release ${resolved.tag} now publishes ${archiveName} with digest ${sidecarDigest.slice(0, 12)}; the frozen record says ${frozenRecord.archiveSha256.slice(0, 12)}. The asset was replaced since this run resolved it.`);
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
  if (resolved && resolved.commit && resolved.commit !== release.commit) throw new ReleaseError(`The archive was built from ${release.commit.slice(0, 12)}, but tag ${resolved.tag} points at ${resolved.commit.slice(0, 12)}; the archive is not the tag's build.`);
  if (frozenRecord) assertFrozenIdentity(frozenRecord, { tag: release.tag, commit: release.commit, zipDigest, archiveName });
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

  const record = {
    ...releaseInfo,
    archive: archiveName,
    sha256: zipDigest,
    source: resolved ? resolved.htmlUrl : archiveFile,
    tagCommit: resolved ? resolved.commit : null,
    frozen: frozenRecord ? { tag: frozenRecord.tag, tagCommit: frozenRecord.tagCommit, assetId: frozenRecord.assetId ?? null, assetName: frozenRecord.assetName, archiveSha256: frozenRecord.archiveSha256, resolvedAt: frozenRecord.resolvedAt ?? null } : null,
    zipp: release.zipp,
    protocols: release.protocols,
    adapter: { sha256: adapterSha },
    xdb: release.xdb ?? null,
    builtAt: release.builtAt ?? null,
    fetchedAt: new Date().toISOString(),
  };
  const full = await installGeneration(entries, expected, paths, record, { failAt, log });
  log(`Softn ${release.tag} (${release.commit.slice(0, 12)}) installed: hosted runtime, app editors, native runtime; ZIPP ${release.zipp.version}${frozenRecord ? ' (frozen for this run)' : ''}`);
  return full;
}

/**
 * Verify what a previous run installed, without the network: the record's
 * compatibility with this tree, every tree's own manifest, and every
 * installed file against the recorded inventory of the generation.
 */
export async function checkInstalled({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), frozen = process.env.SOFTN_FROZEN || null, log = console.log } = {}) {
  const paths = defaultPaths(root);
  if (existsSync(promotionJournalPath(paths))) throw new ReleaseError('A Softn runtime install was interrupted mid-promotion (.runtime-source/softn-release/promotion.json); the trees may be a mixture of two generations. Run node scripts/fetch-softn-release.mjs to resolve it.');
  const current = currentRecordPath(paths);
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
  const frozenRecord = await loadFrozen(frozen, root);
  if (frozenRecord) assertFrozenIdentity(frozenRecord, { tag: record.tag, commit: record.commit, zipDigest: record.sha256, archiveName: record.archive });

  // The generation: every file of every tree is the one recorded, nothing
  // more, nothing less. Two releases with the same engine and protocols have
  // self-consistent manifests each; only the inventory tells them apart.
  const inventory = record.generation?.inventory;
  if (!inventory || typeof inventory !== 'object') throw new ReleaseError(`current.json for Softn ${record.tag} records no generation inventory (installed by an earlier fetcher); run node scripts/fetch-softn-release.mjs to install and record it.`);
  const trees = generationTrees(paths, expected, record);
  for (const tree of trees) {
    if (!inventory[tree.name]) throw new ReleaseError(`current.json records no inventory for ${tree.name}; fetch again.`);
    const diff = await inventoryDiff(tree.destination, inventory[tree.name]);
    if (!intact(diff)) {
      const detail = [diff.missing.length && `missing: ${diff.missing.slice(0, 5).join(', ')}${diff.missing.length > 5 ? ', …' : ''}`, diff.unlisted.length && `not in the recorded generation: ${diff.unlisted.slice(0, 5).join(', ')}${diff.unlisted.length > 5 ? ', …' : ''}`, diff.changed.length && `changed: ${diff.changed.slice(0, 5).join(', ')}${diff.changed.length > 5 ? ', …' : ''}`].filter(Boolean).join('; ');
      throw new ReleaseError(`${tree.name} is not the generation current.json records for Softn ${record.tag} (${detail}). The trees are stale, edited or a mixture of two installs; run node scripts/fetch-softn-release.mjs.`);
    }
    await tree.validate(tree.destination);
  }
  const transformed = record.generation?.transformed?.[PROVENANCE];
  const provenance = JSON.parse(await readFile(resolve(paths.nativeRuntime, 'provenance.json'), 'utf8'));
  if (provenance.release?.tag !== record.tag || provenance.release?.commit !== record.commit) throw new ReleaseError(`The native runtime on disk is from ${provenance.release?.tag ?? 'a source build'}, current.json says ${record.tag}. Fetch again.`);
  if (transformed) {
    const { release: _release, ...content } = provenance;
    if (canonicalDigest(content) !== transformed.contentSha256) throw new ReleaseError('native-runtime/provenance.json differs from the archive\'s beyond the recorded transformation (release added). Fetch again.');
  }
  log(`Softn ${record.tag} (${record.commit.slice(0, 12)}) is installed and intact${frozenRecord ? ' and is the frozen release of this run' : ''}.`);
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const frozenIndex = args.indexOf('--frozen');
  const frozenArg = frozenIndex >= 0 ? args[frozenIndex + 1] : null;
  if (frozenIndex >= 0 && (!frozenArg || frozenArg.startsWith('--'))) { console.error('fetch-softn-release: --frozen needs a file path'); process.exit(1); }
  try {
    if (args.includes('--resolve-only')) await resolveOnly({ frozenPath: frozenArg || process.env.SOFTN_FROZEN || DEFAULT_FROZEN_PATH });
    else if (args.includes('--check')) await checkInstalled({ frozen: frozenArg || process.env.SOFTN_FROZEN || null });
    else await fetchSoftnRelease({ syncAdapter: args.includes('--sync-adapter'), frozen: frozenArg || process.env.SOFTN_FROZEN || null });
  } catch (error) {
    if (error instanceof ReleaseError) { console.error(`fetch-softn-release: ${error.message}`); process.exit(1); }
    throw error;
  }
}
