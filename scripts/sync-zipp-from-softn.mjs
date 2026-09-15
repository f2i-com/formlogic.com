// SOFTN_REPO source mode: install the ZIPP release a Softn checkout has
// installed (packages/@softn/core/wasm-zipp, generated there from a ZIPP
// release by `npm run fetch:zipp`) as formlogic/ui/vendor/zipp-wasm, the same
// tree a Softn release archive's zipp/ installs. Never build or pick a second,
// different engine here: releases install it with scripts/fetch-softn-release.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkZippTree, ZIPP_TREE_REQUIRED } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REFUSED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** A rename Windows can refuse for a moment while a scanner or watcher holds the folder: a few short retries. */
async function renameRetrying(from, to, ops) {
  for (let attempt = 1; ; attempt++) {
    try { return await ops.rename(from, to); }
    catch (error) {
      if (!REFUSED.has(error.code) || attempt === 5) throw error;
      await new Promise((settle) => setTimeout(settle, 20 * attempt));
    }
  }
}

/**
 * Move a directory. Vite's watcher holds a fresh folder under ui/ as soon as it
 * appears, so a rename Windows keeps refusing falls back to copying into `to`
 * and then removing `from` (as scripts/fetch-softn-release.mjs moves its trees).
 */
async function moveDir(from, to, ops) {
  try { return await renameRetrying(from, to, ops); }
  catch (error) { if (!REFUSED.has(error.code) && error.code !== 'EXDEV') throw error; }
  await ops.cp(from, to, { recursive: true });
  await ops.rm(from, { recursive: true, force: true });
}

/**
 * `ops` replaces the filesystem operations the swap goes through (tests make a
 * move fail). The previous tree is kept beside the destination until the new
 * one is in place and checked, and put back if it is not.
 */
export async function syncZippFromSoftn({
  softnRepo = process.env.SOFTN_REPO ? resolve(process.env.SOFTN_REPO) : resolve(here, '../../softn.com'),
  destination = resolve(here, '../formlogic/ui/vendor/zipp-wasm'),
  log = console.log,
  ops = {},
} = {}) {
  const io = { rename, cp, rm, ...ops };
  const parent = dirname(destination);
  const previous = `${destination}.previous`;
  const stagePrefix = `.${basename(destination)}-`;
  // A sync that died mid-swap left the old tree set aside and nothing in its place: put it back first.
  if (!existsSync(destination) && existsSync(previous)) {
    await moveDir(previous, destination, io);
    log(`Restored ${destination} from an interrupted sync`);
  }

  const sourceDir = resolve(softnRepo, 'packages/@softn/core/wasm-zipp');
  const fetcher = resolve(softnRepo, 'packages/@softn/core/scripts/fetch-zipp-release.mjs');
  const hint = `The Softn checkout's wasm-zipp/ is generated: run npm run fetch:zipp there first (${softnRepo}).`;
  if (!existsSync(fetcher)) throw new Error(`${hint} This checkout has no packages/@softn/core/scripts/fetch-zipp-release.mjs; it predates Softn installing ZIPP from a release.`);
  // Softn's own offline check of its install against the ZIPP release sums.
  const checked = spawnSync(process.execPath, [fetcher, '--check'], { cwd: softnRepo, encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(`${hint} fetch-zipp-release.mjs --check failed: ${(checked.stderr || checked.stdout || checked.error?.message || '').trim()}`);
  let record;
  try { record = JSON.parse(await readFile(resolve(sourceDir, 'SOURCE.json'), 'utf8')); }
  catch (error) { throw new Error(`${hint} Its wasm-zipp/SOURCE.json is missing or unreadable: ${error.message}`); }
  // The notices go by the name SOURCE.json records, as Softn's packager and checkZippTree take them.
  const required = [...ZIPP_TREE_REQUIRED, ...(typeof record.notices?.file === 'string' ? [record.notices.file] : [])];
  const missing = required.filter((name) => !existsSync(resolve(sourceDir, name)));
  if (missing.length) throw new Error(`${hint} Its wasm-zipp/ lacks ${missing.join(', ')}.`);

  await mkdir(parent, { recursive: true });
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(stagePrefix)) await rm(resolve(parent, entry.name), { recursive: true, force: true });
  }
  // The whole install, as the archive's zipp/ carries it; checkZippTree refuses anything that is not the release's.
  const staged = await mkdtemp(resolve(parent, stagePrefix));
  try {
    await cp(sourceDir, staged, { recursive: true });
    const source = await checkZippTree(staged, record);

    await io.rm(previous, { recursive: true, force: true });
    const hadPrevious = existsSync(destination);
    if (hadPrevious) await moveDir(destination, previous, io);
    try {
      await moveDir(staged, destination, io);
      await checkZippTree(destination, record);
    } catch (error) {
      try {
        await io.rm(destination, { recursive: true, force: true });
        if (hadPrevious) await moveDir(previous, destination, io);
      } catch (restoreError) {
        throw new Error(`Installing ZIPP ${source.release} at ${destination} failed (${error.message}), and putting the previous tree back failed too (${restoreError.message}). It is kept at ${previous}; run the sync again.`);
      }
      throw error;
    }
    // The new tree stands; an old copy that cannot be removed now is removed by the next sync or fetch.
    await io.rm(previous, { recursive: true, force: true }).catch((error) => log(`Left ${previous} behind: ${error.message}`));
    log(`Synced ZIPP ${source.release} (${source.revision.slice(0, 12)}, engine ${source.sha256.slice(0, 12)}) from ${sourceDir}`);
    return source;
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await syncZippFromSoftn(); }
  catch (error) { console.error(`sync-zipp-from-softn: ${error.message}`); process.exit(1); }
}
