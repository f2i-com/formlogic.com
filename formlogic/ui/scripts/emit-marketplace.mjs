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
// The catalog is lazy (per-pack dynamic imports); esbuild inlines them when bundling without
// splitting, so loadAllPacks() resolves everything from the single bundled module.
const { loadAllPacks } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const packCatalog = await loadAllPacks();

// Folder catalogues are independently editable sources. Refresh their screens
// only when explicitly requested; never replace an operator's app/database/flows
// as a side effect of the legacy marketplace build.
const folderIndex = process.argv.indexOf('--folder-screens');
if (folderIndex !== -1) {
  const id = process.argv[folderIndex + 1];
  const entry = packCatalog.find(pack => pack.id === id);
  if (!entry || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Provide a known pack ID after --folder-screens');
  const vendorKey = loadVendorKey();
  if (!vendorKey) throw new Error('A vendor signing key is required to refresh folder screens. No files changed.');
  const folder = join(here, '..', '..', 'backend', 'resources', 'packs', id);
  const target = join(folder, 'install.json');
  const installed = JSON.parse(readFileSync(target, 'utf8'));
  const legacyTarget = join(here, '..', '..', 'backend', 'resources', 'marketplace-packs', id + '.json');
  const legacy = JSON.parse(readFileSync(legacyTarget, 'utf8'));
  const metadata = JSON.parse(readFileSync(join(folder, 'pack.json'), 'utf8'));
  if (installed.packMeta?.id !== id || metadata.id !== id || installed.packMeta?.version !== metadata.version) {
    throw new Error('Folder pack identity/version does not match');
  }
  let refreshed = 0;
  for (const form of installed.forms) {
    const source = entry.pack.forms.find(candidate => candidate.packFormId === form.packFormId);
    if (!source?.customScreen) continue;
    form.customScreen = source.customScreen;
    const legacyForm = legacy.pack.forms.find(candidate => candidate.packFormId === form.packFormId);
    if (legacyForm) legacyForm.customScreen = source.customScreen;
    refreshed++;
  }
  if (!refreshed) throw new Error('No matching form screens to refresh');
  // Sign the final folder payload, including any app screens already there.
  // PHP still verifies the signature and each component's executable digest.
  installed.signing = buildPackSigning(installed, vendorKey);
  legacy.pack.signing = buildPackSigning(legacy.pack, vendorKey);
  writeFileSync(target, JSON.stringify(installed, null, 2) + '\n');
  writeFileSync(legacyTarget, JSON.stringify(legacy, null, 2));
  console.log(`Refreshed ${refreshed} screens and signed ${id}; forms, flows and app projects preserved.`);
  process.exit(0);
}

const outDir = join(here, '..', '..', 'backend', 'resources', 'marketplace-packs');
mkdirSync(outDir, { recursive: true });

// Vendor signing (APP-501): per-component screen digests signed with the
// first-party Ed25519 key when this machine holds it — a direct JSON import
// of an unmodified pack then stamps custom_screen_trust 'verified' instead
// of 'untrusted'. No key = unsigned packs (imports stay untrusted, honestly).
const vendorKey = loadVendorKey();
if (!vendorKey) console.warn('⚠️  no vendor key at ~/.formlogic-signing/formlogic-packs-2026a.json — emitting UNSIGNED packs');

for (const entry of packCatalog) {
  // The manifest's version MIRRORS the payload's packMeta.version — a drift means someone bumped
  // one without the other, which would ship a store listing lying about what installs.
  const payloadVersion = entry.pack?.packMeta?.version;
  if (entry.version !== payloadVersion) {
    console.error(`✗ ${entry.id}: manifest.json version '${entry.version}' != packMeta.version '${payloadVersion}'`);
    process.exit(1);
  }
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

// Public, credential-free summaries keep the starter gallery browsable without the API.
const summaries = packCatalog.map(entry => ({
  id: 'bundled-' + entry.id, slug: entry.id, name: entry.name, description: entry.description,
  icon: entry.icon || null, tags: entry.tags || [], screenshot:null, screenshots:[], category:null,
  visibility:'public', status:'published', downloadCount:0, avgRating:0, ratingCount:0,
  featured:entry.id === 'aokie-receptionist', publisherId:'', publisherName:'FormLogic',
  latestVersion:entry.version, formatVersion:1, formCount:entry.pack.forms.length,
  appCount:(entry.pack.apps || []).length, createdAt:'', updatedAt:'', versions:[],
  formTitles:entry.pack.forms.map(form => form.title), appNames:(entry.pack.apps || []).map(app => app.name),
}));
writeFileSync(join(here, '..', 'src', 'data', 'starter-catalog.json'), JSON.stringify(summaries, null, 2) + '\n');
