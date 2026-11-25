#!/usr/bin/env node
/**
 * Generate the FormLogic release signing keypair (review FL-006).
 *
 * Writes an Ed25519 PKCS8 PEM private key and prints the values each side
 * needs:
 *   - the packager signs with FORMLOGIC_RELEASE_SIGNING_KEY=<pem path>;
 *   - every server pins UPGRADE_RELEASE_PUBKEY=<base64 raw public key> in .env.
 *
 * Usage: node scripts/generate-release-key.mjs [out.pem]
 *
 * Guard the PEM like any production secret; rotating it means re-pinning
 * UPGRADE_RELEASE_PUBKEY on every install before they can accept new releases.
 */

import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'formlogic-release-signing.pem';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
try {
  // Exclusive creation ('wx') avoids check-then-write TOCTOU and refuses overwriting existing files/symlinks.
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
} catch (err) {
  if (err && err.code === 'EEXIST') {
    console.error(`refusing to overwrite existing key file: ${out}`);
    process.exit(1);
  }
  throw err;
}

const spki = publicKey.export({ type: 'spki', format: 'der' });
const rawPub = spki.subarray(spki.length - 32);
const keyId = createHash('sha256').update(rawPub).digest('hex').slice(0, 16);

console.log(`private key written: ${out}`);
console.log(`key id:              ${keyId}`);
console.log('');
console.log('Local packager (file path):');
console.log(`  FORMLOGIC_RELEASE_SIGNING_KEY=${out}`);
console.log('GitHub Actions secret FORMLOGIC_RELEASE_SIGNING_KEY: store the private PEM contents, not the path.');
console.log(`GitHub Actions variable FORMLOGIC_RELEASE_PUBLIC_KEY=${rawPub.toString('base64')}`);
console.log('Every server (.env):');
console.log(`  UPGRADE_RELEASE_PUBKEY=${rawPub.toString('base64')}`);
