#!/usr/bin/env node
/**
 * The site's ZIPP: the engine FormLogic's own page and form-logic worker run, the one its page
 * hands the app frame and the editors, the one its /zipp/ folder publishes (publish-zipp.mjs),
 * and the one its server sandbox is built from. Installed as formlogic/ui/vendor/zipp (and its
 * siblings zipp-web, the JavaScript-only variant, and zipp-torch, the torch package).
 *
 *   node scripts/site-zipp.mjs           install it
 *   node scripts/site-zipp.mjs --check   verify the install, offline
 *
 * By default it is the installed Softn release's own (formlogic/ui/vendor/zipp-wasm, copied), so
 * nothing changes. With a pin (zipp-release.json at the repository's root: a ZIPP release and the
 * sha256 of its SHA256SUMS) it is that release, installed by the ZIPP installer the Softn release
 * carries (zipp-tools/, Softn v0.0.38 on), with every check Softn makes of a ZIPP release: so
 * FormLogic can take a newer ZIPP without a new Softn. The Softn release's runtime and editors
 * run it in the browser (host-zipp/1); the Softn release's own trees (vendor/zipp-wasm, the hosted
 * runtime, the editors, the native runtime an app's backend runs on) stay as Softn shipped them.
 * A pinned ZIPP whose glue lacks a name Softn's runtime calls, or a Softn release that cannot run
 * a ZIPP of the site's own, is refused before anything changes. A Softn source checkout
 * (SOFTN_REPO, developer mode) builds a runtime that declares nothing, so there the pin is set
 * aside, said so, and the checkout's ZIPP runs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive } from './lib/archive.mjs';
import { checkZippTorchTree, checkZippTree, checkZippVariantTree } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

export const PIN_FILE = 'zipp-release.json';
const HEX64 = /^[0-9a-f]{64}$/;
const TAG = /^v\d+\.\d+\.\d+$/;
const SOFTN_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class SiteZippError extends Error {}
const refuse = (message) => { throw new SiteZippError(message); };

export function sitePaths(root) {
  const vendor = resolve(root, 'formlogic/ui/vendor');
  return {
    root,
    pin: resolve(root, PIN_FILE),
    site: resolve(vendor, 'zipp'), siteWeb: resolve(vendor, 'zipp-web'), siteTorch: resolve(vendor, 'zipp-torch'),
    softn: resolve(vendor, 'zipp-wasm'), softnWeb: resolve(vendor, 'zipp-wasm-web'),
    hostedRuntime: resolve(root, 'formlogic/ui/public/hosted-runtime'),
    appEditors: resolve(root, 'formlogic/ui/public/app-editors'),
    releases: resolve(root, '.runtime-source/softn-release'),
    downloads: resolve(root, '.runtime-source/zipp-release'),
    // Staging outside ui/: Vite's watcher holds a fresh folder there, and Windows then refuses its renames.
    staging: resolve(root, '.runtime-source/site-zipp-stage'),
    record: resolve(root, '.runtime-source/site-zipp.json'),
  };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * The site's ZIPP record (formlogic/ui/vendor/zipp/SOURCE.json), or null before it is installed:
 * what the server sandbox is built from and the expression corpus is held to, so a form's logic
 * runs on one ZIPP in the browser and on the server.
 */
export function siteZippSource(root) {
  const file = resolve(sitePaths(root).site, 'SOURCE.json');
  return existsSync(file) ? readJson(file) : null;
}

/** An installed Softn release record (current.json) with the site's ZIPP in place of its own, where the site's is installed. */
export function withSiteZipp(current, root) {
  const site = siteZippSource(root);
  return site && current ? { ...current, zipp: site } : current;
}

/** Whether this is a Softn source checkout build (developer mode), where a pin is set aside. */
export const sourceMode = (env = process.env) => Boolean(env.SOFTN_REPO);

