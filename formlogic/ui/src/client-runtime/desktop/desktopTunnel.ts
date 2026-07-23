// Browser E2E tunnel client for Desktop AI (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md
// §5.1 envelope/crypto, §5.2 queueing, §7 security — Phase 1).
//
// What this module does:
//   1. Fetches the desktop's long-term X25519 public key via GET /api/desktop/ai/pubkey
//      and TOFU-pins it in localStorage (`formlogic-desktop-e2e-pins`). A CHANGED key for
//      a known desktop instance is never trusted silently: the caller gets a typed
//      `e2e_key_rotated` error carrying both fingerprints and must re-trust explicitly
//      via trustDesktopE2eKey() (§5.1 TOFU, §7).
//   2. Generates a per-thread ephemeral X25519 keypair (never persisted) and seals the
//      request body with NaCl box — X25519 ECDH → HSalsa20 → XSalsa20-Poly1305, the exact
//      `crypto_box` construction the desktop implements in Rust (§5.1). Interop is locked
//      by docs/contracts/e2e-envelope-vectors.json (consumed by desktopTunnel.test.ts).
//   3. Enqueues the sealed envelope (POST /api/desktop/ai/requests) and streams sealed
//      out-frames over fetch-SSE (GET …/{id}/stream) with cookie auth like the lib/api
//      client — EventSource cannot send credentials cross-origin. Each frame is opened
//      with the per-thread shared key and its directional monotonic nonce counter is
//      enforced (replay protection, §5.1).
//
// Nonce scheme (§5.1): 24 bytes; byte 0 = direction (0x00 browser→desktop,
// 0x01 desktop→browser); bytes 1..23 = big-endian counter. The request envelope uses
// counter 0; each subsequent frame in the same direction increments, and a peer rejects
// any counter ≤ last-seen per direction.
//
// Exposed states (§9 Phase 1): queued(position) → streaming → done | failed(code) | uncertain.
import * as nacl from 'tweetnacl';
import {
  api,
  type DesktopAiEnqueueBody,
  type DesktopAiRequestKind,
  type DesktopAiSealedEnvelope,
} from '../../lib/api';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { logger } from '../../lib/logger';
import { generateId } from '../../lib/utils';

const NONCE_LENGTH = 24;
const BOX_PUBLIC_KEY_LENGTH = 32;

/** Nonce direction byte: browser → desktop (request envelope + POST …/input frames). */
export const TUNNEL_DIRECTION_REQUEST = 0x00;
/** Nonce direction byte: desktop → browser (streamed out-frames). */
export const TUNNEL_DIRECTION_RESPONSE = 0x01;

const PINS_STORAGE_KEY = 'formlogic-desktop-e2e-pins';
/** Overall deadline for one tunnel request; the AI lane TTL is 5 minutes (plan §5.2). */
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;
const MIN_STREAM_TIMEOUT_MS = 5_000;
const MAX_STREAM_TIMEOUT_MS = 600_000;
/** Frames cap at 4 MiB (plan §5.2); SSE data lines carry base64 so allow headroom. */
const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;
const MAX_STREAM_ERROR_BODY_BYTES = 64 * 1024;
/** Pause before resuming a cleanly-ended stream while the request is still live. */
const RECONNECT_BACKOFF_MS = 1_000;

// ---------------------------------------------------------------------------
// Errors, results, states.
// ---------------------------------------------------------------------------

/**
 * Typed codes from the plan's §5.8 taxonomy plus client-side codes used by this module
 * (`transport` = the backend could not be reached at all, `auth_required` = session
 * expired, `session_unknown` = postInput for a request this page no longer tracks).
 * Left open-ended for forward compatibility with backend codes added later.
 */
export type DesktopTunnelErrorCode =
  | 'queue_full_user'
  | 'queue_full_desktop'
  | 'desktop_offline'
  | 'ambiguous_desktop'
  | 'e2e_key_unknown'
  | 'e2e_key_rotated'
  | 'sealed_envelope_invalid'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'grant_expired'
  | 'grant_instance_mismatch'
  | 'ai_allowance_exceeded'
  | 'ai_default_unresolved'
  | 'uncertain'
  | 'expired'
  | 'transport'
  | 'auth_required'
  | 'session_unknown'
  | 'request_failed'
  | (string & {});

export interface DesktopE2eKeyRotation {
  instanceId: string;
  deviceName: string;
  /** Fingerprint of the PINNED (previously trusted) key. */
  pinnedFingerprint: string;
  /** Fingerprint of the key the desktop just presented. */
  presentedFingerprint: string;
}

export interface DesktopTunnelError {
  code: DesktopTunnelErrorCode;
  message: string;
  /** HTTP status when the failure came from the backend. */
  status?: number;
  /** Present iff code === 'e2e_key_rotated'. */
  rotation?: DesktopE2eKeyRotation;
}

export type DesktopTunnelResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DesktopTunnelError };

/** States exposed to callers (§9 Phase 1): queued(pos) → streaming → done | failed(code) | uncertain. */
export type DesktopTunnelState =
  | { state: 'queued'; position: number }
  | { state: 'streaming' }
  | { state: 'done' }
  | { state: 'failed'; code: DesktopTunnelErrorCode; message?: string }
  | { state: 'uncertain'; message?: string };

