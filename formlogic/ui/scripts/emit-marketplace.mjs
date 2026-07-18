// Emit the static marketplace packs (authored in TypeScript under src/data/packs) to JSON the
// PHP backend can read, so the same packs can be seeded into the catalog and provisioned into the
// Demo account. Run with Node 24 (strips the type-only imports): `node scripts/emit-marketplace.mjs`.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { buildPackSigning, loadVendorKey } from './packSigning.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Vite-style `?raw` imports (pack modules import screen .tsx/.css sources as strings) for the
// node-side esbuild bundle of the pack TS. Mirrors check-pack-screens.mjs.
const rawPlugin = {
  name: 'vite-raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

// Bundle the TS pack catalog in-memory (type-only imports are dropped), then import it as a data: URL.
const bundled = await build({
  entryPoints: [join(here, '..', 'src', 'data', 'packs', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  plugins: [rawPlugin],
});
const code = bundled.outputFiles[0].text;
const { packCatalog } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const outDir = join(here, '..', '..', 'backend', 'resources', 'marketplace-packs');
mkdirSync(outDir, { recursive: true });

// Vendor signing (APP-501): per-component screen digests signed with the
// first-party Ed25519 key when this machine holds it — a direct JSON import
// of an unmodified pack then stamps custom_screen_trust 'verified' instead
// of 'untrusted'. No key = unsigned packs (imports stay untrusted, honestly).
const vendorKey = loadVendorKey();
if (!vendorKey) console.warn('⚠️  no vendor key at ~/.formlogic-signing/formlogic-packs-2026a.json — emitting UNSIGNED packs');

for (const entry of packCatalog) {
  // Store the full catalog entry (id, name, description, tags, icon) alongside the pack payload,
  // so the provisioner has the marketplace metadata plus the installable pack in one file.
  const signing = buildPackSigning(entry.pack, vendorKey);
  const record = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    icon: entry.icon,
    // `signing` travels INSIDE the pack so it survives every install path
    // (catalog download, direct JSON import, backup round trip).
    pack: signing ? { ...entry.pack, signing } : entry.pack,
  };
  writeFileSync(join(outDir, entry.id + '.json'), JSON.stringify(record, null, 2));
  const apps = entry.pack.apps || [];
  const withScreen = apps.filter((a) => a.customScreen && a.customScreen.enabled).length;
  console.log(`wrote ${entry.id}: ${entry.pack.forms.length} forms, ${apps.length} apps (${withScreen} with screens)`);
}
console.log(`\nEmitted ${packCatalog.length} packs to ${outDir}`);
