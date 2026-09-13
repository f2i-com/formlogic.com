import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
afterEach(() => vi.unstubAllGlobals());
it.each([403, 500, 503])('rejects a non-report error response (%s)', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Unavailable' }), { status })));
  expect(await api.getDeepHealth()).toBeNull();
});
it('preserves a valid degraded report returned with HTTP 503', async () => {
  const report = { status: 'degraded', checks: { database: { ok: false, critical: true, detail: 'Database unavailable' } } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(report), { status: 503 })));
  expect(await api.getDeepHealth()).toEqual(report);
});
it('rejects malformed checks rather than passing them to the renderer', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok', checks: { database: null } }))));
  expect(await api.getDeepHealth()).toBeNull();
});
