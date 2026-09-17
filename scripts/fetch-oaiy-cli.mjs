#!/usr/bin/env node
/**
 * Take the OAIY CLI FormLogic tests against from OAIY's GitHub release, not
 * from a source build.
 *
 * An OAIY release built with the standalone CLI carries `oaiy-cli-<v>.tar.gz`:
 * `oaiy.mjs`, its two worker shells, the ZIPP engine OAIY installed, and the
 * one dependency the CLI needs, packed by oaiy.com/scripts/pack-cli-asset.mjs.
 * The asset is OS-neutral (JavaScript and wasm), so one asset serves every
 * runner. This script resolves the latest release (or the one
 * OAIY_CLI_RELEASE names), proves the bytes are the ones the release page
 * describes, that the release's own evidence says they were built and
 * attested by a verified run of the revision the tag points at, that the
 * tarball's inner manifest accounts for every file in it, and that the engine
 * inside fits what FormLogic asks of it — then installs it where the parity
 * test expects:
 *
 *   .runtime-source/oaiy-cli/cli/oaiy.mjs   (OAIY_CLI for oaiyScriptParity.test.ts)
 *
 *   node scripts/fetch-oaiy-cli.mjs                          latest release
 *   OAIY_CLI_RELEASE=v0.0.5 node scripts/fetch-oaiy-cli.mjs  one release
 *   node scripts/fetch-oaiy-cli.mjs --dest <dir>             install somewhere else
 *   OAIY_REPO=../oaiy.com node scripts/fetch-oaiy-cli.mjs    pack from a local checkout (developers only)
 *
 * One release per run. A CI run that installs the CLI in several jobs must
 * not let an OAIY release published between two of them change what the later
 * job runs, so a run resolves the release ONCE and freezes its identity — tag,
 * the commit the annotated tag points at, the asset and its digest — in a
 * small record every job then consumes:
 *
 *   node scripts/fetch-oaiy-cli.mjs --resolve-only --frozen oaiy-cli-frozen.json
 *   node scripts/fetch-oaiy-cli.mjs --frozen oaiy-cli-frozen.json   (or OAIY_CLI_FROZEN=<file>)
 *
 * THE DIGEST IS THE RELEASE'S, NEVER A LOCAL HASH. Freezing the sha256 of the
 * bytes this machine happened to download would freeze nothing: a replaced
 * asset would be frozen as readily as the real one, and every later job would
 * agree with it. So the frozen digest is read from the release's own
 * SHA256SUMS.txt — the record the publishing run wrote over everything it
 * published — and the download is checked against that. OAIY publishes no
 * per-asset `.sha256` sidecar the way Softn does; SHA256SUMS.txt, the
 * evidence file's `artifacts[]` and its `cli.sha256` are the three
 * release-side statements of the same digest, and all three are checked.
 *
 * WHAT THE EVIDENCE IS WORTH. `release-evidence-linux.json` is written by the
 * build, then stamped `verified`/`pass` with its run id by
 * oaiy.com/scripts/attest-release-evidence.mjs, which re-hashes every artifact
 * it records before it will stamp anything, and the publish step refuses a
 * release whose evidence does not name the revision it built. That is a
 * STRUCTURAL ATTESTATION, not a cryptographic signature: it proves the
 * release's own machinery agreed with itself, not that a key held the bytes.
 * It is the same trust level as Softn's `.sha256` sidecar, and it is stated
 * here so nobody reads these checks as more than they are. `--verify-run`
 * asks GitHub whether the recorded run really succeeded at that revision;
 * it is opt-in because it needs a token that can read oaiy.com's Actions,
 * which a FormLogic workflow's own `github.token` is not.
 *
 * GITHUB_TOKEN / GH_TOKEN, when set, authenticate the API calls (the
 * unauthenticated limit is enough for a laptop, not for a busy CI account).
 * Downloads land under .runtime-source/oaiy-cli/<tag>/ (ignored by git) and
 * are reused when their digest still matches.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const RELEASE_REPOSITORY = 'f2i-com/oaiy.com';
/** The CLI asset is named for the VERSION, not the tag (`oaiy-cli-0.0.5.tar.gz` on `v0.0.5`), so it is found by shape. */
export const ASSET_PATTERN = /^oaiy-cli-.+\.tar\.gz$/;
/** The release's digest record over everything it published. */
export const SUMS_ASSET = 'SHA256SUMS.txt';
/**
 * The CLI asset is packed in the linux desktop leg alone (oaiy.com release.yml), so the linux
 * evidence file is the only one that records it; the windows and web evidence files describe
 * builds that never saw the tarball.
 */
export const EVIDENCE_ASSET = 'release-evidence-linux.json';
/** Inside the tarball: the CLI's own `capabilities --json`, verbatim, and the manifest over every other file. */
export const CAPABILITIES_FILE = 'oaiy-cli.json';
export const SUMS_FILE = 'SHA256SUMS';
/**
 * What an asset must carry to be an OAIY CLI at all. The same five
 * pack-cli-asset.mjs checks before it writes one: a tarball that passed every
 * digest check but has no `oaiy.mjs` would install and fail in the parity
 * test's first spawn, a long way from the reason.
 */
