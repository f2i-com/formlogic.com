import { createHash } from 'node:crypto';
import { cp, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

const manifestName = 'runtime-manifest.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

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

async function artifactFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Generated runtime assets must not contain links: ${path}`);
    if (entry.isDirectory()) files.push(...await artifactFiles(directory, path));
    else if (entry.isFile() && path !== manifestName) files.push(path);
  }
  return files.sort();
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
