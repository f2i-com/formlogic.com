import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { runtimeIdentity, assertMatchingRuntime, writeRuntimeManifest, checkRuntimeArtifact } from './hosted-runtime-artifact.mjs';
import { EDITOR_BRIDGE_PROTOCOL } from './softn-protocol.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = fileURLToPath(new URL('../', import.meta.url));
const softn = process.env.SOFTN_REPO ? await realpath(process.env.SOFTN_REPO) : await realpath(resolve(ui, '../../../softn.com'));
const publicDir = await realpath(resolve(ui, 'public'));
const output = resolve(publicDir, 'app-editors');
if (dirname(output) !== publicDir || basename(output) !== 'app-editors') throw new Error('Unexpected editor output.');
if ((await lstat(output).catch(() => null))?.isSymbolicLink()) throw new Error('Editor output must not be a link.');
await access(resolve(softn, 'apps/shared/hostedEditor.ts'));
const expected = runtimeIdentity(JSON.parse(await readFile(resolve(ui, 'vendor/zipp-wasm/SOURCE.json'), 'utf8')));
assertMatchingRuntime(runtimeIdentity(JSON.parse(await readFile(resolve(softn, 'packages/@softn/core/wasm-zipp/SOURCE.json'), 'utf8'))), expected);
const stage = await mkdtemp(resolve(publicDir, '.app-editors-'));
try {
  for (const kind of ['builder', 'studio']) {
    const result = spawnSync(process.execPath, [resolve(softn, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', resolve(stage, kind)], {
      cwd: resolve(softn, `apps/softn-${kind}`), stdio: 'inherit',
      env: { ...process.env, VITE_BASE: `/app-editors/${kind}/`, VITE_FORMLOGIC_EDITOR: '1', TAURI_ENV_PLATFORM: '' },
    });
    if (result.status !== 0) throw new Error(`${kind} build failed.`);
    await access(resolve(stage, kind, 'index.html'));
  }
  await writeFile(resolve(stage, 'manifest.json'), JSON.stringify({ protocol: EDITOR_BRIDGE_PROTOCOL, editors: ['builder', 'studio'], builtAt: new Date().toISOString() }) + '\n');
  await cp(resolve(softn, 'LICENSE'), resolve(stage, 'LICENSE'));
  await cp(resolve(softn, 'NOTICE'), resolve(stage, 'NOTICE'));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(stage, output, { recursive: true, filter: path => !path.endsWith('.map') });
  for (const kind of ['builder', 'studio']) {
    await writeRuntimeManifest(resolve(output, kind), expected);
    await checkRuntimeArtifact(resolve(output, kind), expected);
  }
  console.log('FormLogic app editors built and verified at public/app-editors.');
} finally {
  const resolved = await realpath(stage);
  if (dirname(resolved) !== publicDir || !basename(resolved).startsWith('.app-editors-')) throw new Error('Unexpected editor staging directory.');
  await rm(resolved, { recursive: true, force: true });
}
