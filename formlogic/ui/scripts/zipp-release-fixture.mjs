// Test fixtures only: a ZIPP engine tree shaped like the zipp/ tree Softn's
// scripts/package-formlogic-runtime.mjs ships (ZIPP's web-python bundle files
// byte for byte, plus Softn's SOURCE.json, RELEASE-SHA256SUMS and curated
// notices), and small valid wasm modules to stand in for the engine.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ZIPP_ENGINE_EXPORTS } from './hosted-runtime-artifact.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const leb = n => { const out = []; do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n); return out; };
const section = (id, body) => [id, ...leb(body.length), ...body];
const name = text => { const bytes = [...Buffer.from(text, 'utf8')]; return [...leb(bytes.length), ...bytes]; };

/** A valid wasm module exporting one no-op function under every name given; `label` goes in a custom section so modules differ. */
export function wasmModule(exportNames, label = '') {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [1, 0]),
    ...section(7, [...leb(exportNames.length), ...exportNames.flatMap(n => [...name(n), 0x00, 0])]),
    ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [...name('fixture'), ...Buffer.from(label, 'utf8')]),
  ]);
}

/** A module the content scan must recognise as a ZIPP engine. */
export const zippEngineWasm = (label = 'engine') => wasmModule([...ZIPP_ENGINE_EXPORTS, 'memory_usage'], label);

const RECORD_FIELDS = ['version', 'sha256', 'revision', 'release', 'bundle', 'bundleSha256', 'sumsSha256', 'variant', 'languages', 'build', 'glueSha256'];

/**
 * One ZIPP release as Softn ships it. `files` is the zipp/ tree (path ->
 * bytes); `source` its SOURCE.json; `record` the softn-release.json `zipp`
 * Softn writes (a subset of SOURCE.json). `buildInfo` edits BUILD-INFO.txt
 * before the bundle's sums are computed, so only that field disagrees.
 */
export function zippReleaseFixture({ version = '0.0.18', revision = 'a'.repeat(40), label = `engine ${version}`, notices = 'softn-curated', noticesFile = 'THIRD_PARTY_LICENSES.txt', buildInfo = text => text } = {}) {
  const release = `v${version}`;
  const bundle = `zipp-wasm-${version}-web-python.zip`;
  const wasm = zippEngineWasm(label);
  const glue = Buffer.from(`// zipp_wasm.js fixture for ${label}\nexport default async function init() {}\nexport class Engine {}\n`);
  const thirdParty = Buffer.from('RustPython parser (MIT) and Unicode data (Unicode-3.0) notices, fixture\n');
  const shipped = {
    'zipp_wasm.js': glue,
    'zipp_wasm.d.ts': Buffer.from('export default function init(): Promise<void>;\nexport class Engine {}\n'),
    'zipp_wasm_bg.wasm': wasm,
    'zipp_wasm_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;\n'),
    'LICENSE-APACHE': Buffer.from('Apache License, Version 2.0 (fixture)\n'),
    'BUILD-INFO.txt': Buffer.from(buildInfo(`version=${version}\ncommit=${revision}\nrustc=rustc 1.92.0 (fixture)\nwasm-bindgen=wasm-bindgen 0.2.126\nvariant=javascript-python\nlanguages=["javascript","python"]\nstack-bytes=16777216\ntarget=wasm32-unknown-unknown\n`)),
    'PROFILE.json': Buffer.from(JSON.stringify({ engine: 'zipp-wasm', version, source: { sha: revision } }, null, 2) + '\n'),
    ...(notices === 'zipp-release' && { [noticesFile]: thirdParty }),
  };
  // The bundle carries more than Softn ships; its sums list all of it.
  const unshipped = { 'README.md': Buffer.from('# ZIPP web bundle\n'), 'docs/TORCH_COMPATIBILITY.md': Buffer.from('torch\n'), 'gpu-lab/LICENSE': Buffer.from('gpu-lab licence\n'), 'host-sdk/zipp-host.mjs': Buffer.from('export {};\n') };
  const inner = Object.entries({ ...shipped, ...unshipped }).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => `${sha256(bytes)}  ${path}`).join('\n') + '\n';
  const bundleSha256 = sha256(`bundle ${label}`);
  const releaseSums = `${sha256(`linux ${label}`)}  zipp-${version}-x86_64-unknown-linux-gnu.tar.gz\n${sha256(`web ${label}`)}  zipp-wasm-${version}-web.zip\n${bundleSha256}  ${bundle}\n`;
  const source = {
    repository: 'https://github.com/f2i-com/zipp.org', release, version, revision, build: 'release',
    bundle, bundleSha256, sumsSha256: sha256(releaseSums),
    variant: 'javascript-python', languages: ['javascript', 'python'], stackBytes: 16777216, rustc: 'rustc 1.92.0 (fixture)', wasmBindgen: 'wasm-bindgen 0.2.126',
    license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: sha256(wasm), glueSha256: sha256(glue),
    notices: { file: noticesFile, source: notices, sha256: sha256(thirdParty) },
  };
  const files = { ...shipped, [noticesFile]: thirdParty, SHA256SUMS: Buffer.from(inner), 'RELEASE-SHA256SUMS': Buffer.from(releaseSums), 'SOURCE.json': Buffer.from(JSON.stringify(source, null, 2) + '\n') };
  const record = Object.fromEntries(RECORD_FIELDS.map(key => [key, source[key]]));
  return { files, source, record, wasm, glue };
}

/** The tree as a Map, the form checkZippTree takes for archive entries. */
export const zippTreeMap = files => new Map(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)]));

export async function writeZippTree(directory, files) {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), bytes);
  }
}
