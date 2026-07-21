// Run a flow on the user's FormLogic Desktop through the E2E relay lane
// (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7 — Phase 5 "Desktop (tunneled)").
//
// This is the flow-lane sibling of the Desktop-AI tunnel (desktopTunnel.ts): the crypto
// session, TOFU pinning and envelope framing are REUSED from that module — only the
// relay routes and the payload vocabulary differ.
//
//   1. Resolve the desktop's long-term X25519 public key (GET /api/desktop/ai/pubkey,
//      same TOFU pins as the AI tunnel — one trust decision covers every desktop lane).
//   2. Seal {v:1, flowId, inputs} with a per-run ephemeral keypair (NaCl box, §5.1) and
//      enqueue it: POST /api/desktop/flows/run {flowId, ephPub, envelope, idempotencyKey}.
//      The backend sees only routing metadata; the inputs stay end-to-end encrypted.
//   3. Stream sealed progress frames from GET /api/desktop/flows/runs/{id}/stream
//      ({v:1, type:'flow_progress', nodeId, status, …}) to the onProgress callback, with
//      the tunnel's directional monotonic nonces (replay protection) and ?since= resume.
//   4. Resolve the terminal outcome: a sealed flow_result frame, or the status read's
//      sealed `resultEnvelope` (GET /api/desktop/flows/runs/{id}), opened with the session.
//
// Exposed states: queued(position) → running → done | failed(code) | uncertain.
// `uncertain` is honest: the run may still complete on the desktop (claimed-but-unreported).
// The function never throws — every failure resolves a typed DesktopTunnelError.
import {
  api,
  type DesktopFlowRunEnqueueBody,
  type DesktopFlowRunStatus,
} from '../../lib/api';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { logger } from '../../lib/logger';
import { generateId } from '../../lib/utils';
import {
  base64ToBytes,
  bytesToBase64,
  decodeTunnelEnvelope,
  encodeTunnelEnvelope,
  getDesktopE2ePin,
  keyFingerprint,
  trustDesktopE2eKey,
  TunnelSession,
  type DesktopE2eKeyRotation,
  type DesktopE2ePin,
  type DesktopTunnelError,
  type DesktopTunnelErrorCode,
  type DesktopTunnelResult,
} from './desktopTunnel';

/** Flow-lane TTL is 15 minutes (plan §5.2) — the default overall deadline for one run. */
const DEFAULT_STREAM_TIMEOUT_MS = 900_000;
const MIN_STREAM_TIMEOUT_MS = 5_000;
const MAX_STREAM_TIMEOUT_MS = 1_800_000;
/** Frames cap at 4 MiB (plan §5.2); SSE data lines carry base64 so allow headroom. */
const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;
const MAX_STREAM_ERROR_BODY_BYTES = 64 * 1024;
/** Pause before resuming a cleanly-ended stream while the run is still live. */
const RECONNECT_BACKOFF_MS = 1_000;
const BOX_PUBLIC_KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** Caller-visible states (plan §5.7): queued(pos) → running → done | failed | uncertain. */
export type DesktopFlowRunState =
  | { state: 'queued'; position: number }
  | { state: 'running' }
  | { state: 'done' }
  | { state: 'failed'; code: DesktopTunnelErrorCode; message?: string }
  | { state: 'uncertain'; message?: string };

/** One sealed {v:1, type:'flow_progress'} frame, mapped for the run UI. */
export interface DesktopFlowRunProgress {
  nodeId?: string;
  /** Executor phase for the node; unknown words pass through as 'running'. */
  status?: 'running' | 'done' | 'error';
  label?: string;
  message?: string;
}

export interface DesktopFlowRunSuccess {
  status: 'done';
  /** The opened result payload ({v:1, type:'flow_result', result} → its `result`). */
  result: unknown;
}

export type DesktopFlowRunResult = DesktopTunnelResult<DesktopFlowRunSuccess>;

