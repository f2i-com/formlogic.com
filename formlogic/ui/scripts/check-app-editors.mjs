import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntimeArtifact, runtimeIdentity } from './hosted-runtime-artifact.mjs';

export async function checkAppEditors(directory, expected) {
  const metadata = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (metadata.protocol !== 1 || JSON.stringify(metadata.editors) !== JSON.stringify(['builder', 'studio'])) throw new Error('Unsupported app editor bridge protocol.');
  for (const editor of metadata.editors) {
    const artifact = await checkRuntimeArtifact(resolve(directory, editor), expected);
    const wasm = Object.entries(artifact.files).filter(([path]) => /zipp_wasm_bg(?:-[^/]+)?\.wasm$/.test(path));
    if (!wasm.length || wasm.some(([, hash]) => hash !== expected.sha256)) throw new Error(`${editor} uses an incompatible ZIPP engine.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = runtimeIdentity(JSON.parse(await readFile(new URL('../vendor/zipp-wasm/SOURCE.json', import.meta.url), 'utf8')));
  try { await checkAppEditors(fileURLToPath(new URL('../public/app-editors/', import.meta.url)), expected); }
  catch (error) { throw new Error(`App editors are missing or out of date. Run npm run build:app-editors with the compatible Softn checkout. ${error.message}`); }
}
