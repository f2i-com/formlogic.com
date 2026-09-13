import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Load once before build tools run. CI supplies PEM in memory; local builds use a file. */
export function loadReleaseSigner(env = process.env, { requireSignature = false, allowUnsigned = false } = {}) {
  if (allowUnsigned && requireSignature) throw new Error('Choose --require-signature or --allow-unsigned, not both.');
  const keyPath = env.FORMLOGIC_RELEASE_SIGNING_KEY;
  const pem = env.FORMLOGIC_RELEASE_SIGNING_KEY_PEM;
  if (keyPath && pem) throw new Error('Supply a signing key file OR PEM, not both.');
  if (!keyPath && !pem) {
    if (!requireSignature) return null;
    throw new Error('Release signing is required: set FORMLOGIC_RELEASE_SIGNING_KEY (PEM file path) or FORMLOGIC_RELEASE_SIGNING_KEY_PEM.');
  }
  let privateKey;
  try { privateKey = createPrivateKey(pem || readFileSync(keyPath, 'utf8')); }
  catch { throw new Error('Cannot load the release signing key; expected an unencrypted Ed25519 private PEM key.'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The release signing key must be Ed25519.');
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const expected = env.FORMLOGIC_RELEASE_PUBLIC_KEY?.trim();
  if (expected && expected !== raw.toString('base64')) throw new Error('The signing key does not match FORMLOGIC_RELEASE_PUBLIC_KEY.');
  return { privateKey, publicKey, raw };
}

export function signReleaseManifest(bytes, signer) {
  const signature = sign(null, bytes, signer.privateKey);
  if (!verify(null, bytes, signer.publicKey, signature)) throw new Error('Release signature self-verification failed.');
  return {
    algorithm: 'ed25519',
    keyId: createHash('sha256').update(signer.raw).digest('hex').slice(0, 16),
    publicKey: signer.raw.toString('base64'),
    signedFile: 'manifest.json',
    signature: signature.toString('base64'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadReleaseSigner();
    console.log('Release signing configuration checked (optional for GitHub-verified updates).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
