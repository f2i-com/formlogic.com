import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkRuntimeArtifact } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

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

export async function checkNativeRuntime(directory, expected) {
  const provenance = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
  const protocol = JSON.parse(await readFile(resolve(directory, 'host-protocol.json'), 'utf8'));
  if (provenance.nativeProtocol !== 1 || protocol.nativeProtocol !== 1 || protocol.recordEvents !== 1 || provenance.zipp?.sha256 !== expected.sha256 || provenance.zipp?.version !== expected.version) throw new Error('The native app runtime is incompatible. Run node scripts/prepare-native-runtime.mjs.');
  for (const name of ['runner.mjs','request-worker.mjs','request-hook.mjs','wasm-host.mjs','migrations.mjs','crypto.mjs','time.mjs','host-protocol.json','record-events.mjs','wasm/zipp_wasm_bg.wasm']) {
    const hash = createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex');
    if (hash !== (name.endsWith('.wasm') ? expected.sha256 : provenance.modules?.[name])) throw new Error(`Native runtime module is missing or changed: ${name}`);
  }
  await readFile(resolve(directory, 'wasm/zipp_wasm.mjs'));
}