export interface DesktopTunnelChatMessage {
  role: string;
  /** Plain text, or OpenAI-style content parts (chat image attachments). */
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

function failure<T>(error: DesktopTunnelError): DesktopTunnelResult<T> {
  return { ok: false, error };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Base64 + nonce helpers (exported for the cross-implementation vector tests).
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 24-byte directional nonce (plan §5.1): byte 0 = direction, bytes 1..23 = big-endian
 * counter. Counters are per-direction and must increase monotonically per thread.
 */
export function buildTunnelNonce(direction: number, counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError(`tunnel nonce counter must be a non-negative safe integer, got ${counter}`);
  }
  const nonce = new Uint8Array(NONCE_LENGTH);
  nonce[0] = direction;
  let remaining = counter;
  for (let i = NONCE_LENGTH - 1; i >= 1; i--) {
    nonce[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining !== 0) throw new RangeError('tunnel nonce counter exceeds the 23-byte nonce space');
  return nonce;
}

export function parseTunnelNonce(nonce: Uint8Array): { direction: number; counter: number } {
  if (nonce.length !== NONCE_LENGTH) {
    throw new RangeError(`tunnel nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`);
  }
  let counter = 0;
  for (let i = 1; i < NONCE_LENGTH; i++) counter = counter * 256 + nonce[i];
  return { direction: nonce[0], counter };
}

/**
 * Human-comparison fingerprint for the TOFU prompt. WebCrypto is unavailable on the
 * non-secure dev origin (plan §10 item 7), and X25519 public keys are unique random
 * values, so a 96-bit key prefix is a sound comparison fingerprint.
 */
export function keyFingerprint(publicKey: Uint8Array): string {
  const hex = Array.from(publicKey.subarray(0, 12), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

// ---------------------------------------------------------------------------
// TOFU pin store (plan §5.1: localStorage `formlogic-desktop-e2e-pins`).
// ---------------------------------------------------------------------------

export interface DesktopE2ePin {
  /** Base64 X25519 public key (32 bytes). */
  pubkey: string;
  deviceName: string;
  fingerprint: string;
  firstTrustedAt: string;
}

function pinStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDesktopE2ePins(): Record<string, DesktopE2ePin> {
  const storage = pinStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(PINS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const pins: Record<string, DesktopE2ePin> = {};
    for (const [instanceId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<DesktopE2ePin> | null;
      if (v && typeof v.pubkey === 'string' && typeof v.fingerprint === 'string') {
        pins[instanceId] = {
          pubkey: v.pubkey,
          deviceName: typeof v.deviceName === 'string' ? v.deviceName : 'FormLogic Desktop',
          fingerprint: v.fingerprint,
          firstTrustedAt: typeof v.firstTrustedAt === 'string' ? v.firstTrustedAt : '',
        };
      }
    }
    return pins;
  } catch (e) {
    logger.warn('[desktop-tunnel] unreadable E2E pin store:', e);
    return {};
  }
}

function writeDesktopE2ePins(pins: Record<string, DesktopE2ePin>): void {
  const storage = pinStorage();
  if (!storage) return;
  try {
    storage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch (e) {
    logger.warn('[desktop-tunnel] could not persist the E2E pin store:', e);
  }
}

export function getDesktopE2ePin(instanceId: string): DesktopE2ePin | null {
  return readDesktopE2ePins()[instanceId] ?? null;
}

/**
 * Record an EXPLICIT trust decision for a desktop instance — first trust, or re-trust
 * after the user approved a rotation prompt (a rotated key is never adopted silently).
 * Returns the recorded pin, or null when the presented key is malformed.
 */
export function trustDesktopE2eKey(instanceId: string, pubkey: string, deviceName: string): DesktopE2ePin | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(pubkey);
  } catch {
    return null;
  }
  if (bytes.length !== BOX_PUBLIC_KEY_LENGTH) return null;
  const pins = readDesktopE2ePins();
  const pin: DesktopE2ePin = {
    pubkey,
    deviceName,
    fingerprint: keyFingerprint(bytes),
    firstTrustedAt: pins[instanceId]?.firstTrustedAt || new Date().toISOString(),
  };
  pins[instanceId] = pin;
  writeDesktopE2ePins(pins);
  return pin;
}

/** Drop a pin entirely (e.g. the desktop was unlinked); the next use is a fresh first trust. */
export function forgetDesktopE2ePin(instanceId: string): void {
  const pins = readDesktopE2ePins();
  if (instanceId in pins) {
    delete pins[instanceId];
    writeDesktopE2ePins(pins);
  }
}

// ---------------------------------------------------------------------------
// Crypto core — NaCl box (X25519 ECDH → HSalsa20 → XSalsa20-Poly1305, plan §5.1).
// ---------------------------------------------------------------------------

export function deriveTunnelSharedKey(peerPublicKey: Uint8Array, ownSecretKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ownSecretKey);
}

/** Seal one frame with an explicit direction + counter (the nonce is transmitted). */
export function sealTunnelFrame(
  sharedKey: Uint8Array,
  plaintext: Uint8Array,
  direction: number,
  counter: number
): DesktopAiSealedEnvelope {
  const nonce = buildTunnelNonce(direction, counter);
  const ct = nacl.box.after(plaintext, nonce, sharedKey);
  return { nonce: bytesToBase64(nonce), ct: bytesToBase64(ct) };
}

export interface OpenedTunnelFrame {
  direction: number;
  counter: number;
  plaintext: Uint8Array;
}

/** Open one frame; null on any shape/authentication failure (never throws). */
export function openTunnelFrame(sharedKey: Uint8Array, envelope: DesktopAiSealedEnvelope): OpenedTunnelFrame | null {
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    nonce = base64ToBytes(envelope.nonce);
    ct = base64ToBytes(envelope.ct);
  } catch {
    return null;
  }
  if (nonce.length !== NONCE_LENGTH) return null;
  const { direction, counter } = parseTunnelNonce(nonce);
  const plaintext = nacl.box.open.after(ct, nonce, sharedKey);
  if (plaintext === null) return null;
  return { direction, counter, plaintext };
}

/**
 * The backend's `envelope` wire field is ONE base64 string of opaque bytes (it stores and
 * relays them verbatim). Canonical byte layout — shared with the desktop's
 * `pack_envelope` (docs/contracts/e2e-envelope-vectors.json): `nonce(24) || ciphertext`.
 */
export function encodeTunnelEnvelope(frame: DesktopAiSealedEnvelope): string {
  const nonce = base64ToBytes(frame.nonce);
  const ct = base64ToBytes(frame.ct);
  const bytes = new Uint8Array(nonce.length + ct.length);
  bytes.set(nonce, 0);
  bytes.set(ct, nonce.length);
  return bytesToBase64(bytes);
}

/**
 * Inverse of encodeTunnelEnvelope. Also accepts the legacy JSON blob layout
 * (`base64({"nonce","ct"})`) so the reader tolerates either convention.
 */
export function decodeTunnelEnvelope(envelope: string): DesktopAiSealedEnvelope | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(envelope);
  } catch {
    return null;
  }
  if (bytes.length > 0 && bytes[0] === 0x7b /* '{' */) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (isSealedEnvelopeShape(parsed)) return parsed;
    } catch {
      /* fall through to the binary layout */
    }
  }
  if (bytes.length > NONCE_LENGTH) {
    return {
      nonce: bytesToBase64(bytes.subarray(0, NONCE_LENGTH)),
      ct: bytesToBase64(bytes.subarray(NONCE_LENGTH)),
    };
  }
  return null;
}

