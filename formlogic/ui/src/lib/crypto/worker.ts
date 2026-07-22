// E2EE crypto worker (docs/E2EE_PRIVATE_FORMS_PLAN.md §10).
//
// Owns ALL long-lived secret material in worker memory only: the UMK, the vault
// private-key bundle, and per-form Form Keys + ingestion secrets. The main thread
// never sees these — it talks to this worker through cryptoClient.ts. On lock the
// client calls the 'lock' op (memzero + drop) AND terminates the worker, so the
// next unlock starts from a pristine heap.
//
// This is hygiene and jank-avoidance, NOT an XSS boundary (plan §2 item 10).
//
// The request handler is exported so vitest can drive it in-process (node has no
// Worker); the self.onmessage glue only binds inside a real worker global.

import { getSodium } from './sodium';
import { bytesEqual, fromB64, toB64, toHex, utf8Bytes } from './encoding';
import {
  DEFAULT_KDF_MEMLIMIT,
  DEFAULT_KDF_OPSLIMIT,
  KDF_SUITE,
  assertPassphraseStrength,
  decodeRecoveryKey,
  derivePuk,
  deriveRecoveryWrapKey,
  encodeRecoveryKey,
  openBundle,
  recoveryAad,
  sealBundle,
  umkAad,
  unwrapKey,
  wrapKey,
  VaultError,
} from './vault';
import {
  CONTENT_SUITE,
  WRAP_SUITE,
  mintRecordId,
  sealEnvelope,
  openEnvelope,
  parseEnvelope,
  EnvelopeError,
  type InnerPayload,
  type ResponseEnvelope,
} from './envelope';
import {
  manifestAcceptsEnvelope,
  manifestCanonicalString,
  signManifestCanonical,
  signerKeyIdFromPk,
} from './manifest';
import type {
  EnableEncryptionPayload,
  FormKeyGrantWire,
  IngestionKeyWire,
  ManifestRowWire,
  VaultWire,
} from '../../types/e2ee';

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export type CryptoOp =
  | 'status'
  | 'createVault'
  | 'unlock'
  | 'recoveryUnlock'
  | 'changePassphrase'
  | 'lock'
  | 'enableFormEncryption'
  | 'publishSchemaVersion'
  | 'loadFormKeys'
  | 'sealResponse'
  | 'openResponses'
  | 'signDataStructure';

export interface CryptoWorkerRequest {
  id: number;
  op: CryptoOp;
  payload?: unknown;
}

export interface CryptoWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

class WorkerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkerError';
  }
}

// ---------------------------------------------------------------------------
// Worker-local secret state (never serialized out of this module)
// ---------------------------------------------------------------------------

interface VaultSecrets {
  userId: string;
  umk: Uint8Array;
  x25519Sk: Uint8Array;
  ed25519Sk: Uint8Array;
  x25519Pk: Uint8Array;
  ed25519Pk: Uint8Array;
}

interface FormKeyEntry {
  fk: Uint8Array;
  fkEpoch: number;
  ingestion: Map<number, { keyId: string; pk: Uint8Array; sk: Uint8Array }>;
}

let vaultSecrets: VaultSecrets | null = null;
const formKeys = new Map<string, FormKeyEntry>();
// Dev-only nonce uniqueness assertion (plan §17): a repeated response nonce would
// be a CSPRNG failure worth crashing over in development.
const seenNonces = new Set<string>();

function requireUnlocked(): VaultSecrets {
  if (!vaultSecrets) throw new WorkerError('vault_locked', 'The vault is locked');
  return vaultSecrets;
}

function dropSecrets(): void {
  // Capture references first — zeroing is best-effort async (sodium loads lazily),
  // but the references are dropped synchronously either way.
  const vs = vaultSecrets;
  const entries = [...formKeys.values()];
  vaultSecrets = null;
  formKeys.clear();
  seenNonces.clear();
  if (!vs && entries.length === 0) return;
  void getSodium().then((sodium) => {
    if (vs) {
      sodium.memzero(vs.umk);
      sodium.memzero(vs.x25519Sk);
      sodium.memzero(vs.ed25519Sk);
    }
    for (const entry of entries) {
      sodium.memzero(entry.fk);
      for (const ing of entry.ingestion.values()) sodium.memzero(ing.sk);
    }
  }).catch(() => { /* best-effort zeroing */ });
}

