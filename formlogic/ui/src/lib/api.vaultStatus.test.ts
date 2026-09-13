import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
afterEach(() => vi.unstubAllGlobals());
it.each([
  [200, { data: { vault: null } }],
  [404, { code: 'vault_not_found', message: 'No vault exists' }],
])('treats an absent vault as a normal empty state (%s)', async (status, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
  expect(await api.getVault()).toEqual({ data: { vault: null } });
});
it('keeps a genuinely missing API route visible as an error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Route not found' }), { status: 404 })));
  expect(await api.getVault()).toEqual({ error: 'Route not found', status: 404 });
});
