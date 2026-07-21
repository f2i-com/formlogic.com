// Tests for the browser E2E tunnel client (plan §5.1/§5.2/§7, Phase 1 step 10).
//
// Covers: nonce construction rules, NaCl-box seal/open round-trips between independently
// derived shared keys (the browser and desktop sides), tamper/wrong-key rejection, TOFU
// pin recording + rotation detection (never silent), the queued→streaming→done/failed/
// uncertain state machine against a mocked backend, sealed postInput frames, and — when
// docs/contracts/e2e-envelope-vectors.json exists — the shared cross-implementation
// vectors (skips cleanly while the file is absent).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nacl from 'tweetnacl';
import {
  __resetDesktopTunnelForTests,
  base64ToBytes,
  buildTunnelNonce,
  bytesToBase64,
  chatViaTunnel,
  decodeTunnelEnvelope,
  deriveTunnelSharedKey,
  encodeTunnelEnvelope,
  fetchModelCatalog,
  fetchProviderCatalog,
  forgetDesktopE2ePin,
  getDesktopE2ePin,
  keyFingerprint,
  openTunnelFrame,
  parseTunnelNonce,
  postInput,
  readDesktopE2ePins,
  sealTunnelFrame,
  trustDesktopE2eKey,
  TunnelSession,
  TUNNEL_DIRECTION_REQUEST,
  TUNNEL_DIRECTION_RESPONSE,
  type DesktopTunnelState,
} from './desktopTunnel';

// ---------------------------------------------------------------------------
// Environment stubs (vitest runs in node: no localStorage / document by default).
// ---------------------------------------------------------------------------

class MemStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function setFetch(mock: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
}

function sseResponse(events: string[], status = 200): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return Promise.resolve(new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } }));
}

function controllableSseResponse(): { push: (event: string) => void; close: () => void } {
  const encoder = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctl = controller;
    },
  });
  (globalThis as unknown as { __sseResponse?: Response }).__sseResponse = new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  return {
    push: (event: string) => ctl?.enqueue(encoder.encode(event)),
    close: () => ctl?.close(),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fixedBytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** A fake desktop side: holds a long-term keypair and seals out-frames to the browser. */
function makeFakeDesktop(fill = 7) {
  const keyPair = nacl.box.keyPair.fromSecretKey(fixedBytes(32, fill));
  let counter = -1;
  let seq = 0;
  return {
    keyPair,
    publicKeyB64: bytesToBase64(keyPair.publicKey),
    /** Reset the per-request frame counters (the desktop's session cache is per request). */
    reset(): void {
      counter = -1;
      seq = 0;
    },
    /** Shared key for a request, given the browser's ephemeral public key (b64). */
    sharedKeyFor(ephPubB64: string): Uint8Array {
      return nacl.box.before(base64ToBytes(ephPubB64), keyPair.secretKey);
    },
    /**
     * Seal one out-frame exactly like the desktop relay + backend SSE would deliver it:
     * {seq, envelope: base64(JSON {nonce, ct})} with direction 0x01 and a monotonic counter.
     */
    sealOutFrame(ephPubB64: string, frame: Record<string, unknown>, explicitCounter?: number): string {
      counter = explicitCounter ?? counter + 1;
      seq += 1;
      const nonce = buildTunnelNonce(TUNNEL_DIRECTION_RESPONSE, counter);
      const ct = nacl.box.after(encoder.encode(JSON.stringify(frame)), nonce, this.sharedKeyFor(ephPubB64));
      return JSON.stringify({ seq, envelope: encodeTunnelEnvelope({ nonce: bytesToBase64(nonce), ct: bytesToBase64(ct) }) });
    },
  };
}

const DESKTOP = makeFakeDesktop();
const INSTANCE = 'desktop-test-1';

interface MockBackend {
  fetchMock: ReturnType<typeof vi.fn>;
  capturedEnqueue: () => Record<string, unknown>;
}

/** Wire a fetch mock that plays the backend relay: pubkey → enqueue → SSE stream. */
function mockTunnelBackend(
  desktop: ReturnType<typeof makeFakeDesktop>,
  streamEvents: (ephPubB64: string) => string[],
  opts: { enqueueStatus?: number; enqueueBody?: unknown; statusBody?: unknown } = {}
): MockBackend {
  let captured: Record<string, unknown> = {};
  const fetchMock = setFetch(
    vi.fn((...args: unknown[]) => {
      const url = String(args[0]);
      const init = (args[1] ?? {}) as RequestInit;
      if (url.includes('/api/desktop/ai/pubkey')) {
        return jsonResponse({ instanceId: INSTANCE, publicKey: desktop.publicKeyB64, deviceName: 'Test Box' });
      }
      if (url.endsWith('/api/desktop/ai/requests') && init.method === 'POST') {
        captured = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (opts.enqueueBody !== undefined || opts.enqueueStatus) {
          return jsonResponse(opts.enqueueBody ?? { error: true, code: 'queue_full_user', message: 'full' }, opts.enqueueStatus ?? 429);
        }
        return jsonResponse({ requestId: 'req-1', status: 'pending', queuePos: 2 }, 201);
      }
      if (url.includes('/stream')) {
        desktop.reset(); // a fresh desktop-side session per request
        return sseResponse(streamEvents(String(captured.ephPub)));
      }
      if (url.includes('/api/desktop/ai/requests/') && init.method === 'POST' && url.endsWith('/input')) {
        return jsonResponse({ accepted: true });
      }
      if (url.includes('/api/desktop/ai/requests/')) {
        const statusBody = 'statusBody' in opts ? opts.statusBody : { requestId: 'req-1', status: 'claimed' };
        return jsonResponse({ request: statusBody });
      }
      return jsonResponse({ error: true, message: `unmocked ${url}` }, 404);
    })
  );
  return { fetchMock, capturedEnqueue: () => captured };
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = new MemStorage();
  (globalThis as unknown as { document: unknown }).document = { cookie: '' };
  __resetDesktopTunnelForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { document?: unknown }).document;
  delete (globalThis as unknown as { __sseResponse?: Response }).__sseResponse;
  __resetDesktopTunnelForTests();
});

