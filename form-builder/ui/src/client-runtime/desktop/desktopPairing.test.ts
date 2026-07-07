import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDesktopToken,
  desktopAuthHeaders,
  getDesktopToken,
  isDesktopPaired,
  pollPairing,
  requestPairing,
  storeDesktopToken,
} from './desktopPairing';
import { __resetDesktopBaseUrlForTests, __setDesktopBaseUrlForTests } from './desktopTypes';

// Pairing: token storage is namespaced per desktop instance (base URL), attach helper
// produces the Authorization header, and the poll loop resolves approved/denied/timeout.

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
}

afterEach(() => {
  clearDesktopToken();
  __setDesktopBaseUrlForTests('http://127.0.0.1:29999');
  clearDesktopToken(); // both namespaces
  __resetDesktopBaseUrlForTests();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('pairing token storage', () => {
  it('stores, reads and clears the token', () => {
    expect(getDesktopToken()).toBeNull();
    expect(isDesktopPaired()).toBe(false);

    storeDesktopToken('tok_abc');
    expect(getDesktopToken()).toBe('tok_abc');
    expect(isDesktopPaired()).toBe(true);

    clearDesktopToken();
    expect(getDesktopToken()).toBeNull();
  });

  it('namespaces the token per desktop instance (base URL)', () => {
    storeDesktopToken('tok_default');

    __setDesktopBaseUrlForTests('http://127.0.0.1:29999');
    expect(getDesktopToken()).toBeNull(); // other instance — no leak
    storeDesktopToken('tok_other');
    expect(getDesktopToken()).toBe('tok_other');

    __resetDesktopBaseUrlForTests();
    expect(getDesktopToken()).toBe('tok_default'); // original instance untouched
  });

  it('desktopAuthHeaders attaches Authorization: Bearer only when paired', () => {
    expect(desktopAuthHeaders()).toEqual({});
    storeDesktopToken('tok_abc');
    expect(desktopAuthHeaders()).toEqual({ Authorization: 'Bearer tok_abc' });
  });
});

describe('requestPairing', () => {
  it('POSTs the origin and resolves the requestId', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ requestId: 'req_1' }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const id = await requestPairing('https://app.example');

    expect(id).toBe('req_1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17872/api/desktop/pairing-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ origin: 'https://app.example' });
  });

  it('resolves null (never throws) when Desktop is unreachable', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(requestPairing('https://app.example')).resolves.toBeNull();
  });
});

describe('pollPairing', () => {
  it('polls until approved and stores the origin-bound token', async () => {
    const polls = [{ status: 'pending' }, { status: 'pending' }, { status: 'approved', token: 'tok_paired' }];
    let i = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => jsonResponse(polls[Math.min(i++, polls.length - 1)]));

    const result = await pollPairing('req_1', { intervalMs: 1, timeoutMs: 1000 });

    expect(result).toEqual({ status: 'approved' });
    expect(getDesktopToken()).toBe('tok_paired');
  });

  it('resolves denied without storing anything', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => jsonResponse({ status: 'denied' }));

    const result = await pollPairing('req_1', { intervalMs: 1, timeoutMs: 1000 });

    expect(result).toEqual({ status: 'denied' });
    expect(getDesktopToken()).toBeNull();
  });

  it('times out while the request stays pending', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => jsonResponse({ status: 'pending' }));

    const result = await pollPairing('req_1', { intervalMs: 2, timeoutMs: 10 });

    expect(result).toEqual({ status: 'timeout' });
    expect(getDesktopToken()).toBeNull();
  });

  it('keeps polling through transient network failures until the deadline', async () => {
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error('flaky')) : jsonResponse({ status: 'approved', token: 'tok_late' });
    });

    const result = await pollPairing('req_1', { intervalMs: 1, timeoutMs: 1000 });

    expect(result).toEqual({ status: 'approved' });
    expect(getDesktopToken()).toBe('tok_late');
  });
});
