// SOFTN_REPO source mode: install the ZIPP release a Softn checkout has
// installed (packages/@softn/core/wasm-zipp, generated there from a ZIPP
// release by `npm run fetch:zipp`) as formlogic/ui/vendor/zipp-wasm, the same
// tree a Softn release archive's zipp/ installs — and, when that install
// records a web variant (wasm-zipp/SOURCE.json `variants.web`, with the
// checkout's wasm-zipp-web/ beside it), the variant as
// formlogic/ui/vendor/zipp-wasm-web, the archive's zipp-web/ tree, under the
// same variant check scripts/fetch-softn-release.mjs applies. A checkout whose
// install records no variant retires a web tree a previous sync or install
// left, as a release without one does: the UI build globs that directory, so
// a stale variant would otherwise be embedded under an identity the installed
// engine never recorded. Never build or pick a second, different engine here:
// releases install it with scripts/fetch-softn-release.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkZippTree, checkZippVariantTree, ZIPP_TREE_REQUIRED } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

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
 * move fail). The engine tree and the web variant tree are one generation:
 * both are staged and checked before either destination is touched, each
 * previous tree is kept beside its destination until the new ones are in place
 * and checked, and both are put back if either is not. `webDestination` is
 * where the variant installs (or is retired from); by default the `-web`
 * sibling of `destination`, as formlogic/ui/vendor/zipp-wasm-web is of
 * formlogic/ui/vendor/zipp-wasm. Returns the engine tree's SOURCE.json.
 */
export async function syncZippFromSoftn({
  softnRepo = process.env.SOFTN_REPO ? resolve(process.env.SOFTN_REPO) : resolve(here, '../../softn.com'),
  destination = resolve(here, '../formlogic/ui/vendor/zipp-wasm'),
  webDestination = `${destination}-web`,
  log = console.log,
  ops = {},
} = {}) {
  const io = { rename, cp, rm, ...ops };
  const parent = dirname(destination);
  if (dirname(webDestination) !== parent || webDestination === destination) throw new Error(`The web variant tree must be a sibling of the engine tree: ${webDestination} is not beside ${destination}.`);
  const trees = {
    engine: { destination, previous: `${destination}.previous`, stagePrefix: `.${basename(destination)}-` },
    web: { destination: webDestination, previous: `${webDestination}.previous`, stagePrefix: `.${basename(webDestination)}-` },
  };
  // A sync that died mid-swap left a tree set aside and nothing in its place: put it back first (a
  // stale web tree too, which this run then retires again if the checkout records no variant).
  for (const tree of Object.values(trees)) {
    if (!existsSync(tree.destination) && existsSync(tree.previous)) {
      await moveDir(tree.previous, tree.destination, io);
      log(`Restored ${tree.destination} from an interrupted sync`);
    }
  }

  const sourceDir = resolve(softnRepo, 'packages/@softn/core/wasm-zipp');
  const webSourceDir = resolve(softnRepo, 'packages/@softn/core/wasm-zipp-web');
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
  // The web variant, when the install records one: the checkout's wasm-zipp-web/, which Softn's
  // fetch:zipp generates beside wasm-zipp/ from the same ZIPP release. A record naming a variant
  // with no tree to install is refused here, as an archive that records zipp.variants.web without
  // a zipp-web/ tree is; a wasm-zipp-web/ the record does not describe is simply not installed.
  const webVariant = record.variants?.web;
  if (webVariant !== undefined && !existsSync(webSourceDir)) throw new Error(`${hint} Its wasm-zipp/SOURCE.json records variants.web but it has no wasm-zipp-web/ tree beside wasm-zipp/.`);
  // The variant tree carries no RELEASE-SHA256SUMS; the check reads the primary's, as the archive path does.
  const releaseSums = webVariant !== undefined ? await readFile(resolve(sourceDir, 'RELEASE-SHA256SUMS')) : null;
  const checkVariant = async (dir) => {
    try { await checkZippVariantTree(dir, webVariant, record, { releaseSums }); }
    catch (error) { throw new Error(`${hint} Its wasm-zipp-web/ is not the ZIPP ${record.release} web variant its wasm-zipp/SOURCE.json records: ${error.message}`); }
  };

  await mkdir(parent, { recursive: true });
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && Object.values(trees).some((tree) => entry.name.startsWith(tree.stagePrefix))) await rm(resolve(parent, entry.name), { recursive: true, force: true });
  }
  // The whole install, as the archive's zipp/ carries it; checkZippTree refuses anything that is not
  // the release's. The variant beside it, as the archive's zipp-web/; checkZippVariantTree refuses
  // anything that is not that release's web build.
  const staged = await mkdtemp(resolve(parent, trees.engine.stagePrefix));
  let stagedWeb = null;
  try {
    await cp(sourceDir, staged, { recursive: true });
    const source = await checkZippTree(staged, record);
    if (webVariant !== undefined) {
      stagedWeb = await mkdtemp(resolve(parent, trees.web.stagePrefix));
      await cp(webSourceDir, stagedWeb, { recursive: true });
      await checkVariant(stagedWeb);
    }

    for (const tree of Object.values(trees)) await io.rm(tree.previous, { recursive: true, force: true });
    const hadPrevious = { engine: existsSync(destination), web: existsSync(webDestination) };
    // Each destination is set aside just before it is replaced (or retired), so a failure knows
    // exactly which trees to put back.
    const setAside = [];
    try {
      setAside.push('engine');
      if (hadPrevious.engine) await moveDir(destination, trees.engine.previous, io);
      await moveDir(staged, destination, io);
      await checkZippTree(destination, record);
      if (webVariant !== undefined) {
        setAside.push('web');
        if (hadPrevious.web) await moveDir(webDestination, trees.web.previous, io);
        await moveDir(stagedWeb, webDestination, io);
        await checkVariant(webDestination);
      } else if (hadPrevious.web) {
        // Retired: set aside like the others and never replaced, so a failure below puts it back and
        // a success removes it with the other previous trees.
        setAside.push('web');
        await moveDir(webDestination, trees.web.previous, io);
        log(`retired ${webDestination}: the checkout's ZIPP ${source.release} records no web variant`);
      }
    } catch (error) {
      try {
        for (const name of setAside.reverse()) {
          await io.rm(trees[name].destination, { recursive: true, force: true });
          if (hadPrevious[name]) await moveDir(trees[name].previous, trees[name].destination, io);
        }
      } catch (restoreError) {
        throw new Error(`Installing ZIPP ${source.release} at ${destination} failed (${error.message}), and putting the previous trees back failed too (${restoreError.message}). They are kept at ${setAside.map((name) => trees[name].previous).join(' and ')}; run the sync again.`);
      }
      throw error;
    }
    // The new trees stand; an old copy that cannot be removed now is removed by the next sync or fetch.
    for (const tree of Object.values(trees)) await io.rm(tree.previous, { recursive: true, force: true }).catch((error) => log(`Left ${tree.previous} behind: ${error.message}`));
    log(`Synced ZIPP ${source.release} (${source.revision.slice(0, 12)}, engine ${source.sha256.slice(0, 12)}) from ${sourceDir}${webVariant !== undefined ? `, and its web variant (${webVariant.sha256.slice(0, 12)}) from ${webSourceDir}` : ''}`);
    return source;
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    if (stagedWeb) await rm(stagedWeb, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await syncZippFromSoftn(); }
  catch (error) { console.error(`sync-zipp-from-softn: ${error.message}`); process.exit(1); }
}
