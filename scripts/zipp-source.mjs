#!/usr/bin/env node
// ZIPP source for FormLogic's server sandbox.
//
// The sandbox guest (formlogic/runtime/guest) takes zipp-vm by path from
// .runtime-source/zipp/src: the source of the ZIPP release the installed Softn
// release names (.runtime-source/softn-release/current.json `zipp`, whose
// revision Softn read from the BUILD-INFO of the SHA256SUMS-verified bundle).
// Nothing in this tree names a ZIPP release, so the server engine follows the
// browser engine with no FormLogic commit.
//
//   node scripts/zipp-source.mjs              fetch that source and verify it
//   node scripts/zipp-source.mjs --identity   print release=<tag> and revision=<commit> (for $GITHUB_OUTPUT)
//   node scripts/zipp-source.mjs --verify     verify a tree already in place (CI's actions/checkout) and stamp it
//   node scripts/zipp-source.mjs --seed-lock  write formlogic/runtime/guest/Cargo.lock from ZIPP's workspace lock
//
// Fetching clones the release tag, or, with ZIPP_SOURCE_DIR=<a zipp.org
// checkout>, extracts `git archive <revision>` from it (read-only, and by
// commit rather than tag). Either way the tree must be the recorded commit,
// ZIPP's workspace version must be the release's, and its manifests must have
// LF endings: git with core.autocrlf=true hands out CRLF text, and what that
// does to the guest's bytes is unknown, so every git call here forces it off.
//
// An extracted tree is proved once, by the commit its archive names; its stamp
// then keeps a digest of every file, so a tree edited, added to or pruned since
// is fetched again rather than built as the release. A checkout is proved by
// git every time, untracked files included (cargo compiles a build.rs or a
// module whether git tracks it or not).
//
// The guest's lock is generated, not committed: a committed lock cannot stay
// --locked across ZIPP versions. It is seeded from ZIPP's workspace lock, the
// root Cargo.lock ZIPP's release CI builds its CLI with (--locked). That is not
// the browser engine's lock: crates/zipp-wasm keeps its own, so a third-party
// crate can sit at another compatible version there (v0.0.18: num-integer and
// tinyvec), and only the parity corpus would see a difference. It cannot seed
// the guest's: it locks no serde_json (nor serde, itoa, zmij), which the guest
// needs for its NDJSON, so the rule below would refuse it. `cargo update
// --workspace` adds only the guest; a shared package changing version, or any
// package ZIPP does not lock, fails, so a guest-only dependency cannot slip in
// unreviewed.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zippReleaseIdentity } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

