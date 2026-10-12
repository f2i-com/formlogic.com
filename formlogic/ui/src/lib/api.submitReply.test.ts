// @vitest-environment jsdom
// A submission answered 2xx with a body that is not JSON was not answered by FormLogic: on a
// plain-HTTP install a captive portal (hotel or café Wi-Fi sign-in) answers every request with its
// own page. Such a reply must never count as a stored submission, or the answers are dropped.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { classifyDeliveryResult } from '../client-runtime/offlineQueue';

afterEach(() => vi.unstubAllGlobals());

const portal = () => new Response('<!doctype html><title>Sign in to the Wi-Fi</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
const stored = () => new Response(JSON.stringify({ response: { id: 'r1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });

describe('a submit answered 2xx with a page that is not JSON', () => {
  // Passed on as the 2xx it was, with no stored record in it: the offline queue keeps the
  // submission and counts an attempt (status 0, "not reached", kept one waiting for ever behind a
  // page that never changes).
  it('is not delivered to the app (the offline queue keeps it, as an unrecognised answer)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(portal()));
    const result = await api.createAppResponseResult('shop', 'orders', { answers: { item: 'tea' }, idempotencyKey: 'k1' });
    expect(result.status).toBe(200);
    expect(result.response).toBeUndefined();
    expect(classifyDeliveryResult(result).outcome).toBe('unrecognised');
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
    const app = await api.createAppResponseResult('shop', 'orders', { answers: {}, idempotencyKey: 'k1' });
    expect(classifyDeliveryResult(app).outcome).toBe('delivered');
    expect((await api.submitEncryptedResponse('f1', { v: 1 } as never, 'k1')).ok).toBe(true);
    const plain = await api.submitResponse('f1', { answers: {}, idempotencyKey: 'k1' });
    expect(plain.error).toBeUndefined();
    expect(plain.data?.response).toEqual({ id: 'r1' });
  });
});
