// Tests for the desktop flow-run relay client (plan §5.7 — Phase 5).
//
// Covers: the sealed request body ({v:1, flowId, inputs} with a per-run ephemeral key),
// the queued(pos) → running → done/failed/uncertain state machine against a mocked
// backend (progress frames over SSE, the sealed resultEnvelope resolved from the status
// read), typed enqueue refusals (queue_full_user / desktop_offline), honest `uncertain`
// on transport failure, replay protection, and TOFU key-rotation refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nacl from 'tweetnacl';
import {
  __resetDesktopTunnelForTests,
  base64ToBytes,
  buildTunnelNonce,
  bytesToBase64,
  encodeTunnelEnvelope,
  openTunnelFrame,
  trustDesktopE2eKey,
  TUNNEL_DIRECTION_RESPONSE,
} from './desktopTunnel';
import { runFlowOnDesktop, type DesktopFlowRunProgress, type DesktopFlowRunState } from './desktopFlowRun';

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

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
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
    reset(): void {
      counter = -1;
      seq = 0;
    },
    sharedKeyFor(ephPubB64: string): Uint8Array {
      return nacl.box.before(base64ToBytes(ephPubB64), keyPair.secretKey);
    },
    sealFrame(ephPubB64: string, frame: Record<string, unknown>, explicitCounter?: number): string {
      counter = explicitCounter ?? counter + 1;
      const nonce = buildTunnelNonce(TUNNEL_DIRECTION_RESPONSE, counter);
      const ct = nacl.box.after(encoder.encode(JSON.stringify(frame)), nonce, this.sharedKeyFor(ephPubB64));
      return encodeTunnelEnvelope({ nonce: bytesToBase64(nonce), ct: bytesToBase64(ct) });
    },
    /** One SSE data line: {seq, envelope} exactly like the backend relays it. */
    sealStreamEvent(ephPubB64: string, frame: Record<string, unknown>, explicitCounter?: number): string {
      seq += 1;
      return sseData(JSON.stringify({ seq, envelope: this.sealFrame(ephPubB64, frame, explicitCounter) }));
    },
  };
}

const DESKTOP = makeFakeDesktop();
const INSTANCE = 'desktop-test-1';

interface MockBackend {
  fetchMock: ReturnType<typeof vi.fn>;
  capturedEnqueue: () => Record<string, unknown>;
}

interface MockBackendOptions {
  enqueueStatus?: number;
  enqueueBody?: unknown;
  /** Events played on the SSE stream; gets the browser's ephemeral pubkey. */
  streamEvents?: (ephPubB64: string) => string[];
  /** Status-read body (under {data:{…}}); gets the fake desktop for sealing a result. */
  statusBody?: (desktop: ReturnType<typeof makeFakeDesktop>, ephPubB64: string) => unknown;
  /** When true, the stream fetch rejects (transport failure). */
  streamRejects?: boolean;
}

