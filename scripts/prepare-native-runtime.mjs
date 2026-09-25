// Assemble trusted SoftN backend code and the shared ZIPP release for FormLogic.
// Application uploads never supply any of these runtime modules.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { NATIVE_PROTOCOL, RECORD_EVENTS_PROTOCOL } from '../formlogic/ui/scripts/softn-protocol.mjs';
import { relativeImports } from './release-runtime.mjs';
const repository = process.env.SOFTN_REPO ? pathToFileURL(resolve(process.env.SOFTN_REPO) + sep) : new URL('../../softn.com/', import.meta.url);
const source = new URL('apps/softn-host-php/runtime/', repository);
const wasm = new URL('packages/@softn/core/wasm-zipp/', repository);
const target = new URL('../formlogic/backend/resources/softn-native/', import.meta.url);
const modules = ['runner.mjs','request-worker.mjs','request-hook.mjs','wasm-host.mjs','migrations.mjs','crypto.mjs','time.mjs','host-protocol.json','record-events.mjs'];
const protocol = JSON.parse(await readFile(new URL('host-protocol.json', source), 'utf8'));
if (protocol.nativeProtocol !== NATIVE_PROTOCOL || protocol.recordEvents !== RECORD_EVENTS_PROTOCOL) throw new Error(`Use a SoftN checkout supporting native hosting protocol ${NATIVE_PROTOCOL} (record events ${RECORD_EVENTS_PROTOCOL}).`);
// Both engine trees are generated: the checkout's by `npm run fetch:zipp`, FormLogic's by sync-zipp-from-softn.
const syncHint = 'Run npm run fetch:zipp in the Softn checkout, then node scripts/sync-zipp-from-softn.mjs here.';
const expected = JSON.parse(await readFile(new URL('../formlogic/ui/vendor/zipp-wasm/SOURCE.json', import.meta.url), 'utf8').catch(() => { throw new Error(`formlogic/ui/vendor/zipp-wasm is not installed. ${syncHint}`); }));
const identity = JSON.parse(await readFile(new URL('SOURCE.json', wasm), 'utf8').catch(() => { throw new Error(`The Softn checkout has no packages/@softn/core/wasm-zipp install. ${syncHint}`); }));
const hash = createHash('sha256').update(await readFile(new URL('zipp_wasm_bg.wasm', wasm))).digest('hex');
if (identity.version !== expected.version || identity.sha256 !== expected.sha256 || hash !== expected.sha256) throw new Error(`Native runtime must use the same verified ZIPP release as FormLogic's browser engine. ${syncHint}`);
await mkdir(new URL('wasm/', target), { recursive: true });
const hashes = {};
// The fixed modules, then every sibling module they import (sql.mjs since Softn v0.0.16), so a
// module the runtime gained is prepared and recorded rather than left for the worker to miss.
const pending = [...modules];
while (pending.length) {
  const name = pending.shift();
  if (name in hashes) continue;
  const bytes = await readFile(new URL(name, source));
  await writeFile(new URL(name, target), bytes);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  if (name.endsWith('.mjs')) for (const specifier of relativeImports(bytes.toString('utf8'))) {
    if (/^\.\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.mjs$/.test(specifier)) pending.push(specifier.slice(2));
  }
}
for (const [from, to] of [['zipp_wasm.js','wasm/zipp_wasm.mjs'],['zipp_wasm_bg.wasm','wasm/zipp_wasm_bg.wasm'],['SOURCE.json','wasm/SOURCE.json']]) {
  await copyFile(new URL(from, wasm), new URL(to, target));
}
for (const name of ['LICENSE','NOTICE']) await copyFile(new URL(name, repository), new URL(name, target));
// The notices go by the name SOURCE.json records, as Softn's packager takes them.
await copyFile(new URL(identity.notices?.file ?? 'THIRD_PARTY_LICENSES.txt', wasm), new URL('ZIPP-THIRD-PARTY-LICENSES.txt', target));
await writeFile(new URL('provenance.json',target), JSON.stringify({ source:'softn.com/apps/softn-host-php/runtime',nativeProtocol:NATIVE_PROTOCOL,zipp:identity,modules:hashes },null,2)+'\n');
console.log('Prepared native app runtime: '+fileURLToPath(target));
