// Refresh the two editable starter snapshots from the same checkout used to build the editors.
// The installed PHP application serves these files directly, including on hosts without npm.
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await realpath(process.env.SOFTN_REPO || resolve(root, '../softn.com'));
const fromSource = createRequire(resolve(source, 'package.json'));
const { createServer } = await import(pathToFileURL(fromSource.resolve('vite')).href);
const { starterVendorsPlugin } = await import(pathToFileURL(resolve(source, 'scripts/build/starter-vendors.mjs')).href);
const server = await createServer({
  root: source, configFile: false, appType: 'custom', publicDir: false,
  server: { middlewareMode: true, hmr: false }, plugins: [starterVendorsPlugin()],
});

try {
  const shared = '/packages/@softn/editor-shared/src/';
  const { createWebStarter } = await server.ssrLoadModule(shared + 'webStarters.ts');
  const { prepareWebSourceFiles } = await server.ssrLoadModule(shared + 'webSourceCompiler.ts');
  const notice = await readFile(resolve(source, 'NOTICE'), 'utf8');
  const license = await readFile(resolve(source, 'LICENSE'), 'utf8');
  for (const [framework, id] of [['react', 'react-jsx'], ['vue', 'vue-sfc']]) {
    const authored = await createWebStarter(id, { name: 'My app' });
    const files = Object.fromEntries(await prepareWebSourceFiles(new Map(authored.map(file => [file.path, file.content]))));
    const attribution = '/*\n' + notice + '\n' + license + '\n*/\n';
    files['vendor/' + framework + '.js'] = attribution + files['vendor/' + framework + '.js'];
    const snapshot = { manifest: JSON.parse(files['manifest.json']), files };
    delete files['manifest.json'];
    const target = resolve(root, 'formlogic/backend/resources/web-app-starter', framework + '.json');
    await writeFile(target, JSON.stringify(snapshot, null, 2) + '\n');
  }
} finally {
  await server.close();
}
