import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { getApps: vi.fn(), getAppForms: vi.fn() } }));
vi.mock('./uiCache', () => ({ loadUiCache: vi.fn(() => null), saveUiCache: vi.fn() }));

import { api } from './api';
import { fetchAppGroups } from './appGroups';

const app = (id: string, more: Record<string, unknown> = {}) => ({ id, name: `App ${id}`, slug: id, ...more });
const answerForms = (byApp: Record<string, string[]>) => vi.mocked(api.getAppForms).mockImplementation(
  (async (appId: string) => ({ data: { forms: (byApp[appId] ?? []).map((formId) => ({ formId })) } })) as unknown as typeof api.getAppForms,
);

describe('the apps that hold forms', () => {
  beforeEach(() => { vi.mocked(api.getApps).mockReset(); vi.mocked(api.getAppForms).mockReset(); });

  it('leaves out a SoftN app that holds no form, and never asks one for its forms', async () => {
    vi.mocked(api.getApps).mockResolvedValue({ data: { apps: [
      app('softn', { settings: { softnApp: true }, formCount: 0 }),
      app('forms', { formCount: 2 }),
    ] } } as unknown as Awaited<ReturnType<typeof api.getApps>>);
    answerForms({ forms: ['f1', 'f2'] });

    const groups = await fetchAppGroups('user');

    expect(groups.map((group) => [group.id, group.formIds])).toEqual([['forms', ['f1', 'f2']]]);
    expect(vi.mocked(api.getAppForms).mock.calls.map(([id]) => id)).toEqual(['forms']);
  });

  it('keeps a forms app that is still empty, as somewhere to put forms, without asking for them', async () => {
    vi.mocked(api.getApps).mockResolvedValue({ data: { apps: [app('empty', { formCount: 0 })] } } as unknown as Awaited<ReturnType<typeof api.getApps>>);

    const groups = await fetchAppGroups('user');

    expect(groups.map((group) => [group.id, group.formIds])).toEqual([['empty', []]]);
    expect(api.getAppForms).not.toHaveBeenCalled();
  });

  it('lists a SoftN app that was given forms in its App Studio', async () => {
    vi.mocked(api.getApps).mockResolvedValue({ data: { apps: [app('softn', { settings: { softnApp: true }, formCount: 1 })] } } as unknown as Awaited<ReturnType<typeof api.getApps>>);
    answerForms({ softn: ['f9'] });

    expect((await fetchAppGroups('user')).map((group) => [group.id, group.formIds])).toEqual([['softn', ['f9']]]);
  });

  it('asks every app when the list does not say how many forms each holds (an older server)', async () => {
    vi.mocked(api.getApps).mockResolvedValue({ data: { apps: [app('a'), app('b')] } } as unknown as Awaited<ReturnType<typeof api.getApps>>);
    answerForms({ a: ['f1'] });

    const groups = await fetchAppGroups('user');

    expect(groups.map((group) => [group.id, group.formIds])).toEqual([['a', ['f1']], ['b', []]]);
    expect(vi.mocked(api.getAppForms).mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('refuses to answer from a failed read of the apps', async () => {
    vi.mocked(api.getApps).mockResolvedValue({ error: 'offline' } as unknown as Awaited<ReturnType<typeof api.getApps>>);
    await expect(fetchAppGroups('user')).rejects.toThrow('offline');
  });
});