// ---------------------------------------------------------------------------
// Nonce rules (plan §5.1).
// ---------------------------------------------------------------------------

describe('tunnel nonces', () => {
  it('builds a 24-byte nonce with the direction in byte 0 and a big-endian counter', () => {
    const zero = buildTunnelNonce(TUNNEL_DIRECTION_REQUEST, 0);
    expect(zero.length).toBe(24);
    expect(Array.from(zero)).toEqual(new Array(24).fill(0));

    const nonce = buildTunnelNonce(TUNNEL_DIRECTION_RESPONSE, 258); // 0x0102
    expect(nonce[0]).toBe(1);
    expect(nonce[22]).toBe(1);
    expect(nonce[23]).toBe(2);
    expect(parseTunnelNonce(nonce)).toEqual({ direction: 1, counter: 258 });
  });

  it('rejects negative, fractional, and unsafe counters', () => {
    expect(() => buildTunnelNonce(0, -1)).toThrow(RangeError);
    expect(() => buildTunnelNonce(0, 1.5)).toThrow(RangeError);
    expect(() => buildTunnelNonce(0, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => parseTunnelNonce(new Uint8Array(8))).toThrow(RangeError);
  });

  it('round-trips large safe-integer counters', () => {
    const counter = 2 ** 40 + 17;
    expect(parseTunnelNonce(buildTunnelNonce(0, counter)).counter).toBe(counter);
  });
});

// ---------------------------------------------------------------------------
// Seal/open round-trips (the exact §5.1 construction, both sides derived independently).
// ---------------------------------------------------------------------------

describe('tunnel crypto', () => {
  it('seals browser→desktop and opens with the independently derived desktop-side key', () => {
    const browser = nacl.box.keyPair.fromSecretKey(fixedBytes(32, 2));
    const sharedBrowserSide = deriveTunnelSharedKey(DESKTOP.keyPair.publicKey, browser.secretKey);
    const sharedDesktopSide = deriveTunnelSharedKey(browser.publicKey, DESKTOP.keyPair.secretKey);

    const sealed = sealTunnelFrame(sharedBrowserSide, encoder.encode(JSON.stringify({ v: 1, kind: 'chat' })), TUNNEL_DIRECTION_REQUEST, 0);
    const opened = openTunnelFrame(sharedDesktopSide, sealed);

    expect(opened).not.toBeNull();
    expect(opened?.direction).toBe(TUNNEL_DIRECTION_REQUEST);
    expect(opened?.counter).toBe(0);
    expect(JSON.parse(decoder.decode(opened?.plaintext))).toEqual({ v: 1, kind: 'chat' });
  });

  it('seals desktop→browser out-frames the TunnelSession can open, with monotonic counters', () => {
    const session = TunnelSession.create(INSTANCE, DESKTOP.keyPair.publicKey);
    const eph = bytesToBase64(session.ephemeralPublicKey);

    const first = JSON.parse(DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'a' }));
    const second = JSON.parse(DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'b' }));
    expect(session.openIncoming(decodeTunnelEnvelope(first.envelope)!)).toMatchObject({ type: 'delta', text: 'a' });
    expect(session.openIncoming(decodeTunnelEnvelope(second.envelope)!)).toMatchObject({ type: 'delta', text: 'b' });
  });

  it('returns null for tampered ciphertext, wrong keys, and malformed input', () => {
    const browser = nacl.box.keyPair.fromSecretKey(fixedBytes(32, 3));
    const shared = deriveTunnelSharedKey(DESKTOP.keyPair.publicKey, browser.secretKey);
    const sealed = sealTunnelFrame(shared, encoder.encode('secret'), TUNNEL_DIRECTION_REQUEST, 0);

    const tampered = base64ToBytes(sealed.ct);
    tampered[0] ^= 0xff;
    expect(openTunnelFrame(shared, { nonce: sealed.nonce, ct: bytesToBase64(tampered) })).toBeNull();

    const stranger = nacl.box.keyPair.fromSecretKey(fixedBytes(32, 4));
    const wrongShared = deriveTunnelSharedKey(stranger.publicKey, fixedBytes(32, 5));
    expect(openTunnelFrame(wrongShared, sealed)).toBeNull();

    expect(openTunnelFrame(shared, { nonce: '!!!', ct: sealed.ct })).toBeNull();
    expect(openTunnelFrame(shared, { nonce: bytesToBase64(new Uint8Array(8)), ct: sealed.ct })).toBeNull();
  });

  it('fails closed on wrong direction and on replayed/out-of-order counters', () => {
    const session = TunnelSession.create(INSTANCE, DESKTOP.keyPair.publicKey);
    const eph = bytesToBase64(session.ephemeralPublicKey);

    // A "desktop" frame sealed with the browser→desktop direction byte must be rejected.
    const wrongDirection = (() => {
      const nonce = buildTunnelNonce(TUNNEL_DIRECTION_REQUEST, 0);
      const ct = nacl.box.after(encoder.encode('{"v":1}'), nonce, DESKTOP.sharedKeyFor(eph));
      return { nonce: bytesToBase64(nonce), ct: bytesToBase64(ct) };
    })();
    expect(() => session.openIncoming(wrongDirection)).toThrow(/direction/);

    // Replay: same counter twice.
    const frame = decodeTunnelEnvelope(JSON.parse(DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'x' }, 0)).envelope)!;
    expect(session.openIncoming(frame)).toMatchObject({ type: 'delta' });
    expect(() => session.openIncoming(frame)).toThrow(/replay|out-of-order/i);

    // Out of order (counter goes backwards).
    const older = decodeTunnelEnvelope(JSON.parse(DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'y' }, 0)).envelope)!;
    expect(() => session.openIncoming(older)).toThrow(/replay|out-of-order/i);
  });

  it('sealRequest uses counter 0 and sealInput increments per frame (direction 0x00)', () => {
    const session = TunnelSession.create(INSTANCE, DESKTOP.keyPair.publicKey);
    const shared = DESKTOP.sharedKeyFor(bytesToBase64(session.ephemeralPublicKey));

    const request = session.sealRequest({ v: 1, kind: 'chat' });
    const openedRequest = openTunnelFrame(shared, request);
    expect(openedRequest?.direction).toBe(TUNNEL_DIRECTION_REQUEST);
    expect(openedRequest?.counter).toBe(0);

    const input1 = session.sealInput({ v: 1, type: 'tool_approval', approved: true });
    const input2 = session.sealInput({ v: 1, type: 'tool_approval', approved: false });
    expect(openTunnelFrame(shared, input1)?.counter).toBe(1);
    expect(openTunnelFrame(shared, input2)?.counter).toBe(2);
    expect(JSON.parse(decoder.decode(openTunnelFrame(shared, input2)?.plaintext))).toMatchObject({ approved: false });
  });

  it('encodes/decodes the backend envelope string (compact binary, with JSON blob fallback)', () => {
    const frame = { nonce: bytesToBase64(buildTunnelNonce(0, 0)), ct: bytesToBase64(encoder.encode('abc')) };
    const encoded = encodeTunnelEnvelope(frame);
    // Canonical wire layout: base64(nonce(24) || ciphertext) — matches the desktop's pack_envelope.
    const raw = base64ToBytes(encoded);
    expect(raw.length).toBe(24 + 3);
    expect(bytesToBase64(raw.subarray(0, 24))).toBe(frame.nonce);
    expect(decodeTunnelEnvelope(encoded)).toEqual(frame);

    // JSON blob fallback: base64({"nonce","ct"}).
    const legacy = bytesToBase64(encoder.encode(JSON.stringify(frame)));
    expect(decodeTunnelEnvelope(legacy)).toEqual(frame);

    expect(decodeTunnelEnvelope('!!!not-base64!!!')).toBeNull();
    expect(decodeTunnelEnvelope(bytesToBase64(new Uint8Array(4)))).toBeNull(); // too short for either layout
  });
});