/** Test hook: full reset of worker-local state (what 'lock' + restart would do). */
export function __resetCryptoWorkerState(): void {
  dropSecrets();
}

// ---------------------------------------------------------------------------
// Vault wire helpers
// ---------------------------------------------------------------------------

function parseVaultWire(wire: VaultWire): {
  kdf: { kdf: typeof KDF_SUITE; salt: Uint8Array; opslimit: number; memlimit: number };
  wrappedUmk: Uint8Array;
  wrappedUmkRecovery: Uint8Array | null;
  encKeyBundle: Uint8Array;
  x25519Pk: Uint8Array;
  ed25519Pk: Uint8Array;
} {
  if (wire.kdf !== KDF_SUITE) throw new WorkerError('vault_corrupt', 'unknown KDF suite');
  return {
    kdf: { kdf: KDF_SUITE, salt: fromB64(wire.kdfSalt), opslimit: wire.kdfOpslimit, memlimit: wire.kdfMemlimit },
    wrappedUmk: fromB64(wire.wrappedUmk),
    wrappedUmkRecovery: wire.wrappedUmkRecovery ? fromB64(wire.wrappedUmkRecovery) : null,
    encKeyBundle: fromB64(wire.encKeyBundle),
    x25519Pk: fromB64(wire.x25519Pk),
    ed25519Pk: fromB64(wire.ed25519Pk),
  };
}

/** Adopt a freshly derived UMK + verified bundle as the worker's unlocked state. */
async function adoptSecrets(userId: string, umk: Uint8Array, wire: ReturnType<typeof parseVaultWire>): Promise<void> {
  const bundle = await openBundle(wire.encKeyBundle, umk, userId, {
    x25519Pk: wire.x25519Pk,
    ed25519Pk: wire.ed25519Pk,
  });
  // Retain private copies; openBundle hands us the bundle's own buffers.
  vaultSecrets = {
    userId,
    umk,
    x25519Sk: bundle.x25519Sk,
    ed25519Sk: bundle.ed25519Sk,
    x25519Pk: new Uint8Array(wire.x25519Pk),
    ed25519Pk: new Uint8Array(wire.ed25519Pk),
  };
}

/** Rewrap the in-memory UMK under a new passphrase (fresh salt, launch-floor params). */
async function rewrapUmkForNewPassphrase(
  userId: string,
  umk: Uint8Array,
  newPassphrase: string,
): Promise<Pick<VaultWire, 'kdf' | 'kdfSalt' | 'kdfMemlimit' | 'kdfOpslimit' | 'wrappedUmk'>> {
  const sodium = await getSodium();
  const kdf = {
    kdf: KDF_SUITE,
    salt: sodium.randombytes_buf(16),
    opslimit: DEFAULT_KDF_OPSLIMIT,
    memlimit: DEFAULT_KDF_MEMLIMIT,
  };
  const puk = await derivePuk(newPassphrase, kdf);
  try {
    const wrappedUmk = await wrapKey(umk, puk, umkAad(userId));
    return {
      kdf: KDF_SUITE,
      kdfSalt: toB64(kdf.salt),
      kdfMemlimit: kdf.memlimit,
      kdfOpslimit: kdf.opslimit,
      wrappedUmk: toB64(wrappedUmk),
    };
  } finally {
    sodium.memzero(puk);
  }
}

// ---------------------------------------------------------------------------
// Op handlers
// ---------------------------------------------------------------------------

