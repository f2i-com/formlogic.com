// Emit the static marketplace packs (authored in TypeScript under src/data/packs) to JSON the
// PHP backend can read, so the same packs can be seeded into the catalog and provisioned into the
// Demo account. Run with Node 24 (strips the type-only imports): `node scripts/emit-marketplace.mjs`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

// Bundle the TS pack catalog in-memory (type-only imports are dropped), then import it as a data: URL.
const bundled = await build({
  entryPoints: [join(here, '..', 'src', 'data', 'packs', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});
const code = bundled.outputFiles[0].text;
const { packCatalog } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const outDir = join(here, '..', '..', 'backend', 'resources', 'marketplace-packs');
mkdirSync(outDir, { recursive: true });

for (const entry of packCatalog) {
  // Store the full catalog entry (id, name, description, tags, icon) alongside the pack payload,
  // so the provisioner has the marketplace metadata plus the installable pack in one file.
  const record = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    icon: entry.icon,
    pack: entry.pack,
  };
  writeFileSync(join(outDir, entry.id + '.json'), JSON.stringify(record, null, 2));
  const apps = entry.pack.apps || [];
  const withScreen = apps.filter((a) => a.customScreen && a.customScreen.enabled).length;
  console.log(`wrote ${entry.id}: ${entry.pack.forms.length} forms, ${apps.length} apps (${withScreen} with screens)`);
}
console.log(`\nEmitted ${packCatalog.length} packs to ${outDir}`);
