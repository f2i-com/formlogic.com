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

const HEX64 = /^[0-9a-f]{64}$/;
/** JSON values compared without regard to key order. */
export const canonical = value => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

/**
 * The ZIPP record a Softn release carries (softn-release.json `zipp`, and the
 * zipp/SOURCE.json it installs as formlogic/ui/vendor/zipp-wasm/SOURCE.json):
 * an engine Softn took from a ZIPP release and verified against that
 * release's SHA256SUMS. A local build, or a record without the release it
 * came from, is refused. Returns a copy of the whole record.
 */
export function zippReleaseIdentity(source) {
  if (!source || typeof source !== 'object') throw new Error('The ZIPP record is missing.');
  const problems = [];
  if (typeof source.version !== 'string' || !HEX64.test(source.sha256 ?? '')) problems.push('no version and SHA-256');
  if (!/^v\d+\.\d+\.\d+$/.test(source.release ?? '')) problems.push(`release ${source.release ?? '(none)'} is not a vX.Y.Z tag`);
  else if (source.release.slice(1) !== source.version) problems.push(`release ${source.release} is not version ${source.version}`);
  if (!/^[0-9a-f]{40}$/.test(source.revision ?? '')) problems.push('revision is not a 40-hex commit');
  if (source.build !== 'release') problems.push(`build is ${source.build ?? '(unrecorded)'}, not release`);
  if (typeof source.bundle !== 'string' || !/^[^/\\]+$/.test(source.bundle)) problems.push('no bundle file name');
  for (const key of ['bundleSha256', 'sumsSha256', 'glueSha256']) if (!HEX64.test(source[key] ?? '')) problems.push(`${key} is not a SHA-256`);
  if (problems.length) throw new Error(`The ZIPP record is not an engine taken from a ZIPP release: ${problems.join('; ')}.`);
  return JSON.parse(JSON.stringify(source));
}

/** Exports only the ZIPP engine module has (probed on the web and web-python releases, a local build, the WASI guest and gpu-lab's kernels). */
export const ZIPP_ENGINE_EXPORTS = Object.freeze(['zippProfile', 'zipp_start', 'engine_evalInContext']);

/**
 * Whether bytes are a ZIPP engine module, by its exports rather than its file
 * name: the export section is read without compiling, so an engine copy under
 * any name (a hashed Vite asset, a renamed file) is found.
 */
