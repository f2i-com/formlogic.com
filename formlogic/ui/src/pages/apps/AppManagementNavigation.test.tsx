// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppsDashboard } from './AppsDashboard';
import { AppSettings } from './AppSettings';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { DEFAULT_APP_SETTINGS, DEFAULT_APP_THEME } from '../../types/app';
import type { App, AppRole } from '../../types/app';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const fixtures = vi.hoisted(() => ({
  apps: [] as unknown[],
  roles: [] as unknown[],
  forms: [] as unknown[],
}));

vi.mock('../../lib/api', () => ({
  api: {
    getApps: vi.fn(async () => ({ data: { apps: fixtures.apps, count: fixtures.apps.length } })),
    getInstalledPacks: vi.fn(async () => ({ data: { installations: [] } })),
    getAppRoles: vi.fn(async () => ({ data: { roles: fixtures.roles } })),
    getAppForms: vi.fn(async () => ({ data: { forms: fixtures.forms } })),
    isAdminActing: () => false,
    isDemoMode: () => false,
    isAuthenticated: () => true,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const routeRef = { current: '' };

function RouteProbe() {
  const location = useLocation();
  React.useEffect(() => {
    routeRef.current = `${location.pathname}${location.search}`;
  });
  return null;
}

const app: App = {
  id: 'app-1',
  name: 'Plumbing Operations',
  slug: 'plumbing',
  ownerId: 'u1',
  canManage: true,
  description: 'Jobs, customers and invoices.',
  status: 'published',
  settings: { ...DEFAULT_APP_SETTINGS },
  theme: { ...DEFAULT_APP_THEME },
  navConfig: [],
  formCount: 2,
  createdAt: '2026-07-24 00:00:00',
  updatedAt: '2026-07-24 00:00:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('appsDashboard.viewMode', 'grid');
  fixtures.apps = [app];
  fixtures.forms = [
    { id: 'af-1', appId: app.id, formId: 'f-1', displayName: 'Jobs', sortOrder: 0, isVisible: true, settings: {} },
    { id: 'af-2', appId: app.id, formId: 'f-2', displayName: 'Customers', sortOrder: 1, isVisible: true, settings: {} },
  ];
  fixtures.roles = [
    { id: 'r-1', appId: app.id, name: 'Owner', isSystem: true, sortOrder: 0 },
    { id: 'r-2', appId: app.id, name: 'Member', isSystem: true, sortOrder: 1 },
  ] as AppRole[];
  routeRef.current = '';
  useAppStore.setState({ apps: [], error: null, isLoading: false, _loadingCount: 0 });
  useAuthStore.setState({ user: { id: 'demo', email: 'demo@example.com', name: 'Demo', isDemo: true } as unknown as AuthUser });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({ apps: [], error: null });
  useAuthStore.setState({ user: null });
  localStorage.removeItem('appsDashboard.viewMode');
});

async function renderAt(initialEntry: string, element: React.ReactNode) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <RouteProbe />
        <Routes>
          <Route path="/apps/:appId/settings" element={element} />
          <Route path="*" element={element} />
        </Routes>
      </MemoryRouter>
    );
    await Promise.resolve();
  });
}

describe('app management navigation', () => {
  it('shows a cog action on app cards and opens the Manage app tab', async () => {
    await renderAt('/apps', <AppsDashboard />);
    const manage = container.querySelector<HTMLButtonElement>('button[aria-label="Manage Plumbing Operations"]');
    expect(manage).not.toBeNull();

    await act(async () => { manage!.click(); });
    expect(routeRef.current).toBe('/apps/app-1/settings?tab=manage');
  });

  it('organizes the Manage page and links back to the App Studio', async () => {
    await renderAt('/apps/app-1/settings?tab=manage', <AppSettings />);

    for (const heading of ['Content & data', 'People & access', 'Experience & delivery', 'Tools & portability']) {
      expect(container.textContent).toContain(heading);
    }
    expect(container.textContent).toContain('Manage Plumbing Operations');
    expect(container.textContent).toContain('2');

    const studio = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Open App Studio'))!;
    await act(async () => { studio.click(); });
    expect(routeRef.current).toBe('/apps/app-1/studio');
  });
});
