#!/usr/bin/env node
/**
 * Take the Softn runtime FormLogic embeds from Softn's GitHub release, not
 * from a source build.
 *
 * Every Softn release (tag v*) carries `softn-formlogic-runtime-<tag>.zip`:
 * the ZIPP engine Softn took from a ZIPP release, the hosted app runtime, the
 * two embedded editors, the native backend runtime and the FormLogic adapter
 * source, built once by Softn's release workflow and verified there. This
 * script fetches the latest release (or the one SOFTN_RELEASE names), proves
 * the archive is the one the release page describes, that every copy of the
 * engine in it is the one ZIPP release its softn-release.json records, and
 * that it fits THIS FormLogic (same protocol versions, the adapter this tree
 * has vendored), and installs the four generated trees where the build and
 * the tests expect them:
 *
 *   zipp/            -> formlogic/ui/vendor/zipp-wasm/   (the browser engine)
 *   hosted-runtime/  -> formlogic/ui/public/hosted-runtime/
 *   app-editors/     -> formlogic/ui/public/app-editors/
 *   native-runtime/  -> formlogic/backend/resources/softn-native/
 *
 * Which ZIPP release that is, is Softn's choice: nothing in this tree names
 * one, so a Softn release that moves ZIPP installs without a FormLogic commit.
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
 * One generation per install (release-readiness FL-S05). The four trees are
 * staged and verified together, promoted together with the previous trees
 * kept until the new generation is recorded, and recorded with a complete
 * file inventory; a promotion that fails is rolled back before the run ends,
 * an interrupted one is resolved deterministically on the next run, and
 * `--check` verifies every installed file against the inventory, so a
 * mixture of two releases with the same engine cannot pass as an intact
 * install. While the promotion journal exists, `--check` and the UI prebuild
 * checks refuse the trees.
 *
 * GITHUB_TOKEN / GH_TOKEN, when set, authenticate the API calls (the
 * unauthenticated limit is enough for a laptop, not for a busy CI account).
 * Downloads land under .runtime-source/softn-release/<tag>/ (ignored by git)
 * and are reused when their digest still matches. The record of what is
 * installed is .runtime-source/softn-release/current.json, which
 * scripts/ecosystem-manifest.mjs reads.
 *
 * Developers who want to run against a local Softn checkout instead keep the
 * source path: SOFTN_REPO with scripts/sync-zipp-from-softn.mjs (after
 * `npm run fetch:zipp` in the checkout), scripts/prepare-native-runtime.mjs,
 * and formlogic/ui `npm run build:hosted-runtime` and `npm run build:app-editors`.
 * A local archive (SOFTN_RELEASE_ARCHIVE) is the same path CI takes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive } from './lib/archive.mjs';
import { runtimeIdentity, assertMatchingRuntime, checkRuntimeArtifact, checkZippTree, isZippEngineWasm, zippReleaseIdentity, artifactFiles, LINKED_ASSET } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';
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
/**
 * Where a release's engine copies live, as Softn's packager requires them: the
 * browser engine tree, the native runtime, and in the hosted runtime and each
 * editor the hashed app asset and the core-runtime copy. Each must yield one
 * to the content scan, so an engine whose exports changed, or a copy a Softn
 * packaging change dropped, fails the fetch instead of a later build or package.
 */
const KNOWN_ENGINE_COPIES = [
  'zipp/zipp_wasm_bg.wasm',
  'native-runtime/wasm/zipp_wasm_bg.wasm',
  ...['hosted-runtime', 'app-editors/builder', 'app-editors/studio'].flatMap((prefix) => [`${prefix}/assets/zipp_wasm_bg-*.wasm`, `${prefix}/assets/core-runtime/zipp_wasm_bg.wasm`]),
].map((where) => ({ where, pattern: new RegExp(`^${where.replace(/[.]/g, '\\.').replace('*', '[^/]+')}$`) }));
/** The first Softn release that ships its ZIPP engine as a zipp/ tree with the ZIPP release it came from. */
const FIRST_ZIPP_TREE_RELEASE = 'v0.0.15';

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
/**
 * What a test hook throws to stand for the process dying at that point: the
 * install does not roll back in process and leaves the promotion journal as a
 * kill would, for the next run to resolve.
 */
export class SimulatedCrash extends Error {}

