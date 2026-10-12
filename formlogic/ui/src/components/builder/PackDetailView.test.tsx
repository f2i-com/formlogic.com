// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { PackDetailView } from './PackDetailView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

type PackDetail = NonNullable<Awaited<ReturnType<typeof api.getPackDetail>>['data']>['pack'];

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
