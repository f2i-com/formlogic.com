import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  getOaiyToken,
  isOaiyPaired,
  listOaiyPlugins,
  mapOaiyErrorCode,
  oaiyConnectorRequest,
  oaiyRouteAvailable,
  probeOaiy,
  setOaiyToken,
  subscribeOaiyPaired,
  unwrapConnectorEnvelope,
  __resetOaiyDetectionForTests,
} from './oaiyRuntime';

const BASE = 'http://127.0.0.1:19999';

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

const healthy = { status: 'ok', product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: '0.1.0' };

beforeEach(() => {
  __setOaiyBaseUrlForTests(BASE);
  setOaiyToken(null);
  // Detection is module-level cache; isolate each test from the last.
  __resetOaiyDetectionForTests();
});
afterEach(() => {
  __resetOaiyBaseUrlForTests();
  setOaiyToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeOaiy — the identity handshake', () => {
  it('recognises the real product + protocol', async () => {
    mockFetch(() => ({ status: 200, body: healthy }));
    const info = await probeOaiy(true);
    expect(info.available).toBe(true);
    expect(info.product).toBe('oaiy-desktop');
  });

  it('rejects a squatter answering /api/health with the wrong product', async () => {
    mockFetch(() => ({ status: 200, body: { ...healthy, product: 'someone-else' } }));
    expect((await probeOaiy(true)).available).toBe(false);
  });

  it('rejects a foreign protocol major', async () => {
    mockFetch(() => ({ status: 200, body: { ...healthy, protocol: 'oaiy-bridge/2' } }));
    expect((await probeOaiy(true)).available).toBe(false);
  });

  it('accepts a compatible minor', async () => {
    mockFetch(() => ({ status: 200, body: { ...healthy, protocol: 'oaiy-bridge/1.4' } }));
    expect((await probeOaiy(true)).available).toBe(true);
  });

  it('treats an unreachable OAIY as not available, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('ECONNREFUSED'); }));
    await expect(probeOaiy(true)).resolves.toMatchObject({ available: false });
  });
});

describe('oaiyRouteAvailable — gated on detection AND a token', () => {
  it('is false when detected but unpaired (no token)', async () => {
    mockFetch(() => ({ status: 200, body: healthy }));
    await probeOaiy(true);
    expect(oaiyRouteAvailable()).toBe(false);
  });

  it('is true when detected AND a token is held', async () => {
    mockFetch(() => ({ status: 200, body: healthy }));
    await probeOaiy(true);
    setOaiyToken('t');
    expect(oaiyRouteAvailable()).toBe(true);
  });

  it('is false when a token is held but OAIY is absent', () => {
    setOaiyToken('t');
    // No successful probe cached.
    expect(oaiyRouteAvailable()).toBe(false);
  });
});

describe('oaiyConnectorRequest — forwarding + result shape', () => {
  it('unwraps the plugin envelope { ok, result:{ ok, data } } to the inner data', async () => {
    // OAIY passes the plugin's raw connector-response envelope through as
    // `result`; the adapter unwraps `.data` so a FormLogic flow reads the same
    // shape it would from FormLogic Desktop.
    const { calls } = mockFetch(() => ({
      status: 200,
      body: { ok: true, result: { ok: true, data: { paired: false } } },
    }));
    setOaiyToken('tok');
    const res = await oaiyConnectorRequest('aokie', 'phone.status', { x: 1 });
    expect(res).toEqual({ ok: true, data: { paired: false } });
    // Body carried the command + payload; the bearer went on the request.
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.command).toBe('phone.status');
    expect(sent.payload).toEqual({ x: 1 });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0]!.url).toContain('/api/bridge/connectors/aokie/request');
  });

  it('passes a journalled idempotencyKey through', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true, result: null } }));
    await oaiyConnectorRequest('aokie', 'sms.send', { to: 'x' }, { idempotencyKey: 'op-1' });
    expect(JSON.parse(String(calls[0]!.init.body)).idempotencyKey).toBe('op-1');
  });

  it('maps a 403 capability_denied to a real per-command refusal', async () => {
    mockFetch(() => ({ status: 403, body: { error: { code: 'capability_denied', message: 'not declared' } } }));
    const res = await oaiyConnectorRequest('aokie', 'call.teleport');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('capability_denied');
      expect(res.transportFailure).toBeUndefined();
    }
  });

  it('maps a 403-for-auth to auth_required (a pairing problem)', async () => {
    mockFetch(() => ({ status: 403, body: { error: { code: 'invalid_request', message: 'origin not allowed' } } }));
    const res = await oaiyConnectorRequest('aokie', 'phone.status');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth_required');
  });

  it('maps a 503 capability_unavailable to connector_unavailable', async () => {
    mockFetch(() => ({ status: 503, body: { error: { code: 'capability_unavailable', message: 'start it' } } }));
    const res = await oaiyConnectorRequest('aokie', 'call.answer');
    if (!res.ok) expect(res.error.code).toBe('connector_unavailable');
    else throw new Error('expected failure');
  });

  it('marks a transport failure so the caller can fall back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await oaiyConnectorRequest('aokie', 'phone.status');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.transportFailure).toBe(true);
      expect(res.error.code).toBe('connector_unavailable');
    }
  });
});

