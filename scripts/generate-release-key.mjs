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
import { existsSync, writeFileSync } from 'node:fs';

const out = process.argv[2] || 'formlogic-release-signing.pem';
if (existsSync(out)) {
  console.error(`refusing to overwrite existing key file: ${out}`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const spki = publicKey.export({ type: 'spki', format: 'der' });
const rawPub = spki.subarray(spki.length - 32);
const keyId = createHash('sha256').update(rawPub).digest('hex').slice(0, 16);

console.log(`private key written: ${out}`);
console.log(`key id:              ${keyId}`);
console.log('');
console.log('Packager (CI secret):');
console.log(`  FORMLOGIC_RELEASE_SIGNING_KEY=${out}`);
console.log('Every server (.env):');
console.log(`  UPGRADE_RELEASE_PUBKEY=${rawPub.toString('base64')}`);
