import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalHttpConnector } from './localHttpConnector';

vi.mock('../appLocalAccess', () => ({
  appMayUseThisComputer: vi.fn(),
  assertAppMayUseThisComputer: vi.fn(),
}));

import { appMayUseThisComputer, assertAppMayUseThisComputer } from '../appLocalAccess';

describe('localHttpConnector local-access gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(appMayUseThisComputer).mockReset();
    vi.mocked(assertAppMayUseThisComputer).mockReset();
  });

  it('refuses status() without contacting localhost when local access is denied', async () => {
    vi.mocked(appMayUseThisComputer).mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const conn = createLocalHttpConnector('http://127.0.0.1:39291');
    const info = await conn.status();

    expect(info.available).toBe(false);
    expect(info.detail).toContain('not allowed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses request() without contacting localhost when assertAppMayUseThisComputer rejects', async () => {
    vi.mocked(assertAppMayUseThisComputer).mockRejectedValue(new Error('Local access denied'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const conn = createLocalHttpConnector('http://127.0.0.1:39291');
    await expect(conn.request('status.read')).rejects.toThrow('Local access denied');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
