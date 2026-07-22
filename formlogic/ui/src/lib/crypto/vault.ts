// Vault key hierarchy: passphrase → Argon2id → PUK → UMK → {X25519, Ed25519} bundle,
// plus the recovery-kit wrapper. Authority: docs/E2EE_PRIVATE_FORMS_PLAN.md §5, §7.
// libsodium's crypto_pwhash exposes opslimit/memlimit/alg ONLY — there is no
// parallelism parameter (plan §0 v2→v3 item 8).

import { getSodium } from './sodium';
import {
  base32Decode, base32Encode, bytesEqual, concatBytes, fromB64, toB64, utf8Bytes, utf8String,
} from './encoding';

export const KDF_SUITE = 'argon2id13.1' as const;
export const KDF_SALT_BYTES = 16;
export const DEFAULT_KDF_OPSLIMIT = 3;
export const DEFAULT_KDF_MEMLIMIT = 64 * 1024 * 1024; // 64 MiB
export const UMK_BYTES = 32;
export const RECOVERY_KEY_BYTES = 32;
/** Client-side passphrase floor (offline-attack resistance; review 2026-07-22). */
export const MIN_PASSPHRASE_LENGTH = 12;
const RECOVERY_PREFIX = 'FLRK1';
const RECOVERY_KDF_CONTEXT = 'flrecov1'; // crypto_kdf context: exactly 8 chars
const RECOVERY_KDF_SUBKEY_ID = 1;

export interface VaultKdfParams {
  kdf: typeof KDF_SUITE;
  salt: Uint8Array;
  opslimit: number;
  memlimit: number;
}

export interface KeyBundle {
  x25519Sk: Uint8Array; // 32 bytes
  ed25519Sk: Uint8Array; // 64 bytes (libsodium secret key = seed || pk)
}

export interface PublicKeys {
  x25519Pk: Uint8Array;
  ed25519Pk: Uint8Array;
}

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'VaultError';
  }
}

