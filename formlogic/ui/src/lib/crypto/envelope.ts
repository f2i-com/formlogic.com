// Response envelope seal/open — the frozen __flenc:1 format.
// Authority: docs/E2EE_PRIVATE_FORMS_PLAN.md §5 (suites), §6 (envelope + AAD).
// v1 has EXACTLY ONE wrap suite (sealed box to the form ingestion key). The FK-wrapped
// "adoption" path is deferred to a future __flenc:2 dekWrap structure (§6.1) — nothing
// here may emit or accept anything else.

import { getSodium } from './sodium';
import { fromB64, toB64, toHex, utf8Bytes, utf8String } from './encoding';

export const ENVELOPE_VERSION = 1 as const;
export const CONTENT_SUITE = 'xchacha20p1305.1' as const;
export const WRAP_SUITE = 'sealedbox-x25519xsalsa20p1305.1' as const;

export const NONCE_BYTES = 24;
export const DEK_BYTES = 32;
/** crypto_box_seal of a 32-byte DEK: 32 (ephemeral pk) + 32 (dek) + 16 (tag). */
export const WRAPPED_DEK_BYTES = 80;
/** Serialized envelope cap = existing MAX_ANSWER_BYTES server-side. */
export const MAX_ENVELOPE_BYTES = 2_000_000;
/** Effective inner-plaintext budget (~1.4 MB) — enforced client-side pre-seal (§6). */
export const MAX_INNER_PLAINTEXT_BYTES = 1_400_000;

const AAD_COMPONENT_RE = /^[a-zA-Z0-9_-]+$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_RE = /^fik_[a-zA-Z0-9_-]{1,36}$/;
const SCHEMA_HASH_RE = /^[0-9a-f]{64}$/;
const FILE_ID_RE = /^fil_[a-zA-Z0-9_-]{1,36}$/;

export interface ResponseEnvelope {
  __flenc: typeof ENVELOPE_VERSION;
  recordId: string;
  rev: number;
  keyId: string;
  epoch: number;
  content: typeof CONTENT_SUITE;
  wrap: typeof WRAP_SUITE;
  schemaVersion: number;
  schemaHash: string;
  attachments?: string[];
  wrappedDek: string;
  nonce: string;
  ct: string;
}

export interface EnvelopeParams {
  formId: string;
  recordId: string;
  rev: number;
  keyId: string;
  epoch: number;
  schemaVersion: number;
  schemaHash: string;
  attachments?: string[];
}

/** Inner plaintext shape (§6) — never seen by the server. */
export interface InnerPayload {
  v: 1;
  answers: Record<string, unknown>;
  meta?: { completionTime?: number; language?: string; clientAt?: string };
  files?: Record<string, Array<{ fileId: string; name: string; mime: string; size: number; sha256: string }>>;
}

export class EnvelopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'EnvelopeError';
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return toHex(sodium.crypto_hash_sha256(bytes));
}

/** SHA-256 hex of the sorted attachment ids joined by ',', or '-' when none (§6). */
export async function attachmentsHash(ids: readonly string[] | undefined): Promise<string> {
  if (!ids || ids.length === 0) return '-';
  const sorted = [...ids].sort();
  return sha256Hex(utf8Bytes(sorted.join(',')));
}

function assertAadComponent(label: string, value: string): void {
  if (!AAD_COMPONENT_RE.test(value)) {
    throw new EnvelopeError('envelope_invalid', `${label} contains characters outside [a-zA-Z0-9_-]`);
  }
}

