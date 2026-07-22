// Submitter-side TOFU pinning of the manifest signer key, per form
// (docs/E2EE_PRIVATE_FORMS_PLAN.md §8 "Verification honesty"). First sight of a
// private form pins signerPk; a CHANGED signer for a known form is refused loudly —
// same posture as the desktop tunnel pins. Only public key material is persisted.
//
// The pin store is localStorage-scoped (per browser profile); pins are not secrets.
// FAIL CLOSED (review 2026-07-22): when localStorage is unavailable or a read/write
// fails, pinning REFUSES with a typed PinStorageError — there is NO silent in-memory
// session fallback, which would quietly accept a key change across a reload.

const STORAGE_KEY = 'fl-signer-pins';

export class SignerChangedError extends Error {
  readonly code = 'signer_changed';
  readonly pinnedSignerPk: string;
  readonly servedSignerPk: string;
  constructor(formId: string, pinnedSignerPk: string, servedSignerPk: string) {
    super(`The encryption signer for form ${formId} changed — refusing to submit. This can indicate a server compromise; contact the form owner.`);
    this.name = 'SignerChangedError';
    this.pinnedSignerPk = pinnedSignerPk;
    this.servedSignerPk = servedSignerPk;
  }
}

/** The pin store could not be read or written — refuse rather than degrade. */
export class PinStorageError extends Error {
  readonly code = 'pin_storage_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'PinStorageError';
  }
}

type PinMap = Record<string, string>;

function readPins(storage: Storage): PinMap {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    throw new PinStorageError('Could not read the encryption key pin store.');
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupted pin store cannot prove key continuity — fail closed.
    throw new PinStorageError('The encryption key pin store is corrupted.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PinStorageError('The encryption key pin store is corrupted.');
  }
  const out: PinMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function writePins(pins: PinMap, storage: Storage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage may be full or blocked (private browsing) — fail CLOSED rather than
    // degrading to a session-only pin that would accept a key change after reload.
    throw new PinStorageError('Could not persist the encryption key pin — browser storage is unavailable.');
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function requireStorage(storage?: Storage | null): Storage {
  const store = storage === undefined ? safeStorage() : storage;
  if (!store) {
    throw new PinStorageError('Browser storage is unavailable — the encryption key cannot be pinned, so submission is refused.');
  }
  return store;
}

/**
 * Trust-on-first-use pin check. Returns after pinning on first sight; throws
 * SignerChangedError when a previously pinned form presents a different signer,
 * and PinStorageError when the pin store cannot be read or written (fail closed).
 */
export function pinSigner(formId: string, signerPkB64: string, storage?: Storage | null): void {
  const store = requireStorage(storage);
  const pins = readPins(store);
  const existing = pins[formId];
  if (existing === undefined) {
    pins[formId] = signerPkB64;
    writePins(pins, store);
    return;
  }
  if (existing !== signerPkB64) throw new SignerChangedError(formId, existing, signerPkB64);
}

/** Test hook: clear all pins. */
export function clearSignerPins(storage?: Storage | null): void {
  const store = storage === undefined ? safeStorage() : storage;
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** The currently pinned signer key (base64) for a form, or null when unpinned.
 *  Display-only (fingerprint UX): a read failure degrades to null here. */
export function getPinnedSigner(formId: string, storage?: Storage | null): string | null {
  const store = storage === undefined ? safeStorage() : storage;
  if (!store) return null;
  try {
    return readPins(store)[formId] ?? null;
  } catch {
    return null;
  }
}

/**
 * Record an EXPLICIT trust decision - first trust, or re-trust after the user
 * approved a changed-key prompt (a rotated signer is never adopted silently;
 * this is the ONLY path that may overwrite an existing pin). Fails closed with
 * PinStorageError when the decision cannot be persisted.
 */
export function trustFormSignerKey(formId: string, signerPkB64: string, storage?: Storage | null): void {
  const store = requireStorage(storage);
  const pins = readPins(store);
  pins[formId] = signerPkB64;
  writePins(pins, store);
}

/**
 * Human-comparison fingerprint for the changed-key refusal UX - a 96-bit key
 * prefix in hex, grouped by 4 (same construction as the desktop tunnel's
 * keyFingerprint; Ed25519 keys are uniform random, so a prefix is a sound
 * comparison fingerprint).
 */
export function signerFingerprint(publicKey: Uint8Array): string {
  const hex = Array.from(publicKey.subarray(0, 12), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}