export const ZIPP_REPOSITORY = 'https://github.com/f2i-com/zipp.org';
export const GUEST_PACKAGE = 'formlogic-runtime-guest';
/** The ZIPP lock the guest's is seeded from, recorded with its digest: the workspace (CLI) lock, not crates/zipp-wasm's. */
export const ZIPP_LOCK = 'Cargo.lock';
/** Text files whose line endings prove the tree was written without eol conversion (LF in ZIPP's repository). */
const LF_CANARIES = ['Cargo.toml', 'Cargo.lock', 'crates/zipp-vm/Cargo.toml'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function sourcePaths(root) {
  return {
    current: resolve(root, '.runtime-source/softn-release/current.json'),
    source: resolve(root, '.runtime-source/zipp/src'),
    stamp: resolve(root, '.runtime-source/zipp/source.json'),
    guest: resolve(root, 'formlogic/runtime/guest'),
  };
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { maxBuffer: 1 << 30, ...options });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${String(result.stderr ?? '').trim()}`);
  return result.stdout;
}

/** The ZIPP release the installed Softn release names. A Softn release before v0.0.15 names none (no release, a local build). */
export function installedZipp(root) {
  const { current } = sourcePaths(root);
  if (!existsSync(current)) throw new Error('No Softn release is installed (.runtime-source/softn-release/current.json is missing): run node scripts/fetch-softn-release.mjs first; the sandbox is built from the ZIPP release it names.');
  const release = JSON.parse(readFileSync(current, 'utf8'));
  let zipp;
  try { zipp = zippReleaseIdentity(release.zipp); }
  catch (error) { throw new Error(`The installed Softn release ${release.tag ?? '(untagged)'} names no ZIPP release to build the sandbox from; it needs Softn v0.0.15 or later. ${error.message}`); }
  if (zipp.repository !== undefined && zipp.repository !== ZIPP_REPOSITORY) throw new Error(`The installed Softn release names ZIPP from ${zipp.repository}; the sandbox is built only from ${ZIPP_REPOSITORY}.`);
  return zipp;
}

/** `[workspace.package] version` in ZIPP's root Cargo.toml, or null. */
export function workspaceVersion(text) {
  let inTable = false;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) { inTable = header[1].trim() === 'workspace.package'; continue; }
    const version = inTable && /^version\s*=\s*"([^"]+)"$/.exec(line);
    if (version) return version[1];
  }
  return null;
}

export const hasCrlf = (bytes) => Buffer.from(bytes).includes('\r\n');

/** The commit `git archive <commit>` records in its pax global header (what `git get-tar-commit-id` reads), or null. */
export function tarCommitId(tar) {
  if (tar.length < 1024 || tar[156] !== 0x67 /* typeflag 'g' */) return null;
  const size = parseInt(tar.subarray(124, 136).toString('latin1').replace(/\0[\s\S]*$/, '').trim(), 8);
  if (!Number.isFinite(size)) return null;
  const body = tar.subarray(512, 512 + size).toString('utf8');
  return /(?:^|\n)\d+ comment=([0-9a-f]{40,64})\n/.exec(body)?.[1] ?? null;
}

/**
 * One digest over every file under `dir` (its path and its content, or a
 * link's target), .git aside: what an extracted tree's stamp pins it to.
 */
export function treeDigest(dir) {
  const lines = [];
  const walk = (prefix) => {
    for (const entry of readdirSync(resolve(dir, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === '.git') continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink()) lines.push(`${path}\0link ${readlinkSync(resolve(dir, path))}\n`);
      else lines.push(`${path}\0${entry.isFile() ? sha256(readFileSync(resolve(dir, path))) : 'special'}\n`);
    }
  };
  walk('');
  return sha256(lines.sort().join(''));
}

/**
 * Proves .runtime-source/zipp/src is ZIPP `identity`, and returns the stamp
 * that says so. A git checkout's HEAD must be the recorded revision (a tag
 * that moved fails here) with no file changed or added; an extracted archive
 * is the `commit` its embedded header named, or, once extracted, is still the
 * tree its stamp's digest records. The workspace version must be the
 * release's, and the manifests LF.
 */
export function verifySource(root, identity, { commit = null } = {}) {
  const { source, stamp } = sourcePaths(root);
  const where = relative(root, source).replace(/\\/g, '/');
  if (!existsSync(resolve(source, 'Cargo.toml')) || !existsSync(resolve(source, 'crates/zipp-vm/Cargo.toml'))) {
    throw new Error(`${where} holds no ZIPP source: run node scripts/zipp-source.mjs (or scripts/build-runtime.sh zipp-source).`);
  }
  const checkout = existsSync(resolve(source, '.git'));
  let recorded = null;
  if (checkout) {
    const head = git(['-C', source, '-c', 'core.autocrlf=false', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== identity.revision) throw new Error(`${where} is ZIPP commit ${head}; the installed Softn release names ZIPP ${identity.release} at ${identity.revision}. The tag moved, or the checkout is stale: fetch it again.`);
    const changed = git(['-C', source, '-c', 'core.autocrlf=false', 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
    if (changed) throw new Error(`${where} has changed or extra files, so it is not ZIPP ${identity.release} as released:\n${changed}`);
  } else if (commit) {
    if (commit !== identity.revision) throw new Error(`The ZIPP archive is commit ${commit}; the installed Softn release names ZIPP ${identity.release} at ${identity.revision}.`);
  } else {
    recorded = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : null;
    if (recorded?.revision !== identity.revision || recorded?.release !== identity.release) {
      throw new Error(`${where} was extracted for ZIPP ${recorded?.release ?? '(unrecorded)'} at ${recorded?.revision ?? '(unrecorded)'}; the installed Softn release names ${identity.release} at ${identity.revision}: fetch it again.`);
    }
  }
  const version = workspaceVersion(readFileSync(resolve(source, 'Cargo.toml'), 'utf8'));
  if (version !== identity.version) throw new Error(`ZIPP's workspace version in ${where}/Cargo.toml is ${version ?? '(none)'}; ZIPP ${identity.release} is version ${identity.version}.`);
  for (const name of LF_CANARIES) {
    const file = resolve(source, name);
    if (existsSync(file) && hasCrlf(readFileSync(file))) throw new Error(`${where}/${name} has CRLF line endings: the source was written with git eol conversion (core.autocrlf) on, so it is not ZIPP's bytes. Fetch it again with node scripts/zipp-source.mjs.`);
  }
  const lock = resolve(source, ZIPP_LOCK);
  if (!existsSync(lock)) throw new Error(`${where} has no ${ZIPP_LOCK}; the guest's lock is seeded from ZIPP's.`);
  const cargoLockSha256 = sha256(readFileSync(lock));
  const treeSha256 = checkout ? null : treeDigest(source);
  if (recorded && recorded.treeSha256 !== treeSha256) {
    throw new Error(`${where} is not the tree extracted for ZIPP ${identity.release}: a file was edited, added or removed since. Fetch it again (node scripts/zipp-source.mjs).`);
  }
  return { repository: ZIPP_REPOSITORY, release: identity.release, version: identity.version, revision: identity.revision, cargoLock: ZIPP_LOCK, cargoLockSha256, ...(treeSha256 && { treeSha256 }) };
}

