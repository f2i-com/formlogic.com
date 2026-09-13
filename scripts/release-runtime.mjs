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