/** The pin, or null: `{ release: 'vX.Y.Z', sumsSha256 }`. A pin that says anything else is refused. */
export function readPin(root) {
  const file = sitePaths(root).pin;
  if (!existsSync(file)) return null;
  let pin;
  try { pin = readJson(file); } catch (error) { refuse(`${PIN_FILE} is not JSON: ${error.message}`); }
  if (!TAG.test(pin?.release ?? '') || !HEX64.test(pin?.sumsSha256 ?? '')) refuse(`${PIN_FILE} must name a ZIPP release (vX.Y.Z) and the sha256 of its SHA256SUMS (sumsSha256, 64 lowercase hex)`);
  return { release: pin.release, sumsSha256: pin.sumsSha256 };
}

/** The pin this run applies: none in a Softn source checkout, which builds a runtime that declares nothing. */
function activePin(root, log = () => {}) {
  const pin = readPin(root);
  if (pin && sourceMode()) { log(`${PIN_FILE} is set aside in a Softn source checkout (SOFTN_REPO): the checkout's ZIPP runs.`); return null; }
  return pin;
}

/** The names a glue exports, read from its text (wasm-bindgen writes `export function`, `export class` and `export default`). */
export function glueExports(text) {
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of match[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (name) names.add(name); }
  if (/^export\s+default\b/m.test(text)) names.add('default');
  return names;
}

/**
 * Whether the installed Softn runtime and editors run a ZIPP other than their own, and the names
 * its glue must export: refused, by name, when they cannot (a Softn release before v0.0.36) or
 * when `glue` lacks one of the names.
 */
export function assertRunsSiteZipp(paths, glue, release) {
  const runtime = readJson(resolve(paths.hostedRuntime, 'runtime-manifest.json'));
  const editors = readJson(resolve(paths.appEditors, 'manifest.json'));
  if (!runtime.features?.includes('host-zipp/1') || !editors.features?.includes('host-zipp/1')) {
    refuse(`The installed Softn runtime and editors cannot run a ZIPP of the site's own (they lack host-zipp/1): ZIPP ${release} would be refused by every app. Install Softn v0.0.38 or later, or remove ${PIN_FILE}.`);
  }
  const needed = Array.isArray(runtime.zippGlueExports) && runtime.zippGlueExports.length ? runtime.zippGlueExports : editors.zippGlueExports;
  if (!Array.isArray(needed) || !needed.length) refuse('The installed Softn runtime does not say what a ZIPP glue must export (zippGlueExports); install Softn v0.0.38 or later.');
  const exported = glueExports(glue);
  const missing = needed.filter((name) => !exported.has(name));
  if (missing.length) refuse(`ZIPP ${release}'s glue does not export ${missing.join(', ')}, which the installed Softn runtime calls: this ZIPP is not one it runs.`);
}

/**
 * The installed Softn release's archive: kept beside current.json when it was downloaded, or where
 * current.json's `source` says for a local one (SOFTN_RELEASE_ARCHIVE). Whichever of the two has
 * the digest current.json records.
 */
function installedArchive(paths) {
  const current = existsSync(resolve(paths.releases, 'current.json')) ? readJson(resolve(paths.releases, 'current.json')) : null;
  if (!SOFTN_TAG.test(current?.tag ?? '') || !/^[\w.-]+\.zip$/.test(current?.archive ?? '') || !HEX64.test(current?.sha256 ?? '')) refuse('No Softn release is installed (.runtime-source/softn-release/current.json); run node scripts/fetch-softn-release.mjs first.');
  const candidates = [
    typeof current.source === 'string' && !/^https?:/i.test(current.source) ? resolve(paths.root, current.source) : null,
    resolve(paths.releases, current.tag, current.archive),
  ].filter((file) => file && existsSync(file));
  for (const file of candidates) {
    const bytes = readFileSync(file);
    if (sha256(bytes) === current.sha256) return { tag: current.tag, bytes };
  }
  refuse(`The archive of the installed Softn release ${current.tag} (${current.sha256.slice(0, 12)}) is not kept; run node scripts/fetch-softn-release.mjs again.`);
}

