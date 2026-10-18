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

/** Signed LEB128, as an i32.const operand is written. */
const sleb = n => { const out = []; for (;;) { const byte = n & 0x7f; n >>= 7; if ((n === 0 && !(byte & 0x40)) || (n === -1 && byte & 0x40)) return [...out, byte]; out.push(byte | 0x80); } };

/**
 * A valid wasm module exporting one no-op function under every name given; `label` goes in a
 * custom section so modules differ. `stackBytes` gives it a first global as rustc's stack pointer
 * starts (a mutable i32 at the top of the stack), and `custom` more custom sections, [name, payload].
 */
export function wasmModule(exportNames, label = '', { stackBytes, custom = [] } = {}) {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [1, 0]),
    ...(stackBytes === undefined ? [] : section(6, [1, 0x7f, 0x01, 0x41, ...sleb(stackBytes), 0x0b])),
    ...section(7, [...leb(exportNames.length), ...exportNames.flatMap(n => [...name(n), 0x00, 0])]),
    ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [...name('fixture'), ...Buffer.from(label, 'utf8')]),
    ...custom.flatMap(([n, payload]) => section(0, [...name(n), ...Buffer.from(payload)])),
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

/**
 * One ZIPP release published as plain modules (0.0.26 on) as Softn installs it: `files` the zipp/
 * tree (the engine module as published, its bindings, the embed kit's declarations and licence,
 * ZIPP's SHA256SUMS, the notices, SOURCE.json), `webFiles` the zipp-web/ tree (the javascript
 * module and SOURCE.json) and `torchFiles` the zipp-torch/ tree (the torch-package module, Softn's
 * generated loader and declarations, SOURCE.json); `record` is softn-release.json `zipp`, the whole
 * SOURCE.json, as Softn writes it. Every module carries its zipp.meta record (and an engine its
 * zipp.glue bindings and a stack); `meta`, `webMeta` and `torchMeta` edit a record before the
 * module is built, so the digests that follow it still agree and only the record says otherwise.
 */