export function isZippEngineWasm(bytes) {
  if (!bytes || bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return false;
  if (bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) return false;
  let offset = 8;
  const leb = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (offset >= bytes.length) throw new RangeError('truncated');
      const byte = bytes[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new RangeError('overlong');
  };
  try {
    while (offset < bytes.length) {
      const id = bytes[offset++];
      const end = leb() + offset;
      if (end > bytes.length) return false;
      if (id !== 7) { offset = end; continue; }
      const names = new Set();
      for (let count = leb(); count > 0; count--) {
        const length = leb();
        if (offset + length > end) return false;
        names.add(Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString('utf8'));
        offset += length + 1; // the name, then the export kind
        leb(); // the index
      }
      return ZIPP_ENGINE_EXPORTS.every(name => names.has(name));
    }
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
  return false;
}

/**
 * The files ZIPP's web bundle and Softn's installer must both have supplied:
 * tsc needs the .d.ts beside the glue, and scripts/package-dist.mjs ships
 * LICENSE-APACHE, so a tree without it fails here rather than at packaging.
 */
export const ZIPP_TREE_REQUIRED = Object.freeze(['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'LICENSE-APACHE', 'SOURCE.json', 'SHA256SUMS', 'BUILD-INFO.txt', 'RELEASE-SHA256SUMS']);

/** `<sha256>  <file>` lines, as sha256sum writes them. */
function parseSums(text, name) {
  const sums = new Map();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (!match) throw new Error(`${name} has a line that is not "<sha256>  <file>".`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * A ZIPP engine tree as Softn ships it (the archive's zipp/, installed as
 * formlogic/ui/vendor/zipp-wasm): `source` is a directory or a Map of
 * tree-relative path to bytes. Proves the tree is one ZIPP release, internally
 * consistent: every shipped file ZIPP built is the one the bundle's own
 * SHA256SUMS lists (never the reverse: the bundle also carries gpu-lab/,
 * host-sdk/, docs/ and a README Softn does not ship), BUILD-INFO names the
 * recorded commit, build and toolchain, RELEASE-SHA256SUMS is the recorded ZIPP
 * release sums and lists the recorded bundle, and SOURCE.json carries every
 * field of `identity` (the release's record) unchanged. Whether that release is
 * authentic is Softn's check against ZIPP: FormLogic never fetches ZIPP's
 * release assets. (The server sandbox is built from ZIPP's source at the
 * recorded commit, which scripts/zipp-source.mjs proves; see there.)
 * Returns the tree's SOURCE.json.
 */
export async function checkZippTree(source, identity) {
  const files = new Map();
  if (typeof source === 'string') {
    for (const path of await artifactFiles(source, { includeManifest: true })) files.set(path, await readFile(resolve(source, path)));
  } else {
    for (const [path, value] of source) files.set(path, Buffer.isBuffer(value) ? value : value.data);
  }
  const missing = ZIPP_TREE_REQUIRED.filter(name => !files.has(name));
  if (missing.length) throw new Error(`The ZIPP engine tree is missing ${missing.join(', ')}.`);
  const text = name => files.get(name).toString('utf8');
  let record;
  try { record = JSON.parse(text('SOURCE.json')); }
  catch (error) { throw new Error(`The ZIPP engine tree's SOURCE.json is not JSON: ${error.message}`); }
  record = zippReleaseIdentity(record);
  for (const [key, value] of Object.entries(identity ?? {})) {
    if (canonical(record[key]) !== canonical(value)) throw new Error(`The ZIPP engine tree's SOURCE.json ${key} is ${canonical(record[key]) ?? '(absent)'}; the release records ${canonical(value)}.`);
  }

  const inner = parseSums(text('SHA256SUMS'), 'SHA256SUMS');
  const notices = record.notices;
  if (!notices || typeof notices.file !== 'string' || !/^[^/\\]+$/.test(notices.file) || !HEX64.test(notices.sha256 ?? '') || !['zipp-release', 'softn-curated'].includes(notices.source)) {
    throw new Error('The ZIPP engine tree\'s SOURCE.json records no third-party notices (file, source zipp-release or softn-curated, sha256).');
  }
  // Curated notices are exempt from the bundle's sums, so they may not stand in for a file the bundle or Softn's record defines.
  if (ZIPP_TREE_REQUIRED.includes(notices.file) || (notices.source === 'softn-curated' && inner.has(notices.file))) {
    throw new Error(`The ZIPP engine tree's SOURCE.json names ${notices.file} as its ${notices.source} notices; that is a file of the ZIPP bundle or of Softn's record, not a notices file.`);
  }
  if (!files.has(notices.file) || digest(files.get(notices.file)) !== notices.sha256) throw new Error(`The ZIPP engine tree's ${notices.file} is missing or differs from SOURCE.json notices.`);

  // Shipped file -> the bundle's sums. Only Softn's own additions are exempt.
  const exempt = new Set(['SOURCE.json', 'SHA256SUMS', 'RELEASE-SHA256SUMS']);
  if (notices.source === 'softn-curated') exempt.add(notices.file);
  for (const [path, bytes] of files) {
    if (exempt.has(path)) continue;
    if (!inner.has(path)) throw new Error(`The ZIPP engine tree ships ${path}, which ZIPP ${record.release}'s bundle SHA256SUMS does not list.`);
    if (digest(bytes) !== inner.get(path)) throw new Error(`The ZIPP engine tree's ${path} differs from ZIPP ${record.release}'s bundle SHA256SUMS.`);
  }

  const buildInfo = new Map(text('BUILD-INFO.txt').replace(/\r\n/g, '\n').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  let languages = null;
  try { languages = JSON.parse(buildInfo.get('languages') ?? 'null'); } catch { /* compared below */ }
  const built = [
    ['commit', buildInfo.get('commit'), record.revision, 'revision'],
    ['version', buildInfo.get('version'), record.version, 'version'],
    ['variant', buildInfo.get('variant'), record.variant, 'variant'],
    ['languages', languages, record.languages, 'languages'],
    ['stack-bytes', buildInfo.has('stack-bytes') ? Number(buildInfo.get('stack-bytes')) : undefined, record.stackBytes, 'stackBytes'],
    // scripts/build-runtime.sh builds the server sandbox with the toolchain this record names.
    ['rustc', buildInfo.get('rustc'), record.rustc, 'rustc'],
  ];
  for (const [key, actual, expected, field] of built) {
    if (actual === undefined || canonical(actual) !== canonical(expected)) throw new Error(`The ZIPP engine tree's BUILD-INFO.txt ${key} is ${canonical(actual) ?? '(absent)'}; SOURCE.json ${field} is ${canonical(expected) ?? '(absent)'}.`);
  }

  const releaseSums = files.get('RELEASE-SHA256SUMS');
  if (digest(releaseSums) !== record.sumsSha256) throw new Error(`The ZIPP engine tree's RELEASE-SHA256SUMS is not the ZIPP ${record.release} SHA256SUMS SOURCE.json records (${record.sumsSha256.slice(0, 12)}).`);
  if (parseSums(releaseSums.toString('utf8'), 'RELEASE-SHA256SUMS').get(record.bundle) !== record.bundleSha256) throw new Error(`ZIPP ${record.release}'s SHA256SUMS does not list ${record.bundle} with the digest SOURCE.json records.`);
  if (digest(files.get('zipp_wasm_bg.wasm')) !== record.sha256) throw new Error('The ZIPP engine tree\'s zipp_wasm_bg.wasm differs from SOURCE.json sha256.');
  if (digest(files.get('zipp_wasm.js')) !== record.glueSha256) throw new Error('The ZIPP engine tree\'s zipp_wasm.js differs from SOURCE.json glueSha256.');
  return record;
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
