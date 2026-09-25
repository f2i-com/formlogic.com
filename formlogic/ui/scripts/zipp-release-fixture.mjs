// Test fixtures only: a ZIPP engine tree shaped like the zipp/ tree Softn's
// scripts/package-formlogic-runtime.mjs ships (ZIPP's web-python bundle files
// byte for byte, plus Softn's SOURCE.json, RELEASE-SHA256SUMS and curated
// notices), and small valid wasm modules to stand in for the engine.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ZIPP_ENGINE_EXPORTS, ZIPP_TORCH_EXPORTS } from './hosted-runtime-artifact.mjs';

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

/** A module the content scan must recognise as ZIPP's torch package. */
export const zippTorchWasm = (label = 'torch') => wasmModule(['zipp_alloc', 'zipp_free', ...ZIPP_TORCH_EXPORTS], label);

const RECORD_FIELDS = ['version', 'sha256', 'revision', 'release', 'bundle', 'bundleSha256', 'sumsSha256', 'variant', 'languages', 'build', 'glueSha256'];

/**
 * One ZIPP release as Softn ships it. `files` is the zipp/ tree (path ->
 * bytes); `source` its SOURCE.json; `record` the softn-release.json `zipp`
 * Softn writes (a subset of SOURCE.json). `buildInfo` edits BUILD-INFO.txt
 * before the bundle's sums are computed, so only that field disagrees.
 *
 * `webVariant` adds what Softn ships since it carries ZIPP's JavaScript-only
 * web build as a verified VARIANT of the same release: `source` and `record`
 * gain `variants.web` (appended last, as Softn writes it), and `webFiles` is
 * the top-level zipp-web/ tree — the variant's engine, BUILD-INFO, PROFILE,
 * the web bundle's inner SHA256SUMS (which lists files Softn does not ship:
 * the web glue, its declarations, the licence, the host SDK) and a
 * SOURCE.json naming the primary it is a variant of. No glue: the variant
 * runs under the primary's zipp_wasm.js. `webBuildInfo` edits the variant's
 * BUILD-INFO.txt before ITS sums are computed; `webWasm` replaces its engine
 * bytes (the record follows, so only the bytes' relation to the primary changes).
 *
 * `torch` adds what Softn ships since v0.0.16 (ZIPP v0.0.21): the same release's web-torch
 * package, recorded under `packages.torch` (after `variants`, as Softn writes it), and
 * `torchFiles`, the top-level zipp-torch/ tree — the module, ZIPP's loader, BUILD-INFO, the torch
 * bundle's inner SHA256SUMS (which lists files Softn does not ship: the licence, a README, docs),
 * Softn's generated declarations and a SOURCE.json naming the engine it pairs with.
 * `torchBuildInfo` edits its BUILD-INFO.txt before ITS sums are computed.
 */
