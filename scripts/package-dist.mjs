#!/usr/bin/env node
/**
 * FormLogic — distributable zip packager.
 *
 * Builds the single-domain release zip that `form-builder/ui/public/.htaccess` documents:
 *
 *   <zip root>/            the BUILT ui (contents of form-builder/ui/dist: index.html, assets/, .htaccess, ...)
 *   <zip root>/api/        the backend (front controller api/public/index.php), production-filtered
 *   <zip root>/install.php the browser install/upgrade wizard (form-builder/install.php; it detects
 *                          the bundle layout via the api/ folder beside it — delete after installing)
 *   <zip root>/INSTALL.txt fresh-install steps (wizard first, manual fallback)
 *   <zip root>/UPGRADE.txt existing-install steps (wizard upgrade mode / api/bin/upgrade.php + docs/UPGRADING.md)
 *   <zip root>/VERSION     version string (also copied to <zip root>/api/VERSION)
 *
 * Version resolution: git tag vX.Y.Z at HEAD (stripped "v") when building a tag, else "<short-sha>-<yyyymmdd>".
 *
 * Used by BOTH CI (.github/workflows/package.yml) and local devs (Windows Git Bash + Linux).
 * Node builtins only — no npm deps at the repo root. External tools it shells out to:
 * npm (UI build), composer (backend prod vendor/), git (version), zip OR PowerShell (archive).
 *
 * Usage:
 *   node scripts/package-dist.mjs [--skip-ui-build] [--no-install] [--out <dir>] [--keep-staging] [--version <v>]
 *
 *   --skip-ui-build  reuse the existing form-builder/ui/dist (must exist and contain .htaccess)
 *   --no-install     skip `npm ci` before the UI build (reuse existing node_modules)
 *   --out <dir>      output directory (default: <repo>/dist-package)
 *   --keep-staging   keep the staging directory next to the zip for inspection
 *   --version <v>    override the resolved version string
 *
 * The working tree is never mutated: the backend is COPIED into staging and
 * `composer install --no-dev` runs against that copy, so the dev vendor/ is untouched.
 * (The UI build itself writes ui/dist and syncs the prelude via its normal prebuild step.)
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(repoRoot, 'form-builder', 'ui');
const distDir = path.join(uiDir, 'dist');
const backendDir = path.join(repoRoot, 'form-builder', 'backend');

// ---------------------------------------------------------------------------
// Backend production filter (the pinned packaging contract).
//
// COPY (allowlist) — everything the app needs at runtime:
//   bin/        maintenance CLIs (upgrade.php, idempotency-cleanup.php, webhook-worker.php,
//               reconcile.php) + the vendored static qjs binaries (bin/qjs/) the QuickJS
//               script runtime shells out to.
//   config/     settings.php
//   database/   schema.sql + migrate.php (schema files only — no runtime SQLite lives here;
//               per-form SQLite DBs live under storage/forms which ships EMPTY)
//   public/     the front controller (api/public/index.php) + .htaccess
//   resources/  formlogic prelude/harness JS, cacert.pem, marketplace packs, sample apps
//   src/        the application
//   composer.json + composer.lock (vendor/ is installed FRESH with --no-dev in staging)
//   .env.example (shipped; the real .env is created by the installer, never shipped)
//
// EXCLUDE (never ships):
//   tests/ phpunit.xml .phpunit.cache  — dev/test only
//   .env                               — secrets
//   logs/* storage/*                   — runtime data (the empty skeleton IS recreated below)
//   scripts/                           — dev/demo provisioning (provision-demo.php)
//   vendor/                            — dev vendor may contain dev deps; replaced by a fresh
//                                        `composer install --no-dev --optimize-autoloader`
//   README.md                          — developer doc, not needed at runtime
//
// SKELETON (created empty, with a .gitkeep placeholder so every zip backend —
// PowerShell Compress-Archive in particular — preserves the empty directories):
// these are exactly the dirs the code expects (settings.php sqlite storage_path
// = storage/forms, packs storagePath = storage/packs, FileStorageService =
// storage/uploads, pack screenshots = storage/pack-screenshots, Monolog = logs/;
// mirrors the e2e.yml "storage dirs" step).
// ---------------------------------------------------------------------------
const BACKEND_COPY_DIRS = ['bin', 'config', 'database', 'public', 'resources', 'src'];
// .htaccess: FilesMatch-scoped secrets deny (defense in depth inside api/ — the web-root
// .htaccess is the primary guard; this one keeps .env/SQLite safe even without it).
const BACKEND_COPY_FILES = ['composer.json', 'composer.lock', '.env.example', '.htaccess'];
const BACKEND_SKELETON_DIRS = [
  'logs',
  'storage/forms',
  'storage/packs',
  'storage/uploads',
  'storage/pack-screenshots',
];

// --- tiny CLI ---------------------------------------------------------------
const cli = { skipUiBuild: false, noInstall: false, keepStaging: false, out: null, version: null };
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skip-ui-build') cli.skipUiBuild = true;
    else if (a === '--no-install') cli.noInstall = true;
    else if (a === '--keep-staging') cli.keepStaging = true;
    else if (a === '--out') cli.out = args[++i];
    else if (a.startsWith('--out=')) cli.out = a.slice('--out='.length);
    else if (a === '--version') cli.version = args[++i];
    else if (a.startsWith('--version=')) cli.version = a.slice('--version='.length);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/package-dist.mjs [--skip-ui-build] [--no-install] [--out <dir>] [--keep-staging] [--version <v>]');
      process.exit(0);
    } else {
      fail(`Unknown argument: ${a} (see --help)`);
    }
  }
  if (cli.out === undefined || cli.out === '') fail('--out requires a directory argument');
  if (cli.version === undefined || cli.version === '') fail('--version requires a value');
}

let stepNo = 0;
function step(msg) {
  stepNo += 1;
  console.log(`\n==> [${stepNo}] ${msg}`);
}
function info(msg) {
  console.log(`    ${msg}`);
}
function fail(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

/** Quote an argument for the Windows shell (only needed because .cmd/.bat shims
 *  like npm/composer require shell:true on Windows since CVE-2024-27980). */
