import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNativeReadyForTests,
  __setReadyTimeoutForTests,
  classifyReadiness,
  getConnectorClient,
} from './nativeConnectorClient';

// Native manifest-readiness gate (contracts #3 per-app cache key + #4 timeout != denial).
//
// The connector client reads window.FormLogicNative + window.location at CALL time, so each test just
// swaps a mock bridge + location between requests — mirroring the native runtime replacing the page's
// bridge when it navigates between apps/domains without a full module reload.

// A unique sentinel the mock NATIVE bridge returns from connectors.request(), so a test can prove a
// result came from native (=== NATIVE) rather than the browser mock connector (telemetry w/ vehicleId).
const NATIVE = { __native: true } as const;

type ReadyFn = (() => Promise<{ verified: boolean }>) | (() => Promise<never>);

interface MockBridge {
  available: boolean;
  runtime: Record<string, unknown>;
  connectors: {
    list: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
}

function makeBridge(opts: {
  available?: boolean;
  /** null / omitted => runtime has NO ready() (older runtime); a function => runtime.ready(). */
  ready?: ReadyFn | null;
  requestResult?: unknown;
}): MockBridge {
  const runtime: Record<string, unknown> = { getInfo: vi.fn(), openExternal: vi.fn() };
  if (opts.ready) runtime.ready = vi.fn(opts.ready);
  return {
    available: opts.available ?? true,
    runtime,
    connectors: {
      list: vi.fn(async () => []),
      status: vi.fn(async () => ({ id: 'vehicle', kind: 'native', available: true, source: 'native' })),
      request: vi.fn(async () => (opts.requestResult === undefined ? NATIVE : opts.requestResult)),
      subscribe: vi.fn(() => () => {}),
    },
  };
}

function setWindow(bridge: MockBridge | null, pathname: string, origin = 'https://plat.example'): void {
  (globalThis as unknown as { window?: unknown }).window = {
    FormLogicNative: bridge ?? undefined,
    location: { origin, pathname },
  };
}

afterEach(() => {
  __resetNativeReadyForTests();
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure classifier (contract #4) — the four decision states, no bridge needed.
// ---------------------------------------------------------------------------
describe('classifyReadiness', () => {
  it('absent for an older runtime with no ready()', () => {
    expect(classifyReadiness(false, false, null)).toBe('absent');
    // Even a (spurious) timeout flag can never turn a no-ready runtime into a denial.
    expect(classifyReadiness(false, true, { verified: true })).toBe('absent');
  });

  it('pending on timeout — never a denial', () => {
    expect(classifyReadiness(true, true, null)).toBe('pending');
  });

  it('verified when ready() resolved verified:true', () => {
    expect(classifyReadiness(true, false, { verified: true })).toBe('verified');
  });

  it('denied when ready() resolved verified:false', () => {
    expect(classifyReadiness(true, false, { verified: false })).toBe('denied');
  });

  it('absent (best-effort) when ready() resolved a malformed/null result', () => {
    expect(classifyReadiness(true, false, null)).toBe('absent');
  });
});

// ---------------------------------------------------------------------------
// request() gate — end-to-end through the real client with a mock bridge.
// ---------------------------------------------------------------------------
describe('DefaultConnectorClient request() native-readiness gate', () => {
  it('verified:true => calls native', async () => {
    const bridge = makeBridge({ available: true, ready: async () => ({ verified: true }) });
    setWindow(bridge, '/app/appV');
    const client = getConnectorClient();

    const r = await client.request('vehicle', 'engineHours.read', { p: 1 });

    expect(r).toBe(NATIVE);
    expect(bridge.connectors.request).toHaveBeenCalledWith('vehicle', 'engineHours.read', { p: 1 });
  });

  it('verified:false => origin_denied with NO browser/mock fallback', async () => {
    // A failed verification flips available=false but leaves ready() callable (raw bridge).
    const bridge = makeBridge({ available: false, ready: async () => ({ verified: false }) });
    setWindow(bridge, '/app/appX');
    const client = getConnectorClient();

    // A fallback would RESOLVE to telemetry; a rejection proves the mock was never consulted.
    await expect(client.request('vehicle', 'status.read')).rejects.toHaveProperty('code', 'origin_denied');
    expect(bridge.connectors.request).not.toHaveBeenCalled();
  });

  it('ready() timeout => browser fallback, not a permanent origin_denied', async () => {
    __setReadyTimeoutForTests(20);
    const bridge = makeBridge({ available: true, ready: () => new Promise<never>(() => {}) });
    setWindow(bridge, '/app/appTimeout');
    const client = getConnectorClient();

    const r = await client.request('vehicle', 'status.read');

    expect(r).not.toBe(NATIVE); // served by the browser mock, not native
    expect(r).toHaveProperty('vehicleId');
    expect(bridge.connectors.request).not.toHaveBeenCalled();
  });

  it('older runtime without ready() => best-effort native (as before)', async () => {
    const bridge = makeBridge({ available: true, ready: null });
    setWindow(bridge, '/app/appOld');
    const client = getConnectorClient();

    const r = await client.request('vehicle', 'status.read');

    expect(r).toBe(NATIVE);
    expect(bridge.connectors.request).toHaveBeenCalledTimes(1);
  });

  it('App A verified does NOT mark App B verified (per-app cache key, no reset between)', async () => {
    const client = getConnectorClient();

    const bridgeA = makeBridge({ available: true, ready: async () => ({ verified: true }) });
    setWindow(bridgeA, '/app/appA');
    expect(await client.request('vehicle', 'status.read')).toBe(NATIVE);
    expect(bridgeA.connectors.request).toHaveBeenCalledTimes(1);

    // Navigate to App B (same session, no cache reset). B's own verification must be re-derived.
    const bridgeB = makeBridge({ available: false, ready: async () => ({ verified: false }) });
    setWindow(bridgeB, '/app/appB');
    await expect(client.request('vehicle', 'status.read')).rejects.toHaveProperty('code', 'origin_denied');
    expect(bridgeB.connectors.request).not.toHaveBeenCalled();
  });

  it('App A failed does NOT poison App B (per-app cache key, no reset between)', async () => {
    const client = getConnectorClient();

    const bridgeA = makeBridge({ available: false, ready: async () => ({ verified: false }) });
    setWindow(bridgeA, '/app/appA');
    await expect(client.request('vehicle', 'status.read')).rejects.toHaveProperty('code', 'origin_denied');

    // App B is legitimate — it must not inherit A's failure.
    const bridgeB = makeBridge({ available: true, ready: async () => ({ verified: true }) });
    setWindow(bridgeB, '/app/appB');
    expect(await client.request('vehicle', 'status.read')).toBe(NATIVE);
    expect(bridgeB.connectors.request).toHaveBeenCalledTimes(1);
  });

  it('distinguishes two apps served at different custom-domain origins', async () => {
    const client = getConnectorClient();

    // Custom domains serve one app at the root (no /app/ segment) — origin alone is the key.
    const bridgeA = makeBridge({ available: true, ready: async () => ({ verified: true }) });
    setWindow(bridgeA, '/', 'https://app-a.example');
    expect(await client.request('vehicle', 'status.read')).toBe(NATIVE);

    const bridgeB = makeBridge({ available: false, ready: async () => ({ verified: false }) });
    setWindow(bridgeB, '/', 'https://app-b.example');
    await expect(client.request('vehicle', 'status.read')).rejects.toHaveProperty('code', 'origin_denied');
  });
});

// ---------------------------------------------------------------------------
// status() gate — mirrors request()'s denial vs temporary-unavailable handling.
// ---------------------------------------------------------------------------
describe('DefaultConnectorClient status() native-readiness gate', () => {
  it('verified:false => origin_denied', async () => {
    const bridge = makeBridge({ available: false, ready: async () => ({ verified: false }) });
    setWindow(bridge, '/app/appX');
    const client = getConnectorClient();

    await expect(client.status('vehicle')).rejects.toHaveProperty('code', 'origin_denied');
  });

  it('ready() timeout => browser status (source mock), not origin_denied', async () => {
    __setReadyTimeoutForTests(20);
    const bridge = makeBridge({ available: true, ready: () => new Promise<never>(() => {}) });
    setWindow(bridge, '/app/appTimeout');
    const client = getConnectorClient();

    const s = await client.status('vehicle');

    expect(s.source).toBe('mock');
    expect(bridge.connectors.status).not.toHaveBeenCalled();
  });
});