export function validateEnvelopeParams(p: EnvelopeParams): void {
  assertAadComponent('formId', p.formId);
  if (!UUID_V4_RE.test(p.recordId)) throw new EnvelopeError('envelope_invalid', 'recordId must be a UUIDv4');
  if (!Number.isInteger(p.rev) || p.rev < 1) throw new EnvelopeError('envelope_invalid', 'rev must be a positive integer');
  if (!KEY_ID_RE.test(p.keyId)) throw new EnvelopeError('envelope_invalid', 'keyId malformed');
  if (!Number.isInteger(p.epoch) || p.epoch < 1) throw new EnvelopeError('envelope_invalid', 'epoch must be a positive integer');
  if (!Number.isInteger(p.schemaVersion) || p.schemaVersion < 1) {
    throw new EnvelopeError('envelope_invalid', 'schemaVersion must be a positive integer');
  }
  if (!SCHEMA_HASH_RE.test(p.schemaHash)) throw new EnvelopeError('envelope_invalid', 'schemaHash must be 64 lowercase hex chars');
  if (p.attachments) {
    for (const id of p.attachments) {
      if (!FILE_ID_RE.test(id)) throw new EnvelopeError('envelope_invalid', `attachment id malformed: ${id}`);
    }
  }
}

/** AAD string (§6): flenc:1|formId|recordId|rev|keyId|epoch|schemaVersion|schemaHash|attHash */
export async function buildAad(p: EnvelopeParams): Promise<string> {
  validateEnvelopeParams(p);
  const attHash = await attachmentsHash(p.attachments);
  return `flenc:1|${p.formId}|${p.recordId}|${p.rev}|${p.keyId}|${p.epoch}|${p.schemaVersion}|${p.schemaHash}|${attHash}`;
}

export function mintRecordId(randomBytes: Uint8Array): string {
  if (randomBytes.length !== 16) throw new EnvelopeError('envelope_invalid', 'recordId needs 16 random bytes');
  const b = new Uint8Array(randomBytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function sealEnvelope(
  params: EnvelopeParams,
  inner: InnerPayload,
  ingestionPublicKey: Uint8Array,
): Promise<ResponseEnvelope> {
  const sodium = await getSodium();
  validateEnvelopeParams(params);
  if (ingestionPublicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new EnvelopeError('envelope_invalid', 'ingestion public key must be 32 bytes');
  }
  const plaintext = utf8Bytes(JSON.stringify(inner));
  if (plaintext.length > MAX_INNER_PLAINTEXT_BYTES) {
    throw new EnvelopeError('payload_too_large', 'response exceeds the encrypted size budget (~1.4 MB)');
  }
  const aad = await buildAad(params);
  const dek = sodium.randombytes_buf(DEK_BYTES);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, dek);
  const wrappedDek = sodium.crypto_box_seal(dek, ingestionPublicKey);
  sodium.memzero(dek);
  const envelope: ResponseEnvelope = {
    __flenc: ENVELOPE_VERSION,
    recordId: params.recordId,
    rev: params.rev,
    keyId: params.keyId,
    epoch: params.epoch,
    content: CONTENT_SUITE,
    wrap: WRAP_SUITE,
    schemaVersion: params.schemaVersion,
    schemaHash: params.schemaHash,
    ...(params.attachments && params.attachments.length > 0
      ? { attachments: [...params.attachments].sort() }
      : {}),
    wrappedDek: toB64(wrappedDek),
    nonce: toB64(nonce),
    ct: toB64(ct),
  };
  const serialized = JSON.stringify(envelope);
  if (utf8Bytes(serialized).length > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeError('payload_too_large', 'sealed envelope exceeds the 2 MB storage cap');
  }
  return envelope;
}

/** Structural check + typed narrowing for anything claiming to be an envelope. */
export function parseEnvelope(value: unknown): ResponseEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnvelopeError('envelope_invalid', 'envelope must be an object');
  }
  const env = value as Record<string, unknown>;
  const allowed = new Set([
    '__flenc', 'recordId', 'rev', 'keyId', 'epoch', 'content', 'wrap',
    'schemaVersion', 'schemaHash', 'attachments', 'wrappedDek', 'nonce', 'ct',
  ]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) throw new EnvelopeError('envelope_invalid', `unexpected envelope key: ${key}`);
  }
  if (env.__flenc !== ENVELOPE_VERSION) throw new EnvelopeError('envelope_invalid', 'unsupported envelope version');
  if (env.content !== CONTENT_SUITE) throw new EnvelopeError('envelope_invalid', 'unknown content suite');
  if (env.wrap !== WRAP_SUITE) throw new EnvelopeError('envelope_invalid', 'unknown wrap suite');
  if (typeof env.recordId !== 'string' || typeof env.keyId !== 'string' || typeof env.schemaHash !== 'string'
    || typeof env.wrappedDek !== 'string' || typeof env.nonce !== 'string' || typeof env.ct !== 'string'
    || typeof env.rev !== 'number' || typeof env.epoch !== 'number' || typeof env.schemaVersion !== 'number') {
    throw new EnvelopeError('envelope_invalid', 'envelope field types invalid');
  }
  let attachments: string[] | undefined;
  if (env.attachments !== undefined) {
    if (!Array.isArray(env.attachments) || env.attachments.some((a) => typeof a !== 'string')) {
      throw new EnvelopeError('envelope_invalid', 'attachments must be an array of ids');
    }
    attachments = env.attachments as string[];
  }
  validateEnvelopeParams({
    formId: 'x', // formId is not part of the envelope body; validated by the caller's AAD
    recordId: env.recordId,
    rev: env.rev,
    keyId: env.keyId,
    epoch: env.epoch,
    schemaVersion: env.schemaVersion,
    schemaHash: env.schemaHash,
    attachments,
  });
  const wrapped = fromB64(env.wrappedDek);
  if (wrapped.length !== WRAPPED_DEK_BYTES) throw new EnvelopeError('envelope_invalid', 'wrappedDek must be 80 bytes');
  const nonce = fromB64(env.nonce);
  if (nonce.length !== NONCE_BYTES) throw new EnvelopeError('envelope_invalid', 'nonce must be 24 bytes');
  fromB64(env.ct);
  return env as unknown as ResponseEnvelope;
}

