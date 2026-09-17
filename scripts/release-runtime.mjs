import { open, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkRuntimeArtifact, isZippEngineWasm } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Where a UI build puts the engine assets the page itself fetches: Vite's hashed copy of each vendor engine. */
const APP_ENGINE_ASSET = /^assets\/zipp_wasm_bg-[^/]+\.wasm$/;

/**
 * Every ZIPP engine a UI build emitted, found by its exports whatever Vite
 * named it, is the installed release's (`source`, the engine tree's
 * SOURCE.json), and the app's own hashed copy is among them. Links, and the
 * top-level folders in `skip` (the staged backend), are not followed. Returns
 * the engines found, as `label`-relative paths.
 *
 * `web` is the installed release's web variant record (`source.variants.web`)
 * when the vendor tree formlogic/ui/vendor/zipp-wasm-web is installed, or
 * null. With it, the build must ALSO carry the variant — as one more hashed
 * `assets/zipp_wasm_bg-*.wasm`, the asset the page's second byte broker
 * fetches, and there alone: the hosted runtime and the editors carry only the
 * primary, and a variant under any other name is a second engine nobody
 * serves. Without it, a second digest anywhere is refused as it always was.
 */
export async function checkDistEngines(directory, source, { label = 'formlogic/ui/dist', skip = ['api'], web = null } = {}) {
  const engines = [];
  const webCopies = [];
  const walk = async prefix => {
    for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (prefix || !skip.includes(entry.name)) await walk(path); continue; }
      if (!entry.isFile()) continue;
      // Only a file that starts like wasm is read whole.
      const handle = await open(resolve(directory, path), 'r');
      let magic;
      try { magic = await handle.read(Buffer.alloc(4), 0, 4, 0); } finally { await handle.close(); }
      if (magic.bytesRead < 4 || magic.buffer.readUInt32BE(0) !== 0x0061736d) continue;
      const bytes = await readFile(resolve(directory, path));
      if (!isZippEngineWasm(bytes)) continue;
      const digest = sha256(bytes);
      if (web && digest === web.sha256) {
        if (!APP_ENGINE_ASSET.test(path)) throw new Error(`${label}/${path} is the installed ZIPP ${source.release ?? source.version} web variant (${digest.slice(0, 12)}) under a name other than the app's hashed engine asset (assets/zipp_wasm_bg-*.wasm); the variant is served from that asset alone. Rebuild the UI after node scripts/fetch-softn-release.mjs`);
        webCopies.push(path);
        engines.push(path);
        continue;
      }
      if (digest !== source.sha256) throw new Error(`${label}/${path} is a ZIPP engine (${digest.slice(0, 12)}) other than the installed ZIPP ${source.release ?? source.version} (${source.sha256.slice(0, 12)})${web ? ` or its web variant (${web.sha256.slice(0, 12)})` : ''}; rebuild the UI after node scripts/fetch-softn-release.mjs`);
      engines.push(path);
    }
  };
  await walk('');
  engines.sort();
  // Sorted for the same reason `engines` is. These names reach a person only
  // inside an error message, and `readdir` returns them in whatever order the
  // filesystem keeps: a case-insensitive one puts `-again` before `-DJYZzo8n`
  // and a case-sensitive one does the opposite. Left unsorted, a test pinning
  // that message passes on the machine it was written on and fails on the
  // other kind.
  webCopies.sort();
  const appCopies = engines.filter(path => APP_ENGINE_ASSET.test(path) && !webCopies.includes(path));
  if (!appCopies.length) throw new Error(`${label} has no assets/zipp_wasm_bg-*.wasm engine (found: ${engines.join(', ') || 'none'})`);
  if (web) {
    if (!webCopies.length) throw new Error(`${label} has no assets/zipp_wasm_bg-*.wasm carrying the installed ZIPP ${source.release ?? source.version} web variant (${web.sha256.slice(0, 12)}); the build predates the variant's install (found: ${engines.join(', ')}). Rebuild the UI after node scripts/fetch-softn-release.mjs`);
    if (webCopies.length > 1) throw new Error(`${label} carries the ZIPP web variant twice (${webCopies.join(', ')}); the page fetches one asset for it`);
  }
  return engines;
}

