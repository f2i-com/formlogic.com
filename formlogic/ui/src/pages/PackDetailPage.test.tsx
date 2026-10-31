// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { useInstalledNodeStore } from '../stores/installedNodeStore';
import { useToastStore } from '../stores/toastStore';
import PackDetailPage from './PackDetailPage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const realRefresh = useInstalledNodeStore.getState().refresh;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useInstalledNodeStore.setState({ refresh: realRefresh });
  useAuthStore.setState({ user: null });
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks();
});

type PackDetail = NonNullable<Awaited<ReturnType<typeof api.getPackDetail>>['data']>['pack'];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PackDetailPage v2 extension install', () => {
  const buttonNamed = (name: string) => Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);

  async function openReview() {
    vi.spyOn(api, 'getPackDetail').mockResolvedValue({
      data: {
        pack: {
          id: 'cat-1', slug: 'ext', name: 'Ext', description: null, icon: null, screenshot: null, screenshots: [],
          tags: [], category: null, visibility: 'public', status: 'published', downloadCount: 0, avgRating: 0,
          ratingCount: 0, featured: false, publisherId: 'p', publisherName: null, latestVersion: '1.0.0',
          formCount: 0, appCount: 0, createdAt: '2026-01-10 00:00:00', updatedAt: '2026-01-10 00:00:00', versions: [],
        } as PackDetail,
      },
    } as Awaited<ReturnType<typeof api.getPackDetail>>);
    vi.spyOn(api, 'getPackRatings').mockResolvedValue({ data: { ratings: [], userRating: null } } as never);
    vi.spyOn(api, 'getInstalledPacks').mockResolvedValue({ data: { installations: [] } } as never);
    vi.spyOn(api, 'getDemoApps').mockResolvedValue({ data: { apps: [] } } as never);
    vi.spyOn(api, 'downloadPack').mockResolvedValue({ data: { pack: { formatVersion: 2, package: { id: 'acme.ext' } }, catalogId: 'cat-1', versionId: 'v1' } } as never);
    vi.spyOn(api, 'proposePackageInstallPlan').mockResolvedValue({
      data: {
        planId: 'plan-1', planDigest: 'digest-1', expiresInSeconds: 600, trust: 'community', action: 'install',
        capabilities: { forms: 0, apps: 0, hasScreens: false, hasCustomLogic: false, logicScripts: 0, connectors: [], permissions: [] },
        resolution: { ok: true, resolved: [], missingOptional: [], problems: [] },
      },
    } as never);
    const refresh = vi.fn(async () => undefined);
    useInstalledNodeStore.setState({ refresh });
    useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com' } as never });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <MemoryRouter initialEntries={['/packs/ext']}>
          <Routes><Route path="/packs/:slug" element={<PackDetailPage />} /></Routes>
        </MemoryRouter>,
      );
    });
    await act(settle);
    await act(settle);
    await act(async () => buttonNamed('Install pack')!.click());
    return { refresh };
  }

  it('refreshes the flow nodes and words the toast for an extension', async () => {
    const { refresh } = await openReview();
    vi.spyOn(api, 'confirmPackageInstallPlan').mockResolvedValue({ data: { forms: [], apps: [] } } as never);

    await act(async () => buttonNamed('Install')!.click());
    await act(settle);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ title: 'Extension installed' })]);
  });

  it('closes the review when a confirm fails, since the plan cannot be used again', async () => {
    await openReview();
    vi.spyOn(api, 'confirmPackageInstallPlan').mockResolvedValue({ error: 'dependency missing' } as never);

    await act(async () => buttonNamed('Install')!.click());
    await act(settle);

    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ message: 'dependency missing' })]);
    expect(host!.textContent).not.toContain('Review what this package can do');
  });
});

describe('PackDetailPage version history', () => {
  it('dates a version by the UTC instant the server stored, from its offset-less datetime', async () => {
    // The catalog sends pack_versions.created_at as MySQL stores it. Pinned to a zone where
    // 20:00 UTC is already the next day, so reading it as local time shows the wrong date.
    const zone = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    try {
      vi.spyOn(api, 'getPackDetail').mockResolvedValue({
        data: {
          pack: {
            id: 'cat-1', slug: 'crm', name: 'CRM', description: null, icon: null, screenshot: null, screenshots: [],
            tags: [], category: null, visibility: 'public', status: 'published', downloadCount: 0, avgRating: 0,
            ratingCount: 0, featured: false, publisherId: 'p', publisherName: null, latestVersion: '1.0.0',
            formCount: 1, appCount: 0, createdAt: '2026-01-10 00:00:00', updatedAt: '2026-01-10 00:00:00',
            versions: [{ id: 'v1', version: '1.0.0', changelog: null, form_count: 1, app_count: 0, created_at: '2026-07-01 20:00:00' }],
          } as PackDetail,
        },
      } as Awaited<ReturnType<typeof api.getPackDetail>>);
      vi.spyOn(api, 'getPackRatings').mockResolvedValue({ data: { ratings: [], userRating: null } } as unknown as Awaited<ReturnType<typeof api.getPackRatings>>);
      vi.spyOn(api, 'getInstalledPacks').mockResolvedValue({ data: { installations: [] } } as unknown as Awaited<ReturnType<typeof api.getInstalledPacks>>);
      vi.spyOn(api, 'getDemoApps').mockResolvedValue({ data: { apps: [] } } as unknown as Awaited<ReturnType<typeof api.getDemoApps>>);
      window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });

      host = document.createElement('div');
      document.body.appendChild(host);
      await act(async () => {
        root = createRoot(host!);
        root.render(
          <MemoryRouter initialEntries={['/packs/crm']}>
            <Routes><Route path="/packs/:slug" element={<PackDetailPage />} /></Routes>
          </MemoryRouter>,
        );
      });
      await act(settle);
      await act(settle);
      const toggle = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Version history'));
      expect(toggle).toBeTruthy();
      await act(async () => { toggle!.click(); });

      const date = new Date(Date.UTC(2026, 6, 1, 20)).toLocaleDateString();
      const line = Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.includes('1 forms, 0 apps'));
      expect(line?.textContent?.split(' ·')[0]).toBe(date);
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });
});