describe('unwrapConnectorEnvelope', () => {
  it('unwraps a { ok:true, data } envelope', () => {
    expect(unwrapConnectorEnvelope({ ok: true, data: { paired: false } })).toEqual({ paired: false });
  });
  it('passes a bare value through', () => {
    expect(unwrapConnectorEnvelope({ paired: false })).toEqual({ paired: false });
    expect(unwrapConnectorEnvelope(null)).toBeNull();
    expect(unwrapConnectorEnvelope('text')).toBe('text');
  });
});

describe('mapOaiyErrorCode', () => {
  it('routes each OAIY code to the right desktop-error code', () => {
    expect(mapOaiyErrorCode('capability_denied', 403)).toBe('capability_denied');
    expect(mapOaiyErrorCode('invalid_request', 403)).toBe('auth_required');
    expect(mapOaiyErrorCode('anything', 401)).toBe('auth_required');
    expect(mapOaiyErrorCode('capability_unavailable')).toBe('connector_unavailable');
    expect(mapOaiyErrorCode('runtime_unavailable')).toBe('connector_unavailable');
    expect(mapOaiyErrorCode('node_failed')).toBe('command_failed');
    expect(mapOaiyErrorCode('timeout')).toBe('command_failed');
  });
});

describe('token storage', () => {
  it('round-trips and clears a token', () => {
    expect(getOaiyToken()).toBeNull();
    setOaiyToken('abc');
    expect(getOaiyToken()).toBe('abc');
    setOaiyToken(null);
    expect(getOaiyToken()).toBeNull();
  });
});

describe('paired-state notifications', () => {
  it('isOaiyPaired tracks the token', () => {
    expect(isOaiyPaired()).toBe(false);
    setOaiyToken('t');
    expect(isOaiyPaired()).toBe(true);
  });

  it('subscribeOaiyPaired fires on store and clear, and stops after unsubscribe', () => {
    const seen: boolean[] = [];
    const unsub = subscribeOaiyPaired((p) => seen.push(p));
    setOaiyToken('t'); // → true
    setOaiyToken(null); // → false
    unsub();
    setOaiyToken('t2'); // no longer observed
    expect(seen).toEqual([true, false]);
  });
});

describe('listOaiyPlugins', () => {
  it('maps records to the shared summary, taking name/version from the manifest and dropping dir', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        plugins: [
          {
            id: 'aokie',
            state: 'running',
            dir: 'C:/Users/secret/plugins/aokie',
            manifest: { name: 'Aokie Phone', version: '1.2.0' },
          },
          { id: 'bare', state: 'crashed', reason: 'exited 1' },
        ],
      },
    }));
    setOaiyToken('tok');
    const rows = await listOaiyPlugins();
    expect(rows).toEqual([
      { id: 'aokie', name: 'Aokie Phone', version: '1.2.0', state: 'running', detail: undefined },
      { id: 'bare', name: undefined, version: undefined, state: 'crashed', detail: 'exited 1' },
    ]);
    // No absolute path (OS username) leaks into the summary.
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('carries the bearer and returns null when unauthorized', async () => {
    const { calls } = mockFetch(() => ({ status: 401, body: { error: {} } }));
    setOaiyToken('tok');
    expect(await listOaiyPlugins()).toBeNull();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns null on a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await listOaiyPlugins()).toBeNull();
  });
});