class TunnelCryptoError extends Error {}

/**
 * One thread's crypto session: the per-thread ephemeral keypair (never persisted), the
 * shared key with the desktop's long-term identity, and the per-direction nonce counters.
 */
export class TunnelSession {
  readonly instanceId: string;
  readonly ephemeralPublicKey: Uint8Array;
  private readonly sharedKey: Uint8Array;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  /** Last-used browser→desktop counter; the request envelope uses counter 0. */
  private outCounter = -1;
  /** Last-seen desktop→browser counter (-1 = none yet). */
  private inCounter = -1;

  private constructor(instanceId: string, ephemeralPublicKey: Uint8Array, sharedKey: Uint8Array) {
    this.instanceId = instanceId;
    this.ephemeralPublicKey = ephemeralPublicKey;
    this.sharedKey = sharedKey;
  }

  static create(instanceId: string, desktopPublicKey: Uint8Array): TunnelSession {
    const pair = nacl.box.keyPair(); // per-thread ephemeral — never persisted (plan §5.1)
    return new TunnelSession(instanceId, pair.publicKey, nacl.box.before(desktopPublicKey, pair.secretKey));
  }

  private sealJson(body: Record<string, unknown>, counter: number): DesktopAiSealedEnvelope {
    return sealTunnelFrame(this.sharedKey, this.encoder.encode(JSON.stringify(body)), TUNNEL_DIRECTION_REQUEST, counter);
  }

  /** Seal the request envelope — direction 0x00, counter 0 (plan §5.1). */
  sealRequest(body: Record<string, unknown>): DesktopAiSealedEnvelope {
    this.outCounter = 0;
    return this.sealJson(body, 0);
  }

  /** Seal a follow-up inbound frame (POST …/input) — direction 0x00, counter increments. */
  sealInput(body: Record<string, unknown>): DesktopAiSealedEnvelope {
    if (this.outCounter < 0) throw new TunnelCryptoError('sealRequest must run before sealInput');
    this.outCounter += 1;
    return this.sealJson(body, this.outCounter);
  }

