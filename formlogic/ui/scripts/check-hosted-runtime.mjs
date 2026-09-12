import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkRuntimeArtifact, runtimeIdentity } from './hosted-runtime-artifact.mjs';
try {
  const source = JSON.parse(await readFile(new URL('../vendor/zipp-wasm/SOURCE.json', import.meta.url), 'utf8'));
  await checkRuntimeArtifact(fileURLToPath(new URL('../public/hosted-runtime/', import.meta.url)), runtimeIdentity(source));
} catch (error) {
  throw new Error(`Hosted app runtime is missing, incomplete or out of date. Run npm run build:hosted-runtime with the sibling softn.com dependencies installed. ${error.message}`);
}
