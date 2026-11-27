import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoInterruptedPromotion, checkRuntimeArtifact, checkZippTree, runtimeIdentity } from './hosted-runtime-artifact.mjs';
import { EDITOR_BRIDGE_PROTOCOL } from './softn-protocol.mjs';

const SHARED_CONTAINER_RUNTIME_RE = /\/hosted-runtime\/assets\/container-runtime\/([0-9a-f]{12})\//g;

/** The fetcher validates promoted trees with this while its promotion journal exists, so the journal check belongs to the CLI below. */
export async function checkAppEditors(directory, expected) {
  const metadata = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (metadata.protocol !== EDITOR_BRIDGE_PROTOCOL || JSON.stringify(metadata.editors) !== JSON.stringify(['builder', 'studio'])) throw new Error('Unsupported app editor bridge protocol.');
  const hostedRuntimeDir = resolve(dirname(directory), 'hosted-runtime');
  const hasHostedRuntime = await access(resolve(hostedRuntimeDir, 'runtime-manifest.json')).then(() => true, () => false);
  for (const editor of metadata.editors) {
    const editorDir = resolve(directory, editor);
    const artifact = await checkRuntimeArtifact(editorDir, expected);
    // From Softn v0.0.35 an editor carries no engine: the page gives it the one it downloaded
    // when it connects (AppEditorDialog). One carried by an earlier release has to be the release's.
    const wasm = Object.entries(artifact.files).filter(([path]) => /zipp_wasm_bg(?:-[^/]+)?\.wasm$/.test(path));
    if (wasm.some(([, hash]) => hash !== expected.sha256)) throw new Error(`${editor} uses an incompatible ZIPP engine.`);
    // Embedded editors built against FormLogic share /hosted-runtime/assets/container-runtime/<digest>/
    // with public/hosted-runtime/. When that sibling tree exists, ensure the digest matches so
    // previews never 404 on container-worker.js or engine .wasm/.glue.js files.
    if (hasHostedRuntime) {
      const digests = new Set();
      for (const filePath of Object.keys(artifact.files)) {
        if (!/^assets\/.*\.m?js$/.test(filePath)) continue;
        const source = await readFile(resolve(editorDir, filePath), 'utf8');
        for (const match of source.matchAll(SHARED_CONTAINER_RUNTIME_RE)) digests.add(match[1]);
      }
      for (const digest of digests) {
        const worker = resolve(hostedRuntimeDir, 'assets/container-runtime', digest, 'container-worker.js');
        const present = await access(worker).then(() => true, () => false);
        if (!present) {
          throw new Error(`${editor} expects shared container runtime ${digest} in public/hosted-runtime/assets/container-runtime/${digest}/, which is missing. Rebuild both hosted-runtime and app-editors together (npm run build:hosted-runtime && npm run build:app-editors).`);
        }
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNoInterruptedPromotion(fileURLToPath(new URL('../../../', import.meta.url)));
  let expected;
  try {
    const source = JSON.parse(await readFile(new URL('../vendor/zipp-wasm/SOURCE.json', import.meta.url), 'utf8'));
    expected = runtimeIdentity(await checkZippTree(fileURLToPath(new URL('../vendor/zipp-wasm/', import.meta.url)), source));
  } catch (error) { throw new Error(`The ZIPP browser engine (formlogic/ui/vendor/zipp-wasm) is missing or is not a ZIPP release. Run node scripts/fetch-softn-release.mjs from the repository root (or node scripts/sync-zipp-from-softn.mjs against a Softn source checkout). ${error.message}`); }
  try { await checkAppEditors(fileURLToPath(new URL('../public/app-editors/', import.meta.url)), expected); }
  catch (error) { throw new Error(`App editors are missing or out of date. Run node scripts/fetch-softn-release.mjs from the repository root (or npm run build:app-editors against a Softn source checkout). ${error.message}`); }
}