/** The Softn release's ZIPP installer (zipp-tools/), unpacked beside its archive, every name held inside the folder. */
function unpackInstaller(paths) {
  const { tag, bytes } = installedArchive(paths);
  const { entries } = readArchive(bytes);
  const tools = [...entries.keys()].filter((name) => name.startsWith('zipp-tools/') && !name.endsWith('/'));
  if (!tools.includes('zipp-tools/scripts/fetch-zipp-release.mjs')) refuse(`Softn ${tag} carries no ZIPP installer (zipp-tools/, Softn v0.0.38 on): it cannot install a ZIPP of the site's own. Install a later Softn release, or remove ${PIN_FILE}.`);
  const base = resolve(paths.releases, tag);
  const dir = resolve(base, 'zipp-tools');
  rmSync(dir, { recursive: true, force: true });
  for (const name of tools) {
    const out = resolve(base, name);
    if (!out.startsWith(dir + sep)) refuse(`Softn ${tag}'s archive names ${name}, outside zipp-tools/.`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, entries.get(name).data);
  }
  return { tag, script: resolve(dir, 'scripts/fetch-zipp-release.mjs') };
}

/** A rename Windows refuses for a moment (an indexer, an antivirus, a watcher) is tried again, then done as copy and remove. */
function move(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try { renameSync(from, to); return; } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EXDEV'].includes(error.code)) throw error;
      if (attempt === 5 || error.code === 'EXDEV') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
    }
  }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}

/**
 * Puts the staged trees in place of the site's. Every old tree is set aside first, then every new
 * one placed; on a failure the new ones placed are removed and every old one is put back. If that
 * fails too, the old trees are kept where they were set aside and the error says where.
 */
function promote(paths, stage) {
  const pairs = [['zipp', paths.site], ['zipp-web', paths.siteWeb], ['zipp-torch', paths.siteTorch]];
  const old = resolve(stage, 'old');
  mkdirSync(old, { recursive: true });
  const setAside = [];
  const placed = [];
  try {
    for (const [name, destination] of pairs) if (existsSync(destination)) { move(destination, resolve(old, name)); setAside.push([name, destination]); }
    for (const [name, destination] of pairs) if (existsSync(resolve(stage, name))) { move(resolve(stage, name), destination); placed.push(destination); }
  } catch (error) {
    try {
      for (const destination of placed) rmSync(destination, { recursive: true, force: true });
      for (const [name, destination] of setAside) if (!existsSync(destination)) move(resolve(old, name), destination);
    } catch (restoreError) {
      throw new SiteZippError(`The site's ZIPP could not be put in place (${error.message}), and putting the previous one back failed too (${restoreError.message}). It is kept at ${old}; move its folders back into formlogic/ui/vendor.`);
    }
    throw error;
  }
  rmSync(stage, { recursive: true, force: true });
}

/**
 * The trees in `dirs` hold one ZIPP release, with its web variant and torch package where it
 * records them: the full checks of a release's trees for a pinned ZIPP (the installer's output),
 * the digests for a copy of the Softn release's (whose trees its installer checked).
 */
async function checkTrees(dirs, { full }) {
  const site = await checkZippTree(dirs.site);
  const releaseSums = existsSync(resolve(dirs.site, 'RELEASE-SHA256SUMS')) ? readFileSync(resolve(dirs.site, 'RELEASE-SHA256SUMS')) : null;
  if (site.variants?.web) {
    if (full) await checkZippVariantTree(dirs.siteWeb, site.variants.web, site, { releaseSums });
    else {
      const web = resolve(dirs.siteWeb, 'zipp_wasm_bg.wasm');
      if (!existsSync(web) || sha256(readFileSync(web)) !== site.variants.web.sha256) refuse(`The site's web variant (formlogic/ui/vendor/zipp-web) is not the one ZIPP ${site.release} records.`);
    }
  } else if (existsSync(dirs.siteWeb)) refuse(`formlogic/ui/vendor/zipp-web is present, and ZIPP ${site.release} records no web variant.`);
  if (site.packages?.torch) {
    if (full) await checkZippTorchTree(dirs.siteTorch, site.packages.torch, site, { releaseSums });
    else {
      const torch = resolve(dirs.siteTorch, 'zipp_torch.wasm');
      if (!existsSync(torch) || sha256(readFileSync(torch)) !== site.packages.torch.sha256) refuse(`The site's torch package (formlogic/ui/vendor/zipp-torch) is not the one ZIPP ${site.release} records.`);
    }
  } else if (existsSync(dirs.siteTorch)) refuse(`formlogic/ui/vendor/zipp-torch is present, and ZIPP ${site.release} records no torch package.`);
  return site;
}

