// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [{ 'X-Backup-Restore-Limit': '209715200' }, 209715200],
  [{}, null],
])('says when a downloaded backup is past what can be uploaded back', async (headers, limit) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('zip', { headers })));
  URL.createObjectURL = vi.fn(() => 'blob:backup');
  URL.revokeObjectURL = vi.fn();

  await expect(api.exportAccountBackup()).resolves.toBe(limit);
});