  /**
   * Open one sealed out-frame from the desktop: direction must be 0x01 and the counter
   * strictly greater than the last one seen on this thread (replay protection, §5.1).
   * Throws TunnelCryptoError on any violation — callers fail the request closed.
   */
  openIncoming(envelope: DesktopAiSealedEnvelope): Record<string, unknown> {
    const opened = openTunnelFrame(this.sharedKey, envelope);
    if (!opened) throw new TunnelCryptoError('frame authentication failed');
    if (opened.direction !== TUNNEL_DIRECTION_RESPONSE) {
      throw new TunnelCryptoError(`unexpected frame direction ${opened.direction}`);
    }
    if (opened.counter <= this.inCounter) {
      throw new TunnelCryptoError(`replayed or out-of-order frame counter ${opened.counter}`);
    }
    this.inCounter = opened.counter;
    try {
      const parsed = JSON.parse(this.decoder.decode(opened.plaintext)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TunnelCryptoError('decrypted frame was not a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      if (e instanceof TunnelCryptoError) throw e;
      throw new TunnelCryptoError('decrypted frame was not valid JSON');
    }
  }
}

// ---------------------------------------------------------------------------
// Small parsing helpers.
// ---------------------------------------------------------------------------

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSealedEnvelopeShape(value: unknown): value is DesktopAiSealedEnvelope {
  const v = asRecord(value);
  return !!v && typeof v.nonce === 'string' && typeof v.ct === 'string';
}

// ---------------------------------------------------------------------------
// Desktop key resolution + TOFU.
// ---------------------------------------------------------------------------

interface ResolvedDesktopKey {
  instanceId: string;
  publicKey: Uint8Array;
  deviceName: string;
  firstTrust: boolean;
}

async function resolveDesktopKey(
  instanceId: string | undefined,
  onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void
): Promise<DesktopTunnelResult<ResolvedDesktopKey>> {
  const res = await api.getDesktopAiPubkey(instanceId);
  if (res.error) {
    if (!res.status) {
      // Network-level failure before anything was enqueued — a plain transport error.
      return failure({ code: 'transport', message: res.error });
    }
    return failure({ code: res.code ?? 'request_failed', message: res.error, status: res.status });
  }
  const body = asRecord(res.data) ?? {};
  const pubkeyB64 = firstString(body.publicKey, body.pubkey, body.e2ePublicKey, body.e2e_public_key);
  const resolvedInstance = firstString(body.instanceId, body.instance_id) ?? instanceId;
  const deviceName = firstString(body.deviceName, body.device_name, body.name) ?? 'FormLogic Desktop';
  if (!pubkeyB64 || !resolvedInstance) {
    return failure({
      code: 'e2e_key_unknown',
      message: 'The desktop has not published an end-to-end encryption key yet — restart FormLogic Desktop and try again.',
    });
  }
  let publicKey: Uint8Array;
  try {
    publicKey = base64ToBytes(pubkeyB64);
  } catch {
    return failure({ code: 'e2e_key_unknown', message: 'The desktop published an unreadable encryption key.' });
  }
  if (publicKey.length !== BOX_PUBLIC_KEY_LENGTH) {
    return failure({ code: 'e2e_key_unknown', message: 'The desktop published an invalid encryption key.' });
  }

  const pin = getDesktopE2ePin(resolvedInstance);
  if (pin && pin.pubkey !== pubkeyB64) {
    // Key rotation: NEVER trusted silently (plan §5.1/§7). The caller must surface the
    // fingerprints and get an explicit re-trust decision via trustDesktopE2eKey().
    const rotation: DesktopE2eKeyRotation = {
      instanceId: resolvedInstance,
      deviceName,
      pinnedFingerprint: pin.fingerprint,
      presentedFingerprint: keyFingerprint(publicKey),
    };
    logger.error('[desktop-tunnel] desktop E2E key ROTATED — refusing to trust it silently', rotation);
    return failure({
      code: 'e2e_key_rotated',
      message:
        `The encryption key for "${deviceName}" changed (was ${rotation.pinnedFingerprint}, now ${rotation.presentedFingerprint}). ` +
        'Only continue if you expected the desktop to be reinstalled or reset, then explicitly trust the new key.',
      rotation,
    });
  }

  let firstTrust = false;
  if (!pin) {
    firstTrust = true;
    const recorded = trustDesktopE2eKey(resolvedInstance, pubkeyB64, deviceName);
    if (!recorded) {
      return failure({ code: 'e2e_key_unknown', message: 'The desktop published an invalid encryption key.' });
    }
    onTrustEstablished?.(recorded, true);
  } else {
    if (pin.deviceName !== deviceName) {
      // Benign: same key, refreshed device name.
      trustDesktopE2eKey(resolvedInstance, pubkeyB64, deviceName);
    }
    onTrustEstablished?.({ ...pin, deviceName }, false);
  }
  return { ok: true, data: { instanceId: resolvedInstance, publicKey, deviceName, firstTrust } };
}

// ---------------------------------------------------------------------------
// Active sessions (postInput needs the thread's crypto context).
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, TunnelSession>();

/** Clear module session state — test-only. */
export function __resetDesktopTunnelForTests(): void {
  activeSessions.clear();
}

// ---------------------------------------------------------------------------
// The shared tunnel run: resolve key → seal → enqueue → stream to terminal.
// ---------------------------------------------------------------------------

interface TunnelRunParams {
  kind: DesktopAiRequestKind;
  instanceId?: string;
  providerId: string;
  model?: string;
  threadId: string;
  messages?: DesktopTunnelChatMessage[];
  /** Chat tool use (§5.1 sealed-body fields, Phase 6): per-user Auto/Confirm mode. */
  toolMode?: 'auto' | 'confirm';
  /** Per-turn chat-tool grant token — sealed into the request body, never plaintext. */
  toolGrant?: string;
  clientSeq: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onDelta?: (delta: string, accumulated: string) => void;
  onState: (state: DesktopTunnelState) => void;
  /**
   * Every decrypted out-frame, for forward-compatible handling (tool proposals, …).
   * Frames are delivered with the relay `requestId` injected (unless the frame already
   * carries one) so consumers can answer via postInput(requestId, …).
   */
  onFrame?: (frame: Record<string, unknown>) => void;
  onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void;
}

interface TunnelRunAccum {
  text: string;
  finalText?: string;
  threadId?: string;
  models: unknown[] | null;
  providers: unknown[] | null;
}

interface TunnelRunOutcome {
  threadId: string;
  text: string;
  finalText?: string;
  models: unknown[] | null;
  providers: unknown[] | null;
}

type Terminal =
  | { kind: 'done' }
  | { kind: 'failed'; code: DesktopTunnelErrorCode; message?: string }
  | { kind: 'uncertain'; message: string };

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    logger.warn('[desktop-tunnel] consumer callback threw:', e);
  }
}