export function zippModuleReleaseFixture({ version = '0.0.26', revision = 'b'.repeat(40), label = `engine ${version}`, notices = 'softn-curated', noticesFile = 'THIRD_PARTY_LICENSES.txt', meta = m => m, webMeta = m => m, torchMeta = m => m, stackBytes = 16777216, webStackBytes = 1048576 } = {}) {
  const release = `v${version}`;
  const bundle = `zipp-${version}-javascript-python-base.wasm`;
  const glue = Buffer.from(`// zipp.glue fixture for ${label}\nexport default async function init() {}\nexport class Engine {}\n`);
  const wasm = wasmModule([...ZIPP_ENGINE_EXPORTS, 'memory_usage'], label, { stackBytes, custom: [['zipp.meta', JSON.stringify(meta({ format: 1, variant: 'javascript-python-base', version, commit: revision, languages: ['javascript', 'python'], glueSha256: sha256(glue) }))], ['zipp.glue', glue]] });
  const webBundle = `zipp-${version}-javascript.wasm`;
  const webGlue = Buffer.from(`// zipp.glue fixture for ${label} web\nexport default async function init() {}\n`);
  const webWasm = wasmModule([...ZIPP_ENGINE_EXPORTS], `${label} web`, { stackBytes: webStackBytes, custom: [['zipp.meta', JSON.stringify(webMeta({ format: 1, variant: 'javascript', version, commit: revision, languages: ['javascript'], glueSha256: sha256(webGlue) }))], ['zipp.glue', webGlue]] });
  const torchBundle = `zipp-${version}-torch-package.wasm`;
  const torchWasm = wasmModule(['zipp_alloc', 'zipp_free', 'memory', ...ZIPP_TORCH_EXPORTS], `${label} torch`, { custom: [['zipp.meta', JSON.stringify(torchMeta({ format: 1, variant: 'torch-package', version, commit: revision, languages: ['python'] }))]] });
  const kitBundle = `zipp-${version}-wasm-embed-kit.zip`;
  const kitBundleSha256 = sha256(`kit ${label}`);
  const declarations = Buffer.from('export default function init(): Promise<void>;\nexport class Engine {}\n');
  const license = Buffer.from('Apache License, Version 2.0 (fixture)\n');
  const thirdParty = Buffer.from('Unicode data (Unicode-3.0) notices, fixture\n');
  const releaseSums = [
    `${sha256(`windows ${label}`)}  zipp-${version}-windows-x86_64-portable.exe`,
    `${sha256(webWasm)}  ${webBundle}`,
    `${sha256(wasm)}  ${bundle}`,
    `${sha256(torchWasm)}  ${torchBundle}`,
    `${kitBundleSha256}  ${kitBundle}`,
  ].join('\n') + '\n';
  const repository = 'https://github.com/f2i-com/zipp.org';
  const source = {
    repository, release, version, revision, build: 'release',
    bundle, bundleSha256: sha256(wasm), sumsSha256: sha256(releaseSums),
    variant: 'javascript-python-base', languages: ['javascript', 'python'], stackBytes,
    license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: sha256(wasm), glueSha256: sha256(glue),
    kit: { bundle: kitBundle, bundleSha256: kitBundleSha256, files: { 'zipp_wasm.d.ts': { from: 'zipp-engine.d.ts', sha256: sha256(declarations) }, 'LICENSE-APACHE': { from: 'LICENSE-APACHE', sha256: sha256(license) } } },
    notices: { file: noticesFile, source: notices, sha256: sha256(thirdParty) },
  };
  const primary = { bundle, sha256: source.sha256, glueSha256: source.glueSha256 };
  const variant = { bundle: webBundle, bundleSha256: sha256(webWasm), sha256: sha256(webWasm), glueSha256: sha256(webGlue), variant: 'javascript', languages: ['javascript'], stackBytes: webStackBytes, commit: revision };
  const webSource = { repository, release, version, revision, build: 'release', ...variant, sumsSha256: source.sumsSha256, license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', primary };
  const loader = Buffer.from(`// zipp_torch.js fixture for ${label}\nexport async function addTorch() {}\nexport function addTorchSync() {}\n`);
  const torchDeclarations = Buffer.from('export function addTorch(zipp: unknown, source: unknown): Promise<unknown>;\n');
  const torchRecord = { bundle: torchBundle, bundleSha256: sha256(torchWasm), sha256: sha256(torchWasm), loaderSha256: sha256(loader), variant: 'torch-package', pairsWith: bundle, commit: revision, engineAbi: '0123456789abcdef' };
  const torchSource = {
    repository, release, version, revision, build: 'release', bundle: torchBundle, bundleSha256: torchRecord.bundleSha256, sumsSha256: source.sumsSha256,
    variant: 'torch-package', languages: ['python'], pairsWith: bundle, license: 'Apache-2.0', artifact: 'zipp_torch.wasm', sha256: torchRecord.sha256,
    loader: 'zipp_torch.js', loaderSha256: torchRecord.loaderSha256, loaderSource: 'softn-generated',
    declarations: { file: 'zipp_torch.d.ts', source: 'softn-generated', sha256: sha256(torchDeclarations) },
    commit: revision, engineAbi: torchRecord.engineAbi, primary,
  };
  source.variants = { web: variant };
  source.packages = { torch: torchRecord };
  const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const files = { 'zipp_wasm.js': glue, 'zipp_wasm.d.ts': declarations, 'zipp_wasm_bg.wasm': wasm, 'LICENSE-APACHE': license, [noticesFile]: thirdParty, 'RELEASE-SHA256SUMS': Buffer.from(releaseSums), 'SOURCE.json': json(source) };
  return {
    files, source, record: JSON.parse(JSON.stringify(source)), wasm, glue, releaseSums: Buffer.from(releaseSums),
    webFiles: { 'zipp_wasm_bg.wasm': webWasm, 'SOURCE.json': json(webSource) }, webSource, webWasm, webGlue, variant,
    torchFiles: { 'zipp_torch.wasm': torchWasm, 'zipp_torch.js': loader, 'zipp_torch.d.ts': torchDeclarations, 'SOURCE.json': json(torchSource) }, torchSource, torchWasm, torchLoader: loader, torchRecord,
  };
}

/** The tree as a Map, the form checkZippTree takes for archive entries. */
export const zippTreeMap = files => new Map(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)]));

export async function writeZippTree(directory, files) {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), bytes);
  }
}