export interface RunFlowOnDesktopOptions {
  /** Target desktop instance; omitted = the backend's normal targeting (pin → implicit single). */
  instanceId?: string;
  /** Run inputs (sealed into the request envelope; the backend never sees them). */
  inputs?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onState?: (state: DesktopFlowRunState) => void;
  /** Every sealed flow_progress frame, in desktop order. */
  onProgress?: (progress: DesktopFlowRunProgress) => void;
  /** Notified when a TOFU pin is recorded/refreshed (firstTrust=true only on the very first trust). */
  onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

type FlowTerminal =
  | { kind: 'done'; result: unknown }
  | { kind: 'failed'; code: DesktopTunnelErrorCode; message?: string }
  | { kind: 'uncertain'; message: string };

function failure<T>(error: DesktopTunnelError): DesktopTunnelResult<T> {
  return { ok: false, error };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    logger.warn('[desktop-flow-run] consumer callback threw:', e);
  }
}

/** Marker for authentication/replay/shape violations — these fail CLOSED (§7), never `uncertain`. */
class FlowRunCryptoError extends Error {}

/** openIncoming throws on any violation; rethrow as our marker so the catch site classifies it. */
function openIncomingStrict(session: TunnelSession, envelope: { nonce: string; ct: string }): Record<string, unknown> {
  try {
    return session.openIncoming(envelope);
  } catch (e) {
    throw new FlowRunCryptoError(errorMessage(e));
  }
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

// ---------------------------------------------------------------------------
// Desktop key resolution + TOFU (same trust store as the AI tunnel, plan §5.1).
// ---------------------------------------------------------------------------

interface ResolvedDesktopKey {
  instanceId: string;
  publicKey: Uint8Array;
  deviceName: string;
}

async function resolveDesktopKey(
  instanceId: string | undefined,
  onTrustEstablished?: (pin: DesktopE2ePin, firstTrust: boolean) => void
): Promise<DesktopTunnelResult<ResolvedDesktopKey>> {
  const res = await api.getDesktopAiPubkey(instanceId);
  if (res.error) {
    if (!res.status) {
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
    // Key rotation: NEVER trusted silently (plan §5.1/§7).
    const rotation: DesktopE2eKeyRotation = {
      instanceId: resolvedInstance,
      deviceName,
      pinnedFingerprint: pin.fingerprint,
      presentedFingerprint: keyFingerprint(publicKey),
    };
    logger.error('[desktop-flow-run] desktop E2E key ROTATED — refusing to trust it silently', rotation);
    return failure({
      code: 'e2e_key_rotated',
      message:
        `The encryption key for "${deviceName}" changed (was ${rotation.pinnedFingerprint}, now ${rotation.presentedFingerprint}). ` +
        'Only continue if you expected the desktop to be reinstalled or reset, then explicitly trust the new key.',
      rotation,
    });
  }

  if (!pin) {
    const recorded = trustDesktopE2eKey(resolvedInstance, pubkeyB64, deviceName);
    if (!recorded) {
      return failure({ code: 'e2e_key_unknown', message: 'The desktop published an invalid encryption key.' });
    }
    onTrustEstablished?.(recorded, true);
  } else {
    if (pin.deviceName !== deviceName) {
      trustDesktopE2eKey(resolvedInstance, pubkeyB64, deviceName);
    }
    onTrustEstablished?.({ ...pin, deviceName }, false);
  }
  return { ok: true, data: { instanceId: resolvedInstance, publicKey, deviceName } };
}

// ---------------------------------------------------------------------------
// Status mapping.
// ---------------------------------------------------------------------------

/** Map a backend status word (§5.2) onto the caller-visible state / terminal. */
function statusToTerminal(
  status: string,
  queuePos: number | undefined,
  code: string | undefined,
  message: string | undefined,
  onState: (state: DesktopFlowRunState) => void
): FlowTerminal | null {
  switch (status) {
    case 'pending':
      safeCall(() => onState({ state: 'queued', position: queuePos ?? 0 }));
      return null;
    case 'claimed':
    case 'running':
    case 'streaming':
      safeCall(() => onState({ state: 'running' }));
      return null;
    case 'done':
      return { kind: 'done', result: undefined };
    case 'failed':
      return { kind: 'failed', code: code ?? 'request_failed', message };
    case 'expired':
      return { kind: 'failed', code: 'expired', message: message ?? 'The queued run expired before the desktop completed it.' };
    default:
      logger.warn('[desktop-flow-run] unknown run status:', status);
      return null;
  }
}

/**
 * Open the sealed `resultEnvelope` of a completed run (direction 0x01, next monotonic
 * counter). Returns the result payload; throws on any crypto/shape violation — the
 * caller maps that to a closed `sealed_envelope_invalid` failure.
 */
function openResultEnvelope(session: TunnelSession, resultEnvelope: string): unknown {
  const envelope = decodeTunnelEnvelope(resultEnvelope);
  if (!envelope) throw new FlowRunCryptoError('undecodable result envelope');
  const frame = openIncomingStrict(session, envelope);
  return 'result' in frame ? frame.result : frame;
}

/**
 * One authoritative status read after a stream end. Returns the settled FlowTerminal, or
 * `waiting: true` when the run is still live (the caller resumes its stream cursor).
 */
async function settleFromStatus(
  session: TunnelSession,
  requestId: string,
  onState: (state: DesktopFlowRunState) => void
): Promise<{ terminal: FlowTerminal | null; waiting: boolean }> {
  const res = await api.getDesktopFlowRun(requestId);
  if (res.error) {
    return {
      terminal: { kind: 'uncertain', message: `The stream ended and the run status could not be read (${res.error}). The run may still complete.` },
      waiting: false,
    };
  }
  const run = res.data as DesktopFlowRunStatus | undefined;
  if (run && typeof run.status === 'string') {
    if (run.status === 'done') {
      if (typeof run.resultEnvelope === 'string' && run.resultEnvelope !== '') {
        return { terminal: { kind: 'done', result: openResultEnvelope(session, run.resultEnvelope) }, waiting: false };
      }
      return { terminal: { kind: 'done', result: undefined }, waiting: false };
    }
    const terminal = statusToTerminal(run.status, run.queuePos, run.code, run.message, onState);
    if (terminal) return { terminal, waiting: false };
    return { terminal: null, waiting: true };
  }
  return {
    terminal: { kind: 'uncertain', message: 'The stream ended before the desktop reported an outcome.' },
    waiting: false,
  };
}

// ---------------------------------------------------------------------------
// The SSE progress stream.
// ---------------------------------------------------------------------------

async function streamFlowRun(
  session: TunnelSession,
  requestId: string,
  opts: RunFlowOnDesktopOptions,
  onState: (state: DesktopFlowRunState) => void
): Promise<FlowTerminal> {
  const timeoutMs = Math.min(
    MAX_STREAM_TIMEOUT_MS,
    Math.max(MIN_STREAM_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS))
  );
  const controller = new AbortController();
  let abortKind: 'external' | 'timeout' | null = null;
  const onExternalAbort = () => {
    if (abortKind !== null) return;
    abortKind = 'external';
    controller.abort();
  };
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    if (abortKind !== null) return;
    abortKind = 'timeout';
    controller.abort();
  }, timeoutMs);

  const cancelled = (): FlowTerminal =>
    abortKind === 'external'
      ? { kind: 'uncertain', message: 'The stream was cancelled; the desktop may still complete the run.' }
      : { kind: 'uncertain', message: 'Timed out waiting for the desktop; the run may still complete.' };

  try {
    // The backend bounds one SSE connection's lifetime and ends it cleanly — a still-live
    // run is followed by reconnecting with the last frame cursor (?since=, §9-P1 SSE notes).
    let sinceCursor = 0;
    for (;;) {
      if (controller.signal.aborted) return cancelled();
      const url =
        resolveBackendApiUrl(`/desktop/flows/runs/${encodeURIComponent(requestId)}/stream`) +
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
        return { kind: 'uncertain', message: 'Could not open the desktop stream; the run may still complete.' };
      }

      if (res.status === 401) {
        return { kind: 'failed', code: 'auth_required', message: 'Sign in again to follow the desktop run.' };
      }
      if (!res.ok || !res.body) {
        const body = await readBoundedJson(res);
        const code = firstString(body?.code) ?? 'request_failed';
        const message = firstString(body?.message) ?? `The stream endpoint responded ${res.status}.`;
        return { kind: 'failed', code, message };
      }

      /** Handle one SSE data payload; returns a FlowTerminal when the run is settled. */
      const dispatchData = async (data: string): Promise<FlowTerminal | null> => {
        if (!data) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          logger.warn('[desktop-flow-run] dropping a malformed stream data frame');
          return null;
        }
        const obj = asRecord(parsed);
        if (!obj) return null;
        if (typeof obj.seq === 'number' && Number.isSafeInteger(obj.seq) && obj.seq > sinceCursor) {
          sinceCursor = obj.seq;
        }

        // Sealed frame from the desktop ({seq, envelope}); tolerate a raw {nonce, ct} shape too.
        let envelope = null;
        if (typeof obj.envelope === 'string') {
          envelope = decodeTunnelEnvelope(obj.envelope);
          if (!envelope) throw new FlowRunCryptoError('undecodable envelope on the stream');
        } else {
          const shaped = asRecord(obj.frame) ?? asRecord(obj.envelope) ?? obj;
          if (typeof shaped.nonce === 'string' && typeof shaped.ct === 'string') {
            envelope = { nonce: shaped.nonce, ct: shaped.ct };
          }
        }
        if (envelope) {
          const frame = openIncomingStrict(session, envelope); // throws FlowRunCryptoError — fail closed
          const type = firstString(frame.type, frame.kind);
          switch (type) {
            case 'flow_progress': {
              const statusWord = firstString(frame.status);
              safeCall(() =>
                opts.onProgress?.({
                  ...(firstString(frame.nodeId, frame.node) ? { nodeId: firstString(frame.nodeId, frame.node) } : {}),
                  status: statusWord === 'done' || statusWord === 'error' ? statusWord : 'running',
                  ...(firstString(frame.label, frame.nodeLabel) ? { label: firstString(frame.label, frame.nodeLabel) } : {}),
                  ...(firstString(frame.message, frame.error) ? { message: firstString(frame.message, frame.error) } : {}),
                })
              );
              safeCall(() => onState({ state: 'running' }));
              return null;
            }
            case 'flow_result':
            case 'done':
            case 'final': {
              if ('result' in frame && frame.result !== undefined) return { kind: 'done', result: frame.result };
              // No inline result — the status read carries the sealed resultEnvelope.
              const settled = await settleFromStatus(session, requestId, onState);
              if (settled.terminal) return settled.terminal;
              return settled.waiting ? null : { kind: 'done', result: undefined };
            }
            case 'failed':
            case 'error':
              return {
                kind: 'failed',
                code: firstString(frame.code) ?? 'request_failed',
                message: firstString(frame.message),
              };
            case 'state':
            case 'status': {
              const word = firstString(frame.state, frame.status) ?? '';
              if (word === 'done') {
                const settled = await settleFromStatus(session, requestId, onState);
                if (settled.terminal) return settled.terminal;
                return settled.waiting ? null : { kind: 'done', result: undefined };
              }
              return statusToTerminal(
                word,
                typeof frame.position === 'number' ? frame.position : undefined,
                firstString(frame.code),
                firstString(frame.message),
                onState
              );
            }
            default:
              logger.warn('[desktop-flow-run] unhandled frame type:', type);
              return null;
          }
        }

        // Unsealed status event (queue position / lifecycle — routing metadata only, §7).
        if (typeof obj.status === 'string') {
          if (obj.status === 'done') {
            // The result never rides unsealed routing metadata — read the sealed resultEnvelope.
            const settled = await settleFromStatus(session, requestId, onState);
            if (settled.terminal) return settled.terminal;
            return settled.waiting ? null : { kind: 'done', result: undefined };
          }
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
                throw new FlowRunCryptoError('stream event exceeded the browser limit');
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
      // between done (with the sealed result) / failed(code) / uncertain — or a resume.
      const settled = await settleFromStatus(session, requestId, onState);
      if (settled.terminal) return settled.terminal;
      if (!settled.waiting) {
        return { kind: 'uncertain', message: 'The stream ended before the desktop reported an outcome.' };
      }
      await sleep(RECONNECT_BACKOFF_MS, controller.signal);
    }
  } catch (e) {
    if (abortKind !== null) return cancelled();
    // Authentication/replay/shape violations fail CLOSED (§7) — never `uncertain`.
    if (e instanceof FlowRunCryptoError) {
      return { kind: 'failed', code: 'sealed_envelope_invalid', message: errorMessage(e) };
    }
    logger.error('[desktop-flow-run] stream failed:', e);
    return { kind: 'uncertain', message: 'The desktop stream dropped mid-run; the run may still complete.' };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onExternalAbort);
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

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Run one flow on the linked FormLogic Desktop: seal → enqueue → stream progress → open
 * the sealed result. Resolves a typed error (never throws) — including `e2e_key_rotated`
 * when the desktop's long-term key changed (re-trust via trustDesktopE2eKey after user
 * confirmation) and `uncertain` when the outcome is genuinely unknown (never fake a
 * failure the desktop may still turn into a success, §5.8).
 */