/** The Softn release's torch package: the runtime's copy, or a source checkout's own, held to the record. */
function softnTorch(paths, softn) {
  const record = softn.packages?.torch;
  if (!record) return null;
  const candidates = [resolve(paths.hostedRuntime, 'assets/core-runtime/zipp_torch.wasm')];
  if (process.env.SOFTN_REPO) candidates.push(resolve(process.env.SOFTN_REPO, 'packages/@softn/core/wasm-zipp-torch/zipp_torch.wasm'));
  for (const file of candidates) if (existsSync(file) && sha256(readFileSync(file)) === record.sha256) return file;
  refuse(`The Softn release's torch package (${record.sha256.slice(0, 12)}) is not installed: the hosted runtime carries no copy with that digest. Run node scripts/fetch-softn-release.mjs${process.env.SOFTN_REPO ? ', or npm run build:hosted-runtime against the checkout' : ''}.`);
}

/**
 * Installs the site's ZIPP: the Softn release's, or the pinned one (left as it is when it is
 * already the pinned release and the Softn runtime still runs it). Returns the record it keeps in
 * .runtime-source/site-zipp.json.
 */
export async function installSiteZipp({ root, log = console.log, node = process.execPath } = {}) {
  const paths = sitePaths(root);
  const pin = activePin(root, log);
  const softn = readJson(resolve(paths.softn, 'SOURCE.json'));
  if (pin) {
    try {
      const { site } = await checkSiteZipp({ root });
      if (site.release === pin.release && site.sumsSha256 === pin.sumsSha256) {
        log(`The site runs ZIPP ${site.release} (${site.sha256.slice(0, 12)}), its own, already installed.`);
        return writeRecord(paths, pin, site, softn);
      }
    } catch (error) { if (!(error instanceof SiteZippError) && error?.code !== 'ENOENT') throw error; }
  }
  // A stage a run that was stopped left behind goes first.
  rmSync(paths.staging, { recursive: true, force: true });
  const stage = resolve(paths.staging, randomBytes(4).toString('hex'));
  const dirs = { site: resolve(stage, 'zipp'), siteWeb: resolve(stage, 'zipp-web'), siteTorch: resolve(stage, 'zipp-torch') };
  mkdirSync(stage, { recursive: true });
  try {
    if (!pin) {
      cpSync(paths.softn, dirs.site, { recursive: true });
      if (existsSync(paths.softnWeb)) cpSync(paths.softnWeb, dirs.siteWeb, { recursive: true });
      const torch = softnTorch(paths, softn);
      if (torch) { mkdirSync(dirs.siteTorch, { recursive: true }); cpSync(torch, resolve(dirs.siteTorch, 'zipp_torch.wasm')); }
    } else {
      const installer = unpackInstaller(paths);
      log(`Installing ZIPP ${pin.release} for the site with the installer Softn ${installer.tag} carries ...`);
      const run = spawnSync(node, [installer.script, pin.release], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, ZIPP_OUT: dirs.site, ZIPP_CACHE_DIR: paths.downloads, ZIPP_SUMS_SHA256: pin.sumsSha256, ZIPP_RELEASE: pin.release, ZIPP_RELEASE_DIR: process.env.ZIPP_RELEASE_DIR ?? '' },
      });
      if (run.status !== 0) refuse(`ZIPP ${pin.release} was not installed: ${(run.stderr || run.stdout || '').trim().split('\n').pop()}`);
      assertRunsSiteZipp(paths, readFileSync(resolve(dirs.site, 'zipp_wasm.js'), 'utf8'), pin.release);
    }
    const site = await checkTrees(dirs, { full: Boolean(pin) });
    if (pin && (site.release !== pin.release || site.sumsSha256 !== pin.sumsSha256)) refuse(`The installed ZIPP is ${site.release} (${String(site.sumsSha256).slice(0, 12)}); ${PIN_FILE} names ${pin.release} (${pin.sumsSha256.slice(0, 12)}).`);
    promote(paths, stage);
    if (existsSync(paths.staging) && !readdirSync(paths.staging).length) rmSync(paths.staging, { recursive: true, force: true });
    const record = writeRecord(paths, pin, site, softn);
    log(pin
      ? `The site runs ZIPP ${site.release} (${site.sha256.slice(0, 12)}), its own; the Softn release's runtime and editors (built with ZIPP ${softn.release}) run it in the browser, and an app's backend stays on ZIPP ${softn.release}.`
      : `The site runs the Softn release's ZIPP ${site.release} (${site.sha256.slice(0, 12)}).`);
    return record;
  } finally {
    // Not the old trees promote() kept after a failed restore: it says where they are.
    if (existsSync(stage) && !existsSync(resolve(stage, 'old'))) rmSync(stage, { recursive: true, force: true });
  }
}

