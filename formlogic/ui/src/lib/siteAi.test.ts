/**
 * Choosing Site AI in one click: the same full-replace PUT the Settings card makes, so the
 * person's other AI preferences survive it, and the readiness check sees the new source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), cache: vi.fn(), fresh: vi.fn() }));
vi.mock('./api', () => ({ api: { getAiPreferences: mocks.get, putAiPreferences: mocks.put } }));
vi.mock('./websiteAiRouting', () => ({ cacheAiPreferences: mocks.cache }));
vi.mock('../client-runtime/flows/aiDefault', () => ({ getAiPreferences: mocks.fresh }));

import { chooseSiteAi } from './siteAi';

const current = { aiSource: 'custom', desktopProviderId: 'desk', desktopModel: 'm', customProviderId: 'mine', chatToolMode: 'confirm', desktopReasoning: 'high' };

beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });

describe('chooseSiteAi', () => {
  it('switches the source to Site AI and keeps every other preference', async () => {
    mocks.get.mockResolvedValue({ data: current });
    mocks.put.mockImplementation(async (input) => ({ data: { ...input } }));
    expect(await chooseSiteAi()).toEqual({ ok: true });
    expect(mocks.put).toHaveBeenCalledWith({ ...current, aiSource: 'site' });
    expect(mocks.cache).toHaveBeenCalledWith({ ...current, aiSource: 'site' });
    expect(mocks.fresh).toHaveBeenCalledWith({ fresh: true });
  });

  it('changes nothing when the settings cannot be read, and says why a switch was refused', async () => {
    mocks.get.mockResolvedValue({ error: 'Network down' });
    expect(await chooseSiteAi()).toEqual({ ok: false, error: 'Network down' });
    expect(mocks.put).not.toHaveBeenCalled();

    mocks.get.mockResolvedValue({ data: current });
    mocks.put.mockResolvedValue({ error: 'Allowance', code: 'ai_allowance_exceeded' });
    expect(await chooseSiteAi()).toEqual({ ok: false, error: 'This month’s Site AI allowance is used up.' });
    expect(mocks.cache).not.toHaveBeenCalled();
  });
});
