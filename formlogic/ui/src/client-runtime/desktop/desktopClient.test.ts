import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopClient } from './desktopClient';
import { clearDesktopToken, getDesktopToken, storeDesktopToken } from './desktopPairing';

// Desktop client error mapping: network failure → connector_unavailable (flagged as a
// transport failure), HTTP 401 → auth_required + the stored token is dropped, and a
// desktop-returned typed error envelope passes through untouched.

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
}

function setFetch(mock: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

afterEach(() => {
  clearDesktopToken();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('desktopClient.connectors.request', () => {
  it('POSTs the connector-request body with the bearer token and unwraps data', async () => {
    storeDesktopToken('tok_abc');
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true, data: { dongles: [] }, requestId: 'r1' })));

    const res = await desktopClient.connectors.request('aokie', 'dongle.list', { verbose: true });

    expect(res).toEqual({ ok: true, data: { dongles: [] }, requestId: 'r1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/connectors/aokie/request');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
    expect(JSON.parse(init.body as string)).toEqual({
      connectorId: 'aokie',
      command: 'dongle.list',
      payload: { verbose: true },
    });
  });

  it('maps a network failure to connector_unavailable with transportFailure', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const res = await desktopClient.connectors.request('aokie', 'phone.status');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('connector_unavailable');
      expect(res.transportFailure).toBe(true);
    }
  });

  it('maps HTTP 401 to auth_required and drops the stored pairing token', async () => {
    storeDesktopToken('tok_expired');
    setFetch(vi.fn(() => jsonResponse({ message: 'unauthorized' }, 401)));

    const res = await desktopClient.connectors.request('aokie', 'phone.status');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('auth_required');
      expect(res.transportFailure).toBeUndefined(); // a real desktop response, not transport
    }
    expect(getDesktopToken()).toBeNull();
  });

  it('passes a desktop-returned typed error envelope through verbatim (no transport flag)', async () => {
    storeDesktopToken('tok_abc');
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'capability_denied', message: 'not declared' } }, 403)));

    const res = await desktopClient.connectors.request('aokie', 'call.answer');

    expect(res).toEqual({ ok: false, error: { code: 'capability_denied', message: 'not declared' } });
  });
});

describe('desktopClient.plugins.list', () => {
  it('accepts both bare-array and wrapped list shapes', async () => {
    storeDesktopToken('tok_abc');
    setFetch(vi.fn(() => jsonResponse([{ id: 'aokie', state: 'running' }])));
    let res = await desktopClient.plugins.list();
    expect(res.ok && res.data).toEqual([{ id: 'aokie', state: 'running' }]);

    setFetch(vi.fn(() => jsonResponse({ plugins: [{ id: 'aokie', state: 'stopped' }] })));
    res = await desktopClient.plugins.list();
    expect(res.ok && res.data).toEqual([{ id: 'aokie', state: 'stopped' }]);
  });
});