function winQuote(arg) {
  return /[\s"^&|<>]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Run a command, streaming output; hard-fails the build on a non-zero exit. */
function run(cmd, args, opts = {}) {
  info(`$ ${cmd} ${args.join(' ')}${opts.cwd ? `   (in ${path.relative(repoRoot, opts.cwd) || '.'})` : ''}`);
  const spawnOpts = {
    stdio: 'inherit',
    cwd: opts.cwd || repoRoot,
    env: { ...process.env, ...(opts.env || {}) },
  };
  // npm/composer are .cmd/.bat shims on Windows, which Node refuses to spawn directly
  // (CVE-2024-27980) — run them through the shell as ONE pre-quoted command string
  // (avoids DEP0190: args arrays are concatenated unescaped under shell:true).
  const res = isWindows
    ? spawnSync([cmd, ...args.map(winQuote)].join(' '), { ...spawnOpts, shell: true })
    : spawnSync(cmd, args, spawnOpts);
  if (res.error) fail(`failed to run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} ${args[0] ?? ''} exited with code ${res.status}`);
}

/** Run a command and capture stdout (empty string on any failure). */
function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: opts.cwd || repoRoot, encoding: 'utf8', shell: false });
  if (res.error || res.status !== 0) return '';
  return (res.stdout || '').trim();
}

function commandExists(cmd, probeArgs) {
  const res = spawnSync(cmd, probeArgs, { stdio: 'ignore', shell: false });
  return !res.error && res.status === 0;
}