// ---------------------------------------------------------------------------
// TOFU pin store (§5.1) — first-trust record + rotation detection, never silent.
// ---------------------------------------------------------------------------

describe('TOFU pin store', () => {
  it('records a first-trust pin with device name + fingerprint', () => {
    const pin = trustDesktopE2eKey(INSTANCE, DESKTOP.publicKeyB64, 'Test Box');
    expect(pin).not.toBeNull();
    expect(pin?.fingerprint).toBe(keyFingerprint(DESKTOP.keyPair.publicKey));
    expect(getDesktopE2ePin(INSTANCE)?.pubkey).toBe(DESKTOP.publicKeyB64);
    expect(readDesktopE2ePins()[INSTANCE].deviceName).toBe('Test Box');
  });

  it('rejects malformed keys and forgets pins explicitly', () => {
    expect(trustDesktopE2eKey(INSTANCE, '!!!', 'Box')).toBeNull();
    expect(trustDesktopE2eKey(INSTANCE, bytesToBase64(new Uint8Array(8)), 'Box')).toBeNull();
    trustDesktopE2eKey(INSTANCE, DESKTOP.publicKeyB64, 'Box');
    forgetDesktopE2ePin(INSTANCE);
    expect(getDesktopE2ePin(INSTANCE)).toBeNull();
  });

  it('trusts the key on first use, then accepts the same key silently', async () => {
    const backend = mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done', text: 'hi' })}\n\n`,
    ]);
    const trusted: Array<{ fingerprint: string; first: boolean }> = [];
    const opts = {
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      onTrustEstablished: (pin: { fingerprint: string }, first: boolean) => trusted.push({ fingerprint: pin.fingerprint, first }),
    };

    const first = await chatViaTunnel({ ...opts, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    expect(trusted).toEqual([{ fingerprint: keyFingerprint(DESKTOP.keyPair.publicKey), first: true }]);
    expect(getDesktopE2ePin(INSTANCE)?.pubkey).toBe(DESKTOP.publicKeyB64);

    const second = await chatViaTunnel({ ...opts, instanceId: INSTANCE });
    expect(second.ok).toBe(true);
    expect(trusted[1]).toEqual({ fingerprint: keyFingerprint(DESKTOP.keyPair.publicKey), first: false });
    expect(backend.fetchMock).toHaveBeenCalled();
  });

  it('fails with e2e_key_rotated on a changed key and never overwrites the pin silently', async () => {
    trustDesktopE2eKey(INSTANCE, DESKTOP.publicKeyB64, 'Test Box');
    const rotated = makeFakeDesktop(42);
    mockTunnelBackend(rotated, () => []);

    const res = await chatViaTunnel({
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      instanceId: INSTANCE,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('e2e_key_rotated');
      expect(res.error.rotation?.pinnedFingerprint).toBe(keyFingerprint(DESKTOP.keyPair.publicKey));
      expect(res.error.rotation?.presentedFingerprint).toBe(keyFingerprint(rotated.keyPair.publicKey));
    }
    // The old pin survives: the rotated key was NOT adopted silently.
    expect(getDesktopE2ePin(INSTANCE)?.pubkey).toBe(DESKTOP.publicKeyB64);

    // Explicit re-trust (what the UI prompt calls) lets the new key through.
    expect(trustDesktopE2eKey(INSTANCE, rotated.publicKeyB64, 'Test Box')?.pubkey).toBe(rotated.publicKeyB64);
    const backend = mockTunnelBackend(rotated, (eph) => [
      `data: ${rotated.sealOutFrame(eph, { v: 1, type: 'done', text: 'ok again' })}\n\n`,
    ]);
    const retry = await chatViaTunnel({
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      instanceId: INSTANCE,
    });
    expect(retry.ok).toBe(true);
    expect(backend.fetchMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State machine + wire behavior against a mocked backend (§5.2, §9 step 9/10).
// ---------------------------------------------------------------------------

describe('chatViaTunnel state machine', () => {
  it('runs queued → streaming → done, sealing the request and streaming decrypted deltas', async () => {
    const backend = mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'state', state: 'streaming' })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'Hello, ' })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'world' })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done', text: 'Hello, world' })}\n\n`,
    ]);
    const states: DesktopTunnelState[] = [];
    const deltas: string[] = [];

    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      model: 'gpt-5-codex',
      threadId: 'thread-1',
      messages: [{ role: 'user', content: 'Say hello' }],
      onState: (s) => states.push(s),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(res).toEqual({ ok: true, data: { threadId: 'thread-1', finalText: 'Hello, world' } });
    expect(states).toEqual([{ state: 'queued', position: 2 }, { state: 'streaming' }, { state: 'done' }]);
    expect(deltas).toEqual(['Hello, ', 'world']);

    // The request envelope: routing plaintext + a sealed body only the desktop can open.
    const body = backend.capturedEnqueue();
    expect(body.targetInstanceId).toBe(INSTANCE);
    expect(body.kind).toBe('chat');
    expect(body.providerId).toBe('openai-codex-agent');
    expect(typeof body.ephPub).toBe('string');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(typeof body.envelope).toBe('string'); // the backend relays one opaque base64 string
    const envelope = decodeTunnelEnvelope(String(body.envelope));
    expect(envelope).not.toBeNull();
    const opened = openTunnelFrame(DESKTOP.sharedKeyFor(String(body.ephPub)), envelope!);
    expect(opened?.direction).toBe(TUNNEL_DIRECTION_REQUEST);
    expect(opened?.counter).toBe(0);
    expect(JSON.parse(decoder.decode(opened?.plaintext))).toEqual({
      v: 1,
      kind: 'chat',
      providerId: 'openai-codex-agent',
      model: 'gpt-5-codex',
      threadId: 'thread-1',
      messages: [{ role: 'user', content: 'Say hello' }],
      clientSeq: 1,
    });
  });

  it('seals toolMode + toolGrant into the request body when given (plan §5.1/§5.4)', async () => {
    const backend = mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done', text: 'ok' })}\n\n`,
    ]);

    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      threadId: 'thread-tools',
      messages: [{ role: 'user', content: 'make a form' }],
      toolMode: 'confirm',
      toolGrant: 'grant-token-abc',
    });
    expect(res.ok).toBe(true);

    const body = backend.capturedEnqueue();
    // The grant NEVER appears in the plaintext routing fields.
    expect(JSON.stringify({ ...body, envelope: '' })).not.toContain('grant-token-abc');
    const opened = openTunnelFrame(
      DESKTOP.sharedKeyFor(String(body.ephPub)),
      decodeTunnelEnvelope(String(body.envelope))!
    );
    expect(JSON.parse(decoder.decode(opened?.plaintext))).toEqual({
      v: 1,
      kind: 'chat',
      providerId: 'openai-codex-agent',
      threadId: 'thread-tools',
      messages: [{ role: 'user', content: 'make a form' }],
      toolMode: 'confirm',
      toolGrant: 'grant-token-abc',
      clientSeq: 1,
    });
  });

  it('injects the relay requestId into every onFrame frame (kept when already present)', async () => {
    mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'tool_proposal', callId: 'call-1', tool: 'create_form', input: {} })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'tool_call', name: 'create_form', status: 'done', requestId: 'req-custom' })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done', text: 'made it' })}\n\n`,
    ]);
    const frames: Array<Record<string, unknown>> = [];
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'make a form' }],
      onFrame: (frame) => frames.push(frame),
    });
    expect(res.ok).toBe(true);
    expect(frames).toHaveLength(3);
    // The enqueue mock answers requestId 'req-1'; frames without one get it injected…
    expect(frames[0]).toMatchObject({ type: 'tool_proposal', callId: 'call-1', requestId: 'req-1' });
    expect(frames[2]).toMatchObject({ type: 'done', requestId: 'req-1' });
    // …and a frame that already names a requestId keeps its own.
    expect(frames[1]).toMatchObject({ type: 'tool_call', requestId: 'req-custom' });
  });

  it('surfaces a typed enqueue refusal (queue_full_user) as failed(code)', async () => {
    mockTunnelBackend(DESKTOP, () => [], {
      enqueueStatus: 429,
      enqueueBody: { error: true, code: 'queue_full_user', message: 'You already have too many requests queued.' },
    });
    const states: DesktopTunnelState[] = [];
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      onState: (s) => states.push(s),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('queue_full_user');
      expect(res.error.status).toBe(429);
    }
    expect(states).toEqual([{ state: 'failed', code: 'queue_full_user', message: 'You already have too many requests queued.' }]);
  });

  it('reports uncertain when the stream ends and the request outcome is unreported', async () => {
    // The request row is gone/unreadable (e.g. purged before an outcome was recorded):
    // the honest terminal state is `uncertain` (§5.8), never a fabricated success.
    mockTunnelBackend(DESKTOP, () => [], { statusBody: null });
    const states: DesktopTunnelState[] = [];
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      onState: (s) => states.push(s),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('uncertain');
    expect(states[states.length - 1].state).toBe('uncertain');
  });

  it('settles done from the status endpoint when the stream ended after completion', async () => {
    mockTunnelBackend(DESKTOP, () => [], { statusBody: { requestId: 'req-1', status: 'done' } });
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.ok).toBe(true);
  });

  it('fails closed with sealed_envelope_invalid when a frame counter is replayed', async () => {
    mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'a' }, 0)}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'delta', text: 'b' }, 0)}\n\n`, // replayed counter
    ]);
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('sealed_envelope_invalid');
  });

  it('maps a typed stream-open error from the backend', async () => {
    setFetch(
      vi.fn((...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes('/api/desktop/ai/pubkey')) {
          return jsonResponse({ instanceId: INSTANCE, publicKey: DESKTOP.publicKeyB64, deviceName: 'Test Box' });
        }
        if (url.endsWith('/api/desktop/ai/requests')) {
          return jsonResponse({ requestId: 'req-1', status: 'pending', queuePos: 0 }, 201);
        }
        if (url.endsWith('/stream')) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: true, code: 'desktop_offline', message: 'The desktop went away.' }), { status: 503 })
          );
        }
        return jsonResponse({}, 404);
      })
    );
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('desktop_offline');
  });

  it('handles unsealed queue-status events on the stream', async () => {
    mockTunnelBackend(DESKTOP, (eph) => [
      'data: {"status":"pending","queuePos":1}\n\n',
      'data: {"status":"streaming"}\n\n',
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done', text: 'fine' })}\n\n`,
    ]);
    const states: DesktopTunnelState[] = [];
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      onState: (s) => states.push(s),
    });
    expect(res.ok).toBe(true);
    expect(states).toEqual([
      { state: 'queued', position: 2 },
      { state: 'queued', position: 1 },
      { state: 'streaming' },
      { state: 'done' },
    ]);
  });

  it('accepts the desktop kind vocabulary: OpenAI-chunk deltas and a final completion', async () => {
    mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, kind: 'delta', delta: { choices: [{ delta: { content: 'Hel' } }] } })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, kind: 'delta', delta: { choices: [{ delta: { content: 'lo' } }] } })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, kind: 'final', completion: { choices: [{ message: { content: 'Hello' } }] } })}\n\n`,
    ]);
    const deltas: string[] = [];
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });
    expect(res).toEqual({ ok: true, data: { threadId: expect.any(String), finalText: 'Hello' } });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('resumes a cleanly-ended stream while the request is still live', async () => {
    let captured: Record<string, unknown> = {};
    let streamCalls = 0;
    setFetch(
      vi.fn((...args: unknown[]) => {
        const url = String(args[0]);
        const init = (args[1] ?? {}) as RequestInit;
        if (url.includes('/api/desktop/ai/pubkey')) {
          return jsonResponse({ instanceId: INSTANCE, publicKey: DESKTOP.publicKeyB64, deviceName: 'Test Box' });
        }
        if (url.endsWith('/api/desktop/ai/requests') && init.method === 'POST') {
          captured = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ requestId: 'req-1', status: 'pending', queuePos: 0 }, 201);
        }
        if (url.includes('/stream')) {
          streamCalls += 1;
          DESKTOP.reset();
          if (streamCalls === 1) return sseResponse([]); // clean end, no frames
          return sseResponse([
            `data: ${DESKTOP.sealOutFrame(String(captured.ephPub), { v: 1, type: 'done', text: 'resumed' })}\n\n`,
          ]);
        }
        if (url.includes('/api/desktop/ai/requests/')) {
          return jsonResponse({ request: { requestId: 'req-1', status: 'claimed' } });
        }
        return jsonResponse({}, 404);
      })
    );
    const res = await chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res).toEqual({ ok: true, data: { threadId: expect.any(String), finalText: 'resumed' } });
    expect(streamCalls).toBe(2);
  });
});

describe('fetchModelCatalog', () => {
  it('collects the models frame over the tunnel (kind=models)', async () => {
    const backend = mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'models', models: [{ id: 'gpt-5-codex' }, { id: 'gpt-5' }] })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done' })}\n\n`,
    ]);
    const res = await fetchModelCatalog('openai-codex-agent', { instanceId: INSTANCE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.models).toEqual([{ id: 'gpt-5-codex' }, { id: 'gpt-5' }]);
      expect(res.data.threadId).toBeTruthy();
    }
    expect(backend.capturedEnqueue().kind).toBe('models');
  });
});