export async function runFlowOnDesktop(
  flowId: string,
  opts: RunFlowOnDesktopOptions = {}
): Promise<DesktopFlowRunResult> {
  const onState = opts.onState ?? (() => undefined);
  const fail = (error: DesktopTunnelError, terminalState?: DesktopFlowRunState): DesktopFlowRunResult => {
    safeCall(() =>
      onState(
        terminalState ?? ({
          state: error.code === 'uncertain' ? 'uncertain' : 'failed',
          code: error.code,
          message: error.message,
        } as DesktopFlowRunState)
      )
    );
    return failure(error);
  };

  // 1. Desktop key + TOFU (the AI tunnel's trust store — one trust covers every lane).
  const keyRes = await resolveDesktopKey(opts.instanceId, opts.onTrustEstablished);
  if (!keyRes.ok) return fail(keyRes.error);
  const { instanceId, publicKey } = keyRes.data;

  // 2. Per-run ephemeral session + sealed request envelope (counter 0, direction 0x00).
  const session = TunnelSession.create(instanceId, publicKey);
  const sealedBody: Record<string, unknown> = { v: 1, flowId, inputs: opts.inputs ?? {}, clientSeq: 1 };
  let envelopeB64: string;
  try {
    envelopeB64 = encodeTunnelEnvelope(session.sealRequest(sealedBody));
  } catch (e) {
    return fail({ code: 'sealed_envelope_invalid', message: errorMessage(e) });
  }

  // 3. Enqueue onto the desktop's flow lane (§5.2). The backend never sees the plaintext.
  const enqueueBody: DesktopFlowRunEnqueueBody = {
    targetInstanceId: instanceId,
    flowId,
    ephPub: bytesToBase64(session.ephemeralPublicKey),
    envelope: envelopeB64,
    idempotencyKey: generateId(),
  };
  const enqueueRes = await api.enqueueDesktopFlowRun(enqueueBody);
  if (enqueueRes.error) {
    if (!enqueueRes.status) {
      // Network failure at enqueue: the run MAY have landed — honest `uncertain` (§5.8),
      // never a silent retry that could double-run the flow.
      return fail({
        code: 'uncertain',
        message: `The run may or may not have reached the queue (${enqueueRes.error}). Check the request list before retrying.`,
      });
    }
    return fail({ code: enqueueRes.code ?? 'request_failed', message: enqueueRes.error, status: enqueueRes.status });
  }
  const requestId = enqueueRes.data?.requestId;
  if (!requestId) {
    return fail({ code: 'request_failed', message: 'The queue accepted the run but returned no request id.' });
  }
  safeCall(() => onState({ state: 'queued', position: enqueueRes.data?.queuePos ?? 0 }));

  // 4. Stream sealed progress to a terminal outcome, then resolve the result.
  const terminal = await streamFlowRun(session, requestId, opts, onState);
  switch (terminal.kind) {
    case 'done': {
      // A sealed flow_result frame is authentic on its own; otherwise the status read
      // (already done inside the stream loop when it ended cleanly) is the authority.
      safeCall(() => onState({ state: 'done' }));
      return { ok: true, data: { status: 'done', result: terminal.result } };
    }
    case 'failed':
      return fail({ code: terminal.code, message: terminal.message ?? 'The desktop reported a failure.' });
    case 'uncertain':
      return fail({ code: 'uncertain', message: terminal.message }, { state: 'uncertain', message: terminal.message });
  }
}
