import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

const manifestName = 'runtime-manifest.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** The `code` of the link refusal, so a caller can recognise that refusal without catching every error. */
export const LINKED_ASSET = 'ERR_RUNTIME_ASSET_LINK';

export function runtimeIdentity(source) {
  if (!source || typeof source.version !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256 ?? '')) {
    throw new Error('The engine SOURCE.json does not contain a version and SHA-256.');
  }
  return { version: source.version, sha256: source.sha256 };
}

export function assertMatchingRuntime(actual, expected) {
  if (actual?.version !== expected.version || actual?.sha256 !== expected.sha256) {
    throw new Error('The hosted runtime and FormLogic engine versions do not match.');
  }
}

/**
 * Every file under a generated tree, sorted, as forward-slash paths, the root
 * runtime-manifest.json only when asked for; links are refused.
 * scripts/fetch-softn-release.mjs inventories a generation with it too, so the
 * manifest check and the inventory cannot disagree about what a tree holds.
 */
export async function artifactFiles(directory, { includeManifest = false } = {}) {
  const files = [];
  const walk = async prefix => {
    for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw Object.assign(new Error(`Generated runtime assets must not contain links: ${path}`), { code: LINKED_ASSET });
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (includeManifest || path !== manifestName)) files.push(path);
    }
  };
  await walk('');
  return files.sort();
}

/**
 * scripts/fetch-softn-release.mjs keeps .runtime-source/softn-release/promotion.json
 * while it swaps the trees and while an interrupted swap is unresolved; the
 * trees may then be two releases with the same engine, each passing its own
 * manifest check. The prebuild checks refuse to build from them. A tree built
 * from a Softn source checkout has no journal, so this passes.
 */
export function assertNoInterruptedPromotion(repositoryRoot) {
  if (existsSync(resolve(repositoryRoot, '.runtime-source/softn-release/promotion.json'))) {
    throw new Error('A Softn runtime install is unfinished (.runtime-source/softn-release/promotion.json exists): the hosted runtime and the editors may be a mixture of two releases. Run node scripts/fetch-softn-release.mjs from the repository root to resolve it.');
  }
}

export async function writeRuntimeManifest(directory, zipp) {
  const paths = await artifactFiles(directory);
  if (!paths.includes('index.html')) throw new Error('The hosted runtime index is missing.');
  const files = {};
  for (const path of paths) files[path] = digest(await readFile(resolve(directory, path)));
  await writeFile(resolve(directory, manifestName), JSON.stringify({ formatVersion: 1, zipp: runtimeIdentity(zipp), files }, null, 2) + '\n');
}

export async function checkRuntimeArtifact(directory, expected) {
  const manifest = JSON.parse(await readFile(resolve(directory, manifestName), 'utf8'));
  if (manifest.formatVersion !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('The hosted runtime manifest is invalid.');
  }
  assertMatchingRuntime(manifest.zipp, expected);
  const paths = Object.keys(manifest.files).sort();
  if (!paths.includes('index.html')) throw new Error('The hosted runtime index is missing from its manifest.');
  if (JSON.stringify(paths) !== JSON.stringify(await artifactFiles(directory))) {
    throw new Error('The hosted runtime has missing or stale files.');
  }
  const root = resolve(directory);
  for (const path of paths) {
    const target = resolve(root, path);
    const fromRoot = relative(root, target);
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
      throw new Error('The hosted runtime manifest contains an invalid path.');
    }
    if (digest(await readFile(target)) !== manifest.files[path]) throw new Error(`The hosted runtime asset has changed: ${path}`);
  }
  return manifest;
}

/** Promote a verified sibling staging directory; Windows watchers can lock rename. */
export async function installRuntimeArtifact(staged, output, expected, move = rename) {
  if (dirname(resolve(staged)) !== dirname(resolve(output)) || resolve(staged) === resolve(output)) {
    throw new Error('The runtime staging and output directories must be distinct siblings.');
  }
  await checkRuntimeArtifact(staged, expected);
  try {
    await move(staged, output);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    // Copy only the already-validated generated tree. Verify every file after
    // copying so a locked, incomplete or stale destination cannot pass prebuild.
    await cp(staged, output, { recursive: true });
  }
  await checkRuntimeArtifact(output, expected);
}
