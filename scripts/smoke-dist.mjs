#!/usr/bin/env node
/**
 * FormLogic — distributable ZIP smoke test (audit FL-30).
 *
 * The packaging workflow verified the SOURCE tree and structurally listed the
 * zip; nothing ever booted the actual artifact. This script serves ONLY the
 * extracted bytes and fails when a runtime file/dependency is missing or a
 * forbidden file leaked:
 *
 *   1. extract the zip into a clean temporary docroot;
 *   2. forbidden-file sweep — no .env, no repo tests/scripts, no phpunit/dev
 *      vendor binaries, no source maps, no .git/node_modules;
 *   3. structural sweep — every documented runtime entry point present;
 *   4. integrity — manifest.json version matches VERSION and every listed
 *      file's sha256 matches the extracted bytes;
 *   5. boot by the documented production path (front controller
 *      api/public/index.php) against a CLEAN database, then smoke:
 *      /api/health, the SPA shell, an SPA fallback route, registration,
 *      login, and one authenticated form + response round trip.
 *
 * Usage:
 *   node scripts/smoke-dist.mjs [--zip <path>] [--keep]
 *
 *   --zip   path to the built zip (default: newest formlogic-*.zip in
 *           <repo>/dist-package)
 *   --keep  keep the temp docroot for inspection
 *
 * Database: SMOKE_DB_HOST/PORT/DATABASE/USERNAME/PASSWORD env vars
 * (defaults: 127.0.0.1/3306/formlogic_smoke/root/<empty>). The database is
 * DROPPED and recreated — never point it at real data.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const zipArg = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : null;

const DB = {
  host: process.env.SMOKE_DB_HOST || '127.0.0.1',
  port: process.env.SMOKE_DB_PORT || '3306',
  database: process.env.SMOKE_DB_DATABASE || 'formlogic_smoke',
  username: process.env.SMOKE_DB_USERNAME || 'root',
  password: process.env.SMOKE_DB_PASSWORD || '',
};
const PORT = Number(process.env.SMOKE_PORT || 8091);
const BASE = `http://127.0.0.1:${PORT}`;

function fail(message) {
  console.error(`smoke-dist: FAIL — ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function findMysql() {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['mysql'], { stdio: 'ignore' });
    return 'mysql';
  } catch { /* not on PATH */ }
  if (process.platform === 'win32') {
    const wampMysql = 'C:/wamp64/bin/mysql';
    if (existsSync(wampMysql)) {
      for (const dir of readdirSync(wampMysql).sort().reverse()) {
        const exe = path.join(wampMysql, dir, 'bin', 'mysql.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  fail('mysql client not found (PATH or C:/wamp64/bin/mysql/*) — needed to create the clean smoke database');
}

function mysqlBaseArgs() {
  const a = ['-h', DB.host, '-P', DB.port, '-u', DB.username];
  if (DB.password) a.push(`-p${DB.password}`);
  return a;
}

function findZip() {
  if (zipArg) {
    if (!existsSync(zipArg)) fail(`--zip ${zipArg} does not exist`);
    return path.resolve(zipArg);
  }
  const dir = path.join(repoRoot, 'dist-package');
  if (!existsSync(dir)) fail('no dist-package/ directory — run scripts/package-dist.mjs first (or pass --zip)');
  const zips = readdirSync(dir).filter((name) => name.endsWith('.zip'))
    .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (zips.length === 0) fail('dist-package/ has no .zip — run scripts/package-dist.mjs first');
  return path.join(dir, zips[0].name);
}

function extract(zip, dest) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zip, '-d', dest], { stdio: 'inherit' });
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function req(url, init = {}, jar = null) {
  if (jar && jar.cookie) {
    init.headers = { ...(init.headers || {}), Cookie: jar.cookie };
  }
  const res = await fetch(url, { redirect: 'manual', ...init });
  if (jar) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const [name] = pair.split('=');
      const existing = (jar.cookie || '').split('; ').filter((c) => c && !c.startsWith(name + '='));
      existing.push(pair);
      jar.cookie = existing.join('; ');
    }
  }
  return res;
}

function csrfFrom(jar) {
  const m = (jar.cookie || '').match(/(?:^|; )formlogic_csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function main() {
  const zip = findZip();
  const mysql = findMysql();
  console.log(`smoke-dist: artifact ${zip}`);
  const docroot = mkdtempSync(path.join(tmpdir(), 'fl-dist-smoke-'));
  console.log(`smoke-dist: docroot ${docroot}`);

  let server = null;
  try {
    extract(zip, docroot);

    // ── 2. Forbidden-file sweep ──
    // Independent re-verification on the EXTRACTED bytes (the packager checks
    // its staging dir; this checks what a customer actually receives).
    const files = walk(docroot).map((p) => path.relative(docroot, p).replaceAll('\\', '/'));
    const forbidden = files.filter((f) =>
      f === '.env' || f === 'api/.env'
      || (f.startsWith('api/.env.') && f !== 'api/.env.example')
      || f.startsWith('api/tests/')
      || f.startsWith('api/scripts/')
      || f.startsWith('scripts/')
      || f.startsWith('api/vendor/phpunit/')
      || /^api\/vendor\/bin\/phpunit/.test(f)
      || f.endsWith('.map')
      || f.includes('/.git/') || f.startsWith('.git/')
      || f.includes('node_modules/')
      || f.endsWith('.log')
    );
    if (forbidden.length > 0) {
      fail(`forbidden files leaked into the artifact:\n  ${forbidden.slice(0, 20).join('\n  ')}`);
    }
    console.log(`smoke-dist: forbidden-file sweep OK (${files.length} files)`);

    // ── 3. Structural sweep ──
    for (const required of [
      'index.html', '.htaccess', 'install.php', 'INSTALL.txt', 'UPGRADE.txt', 'VERSION',
      'manifest.json',
      'api/public/index.php', 'api/public/.htaccess', 'api/config/settings.php',
      'api/database/schema.sql', 'api/database/migrate.php', 'api/composer.json',
      'api/vendor/autoload.php', 'api/.env.example', 'api/bin/upgrade.php', 'api/VERSION',
      // The sandbox runtime: both launchers (the zip serves either platform) and
      // the prelude they load. Their ABSENCE is not a boot failure — the API fails
      // open without them — which is exactly why they are listed here.
      'api/bin/runtime/formlogic-runtime-linux-x86_64',
      'api/bin/runtime/formlogic-runtime-windows-x86_64.exe',
      'api/resources/formlogic-prelude.js',
    ]) {
      if (!existsSync(path.join(docroot, required))) fail(`required artifact file missing: ${required}`);
    }
    console.log('smoke-dist: structural sweep OK');

    // ── 4. Integrity: manifest.json version + full sha256 verification ──
    const manifest = JSON.parse(readFileSync(path.join(docroot, 'manifest.json'), 'utf8'));
    const versionFile = readFileSync(path.join(docroot, 'VERSION'), 'utf8').trim();
    if (manifest.version !== versionFile) {
      fail(`manifest.json version (${manifest.version}) != VERSION file (${versionFile})`);
    }
    let hashChecked = 0;
    const hashMismatches = [];
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const abs = path.join(docroot, rel);
      if (!existsSync(abs)) { hashMismatches.push(`${rel} (missing)`); continue; }
      const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (actual !== expected) hashMismatches.push(rel);
      hashChecked++;
    }
    if (hashMismatches.length > 0) {
      fail(`manifest checksum mismatches:\n  ${hashMismatches.slice(0, 20).join('\n  ')}`);
    }
    // manifest.json hashes itself out of scope (its signature envelope,
    // manifest.sig.json, signs the manifest bytes instead — review FL-006);
    // everything else must be listed.
    const unlisted = files.filter((f) => f !== 'manifest.json' && f !== 'manifest.sig.json' && !(f in manifest.files));
    if (unlisted.length > 0) {
      fail(`extracted files missing from manifest.json:\n  ${unlisted.slice(0, 20).join('\n  ')}`);
    }
    // When the package is signed, independently verify the envelope.
    const sigPath = path.join(docroot, 'manifest.sig.json');
    if (existsSync(sigPath)) {
      const { createPublicKey, verify } = await import('node:crypto');
      const sig = JSON.parse(readFileSync(sigPath, 'utf8'));
      const rawPub = Buffer.from(String(sig.publicKey || ''), 'base64');
      if (sig.algorithm !== 'ed25519' || rawPub.length !== 32) fail('manifest.sig.json is malformed');
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPub]);
      const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
      const ok = verify(null, readFileSync(path.join(docroot, 'manifest.json')), pub, Buffer.from(String(sig.signature || ''), 'base64'));
      if (!ok) fail('manifest.sig.json signature does not verify over manifest.json');
      const keyId = createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
      if (keyId !== sig.keyId) fail('manifest.sig.json keyId does not match its public key');
      console.log(`smoke-dist: release signature OK (keyId ${keyId})`);
    } else {
      console.log('smoke-dist: package is UNSIGNED (production installs will refuse it)');
    }
    console.log(`smoke-dist: integrity OK (version ${versionFile}, ${hashChecked} checksums verified)`);

    // ── 5. Boot the EXTRACTED artifact against a clean DB ──
    // The artifact's production guard (settings.php) refuses an empty
    // DB_PASSWORD, so the app connects as a dedicated throwaway user with a
    // random password; SMOKE_DB_* stays the ADMIN login used to provision it.
    const appDbUser = 'fl_dist_smoke';
    const appDbPassword = randomBytes(18).toString('base64url');
    execFileSync(mysql, [...mysqlBaseArgs(), '-e', [
      `DROP DATABASE IF EXISTS \`${DB.database}\`;`,
      `CREATE DATABASE \`${DB.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `DROP USER IF EXISTS '${appDbUser}'@'localhost';`,
      `DROP USER IF EXISTS '${appDbUser}'@'127.0.0.1';`,
      `CREATE USER '${appDbUser}'@'localhost' IDENTIFIED BY '${appDbPassword}';`,
      `CREATE USER '${appDbUser}'@'127.0.0.1' IDENTIFIED BY '${appDbPassword}';`,
      `GRANT ALL PRIVILEGES ON \`${DB.database}\`.* TO '${appDbUser}'@'localhost';`,
      `GRANT ALL PRIVILEGES ON \`${DB.database}\`.* TO '${appDbUser}'@'127.0.0.1';`,
    ].join(' ')]);
    execFileSync(mysql, [...mysqlBaseArgs(), DB.database], {
      input: readFileSync(path.join(docroot, 'api/database/schema.sql')),
    });
    console.log('smoke-dist: clean database imported from the shipped schema.sql');

    const rand = () => Math.random().toString(36).slice(2, 10);
    const secret = randomBytes(32).toString('hex');
    // The documented manual install path: copy .env.example -> .env, set DB + JWT.
    writeFileSync(path.join(docroot, 'api/.env'), [
      'APP_ENV=production',
      `DB_HOST=${DB.host}`,
      `DB_PORT=${DB.port}`,
      `DB_DATABASE=${DB.database}`,
      `DB_USERNAME=${appDbUser}`,
      `DB_PASSWORD=${appDbPassword}`,
      `JWT_SECRET=${secret}`,
      `CORS_ORIGIN=${BASE}`,
      '',
    ].join('\n'));

    // Router mirroring the shipped Apache .htaccess against the ZIP layout
    // (single-domain-v1: /api/* -> api/public/index.php, static, SPA fallback).
    const routerPath = path.join(docroot, 'smoke-router.php');
    writeFileSync(routerPath, `<?php
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$root = __DIR__;
if ($uri === '/api' || str_starts_with($uri, '/api/')) {
    require $root . '/api/public/index.php';
    return true;
}
$path = realpath($root . $uri);
if ($uri !== '/' && $path !== false && is_file($path) && str_starts_with($path, $root) && basename($path) !== 'smoke-router.php') {
    return false;
}
header('Content-Type: text/html; charset=UTF-8');
readfile($root . '/index.html');
return true;
`);

    server = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', docroot, routerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (chunk) => { serverLog += chunk; });
    server.stderr.on('data', (chunk) => { serverLog += chunk; });

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) fail(`server never became ready; log:\n${serverLog.slice(-2000)}`);

    const health = await (await fetch(`${BASE}/api/health`)).json();
    if (health?.status !== 'ok') fail(`/api/health did not report ok: ${JSON.stringify(health)}`);
    console.log('smoke-dist: /api/health OK');

    const shell = await (await fetch(`${BASE}/`)).text();
    if (!/<div id="root">|<script/i.test(shell)) fail('SPA shell did not render');
    const fallback = await (await fetch(`${BASE}/settings`)).text();
    if (!/<div id="root">|<script/i.test(fallback)) fail('SPA fallback route did not serve index.html');
    console.log('smoke-dist: SPA shell + fallback OK');

    // Registration + login + one form/response round trip — all served from
    // the extracted artifact only.
    const jar = { cookie: '' };
    const email = `smoke-${rand()}@dist.local`;
    const password = 'smoke-Password-123';
    const reg = await req(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Dist Smoke' }),
    }, jar);
    if (reg.status !== 201) fail(`registration failed: HTTP ${reg.status} ${await reg.text()}`);
    console.log('smoke-dist: registration OK');

    const login = await req(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, jar);
    if (!login.ok) fail(`login failed: HTTP ${login.status} ${await login.text()}`);
    console.log('smoke-dist: login OK');

    const csrf = csrfFrom(jar);
    const formRes = await req(`${BASE}/api/forms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        title: 'Dist smoke form',
        status: 'published',
        fields: [
          { id: 'note', type: 'short_text', label: 'Note', required: false, order: 0, properties: {} },
          // A calculated field is the one thing in this smoke that cannot pass
          // without the sandbox runtime: the server evaluates it in the vendored
          // launcher on submit, and ResponseService fails OPEN when that engine is
          // absent (the field is silently skipped, the submission still succeeds).
          // So the round trip below asserts the VALUE, and reaches into the
          // prelude while it is at it, so a launcher that starts but cannot load
          // the standard library is caught too.
          {
            id: 'calc', type: 'calculated', label: 'Calc', required: false, order: 1,
            properties: { calculationExpression: 'validators.email("smoke@example.com") ? 40 + 2 : -1' },
          },
        ],
      }),
    }, jar);
    if (!formRes.ok) fail(`form creation failed: HTTP ${formRes.status} ${await formRes.text()}`);
    const form = (await formRes.json()).form;
    if (!form?.id) fail('form creation returned no id');
    const fieldId = form.fields?.find((f) => f.type === 'short_text')?.id;
    const calcId = form.fields?.find((f) => f.type === 'calculated')?.id;
    if (!fieldId || !calcId) fail('created form is missing its fields');

    const respRes = await req(`${BASE}/api/forms/${form.id}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ answers: { [fieldId]: 'hello from the artifact' } }),
    }, jar);
    if (!respRes.ok) fail(`response submission failed: HTTP ${respRes.status} ${await respRes.text()}`);
    console.log('smoke-dist: form + response round trip OK');

    const listRes = await req(`${BASE}/api/forms/${form.id}/responses`, { headers: { 'X-CSRF-Token': csrf } }, jar);
    if (!listRes.ok) fail(`response listing failed: HTTP ${listRes.status} ${await listRes.text()}`);
    const rows = (await listRes.json()).responses ?? [];
    const calc = rows[0]?.answers?.[calcId];
    if (calc !== 42) {
      fail(
        `the sandbox runtime did not evaluate the calculated field (got ${JSON.stringify(calc)}, wanted 42). ` +
          'The launcher under api/bin/runtime/ is missing, not executable, or not for this platform — ' +
          'the API still accepted the submission, which is why this check exists.'
      );
    }
    console.log('smoke-dist: sandbox runtime evaluated a calculated field through the prelude (42) OK');

    console.log('smoke-dist: PASS — the artifact boots and serves by its documented path');
    process.exitCode = 0;
  } finally {
    if (server) server.kill();
    if (keep) {
      console.log(`smoke-dist: docroot kept at ${docroot}`);
    } else {
      try { rmSync(docroot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try {
      execFileSync(mysql, [...mysqlBaseArgs(), '-e',
        `DROP DATABASE IF EXISTS \`${DB.database}\`; DROP USER IF EXISTS 'fl_dist_smoke'@'localhost'; DROP USER IF EXISTS 'fl_dist_smoke'@'127.0.0.1';`]);
    } catch { /* best-effort */ }
  }
}

main().catch((err) => {
  if (process.exitCode !== 1) {
    console.error(`smoke-dist: FAIL — ${err?.message ?? err}`);
    process.exitCode = 1;
  }
});
