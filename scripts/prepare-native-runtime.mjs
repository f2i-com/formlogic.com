// Assemble trusted SoftN backend code and the shared ZIPP release for FormLogic.
// Application uploads never supply any of these runtime modules.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
const repository = process.env.SOFTN_REPO ? pathToFileURL(resolve(process.env.SOFTN_REPO) + sep) : new URL('../../softn.com/', import.meta.url);
const source = new URL('apps/softn-php/runtime/', repository);
const wasm = new URL('packages/@softn/core/wasm-zipp/', repository);
const target = new URL('../formlogic/backend/resources/softn-native/', import.meta.url);
const modules = ['runner.mjs','request-worker.mjs','request-hook.mjs','wasm-host.mjs','migrations.mjs','crypto.mjs','time.mjs','host-protocol.json','record-events.mjs'];
const protocol = JSON.parse(await readFile(new URL('host-protocol.json', source), 'utf8'));
if (protocol.nativeProtocol !== 1 || protocol.recordEvents !== 1) throw new Error('Use a SoftN checkout supporting native hosting protocol 1.');
const expected = JSON.parse(await readFile(new URL('../formlogic/ui/vendor/zipp-wasm/SOURCE.json', import.meta.url), 'utf8'));
const identity = JSON.parse(await readFile(new URL('SOURCE.json', wasm), 'utf8'));
const hash = createHash('sha256').update(await readFile(new URL('zipp_wasm_bg.wasm', wasm))).digest('hex');
if (identity.version !== expected.version || identity.sha256 !== expected.sha256 || hash !== expected.sha256) throw new Error('Native runtime must use the same verified ZIPP release as FormLogic.');
await mkdir(new URL('wasm/', target), { recursive: true });
const hashes = {};
for (const name of modules) {
  const bytes = await readFile(new URL(name, source));
  await writeFile(new URL(name, target), bytes);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}
for (const [from, to] of [['zipp_wasm.js','wasm/zipp_wasm.mjs'],['zipp_wasm_bg.wasm','wasm/zipp_wasm_bg.wasm'],['SOURCE.json','wasm/SOURCE.json']]) {
  await copyFile(new URL(from, wasm), new URL(to, target));
}
for (const name of ['LICENSE','NOTICE']) await copyFile(new URL(name, repository), new URL(name, target));
await writeFile(new URL('provenance.json',target), JSON.stringify({ source:'softn.com/apps/softn-php/runtime',nativeProtocol:1,zipp:identity,modules:hashes },null,2)+'\n');
console.log('Prepared native app runtime: '+fileURLToPath(target));
