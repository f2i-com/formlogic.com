// Explicitly refresh the small, dependency-free adapter from the sibling SoftN
// repository. Production builds use this committed copy and need no sibling repo.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = new URL('../../../../softn.com/packages/@softn/core/src/integrations/formlogic.ts', import.meta.url);
const destination = new URL('../src/lib/softn/', import.meta.url);
const content = await readFile(source, 'utf8');
await mkdir(destination, { recursive: true });
await writeFile(new URL('project.ts', destination), '// Vendored from SoftN. Refresh with node scripts/sync-softn.mjs.\n' + content);
await writeFile(new URL('provenance.json', destination), JSON.stringify({ source: 'softn.com/packages/@softn/core/src/integrations/formlogic.ts', license: 'Apache-2.0', sha256: createHash('sha256').update(content).digest('hex') }, null, 2) + '\n');
await writeFile(new URL('LICENSE', destination), await readFile(new URL('../../../../softn.com/LICENSE', import.meta.url)));
await writeFile(new URL('NOTICE', destination), await readFile(new URL('../../../../softn.com/NOTICE', import.meta.url)));
console.log('SoftN FormLogic adapter synchronized.');