export const REQUIRED_FILES = ['oaiy.mjs', 'oaiy-zipp-worker.mjs', 'oaiy-script-worker.mjs', 'zipp/zipp_wasm_bg.wasm', 'zipp/SOURCE.json'];
/** The four blocks of `capabilities --json` the release evidence also records, and the whole of what rung 5 compares. */
export const CAPABILITY_KEYS = ['protocols', 'engine', 'run', 'script'];
/** The frozen record's format; a record another version wrote is refused rather than guessed at. */
export const FROZEN_FORMAT = 1;
export const DEFAULT_FROZEN_PATH = '.runtime-source/oaiy-cli/frozen.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A canonical rendering that does not depend on key order or formatting, for comparing two records of one thing. */
const canonical = (value) => JSON.stringify(sortKeys(value), null, 2);
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

/** A refusal the operator can act on; the CLI prints it and exits 1. */
export class ReleaseError extends Error {}

export function defaultPaths(root, { dest = null } = {}) {
  const cache = resolve(root, '.runtime-source/oaiy-cli');
  return {
    root,
    protocolFile: resolve(root, 'formlogic/ui/src/lib/oaiy/protocol.json'),
    cache,
    install: dest ? resolve(root, dest) : resolve(cache, 'cli'),
  };
}
const currentRecordPath = (paths) => resolve(paths.cache, 'current.json');

// ── Resolving and downloading ────────────────────────────────────────────────

function apiHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'formlogic-fetch-oaiy-cli', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The commit a tag names. An annotated tag is its own object whose target is
 * the commit; a lightweight tag is the commit. Neither is the release's
 * `target_commitish`, which is whatever was typed when the release was made
 * (often a branch name) and says nothing about what the tag points at now.
 * The evidence file records the revision it was built from, and that revision
 * is compared against THIS, so the two must be the same kind of thing.
 */
export async function resolveTagCommit({ tag, token, fetchImpl = fetch, repository = RELEASE_REPOSITORY }) {
  const ref = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, { headers: apiHeaders(token) });
  if (ref.status === 404) throw new ReleaseError(`OAIY (${repository}) has no tag ${tag}; the release exists but its tag is gone.`);
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
 *
 * A release with no CLI asset is refused HERE and the run ends. Walking back
 * to an older release would silently adopt an engine the owner did not
 * choose — the whole point of resolving the latest release and freezing it —
 * and every release older than the one that first packed the asset lacks it
 * too, so the walk could only end in this same refusal one tag later.
 */
export async function resolveRelease({ tag, token, fetchImpl = fetch, repository = RELEASE_REPOSITORY }) {
  const url = tag ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}` : `https://api.github.com/repos/${repository}/releases/latest`;
  const response = await fetchImpl(url, { headers: apiHeaders(token) });
  if (response.status === 404) throw new ReleaseError(tag ? `OAIY has no release tagged ${tag} (${repository}).` : `OAIY (${repository}) has no published release yet.`);
  if (!response.ok) throw new ReleaseError(`GitHub answered ${response.status} for ${url}${token ? '' : ' (set GITHUB_TOKEN if the unauthenticated rate limit is exhausted)'}.`);
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((a) => ASSET_PATTERN.test(a.name));
  if (!asset) {
    throw new ReleaseError(`OAIY release ${release.tag_name} carries no oaiy-cli-*.tar.gz asset (assets: ${assets.map((a) => a.name).join(', ') || 'none'}). FormLogic needs an OAIY release built with the standalone CLI asset; pin an older one with OAIY_CLI_RELEASE=<tag> or wait for the next release.`);
  }
  const commit = await resolveTagCommit({ tag: release.tag_name, token, fetchImpl, repository });
  return { tag: release.tag_name, commit, asset, assets, htmlUrl: release.html_url ?? null };
}

/**
 * The two release-side records the verification reads, refused by name when
 * either is missing. Releases cut before oaiy.com attested its evidence carry
 * SHA256SUMS.txt alone; "no digest to check, continue" is never the answer,
 * so each absence is its own refusal rather than a fall-through.
 */
export function releaseRecords({ tag, asset, assets }) {
  const sums = assets.find((a) => a.name === SUMS_ASSET);
  if (!sums) throw new ReleaseError(`OAIY release ${tag} carries ${asset.name} but no ${SUMS_ASSET}; there is no release-side digest to hold the download to.`);
  const evidence = assets.find((a) => a.name === EVIDENCE_ASSET);
  if (!evidence) throw new ReleaseError(`OAIY release ${tag} carries ${asset.name} but no ${EVIDENCE_ASSET}; the build that packed the CLI attested nothing, so nothing says these bytes came from ${tag}. An OAIY release cut after attest-release-evidence.mjs landed is needed.`);
  return { sums, evidence };
}