/** Detects the private-form marker on a stored answers value (object or JSON string). */
export function isEncryptedEnvelope(answers: unknown): boolean {
  if (typeof answers === 'string') {
    if (!answers.includes('"__flenc"')) return false;
    try {
      const parsed: unknown = JSON.parse(answers);
      return typeof parsed === 'object' && parsed !== null
        && (parsed as Record<string, unknown>).__flenc === ENVELOPE_VERSION;
    } catch {
      return false;
    }
  }
  return typeof answers === 'object' && answers !== null
    && (answers as Record<string, unknown>).__flenc === ENVELOPE_VERSION;
}

export async function openEnvelope(
  envelope: ResponseEnvelope,
  formId: string,
  ingestionPublicKey: Uint8Array,
  ingestionSecretKey: Uint8Array,
): Promise<InnerPayload> {
  const sodium = await getSodium();
  const env = parseEnvelope(envelope);
  const aad = await buildAad({
    formId,
    recordId: env.recordId,
    rev: env.rev,
    keyId: env.keyId,
    epoch: env.epoch,
    schemaVersion: env.schemaVersion,
    schemaHash: env.schemaHash,
    attachments: env.attachments,
  });
  let dek: Uint8Array;
  try {
    dek = sodium.crypto_box_seal_open(fromB64(env.wrappedDek), ingestionPublicKey, ingestionSecretKey);
  } catch {
    throw new EnvelopeError('decrypt_failed', 'DEK unwrap failed (wrong key or tampered wrappedDek)');
  }
  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, fromB64(env.ct), aad, fromB64(env.nonce), dek,
    );
    const inner: unknown = JSON.parse(utf8String(plaintext));
    if (typeof inner !== 'object' || inner === null || (inner as { v?: unknown }).v !== 1
      || typeof (inner as { answers?: unknown }).answers !== 'object') {
      throw new EnvelopeError('decrypt_failed', 'inner payload malformed');
    }
    return inner as InnerPayload;
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    throw new EnvelopeError('decrypt_failed', 'content decryption failed (tampered ciphertext or AAD mismatch)');
  } finally {
    sodium.memzero(dek);
  }
}