/** Wire a fetch mock that plays the backend relay: pubkey → enqueue → SSE stream → status. */
function mockFlowBackend(
  desktop: ReturnType<typeof makeFakeDesktop>,
  opts: MockBackendOptions = {}
): MockBackend {
  let captured: Record<string, unknown> = {};
  const fetchMock = setFetch(
    vi.fn((...args: unknown[]) => {
      const url = String(args[0]);
      const init = (args[1] ?? {}) as RequestInit;
      if (url.includes('/api/desktop/ai/pubkey')) {
        return jsonResponse({ instanceId: INSTANCE, publicKey: desktop.publicKeyB64, deviceName: 'Test Box' });
      }
      if (url.endsWith('/api/desktop/flows/run') && init.method === 'POST') {
        captured = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (opts.enqueueBody !== undefined || opts.enqueueStatus) {
          return jsonResponse(opts.enqueueBody ?? { error: true, code: 'queue_full_user', message: 'full' }, opts.enqueueStatus ?? 429);
        }
        return jsonResponse({ data: { requestId: 'req-1', status: 'pending', queuePos: 2 } }, 201);
      }
      if (url.includes('/stream')) {
        if (opts.streamRejects) return Promise.reject(new TypeError('Failed to fetch'));
        desktop.reset();
        return sseResponse(opts.streamEvents ? opts.streamEvents(String(captured.ephPub)) : []);
      }
      if (url.includes('/api/desktop/flows/runs/')) {
        const body = opts.statusBody
          ? opts.statusBody(desktop, String(captured.ephPub))
          : { status: 'claimed' };
        return jsonResponse({ data: body });
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
  DESKTOP.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { document?: unknown }).document;
  __resetDesktopTunnelForTests();
});

// ---------------------------------------------------------------------------
// The sealed request.
// ---------------------------------------------------------------------------

describe('runFlowOnDesktop — request sealing', () => {
  it('seals {v:1, flowId, inputs} with a per-run ephemeral key and posts the routing plaintext', async () => {
    const backend = mockFlowBackend(DESKTOP, {
      streamEvents: (eph) => [DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_result', result: { ok: 1 } })],
    });
    const res = await runFlowOnDesktop('flow-9', { inputs: { from: '+61400000000' } });
    expect(res.ok).toBe(true);

    const body = backend.capturedEnqueue();
    expect(body.flowId).toBe('flow-9');
    expect(body.targetInstanceId).toBe(INSTANCE);
    expect(typeof body.idempotencyKey).toBe('string');
    expect(base64ToBytes(String(body.ephPub)).length).toBe(32);

    // The backend only relays opaque bytes; the fake desktop opens them with ITS shared key.
    const envBytes = base64ToBytes(String(body.envelope));
    const sealed = { nonce: bytesToBase64(envBytes.subarray(0, 24)), ct: bytesToBase64(envBytes.subarray(24)) };
    const opened = openTunnelFrame(DESKTOP.sharedKeyFor(String(body.ephPub)), sealed);
    expect(opened).not.toBeNull();
    expect(opened!.direction).toBe(0x00); // browser → desktop
    expect(opened!.counter).toBe(0);
    expect(JSON.parse(decoder.decode(opened!.plaintext))).toEqual({
      v: 1,
      flowId: 'flow-9',
      inputs: { from: '+61400000000' },
      clientSeq: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// The state machine: queued(pos) → running → done, progress frames, sealed result.
// ---------------------------------------------------------------------------

describe('runFlowOnDesktop — states, progress, result', () => {
  it('walks queued → running → done, forwards flow_progress frames, and opens the resultEnvelope', async () => {
    const states: DesktopFlowRunState[] = [];
    const progress: DesktopFlowRunProgress[] = [];
    mockFlowBackend(DESKTOP, {
      streamEvents: (eph) => [
        DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_progress', nodeId: 'list-1', status: 'running' }),
        DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_progress', nodeId: 'list-1', status: 'done' }),
      ],
      statusBody: (desktop, eph) => ({
        status: 'done',
        resultEnvelope: desktop.sealFrame(eph, { v: 1, type: 'flow_result', result: { rows: 3 } }),
      }),
    });
    const res = await runFlowOnDesktop('flow-1', {
      onState: (s) => states.push(s),
      onProgress: (p) => progress.push(p),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.status).toBe('done');
      expect(res.data.result).toEqual({ rows: 3 });
    }
    expect(states[0]).toEqual({ state: 'queued', position: 2 });
    expect(states.filter((s) => s.state === 'running').length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]).toEqual({ state: 'done' });
    expect(progress).toEqual([
      { nodeId: 'list-1', status: 'running' },
      { nodeId: 'list-1', status: 'done' },
    ]);
  });

  it('resolves a sealed flow_result frame straight off the stream (no status read needed)', async () => {
    const backend = mockFlowBackend(DESKTOP, {
      streamEvents: (eph) => [DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_result', result: { emailed: true } })],
    });
    const res = await runFlowOnDesktop('flow-2');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.result).toEqual({ emailed: true });
    const statusReads = backend.fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/desktop/flows/runs/') && !String(c[0]).includes('/stream'));
    expect(statusReads.length).toBe(0);
  });

  it('maps an unsealed status lifecycle event, then reads the sealed result', async () => {
    mockFlowBackend(DESKTOP, {
      streamEvents: () => [sseData(JSON.stringify({ status: 'pending', queuePos: 1 }))],
      statusBody: (desktop, eph) => ({
        status: 'done',
        resultEnvelope: desktop.sealFrame(eph, { v: 1, type: 'flow_result', result: 'finished' }),
      }),
    });
    const states: DesktopFlowRunState[] = [];
    const res = await runFlowOnDesktop('flow-3', { onState: (s) => states.push(s) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.result).toBe('finished');
    expect(states).toContainEqual({ state: 'queued', position: 1 });
  });

  it('a desktop-reported failure resolves failed with its typed code', async () => {
    mockFlowBackend(DESKTOP, {
      streamEvents: (eph) => [DESKTOP.sealStreamEvent(eph, { v: 1, type: 'failed', code: 'node_failed', message: 'logic block threw' })],
    });
    const res = await runFlowOnDesktop('flow-4');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('node_failed');
      expect(res.error.message).toBe('logic block threw');
    }
  });

  it('a failed status read after a clean stream end resolves failed(code)', async () => {
    mockFlowBackend(DESKTOP, {
      streamEvents: () => [],
      statusBody: () => ({ status: 'failed', code: 'node_failed', message: 'boom' }),
    });
    const res = await runFlowOnDesktop('flow-5');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('node_failed');
  });

  it('an expired queue entry resolves failed(expired)', async () => {
    mockFlowBackend(DESKTOP, {
      streamEvents: () => [],
      statusBody: () => ({ status: 'expired' }),
    });
    const res = await runFlowOnDesktop('flow-6');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// Enqueue failures + honesty.
// ---------------------------------------------------------------------------

describe('runFlowOnDesktop — enqueue failures and honesty', () => {
  it('a typed queue_full_user refusal resolves failed(queue_full_user)', async () => {
    mockFlowBackend(DESKTOP, { enqueueStatus: 429, enqueueBody: { error: true, code: 'queue_full_user', message: 'Too many queued runs' } });
    const states: DesktopFlowRunState[] = [];
    const res = await runFlowOnDesktop('flow-7', { onState: (s) => states.push(s) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('queue_full_user');
      expect(res.error.message).toBe('Too many queued runs');
    }
    expect(states[states.length - 1]).toMatchObject({ state: 'failed', code: 'queue_full_user' });
  });

  it('a typed desktop_offline refusal resolves failed(desktop_offline)', async () => {
    mockFlowBackend(DESKTOP, { enqueueStatus: 409, enqueueBody: { error: true, code: 'desktop_offline', message: 'Desktop is offline' } });
    const res = await runFlowOnDesktop('flow-8');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('desktop_offline');
  });

  it('a transport failure at enqueue is honest `uncertain` (the run may have landed)', async () => {
    mockFlowBackend(DESKTOP, { enqueueStatus: 0, enqueueBody: null });
    // status 0 = requestWithMeta's network-error path (res.status falsy)
    const res = await runFlowOnDesktop('flow-10');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('uncertain');
  });

  it('a dead stream with an unreadable status resolves `uncertain`', async () => {
    mockFlowBackend(DESKTOP, {
      streamRejects: true,
    });
    const res = await runFlowOnDesktop('flow-11');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('uncertain');
  });
});

// ---------------------------------------------------------------------------
// Crypto honesty: replay protection + TOFU rotation.
// ---------------------------------------------------------------------------

describe('runFlowOnDesktop — crypto honesty', () => {
  it('a replayed frame counter fails closed with sealed_envelope_invalid', async () => {
    mockFlowBackend(DESKTOP, {
      streamEvents: (eph) => [
        DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_progress', nodeId: 'a', status: 'running' }),
        // Same counter as the previous frame — the desktop would never send this.
        DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_progress', nodeId: 'b', status: 'running' }, 0),
      ],
    });
    const res = await runFlowOnDesktop('flow-12');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('sealed_envelope_invalid');
  });

  it('a rotated desktop key is never trusted silently (e2e_key_rotated)', async () => {
    // Pre-pin a DIFFERENT key for the instance than the one the backend now serves.
    trustDesktopE2eKey(INSTANCE, bytesToBase64(fixedBytes(32, 9)), 'Test Box');
    mockFlowBackend(DESKTOP, {});
    const res = await runFlowOnDesktop('flow-13');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('e2e_key_rotated');
      expect(res.error.rotation?.instanceId).toBe(INSTANCE);
      expect(res.error.rotation?.pinnedFingerprint).not.toBe(res.error.rotation?.presentedFingerprint);
    }
  });

  it('a first-trust key is pinned and notified', async () => {
    mockFlowBackend(DESKTOP, {
      streamEvents: (eph) => [DESKTOP.sealStreamEvent(eph, { v: 1, type: 'flow_result', result: null })],
    });
    const trusts: Array<{ firstTrust: boolean }> = [];
    const res = await runFlowOnDesktop('flow-14', { onTrustEstablished: (_pin, firstTrust) => trusts.push({ firstTrust }) });
    expect(res.ok).toBe(true);
    expect(trusts).toEqual([{ firstTrust: true }]);
  });
});
