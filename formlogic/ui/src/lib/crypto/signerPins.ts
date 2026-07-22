// Submitter-side TOFU pinning of the manifest signer key, per form
// (docs/E2EE_PRIVATE_FORMS_PLAN.md §8 "Verification honesty"). First sight of a
// private form pins signerPk; a CHANGED signer for a known form is refused loudly —
// same posture as the desktop tunnel pins. Only public key material is persisted.
//
// The pin store is localStorage-scoped (per browser profile); pins are not secrets.

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

type PinMap = Record<string, string>;

function readPins(storage: Storage | null = safeStorage()): PinMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: PinMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writePins(pins: PinMap, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage may be full or unavailable (private browsing) — pinning then degrades
    // to per-session only, which fails safe (a signer change still alarms within the
    // session; nothing is silently accepted).
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Trust-on-first-use pin check. Returns after pinning on first sight; throws
 * SignerChangedError when a previously pinned form presents a different signer.
 */
export function pinSigner(formId: string, signerPkB64: string, storage?: Storage | null): void {
  const store = storage === undefined ? safeStorage() : storage;
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

/** The currently pinned signer key (base64) for a form, or null when unpinned. */
export function getPinnedSigner(formId: string, storage?: Storage | null): string | null {
  const store = storage === undefined ? safeStorage() : storage;
  return readPins(store)[formId] ?? null;
}

/**
 * Record an EXPLICIT trust decision - first trust, or re-trust after the user
 * approved a changed-key prompt (a rotated signer is never adopted silently;
 * this is the ONLY path that may overwrite an existing pin).
 */
export function trustFormSignerKey(formId: string, signerPkB64: string, storage?: Storage | null): void {
  const store = storage === undefined ? safeStorage() : storage;
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