async function handleCreateVault(payload: { userId: string; passphrase: string }): Promise<{
  vault: VaultWire;
  recoveryDisplay: string;
}> {
  const sodium = await getSodium();
  const { userId, passphrase } = payload;
  if (!userId) throw new WorkerError('vault_invalid', 'userId required');
  assertPassphraseStrength(passphrase);
  const kdf = {
    kdf: KDF_SUITE,
    salt: sodium.randombytes_buf(16),
    opslimit: DEFAULT_KDF_OPSLIMIT,
    memlimit: DEFAULT_KDF_MEMLIMIT,
  };
  const puk = await derivePuk(passphrase, kdf);
  const umk = sodium.randombytes_buf(32);
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  const recoveryKey = sodium.randombytes_buf(32);
  try {
    const wrappedUmk = await wrapKey(umk, puk, umkAad(userId));
    const recoveryWrapKey = await deriveRecoveryWrapKey(recoveryKey);
    let wrappedUmkRecovery: Uint8Array;
    try {
      wrappedUmkRecovery = await wrapKey(umk, recoveryWrapKey, recoveryAad(userId));
    } finally {
      sodium.memzero(recoveryWrapKey);
    }
    const encKeyBundle = await sealBundle(
      { x25519Sk: box.privateKey, ed25519Sk: sign.privateKey }, umk, userId,
    );
    const recoveryDisplay = await encodeRecoveryKey(recoveryKey);
    // The vault is born unlocked: adopt the secrets (private copies — the locals are
    // zeroed in the finally below).
    vaultSecrets = {
      userId,
      umk: new Uint8Array(umk),
      x25519Sk: new Uint8Array(box.privateKey),
      ed25519Sk: new Uint8Array(sign.privateKey),
      x25519Pk: new Uint8Array(box.publicKey),
      ed25519Pk: new Uint8Array(sign.publicKey),
    };
    return {
      vault: {
        version: 1,
        kdf: KDF_SUITE,
        kdfSalt: toB64(kdf.salt),
        kdfMemlimit: kdf.memlimit,
        kdfOpslimit: kdf.opslimit,
        wrappedUmk: toB64(wrappedUmk),
        wrappedUmkRecovery: toB64(wrappedUmkRecovery),
        encKeyBundle: toB64(encKeyBundle),
        x25519Pk: toB64(box.publicKey),
        ed25519Pk: toB64(sign.publicKey),
      },
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

async function handleUnlock(payload: { userId: string; passphrase: string; vault: VaultWire }): Promise<{ ok: true }> {
  const sodium = await getSodium();
  const { userId, passphrase } = payload;
  const wire = parseVaultWire(payload.vault);
  const puk = await derivePuk(passphrase, wire.kdf);
  try {
    const umk = await unwrapKey(wire.wrappedUmk, puk, umkAad(userId));
    // adoptSecrets verifies the re-derived public keys (corrupted bundle → vault_corrupt, §5).
    await adoptSecrets(userId, umk, wire);
  } finally {
    sodium.memzero(puk);
  }
  return { ok: true };
}

async function handleRecoveryUnlock(payload: {
  userId: string;
  recoveryCode: string;
  newPassphrase: string;
  vault: VaultWire;
}): Promise<{ rewrap: Pick<VaultWire, 'kdf' | 'kdfSalt' | 'kdfMemlimit' | 'kdfOpslimit' | 'wrappedUmk'> }> {
  const sodium = await getSodium();
  const { userId, recoveryCode, newPassphrase } = payload;
  assertPassphraseStrength(newPassphrase, 'New passphrase');
  const wire = parseVaultWire(payload.vault);
  if (!wire.wrappedUmkRecovery) throw new WorkerError('recovery_invalid', 'This vault has no recovery kit');
  // Checksum + format are verified inside decodeRecoveryKey BEFORE any KDF work (§16-P2 gate).
  const recoveryKey = await decodeRecoveryKey(recoveryCode);
  try {
    const recoveryWrapKey = await deriveRecoveryWrapKey(recoveryKey);
    let umk: Uint8Array;
    try {
      umk = await unwrapKey(wire.wrappedUmkRecovery, recoveryWrapKey, recoveryAad(userId));
    } finally {
      sodium.memzero(recoveryWrapKey);
    }
    await adoptSecrets(userId, umk, wire);
    // Recovery replaces the passphrase: rewrap the UMK under the new one (the recovery
    // wrapper itself is untouched — the recovery kit stays valid).
    const rewrap = await rewrapUmkForNewPassphrase(userId, umk, newPassphrase);
    return { rewrap };
  } finally {
    sodium.memzero(recoveryKey);
  }
}

async function handleChangePassphrase(payload: {
  userId: string;
  currentPassphrase: string;
  newPassphrase: string;
  vault: VaultWire;
}): Promise<{ rewrap: Pick<VaultWire, 'kdf' | 'kdfSalt' | 'kdfMemlimit' | 'kdfOpslimit' | 'wrappedUmk'> }> {
  const sodium = await getSodium();
  const secrets = requireUnlocked();
  const { userId, currentPassphrase, newPassphrase } = payload;
  assertPassphraseStrength(newPassphrase, 'New passphrase');
  const wire = parseVaultWire(payload.vault);
  // Verify the CURRENT passphrase against the served wrap before rewrapping — the
  // server can't check it (E2EE), so the client must.
  const puk = await derivePuk(currentPassphrase, wire.kdf);
  try {
    await unwrapKey(wire.wrappedUmk, puk, umkAad(userId));
  } finally {
    sodium.memzero(puk);
  }
  // Rewrap-only by construction (§11): only the passphrase-side wrapper changes; the
  // recovery wrapper, key bundle, grants, and data are untouched.
  const rewrap = await rewrapUmkForNewPassphrase(userId, secrets.umk, newPassphrase);
  return { rewrap };
}

async function handleEnableFormEncryption(payload: {
  userId: string;
  formId: string;
  schemaJson: string;
}): Promise<EnableEncryptionPayload> {
  const sodium = await getSodium();
  const secrets = requireUnlocked();
  const { formId, schemaJson } = payload;
  if (!formId) throw new WorkerError('envelope_invalid', 'formId required');

  const fk = sodium.randombytes_buf(32);
  const ingest = sodium.crypto_box_keypair();
  try {
    const keyId = `fik_${toHex(sodium.randombytes_buf(16))}`;
    const fkEpoch = 1 as const;
    const ingestEpoch = 1 as const;
    const wrappedIngestionSecret = await wrapKey(
      ingest.privateKey, fk, `flingest:1|${formId}|${ingestEpoch}|${fkEpoch}`,
    );

    // Owner self-grant (§11): sealed FK + Ed25519 signature over the canonical grant string.
    const grantId = `fkg_${toHex(sodium.randombytes_buf(16))}`;
    const wrappedKey = sodium.crypto_box_seal(fk, secrets.x25519Pk);
    const grantorKeyId = await signerKeyIdFromPk(secrets.ed25519Pk);
    const granteePkHash = toHex(sodium.crypto_hash_sha256(secrets.x25519Pk));
    const wrappedKeyHash = toHex(sodium.crypto_hash_sha256(wrappedKey));
    const grantCanonical = `flgrant:1|${grantId}|${formId}|${fkEpoch}|${secrets.userId}|${secrets.userId}|${granteePkHash}|${wrappedKeyHash}|${WRAP_SUITE}|owner|-`;
    const grantSig = await signManifestCanonical(grantCanonical, secrets.ed25519Sk);

    const schemaHash = toHex(sodium.crypto_hash_sha256(utf8Bytes(schemaJson)));
    const publicKey = toB64(ingest.publicKey);
    const canonical = manifestCanonicalString({
      formId,
      keyId,
      epoch: ingestEpoch,
      publicKey,
      content: CONTENT_SUITE,
      wrap: WRAP_SUITE,
      schemaVersion: 1,
      schemaHash,
      signerKeyId: grantorKeyId,
      expiresAt: null,
    });
    const signature = await signManifestCanonical(canonical, secrets.ed25519Sk);

    // Cache the form keys so the owner can decrypt immediately after enabling.
    formKeys.set(formId, {
      fk: new Uint8Array(fk),
      fkEpoch,
      ingestion: new Map([[ingestEpoch, { keyId, pk: new Uint8Array(ingest.publicKey), sk: new Uint8Array(ingest.privateKey) }]]),
    });

    return {
      keyId,
      fkEpoch,
      ingestEpoch,
      ingestionPublicKey: publicKey,
      wrappedIngestionSecret: toB64(wrappedIngestionSecret),
      schema: { schemaJson, schemaHash },
      grant: {
        grantId,
        wrappedKey: toB64(wrappedKey),
        signature: grantSig,
        role: 'owner',
        sigVersion: 1,
      },
      manifest: {
        signature,
        signerKeyId: grantorKeyId,
        expiresAt: null,
      },
    };
  } finally {
    sodium.memzero(fk);
    sodium.memzero(ingest.privateKey);
  }
}

async function handlePublishSchemaVersion(payload: {
  userId: string;
  formId: string;
  keyId: string;
  ingestEpoch: number;
  schemaJson: string;
  version: number;
}): Promise<{ manifest: EnableEncryptionPayload['manifest']; schemaHash: string }> {
  const sodium = await getSodium();
  const secrets = requireUnlocked();
  const { formId, keyId, ingestEpoch, schemaJson, version } = payload;
  const entry = formKeys.get(formId);
  const ing = entry?.ingestion.get(ingestEpoch);
  if (!ing || ing.keyId !== keyId) {
    throw new WorkerError('key_unavailable', 'Form keys are not loaded in the worker — reload and try again');
  }
  const schemaHash = toHex(sodium.crypto_hash_sha256(utf8Bytes(schemaJson)));
  const signerKeyId = await signerKeyIdFromPk(secrets.ed25519Pk);
  const canonical = manifestCanonicalString({
    formId,
    keyId,
    epoch: ingestEpoch,
    publicKey: toB64(ing.pk),
    content: CONTENT_SUITE,
    wrap: WRAP_SUITE,
    schemaVersion: version,
    schemaHash,
    signerKeyId,
    expiresAt: null,
  });
  const signature = await signManifestCanonical(canonical, secrets.ed25519Sk);
  return {
    manifest: { signature, signerKeyId, expiresAt: null },
    schemaHash,
  };
}

/**
 * Owner-side verification of ONE stored manifest row (review 2026-07-22, blocker 4):
 * the owner is the only signer in P3, so EVERY served row — current or historical —
 * must (1) be signed by THIS vault's Ed25519 key, (2) bind signerKeyId to that key,
 * (3) reference a served ingestion key + schema version, (4) carry a schemaHash equal
 * to SHA-256 of the exact served schema snapshot bytes, (5) hold signed_bytes equal
 * to the canonical string recomputed from the row, and (6) carry a valid Ed25519
 * signature over those exact bytes. Any failure is a typed refusal — keys never load.
 */
async function verifyStoredManifestRow(
  sodium: Awaited<ReturnType<typeof getSodium>>,
  secrets: VaultSecrets,
  formId: string,
  m: ManifestRowWire,
  ingestionKeys: IngestionKeyWire[],
  schemaVersions: { version: number; schemaHash: string; schemaJson: string }[],
): Promise<void> {
  const signerPk = fromB64(m.signerPk);
  if (signerPk.length !== 32 || !bytesEqual(signerPk, secrets.ed25519Pk)) {
    throw new WorkerError('manifest_invalid', 'A stored manifest was not signed by this vault');
  }
  if ((await signerKeyIdFromPk(signerPk)) !== m.signerKeyId) {
    throw new WorkerError('manifest_invalid', 'A stored manifest signerKeyId does not match its signer key');
  }
  if (m.contentSuite !== CONTENT_SUITE || m.wrapSuite !== WRAP_SUITE) {
    throw new WorkerError('manifest_invalid', 'A stored manifest names an unknown suite');
  }
  const key = ingestionKeys.find((k) => k.id === m.keyId);
  if (!key || key.epoch !== m.ingestEpoch) {
    throw new WorkerError('manifest_invalid', 'A stored manifest references an unknown ingestion key');
  }
  const schema = schemaVersions.find((s) => s.version === m.schemaVersion);
  if (!schema) {
    throw new WorkerError('manifest_invalid', 'A stored manifest references a missing schema version');
  }
  const recomputed = toHex(sodium.crypto_hash_sha256(utf8Bytes(schema.schemaJson)));
  if (recomputed !== m.schemaHash || recomputed !== schema.schemaHash) {
    throw new WorkerError('manifest_invalid', 'A stored manifest schemaHash does not match the served schema bytes');
  }
  const canonical = manifestCanonicalString({
    formId,
    keyId: m.keyId,
    epoch: m.ingestEpoch,
    publicKey: key.publicKey,
    content: m.contentSuite,
    wrap: m.wrapSuite,
    schemaVersion: m.schemaVersion,
    schemaHash: m.schemaHash,
    signerKeyId: m.signerKeyId,
    expiresAt: m.expiresAt,
  });
  if (m.signedBytes !== canonical) {
    throw new WorkerError('manifest_invalid', 'A stored manifest canonical bytes were altered');
  }
  const ok = sodium.crypto_sign_verify_detached(fromB64(m.signature), utf8Bytes(m.signedBytes), signerPk);
  if (!ok) {
    throw new WorkerError('manifest_invalid', 'A stored manifest signature verification failed');
  }
}

async function handleLoadFormKeys(payload: {
  formId: string;
  grants: FormKeyGrantWire[];
  ingestionKeys: IngestionKeyWire[];
  manifests?: ManifestRowWire[];
  schemaVersions?: { version: number; schemaHash: string; schemaJson: string }[];
}): Promise<{ loadedEpochs: number[] }> {
  const sodium = await getSodium();
  const secrets = requireUnlocked();
  const { formId, grants, ingestionKeys } = payload;
  const manifests = payload.manifests ?? [];
  const schemaVersions = payload.schemaVersions ?? [];
  // The backend serves the caller's latest non-revoked grant (revoked ones are
  // filtered server-side), so the local check is just "is it ours?".
  const grant = grants.find((g) => g.granteeUserId === secrets.userId);
  if (!grant) throw new WorkerError('key_unavailable', 'No active key grant for this account');
  // P3 is owner-only: NEVER unwrap an FK from a grant that is not a complete
  // self-grant — any other grantor/grantee fails closed BEFORE any crypto (a
  // tampered grantorUserId must not skip verification, review 2026-07-22 blocker 4).
  if (grant.grantorUserId !== secrets.userId || grant.granteeUserId !== secrets.userId) {
    throw new WorkerError('grant_invalid', 'Refusing a key grant that is not a vault-owner self-grant');
  }
  // Grant integrity (§11): the grantee key snapshot must be OUR X25519 key, and the
  // signature over the exact canonical grant string must verify against the vault
  // Ed25519 key — before the wrapped FK is touched.
  if (!bytesEqual(fromB64(grant.granteePk), secrets.x25519Pk)) {
    throw new WorkerError('grant_invalid', 'Key grant is sealed to a different public key');
  }
  const granteePkHash = toHex(sodium.crypto_hash_sha256(fromB64(grant.granteePk)));
  const wrappedKeyHash = toHex(sodium.crypto_hash_sha256(fromB64(grant.wrappedKey)));
  const canonical = `flgrant:1|${grant.grantId}|${formId}|${grant.fkEpoch}|${grant.grantorUserId}|${grant.granteeUserId}|${granteePkHash}|${wrappedKeyHash}|${WRAP_SUITE}|${grant.role}|-`;
  const ok = sodium.crypto_sign_verify_detached(fromB64(grant.signature), utf8Bytes(canonical), secrets.ed25519Pk);
  if (!ok) throw new WorkerError('grant_invalid', 'Key grant signature verification failed');
  // EVERY served manifest row is verified before any key loads (blocker 4) — the
  // owner is the only signer in P3, so anything not signed by this vault is refused.
  if (manifests.length === 0) {
    throw new WorkerError('manifest_invalid', 'No manifests were served for a private form');
  }
  for (const m of manifests) {
    await verifyStoredManifestRow(sodium, secrets, formId, m, ingestionKeys, schemaVersions);
  }
  let fk: Uint8Array;
  try {
    fk = sodium.crypto_box_seal_open(fromB64(grant.wrappedKey), secrets.x25519Pk, secrets.x25519Sk);
  } catch {
    throw new WorkerError('grant_invalid', 'Could not unwrap the form key grant (wrong vault or tampered grant)');
  }
  const entry: FormKeyEntry = { fk, fkEpoch: grant.fkEpoch, ingestion: new Map() };
  try {
    for (const key of ingestionKeys) {
      if (key.state === 'retired') continue;
      const sk = await unwrapKey(fromB64(key.wrappedSecret), fk, `flingest:1|${formId}|${key.epoch}|${key.fkEpoch}`);
      // Fail closed if the unwrapped secret doesn't match the served public key.
      const derived = sodium.crypto_scalarmult_base(sk);
      const served = fromB64(key.publicKey);
      if (!bytesEqual(derived, served)) {
        sodium.memzero(sk);
        throw new WorkerError('key_mismatch', `Ingestion key epoch ${key.epoch} does not match its public key`);
      }
      entry.ingestion.set(key.epoch, { keyId: key.id, pk: served, sk });
    }
  } catch (e) {
    sodium.memzero(fk);
    for (const ing of entry.ingestion.values()) sodium.memzero(ing.sk);
    throw e;
  }
  formKeys.set(formId, entry);
  return { loadedEpochs: [...entry.ingestion.keys()] };
}

async function handleSealResponse(payload: {
  formId: string;
  keyId: string;
  epoch: number;
  schemaVersion: number;
  schemaHash: string;
  publicKey: string;
  rev?: number;
  recordId?: string;
  inner: InnerPayload;
}): Promise<{ envelope: ResponseEnvelope }> {
  const sodium = await getSodium();
  const recordId = payload.recordId ?? mintRecordId(sodium.randombytes_buf(16));
  const envelope = await sealEnvelope(
    {
      formId: payload.formId,
      recordId,
      rev: payload.rev ?? 1,
      keyId: payload.keyId,
      epoch: payload.epoch,
      schemaVersion: payload.schemaVersion,
      schemaHash: payload.schemaHash,
    },
    payload.inner,
    fromB64(payload.publicKey),
  );
  if (import.meta.env?.DEV) {
    if (seenNonces.has(envelope.nonce)) {
      throw new WorkerError('nonce_reused', 'FATAL: response nonce reused (CSPRNG failure)');
    }
    seenNonces.add(envelope.nonce);
    if (seenNonces.size > 100_000) seenNonces.clear();
  }
  return { envelope };
}

async function handleOpenResponses(payload: {
  formId: string;
  items: { envelope: unknown }[];
  manifests: Pick<ManifestRowWire, 'keyId' | 'ingestEpoch' | 'schemaVersion' | 'schemaHash'>[];
  keys: Pick<IngestionKeyWire, 'id' | 'state' | 'acceptUntil'>[];
}): Promise<{
  results: ({ recordId: string; rev: number; inner: InnerPayload } | { recordId: string; error: { code: string; message: string } })[];
}> {
  requireUnlocked();
  const entry = formKeys.get(payload.formId);
  if (!entry) throw new WorkerError('key_unavailable', 'Form keys are not loaded in the worker');
  const byKeyId = new Map([...entry.ingestion.values()].map((ing) => [ing.keyId, ing]));
  const results: Awaited<ReturnType<typeof handleOpenResponses>>['results'] = [];
  for (const item of payload.items) {
    let env: ResponseEnvelope;
    try {
      env = parseEnvelope(item.envelope);
    } catch (e) {
      results.push({
        recordId: 'unknown',
        error: { code: e instanceof EnvelopeError ? e.code : 'envelope_invalid', message: e instanceof Error ? e.message : 'invalid envelope' },
      });
      continue;
    }
    // Manifest acceptance rule (§8) before any decryption attempt.
    if (!manifestAcceptsEnvelope(payload.manifests, payload.keys, {
      keyId: env.keyId, epoch: env.epoch, schemaVersion: env.schemaVersion, schemaHash: env.schemaHash,
    })) {
      results.push({
        recordId: env.recordId,
        error: { code: 'manifest_rejected', message: 'Envelope does not match any acceptable manifest (retired epoch or schema skew)' },
      });
      continue;
    }
    const ing = byKeyId.get(env.keyId);
    if (!ing) {
      results.push({
        recordId: env.recordId,
        error: { code: 'key_unavailable', message: 'No key available for this envelope (pre-dates your access?)' },
      });
      continue;
    }
    try {
      const inner = await openEnvelope(env, payload.formId, ing.pk, ing.sk);
      results.push({ recordId: env.recordId, rev: env.rev, inner });
    } catch (e) {
      results.push({
        recordId: env.recordId,
        error: { code: e instanceof EnvelopeError ? e.code : 'decrypt_failed', message: e instanceof Error ? e.message : 'decrypt failed' },
      });
    }
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Dispatcher (exported for in-process tests)
// ---------------------------------------------------------------------------

export async function handleCryptoRequest(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse> {
  const { id, op } = request;
  try {
    let result: unknown;
    switch (op) {
      case 'status':
        result = { unlocked: vaultSecrets !== null, userId: vaultSecrets?.userId ?? null };
        break;
      case 'createVault':
        result = await handleCreateVault(request.payload as Parameters<typeof handleCreateVault>[0]);
        break;
      case 'unlock':
        result = await handleUnlock(request.payload as Parameters<typeof handleUnlock>[0]);
        break;
      case 'recoveryUnlock':
        result = await handleRecoveryUnlock(request.payload as Parameters<typeof handleRecoveryUnlock>[0]);
        break;
      case 'changePassphrase':
        result = await handleChangePassphrase(request.payload as Parameters<typeof handleChangePassphrase>[0]);
        break;
      case 'lock':
        dropSecrets();
        result = { ok: true };
        break;
      case 'enableFormEncryption':
        result = await handleEnableFormEncryption(request.payload as Parameters<typeof handleEnableFormEncryption>[0]);
        break;
      case 'publishSchemaVersion':
        result = await handlePublishSchemaVersion(request.payload as Parameters<typeof handlePublishSchemaVersion>[0]);
        break;
      case 'loadFormKeys':
        result = await handleLoadFormKeys(request.payload as Parameters<typeof handleLoadFormKeys>[0]);
        break;
      case 'sealResponse':
        result = await handleSealResponse(request.payload as Parameters<typeof handleSealResponse>[0]);
        break;
      case 'openResponses':
        result = await handleOpenResponses(request.payload as Parameters<typeof handleOpenResponses>[0]);
        break;
      case 'signDataStructure':
        result = await handleSignDataStructure(request.payload as Parameters<typeof handleSignDataStructure>[0]);
        break;
      default:
        throw new WorkerError('unknown_op', `Unknown crypto op: ${String(op)}`);
    }
    return { id, ok: true, result };
  } catch (e) {
    const code = e instanceof WorkerError || e instanceof VaultError || e instanceof EnvelopeError
      ? e.code
      : 'crypto_error';
    return { id, ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } };
  }
}

// ---------------------------------------------------------------------------
// Data-node structure signing (docs/FORMLOGIC_DATA_NODES.md §2, §11)
// ---------------------------------------------------------------------------

const DATA_SIGN_DOMAINS = new Set(['flplacement:1', 'flnodecert:1']);

/**
 * Sign a data-node structure (placement manifest / node-authority certificate)
 * with the vault Ed25519 key under a WHITELISTED flcanon/1 domain. The
 * structure's ownerSigner* fields must already match this vault — the worker
 * never signs an identity claim it does not hold, and the allowlist keeps this
 * op from ever producing an operation/checkpoint/backup signature (those are
 * node/Cloud authorities, not the owner).
 */
async function handleSignDataStructure(payload: {
  domain: string;
  structure: Record<string, unknown>;
}): Promise<{ signature: string; signerKeyId: string; signerFingerprint: string }> {
  const secrets = requireUnlocked();
  if (!DATA_SIGN_DOMAINS.has(payload.domain)) {
    throw new WorkerError('data_sign_domain', `The vault does not sign ${payload.domain} structures`);
  }
  const { signStructure, dataKeyId, dataKeyFingerprint } = await import('../data/canonical');
  const signerKeyId = await dataKeyId(secrets.ed25519Pk);
  const signerFingerprint = await dataKeyFingerprint(secrets.ed25519Pk);
  const claimedKeyId = payload.structure['ownerSignerKeyId'];
  const claimedFp = payload.structure['ownerSignerFingerprint'];
  if (claimedKeyId !== signerKeyId || claimedFp !== signerFingerprint) {
    throw new WorkerError('data_sign_identity', 'ownerSigner fields do not match this vault');
  }
  const signature = await signStructure(payload.domain, payload.structure, secrets.ed25519Sk);
  return { signature, signerKeyId, signerFingerprint };
}

// Bind inside a real worker only (excluded in node tests and jsdom, where `window` exists).
if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  (self as unknown as { onmessage: (e: MessageEvent<CryptoWorkerRequest>) => void }).onmessage = (event) => {
    void handleCryptoRequest(event.data).then((response) => {
      (self as unknown as { postMessage: (msg: CryptoWorkerResponse) => void }).postMessage(response);
    });
  };
}
