// flcanon/1 — RFC 8785 (JCS) restricted to an integer-only subset, plus the
// domain-separated signing preimages for the data-nodes protocol
// (docs/FORMLOGIC_DATA_NODES.md §1-§3, plan docs/FORMLOGIC_DESKTOP_ENCRYPTED_DATA_NODES_PLAN.md §6).
//
// Mirrored byte-for-byte by backend/src/Support/DataCanonicalJson.php and
// desktop/src-tauri/src/data/canonical.rs; all three assert
// docs/contracts/data-sync-vectors.json. Any rule change is a protocol version bump.
//
// Verification never re-parses leniently: verifiers parse received bytes,
// re-serialize with flcanon/1, and require byte equality — which inherently rejects
// duplicate keys, floats, -0, exponent forms, and whitespace variants.

import { getSodium } from '../crypto/sodium';
import { concatBytes, fromB64, toB64, toHex, utf8Bytes } from '../crypto/encoding';

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export const DATA_PROTOCOL = 'formlogic-data-sync/1';

/** Frozen signing/hash domains (docs/FORMLOGIC_DATA_NODES.md §2). */
export const DOMAIN_PLACEMENT = 'flplacement:1';
export const DOMAIN_OPERATION = 'flop:1';
export const DOMAIN_CHECKPOINT = 'flcheckpoint:1';
export const DOMAIN_BACKUP = 'flbackup:1';
export const DOMAIN_NODE_CERT = 'flnodecert:1';
export const DOMAIN_LOGICAL_ROOT = 'flroot:1';
export const DOMAIN_HIGH_WATER = 'flhw:1';

const MAX_DEPTH = 64;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class CanonicalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CanonicalError';
  }
}

/** JCS string escaping: the five short escapes + \" \\, \u00xx lowercase for other C0, raw UTF-8 elsewhere. */
function escapeString(s: string): string {
  if (LONE_SURROGATE_RE.test(s)) {
    throw new CanonicalError('canonical_invalid', 'lone surrogate in string');
  }
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** UTF-16 code-unit comparison (the exact JCS key ordering; differs from code-point order for non-BMP). */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalError('canonical_invalid', 'nesting too deep');
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    const n = value as number;
    if (!Number.isSafeInteger(n)) {
      throw new CanonicalError('canonical_invalid', 'numbers must be safe integers');
    }
    if (Object.is(n, -0)) throw new CanonicalError('canonical_invalid', '-0 is invalid');
    return String(n);
  }
  if (t === 'string') return escapeString(value as string);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => serialize(v, depth + 1)).join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareUtf16);
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) {
        throw new CanonicalError('canonical_invalid', `undefined value for key ${key}`);
      }
      parts.push(escapeString(key) + ':' + serialize(v, depth + 1));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalError('canonical_invalid', `unsupported type ${t}`);
}

/** flcanon/1 serialization of any canonical value. */
export function canonicalize(value: unknown): string {
  return serialize(value, 0);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8Bytes(canonicalize(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** preimage = ASCII(domain) || 0x0A || flcanon(structure). Top level must be an object. */
export function signingPreimage(domain: string, structure: unknown): Uint8Array {
  if (!isPlainObject(structure)) {
    throw new CanonicalError('canonical_invalid', 'signed structures must be objects');
  }
  return concatBytes(utf8Bytes(domain), Uint8Array.of(0x0a), canonicalBytes(structure));
}

/** SHA-256 lowercase hex over the domain-separated preimage. */
export async function domainHashHex(domain: string, structure: unknown): Promise<string> {
  const sodium = await getSodium();
  return toHex(sodium.crypto_hash_sha256(signingPreimage(domain, structure)));
}

function withoutSignature(structure: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...structure };
  delete rest.signature;
  return rest;
}

/** Ed25519 detached signature (base64, padded) over the preimage of the structure WITHOUT its signature field. */
export async function signStructure(
  domain: string,
  structure: Record<string, unknown>,
  ed25519Sk: Uint8Array,
): Promise<string> {
  const sodium = await getSodium();
  return toB64(sodium.crypto_sign_detached(signingPreimage(domain, withoutSignature(structure)), ed25519Sk));
}

/** Verify a signed structure's `signature` field against the domain preimage. */
export async function verifyStructure(
  domain: string,
  structure: Record<string, unknown>,
  ed25519Pk: Uint8Array,
): Promise<boolean> {
  const sig = structure['signature'];
  if (typeof sig !== 'string') return false;
  let raw: Uint8Array;
  try {
    raw = fromB64(sig);
  } catch {
    return false;
  }
  if (raw.length !== 64) return false;
  const sodium = await getSodium();
  return sodium.crypto_sign_verify_detached(raw, signingPreimage(domain, withoutSignature(structure)), ed25519Pk);
}

/** keyId = first 16 hex of SHA-256(raw pk); fingerprint = full 64 hex (docs/FORMLOGIC_DATA_NODES.md §2). */
export async function dataKeyId(ed25519Pk: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return toHex(sodium.crypto_hash_sha256(ed25519Pk)).slice(0, 16);
}

export async function dataKeyFingerprint(ed25519Pk: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return toHex(sodium.crypto_hash_sha256(ed25519Pk));
}

export type LogicalRootEntry =
  | ['response', string, number, number, string]
  | ['tombstone', string, number, string]
  | ['artifact', string, string, string]
  | ['attachment', string, string];

function compareUtf8Bytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * v1 logical root (docs/FORMLOGIC_DATA_NODES.md §3): entries sorted by the UTF-8 bytes
 * of their flcanon serialization (memcmp, NOT UTF-16 order), hashed under flroot:1.
 */
export async function computeLogicalRootHex(
  datasetId: string,
  entries: readonly LogicalRootEntry[],
): Promise<string> {
  const sorted = entries
    .map((entry) => ({ entry, bytes: canonicalBytes(entry) }))
    .sort((a, b) => compareUtf8Bytes(a.bytes, b.bytes))
    .map((item) => item.entry);
  return domainHashHex(DOMAIN_LOGICAL_ROOT, { v: 1, datasetId, entries: sorted });
}
