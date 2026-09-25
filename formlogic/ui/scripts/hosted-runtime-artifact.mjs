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
 * Exports only ZIPP's torch package module has (probed on ZIPP v0.0.21's web-torch bundle): the
 * packed Python package it hands the engine, and the kernel entry the engine calls back into.
 */
export const ZIPP_TORCH_EXPORTS = Object.freeze(['zipp_package_ptr', 'zipp_package_len', 'zipp_kernel']);

/**
 * Whether bytes are a ZIPP engine module, by its exports rather than its file
 * name: the export section is read without compiling, so an engine copy under
 * any name (a hashed Vite asset, a renamed file) is found.
 */
export function isZippEngineWasm(bytes) {
  const names = wasmExportNames(bytes);
  return Boolean(names) && ZIPP_ENGINE_EXPORTS.every(name => names.has(name));
}

/** Whether bytes are ZIPP's torch package module, by its exports as isZippEngineWasm reads them. */
export function isZippTorchWasm(bytes) {
  const names = wasmExportNames(bytes);
  return Boolean(names) && ZIPP_TORCH_EXPORTS.every(name => names.has(name)) && !ZIPP_ENGINE_EXPORTS.some(name => names.has(name));
}

/** A wasm module's export names from its export section, read without compiling; null for bytes that are not one. */
function wasmExportNames(bytes) {
  if (!bytes || bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  if (bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) return null;
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
      if (end > bytes.length) return null;
      if (id !== 7) { offset = end; continue; }
      const names = new Set();
      for (let count = leb(); count > 0; count--) {
        const length = leb();
        if (offset + length > end) return null;
        names.add(Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString('utf8'));
        offset += length + 1; // the name, then the export kind
        leb(); // the index
      }
      return names;
    }
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return new Set();
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

/** The files Softn ships for the web variant: the engine and its declarations, no glue (it runs under the primary's). */
export const ZIPP_VARIANT_TREE_REQUIRED = Object.freeze(['zipp_wasm_bg.wasm', 'BUILD-INFO.txt', 'PROFILE.json', 'SHA256SUMS', 'SOURCE.json']);
/** The keys Softn records for a variant, in softn-release.json `zipp.variants.<name>` and in zipp/SOURCE.json. */
export const ZIPP_VARIANT_KEYS = Object.freeze(['bundle', 'bundleSha256', 'sha256', 'glueSha256', 'variant', 'languages', 'stackBytes', 'commit']);

/**
 * The record of a ZIPP release VARIANT a Softn release carries (softn-release.json
 * `zipp.variants.web`): the same release's other bundle, with its own engine and glue digests,
 * its build's variant name, languages and stack size, and the commit it was built from. Returns
 * a copy; a malformed record is refused rather than guessed at.
 */
export function zippVariantIdentity(variant, name = 'web') {
  if (!variant || typeof variant !== 'object' || Array.isArray(variant)) throw new Error(`The ZIPP ${name} variant record is missing.`);
  const problems = [];
  if (typeof variant.bundle !== 'string' || !/^[^/\\]+$/.test(variant.bundle)) problems.push('no bundle file name');
  for (const key of ['bundleSha256', 'sha256', 'glueSha256']) if (!HEX64.test(variant[key] ?? '')) problems.push(`${key} is not a SHA-256`);
  if (typeof variant.variant !== 'string' || !variant.variant) problems.push('no variant name');
  if (!Array.isArray(variant.languages) || !variant.languages.length || !variant.languages.every(language => typeof language === 'string' && language)) problems.push('languages is not a list of names');
  if (!Number.isInteger(variant.stackBytes) || variant.stackBytes <= 0) problems.push('stackBytes is not a positive integer');
  if (!/^[0-9a-f]{40}$/.test(variant.commit ?? '')) problems.push('commit is not a 40-hex commit');
  if (problems.length) throw new Error(`The ZIPP ${name} variant record is not a variant of a ZIPP release: ${problems.join('; ')}.`);
  return JSON.parse(JSON.stringify(variant));
}

/**
 * The web variant tree as Softn ships it (the archive's top-level zipp-web/, installed as
 * formlogic/ui/vendor/zipp-wasm-web): ZIPP's JavaScript-only build of the SAME release as the
 * primary engine, served to apps as `zipp-web`. `source` is a directory or a Map of path to
 * bytes, `variant` the release's `zipp.variants.web` record, `primary` the release's `zipp`
 * record (or the primary tree's whole SOURCE.json).
 *
 * What is proved is provenance, since the variant changes size and not containment: exactly the
 * five files Softn ships and no glue (the variant runs under the primary's zipp_wasm.js — a glue
 * here would be a second engine loader nobody checks); every shipped file is the one the web
 * bundle's own SHA256SUMS lists (never the reverse: that bundle also carries the glue, its
 * declarations, a licence and the host SDK, which Softn does not ship in this tree); the variant's
 * SOURCE.json carries the record's every key, names the primary it is a variant OF by bundle,
 * engine and glue digest, and is the same release — version, tag, revision, release sums, build
 * and toolchain — as the primary; BUILD-INFO says what SOURCE.json says; the record was built
 * from the release's own commit; the web bundle's sums list the recorded glue; and, when the
 * caller has them (`releaseSums`, the primary tree's RELEASE-SHA256SUMS — the variant tree
 * carries none), they are the recorded ZIPP SHA256SUMS and list the web bundle with the recorded
 * digest. The engine bytes are the recorded digest, are a ZIPP engine module, and are NOT the
 * primary's: a variant is the same source built again, never the same bytes named twice (that
 * substitution, with both digests rewritten to match, would otherwise pass every check here).
 *
 * `zipp-web` is the JavaScript-only build by definition — the server clamps every app with
 * Python onto zipp-web-python on the strength of that — so the record must say variant
 * `javascript` with languages exactly `["javascript"]`. Returns the tree's SOURCE.json.
 */
export async function checkZippVariantTree(source, variant, primary, { releaseSums = null } = {}) {
  const files = new Map();
  if (typeof source === 'string') {
    for (const path of await artifactFiles(source, { includeManifest: true })) files.set(path, await readFile(resolve(source, path)));
  } else {
    for (const [path, value] of source) files.set(path, Buffer.isBuffer(value) ? value : value.data);
  }
  const missing = ZIPP_VARIANT_TREE_REQUIRED.filter(name => !files.has(name));
  if (missing.length) throw new Error(`The ZIPP web variant tree is missing ${missing.join(', ')}.`);
  variant = zippVariantIdentity(variant);
  const primaryRecord = zippReleaseIdentity(primary);
  if (variant.variant !== 'javascript' || canonical(variant.languages) !== canonical(['javascript'])) {
    throw new Error(`The ZIPP web variant record is variant ${canonical(variant.variant)} with languages ${canonical(variant.languages)}; zipp-web is the JavaScript-only build (variant "javascript", languages ["javascript"]).`);
  }
  if (variant.commit !== primaryRecord.revision) throw new Error(`The ZIPP web variant record was built from ${variant.commit.slice(0, 12)}; the release is ${primaryRecord.revision.slice(0, 12)}. A variant ships only from the release's own commit.`);
  if (variant.sha256 === primaryRecord.sha256) throw new Error('The ZIPP web variant record names the primary engine\'s own digest; a variant is the same source built again, not the same bytes named twice.');

  const text = name => files.get(name).toString('utf8');
  let record;
  try { record = JSON.parse(text('SOURCE.json')); }
  catch (error) { throw new Error(`The ZIPP web variant tree's SOURCE.json is not JSON: ${error.message}`); }
  if (!record || typeof record !== 'object') throw new Error('The ZIPP web variant tree\'s SOURCE.json is not a record.');
  for (const [key, value] of Object.entries(variant)) {
    if (canonical(record[key]) !== canonical(value)) throw new Error(`The ZIPP web variant tree's SOURCE.json ${key} is ${canonical(record[key]) ?? '(absent)'}; the release records ${canonical(value)}.`);
  }
  // The same release as the primary, field by field.
  const same = [['version', primaryRecord.version], ['release', primaryRecord.release], ['revision', primaryRecord.revision], ['sumsSha256', primaryRecord.sumsSha256], ['build', 'release'], ...(primaryRecord.rustc !== undefined ? [['rustc', primaryRecord.rustc]] : [])];
  for (const [key, value] of same) {
    if (canonical(record[key]) !== canonical(value)) throw new Error(`The ZIPP web variant tree's SOURCE.json ${key} is ${canonical(record[key]) ?? '(absent)'}; the release's is ${canonical(value)}.`);
  }
  const named = record.primary;
  if (!named || typeof named !== 'object' || named.bundle !== primaryRecord.bundle || named.sha256 !== primaryRecord.sha256 || named.glueSha256 !== primaryRecord.glueSha256) {
    throw new Error(`The ZIPP web variant tree's SOURCE.json primary is ${canonical(named) ?? '(absent)'}; the release's engine is ${primaryRecord.bundle} (${primaryRecord.sha256.slice(0, 12)}, glue ${primaryRecord.glueSha256.slice(0, 12)}).`);
  }

  // Shipped file -> the web bundle's sums; only Softn's own additions are exempt. No glue.
  const inner = parseSums(text('SHA256SUMS'), 'zipp-web/SHA256SUMS');
  const exempt = new Set(['SOURCE.json', 'SHA256SUMS']);
  for (const [path, bytes] of files) {
    if (exempt.has(path)) continue;
    if (path === 'zipp_wasm.js') throw new Error(`The ZIPP web variant tree ships zipp_wasm.js, which Softn does not ship for a variant: it runs under the primary's glue.`);
    if (!inner.has(path)) throw new Error(`The ZIPP web variant tree ships ${path}, which ZIPP ${record.release}'s web bundle SHA256SUMS does not list.`);
    if (digest(bytes) !== inner.get(path)) throw new Error(`The ZIPP web variant tree's ${path} differs from ZIPP ${record.release}'s web bundle SHA256SUMS.`);
  }
  if (inner.get('zipp_wasm.js') !== variant.glueSha256) throw new Error(`ZIPP ${record.release}'s web bundle SHA256SUMS lists zipp_wasm.js as ${inner.get('zipp_wasm.js')?.slice(0, 12) ?? '(absent)'}; the variant record says glueSha256 ${variant.glueSha256.slice(0, 12)}.`);

  const buildInfo = new Map(text('BUILD-INFO.txt').replace(/\r\n/g, '\n').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  let languages = null;
  try { languages = JSON.parse(buildInfo.get('languages') ?? 'null'); } catch { /* compared below */ }
  const built = [
    ['commit', buildInfo.get('commit'), record.revision, 'revision'],
    ['version', buildInfo.get('version'), record.version, 'version'],
    ['variant', buildInfo.get('variant'), record.variant, 'variant'],
    ['languages', languages, record.languages, 'languages'],
    ['stack-bytes', buildInfo.has('stack-bytes') ? Number(buildInfo.get('stack-bytes')) : undefined, record.stackBytes, 'stackBytes'],
    ['rustc', buildInfo.get('rustc'), record.rustc, 'rustc'],
  ];
  for (const [key, actual, expected, field] of built) {
    if (actual === undefined || canonical(actual) !== canonical(expected)) throw new Error(`The ZIPP web variant tree's BUILD-INFO.txt ${key} is ${canonical(actual) ?? '(absent)'}; SOURCE.json ${field} is ${canonical(expected) ?? '(absent)'}.`);
  }

  if (releaseSums) {
    const sums = parseSums(releaseSums.toString('utf8'), 'RELEASE-SHA256SUMS');
    if (digest(releaseSums) !== primaryRecord.sumsSha256) throw new Error(`RELEASE-SHA256SUMS is not the ZIPP ${primaryRecord.release} SHA256SUMS the release records (${primaryRecord.sumsSha256.slice(0, 12)}).`);
    if (sums.get(variant.bundle) !== variant.bundleSha256) throw new Error(`ZIPP ${primaryRecord.release}'s SHA256SUMS does not list ${variant.bundle} with the digest the variant record says.`);
  }

  const wasm = files.get('zipp_wasm_bg.wasm');
  if (digest(wasm) !== variant.sha256) throw new Error('The ZIPP web variant tree\'s zipp_wasm_bg.wasm differs from the recorded variant sha256.');
  if (!isZippEngineWasm(wasm)) throw new Error('The ZIPP web variant tree\'s zipp_wasm_bg.wasm is not a ZIPP engine module: its exports are not the engine\'s.');
  return record;
}

/** The files Softn ships for the torch package (the archive's zipp-torch/): the module, ZIPP's loader, and the records. */
export const ZIPP_TORCH_TREE_REQUIRED = Object.freeze(['zipp_torch.wasm', 'zipp_torch.js', 'BUILD-INFO.txt', 'SHA256SUMS', 'SOURCE.json']);
/** The keys Softn records for the torch package, in softn-release.json `zipp.packages.torch` and in zipp/SOURCE.json. */
export const ZIPP_TORCH_KEYS = Object.freeze(['bundle', 'bundleSha256', 'sha256', 'loaderSha256', 'variant', 'pairsWith', 'commit', 'engineAbi']);

/**
 * The torch package record a Softn release carries (softn-release.json `zipp.packages.torch`,
 * since Softn v0.0.16 and ZIPP v0.0.21): ZIPP's web-torch build of the same release, a Python
 * package the engine adds on demand for an app that declares torch. `primary` is the release's
 * `zipp` record: the package must be built from its commit and pair with exactly its bundle.
 * Returns a copy of the record.
 */
export function zippTorchIdentity(torch, primary) {
  if (!torch || typeof torch !== 'object' || Array.isArray(torch)) throw new Error('The ZIPP torch package record is missing.');
  const primaryRecord = zippReleaseIdentity(primary);
  const problems = [];
  if (typeof torch.bundle !== 'string' || !/^[^/\\]+$/.test(torch.bundle)) problems.push('no bundle file name');
  for (const key of ['bundleSha256', 'sha256', 'loaderSha256']) if (!HEX64.test(torch[key] ?? '')) problems.push(`${key} is not a SHA-256`);
  if (torch.variant !== 'torch') problems.push(`variant is ${canonical(torch.variant) ?? '(absent)'}, not "torch"`);
  if (typeof torch.engineAbi !== 'string' || !torch.engineAbi) problems.push('no engineAbi');
  if (!/^[0-9a-f]{40}$/.test(torch.commit ?? '')) problems.push('commit is not a 40-hex commit');
  else if (torch.commit !== primaryRecord.revision) problems.push(`it was built from ${torch.commit.slice(0, 12)}, not the release's ${primaryRecord.revision.slice(0, 12)}`);
  if (torch.pairsWith !== primaryRecord.bundle.replace(/\.zip$/, '')) problems.push(`it pairs with ${canonical(torch.pairsWith) ?? '(nothing)'}, not the engine bundle ${primaryRecord.bundle}`);
  if (torch.sha256 === primaryRecord.sha256) problems.push('it names the engine\'s own digest');
  if (problems.length) throw new Error(`The ZIPP torch package record is not ZIPP ${primaryRecord.release}'s torch package for this engine: ${problems.join('; ')}.`);
  return JSON.parse(JSON.stringify(torch));
}

/**
 * The torch package tree as Softn ships it (the archive's top-level zipp-torch/): `source` a
 * directory or a Map of path to bytes, `torch` the release's `zipp.packages.torch`, `primary` the
 * release's `zipp` record. FormLogic installs no copy of this tree — the hosted runtime and the
 * editors each carry the module beside their core chunk and fetch it from there — but it is the
 * one copy Softn ships with its provenance, so it is where the record is proved: exactly the files
 * the web-torch bundle's own SHA256SUMS lists, plus Softn's SOURCE.json and generated
 * declarations; SOURCE.json carries the record's every key and is the same release (version, tag,
 * revision, release sums, build, toolchain) as the engine it names as its primary; BUILD-INFO says
 * what SOURCE.json says; the module and ZIPP's loader are the recorded digests; and, given the
 * primary tree's RELEASE-SHA256SUMS (`releaseSums`), the ZIPP release lists the torch bundle with
 * the recorded digest. Whether the package runs with this engine (engineAbi) is Softn's install
 * check, which adds it to the engine and runs `import torch`. Returns the tree's SOURCE.json.
 */
export async function checkZippTorchTree(source, torch, primary, { releaseSums = null } = {}) {
  const files = new Map();
  if (typeof source === 'string') {
    for (const path of await artifactFiles(source, { includeManifest: true })) files.set(path, await readFile(resolve(source, path)));
  } else {
    for (const [path, value] of source) files.set(path, Buffer.isBuffer(value) ? value : value.data);
  }
  const missing = ZIPP_TORCH_TREE_REQUIRED.filter(name => !files.has(name));
  if (missing.length) throw new Error(`The ZIPP torch package tree is missing ${missing.join(', ')}.`);
  torch = zippTorchIdentity(torch, primary);
  const primaryRecord = zippReleaseIdentity(primary);

  const text = name => files.get(name).toString('utf8');
  let record;
  try { record = JSON.parse(text('SOURCE.json')); }
  catch (error) { throw new Error(`The ZIPP torch package tree's SOURCE.json is not JSON: ${error.message}`); }
  if (!record || typeof record !== 'object') throw new Error('The ZIPP torch package tree\'s SOURCE.json is not a record.');
  for (const [key, value] of Object.entries(torch)) {
    if (canonical(record[key]) !== canonical(value)) throw new Error(`The ZIPP torch package tree's SOURCE.json ${key} is ${canonical(record[key]) ?? '(absent)'}; the release records ${canonical(value)}.`);
  }
  const same = [['version', primaryRecord.version], ['release', primaryRecord.release], ['revision', primaryRecord.revision], ['sumsSha256', primaryRecord.sumsSha256], ['build', 'release'], ['artifact', 'zipp_torch.wasm'], ['loader', 'zipp_torch.js'], ...(primaryRecord.rustc !== undefined ? [['rustc', primaryRecord.rustc]] : [])];
  for (const [key, value] of same) {
    if (canonical(record[key]) !== canonical(value)) throw new Error(`The ZIPP torch package tree's SOURCE.json ${key} is ${canonical(record[key]) ?? '(absent)'}; the release's is ${canonical(value)}.`);
  }
  const named = record.primary;
  if (!named || typeof named !== 'object' || named.bundle !== primaryRecord.bundle || named.sha256 !== primaryRecord.sha256 || named.glueSha256 !== primaryRecord.glueSha256) {
    throw new Error(`The ZIPP torch package tree's SOURCE.json primary is ${canonical(named) ?? '(absent)'}; the release's engine is ${primaryRecord.bundle} (${primaryRecord.sha256.slice(0, 12)}, glue ${primaryRecord.glueSha256.slice(0, 12)}).`);
  }

  // Shipped file -> the torch bundle's sums; only Softn's own additions are exempt.
  const inner = parseSums(text('SHA256SUMS'), 'zipp-torch/SHA256SUMS');
  const exempt = new Set(['SOURCE.json', 'SHA256SUMS']);
  const declarations = record.declarations;
  if (declarations !== undefined) {
    if (!declarations || typeof declarations.file !== 'string' || !/^[^/\\]+$/.test(declarations.file) || declarations.source !== 'softn-generated' || !HEX64.test(declarations.sha256 ?? '')) {
      throw new Error('The ZIPP torch package tree\'s SOURCE.json declarations are not a softn-generated file with a SHA-256.');
    }
    if (ZIPP_TORCH_TREE_REQUIRED.includes(declarations.file) || inner.has(declarations.file)) throw new Error(`The ZIPP torch package tree's SOURCE.json names ${declarations.file} as Softn's declarations; that is a file of the torch bundle or of Softn's record.`);
    if (!files.has(declarations.file) || digest(files.get(declarations.file)) !== declarations.sha256) throw new Error(`The ZIPP torch package tree's ${declarations.file} is missing or differs from SOURCE.json declarations.`);
    exempt.add(declarations.file);
  }
  for (const [path, bytes] of files) {
    if (exempt.has(path)) continue;
    if (!inner.has(path)) throw new Error(`The ZIPP torch package tree ships ${path}, which ZIPP ${record.release}'s torch bundle SHA256SUMS does not list.`);
    if (digest(bytes) !== inner.get(path)) throw new Error(`The ZIPP torch package tree's ${path} differs from ZIPP ${record.release}'s torch bundle SHA256SUMS.`);
  }

  const buildInfo = new Map(text('BUILD-INFO.txt').replace(/\r\n/g, '\n').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const built = [
    ['commit', buildInfo.get('commit'), record.revision, 'revision'],
    ['version', buildInfo.get('version'), record.version, 'version'],
    ['variant', buildInfo.get('variant'), record.variant, 'variant'],
    ['pairs-with', buildInfo.get('pairs-with'), record.pairsWith, 'pairsWith'],
    ['rustc', buildInfo.get('rustc'), record.rustc, 'rustc'],
  ];
  for (const [key, actual, expected, field] of built) {
    if (actual === undefined || canonical(actual) !== canonical(expected)) throw new Error(`The ZIPP torch package tree's BUILD-INFO.txt ${key} is ${canonical(actual) ?? '(absent)'}; SOURCE.json ${field} is ${canonical(expected) ?? '(absent)'}.`);
  }

  if (releaseSums) {
    if (digest(releaseSums) !== primaryRecord.sumsSha256) throw new Error(`RELEASE-SHA256SUMS is not the ZIPP ${primaryRecord.release} SHA256SUMS the release records (${primaryRecord.sumsSha256.slice(0, 12)}).`);
    if (parseSums(releaseSums.toString('utf8'), 'RELEASE-SHA256SUMS').get(torch.bundle) !== torch.bundleSha256) throw new Error(`ZIPP ${primaryRecord.release}'s SHA256SUMS does not list ${torch.bundle} with the digest the torch package record says.`);
  }

  const wasm = files.get('zipp_torch.wasm');
  if (digest(wasm) !== torch.sha256) throw new Error('The ZIPP torch package tree\'s zipp_torch.wasm differs from the recorded torch sha256.');
  if (!isZippTorchWasm(wasm)) throw new Error('The ZIPP torch package tree\'s zipp_torch.wasm is not ZIPP\'s torch module: its exports are not the package\'s.');
  if (digest(files.get('zipp_torch.js')) !== torch.loaderSha256) throw new Error('The ZIPP torch package tree\'s zipp_torch.js differs from the recorded torch loaderSha256.');
  return record;
}

/**
 * Every torch package module in a built tree (a hosted runtime, the editors) is the one the
 * release records, and each place the runtime fetches it from (`required`, tree-relative) holds
 * one. With no record, a torch module anywhere is refused: the tree is serving a package its
 * release does not describe. Returns the paths found.
 */
export async function checkTorchCopies(directory, torch, required = []) {
  const found = [];
  for (const path of await artifactFiles(directory, { includeManifest: true })) {
    if (!path.endsWith('.wasm')) continue;
    const bytes = await readFile(resolve(directory, path));
    if (!isZippTorchWasm(bytes)) continue;
    if (!torch) throw new Error(`${path} is a ZIPP torch package module, but the installed release records no zipp.packages.torch.`);
    if (digest(bytes) !== torch.sha256) throw new Error(`${path} is a ZIPP torch package module (${digest(bytes).slice(0, 12)}) other than the one the release records (${torch.sha256.slice(0, 12)}).`);
    found.push(path);
  }
  const absent = torch ? required.filter(path => !found.includes(path)) : [];
  if (absent.length) throw new Error(`No ZIPP torch package module at ${absent.join(', ')} (found: ${found.join(', ') || 'none'}); the runtime fetches it from there for an app that declares torch.`);
  return found;
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

/**
 * The hosted runtime's two entry documents, and the one thing that tells them apart.
 *
 * The shell writes its Content-Security-Policy over itself from ONE input: the
 * `data-softn-logic-engine` attribute on `<html>`. `host.html` carries `"host-js"` and gets
 * `'unsafe-eval'` in `script-src`; `index.html` carries nothing and gets the policy every hosted
 * app has always run under. Both load the SAME entry module, so it is the same code reading the
 * same attribute — which is why the attribute, and not a token in a shared chunk, is what can be
 * checked here at all. (Greping the entry chunk for `'unsafe-eval'` CANNOT work: the two
 * documents share `main-*.js`, where the token is a conditional and is therefore present for
 * both.) What each document actually WRITES is evaluated in a real browser by
 * scripts/check-zipp-sharing.mjs — see its `frame-policy` order.
 *
 * An attribute value neither document should carry is refused rather than guessed at: the shell
 * serves no engine for an attribute it does not know, so such a document would be a runtime that
 * silently runs nothing.
 */
export const ENGINE_ATTRIBUTE = 'data-softn-logic-engine';
export async function checkEntryDocuments(directory) {
  const read = async (name) => {
    try { return await readFile(resolve(directory, name), 'utf8'); }
    catch { throw new Error(`The hosted runtime has no ${name}: it must carry both entry documents.`); }
  };
  const attributeOf = (html, name) => {
    const tag = html.match(/<html\b[^>]*>/i);
    if (!tag) throw new Error(`${name} has no <html> element, so the shell cannot read which engine it serves.`);
    const attribute = tag[0].match(new RegExp(`${ENGINE_ATTRIBUTE}\\s*=\\s*"([^"]*)"`, 'i'));
    return attribute ? attribute[1] : null;
  };
  const entryOf = (html) => [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]).sort();
  const index = await read('index.html');
  const host = await read('host.html');
  const indexAttribute = attributeOf(index, 'index.html');
  if (indexAttribute !== null && indexAttribute !== '') {
    throw new Error(`hosted-runtime/index.html declares ${ENGINE_ATTRIBUTE}="${indexAttribute}"; it must declare none, so its policy stays the one every hosted app has always had.`);
  }
  const hostAttribute = attributeOf(host, 'host.html');
  if (hostAttribute !== 'host-js') {
    throw new Error(`hosted-runtime/host.html declares ${ENGINE_ATTRIBUTE}=${hostAttribute === null ? '(none)' : `"${hostAttribute}"`}; it must declare "host-js", which is the single input that gives it its own policy.`);
  }
  const indexEntry = entryOf(index);
  if (indexEntry.length === 0) throw new Error('hosted-runtime/index.html loads no entry script.');
  if (JSON.stringify(entryOf(host)) !== JSON.stringify(indexEntry)) {
    throw new Error(`hosted-runtime/host.html loads ${JSON.stringify(entryOf(host))} and index.html loads ${JSON.stringify(indexEntry)}; both documents must run the same shell, or the attribute is not the only difference between them.`);
  }
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
