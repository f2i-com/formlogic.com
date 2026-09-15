// Explicitly refresh the small, dependency-free adapter from Softn. Production
// builds use this committed copy and need no sibling repo.
//
// Two sources: the sibling softn.com checkout (this script run directly), or
// the `adapter/` folder of a Softn release archive (scripts/fetch-softn-release.mjs
// --sync-adapter, which calls writeAdapter with the archive's bytes). Both go
// through writeAdapter so the committed copy and its provenance are produced
// one way.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';

export const ADAPTER_SOURCE = 'softn.com/packages/@softn/core/src/integrations/formlogic.ts';
const DEFAULT_DESTINATION = new URL('../src/lib/softn/', import.meta.url);

/** The digest recorded in provenance.json: the adapter body with LF line endings. */
export function adapterDigest(content) {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Write project.ts, provenance.json, LICENSE and NOTICE from the adapter's
 * source text and the repository's licence files. LF on both sides: the
 * digest recorded here is compared by scripts/ecosystem-manifest.mjs and
 * scripts/fetch-softn-release.mjs against the Softn source, on Windows (CRLF
 * checkouts) and in CI (LF) alike.
 */
export async function writeAdapter({ content, license, notice, destination = DEFAULT_DESTINATION }) {
  destination = destination instanceof URL ? destination : pathToFileURL(resolve(destination) + sep);
  const body = content.replace(/\r\n/g, '\n');
  await mkdir(destination, { recursive: true });
  await writeFile(new URL('project.ts', destination), '// Vendored from SoftN. Refresh with node scripts/sync-softn.mjs.\n' + body);
  const sha256 = adapterDigest(body);
  await writeFile(new URL('provenance.json', destination), JSON.stringify({ source: ADAPTER_SOURCE, license: 'Apache-2.0', sha256 }, null, 2) + '\n');
  await writeFile(new URL('LICENSE', destination), license);
  await writeFile(new URL('NOTICE', destination), notice);
  return sha256;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const softn = process.env.SOFTN_REPO ? new URL(`file:///${resolve(process.env.SOFTN_REPO).replace(/\\/g, '/')}/`) : new URL('../../../../softn.com/', import.meta.url);
  await writeAdapter({
    content: await readFile(new URL('packages/@softn/core/src/integrations/formlogic.ts', softn), 'utf8'),
    license: await readFile(new URL('LICENSE', softn)),
    notice: await readFile(new URL('NOTICE', softn)),
  });
  console.log('SoftN FormLogic adapter synchronized.');
}