async function download(asset, target, token, fetchImpl) {
  // With a token the API asset URL is used (it serves private releases too);
  // without one the public download URL costs no API rate limit.
  const headers = apiHeaders(token);
  headers.Accept = 'application/octet-stream';
  const response = await fetchImpl(token && asset.url ? asset.url : asset.browser_download_url, { headers, redirect: 'follow' });
  if (!response.ok) throw new ReleaseError(`Downloading ${asset.name} failed: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (target) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return bytes;
}

/** `<sha256>  <path>` lines, in the two-space form `sha256sum -c` reads, as a path -> digest map. */
export function parseSums(text, where) {
  const sums = new Map();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})[ ][ *](.+)$/.exec(line);
    if (!match) throw new ReleaseError(`${where} has a line that is not "<sha256>  <file>": ${JSON.stringify(line)}`);
    if (sums.has(match[2])) throw new ReleaseError(`${where} lists ${match[2]} twice.`);
    sums.set(match[2], match[1]);
  }
  if (!sums.size) throw new ReleaseError(`${where} lists nothing.`);
  return sums;
}

/** The release's digest for one asset. A SHA256SUMS.txt that does not cover the asset is a refusal of its own. */
export function assetDigestFrom(sumsText, assetName, tag) {
  const digest = parseSums(sumsText, `OAIY release ${tag}'s ${SUMS_ASSET}`).get(assetName);
  if (!digest) throw new ReleaseError(`OAIY release ${tag}'s ${SUMS_ASSET} does not cover ${assetName}; the release publishes the asset without publishing its digest, so there is nothing to hold the download to.`);
  return digest;
}

// ── The frozen record: one release per run ──────────────────────────────────

/**
 * Resolve the release (latest, or the tag named) and write the record every
 * later job consumes: the tag, the commit the tag points at, the asset, the
 * evidence asset, and the digest the release page publishes for the asset.
 * Only SHA256SUMS.txt is downloaded here — a kilobyte, against the tarball's
 * three megabytes — because the digest is all the record needs and every job
 * downloads the asset itself anyway.
 */
export async function resolveOnly({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  tag = process.env.OAIY_CLI_RELEASE || null,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = fetch,
  frozenPath = process.env.OAIY_CLI_FROZEN || DEFAULT_FROZEN_PATH,
  log = console.log,
} = {}) {
  const resolved = await resolveRelease({ tag, token, fetchImpl });
  const { sums, evidence } = releaseRecords(resolved);
  const sumsText = (await download(sums, null, token, fetchImpl)).toString('utf8');
  const assetSha256 = assetDigestFrom(sumsText, resolved.asset.name, resolved.tag);
  // GitHub computes its own digest for an uploaded asset. When the API offers
  // one it is a second, independent release-side statement of the same fact,
  // and a release whose two statements disagree is not one to freeze. It is a
  // cross-check, not the source: the field is recent enough that an API
  // stand-in or an older instance may not carry it at all.
  const published = /^sha256:([0-9a-f]{64})$/.exec(resolved.asset.digest ?? '')?.[1] ?? null;
  if (published && published !== assetSha256) {
    throw new ReleaseError(`OAIY release ${resolved.tag} publishes ${resolved.asset.name} with digest ${published.slice(0, 12)}, but its ${SUMS_ASSET} records ${assetSha256.slice(0, 12)}; the release contradicts itself and is not frozen.`);
  }
  const frozen = {
    formatVersion: FROZEN_FORMAT,
    repository: RELEASE_REPOSITORY,
    source: 'release',
    tag: resolved.tag,
    tagCommit: resolved.commit,
    assetId: resolved.asset.id ?? null,
    assetName: resolved.asset.name,
    assetSha256,
    evidenceAssetId: evidence.id ?? null,
    htmlUrl: resolved.htmlUrl,
    resolvedAt: new Date().toISOString(),
  };
  const target = resolve(root, frozenPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(frozen, null, 2) + '\n');
  log(`OAIY ${frozen.tag} (${String(frozen.tagCommit).slice(0, 12)}) frozen: ${frozen.assetName} ${assetSha256.slice(0, 12)} -> ${relative(root, target) || target}`);
  return frozen;
}

/** Read and validate a frozen record; `null` when no path is given. */
export async function loadFrozen(frozenPath, root, { inCi = Boolean(process.env.CI) } = {}) {
  if (!frozenPath) return null;
  if (typeof frozenPath === 'object') return validateFrozen(frozenPath, '(object)', inCi);
  const file = resolve(root, frozenPath);
  if (!existsSync(file)) throw new ReleaseError(`The frozen release record ${frozenPath} does not exist; run node scripts/fetch-oaiy-cli.mjs --resolve-only --frozen ${frozenPath} first.`);
  let frozen;
  try { frozen = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new ReleaseError(`The frozen release record ${frozenPath} is not JSON: ${error.message}`); }
  return validateFrozen(frozen, frozenPath, inCi);
}
function validateFrozen(frozen, where, inCi) {
  if (frozen.formatVersion !== FROZEN_FORMAT) throw new ReleaseError(`The frozen release record ${where} has formatVersion ${frozen.formatVersion}; this fetcher writes ${FROZEN_FORMAT}.`);
  // A record from a local build names bytes only one machine has. It is a
  // developer's shortcut, and CI installing it would test an engine nobody
  // published and nobody else can reproduce.
  if (frozen.source === 'local') {
    if (inCi) throw new ReleaseError(`The frozen release record ${where} was packed from a local OAIY checkout (source: "local"); CI installs published releases only. Remove OAIY_REPO and resolve a release.`);
    return frozen;
  }
  if (typeof frozen.tag !== 'string' || !/^v\d/.test(frozen.tag)) throw new ReleaseError(`The frozen release record ${where} names no tag.`);
  if (!/^[0-9a-f]{40}$/.test(frozen.tagCommit ?? '')) throw new ReleaseError(`The frozen release record ${where} has no 40-hex tagCommit.`);
  if (!/^[0-9a-f]{64}$/.test(frozen.assetSha256 ?? '')) throw new ReleaseError(`The frozen release record ${where} has no 64-hex assetSha256.`);
  if (typeof frozen.assetName !== 'string' || !ASSET_PATTERN.test(frozen.assetName)) throw new ReleaseError(`The frozen release record ${where} names no oaiy-cli-*.tar.gz asset.`);
  return frozen;
}

// ── The tarball, read as an extractor would ─────────────────────────────────

/** ustar entry types this reader accepts: a regular file (two spellings) and a directory. */
const TAR_FILE = new Set(['0', '\0']);
const TAR_DIRECTORY = '5';

/**
 * Read a ustar archive into `Map<path, Buffer>` of its regular files.
 *
 * Written here rather than shelled out to the platform's `tar` for the same
 * reason oaiy.com writes its own: one behaviour on every runner, no tool to
 * install, and — the reason that matters — full control of what is REFUSED.
 * An extractor that quietly skips what it does not understand is how a file
 * slips past a manifest check: a symbolic link, a hard link, a pax or GNU
 * long-name header carries a name or a target the manifest never saw, and
 * skipping it makes the archive look complete. Every entry is therefore
 * either a file this reader hashes, a directory, or a refusal.
 */
export function untar(archive) {
  const files = new Map();
  const text = (start, length) => archive.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  let at = 0;
  while (at + 512 <= archive.length) {
    const block = archive.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const magic = archive.subarray(at + 257, at + 263).toString('latin1');
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new ReleaseError(`The asset is not a ustar archive (no ustar magic at offset ${at}); it is not the tarball pack-cli-asset.mjs writes.`);
    // The header's own checksum, computed with the checksum field read as eight spaces.
    const stored = parseInt(text(at + 148, 8).trim() || '-1', 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    if (sum !== stored) throw new ReleaseError(`A tar header at offset ${at} fails its own checksum (${sum} against the recorded ${stored}); the asset is corrupt.`);
    const name = text(at, 100);
    const prefix = text(at + 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(block[156] || 0x30);
    const rawSize = text(at + 124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize || '0')) throw new ReleaseError(`${full || '(unnamed entry)'} has a size field this reader does not read (${JSON.stringify(rawSize)}); base-256 and pax sizes are not what pack-cli-asset.mjs writes.`);
    const size = parseInt(rawSize || '0', 8);
    at += 512;
    if (type === TAR_DIRECTORY) continue;
    if (!TAR_FILE.has(type)) {
      const kind = { 1: 'a hard link', 2: 'a symbolic link', 3: 'a character device', 4: 'a block device', 6: 'a FIFO', x: 'a pax header', g: 'a global pax header', L: 'a GNU long name', K: 'a GNU long link name' }[type] ?? `an entry of type ${JSON.stringify(type)}`;
      throw new ReleaseError(`${full || '(unnamed entry)'} is ${kind}; the OAIY CLI asset carries regular files only, and an entry this reader skipped would be a file no manifest check ever saw.`);
    }
    if (!full) throw new ReleaseError(`A tar entry at offset ${at - 512} has no name.`);
    if (full.startsWith('/') || /^[A-Za-z]:/.test(full) || full.split('/').includes('..')) throw new ReleaseError(`${full} is an absolute or escaping path; the asset unpacks into one folder.`);
    if (files.has(full)) throw new ReleaseError(`${full} appears twice in the asset; which copy is the file the manifest describes cannot be decided.`);
    files.set(full, Buffer.from(archive.subarray(at, at + size)));
    at += Math.ceil(size / 512) * 512;
  }
  if (!files.size) throw new ReleaseError('The asset holds no files.');
  return files;
}

// ── The verification ladder ─────────────────────────────────────────────────

/**
 * Rung 3: the release's own evidence. `attest-release-evidence.mjs` re-hashes
 * every artifact it records before it stamps `verified`/`pass` and the run it
 * was stamped by, and oaiy.com refuses to publish a release whose evidence
 * does not name the revision it built — so an evidence file that names this
 * tag's commit, is verified and audited, and records the asset at the digest
 * the release publishes, is the release saying these bytes are its own.
 * Every field is checked: an evidence file left `unverified` is the build's
 * own word, not the attestation's.
 */
export function verifyEvidence(evidence, { tag, tagCommit, assetName, assetSha256 }) {
  const where = `OAIY release ${tag}'s ${EVIDENCE_ASSET}`;
  if (evidence?.revision !== tagCommit) throw new ReleaseError(`${where} was built from ${String(evidence?.revision).slice(0, 12)}, but tag ${tag} points at ${tagCommit.slice(0, 12)}; the evidence is not this tag's build.`);
  if (evidence.verification?.status !== 'verified') throw new ReleaseError(`${where} records verification.status ${JSON.stringify(evidence.verification?.status ?? null)}, not "verified"; the release's own checks did not pass, or were never attested.`);
  if (evidence.dependencyAudit?.status !== 'pass') throw new ReleaseError(`${where} records dependencyAudit.status ${JSON.stringify(evidence.dependencyAudit?.status ?? null)}, not "pass".`);
  const runId = evidence.verification?.run?.id;
  if (!runId) throw new ReleaseError(`${where} is verified but names no verification.run.id; nothing says which run attested it.`);
  if (evidence.verification.revision && evidence.verification.revision !== tagCommit) throw new ReleaseError(`${where} was attested for ${String(evidence.verification.revision).slice(0, 12)}, not the ${tagCommit.slice(0, 12)} it records as its revision.`);
  const artifact = (Array.isArray(evidence.artifacts) ? evidence.artifacts : []).find((entry) => entry?.name === assetName);
  if (!artifact) throw new ReleaseError(`${where} records ${evidence.artifacts?.length ?? 0} artifacts and ${assetName} is not among them; the attested build did not produce this asset.`);
  if (artifact.sha256 !== assetSha256) throw new ReleaseError(`${where} records ${assetName} at ${String(artifact.sha256).slice(0, 12)}; the release publishes ${assetSha256.slice(0, 12)}. The asset was replaced after it was attested.`);
  if (evidence.cli?.asset !== assetName) throw new ReleaseError(`${where} describes a CLI asset named ${JSON.stringify(evidence.cli?.asset ?? null)}, not ${assetName}.`);
  if (evidence.cli?.sha256 !== assetSha256) throw new ReleaseError(`${where} records cli.sha256 ${String(evidence.cli?.sha256).slice(0, 12)}; the release publishes ${assetSha256.slice(0, 12)}.`);
  return { runId: String(runId), attempt: evidence.verification.run.attempt ?? null, attestedAt: evidence.verification.attestedAt ?? null };
}

/**
 * The optional hardening the evidence cannot give itself: GitHub's own answer
 * about the run that stamped it. It needs a token that can read oaiy.com's
 * Actions, which a FormLogic workflow's `github.token` is not, so it is
 * asked for with --verify-run and never on by default.
 */
export async function verifyAttestingRun({ runId, tagCommit, token, fetchImpl = fetch, repository = RELEASE_REPOSITORY }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`, { headers: apiHeaders(token) });
  if (!response.ok) throw new ReleaseError(`GitHub answered ${response.status} for the run ${runId} the evidence names${token ? '' : ' (--verify-run needs a token that can read oaiy.com Actions)'}.`);
  const run = await response.json();
  if (run.conclusion !== 'success') throw new ReleaseError(`The run ${runId} that attested this release concluded ${JSON.stringify(run.conclusion ?? null)}, not "success".`);
  if (run.head_sha !== tagCommit) throw new ReleaseError(`The run ${runId} that attested this release ran at ${String(run.head_sha).slice(0, 12)}, not the tag's ${tagCommit.slice(0, 12)}.`);
  return { conclusion: run.conclusion, headSha: run.head_sha };
}

/**
 * Rungs 4 to 8, against the tarball's bytes and this tree.
 *
 * 4. Every file in the archive is the one the archive's own SHA256SUMS
 *    records: nothing missing, nothing extra, nothing a link.
 * 5. `oaiy-cli.json` — the CLI's own `capabilities --json`, written into the
 *    asset by the packer — says exactly what the release evidence says it
 *    says. The tarball and the release record must agree about the engine
 *    inside, or one of them is describing a different build.
 * 6. The engine reports itself ready.
 * 7. It runs Python.
 * 8. It speaks every protocol FormLogic speaks, at FormLogic's version.
 *
 * `evidenceCli` is null when there is no release record to compare against
 * (a local pack), which drops rung 5 and nothing else.
 */
export async function verifyAsset(archive, { paths, assetName, evidenceCli = null }) {
  let files;
  try { files = untar(gunzipSync(archive)); }
  catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError(`${assetName} does not read back as a gzipped ustar archive: ${error.message}`); }

  const sumsFile = files.get(SUMS_FILE);
  if (!sumsFile) throw new ReleaseError(`${assetName} carries no ${SUMS_FILE}; the asset describes none of its own files.`);
  const sums = parseSums(sumsFile.toString('utf8'), `${assetName}'s ${SUMS_FILE}`);
  for (const [name, digest] of sums) {
    const bytes = files.get(name);
    if (!bytes) throw new ReleaseError(`${assetName}'s ${SUMS_FILE} lists ${name}, which is not in the asset.`);
    const actual = sha256(bytes);
    if (actual !== digest) throw new ReleaseError(`${name} in ${assetName} has digest ${actual.slice(0, 12)}; its ${SUMS_FILE} records ${digest.slice(0, 12)}.`);
  }
  // SHA256SUMS cannot list itself; everything else present but unlisted is a
  // file the release never described, and an installed tree is only ever the
  // files the release described.
  for (const name of files.keys()) {
    if (name !== SUMS_FILE && !sums.has(name)) throw new ReleaseError(`${name} is in ${assetName} but not in its ${SUMS_FILE}.`);
  }
  for (const required of REQUIRED_FILES) {
    if (!files.has(required)) throw new ReleaseError(`${assetName} is missing ${required}; it is not an OAIY CLI.`);
  }

  const capabilitiesBytes = files.get(CAPABILITIES_FILE);
  if (!capabilitiesBytes) throw new ReleaseError(`${assetName} carries no ${CAPABILITIES_FILE}; nothing in it says what its engine can do.`);
  let capabilities;
  try { capabilities = JSON.parse(capabilitiesBytes.toString('utf8')); }
  catch (error) { throw new ReleaseError(`${CAPABILITIES_FILE} in ${assetName} is not JSON: ${error.message}`); }

  if (evidenceCli) {
    // Compared key by key, and only the four the evidence also records: the
    // report carries a `version` the evidence block does not, and the
    // evidence block carries the `asset` and `sha256` the report does not.
    // Naming the key that differs is the whole value of the rung — "the
    // tarball and the release disagree" says nothing an operator can act on.
    for (const key of CAPABILITY_KEYS) {
      if (canonical(capabilities?.[key]) !== canonical(evidenceCli?.[key])) {
        throw new ReleaseError(`${CAPABILITIES_FILE} in ${assetName} and ${EVIDENCE_ASSET} disagree about ${key}:\n  asset:    ${canonical(capabilities?.[key])?.replace(/\n/g, '\n  ')}\n  evidence: ${canonical(evidenceCli?.[key])?.replace(/\n/g, '\n  ')}`);
      }
    }
  }

  const engine = capabilities?.engine ?? {};
  if (engine.status !== 'ready') throw new ReleaseError(`The engine in ${assetName} reports status ${JSON.stringify(engine.status ?? null)}${engine.reason ? ` (${engine.reason})` : ''}, not "ready"; a CLI whose engine does not start runs no logic.`);
  // The engine's own language list, which `script.languages` repeats (the CLI
  // sets both from one identity). NEVER `run.languages`: that is the typed
  // literal ["javascript"] of the `oaiy run` lane — a fact about which
  // workflow node types exist, not about the engine — so reading it here
  // would refuse every release ever built, including one running Python
  // perfectly well.
  const languages = Array.isArray(engine.languages) ? engine.languages : capabilities?.script?.languages;
  if (!Array.isArray(languages) || !languages.includes('python')) {
    throw new ReleaseError(`The engine in ${assetName} runs ${Array.isArray(languages) ? languages.join(', ') || 'nothing' : 'an unrecorded set of languages'}; FormLogic's leaf scripts are Python as well as JavaScript, so a release whose engine.languages lacks python is refused. The OAIY release must install a ZIPP build with the Python variant.`);
  }

  const protocol = JSON.parse(await readFile(paths.protocolFile, 'utf8'));
  const speaks = capabilities?.protocols ?? {};
  for (const key of Object.keys(protocol)) {
    if (speaks[key] !== protocol[key]) {
      throw new ReleaseError(`The CLI in ${assetName} speaks ${key} ${JSON.stringify(speaks[key] ?? null)}; this FormLogic speaks ${protocol[key]} (formlogic/ui/src/lib/oaiy/protocol.json). A FormLogic that understands that protocol is needed, or an older OAIY (OAIY_CLI_RELEASE=<tag>).`);
    }
  }
  // Deliberately a SUBSET: a protocol OAIY adds is not FormLogic's problem
  // until FormLogic speaks it, and OAIY's Desktop reads FormLogic's side the
  // same way. `run` is the standing example — OAIY reports it, FormLogic's
  // protocol.json does not claim it, and neither side minds.
  return { files, sums, capabilities };
}

// ── Installing ──────────────────────────────────────────────────────────────

function safeJoin(root, name) {
  const target = resolve(root, name);
  const fromRoot = relative(root, target);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new ReleaseError(`Archive entry escapes its folder: ${name}`);
  return target;
}

/** Every file under a directory, as POSIX-relative paths. */
async function listTree(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listTree(resolve(directory, entry.name), child));
    else out.push(child);
  }
  return out.sort();
}

