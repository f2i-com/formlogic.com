// @vitest-environment jsdom
// The app-first sidebar (App Studio redesign): the user's apps are the primary
// navigation — published/draft state shown per app, owner clicks land in the
// App Studio, member clicks open the live runtime, and Forms/Automations stay
// visible while Diagrams/Templates/Recycle bin live under More tools.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import type { AppListItem } from '../../types/app';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

// The sidebar refreshes the apps list on mount, so the fixture apps flow
// through the mocked list endpoint (not preset store state, which the
// refresh would replace).
const h = vi.hoisted(() => ({ apps: [] as unknown[] }));

vi.mock('../../lib/api', () => ({
  api: {
    getApps: vi.fn(async () => ({ data: { apps: h.apps, count: h.apps.length } })),
    // appStore's persist storage (adminFrozenStorage) consults this on every write.
    isAdminActing: () => false,
    isDemoMode: () => false,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const pathRef = { current: '/' };

function PathProbe() {
  const location = useLocation();
  React.useEffect(() => {
    pathRef.current = location.pathname;
  });
  return null;
}

const makeApp = (overrides: Partial<AppListItem>): AppListItem =>
  ({
    id: 'app-1',
    name: 'Plumbing Operations',
    slug: 'plumbing-ops',
    ownerId: 'u1',
    status: 'published',
    settings: {},
    theme: {},
    navConfig: [],
    createdAt: '2026-07-23 00:00:00',
    updatedAt: '2026-07-23 00:00:00',
    canManage: true,
    ...overrides,
  }) as AppListItem;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.apps = [];
  pathRef.current = '/';
  useAuthStore.setState({ user: { id: 'u1', email: 'o@example.com', name: 'Owner' } as unknown as AuthUser });
  useAppStore.setState({ apps: [], activeAppId: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({ apps: [], activeAppId: null });
  useAuthStore.setState({ user: null });
});

async function renderSidebar(initialPath = '/') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <PathProbe />
        <Routes>
          <Route path="*" element={<Sidebar />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

describe('Sidebar (app-first)', () => {
  it('lists the user apps with their publish state', async () => {
    h.apps = [
      makeApp({ id: 'a1', name: 'Plumbing Operations', status: 'published', publishedVersion: 3 }),
      makeApp({ id: 'a2', name: 'Customer Portal', slug: 'portal', status: 'draft' }),
    ];
    await renderSidebar();
    expect(container.textContent).toContain('Apps');
    expect(container.textContent).toContain('Plumbing Operations');
    // One vocabulary for app state everywhere (lib/appStatus): 'Live v3', not one
    // of the five spellings the section used to carry.
    expect(container.textContent).toContain('Live v3');
    expect(container.textContent).toContain('Customer Portal');
    expect(container.textContent).toContain('Draft');
  });

  it('archived apps stay out of the primary nav', async () => {
    h.apps = [makeApp({ id: 'a1', name: 'Old Thing', status: 'archived' })];
    await renderSidebar();
    expect(container.textContent).not.toContain('Old Thing');
  });

  it('an owner click opens the App Studio; a member click opens the runtime', async () => {
    h.apps = [
      makeApp({ id: 'own', name: 'Mine', canManage: true }),
      makeApp({ id: 'member', name: 'Theirs', slug: 'theirs', canManage: false }),
    ];
    await renderSidebar();
    const buttons = Array.from(container.querySelectorAll('button'));
    const mine = buttons.find((b) => b.textContent?.includes('Mine'))!;
    await act(async () => { mine.click(); });
    expect(pathRef.current).toBe('/apps/own/studio');

    const theirs = buttons.find((b) => b.textContent?.includes('Theirs'))!;
    await act(async () => { theirs.click(); });
    expect(pathRef.current).toBe('/app/theirs');
  });

  it('search filters the app list', async () => {
    h.apps = [makeApp({ id: 'a1', name: 'Plumbing' }), makeApp({ id: 'a2', name: 'Portal', slug: 'portal' })];
    await renderSidebar();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'plumb');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Plumbing');
    expect(container.textContent).not.toContain('Portal');
  });

  it('collapses the app list, persists the preference, and links to the apps page', async () => {
    h.apps = [makeApp({ id: 'a1', name: 'Plumbing' })];
    await renderSidebar();
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Apps'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Plumbing');
    expect(localStorage.getItem('formlogic.sidebar.appsOpen')).toBe('0');

    const viewAll = container.querySelector<HTMLAnchorElement>('a[aria-label="View all apps"]')!;
    await act(async () => { viewAll.click(); });
    expect(pathRef.current).toBe('/apps');
  });

  it('keeps Forms and Automations visible while More tools can be expanded', async () => {
    await renderSidebar('/flows');
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('More tools'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('a[href="/forms"]')?.textContent).toContain('Forms');
    expect(container.querySelector('a[href="/flows"]')?.textContent).toContain('Automations');
    expect(container.querySelector('a[href="/flows"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('a[href="/diagrams"]')).toBeNull();

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    for (const [path, label] of [['/diagrams', 'Diagrams'], ['/packs', 'Templates'], ['/trash', 'Recycle bin']]) {
      expect(container.querySelector(`a[href="${path}"]`)?.textContent).toContain(label);
    }
  });

  // With eleven apps the list pushed More tools (Templates, the Recycle bin) below the fold.
  describe('with many apps', () => {
    const many = () => Array.from({ length: 11 }, (_, index) => makeApp({ id: `a${index + 1}`, name: `App number ${index + 1}`, slug: `app-${index + 1}` }));
    const listed = () => Array.from(container.querySelectorAll('button')).map((b) => /App number (\d+)/.exec(b.textContent ?? '')?.[1]).filter(Boolean);
    const moreButton = () => Array.from(container.querySelectorAll('button')).find((b) => /^Show (\d+ more apps?|fewer apps)$/.test(b.textContent?.trim() ?? ''));

    it('lists the first six, and the rest after "Show 5 more apps"', async () => {
      h.apps = many();
      await renderSidebar();
      expect(listed()).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(moreButton()?.textContent).toBe('Show 5 more apps');
      expect(moreButton()?.getAttribute('aria-expanded')).toBe('false');

      await act(async () => { moreButton()!.click(); });
      expect(listed()).toHaveLength(11);
      expect(moreButton()?.textContent).toBe('Show fewer apps');

      await act(async () => { moreButton()!.click(); });
      expect(listed()).toHaveLength(6);
    });

    it('keeps the open app in the short list', async () => {
      h.apps = many();
      await renderSidebar('/apps/a9/studio');
      expect(listed()).toEqual(['1', '2', '3', '4', '5', '9']);
      expect(container.querySelector('button[aria-current="page"]')?.textContent).toContain('App number 9');
    });

    it('a search lists every match, however many', async () => {
      h.apps = many();
      await renderSidebar();
      const search = container.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(search, 'app number');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(listed()).toHaveLength(11);
      expect(moreButton()).toBeUndefined();
    });

    it('seven apps are simply listed: a row saying "1 more" would take the place of the app', async () => {
      h.apps = many().slice(0, 7);
      await renderSidebar();
      expect(listed()).toHaveLength(7);
      expect(moreButton()).toBeUndefined();
    });
  });

  it('auto-expands More tools when already on a tool route', async () => {
    await renderSidebar('/diagrams');
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('More tools'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('a[href="/diagrams"]')?.getAttribute('aria-current')).toBe('page');
  });
});