function writeRecord(paths, pin, site, softn) {
  const record = { formatVersion: 1, source: pin ? 'pin' : 'softn', release: site.release, revision: site.revision, sha256: site.sha256, glueSha256: site.glueSha256, sumsSha256: site.sumsSha256 ?? null, softnZipp: { release: softn.release, sha256: softn.sha256 } };
  mkdirSync(dirname(paths.record), { recursive: true });
  writeFileSync(paths.record, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * Verifies the site's ZIPP offline: one ZIPP release with its variant and torch package, the
 * pinned release where there is a pin and the Softn release's otherwise, and, where it is not the
 * Softn release's, a Softn runtime and editors that run it. Returns `{ site, softn, differs }`,
 * the two SOURCE.json records.
 */
export async function checkSiteZipp({ root } = {}) {
  const paths = sitePaths(root);
  if (!existsSync(resolve(paths.site, 'SOURCE.json'))) refuse('The site\'s ZIPP is not installed (formlogic/ui/vendor/zipp); run node scripts/fetch-softn-release.mjs (or node scripts/site-zipp.mjs).');
  const softn = readJson(resolve(paths.softn, 'SOURCE.json'));
  const pin = activePin(root);
  const site = await checkTrees({ site: paths.site, siteWeb: paths.siteWeb, siteTorch: paths.siteTorch }, { full: Boolean(pin) && siteZippSource(root)?.sha256 !== softn.sha256 });
  if (pin && (site.release !== pin.release || site.sumsSha256 !== pin.sumsSha256)) refuse(`The site runs ZIPP ${site.release}; ${PIN_FILE} names ${pin.release}. Run node scripts/site-zipp.mjs.`);
  if (!pin && site.sha256 !== softn.sha256) refuse(`The site runs ZIPP ${site.release} (${site.sha256.slice(0, 12)}), and ${sourceMode() ? 'in a Softn source checkout' : `with no ${PIN_FILE}`} it must be the Softn release's (${softn.sha256.slice(0, 12)}). Run node scripts/site-zipp.mjs.`);
  const differs = site.sha256 !== softn.sha256;
  if (differs) assertRunsSiteZipp(paths, readFileSync(resolve(paths.site, 'zipp_wasm.js'), 'utf8'), site.release);
  return { site, softn, differs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    if (process.argv.includes('--check')) {
      const { site, differs } = await checkSiteZipp({ root });
      console.log(`The site runs ZIPP ${site.release} (${site.sha256.slice(0, 12)})${differs ? ', its own' : ', the Softn release\'s'}, installed and intact.`);
    } else await installSiteZipp({ root });
  } catch (error) {
    if (error instanceof SiteZippError) { console.error(`site-zipp: ${error.message}`); process.exit(1); }
    throw error;
  }
}