describe('fetchProviderCatalog', () => {
  it('collects the providers frame over the tunnel (kind=providers, providerId pinned to "all")', async () => {
    const backend = mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'providers', providers: [{ id: 'openai-codex-agent', label: 'ChatGPT (Codex)' }, { id: 'local-llama', label: 'Llama.cpp' }] })}\n\n`,
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'done' })}\n\n`,
    ]);
    const res = await fetchProviderCatalog({ instanceId: INSTANCE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.providers).toEqual([
        { id: 'openai-codex-agent', label: 'ChatGPT (Codex)' },
        { id: 'local-llama', label: 'Llama.cpp' },
      ]);
    }
    expect(backend.capturedEnqueue().kind).toBe('providers');
    expect(backend.capturedEnqueue().providerId).toBe('all');
  });

  it('also accepts providers delivered on the final frame', async () => {
    mockTunnelBackend(DESKTOP, (eph) => [
      `data: ${DESKTOP.sealOutFrame(eph, { v: 1, type: 'final', providers: [{ id: 'local-llama' }] })}\n\n`,
    ]);
    const res = await fetchProviderCatalog({ instanceId: INSTANCE });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.providers).toEqual([{ id: 'local-llama' }]);
  });
});

describe('postInput', () => {
  it('refuses requests with no active session', async () => {
    const res = await postInput('req-nope', { type: 'tool_approval', approved: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('session_unknown');
  });

  it('seals the input frame with direction 0x00 and the next counter', async () => {
    const sse = controllableSseResponse();
    let captured: Record<string, unknown> = {};
    let inputBody: Record<string, unknown> | null = null;
    let streamRequested!: () => void;
    const streamRequestedP = new Promise<void>((resolve) => {
      streamRequested = resolve;
    });
    setFetch(
      vi.fn((...args: unknown[]) => {
        const url = String(args[0]);
        const init = (args[1] ?? {}) as RequestInit;
        if (url.includes('/api/desktop/ai/pubkey')) {
          return jsonResponse({ instanceId: INSTANCE, publicKey: DESKTOP.publicKeyB64, deviceName: 'Test Box' });
        }
        if (url.endsWith('/api/desktop/ai/requests') && init.method === 'POST') {
          captured = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ requestId: 'req-1', status: 'pending', queuePos: 0 }, 201);
        }
        if (url.endsWith('/stream')) {
          streamRequested();
          return Promise.resolve((globalThis as unknown as { __sseResponse: Response }).__sseResponse);
        }
        if (url.endsWith('/input') && init.method === 'POST') {
          inputBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ accepted: true });
        }
        return jsonResponse({}, 404);
      })
    );

    const chatPromise = chatViaTunnel({
      instanceId: INSTANCE,
      providerId: 'openai-codex-agent',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await streamRequestedP;

    const inputRes = await postInput('req-1', { type: 'tool_approval', approved: true });
    expect(inputRes).toEqual({ ok: true, data: { accepted: true } });

    const shared = DESKTOP.sharedKeyFor(String(captured.ephPub));
    expect(typeof (inputBody as unknown as Record<string, unknown>).envelope).toBe('string');
    const opened = openTunnelFrame(
      shared,
      decodeTunnelEnvelope(String((inputBody as unknown as Record<string, unknown>).envelope))!
    );
    expect(opened?.direction).toBe(TUNNEL_DIRECTION_REQUEST);
    expect(opened?.counter).toBe(1); // the request envelope used counter 0
    expect(JSON.parse(decoder.decode(opened?.plaintext))).toEqual({ v: 1, type: 'tool_approval', approved: true });

    // Settle the chat so the session tears down cleanly.
    const doneFrame = DESKTOP.sealOutFrame(String(captured.ephPub), { v: 1, type: 'done', text: 'bye' });
    sse.push(`data: ${doneFrame}\n\n`);
    sse.close();
    const chatRes = await chatPromise;
    expect(chatRes.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared cross-implementation vectors (plan §5.1): sealed by the desktop's Rust test and
// opened here byte-for-byte (and vice versa). Skips cleanly while the file is absent.
// ---------------------------------------------------------------------------

const VECTORS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/contracts/e2e-envelope-vectors.json'
);
const vectorsExist = existsSync(VECTORS_PATH);

describe.skipIf(!vectorsExist)('docs/contracts/e2e-envelope-vectors.json', () => {
  it('seals and opens every shared vector byte-for-byte', () => {
    const raw = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Record<string, unknown>;
    const keyPair = (side: string) => {
      const obj = raw[side] as Record<string, unknown>;
      return {
        publicKey: base64ToBytes(String(obj.publicKey)),
        secretKey: base64ToBytes(String(obj.secretKey)),
      };
    };
    const browser = keyPair('browser');
    const desktop = keyPair('desktop');
    // Shared key derived independently on both "sides" (X25519 symmetry).
    const sharedBrowserSide = deriveTunnelSharedKey(desktop.publicKey, browser.secretKey);
    const sharedDesktopSide = deriveTunnelSharedKey(browser.publicKey, desktop.secretKey);

    const entries = raw.vectors as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const name = String(entry.name ?? 'unnamed');
      const direction = Number(entry.direction);
      const counter = Number(entry.counter);
      const nonce = base64ToBytes(String(entry.nonce));
      const plaintext = encoder.encode(String(entry.plaintext));
      const expectedCt = base64ToBytes(String(entry.ciphertext));

      // The directional-nonce scheme itself is part of the contract.
      expect(bytesToBase64(buildTunnelNonce(direction, counter)), `nonce mismatch on ${name}`).toBe(String(entry.nonce));

      // Seal with the browser-side derivation must reproduce the vector ciphertext exactly.
      const sealed = nacl.box.after(plaintext, nonce, sharedBrowserSide);
      expect(bytesToBase64(sealed), `seal mismatch on ${name}`).toBe(String(entry.ciphertext));

      // Open with the desktop-side derivation must return the exact plaintext.
      const opened = nacl.box.open.after(expectedCt, nonce, sharedDesktopSide);
      expect(opened === null, `open failed on ${name}`).toBe(false);
      expect(decoder.decode(opened as Uint8Array), `plaintext mismatch on ${name}`).toBe(String(entry.plaintext));
    }
  });
});