function writeStamp(root, verified) {
  const { stamp } = sourcePaths(root);
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, JSON.stringify(verified, null, 2) + '\n');
}

/**
 * Puts ZIPP `identity`'s source at .runtime-source/zipp/src, unless it is
 * already there. `sourceDir` (ZIPP_SOURCE_DIR) extracts from a local zipp.org
 * checkout; otherwise the release tag is cloned from GitHub.
 */
export function fetchSource(root, identity, { sourceDir = process.env.ZIPP_SOURCE_DIR || null, repository = ZIPP_REPOSITORY, log = console.log } = {}) {
  const { source, stamp } = sourcePaths(root);
  if (existsSync(stamp) && existsSync(source)) {
    try {
      const verified = verifySource(root, identity);
      log(`ZIPP ${identity.release} source already at ${relative(root, source).replace(/\\/g, '/')}`);
      return verified;
    } catch { /* not this release, or damaged: fetch it again */ }
  }
  rmSync(source, { recursive: true, force: true });
  rmSync(stamp, { force: true });
  mkdirSync(source, { recursive: true });
  let commit = null;
  if (sourceDir) {
    log(`ZIPP ${identity.release}: extracting ${identity.revision.slice(0, 12)} from ${sourceDir}`);
    const tar = git(['-C', resolve(sourceDir), '-c', 'core.autocrlf=false', 'archive', '--format=tar', identity.revision]);
    commit = tarCommitId(tar);
    if (commit === null) throw new Error(`git archive in ${sourceDir} produced no commit header; cannot prove which commit it is.`);
    // Extract in place rather than name the directory: Git for Windows' tar misreads C:\ paths.
    const extracted = spawnSync('tar', ['-x', '-f', '-'], { cwd: source, input: tar, maxBuffer: 1 << 26 });
    if (extracted.error || extracted.status !== 0) throw new Error(`tar could not extract the ZIPP archive: ${extracted.error?.message ?? String(extracted.stderr).trim()}`);
  } else {
    log(`ZIPP ${identity.release}: cloning ${repository} at ${identity.release}`);
    git(['-c', 'core.autocrlf=false', 'clone', '--quiet', '--depth', '1', '--branch', identity.release, repository, source], { stdio: ['ignore', 'ignore', 'pipe'] });
    git(['-C', source, 'config', 'core.autocrlf', 'false']);
  }
  const verified = verifySource(root, identity, { commit });
  writeStamp(root, verified);
  return verified;
}