/** Fail-closed passphrase policy — every vault-creating/rewrapping path enforces this. */
export function assertPassphraseStrength(passphrase: string, label = 'Passphrase'): void {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError('vault_invalid', `${label} must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

export const umkAad = (userId: string): string => `flvault-umk:1|${userId}`;
export const bundleAad = (userId: string): string => `flvault-bundle:1|${userId}`;
export const recoveryAad = (userId: string): string => `flvault-umk-recovery:1|${userId}`;

export async function derivePuk(passphrase: string, params: VaultKdfParams): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (params.kdf !== KDF_SUITE) throw new VaultError('vault_corrupt', 'unknown KDF suite');
  if (params.salt.length !== KDF_SALT_BYTES) throw new VaultError('vault_corrupt', 'bad KDF salt length');
  if (params.opslimit < DEFAULT_KDF_OPSLIMIT || params.memlimit < DEFAULT_KDF_MEMLIMIT) {
    // Upgrade-only policy: parameters below the launch floor are refused (plan §5).
    throw new VaultError('vault_corrupt', 'KDF parameters below the supported minimum');
  }
  return sodium.crypto_pwhash(
    UMK_BYTES,
    utf8Bytes(passphrase),
    params.salt,
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** XChaCha20-Poly1305 wrap: blob = nonce(24) || ct. */
export async function wrapKey(key: Uint8Array, wrappingKey: Uint8Array, aad: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(key, aad, null, nonce, wrappingKey);
  return concatBytes(nonce, ct);
}

export async function unwrapKey(blob: Uint8Array, wrappingKey: Uint8Array, aad: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nlen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob.length <= nlen + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new VaultError('vault_unlock_failed', 'wrapped blob too short');
  }
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, blob.subarray(nlen), aad, blob.subarray(0, nlen), wrappingKey,
    );
  } catch {
    throw new VaultError('vault_unlock_failed', 'unwrap failed (wrong key/passphrase or tampered blob)');
  }
}

export async function sealBundle(bundle: KeyBundle, umk: Uint8Array, userId: string): Promise<Uint8Array> {
  const plaintext = utf8Bytes(JSON.stringify({
    v: 1,
    x25519Sk: toB64(bundle.x25519Sk),
    ed25519Sk: toB64(bundle.ed25519Sk),
  }));
  return wrapKey(plaintext, umk, bundleAad(userId));
}

/**
 * Opens the private-key bundle and VERIFIES the re-derived public keys against the
 * stored public values — mismatch fails closed as vault_corrupt (plan §5).
 */
export async function openBundle(
  blob: Uint8Array,
  umk: Uint8Array,
  userId: string,
  expected: PublicKeys,
): Promise<KeyBundle> {
  const sodium = await getSodium();
  const raw = await unwrapKey(blob, umk, bundleAad(userId));
  let parsed: { v?: unknown; x25519Sk?: unknown; ed25519Sk?: unknown };
  try {
    parsed = JSON.parse(utf8String(raw)) as typeof parsed;
  } catch {
    throw new VaultError('vault_corrupt', 'bundle payload malformed');
  }
  if (parsed.v !== 1 || typeof parsed.x25519Sk !== 'string' || typeof parsed.ed25519Sk !== 'string') {
    throw new VaultError('vault_corrupt', 'bundle payload malformed');
  }
  const x25519Sk = fromB64(parsed.x25519Sk);
  const ed25519Sk = fromB64(parsed.ed25519Sk);
  if (x25519Sk.length !== sodium.crypto_box_SECRETKEYBYTES
    || ed25519Sk.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new VaultError('vault_corrupt', 'bundle key lengths invalid');
  }
  const derivedX = sodium.crypto_scalarmult_base(x25519Sk);
  const derivedEd = sodium.crypto_sign_ed25519_sk_to_pk(ed25519Sk);
  if (!bytesEqual(derivedX, expected.x25519Pk) || !bytesEqual(derivedEd, expected.ed25519Pk)) {
    throw new VaultError('vault_corrupt', 'derived public keys do not match stored public keys');
  }
  return { x25519Sk, ed25519Sk };
}

export async function deriveRecoveryWrapKey(recoveryKey: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (recoveryKey.length !== RECOVERY_KEY_BYTES) {
    throw new VaultError('recovery_invalid', 'recovery key must be 32 bytes');
  }
  return sodium.crypto_kdf_derive_from_key(32, RECOVERY_KDF_SUBKEY_ID, RECOVERY_KDF_CONTEXT, recoveryKey);
}

/**
 * Recovery kit display (plan §5): FLRK1- + 52 unpadded Base32 chars in groups of 4
 * + a final 4-char checksum group (first 20 bits of SHA-256 of the key, Base32).
 */
export async function encodeRecoveryKey(key: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  if (key.length !== RECOVERY_KEY_BYTES) throw new VaultError('recovery_invalid', 'recovery key must be 32 bytes');
  const body = base32Encode(key); // 52 chars for 32 bytes
  const digest = sodium.crypto_hash_sha256(key);
  const checksum = base32Encode(digest).slice(0, 4); // 4 base32 chars = 20 bits
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4));
  groups.push(checksum);
  return `${RECOVERY_PREFIX}-${groups.join('-')}`;
}

/** Parses a recovery kit string; checksum verified BEFORE any KDF work (plan §16-P2). */
export async function decodeRecoveryKey(display: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const cleaned = display.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!cleaned.startsWith(RECOVERY_PREFIX)) {
    throw new VaultError('recovery_invalid', 'recovery code must start with FLRK1');
  }
  const rest = cleaned.slice(RECOVERY_PREFIX.length);
  if (rest.length !== 52 + 4 || /[^A-Z2-7]/.test(rest)) {
    throw new VaultError('recovery_invalid', 'recovery code has the wrong length or characters');
  }
  const body = rest.slice(0, 52);
  const checksum = rest.slice(52);
  const key = base32Decode(body).subarray(0, RECOVERY_KEY_BYTES);
  if (key.length !== RECOVERY_KEY_BYTES) throw new VaultError('recovery_invalid', 'recovery code malformed');
  const digest = sodium.crypto_hash_sha256(key);
  if (base32Encode(digest).slice(0, 4) !== checksum) {
    throw new VaultError('recovery_invalid', 'recovery code checksum failed — please re-check the code');
  }
  return key;
}

export interface GeneratedVault {
  kdf: VaultKdfParams;
  wrappedUmk: Uint8Array;
  wrappedUmkRecovery: Uint8Array;
  encKeyBundle: Uint8Array;
  x25519Pk: Uint8Array;
  ed25519Pk: Uint8Array;
  recoveryDisplay: string;
}

/** Full client-side vault creation (plan §16-P2). All secrets zeroed before return. */
export async function generateVault(passphrase: string, userId: string): Promise<GeneratedVault> {
  assertPassphraseStrength(passphrase);
  const sodium = await getSodium();
  const kdf: VaultKdfParams = {
    kdf: KDF_SUITE,
    salt: sodium.randombytes_buf(KDF_SALT_BYTES),
    opslimit: DEFAULT_KDF_OPSLIMIT,
    memlimit: DEFAULT_KDF_MEMLIMIT,
  };
  const puk = await derivePuk(passphrase, kdf);
  const umk = sodium.randombytes_buf(UMK_BYTES);
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  const recoveryKey = sodium.randombytes_buf(RECOVERY_KEY_BYTES);
  try {
    const wrappedUmk = await wrapKey(umk, puk, umkAad(userId));
    const recoveryWrapKey = await deriveRecoveryWrapKey(recoveryKey);
    const wrappedUmkRecovery = await wrapKey(umk, recoveryWrapKey, recoveryAad(userId));
    sodium.memzero(recoveryWrapKey);
    const encKeyBundle = await sealBundle(
      { x25519Sk: box.privateKey, ed25519Sk: sign.privateKey }, umk, userId,
    );
    const recoveryDisplay = await encodeRecoveryKey(recoveryKey);
    return {
      kdf,
      wrappedUmk,
      wrappedUmkRecovery,
      encKeyBundle,
      x25519Pk: box.publicKey,
      ed25519Pk: sign.publicKey,
      recoveryDisplay,
    };
  } finally {
    sodium.memzero(puk);
    sodium.memzero(umk);
    sodium.memzero(box.privateKey);
    sodium.memzero(sign.privateKey);
    sodium.memzero(recoveryKey);
  }
}