export function zippReleaseFixture({ version = '0.0.18', revision = 'a'.repeat(40), label = `engine ${version}`, notices = 'softn-curated', noticesFile = 'THIRD_PARTY_LICENSES.txt', buildInfo = text => text, webVariant = false, webBuildInfo = text => text, webWasm: webWasmBytes = null, torch = false, torchBuildInfo = text => text } = {}) {
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
  const releaseSums = `${sha256(`linux ${label}`)}  zipp-${version}-x86_64-unknown-linux-gnu.tar.gz\n${sha256(`web ${label}`)}  zipp-wasm-${version}-web.zip\n${bundleSha256}  ${bundle}\n${torch ? `${sha256(`torch ${label}`)}  zipp-wasm-${version}-web-torch.zip\n` : ''}`;
  const source = {
    repository: 'https://github.com/f2i-com/zipp.org', release, version, revision, build: 'release',
    bundle, bundleSha256, sumsSha256: sha256(releaseSums),
    variant: 'javascript-python', languages: ['javascript', 'python'], stackBytes: 16777216, rustc: 'rustc 1.92.0 (fixture)', wasmBindgen: 'wasm-bindgen 0.2.126',
    license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: sha256(wasm), glueSha256: sha256(glue),
    notices: { file: noticesFile, source: notices, sha256: sha256(thirdParty) },
  };
  let web = {};
  if (webVariant) {
    // The JavaScript-only build of the SAME release: its own engine bytes and glue (the glue is
    // recorded, never shipped), a 1 MiB stack, and the same commit and toolchain.
    const webWasm = webWasmBytes ?? zippEngineWasm(`${label} web`);
    const webGlue = Buffer.from(`// zipp_wasm.js fixture for ${label} web\nexport default async function init() {}\nexport class Engine {}\n`);
    const webBundle = `zipp-wasm-${version}-web.zip`;
    const webShipped = {
      'zipp_wasm_bg.wasm': webWasm,
      'BUILD-INFO.txt': Buffer.from(webBuildInfo(`version=${version}\ncommit=${revision}\nrustc=rustc 1.92.0 (fixture)\nwasm-bindgen=wasm-bindgen 0.2.126\nvariant=javascript\nlanguages=["javascript"]\nstack-bytes=1048576\ntarget=wasm32-unknown-unknown\n`)),
      'PROFILE.json': Buffer.from(JSON.stringify({ engine: 'zipp-wasm', version, source: { sha: revision }, languages: ['javascript'] }, null, 2) + '\n'),
    };
    const webUnshipped = { 'zipp_wasm.js': webGlue, 'zipp_wasm.d.ts': Buffer.from('export default function init(): Promise<void>;\n'), 'zipp_wasm_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;\n'), 'LICENSE-APACHE': Buffer.from('Apache License, Version 2.0 (fixture)\n'), 'README.md': Buffer.from('# ZIPP web bundle\n'), 'host-sdk/zipp-host.mjs': Buffer.from('export {};\n') };
    const webInner = Object.entries({ ...webShipped, ...webUnshipped }).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => `${sha256(bytes)}  ${path}`).join('\n') + '\n';
    // The eight keys Softn records for the variant, in softn-release.json and in zipp/SOURCE.json.
    const variant = { bundle: webBundle, bundleSha256: sha256(`web ${label}`), sha256: sha256(webWasm), glueSha256: sha256(webGlue), variant: 'javascript', languages: ['javascript'], stackBytes: 1048576, commit: revision };
    const webSource = {
      repository: source.repository, release, version, revision, build: 'release',
      bundle: webBundle, bundleSha256: variant.bundleSha256, sumsSha256: source.sumsSha256,
      variant: 'javascript', languages: ['javascript'], stackBytes: 1048576, rustc: source.rustc, wasmBindgen: source.wasmBindgen,
      license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: variant.sha256, glueSha256: variant.glueSha256, commit: revision,
      primary: { bundle, sha256: source.sha256, glueSha256: source.glueSha256 },
    };
    source.variants = { web: variant };
    web = { webFiles: { ...webShipped, SHA256SUMS: Buffer.from(webInner), 'SOURCE.json': Buffer.from(JSON.stringify(webSource, null, 2) + '\n') }, webSource, webWasm, webGlue, variant };
  }
  let packaged = {};
  if (torch) {
    // The web-torch build of the SAME release: its module and ZIPP's loader, paired with exactly the primary bundle.
    const torchBundle = `zipp-wasm-${version}-web-torch.zip`;
    const torchWasm = zippTorchWasm(`${label} torch`);
    const loader = Buffer.from(`// zipp_torch.js fixture for ${label}\nexport async function addTorch() {}\nexport function addTorchSync() {}\n`);
    const declarations = Buffer.from('export function addTorch(zipp: unknown, source: unknown): Promise<unknown>;\n');
    const pairsWith = bundle.replace(/\.zip$/, '');
    const torchShipped = {
      'zipp_torch.wasm': torchWasm,
      'zipp_torch.js': loader,
      'BUILD-INFO.txt': Buffer.from(torchBuildInfo(`version=${version}\ncommit=${revision}\nrustc=rustc 1.92.0 (fixture)\nvariant=torch\npairs-with=${pairsWith}\ntarget=wasm32-unknown-unknown\n`)),
    };
    const torchUnshipped = { 'LICENSE-APACHE': Buffer.from('Apache License, Version 2.0 (fixture)\n'), 'README.md': Buffer.from('# ZIPP torch\n'), 'docs/TORCH_COMPATIBILITY.md': Buffer.from('torch\n') };
    const torchInner = Object.entries({ ...torchShipped, ...torchUnshipped }).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => `${sha256(bytes)}  ${path}`).join('\n') + '\n';
    // The eight keys Softn records for the package, in softn-release.json and in zipp/SOURCE.json.
    const torchRecord = { bundle: torchBundle, bundleSha256: sha256(`torch ${label}`), sha256: sha256(torchWasm), loaderSha256: sha256(loader), variant: 'torch', pairsWith, commit: revision, engineAbi: '0123456789abcdef' };
    const torchSource = {
      repository: source.repository, release, version, revision, build: 'release',
      bundle: torchBundle, bundleSha256: torchRecord.bundleSha256, sumsSha256: source.sumsSha256,
      variant: 'torch', pairsWith, rustc: source.rustc, license: 'Apache-2.0',
      artifact: 'zipp_torch.wasm', sha256: torchRecord.sha256, loader: 'zipp_torch.js', loaderSha256: torchRecord.loaderSha256,
      declarations: { file: 'zipp_torch.d.ts', source: 'softn-generated', sha256: sha256(declarations) },
      commit: revision, engineAbi: torchRecord.engineAbi,
      primary: { bundle, sha256: source.sha256, glueSha256: source.glueSha256 },
    };
    source.packages = { torch: torchRecord };
    packaged = { torchFiles: { ...torchShipped, 'zipp_torch.d.ts': declarations, SHA256SUMS: Buffer.from(torchInner), 'SOURCE.json': Buffer.from(JSON.stringify(torchSource, null, 2) + '\n') }, torchSource, torchWasm, torchLoader: loader, torchRecord };
  }
  const files = { ...shipped, [noticesFile]: thirdParty, SHA256SUMS: Buffer.from(inner), 'RELEASE-SHA256SUMS': Buffer.from(releaseSums), 'SOURCE.json': Buffer.from(JSON.stringify(source, null, 2) + '\n') };
  const record = Object.fromEntries([...RECORD_FIELDS, ...(webVariant ? ['variants'] : []), ...(torch ? ['packages'] : [])].map(key => [key, source[key]]));
  return { files, source, record, wasm, glue, ...web, ...packaged };
}

/** The tree as a Map, the form checkZippTree takes for archive entries. */
export const zippTreeMap = files => new Map(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)]));

export async function writeZippTree(directory, files) {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), bytes);
  }
}
