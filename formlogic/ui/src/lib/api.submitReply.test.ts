// @vitest-environment jsdom
// A submission answered 2xx with a body that is not JSON was not answered by FormLogic: on a
// plain-HTTP install a captive portal (hotel or café Wi-Fi sign-in) answers every request with its
// own page. Such a reply must never count as a stored submission, or the answers are dropped.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

const portal = () => new Response('<!doctype html><title>Sign in to the Wi-Fi</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
const stored = () => new Response(JSON.stringify({ response: { id: 'r1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });

describe('a submit answered 2xx with a page that is not JSON', () => {
  it('is not delivered to the app (the offline queue keeps it, as unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(portal()));
    const result = await api.createAppResponseResult('shop', 'orders', { answers: { item: 'tea' }, idempotencyKey: 'k1' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('is not accepted for a private form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(portal()));
    const result = await api.submitEncryptedResponse('f1', { v: 1 } as never, 'k1');
    expect(result.ok).toBe(false);
  });

  it('is an error a plain form can tell apart from a failed connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(portal()));
    const result = await api.submitResponse('f1', { answers: { q: 'a' }, idempotencyKey: 'k1' });
    expect(result.error).toBeTruthy();
    expect(result.unreadable).toBe(true);
  });
});

describe('a submit FormLogic stored', () => {
  it('is still delivered, accepted and returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => stored()));
    expect((await api.createAppResponseResult('shop', 'orders', { answers: {}, idempotencyKey: 'k1' })).ok).toBe(true);
    expect((await api.submitEncryptedResponse('f1', { v: 1 } as never, 'k1')).ok).toBe(true);
    const plain = await api.submitResponse('f1', { answers: {}, idempotencyKey: 'k1' });
    expect(plain.error).toBeUndefined();
    expect(plain.data?.response).toEqual({ id: 'r1' });
  });
});
