// Form-encryption manifest signing + verification (docs/E2EE_PRIVATE_FORMS_PLAN.md §8).
// The canonical string is:
//   flmanifest:1|<formId>|<keyId>|<epoch>|<publicKey>|<content>|<wrap>|<schemaVersion>|<schemaHash>|<signerKeyId>|<expiresAt|->
// Verification proves internal consistency for an anonymous submitter; the strong
// checks are the owner-side signerPk assertion and submitter-side TOFU pinning
// (signerPins.ts).

import { getSodium } from './sodium';
import { fromB64, toB64, toHex, utf8Bytes } from './encoding';
import { CONTENT_SUITE, WRAP_SUITE } from './envelope';
import { parseServerDate } from '../utils';
import type { FormEncryptionManifest } from '../../types/e2ee';

const KEY_ID_RE = /^fik_[a-zA-Z0-9_-]{1,36}$/;
const SCHEMA_HASH_RE = /^[0-9a-f]{64}$/;
const SIGNER_KEY_ID_RE = /^[0-9a-f]{16}$/;
const AAD_COMPONENT_RE = /^[a-zA-Z0-9_-]+$/;

export class ManifestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ManifestError';
  }
}

/** hex16 fingerprint prefix of an Ed25519 public key (§7 signer_key_id). */
export async function signerKeyIdFromPk(ed25519Pk: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return toHex(sodium.crypto_hash_sha256(ed25519Pk)).slice(0, 16);
}

/** Canonical string that gets signed (§8). expiresAt null → literal '-'. */
export function manifestCanonicalString(m: {
  formId: string;
  keyId: string;
  epoch: number;
  publicKey: string;
  content: string;
  wrap: string;
  schemaVersion: number;
  schemaHash: string;
  signerKeyId: string;
  expiresAt: string | null;
}): string {
  return `flmanifest:1|${m.formId}|${m.keyId}|${m.epoch}|${m.publicKey}|${m.content}|${m.wrap}|${m.schemaVersion}|${m.schemaHash}|${m.signerKeyId}|${m.expiresAt ?? '-'}`;
}

/** Structural validation of a served manifest (unknown suites rejected, never skipped). */
export function validateManifestStructure(m: FormEncryptionManifest): void {
  if (m.mode !== 'private') throw new ManifestError('manifest_invalid', 'unknown encryption mode');
  if (!KEY_ID_RE.test(m.keyId)) throw new ManifestError('manifest_invalid', 'keyId malformed');
  if (!Number.isInteger(m.epoch) || m.epoch < 1) throw new ManifestError('manifest_invalid', 'epoch must be a positive integer');
  if (m.content !== CONTENT_SUITE) throw new ManifestError('manifest_invalid', 'unknown content suite');
  if (m.wrap !== WRAP_SUITE) throw new ManifestError('manifest_invalid', 'unknown wrap suite');
  if (!Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) {
    throw new ManifestError('manifest_invalid', 'schemaVersion must be a positive integer');
  }
  if (!SCHEMA_HASH_RE.test(m.schemaHash)) throw new ManifestError('manifest_invalid', 'schemaHash must be 64 lowercase hex chars');
  if (!SIGNER_KEY_ID_RE.test(m.signerKeyId)) throw new ManifestError('manifest_invalid', 'signerKeyId must be 16 lowercase hex chars');
  if (!AAD_COMPONENT_RE.test(m.signerKeyId)) throw new ManifestError('manifest_invalid', 'signerKeyId malformed');
  if (typeof m.schemaJson !== 'string') throw new ManifestError('manifest_invalid', 'schema snapshot bytes missing from payload');
  const pk = fromB64(m.publicKey);
  if (pk.length !== 32) throw new ManifestError('manifest_invalid', 'publicKey must be 32 bytes');
  const spk = fromB64(m.signerPk);
  if (spk.length !== 32) throw new ManifestError('manifest_invalid', 'signerPk must be 32 bytes');
  const sig = fromB64(m.sig);
  if (sig.length !== 64) throw new ManifestError('manifest_invalid', 'sig must be 64 bytes');
  if (m.expiresAt !== null && new Date(m.expiresAt).getTime() <= Date.now()) {
    throw new ManifestError('manifest_expired', 'the form encryption manifest has expired');
  }
}

/**
 * Full submitter-side verification of a served manifest (§8): structure, signer-key
 * fingerprint binding, schema-hash recomputation over the exact served snapshot bytes,
 * and the Ed25519 signature over the canonical string. Throws ManifestError on any
 * failure — the caller MUST refuse to submit.
 */
export async function verifyManifest(formId: string, m: FormEncryptionManifest): Promise<void> {
  const sodium = await getSodium();
  validateManifestStructure(m);
  const signerPk = fromB64(m.signerPk);
  if ((await signerKeyIdFromPk(signerPk)) !== m.signerKeyId) {
    throw new ManifestError('manifest_invalid', 'signerKeyId does not match signerPk');
  }
  const recomputed = toHex(sodium.crypto_hash_sha256(utf8Bytes(m.schemaJson)));
  if (recomputed !== m.schemaHash) {
    throw new ManifestError('manifest_invalid', 'schema snapshot does not match the signed schemaHash');
  }
  const canonical = manifestCanonicalString({
    formId,
    keyId: m.keyId,
    epoch: m.epoch,
    publicKey: m.publicKey,
    content: m.content,
    wrap: m.wrap,
    schemaVersion: m.schemaVersion,
    schemaHash: m.schemaHash,
    signerKeyId: m.signerKeyId,
    expiresAt: m.expiresAt,
  });
  const ok = sodium.crypto_sign_verify_detached(fromB64(m.sig), utf8Bytes(canonical), signerPk);
  if (!ok) {
    throw new ManifestError('manifest_invalid', 'manifest signature verification failed');
  }
}

/** Owner-side signing (worker): sign the canonical manifest string with the vault Ed25519 key. */
export async function signManifestCanonical(
  canonical: string,
  ed25519Sk: Uint8Array,
): Promise<string> {
  const sodium = await getSodium();
  return toB64(sodium.crypto_sign_detached(utf8Bytes(canonical), ed25519Sk));
}

/**
 * Envelope acceptance rule (§8): the envelope's tuple must exactly match a stored
 * manifest row whose ingestion key is currently acceptable (active, or retiring within
 * its accept_until grace). Used owner-side before decrypting.
 */
export function manifestAcceptsEnvelope(
  manifests: readonly { keyId: string; ingestEpoch: number; schemaVersion: number; schemaHash: string }[],
  keys: readonly { id: string; state: 'active' | 'retiring' | 'retired' | 'trashed'; acceptUntil?: string | null }[],
  tuple: { keyId: string; epoch: number; schemaVersion: number; schemaHash: string },
  now: number = Date.now(),
): boolean {
  const key = keys.find((k) => k.id === tuple.keyId);
  if (!key) return false;
  // Anything but active/retiring-within-grace fails closed (retired AND trashed).
  if (key.state !== 'active' && key.state !== 'retiring') return false;
  if (key.state === 'retiring') {
    if (!key.acceptUntil) return false;
    if (now >= parseServerDate(key.acceptUntil).getTime()) return false;
  }
  return manifests.some(
    (m) => m.keyId === tuple.keyId
      && m.ingestEpoch === tuple.epoch
      && m.schemaVersion === tuple.schemaVersion
      && m.schemaHash === tuple.schemaHash,
  );
}