/** A rename Windows can refuse for a moment while a scanner or watcher holds the target: a few short retries. */
async function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if ((error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY') || attempt === 5) throw error;
      await new Promise((settle) => setTimeout(settle, 20 * attempt));
    }
  }
}

/**
 * Write the asset's files beside the destination, hold the written tree to
 * the archive's own manifest, and only then swap it in. The verification so
 * far was of bytes in memory; this is the same question asked of the bytes on
 * disk, which is what the parity test actually runs. The previous install is
 * kept beside the destination until the new one is in place, so a failed swap
 * leaves the old CLI rather than nothing.
 */
export async function installAsset(files, sums, destination) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staged = await mkdtemp(resolve(parent, '.oaiy-cli-'));
  const previous = `${destination}.previous`;
  try {
    for (const [name, bytes] of files) {
      const target = safeJoin(staged, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const written = await listTree(staged);
    const expected = [...sums.keys(), SUMS_FILE].sort();
    if (written.join('\n') !== expected.join('\n')) {
      const missing = expected.filter((name) => !written.includes(name));
      const extra = written.filter((name) => !expected.includes(name));
      throw new ReleaseError(`The installed CLI is not the asset's file list (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}).`);
    }
    for (const [name, digest] of sums) {
      if (sha256(await readFile(safeJoin(staged, name))) !== digest) throw new ReleaseError(`${name} did not survive installation intact.`);
    }
    await rm(previous, { recursive: true, force: true });
    if (existsSync(destination)) await renameRetrying(destination, previous);
    try { await renameRetrying(staged, destination); }
    catch (error) {
      if (existsSync(previous) && !existsSync(destination)) await renameRetrying(previous, destination);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    return written.length;
  } finally {
    if (existsSync(staged)) await rm(staged, { recursive: true, force: true });
  }
}

// ── The whole run ───────────────────────────────────────────────────────────

/**
 * Resolve (or take the frozen release), download, verify every rung, install
 * and record. Returns the record written to
 * .runtime-source/oaiy-cli/current.json, which names the engine the CLI
 * carries — the figure the parity test compares against this tree's own
 * installed ZIPP.
 */
export async function fetchOaiyCli({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  tag = process.env.OAIY_CLI_RELEASE || null,
  dest = process.env.OAIY_CLI_DEST || null,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  frozen = process.env.OAIY_CLI_FROZEN || null,
  oaiyRepo = process.env.OAIY_REPO || null,
  verifyRun = false,
  inCi = Boolean(process.env.CI),
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const paths = defaultPaths(root, { dest });
  const frozenRecord = await loadFrozen(frozen, root, { inCi });
  // A run that froze a release and then packs from a checkout would install
  // neither what it froze nor anything the frozen record describes, and would
  // say nothing about the swap.
  if (oaiyRepo && frozenRecord) throw new ReleaseError(`OAIY_REPO packs the CLI from ${oaiyRepo} while the frozen release record for this run names ${frozenRecord.tag}; one run installs one CLI. Unset one of them.`);
  if (oaiyRepo) return packFromSource({ root, paths, oaiyRepo, inCi, log });
  if (frozenRecord && tag && tag !== frozenRecord.tag) throw new ReleaseError(`OAIY_CLI_RELEASE names ${tag} but the frozen release record for this run names ${frozenRecord.tag}; one run installs one release.`);

  const resolved = await resolveRelease({ tag: frozenRecord ? frozenRecord.tag : tag, token, fetchImpl });
  if (frozenRecord) {
    // The frozen asset, and only it: a release whose asset was replaced or
    // renamed since the run resolved it is not the release this run tests.
    const wanted = resolved.assets.find((a) => (frozenRecord.assetId != null && a.id != null ? a.id === frozenRecord.assetId : a.name === frozenRecord.assetName));
    if (!wanted || wanted.name !== frozenRecord.assetName) throw new ReleaseError(`OAIY release ${resolved.tag} no longer carries the frozen asset ${frozenRecord.assetName}${frozenRecord.assetId != null ? ` (id ${frozenRecord.assetId})` : ''}; it carries ${resolved.assets.map((a) => a.name).join(', ') || 'nothing'}.`);
    resolved.asset = wanted;
    if (resolved.commit !== frozenRecord.tagCommit) throw new ReleaseError(`Tag ${resolved.tag} now points at ${resolved.commit.slice(0, 12)}; the frozen record says ${frozenRecord.tagCommit.slice(0, 12)}. The tag moved since this run resolved it.`);
  }
  const { sums, evidence: evidenceAsset } = releaseRecords(resolved);
  const assetName = resolved.asset.name;
  const tagCommit = resolved.commit;

  // Rung 2 first, and rung 3 before the three megabytes: both are a kilobyte
  // each and either can end the run, so the download is the last thing asked
  // for rather than the first.
  const sumsText = (await download(sums, null, token, fetchImpl)).toString('utf8');
  const assetSha256 = assetDigestFrom(sumsText, assetName, resolved.tag);
  if (frozenRecord && assetSha256 !== frozenRecord.assetSha256) throw new ReleaseError(`OAIY release ${resolved.tag} now publishes ${assetName} with digest ${assetSha256.slice(0, 12)}; the frozen record says ${frozenRecord.assetSha256.slice(0, 12)}. The asset was replaced since this run resolved it.`);
  if (frozenRecord && frozenRecord.evidenceAssetId != null && evidenceAsset.id != null && evidenceAsset.id !== frozenRecord.evidenceAssetId) {
    throw new ReleaseError(`OAIY release ${resolved.tag} now publishes a different ${EVIDENCE_ASSET} (id ${evidenceAsset.id}) from the one this run froze (id ${frozenRecord.evidenceAssetId}); the release's evidence was replaced mid-run.`);
  }
  let evidence;
  try { evidence = JSON.parse((await download(evidenceAsset, null, token, fetchImpl)).toString('utf8')); }
  catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError(`OAIY release ${resolved.tag}'s ${EVIDENCE_ASSET} is not JSON: ${error.message}`); }
  const attestation = verifyEvidence(evidence, { tag: resolved.tag, tagCommit, assetName, assetSha256 });
  if (verifyRun) {
    const run = await verifyAttestingRun({ runId: attestation.runId, tagCommit, token, fetchImpl });
    log(`the run that attested OAIY ${resolved.tag} (${attestation.runId}) concluded ${run.conclusion} at ${run.headSha.slice(0, 12)}`);
  }

  // Rung 1: the bytes against the digest the release publishes for them. A
  // cached download is reused only when it still hashes to that digest.
  const archiveFile = resolve(paths.cache, resolved.tag, assetName);
  let archive;
  if (existsSync(archiveFile) && sha256(await readFile(archiveFile)) === assetSha256) {
    archive = await readFile(archiveFile);
    log(`reusing ${relative(root, archiveFile)} (digest matches the release)`);
  } else {
    log(`downloading ${assetName} from OAIY release ${resolved.tag}`);
    archive = await download(resolved.asset, archiveFile, token, fetchImpl);
  }
  const downloaded = sha256(archive);
  if (downloaded !== assetSha256) throw new ReleaseError(`${assetName} downloaded as ${downloaded.slice(0, 12)}, but OAIY release ${resolved.tag} publishes ${assetSha256.slice(0, 12)}; the download is corrupt or is not the file the release page describes.`);

  const { files, sums: inner, capabilities } = await verifyAsset(archive, { paths, assetName, evidenceCli: evidence.cli });
  const count = await installAsset(files, inner, paths.install);
  const record = await recordInstall(paths, {
    source: 'release',
    tag: resolved.tag,
    tagCommit,
    asset: assetName,
    assetSha256,
    htmlUrl: resolved.htmlUrl,
    evidence: { revision: evidence.revision, ...attestation },
    capabilities,
    files: count,
    frozen: frozenRecord ? { tag: frozenRecord.tag, tagCommit: frozenRecord.tagCommit, assetId: frozenRecord.assetId ?? null, assetName: frozenRecord.assetName, assetSha256: frozenRecord.assetSha256, resolvedAt: frozenRecord.resolvedAt ?? null } : null,
  });
  log(`OAIY ${resolved.tag} (${tagCommit.slice(0, 12)}) installed: ${count} files in ${relativeInstall(paths)}; engine ${capabilities.engine.name} ${capabilities.engine.release} (${String(capabilities.engine.revision).slice(0, 12)}, ${capabilities.engine.variant}), protocols ${JSON.stringify(capabilities.protocols)}${frozenRecord ? ' (frozen for this run)' : ''}`);
  return record;
}

function relativeInstall(paths) {
  const from = relative(paths.root, paths.install);
  return !from || from.startsWith('..') || isAbsolute(from) ? paths.install : from.replace(/\\/g, '/');
}

async function recordInstall(paths, { source, tag, tagCommit, asset, assetSha256, htmlUrl = null, evidence = null, capabilities, files, frozen = null }) {
  const record = {
    formatVersion: 1,
    repository: RELEASE_REPOSITORY,
    source,
    tag,
    tagCommit,
    asset,
    assetSha256,
    htmlUrl,
    evidence,
    capabilities,
    // Where the parity test's OAIY_CLI points, as this tree names it: a path
    // relative to the repository when the install is inside it, so a record
    // committed to a log or read on another machine still means something.
    install: { dir: relativeInstall(paths), files },
    frozen,
    fetchedAt: new Date().toISOString(),
  };
  await mkdir(paths.cache, { recursive: true });
  await writeFile(currentRecordPath(paths), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * A developer's shortcut: pack the CLI staged in a local oaiy.com checkout
 * and install that, so a change can be tried against FormLogic before it is
 * released. The asset is built by oaiy.com's own packer — imported, not
 * reimplemented, so the local install has the release layout and passes the
 * same rungs 4 to 8 — and the record says `source: "local"`, which CI
 * refuses: bytes only one machine has are not something a build can
 * reproduce, and installing them would test an engine nobody published.
 *
 * The import is dynamic because oaiy.com is a sibling checkout, not a
 * dependency: a tree without it must still run every other path.
 */
async function packFromSource({ root, paths, oaiyRepo, inCi, log }) {
  if (inCi) throw new ReleaseError('OAIY_REPO packs the CLI from a local checkout; CI installs published releases only. Unset OAIY_REPO.');
  const repo = resolve(root, oaiyRepo);
  const packer = resolve(repo, 'scripts/pack-cli-asset.mjs');
  if (!existsSync(packer)) throw new ReleaseError(`OAIY_REPO=${oaiyRepo} has no scripts/pack-cli-asset.mjs; it is not an oaiy.com checkout.`);
  const { packCliAsset, CAPABILITIES_FILE: packedCapabilities, SUMS_FILE: packedSums } = await import(pathToFileURL(packer).href);
  // The packer names the two files it writes into the asset, and this fetcher
  // names the two it reads back out. They are the same two files, so a
  // checkout that has renamed one says so here rather than through a
  // manifest check that cannot explain itself.
  if (packedCapabilities !== CAPABILITIES_FILE || packedSums !== SUMS_FILE) {
    throw new ReleaseError(`${relative(root, packer) || packer} packs ${packedCapabilities} and ${packedSums}; this fetcher reads ${CAPABILITIES_FILE} and ${SUMS_FILE}. The checkout and this tree disagree about the asset's layout.`);
  }
  const staged = resolve(repo, 'desktop/src-tauri/resources/cli');
  if (!existsSync(resolve(staged, 'oaiy.mjs'))) throw new ReleaseError(`${relative(root, staged) || staged} holds no staged CLI; run OAIY's desktop/scripts/sync-cli.mjs in that checkout first.`);
  const out = resolve(paths.cache, 'local', 'oaiy-cli-local.tar.gz');
  await mkdir(dirname(out), { recursive: true });
  const packed = packCliAsset(staged, out);
  const archive = await readFile(out);
  const { files, sums, capabilities } = await verifyAsset(archive, { paths, assetName: packed.asset });
  const count = await installAsset(files, sums, paths.install);
  const record = await recordInstall(paths, { source: 'local', tag: `local:${relative(root, repo) || repo}`, tagCommit: null, asset: packed.asset, assetSha256: packed.sha256, capabilities, files: count });
  log(`OAIY CLI packed from ${relative(root, repo) || repo} and installed: ${count} files in ${relativeInstall(paths)}; engine ${capabilities.engine.name} ${capabilities.engine.release}. This install is local: CI refuses it.`);
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const at = args.indexOf(flag);
    if (at === -1) return null;
    const value = args[at + 1];
    if (!value || value.startsWith('--')) { console.error(`fetch-oaiy-cli: ${flag} needs a value`); process.exit(1); }
    return value;
  };
  const frozenArg = take('--frozen');
  const destArg = take('--dest');
  try {
    if (args.includes('--resolve-only')) await resolveOnly({ frozenPath: frozenArg || process.env.OAIY_CLI_FROZEN || DEFAULT_FROZEN_PATH });
    else await fetchOaiyCli({ frozen: frozenArg || process.env.OAIY_CLI_FROZEN || null, dest: destArg || process.env.OAIY_CLI_DEST || null, verifyRun: args.includes('--verify-run') });
  } catch (error) {
    if (error instanceof ReleaseError) { console.error(`fetch-oaiy-cli: ${error.message}`); process.exit(1); }
    throw error;
  }
}
