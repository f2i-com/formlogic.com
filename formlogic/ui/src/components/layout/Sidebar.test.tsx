// @vitest-environment jsdom
// The app-first sidebar (App Studio redesign): the user's apps are the primary
// navigation — published/draft state shown per app, owner clicks land in the
// App Studio, member clicks open the live runtime, and the shared building
// blocks (Forms/Automations/Diagrams/Templates/Recycle bin) live under Advanced tools.
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

  it('keeps the shared building blocks under Advanced tools', async () => {
    await renderSidebar();
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Advanced tools'))!;
    await act(async () => { toggle.click(); });
    for (const label of ['Forms', 'Automations', 'Diagrams', 'Templates', 'Recycle bin']) {
      expect(container.textContent).toContain(label);
    }
  });

  it('auto-expands Advanced tools when already on a tool route', async () => {
    await renderSidebar('/flows');
    expect(container.textContent).toContain('Diagrams');
  });
});