function defaultPaths(root) {
  return {
    root,
    protocolFile: resolve(root, 'formlogic/ui/src/lib/softn/protocol.json'),
    zippWasm: resolve(root, 'formlogic/ui/vendor/zipp-wasm'),
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
 * manifest records, check every engine copy is the one ZIPP release the
 * manifest records, and check the release fits this tree: protocol versions,
 * and (reported, not enforced here) the adapter digest.
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

  // The engine: whichever ZIPP release Softn built this release with, taken
  // from release.zipp, never from this tree. Its zipp/ tree must be that
  // release, and every other copy in the archive the same bytes.
  const zippTree = new Map();
  for (const [name, entry] of entries) if (name.startsWith('zipp/') && !name.endsWith('/')) zippTree.set(name.slice('zipp/'.length), entry.data);
  let zipp;
  try {
    if (!zippTree.size) throw new Error('the archive has no zipp/ tree');
    zipp = zippReleaseIdentity(release.zipp);
  } catch (error) {
    throw new ReleaseError(`Softn ${release.tag} does not ship its ZIPP engine as a ZIPP release FormLogic can install (${error.message}). This FormLogic takes its browser engine from the Softn release and needs Softn ${FIRST_ZIPP_TREE_RELEASE} or later.`);
  }
  const expected = runtimeIdentity(zipp);
  try { await checkZippTree(zippTree, zipp); }
  catch (error) { throw new ReleaseError(`zipp/ in Softn ${release.tag} is not the ZIPP ${zipp.release} softn-release.json records: ${error.message}`); }
  const wasm = entries.get('native-runtime/wasm/zipp_wasm_bg.wasm');
  if (!wasm) throw new ReleaseError('The archive has no native-runtime/wasm/zipp_wasm_bg.wasm.');
  if (sha256(wasm.data) !== expected.sha256) throw new ReleaseError('The archive\'s ZIPP engine bytes differ from the digest its manifest records.');
  const shippedSource = JSON.parse(entryText(entries, 'native-runtime/wasm/SOURCE.json'));
  try { assertMatchingRuntime(runtimeIdentity(shippedSource), expected); }
  catch { throw new ReleaseError(`native-runtime/wasm/SOURCE.json names ZIPP ${shippedSource?.version} (${String(shippedSource?.sha256).slice(0, 12)}); softn-release.json records ${expected.version} (${expected.sha256.slice(0, 12)}).`); }
  const nativeGlue = entries.get('native-runtime/wasm/zipp_wasm.mjs');
  if (!nativeGlue || !nativeGlue.data.equals(zippTree.get('zipp_wasm.js'))) throw new ReleaseError('native-runtime/wasm/zipp_wasm.mjs is not zipp/zipp_wasm.js: the native runtime and the browser engine must share one glue build.');
  // By content, not by name: a hashed asset or a renamed copy is still found.
  const copies = [];
  for (const [name, entry] of entries) {
    if (!isZippEngineWasm(entry.data)) continue;
    const digest = sha256(entry.data);
    if (digest !== expected.sha256) throw new ReleaseError(`${name} is a ZIPP engine (${digest.slice(0, 12)}) other than the ZIPP ${zipp.release} engine (${expected.sha256.slice(0, 12)}) softn-release.json records; one release ships one engine.`);
    copies.push(name);
  }
  const unfound = KNOWN_ENGINE_COPIES.filter(({ pattern }) => !copies.some((name) => pattern.test(name)));
  if (unfound.length) throw new ReleaseError(`No ZIPP engine copy matches ${unfound.map(({ where }) => where).join(', ')} in Softn ${release.tag} (found: ${copies.join(', ') || 'none'}); a copy is missing or the engine's exports changed, so the content check cannot vouch for this archive.`);

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

/** Every file under a tree, runtime-manifest.json included, by the lister checkRuntimeArtifact uses; a link is a ReleaseError. */
async function listFiles(directory) {
  try { return await artifactFiles(directory, { includeManifest: true }); }
  catch (error) { throw error.code === LINKED_ASSET ? new ReleaseError(error.message) : error; }
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

/** The filesystem operations promotion goes through; a test replaces some to make a move fail, or die partway. */
const promotionOps = (ops = {}) => ({ rename, cp, rm, writeFile, ...ops });

/** A rename Windows can refuse for a moment while a scanner or watcher holds the target: a few short retries. */
async function renameRetrying(from, to, ops) {
  for (let attempt = 1; ; attempt++) {
    try { return await ops.rename(from, to); }
    catch (error) {
      if ((error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY') || attempt === 5) throw error;
      await new Promise((settle) => setTimeout(settle, 20 * attempt));
    }
  }
}

/** JSON written as a temporary sibling renamed over the file, so a kill leaves the old content or the new, never a prefix. */
async function writeJson(file, value, ops) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await ops.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  try { await renameRetrying(temporary, file, ops); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/**
 * Move a directory. Windows refuses to rename a tree while a watcher (Vite's
 * dev server over public/) holds a folder inside it, and a fresh copy in the
 * same folder is watched as soon as it appears, so the fallback copies
 * straight into `to` and then removes `from`. A copy killed partway leaves a
 * partial `to` beside an intact `from`; `copying(true)` before the copy and
 * `copying(false)` once it is whole let the caller's journal tell them apart.
 */
async function moveDir(from, to, ops, copying = async () => {}) {
  try { return await ops.rename(from, to); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EXDEV') throw error; }
  await copying(true);
  await ops.cp(from, to, { recursive: true });
  await copying(false);
  await ops.rm(from, { recursive: true, force: true });
}

/** How the archive's provenance.json differs from the installed copy, for the generation record. */
const PROVENANCE_TRANSFORM = 'release: {tag, commit} and hostedRuntime added';

/**
 * A sorted, distinct list of ids from either shape a manifest may use (a list, or an object keyed
 * by id), or null when there is nothing usable. Null means "this release says nothing", which the
 * reader treats as fail-closed — never as "no engines".
 */
function idList(value) {
  const ids = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.keys(value) : null);
  if (!ids) return null;
  const clean = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))].sort();
  return clean.length ? clean : null;
}

/**
 * What the hosted runtime this release installs advertises, taken from the archive itself:
 * `engines` and `features` from hosted-runtime/runtime-manifest.json, `protocols` from
 * softn-release.json. Stamped into the native runtime's provenance (the one file the install
 * already transforms, and the one the backend already reads) so the server can decide an app's
 * engine from what is INSTALLED without guessing at a web root. Every field is optional: a
 * release from before Softn advertises them stamps an empty record, and the reader fails closed.
 */
export function hostedRuntimeRecord(entries, release) {
  const manifest = JSON.parse(entryText(entries, 'hosted-runtime/runtime-manifest.json'));
  const engines = idList(manifest?.engines);
  const features = idList(manifest?.features);
  const protocols = release?.protocols && typeof release.protocols === 'object' && !Array.isArray(release.protocols)
    ? sortKeys(release.protocols)
    : null;
  return {
    ...(engines ? { engines } : {}),
    ...(features ? { features } : {}),
    ...(protocols ? { protocols } : {}),
  };
}

/**
 * The four trees a release installs, in promotion order. `prepare` edits a
 * staged tree before it is verified (the native runtime's provenance gains
 * the release it came from and what the hosted runtime advertises);
 * `validate` is the same check the source builders and `--check` apply.
 * `releaseInfo.zipp` is the release's ZIPP record, which the installed engine
 * tree's SOURCE.json must carry.
 */
function generationTrees(paths, expected, releaseInfo, hostedRuntime = null) {
  return [
    {
      name: 'zipp-wasm', prefix: 'zipp/', destination: paths.zippWasm, stagePrefix: '.zipp-wasm-',
      validate: async (dir) => {
        try { await checkZippTree(dir, releaseInfo.zipp); }
        catch (error) { throw new ReleaseError(`The browser engine tree (${relative(paths.root, dir) || dir}) is not the ZIPP ${releaseInfo.zipp?.release ?? '(unrecorded)'} Softn ${releaseInfo.tag} records: ${error.message}`); }
      },
    },
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
        if (hostedRuntime) provenance.hostedRuntime = hostedRuntime;
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
 * generation (if all of them are, the generation is completed by recording
 * it) or is put back from the `.previous` copy kept for exactly this, so the
 * result is all-old or all-new, never a mixture. Returns what it did. `ops`
 * replaces filesystem operations (tests).
 */
export async function recoverPromotion(paths, log = () => {}, ops = {}) {
  const io = promotionOps(ops);
  const journalFile = promotionJournalPath(paths);
  if (!existsSync(journalFile)) return null;
  let journal;
  try { journal = JSON.parse(await readFile(journalFile, 'utf8')); }
  catch { journal = null; }
  if (!journal || journal.formatVersion !== 1 || !journal.trees) {
    // A journal that names no trees says nothing about what to put back, and
    // the trees may be a mixture. Discarding it would let every check pass
    // them, so it stays until an install records a complete generation,
    // which replaces it.
    log('.runtime-source/softn-release/promotion.json names no trees to resolve (it is unreadable, or an install over such a journal was rolled back); it is kept, and --check and the UI prebuild checks refuse the trees, until an install records a complete generation');
    return { outcome: 'kept-unresolvable-journal' };
  }
  const names = Object.keys(journal.trees);
  // The journal is written before and after every swap, so each tree's state
  // says what happened to it, not what its bytes happen to look like (two
  // releases can share an identical tree; bytes alone cannot tell "promoted
  // with nothing before it" from "never touched").
  if (names.every((name) => journal.trees[name].state === 'promoted')) {
    for (const name of names) {
      const diff = await inventoryDiff(journal.trees[name].destination, journal.trees[name].inventory);
      if (!intact(diff)) return rollBack(journal, journalFile, log, io, `${name} was promoted but is not the new generation`);
    }
    await mkdir(paths.cache, { recursive: true });
    await writeJson(currentRecordPath(paths), journal.record, io);
    for (const name of names) await io.rm(journal.trees[name].previous, { recursive: true, force: true });
    await io.rm(journalFile, { force: true });
    log(`completed the interrupted install of Softn ${journal.record.tag}: every tree was already the new generation`);
    return { outcome: 'completed', tag: journal.record.tag };
  }
  return rollBack(journal, journalFile, log, io);
}

async function rollBack(journal, journalFile, log, io, reason = 'the swap did not finish') {
  for (const tree of Object.values(journal.trees)) {
    if (tree.state === 'restored' || tree.copyingAside) {
      // Restored: the old tree is back and only .previous is left to remove.
      // Copying aside: the old tree was being copied to .previous and was not
      // yet removed, so the destination is still the old tree, whole, and
      // .previous (partial or not) is not needed.
      await io.rm(tree.previous, { recursive: true, force: true });
    } else if (tree.state === 'promoted' || tree.state === 'promoting') {
      if (existsSync(tree.previous)) {
        // The old tree was set aside whole and the new one may or may not be
        // in place: put the old one back. A copy back cut short is redone from
        // .previous; once it is whole the journal says so before .previous is
        // removed, since a removal cut short leaves a partial .previous.
        await io.rm(tree.destination, { recursive: true, force: true });
        await moveDir(tree.previous, tree.destination, io, async (copying) => {
          if (copying) return;
          tree.state = 'restored';
          await writeJson(journalFile, journal, io);
        });
      } else if (!tree.hadPrevious && existsSync(tree.destination)) {
        // Promoted with nothing before it (a first install): back to nothing.
        await io.rm(tree.destination, { recursive: true, force: true });
      }
      // hadPrevious without a .previous directory: the swap had not begun, or the old tree was renamed back; the destination is the old tree.
    }
    if (tree.staged && existsSync(tree.staged)) await io.rm(tree.staged, { recursive: true, force: true });
  }
  // An install that began over a journal naming no trees puts that refusal back with the trees.
  if (journal.unresolvedBefore) await writeJson(journalFile, { formatVersion: 1, unresolved: `an install of Softn ${journal.record?.tag ?? '(unknown)'} over an unresolvable promotion journal was rolled back` }, io);
  else await io.rm(journalFile, { force: true });
  log(`rolled back the install of Softn ${journal.record?.tag ?? '(unknown)'} (${reason}): the previous generation is back in place`);
  return { outcome: 'rolled-back', tag: journal.record?.tag ?? null };
}

/**
 * Install the four trees as one generation: stage and verify all of them,
 * write the promotion journal, swap each destination (keeping the previous
 * tree beside it), record the generation with its complete inventory, and
 * only then drop the previous trees. A failure between writing the journal
 * and recording the generation (a move refused, a promoted tree failing
 * validation) rolls the generation back before rethrowing; if the rollback
 * fails too, the journal stays and the error names both. `failAt` is a test
 * hook: the name of the step to die before ('promote:app-editors', 'record',
 * ...), as a SimulatedCrash, which is not rolled back. `ops` replaces
 * filesystem operations (tests).
 */
export async function installGeneration(entries, expected, paths, record, { failAt = null, log = () => {}, ops = {} } = {}) {
  const io = promotionOps(ops);
  const trees = generationTrees(paths, expected, record, hostedRuntimeRecord(entries, record));
  await sweepStaging(trees);
  const staged = {};
  const journalFile = promotionJournalPath(paths);
  let journal = null;
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
        transformation: PROVENANCE_TRANSFORM,
        archiveSha256: sha256(entries.get(PROVENANCE).data),
        contentSha256: canonicalDigest(archiveProvenance),
        release: { tag: record.tag, commit: record.commit },
      },
    };
    const inventory = {};
    for (const tree of trees) inventory[tree.name] = await inventoryOf(staged[tree.name]);
    const full = { ...record, generation: { installedAt: new Date().toISOString(), inventory, transformed } };
    // A journal already here is one recoverPromotion kept because it names no
    // trees; if this install is rolled back, that refusal is put back too.
    journal = { formatVersion: 1, startedAt: new Date().toISOString(), record: full, trees: {}, ...(existsSync(journalFile) && { unresolvedBefore: true }) };
    for (const tree of trees) journal.trees[tree.name] = { state: 'staged', hadPrevious: existsSync(tree.destination), destination: tree.destination, staged: staged[tree.name], previous: `${tree.destination}.previous`, inventory: inventory[tree.name] };
    await mkdir(paths.cache, { recursive: true });
    const writeJournal = () => writeJson(journalFile, journal, io);
    await writeJournal();

    for (const tree of trees) {
      if (failAt === `promote:${tree.name}`) throw new SimulatedCrash(`injected failure before promoting ${tree.name}`);
      const previous = `${tree.destination}.previous`;
      await io.rm(previous, { recursive: true, force: true });
      journal.trees[tree.name].state = 'promoting';
      await writeJournal();
      // A copy aside cut short leaves a partial .previous beside the intact old
      // tree, so the journal says a copy is under way until it is whole.
      if (existsSync(tree.destination)) await moveDir(tree.destination, previous, io, async (copying) => { journal.trees[tree.name].copyingAside = copying; await writeJournal(); });
      await moveDir(staged[tree.name], tree.destination, io);
      staged[tree.name] = null;
      journal.trees[tree.name].staged = null;
      journal.trees[tree.name].state = 'promoted';
      await writeJournal();
      await tree.validate(tree.destination);
    }
    if (failAt === 'record') throw new SimulatedCrash('injected failure before recording the generation');
    await writeJson(currentRecordPath(paths), full, io);
    // Recorded, so the new generation stands: a cleanup failing from here
    // leaves the journal, every tree promoted, for the next run to complete.
    journal = null;
    for (const tree of trees) await io.rm(`${tree.destination}.previous`, { recursive: true, force: true });
    await io.rm(journalFile, { force: true });
    return full;
  } catch (error) {
    // Without a journal to act on (not yet written, or the generation already
    // recorded) nothing is put back, and a simulated crash leaves the journal
    // for the next run (recoverPromotion). Anything else is rolled back now,
    // so no mixture of two generations outlives the run.
    if (!journal || error instanceof SimulatedCrash) throw error;
    try { await rollBack(journal, journalFile, log, io, `failed: ${error.message}`); }
    catch (rollbackError) {
      if (rollbackError instanceof SimulatedCrash) throw rollbackError;
      throw new ReleaseError(`Installing Softn ${record.tag} failed mid-promotion (${error.message}), and rolling it back failed too (${rollbackError.message}). The trees may be a mixture of two generations; .runtime-source/softn-release/promotion.json is kept, so --check and the UI prebuild checks refuse them until node scripts/fetch-softn-release.mjs is run again and resolves it.`);
    }
    throw error;
  } finally {
    // Whatever failed, no staging directory outlives the run.
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
  ops = {},
  log = console.log,
} = {}) {
  const paths = defaultPaths(root);
  const frozenRecord = await loadFrozen(frozen, root);
  if (frozenRecord && tag && tag !== frozenRecord.tag) throw new ReleaseError(`SOFTN_RELEASE names ${tag} but the frozen release record for this run names ${frozenRecord.tag}; one run installs one release.`);
  const recovered = await recoverPromotion(paths, log, ops);
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
  const full = await installGeneration(entries, expected, paths, record, { failAt, log, ops });
  log(`Softn ${release.tag} (${release.commit.slice(0, 12)}) installed: browser engine, hosted runtime, app editors, native runtime; ZIPP ${release.zipp.release} (${release.zipp.revision.slice(0, 12)}, engine ${release.zipp.sha256.slice(0, 12)})${frozenRecord ? ' (frozen for this run)' : ''}`);
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
  // The engine identity is the installed release's; the engine tree's own
  // SOURCE.json must carry it (the zipp-wasm tree's check below).
  let expected;
  try { expected = runtimeIdentity(zippReleaseIdentity(record.zipp)); }
  catch (error) { throw new ReleaseError(`The installed Softn ${record.tag} records no ZIPP release FormLogic can install (${error.message}); this FormLogic needs Softn ${FIRST_ZIPP_TREE_RELEASE} or later. Run node scripts/fetch-softn-release.mjs.`); }
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
    // Both keys the install adds are dropped before the comparison, so a generation recorded by an
    // earlier fetcher (whose provenance carries no hostedRuntime) still holds to its archive.
    const { release: _release, hostedRuntime: _hostedRuntime, ...content } = provenance;
    if (canonicalDigest(content) !== transformed.contentSha256) throw new ReleaseError('native-runtime/provenance.json differs from the archive\'s beyond the recorded transformation (release and hostedRuntime added). Fetch again.');
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