/** Map a backend status word (§5.2) onto the caller-visible state / terminal. */
function statusToTerminal(
  status: string,
  queuePos: number | undefined,
  code: string | undefined,
  message: string | undefined,
  onState: (state: DesktopTunnelState) => void
): Terminal | null {
  switch (status) {
    case 'pending':
      safeCall(() => onState({ state: 'queued', position: queuePos ?? 0 }));
      return null;
    case 'claimed':
    case 'streaming':
      safeCall(() => onState({ state: 'streaming' }));
      return null;
    case 'done':
      return { kind: 'done' };
    case 'failed':
      return { kind: 'failed', code: code ?? 'request_failed', message };
    case 'expired':
      return { kind: 'failed', code: 'expired', message: message ?? 'The queued request expired before the desktop completed it.' };
    default:
      logger.warn('[desktop-tunnel] unknown request status:', status);
      return null;
  }
}

async function readBoundedJson(res: Response): Promise<Record<string, unknown> | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_STREAM_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * One authoritative status read after a stream end. Returns the settled Terminal, or
 * `waiting: true` when the request is still live (the caller reconnects with its cursor —
 * the backend bounds a stream's lifetime and expects clients to resume, §9-P1 SSE notes).
 */
async function settleFromStatus(
  requestId: string,
  onState: (state: DesktopTunnelState) => void
): Promise<{ terminal: Terminal | null; waiting: boolean }> {
  const res = await api.getDesktopAiRequest(requestId);
  const body = asRecord(res.data);
  const request = asRecord(body?.request) ?? body;
  if (request && typeof request.status === 'string') {
    const terminal = statusToTerminal(
      request.status,
      typeof request.queuePos === 'number' ? request.queuePos : undefined,
      firstString(request.code),
      firstString(request.message),
      onState
    );
    if (terminal) return { terminal, waiting: false };
    return { terminal: null, waiting: true };
  }
  return {
    terminal: { kind: 'uncertain', message: 'The stream ended before the desktop reported an outcome.' },
    waiting: false,
  };
}

async function executeTunnelRequest(params: TunnelRunParams): Promise<DesktopTunnelResult<TunnelRunOutcome>> {
  const { onState } = params;
  const accum: TunnelRunAccum = { text: '', models: null, providers: null };

  const fail = (error: DesktopTunnelError, terminalState?: DesktopTunnelState): DesktopTunnelResult<TunnelRunOutcome> => {
    safeCall(() =>
      onState(
        terminalState ?? {
          state: error.code === 'uncertain' ? 'uncertain' : 'failed',
          code: error.code,
          message: error.message,
        } as DesktopTunnelState
      )
    );
    return failure(error);
  };

  // 1. Desktop key + TOFU.
  const keyRes = await resolveDesktopKey(params.instanceId, params.onTrustEstablished);
  if (!keyRes.ok) return fail(keyRes.error);
  const { instanceId, publicKey } = keyRes.data;

  // 2. Per-thread ephemeral session + sealed request envelope (counter 0, direction 0x00).
  const session = TunnelSession.create(instanceId, publicKey);
  const sealedBody: Record<string, unknown> = {
    v: 1,
    kind: params.kind,
    providerId: params.providerId,
    threadId: params.threadId,
    clientSeq: params.clientSeq,
  };
  if (params.model) sealedBody.model = params.model;
  if (params.messages) sealedBody.messages = params.messages;
  // Chat tool use (§5.1/§5.4): the tool mode + per-turn grant ride INSIDE the sealed
  // body — the backend must never see the grant token in plaintext.
  if (params.toolMode) sealedBody.toolMode = params.toolMode;
  if (params.toolGrant) sealedBody.toolGrant = params.toolGrant;
  let envelope: DesktopAiSealedEnvelope;
  try {
    envelope = session.sealRequest(sealedBody);
  } catch (e) {
    return fail({ code: 'sealed_envelope_invalid', message: errorMessage(e) });
  }

  // 3. Enqueue onto the desktop's FIFO lane (§5.2). The backend never sees the plaintext.
  const enqueueBody: DesktopAiEnqueueBody = {
    targetInstanceId: instanceId,
    kind: params.kind,
    providerId: params.providerId,
    ephPub: bytesToBase64(session.ephemeralPublicKey),
    envelope: encodeTunnelEnvelope(envelope),
    idempotencyKey: generateId(),
  };
  const enqueueRes = await api.enqueueDesktopAiRequest(enqueueBody);
  if (enqueueRes.error) {
    if (!enqueueRes.status) {
      // Network failure at enqueue: the request MAY have landed — honest `uncertain` (§5.8),
      // never a silent retry that could double-run the turn.
      return fail({
        code: 'uncertain',
        message: `The request may or may not have reached the queue (${enqueueRes.error}). Check the request list before retrying.`,
      });
    }
    return fail({ code: enqueueRes.code ?? 'request_failed', message: enqueueRes.error, status: enqueueRes.status });
  }
  const enqueued = asRecord(enqueueRes.data) ?? {};
  const requestId = firstString(enqueued.requestId, enqueued.id);
  if (!requestId) {
    return fail({ code: 'request_failed', message: 'The queue accepted the request but returned no request id.' });
  }
  activeSessions.set(requestId, session);

  try {
    const queuePos = typeof enqueued.queuePos === 'number' ? enqueued.queuePos : 0;
    safeCall(() => onState({ state: 'queued', position: queuePos }));

    // 4. Stream sealed out-frames to a terminal outcome.
    const terminal = await streamTunnelResponses(session, requestId, params, accum);
    switch (terminal.kind) {
      case 'done': {
        safeCall(() => onState({ state: 'done' }));
        const finalText = accum.finalText ?? accum.text;
        return {
          ok: true,
          data: {
            threadId: accum.threadId ?? params.threadId,
            text: accum.text,
            ...(finalText !== accum.text ? { finalText } : {}),
            models: accum.models,
            providers: accum.providers,
          },
        };
      }
      case 'failed':
        return fail({ code: terminal.code, message: terminal.message ?? 'The desktop reported a failure.' });
      case 'uncertain':
        return fail({ code: 'uncertain', message: terminal.message }, { state: 'uncertain', message: terminal.message });
    }
  } finally {
    activeSessions.delete(requestId);
  }
}

/** Extract spoken text from an out-frame delta: a plain string, or an OpenAI chunk object. */
function extractDeltaText(frame: Record<string, unknown>): string | undefined {
  const direct = firstString(frame.text, frame.delta);
  if (direct !== undefined) return direct;
  return extractCompletionText(frame.delta);
}

/** Text out of an OpenAI-shaped completion/chunk ({choices:[{delta|message:{content}}]}). */
function extractCompletionText(value: unknown): string | undefined {
  const completion = asRecord(value);
  const choices = completion?.choices;
  if (!Array.isArray(choices)) return undefined;
  let text = '';
  for (const choice of choices) {
    const c = asRecord(choice);
    const delta = asRecord(c?.delta);
    const message = asRecord(c?.message);
    text += firstString(delta?.content, message?.content, c?.text) ?? '';
  }
  return text === '' ? undefined : text;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function streamTunnelResponses(
  session: TunnelSession,
  requestId: string,
  params: TunnelRunParams,
  accum: TunnelRunAccum
): Promise<Terminal> {
  const { onState } = params;
  const timeoutMs = Math.min(
    MAX_STREAM_TIMEOUT_MS,
    Math.max(MIN_STREAM_TIMEOUT_MS, Math.trunc(params.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS))
  );
  const controller = new AbortController();
  let abortKind: 'external' | 'timeout' | null = null;
  const onExternalAbort = () => {
    if (abortKind !== null) return;
    abortKind = 'external';
    controller.abort();
  };
  if (params.signal?.aborted) onExternalAbort();
  else params.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    if (abortKind !== null) return;
    abortKind = 'timeout';
    controller.abort();
  }, timeoutMs);

  const cancelled = (): Terminal =>
    abortKind === 'external'
      ? { kind: 'uncertain', message: 'The stream was cancelled; the desktop may still complete the request.' }
      : { kind: 'uncertain', message: 'Timed out waiting for the desktop; the request may still complete.' };

  try {
    // The backend bounds one SSE connection's lifetime and ends it cleanly — a still-live
    // request is followed by reconnecting with the last frame cursor (?since=, §9-P1).
    let sinceCursor = 0;
    for (;;) {
      if (controller.signal.aborted) return cancelled();
      const url =
        resolveBackendApiUrl(`/desktop/ai/requests/${encodeURIComponent(requestId)}/stream`) +
        (sinceCursor > 0 ? `?since=${sinceCursor}` : '');
      let res: Response;
      try {
        res = await fetch(url, {
          credentials: 'include', // session cookies, per the lib/api client pattern (§7)
          cache: 'no-store',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
      } catch {
        if (abortKind !== null) return cancelled();
        return { kind: 'uncertain', message: 'Could not open the desktop stream; the request may still complete.' };
      }

      if (res.status === 401) {
        return { kind: 'failed', code: 'auth_required', message: 'Sign in again to follow the desktop request.' };
      }
      if (!res.ok || !res.body) {
        const body = await readBoundedJson(res);
        const code = firstString(body?.code) ?? 'request_failed';
        const message = firstString(body?.message) ?? `The stream endpoint responded ${res.status}.`;
        return { kind: 'failed', code, message };
      }

      /** Handle one SSE data payload; returns a Terminal when the request is settled. */
      const dispatchData = async (data: string): Promise<Terminal | null> => {
        if (!data) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          logger.warn('[desktop-tunnel] dropping a malformed stream data frame');
          return null;
        }
        const obj = asRecord(parsed);
        if (!obj) return null;

        // Sealed out-frame from the desktop: the backend relays it as
        // {seq, envelope: <base64 frame blob>}; tolerate nested/raw {nonce, ct} shapes too.
        let envelope: DesktopAiSealedEnvelope | null = null;
        if (typeof obj.envelope === 'string') {
          envelope = decodeTunnelEnvelope(obj.envelope);
          if (!envelope) throw new TunnelCryptoError('undecodable envelope on the stream');
        } else if (isSealedEnvelopeShape(obj)) {
          envelope = obj;
        } else if (isSealedEnvelopeShape(obj.frame)) {
          envelope = obj.frame as DesktopAiSealedEnvelope;
        } else if (isSealedEnvelopeShape(obj.envelope)) {
          envelope = obj.envelope as DesktopAiSealedEnvelope;
        }
        if (typeof obj.seq === 'number' && Number.isSafeInteger(obj.seq) && obj.seq > sinceCursor) {
          sinceCursor = obj.seq;
        }
        if (envelope) {
          const frame = session.openIncoming(envelope); // throws TunnelCryptoError — fail closed
          // Consumers get the relay request id on every frame (a frame that already
          // names one keeps it) so confirm-mode tool proposals can be answered via
          // postInput(requestId, …) — plan §5.4, chatEngine integration note.
          safeCall(() => params.onFrame?.('requestId' in frame ? frame : { ...frame, requestId }));
          const type = firstString(frame.type, frame.kind);
          switch (type) {
            case 'delta': {
              const delta = extractDeltaText(frame);
              if (delta) {
                accum.text += delta;
                safeCall(() => params.onDelta?.(delta, accum.text));
              }
              return null;
            }
            case 'models':
              if (Array.isArray(frame.models)) accum.models = frame.models;
              return null;
            case 'providers':
              if (Array.isArray(frame.providers)) accum.providers = frame.providers;
              return null;
            case 'state':
            case 'status':
              return statusToTerminal(
                firstString(frame.state, frame.status) ?? '',
                typeof frame.position === 'number' ? frame.position : undefined,
                firstString(frame.code),
                firstString(frame.message),
                onState
              );
            case 'done':
            case 'final': {
              const finalText = firstString(frame.text) ?? extractCompletionText(frame.completion);
              if (finalText !== undefined) accum.finalText = finalText;
              const threadId = firstString(frame.threadId);
              if (threadId) accum.threadId = threadId;
              if (Array.isArray(frame.models)) accum.models = frame.models;
              if (Array.isArray(frame.providers)) accum.providers = frame.providers;
              return { kind: 'done' };
            }
            case 'failed':
            case 'error':
              return {
                kind: 'failed',
                code: firstString(frame.code) ?? 'request_failed',
                message: firstString(frame.message),
              };
            default:
              logger.warn('[desktop-tunnel] unhandled out-frame type:', type);
              return null;
          }
        }

        // Unsealed status event (queue position / lifecycle — routing metadata only, §7).
        if (typeof obj.status === 'string') {
          return statusToTerminal(
            obj.status,
            typeof obj.queuePos === 'number' ? obj.queuePos : undefined,
            firstString(obj.code),
            firstString(obj.message),
            onState
          );
        }
        return null;
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines: string[] = [];
      let eventChars = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (line === '') {
              const data = dataLines.join('\n');
              dataLines = [];
              eventChars = 0;
              const terminal = await dispatchData(data);
              if (terminal) {
                await reader.cancel().catch(() => undefined);
                return terminal;
              }
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).replace(/^ /, ''));
              eventChars += line.length;
              if (eventChars > MAX_SSE_EVENT_CHARS) {
                throw new TunnelCryptoError('stream event exceeded the browser limit');
              }
            }
            // `id:`/`event:`/`: keepalive` comments — nothing to do.
          }
        }
        if (dataLines.length > 0) {
          const terminal = await dispatchData(dataLines.join('\n'));
          if (terminal) return terminal;
        }
      } finally {
        reader.releaseLock();
      }

      // Clean stream end without a terminal frame: one authoritative status read decides
      // between done / failed(code) / uncertain (§5.8) — or a resume when still live.
      const settled = await settleFromStatus(requestId, onState);
      if (settled.terminal) return settled.terminal;
      if (!settled.waiting) {
        return { kind: 'uncertain', message: 'The stream ended before the desktop reported an outcome.' };
      }
      await sleep(RECONNECT_BACKOFF_MS, controller.signal);
    }
  } catch (e) {
    if (e instanceof TunnelCryptoError) {
      // Authentication/replay violations fail CLOSED (§7) — never surface them as `uncertain`.
      return { kind: 'failed', code: 'sealed_envelope_invalid', message: errorMessage(e) };
    }
    if (abortKind !== null) return cancelled();
    logger.error('[desktop-tunnel] stream failed:', e);
    return { kind: 'uncertain', message: 'The desktop stream dropped mid-request; the request may still complete.' };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface ChatViaTunnelOptions {
  /** Target desktop instance; omitted = the backend's normal targeting (pin → implicit single → 409 ambiguous_desktop). */
  instanceId?: string;
  providerId: string;
  model?: string;
  /** Caller-chosen thread id (a new one is minted when omitted). */
  threadId?: string;
  messages: DesktopTunnelChatMessage[];
  /**
   * Chat tool use (plan §5.1 sealed-body fields + §5.4, Phase 6): the per-user
   * Auto/Confirm tool mode. Sealed into the request body alongside model/messages.
   */
  toolMode?: 'auto' | 'confirm';
  /** Per-turn chat-tool grant token (POST /api/ai/chat-tool-grant) — sealed, never plaintext. */
  toolGrant?: string;
  /** Per-thread client sequence number (defaults to 1). */
  clientSeq?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onDelta?: (delta: string, accumulated: string) => void;
  onState?: (state: DesktopTunnelState) => void;
  /**
   * Every decrypted out-frame (tool proposals and other future frame types land here).
   * Each frame carries the relay `requestId` (injected when absent) so confirm-mode
   * `tool_proposal` frames can be answered via postInput(requestId, …).
   */
  onFrame?: (frame: Record<string, unknown>) => void;
  /** Notified when a TOFU pin is recorded/refreshed; firstTrust=true only on the very first trust. */
  onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void;
}

export interface ChatViaTunnelSuccess {
  threadId: string;
  finalText: string;
}

/**
 * Run one chat turn through the E2E tunnel: seal → enqueue → stream deltas → final text.
 * Resolves a typed error (never throws) — including `e2e_key_rotated` when the desktop's
 * long-term key changed (re-trust via trustDesktopE2eKey after user confirmation).
 */
export async function chatViaTunnel(opts: ChatViaTunnelOptions): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> {
  const threadId = opts.threadId ?? generateId();
  const run = await executeTunnelRequest({
    kind: 'chat',
    instanceId: opts.instanceId,
    providerId: opts.providerId,
    model: opts.model,
    threadId,
    messages: opts.messages,
    toolMode: opts.toolMode,
    toolGrant: opts.toolGrant,
    clientSeq: opts.clientSeq ?? 1,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onDelta: opts.onDelta,
    onState: opts.onState ?? (() => undefined),
    onFrame: opts.onFrame,
    onTrustEstablished: opts.onTrustEstablished,
  });
  if (!run.ok) return run;
  return { ok: true, data: { threadId: run.data.threadId, finalText: run.data.finalText ?? run.data.text } };
}

export interface DesktopModelCatalog {
  models: Array<Record<string, unknown>>;
  threadId: string;
}

/** Fetch a desktop provider's model list over the tunnel (§5.5: remote catalog via kind:'models'). */
export async function fetchModelCatalog(
  providerId: string,
  opts: {
    instanceId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onState?: (state: DesktopTunnelState) => void;
    onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void;
  } = {}
): Promise<DesktopTunnelResult<DesktopModelCatalog>> {
  const threadId = generateId();
  const run = await executeTunnelRequest({
    kind: 'models',
    instanceId: opts.instanceId,
    providerId,
    threadId,
    clientSeq: 1,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onState: opts.onState ?? (() => undefined),
    onTrustEstablished: opts.onTrustEstablished,
  });
  if (!run.ok) return run;
  const models = (run.data.models ?? []).filter(
    (m): m is Record<string, unknown> => m !== null && typeof m === 'object' && !Array.isArray(m)
  );
  return { ok: true, data: { models, threadId: run.data.threadId } };
}

export interface DesktopProviderCatalog {
  providers: Array<Record<string, unknown>>;
  threadId: string;
}

/**
 * Enumerate the desktop's configured AI providers over the tunnel (kind:'providers') —
 * the provider twin of fetchModelCatalog, for browsers with no paired loopback desktop
 * (Settings should offer a dropdown, not a free-text provider id). providerId is the
 * pinned placeholder 'all': the enqueue requires a token there, but this kind targets
 * the whole gateway, not one provider.
 */
export async function fetchProviderCatalog(
  opts: {
    instanceId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onState?: (state: DesktopTunnelState) => void;
    onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void;
  } = {}
): Promise<DesktopTunnelResult<DesktopProviderCatalog>> {
  const threadId = generateId();
  const run = await executeTunnelRequest({
    kind: 'providers',
    instanceId: opts.instanceId,
    providerId: 'all',
    threadId,
    clientSeq: 1,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onState: opts.onState ?? (() => undefined),
    onTrustEstablished: opts.onTrustEstablished,
  });
  if (!run.ok) return run;
  const providers = (run.data.providers ?? []).filter(
    (p): p is Record<string, unknown> => p !== null && typeof p === 'object' && !Array.isArray(p)
  );
  return { ok: true, data: { providers, threadId: run.data.threadId } };
}

/**
 * Send a sealed inbound frame to an in-flight request (POST …/input — direction 0x00 with
 * the thread's next counter). Used by confirm-mode tool approvals (Phase 6): the desktop
 * polls this channel while paused. The session must still be active on this page.
 */
export async function postInput(
  requestId: string,
  body: Record<string, unknown>
): Promise<DesktopTunnelResult<{ accepted: boolean }>> {
  const session = activeSessions.get(requestId);
  if (!session) {
    return failure({
      code: 'session_unknown',
      message: 'No active tunnel session for this request on this page — it may have already completed.',
    });
  }
  let envelope: DesktopAiSealedEnvelope;
  try {
    envelope = session.sealInput({ v: 1, ...body });
  } catch (e) {
    return failure({ code: 'sealed_envelope_invalid', message: errorMessage(e) });
  }
  const res = await api.postDesktopAiInput(requestId, encodeTunnelEnvelope(envelope));
  if (res.error) {
    if (!res.status) {
      return failure({ code: 'uncertain', message: `The input may or may not have reached the desktop (${res.error}).` });
    }
    return failure({ code: res.code ?? 'request_failed', message: res.error, status: res.status });
  }
  return { ok: true, data: { accepted: true } };
}