/** `[[package]]` entries of a Cargo.lock, keyed "name version". */
export function parseLock(text) {
  const packages = new Map();
  for (const block of text.replace(/\r\n/g, '\n').split(/^\[\[package\]\]\n/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(block)?.[1] ?? null;
    const entry = { name: field('name'), version: field('version'), source: field('source'), checksum: field('checksum') };
    if (entry.name && entry.version) packages.set(`${entry.name} ${entry.version}`, entry);
  }
  return packages;
}

/** Why a generated guest lock is not ZIPP's lock plus the guest itself; empty when it is. */
export function compareLocks(zippText, guestText) {
  const zipp = parseLock(zippText);
  const guest = parseLock(guestText);
  const problems = [];
  if (![...guest.values()].some((entry) => entry.name === GUEST_PACKAGE)) problems.push(`it does not lock ${GUEST_PACKAGE} itself`);
  for (const [key, entry] of guest) {
    if (entry.name === GUEST_PACKAGE) continue;
    const locked = zipp.get(key);
    if (!locked) {
      const other = [...zipp.values()].filter((candidate) => candidate.name === entry.name).map((candidate) => candidate.version);
      problems.push(other.length ? `it moves ${entry.name} to ${entry.version} (ZIPP locks ${other.join(', ')})` : `it adds ${entry.name} ${entry.version}, which ZIPP does not lock`);
    } else if (locked.source !== entry.source || locked.checksum !== entry.checksum) {
      problems.push(`it takes ${entry.name} ${entry.version} from ${entry.source ?? 'a path'} (${entry.checksum ?? 'no checksum'}); ZIPP locks ${locked.source ?? 'a path'} (${locked.checksum ?? 'no checksum'})`);
    }
  }
  return problems;
}

function cargoUpdateWorkspace(guestDir) {
  const result = spawnSync('cargo', ['update', '--workspace'], { cwd: guestDir, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`cargo update --workspace in formlogic/runtime/guest failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`);
}

/**
 * Writes formlogic/runtime/guest/Cargo.lock from ZIPP's workspace lock: copy, then
 * `cargo update --workspace` (which adds the guest and prunes what it does not
 * use), then refuse anything else it changed.
 */
export function seedLock(root, identity, { cargoUpdate = cargoUpdateWorkspace } = {}) {
  const verified = verifySource(root, identity);
  const { source, guest } = sourcePaths(root);
  const zippLock = readFileSync(resolve(source, ZIPP_LOCK), 'utf8');
  const lockFile = resolve(guest, 'Cargo.lock');
  writeFileSync(lockFile, zippLock);
  cargoUpdate(guest);
  const generated = readFileSync(lockFile, 'utf8');
  const problems = compareLocks(zippLock, generated);
  if (problems.length) {
    throw new Error(`The guest's generated Cargo.lock is not ZIPP ${identity.release}'s lock plus the guest: ${problems.join('; ')}. A dependency ZIPP's release did not build that way must be reviewed, not resolved here.`);
  }
  return { zipp: verified, cargoLockSha256: sha256(generated), packages: parseLock(generated).size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const identity = installedZipp(root);
    if (args.includes('--identity')) {
      console.log(`release=${identity.release}\nrevision=${identity.revision}`);
    } else if (args.includes('--seed-lock')) {
      const seeded = seedLock(root, identity);
      console.log(`formlogic/runtime/guest/Cargo.lock: ZIPP ${identity.release}'s lock plus the guest (${seeded.packages} packages, ${seeded.cargoLockSha256.slice(0, 12)})`);
    } else if (args.includes('--verify')) {
      const verified = verifySource(root, identity);
      writeStamp(root, verified);
      console.log(`ZIPP ${identity.release} source verified: ${identity.revision}`);
    } else {
      fetchSource(root, identity);
      console.log(`ZIPP ${identity.release} source verified: ${identity.revision}`);
    }
  } catch (error) {
    console.error(`zipp-source: ${error.message}`);
    process.exit(1);
  }
}
