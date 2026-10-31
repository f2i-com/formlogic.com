// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useInstalledNodeStore } from '../../stores/installedNodeStore';
import { useToastStore } from '../../stores/toastStore';
import { PackDetailView } from './PackDetailView';

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
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks();
});

type PackDetail = NonNullable<Awaited<ReturnType<typeof api.getPackDetail>>['data']>['pack'];

describe('PackDetailView v2 extension install', () => {
  const grants = ['connector.crm.read', 'connector.crm.write'];
  const aggregate = { formatVersion: 2, package: { id: 'acme.ext', displayName: 'Ext', version: '1.0.0' } };
  const buttonNamed = (name: string) => Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes(name))!;

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
    vi.spyOn(api, 'downloadPack').mockResolvedValue({ data: { pack: aggregate, catalogId: 'cat-1', versionId: 'v1' } } as never);
    const propose = vi.spyOn(api, 'proposePackageInstallPlan').mockResolvedValue({
      data: {
        planId: 'plan-1', planDigest: 'digest-1', expiresInSeconds: 600, trust: 'community', action: 'install',
        capabilities: {
          forms: 0, apps: 0, hasScreens: false, hasCustomLogic: false, logicScripts: 0,
          connectors: ['crm'], permissions: grants, connectorGrants: grants,
          packageV2: { id: 'acme.ext', displayName: 'Ext', version: '1.0.0', kind: 'extension', nodes: [{ type: 'ext.node', label: 'Ext node' }], requirementSlots: [] },
        },
        resolution: { ok: true, resolved: [], missingOptional: [], problems: [] },
      },
    } as never);
    const refresh = vi.fn(async () => undefined);
    useInstalledNodeStore.setState({ refresh });
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<PackDetailView slug="ext" onBack={() => {}} />);
    });
    await act(async () => buttonNamed('Install Pack').click());
    return { propose, refresh };
  }

  it('proposes the aggregate under `package`, as the server reads it', async () => {
    const { propose } = await openReview();
    expect(propose).toHaveBeenCalledWith({ package: aggregate });
  });

  it('reviews the connector grants and confirms only the ones left ticked', async () => {
    await openReview();
    const confirm = vi.spyOn(api, 'confirmPackageInstallPlan').mockResolvedValue({ data: { forms: [], apps: [], withheldGrants: [grants[1]] } } as never);
    const boxes = Array.from(host!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.checked)).toBe(true);

    await act(async () => boxes[1].click());
    await act(async () => buttonNamed('Install extension').click());

    expect(confirm).toHaveBeenCalledWith('plan-1', { planDigest: 'digest-1', approvedConnectorGrants: [grants[0]] });
  });

  it('brings the new nodes into the store and says what happened', async () => {
    const { refresh } = await openReview();
    vi.spyOn(api, 'confirmPackageInstallPlan').mockResolvedValue({ data: { forms: [], apps: [] } } as never);

    await act(async () => buttonNamed('Install extension').click());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ title: 'Extension installed' })]);
  });
});

describe('PackDetailView version history', () => {
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

      host = document.createElement('div');
      document.body.appendChild(host);
      await act(async () => {
        root = createRoot(host!);
        root.render(<PackDetailView slug="crm" onBack={() => {}} />);
      });
      const toggle = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Version History'));
      expect(toggle).toBeTruthy();
      await act(async () => { toggle!.click(); });

      const row = Array.from(host.querySelectorAll('div')).find((d) => d.firstElementChild?.textContent === 'v1.0.0');
      expect(row?.children[1]?.textContent).toBe(new Date(Date.UTC(2026, 6, 1, 20)).toLocaleDateString());
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });
});