// --- version ----------------------------------------------------------------
function resolveVersion() {
  if (cli.version) return cli.version;
  // CI tag build: GITHUB_REF_NAME is the tag (workflow triggers on v*).
  if (process.env.GITHUB_REF_TYPE === 'tag' && /^v\d/.test(process.env.GITHUB_REF_NAME || '')) {
    return process.env.GITHUB_REF_NAME.slice(1);
  }
  // Local build of a tagged commit.
  const tagAtHead = capture('git', ['tag', '--points-at', 'HEAD', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .find((t) => /^v\d/.test(t));
  if (tagAtHead) return tagAtHead.slice(1);
  // Untagged: short SHA + date.
  const sha = capture('git', ['rev-parse', '--short', 'HEAD']) || 'unknown';
  const now = new Date();
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `${sha}-${date}`;
}

// --- zip note templates -------------------------------------------------------
function installTxt(version) {
  return `FormLogic ${version} — fresh install
====================================

This zip contains the complete app in the single-domain layout:

  /            the built web app (index.html, assets/, .htaccess, ...)
  /api         the PHP backend (front controller: api/public/index.php)
  /install.php the browser install/upgrade wizard (DELETE after installing)
  VERSION      this release's version (also at api/VERSION)

Requirements
------------
- Apache with mod_rewrite enabled and "AllowOverride All" for the web root
  (the shipped .htaccess does the /api routing AND the security hardening —
  it must be honoured).
- PHP 8.1+ (8.3 recommended) with pdo_mysql, pdo_sqlite, mbstring, curl, gd, zip.
- MySQL 8.
- HTTPS in production: auth uses Secure cookies, so login FAILS over plain HTTP.

EASIEST: the install wizard
---------------------------
1. Upload the CONTENTS of this zip to your site's web root (DocumentRoot).
   (Upload what is INSIDE the zip — index.html must end up at the web root,
   not inside a subfolder.)
2. Open https://your-domain/install.php in a browser and follow the wizard.
   The wizard is locked to localhost by default. Installing onto a remote
   server? Temporarily allow it by adding this line at the TOP of the
   web-root .htaccess:
     SetEnv INSTALL_ENABLE 1
3. The wizard automates the whole setup: it checks the PHP version and
   extensions, checks + fixes file permissions where it can (api/storage/*,
   api/logs — printing the exact chown/chmod commands for anything it
   can't), verifies the qjs script-runtime binary is executable on Linux
   (restoring the execute bit that zip extraction drops), tests your MySQL
   connection, writes api/.env with generated secrets, creates the database
   + schema, verifies api/.env is not web-readable, and finishes with
   copy-paste cron lines for the maintenance jobs.
4. DELETE install.php from the web root and remove the SetEnv line from
   .htaccess again. (The wizard also hard-disables itself once installed,
   but deleting the file is the guarantee.)

Manual install (no wizard)
--------------------------
1. Upload the CONTENTS of this zip to your site's web root (as above) and
   delete install.php if you won't use it.
2. Create the backend config: copy api/.env.example to api/.env, then set
     DB_HOST, DB_DATABASE, DB_USERNAME, DB_PASSWORD  — your MySQL details
     JWT_SECRET                                      — a long random string
   Generate a strong secret with:
     php -r "echo bin2hex(random_bytes(32));"
   The .env.example file documents every other (optional) setting.
3. Create the MySQL database named in api/.env (an empty database is fine —
   the schema is created automatically on first run).
4. Make api/storage/ and api/logs/ writable by the web server user
   (e.g. on Linux: chown -R www-data:www-data api/storage api/logs).
5. On Linux, make sure the qjs script-runtime binary is executable (zip
   extraction often drops the execute bit):
     chmod +x api/bin/qjs/qjs-linux-x86_64
6. Visit the site in a browser — the backend creates/updates its schema on the
   first request. (Or, from a shell on the server: php api/bin/upgrade.php)
7. Verify: https://your-domain/api/health reports status + storage checks.
8. Create your account: the sign-up page registers the first user. You can
   start from a blank workspace or install a ready-made app from the
   marketplace (Apps -> Create app / Import).

Scheduled tasks (optional but recommended)
------------------------------------------
The wizard prints these ready-to-paste; the crontab lines are (use the full
path to your PHP 8.1+ CLI binary if plain "php" isn't on cron's PATH):
  * * * * *  php <web-root>/api/bin/webhook-worker.php       # webhook retry delivery (lock-guarded; or run once with --loop as a service)
  17 3 * * * php <web-root>/api/bin/idempotency-cleanup.php  # nightly offline-sync ledger prune (rows older than 30 days)
  23 3 * * * php <web-root>/api/bin/desktop-commands-cleanup.php  # nightly desktop-command relay prune (rows older than 7 days; also expires crashed/claimed rows)
  0-59/5 * * * * php <web-root>/api/bin/flow-runs-reclaim.php     # every 5 min: revert flow runs stuck 'running' >10min (crashed claimant) to 'error'
  0 4 * * 1  php <web-root>/api/bin/reconcile.php            # weekly read-only MySQL<->SQLite drift report (--fix applies safe repairs)

Troubleshooting
---------------
- Every /api request returns 500 (Apache "internal redirect" errors in the
  log): mod_rewrite is off or AllowOverride is not All for the web root —
  the shipped .htaccess is being ignored. Fix the vhost and reload Apache.
- "Database connection failed": check the DB_* values in api/.env, that the
  MySQL server is reachable from the web server, and that the database in
  DB_DATABASE actually exists.
- Login does nothing / you are logged straight out: you are on plain HTTP.
  Auth cookies are Secure-only — serve the site over HTTPS.
- Uploads or app installs fail: api/storage/ is not writable by the web
  server user (see manual step 4 — the wizard reports the exact commands).
- Form logic / scripts do nothing on Linux: the qjs binary lost its execute
  bit (see manual step 5 — the wizard fixes this automatically).
- Blank white page: the zip contents were uploaded into a subfolder. The
  app expects to live at the domain root (index.html next to .htaccess).

Notes
-----
- Never expose api/.env, api/storage/ or api/logs/ over HTTP. The shipped
  .htaccess already denies them on Apache; on any other web server replicate
  those rules (see the comments inside .htaccess). The wizard self-tests
  api/.env exposure after installing where it can.
- Always delete install.php when you are done (it also disables itself once
  installed, and only ever runs from localhost or with INSTALL_ENABLE=1).
- Upgrading later? See UPGRADE.txt in the release zip.
`;
}

function upgradeTxt(version) {
  return `FormLogic ${version} — upgrading an existing install
==================================================

Full guide: docs/UPGRADING.md in the source repository.

1. Back up your database AND your api/.env file.
2. Replace ALL files in the web root with the contents of this zip,
   EXCEPT:
     - api/.env       (your configuration/secrets)
     - api/storage/   (your response databases, uploads, and packs)
   Keeping the existing api/logs/ contents is optional but harmless.
3. Migrate the database — pick ONE:

   EASIEST — the wizard: open https://your-domain/install.php and choose
   "Upgrade existing installation". It runs the same guarded, idempotent
   schema migrations the CLI runs, verifies the core tables, stamps the
   version, re-checks file permissions + the qjs execute bit, and reminds
   you of the cron lines. Once installed the wizard locks itself — allow
   this one run by adding this line at the TOP of the web-root .htaccess:
     SetEnv INSTALL_ENABLE 1
   (remove it again — and delete install.php — right after).

   CLI (recommended for big installs, runs before traffic hits the code):
     php api/bin/upgrade.php --app-version=${version}
   (Without the flag, upgrade.php reads the version to stamp from the
   api/VERSION file shipped in this zip.)

   Or do nothing — pending schema migrations run automatically on the
   first request that hits the new code.

4. Verify: https://your-domain/api/health reports ok and the app loads.
   (From a shell: php api/bin/upgrade.php --check is a read-only report.)
5. Delete install.php from the web root (this zip ships a fresh copy) and
   remove any SetEnv INSTALL_ENABLE line you added.

If anything fails, restore the step-1 backup and retry.
`;
}

// --- steps --------------------------------------------------------------------
const version = resolveVersion();
const outDir = path.resolve(repoRoot, cli.out || 'dist-package');
const staging = path.join(outDir, 'staging');
const zipPath = path.join(outDir, `formlogic-${version}.zip`);

console.log(`FormLogic distributable packager`);
console.log(`  version : ${version}`);
console.log(`  output  : ${zipPath}`);

// [1] Build the UI ------------------------------------------------------------
if (cli.skipUiBuild) {
  step('UI build skipped (--skip-ui-build) — reusing form-builder/ui/dist');
  if (!existsSync(path.join(distDir, 'index.html'))) {
    fail('form-builder/ui/dist/index.html not found — run without --skip-ui-build first');
  }
} else {
  step('Building the UI (form-builder/ui)');
  if (!cli.noInstall) {
    run('npm', ['ci'], { cwd: uiDir });
  } else {
    info('npm ci skipped (--no-install) — reusing existing node_modules');
  }
  // VITE_API_URL=/api pins the single-domain same-origin API base even if a local
  // ui/.env says otherwise (real process env beats .env files in Vite).
  run('npm', ['run', 'build'], { cwd: uiDir, env: { VITE_API_URL: '/api' } });
}
// The root .htaccess ships from ui/public/ via the Vite build — it IS the
// single-domain routing + hardening, so its absence is a hard error.
for (const f of ['index.html', '.htaccess', 'assets']) {
  if (!existsSync(path.join(distDir, f))) fail(`UI build incomplete: form-builder/ui/dist/${f} is missing`);
}

// [2] Stage the UI at the zip root ---------------------------------------------
step('Staging the built UI at the zip root');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const distApi = path.join(distDir, 'api');
cpSync(distDir, staging, {
  recursive: true,
  // NEVER descend into dist/api: on dev machines it is a junction/symlink into the
  // backend (the dist-api-junction convenience) — the real backend is staged below.
  filter: (src) => path.resolve(src) !== path.resolve(distApi),
});
info(`copied ui/dist -> staging/ (excluding dist/api)`);

// [3] Stage the production-filtered backend under api/ --------------------------
step('Staging the backend under api/ (production filter)');
const apiDst = path.join(staging, 'api');
mkdirSync(apiDst, { recursive: true });
for (const dir of BACKEND_COPY_DIRS) {
  const src = path.join(backendDir, dir);
  if (!existsSync(src)) fail(`backend directory missing: form-builder/backend/${dir}`);
  cpSync(src, path.join(apiDst, dir), {
    recursive: true,
    // Defence in depth inside allowlisted dirs: never ship a stray .env/.env.* (except
    // .env.example) or *.log file no matter where it sits.
    filter: (s) => {
      const base = path.basename(s);
      if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return false;
      if (base.endsWith('.log')) return false;
      return true;
    },
  });
  info(`copied backend/${dir}`);
}
for (const file of BACKEND_COPY_FILES) {
  const src = path.join(backendDir, file);
  if (!existsSync(src)) fail(`backend file missing: form-builder/backend/${file}`);
  copyFileSync(src, path.join(apiDst, file));
  info(`copied backend/${file}`);
}
for (const dir of BACKEND_SKELETON_DIRS) {
  const abs = path.join(apiDst, dir);
  mkdirSync(abs, { recursive: true });
  // Placeholder so every zip backend (Compress-Archive drops empty dirs) preserves the
  // skeleton; harmless at runtime and unreachable over HTTP (the /api funnel 404s it).
  writeFileSync(path.join(abs, '.gitkeep'), '');
  info(`created empty ${path.join('api', dir)}/`);
}

// [4] Fresh production vendor/ -------------------------------------------------
step('Installing production composer dependencies into staging (never touches the dev vendor/)');
run('composer', ['install', '--no-dev', '--optimize-autoloader', '--no-interaction', '--no-progress'], {
  cwd: apiDst,
});
if (!existsSync(path.join(apiDst, 'vendor', 'autoload.php'))) {
  fail('composer install did not produce api/vendor/autoload.php');
}
if (existsSync(path.join(apiDst, 'vendor', 'phpunit'))) {
  fail('dev dependencies leaked into the staged vendor/ (vendor/phpunit exists) — expected --no-dev');
}

// [5] Install/upgrade wizard at the zip root -------------------------------------
step('Staging the install wizard (install.php) at the zip root');
const installerSrc = path.join(repoRoot, 'form-builder', 'install.php');
if (!existsSync(installerSrc)) fail('form-builder/install.php not found');
copyFileSync(installerSrc, path.join(staging, 'install.php'));
info('copied form-builder/install.php -> install.php (the wizard resolves the bundle layout via the api/ folder beside it)');

// [6] VERSION + INSTALL.txt + UPGRADE.txt ---------------------------------------
step('Writing VERSION, INSTALL.txt, UPGRADE.txt');
writeFileSync(path.join(staging, 'VERSION'), `${version}\n`);
// api/VERSION is what api/bin/upgrade.php falls back to for --app-version stamping.
writeFileSync(path.join(apiDst, 'VERSION'), `${version}\n`);
writeFileSync(path.join(staging, 'INSTALL.txt'), installTxt(version));
writeFileSync(path.join(staging, 'UPGRADE.txt'), upgradeTxt(version));

// [7] Sanity checks on the staged tree ------------------------------------------
step('Verifying the staged tree');
const mustExist = [
  'index.html',
  '.htaccess',
  'install.php',
  'api/public/index.php',
  'api/public/.htaccess',
  'api/vendor/autoload.php',
  'api/.env.example',
  'api/config/settings.php',
  'api/database/schema.sql',
  'api/bin/qjs/qjs-linux-x86_64',
  'api/resources/formlogic-prelude.js',
  'VERSION',
  'api/VERSION',
  'INSTALL.txt',
  'UPGRADE.txt',
  ...BACKEND_SKELETON_DIRS.map((d) => path.join('api', d)),
];
const mustNotExist = ['api/.env', 'api/tests', 'api/scripts', 'api/phpunit.xml', 'api/.phpunit.cache'];
for (const p of mustExist) {
  if (!existsSync(path.join(staging, p))) fail(`staged tree is missing: ${p}`);
}
for (const p of mustNotExist) {
  if (existsSync(path.join(staging, p))) fail(`staged tree must NOT contain: ${p}`);
}
info(`all ${mustExist.length} required paths present; ${mustNotExist.length} excluded paths confirmed absent`);

// [8] Zip ------------------------------------------------------------------------
step('Creating the zip');
rmSync(zipPath, { force: true });
if (commandExists('zip', ['-v'])) {
  // Preferred: Info-ZIP (Linux/macOS/CI; preserves the empty-dir skeleton natively too).
  run('zip', ['-r', '-q', zipPath, '.'], { cwd: staging });
} else if (isWindows) {
  info('system "zip" not found — falling back to PowerShell Compress-Archive');
  const psCmd = `$ErrorActionPreference='Stop'; Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { stdio: 'inherit' });
  if (res.error || res.status !== 0) fail('Compress-Archive failed');
} else {
  fail('no zip tool available: install Info-ZIP ("zip") — e.g. apt-get install zip / apk add zip');
}
if (!existsSync(zipPath)) fail(`zip was not created at ${zipPath}`);
const sizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(1);

// [9] Report + cleanup --------------------------------------------------------------
step('Package contents (top 2 levels of the zip root)');
function listTree(dir, depth, prefix = '  ') {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory() && depth > 1) listTree(path.join(dir, entry.name), depth - 1, prefix + '  ');
  }
}
listTree(staging, 2);

if (cli.keepStaging) {
  info(`staging kept at ${staging} (--keep-staging)`);
} else {
  rmSync(staging, { recursive: true, force: true });
}

console.log(`\nDone: ${zipPath} (${sizeMb} MB, version ${version})`);
