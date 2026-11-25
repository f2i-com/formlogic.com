#!/usr/bin/env node
/**
 * Sign an already-built FormLogic distributable ZIP in an isolated release-signing job
 * (never sharing an environment or process tree with `npm ci` or `composer install`).
 *
 * Reads `manifest.json` from the ZIP, produces `manifest.sig.json` via Ed25519
 * (`release-signing.mjs`), adds `manifest.sig.json` to the ZIP root, and verifies
 * the resulting archive readback.
 *
 * Usage: node scripts/sign-dist-zip.mjs <path-to-dist.zip> [--require-signature]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verify } from 'node:crypto';
import { loadReleaseSigner, signReleaseManifest } from './release-signing.mjs';
import { readArchive } from './lib/archive.mjs';

const args = process.argv.slice(2);
const requireSignature = args.includes('--require-signature');
const zipPaths = args.filter((a) => !a.startsWith('--'));
if (zipPaths.length !== 1) {
  console.error('Usage: node scripts/sign-dist-zip.mjs <dist.zip> [--require-signature]');
  process.exit(1);
}
const zipPath = path.resolve(zipPaths[0]);

const signer = loadReleaseSigner(process.env, { requireSignature });
if (!signer) {
  console.log('No signing key configured; leaving archive unsigned (official GitHub release digest still applies).');
  process.exit(0);
}

// Verify archive structure and extract manifest.json bytes cleanly without trusting external tools.
const before = readArchive(readFileSync(zipPath));
if (before.problems.length > 0) {
  console.error(`Refusing to sign malformed archive: ${before.problems.join('; ')}`);
  process.exit(1);
}
if (!before.entries.has('api/public/index.php')) {
  console.error('Refusing to sign archive: missing api/public/index.php');
  process.exit(1);
}
const manifestEntry = before.entries.get('manifest.json');
if (!manifestEntry) {
  console.error('Refusing to sign archive: missing manifest.json');
  process.exit(1);
}
if (before.entries.has('manifest.sig.json')) {
  console.error('Refusing to sign archive: manifest.sig.json already exists');
  process.exit(1);
}

const envelope = signReleaseManifest(manifestEntry.data, signer);
const sigBytes = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fl-sign-zip-'));
try {
  const sigFile = path.join(tmpDir, 'manifest.sig.json');
  writeFileSync(sigFile, sigBytes);
  if (process.platform === 'win32') {
    const psCmd = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false); $z = [System.IO.Compression.ZipFile]::Open($env:FL_ZIP_PATH, [System.IO.Compression.ZipArchiveMode]::Update); try { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $env:FL_SIG_PATH, 'manifest.sig.json', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null } finally { $z.Dispose() }`;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      stdio: 'inherit',
      env: { ...process.env, FL_ZIP_PATH: zipPath, FL_SIG_PATH: sigFile },
    });
    if (res.error || res.status !== 0) {
      throw new Error('Failed to add manifest.sig.json to zip via ZipFile');
    }
  } else {
    execFileSync('zip', ['-j', '-q', zipPath, sigFile], { stdio: 'inherit' });
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Readback verification: confirm the stored manifest.sig.json verifies against stored manifest.json.
const after = readArchive(readFileSync(zipPath));
if (after.problems.length > 0) {
  console.error(`Signed archive failed readback check: ${after.problems.join('; ')}`);
  process.exit(1);
}
const storedManifest = after.entries.get('manifest.json')?.data;
const storedSigRaw = after.entries.get('manifest.sig.json')?.data;
if (!storedManifest || !storedSigRaw) {
  console.error('Signed archive missing manifest.json or manifest.sig.json on readback');
  process.exit(1);
}
const storedEnvelope = JSON.parse(storedSigRaw.toString('utf8'));
const ok = verify(null, storedManifest, signer.publicKey, Buffer.from(storedEnvelope.signature, 'base64'));
if (!ok) {
  console.error('Signed archive signature readback verification failed');
  process.exit(1);
}
console.log(`Signed ${path.basename(zipPath)} (keyId ${storedEnvelope.keyId})`);