/** zipp-licenses.txt: the engine tree's third-party notices (the file its SOURCE.json names), then ZIPP's own LICENSE-APACHE. */
export async function zippLicensesText(directory, source) {
  if (typeof source.notices?.file !== 'string') throw new Error('The ZIPP engine tree\'s SOURCE.json names no notices file.');
  const read = name => readFile(resolve(directory, name), 'utf8').catch(() => { throw new Error(`formlogic/ui/vendor/zipp-wasm/${name} is missing; the zip must carry the ZIPP engine's licences`); });
  const notices = await read(source.notices.file);
  const license = await read('LICENSE-APACHE');
  const rule = '='.repeat(78);
  return `${notices.trimEnd()}\n\n${rule}\nZIPP ${source.release ?? source.version} (${source.repository ?? 'https://github.com/f2i-com/zipp.org'}) LICENSE-APACHE\n${rule}\n\n${license}`;
}

/**
 * engine-identity.json: which ZIPP release the zip carries, the Softn release it
 * came from (none for a source checkout), and, from the server sandbox's
 * bin/runtime/SOURCE.json, the ZIPP release its guest was built from and the
 * digests of that guest and of each launcher embedding it.
 */
export function engineIdentity(source, softnRelease, sandbox = null) {
  return {
    zipp: softnRelease ? softnRelease.zipp : source,
    softnRelease: softnRelease ? { tag: softnRelease.tag, archiveSha256: softnRelease.sha256 } : null,
    serverSandbox: sandbox ? {
      zipp: { release: sandbox.zipp.release, revision: sandbox.zipp.revision },
      guestSha256: sandbox.guest.sha256,
      launchers: Object.fromEntries(sandbox.launchers.map(launcher => [launcher.artifact, launcher.sha256])),
      build: { by: sandbox.build.by, runUrl: sandbox.build.runUrl ?? null },
    } : null,
  };
}

export async function checkReleaseRuntime(directory, expected) {
  const manifest = await checkRuntimeArtifact(directory, expected);
  if (Object.keys(manifest.files).some(file => file.endsWith('.map'))) {
    throw new Error('The hosted runtime contains development source maps. Rebuild it before packaging.');
  }
  if (!Object.keys(manifest.files).some(file => /^assets\/.+\.js$/.test(file))) {
    throw new Error('The hosted runtime JavaScript bundle is missing.');
  }
  if (manifest.files['assets/core-runtime/zipp_wasm_bg.wasm'] !== expected.sha256) {
    throw new Error('The hosted runtime ZIPP binary is missing or incompatible.');
  }
  return manifest;
}

export { checkAppEditors } from '../formlogic/ui/scripts/check-app-editors.mjs';
import { NATIVE_PROTOCOL, RECORD_EVENTS_PROTOCOL } from '../formlogic/ui/scripts/softn-protocol.mjs';

export async function checkNativeRuntime(directory, expected) {
  const provenance = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
  const protocol = JSON.parse(await readFile(resolve(directory, 'host-protocol.json'), 'utf8'));
  if (provenance.nativeProtocol !== NATIVE_PROTOCOL || protocol.nativeProtocol !== NATIVE_PROTOCOL || protocol.recordEvents !== RECORD_EVENTS_PROTOCOL || provenance.zipp?.sha256 !== expected.sha256 || provenance.zipp?.version !== expected.version) throw new Error('The native app runtime is incompatible. Run node scripts/prepare-native-runtime.mjs.');
  for (const name of ['runner.mjs','request-worker.mjs','request-hook.mjs','wasm-host.mjs','migrations.mjs','crypto.mjs','time.mjs','host-protocol.json','record-events.mjs','wasm/zipp_wasm_bg.wasm']) {
    const hash = createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex');
    if (hash !== (name.endsWith('.wasm') ? expected.sha256 : provenance.modules?.[name])) throw new Error(`Native runtime module is missing or changed: ${name}`);
  }
  await readFile(resolve(directory, 'wasm/zipp_wasm.mjs'));
}
