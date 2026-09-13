// Copy one verified engine artifact, including its matching glue and provenance.
// Run after Softn's build:zipp-wasm; never compile a second, different binary here.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = process.env.SOFTN_REPO
  ? pathToFileURL(resolve(process.env.SOFTN_REPO) + sep)
  : new URL('../../softn.com/', import.meta.url);
const sourceDir = new URL('packages/@softn/core/wasm-zipp/', repository);
const destination = new URL('../formlogic/ui/vendor/zipp-wasm/', import.meta.url);
const source = JSON.parse(await readFile(new URL('SOURCE.json', sourceDir), 'utf8'));
const bytes = await readFile(new URL('zipp_wasm_bg.wasm', sourceDir));
if (!/^[0-9a-f]{40}$/.test(source.revision ?? '') || !/^[0-9a-f]{64}$/.test(source.sha256 ?? '') ||
    createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
  throw new Error('The Softn engine source revision or checksum is invalid.');
}
const engine = await import(new URL('zipp_wasm.js', sourceDir));
engine.initSync({ module: bytes });
const profile = JSON.parse(engine.zippProfile());
if (profile.version !== source.version || !profile.features.includes('safe-sandbox') ||
    (source.languages && JSON.stringify(profile.languages) !== JSON.stringify(source.languages))) {
  throw new Error('The Softn engine profile does not match its provenance or required sandbox.');
}
const files = ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'SOURCE.json', 'THIRD_PARTY_LICENSES.txt'];
// Read every source before replacing an existing installation.
await Promise.all(files.map(file => readFile(new URL(file, sourceDir))));
await mkdir(destination, { recursive: true });
for (const file of files) await copyFile(new URL(file, sourceDir), new URL(file, destination));
await copyFile(new URL('THIRD_PARTY_LICENSES.txt', sourceDir), new URL('../formlogic/ui/public/zipp-licenses.txt', import.meta.url));
console.log(`Synced ZIPP ${source.version} (${profile.languages.join(', ')}) from ${source.revision}: ${source.sha256}`);
