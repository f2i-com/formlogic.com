import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertNoInterruptedPromotion, checkEntryDocuments, checkRuntimeArtifact, checkZippTree, runtimeIdentity } from './hosted-runtime-artifact.mjs';
assertNoInterruptedPromotion(fileURLToPath(new URL('../../../', import.meta.url)));
// vendor/zipp-wasm is generated: the Softn release's zipp/ tree, installed by the fetch.
let source;
try {
  source = JSON.parse(await readFile(new URL('../vendor/zipp-wasm/SOURCE.json', import.meta.url), 'utf8'));
  await checkZippTree(fileURLToPath(new URL('../vendor/zipp-wasm/', import.meta.url)), source);
} catch (error) {
  throw new Error(`The ZIPP browser engine (formlogic/ui/vendor/zipp-wasm) is missing or is not a ZIPP release. Run node scripts/fetch-softn-release.mjs from the repository root (or node scripts/sync-zipp-from-softn.mjs against a Softn source checkout). ${error.message}`);
}
try {
  await checkRuntimeArtifact(fileURLToPath(new URL('../public/hosted-runtime/', import.meta.url)), runtimeIdentity(source));
} catch (error) {
  throw new Error(`Hosted app runtime is missing, incomplete or out of date. Run node scripts/fetch-softn-release.mjs from the repository root (or npm run build:hosted-runtime against a Softn source checkout). ${error.message}`);
}
// The two entry documents HostedAppFrame mounts by name, and the attribute that is the whole
// difference between their policies.
try {
  await checkEntryDocuments(fileURLToPath(new URL('../public/hosted-runtime/', import.meta.url)));
} catch (error) {
  throw new Error(`The hosted app runtime's entry documents are not the two this FormLogic serves. Run node scripts/fetch-softn-release.mjs from the repository root (or npm run build:hosted-runtime against a Softn source checkout). ${error.message}`);
}
