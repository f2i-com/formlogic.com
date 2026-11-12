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
  summaries: {} as Record<string, unknown>,
}));

vi.mock('../../lib/api', () => ({
  api: {
    getApps: vi.fn(async () => ({ data: { apps: fixtures.apps, count: fixtures.apps.length } })),
    getAppsSummary: vi.fn(async () => ({ data: { apps: fixtures.summaries } })),
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
  fixtures.summaries = {};
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
  // The gear opens the app's own settings. It used to open `?tab=manage`, a grid of
  // nine links — so the only per-app control on the card opened a directory.
  it('shows a cog action on app cards and opens App settings', async () => {
    await renderAt('/apps', <AppsDashboard />);
    const manage = container.querySelector<HTMLButtonElement>('button[aria-label="Manage Plumbing Operations"]');
    expect(manage).not.toBeNull();

    await act(async () => { manage!.click(); });
    expect(routeRef.current).toBe('/apps/app-1/settings');
  });

  // A SoftN app's settings are a section of its own page: the forms-era page knows nothing of it.
  it('opens a SoftN app\'s own settings from its card', async () => {
    fixtures.apps = [{ ...app, settings: { ...app.settings, softnApp: true } }];
    await renderAt('/apps', <AppsDashboard />);
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Manage Plumbing Operations"]')!.click(); });
    expect(routeRef.current).toBe('/apps/app-1/softn/settings');
  });

  describe('the table', () => {
    const softn: App = { ...app, id: 'app-2', name: 'Booking Desk', slug: 'booking-desk', publishedVersion: 1, settings: { ...app.settings, softnApp: true }, updatedAt: '2026-07-25 00:00:00' };
    const draft: App = { ...app, id: 'app-3', name: 'Tide Chart', slug: 'tide-chart', status: 'draft', settings: { ...app.settings, softnApp: true }, updatedAt: '2026-07-23 00:00:00' };
    const rows = () => [...container.querySelectorAll('tbody tr')].map(row => row.textContent ?? '');
    const press = async (name: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!.click(); });
    beforeEach(() => {
      localStorage.removeItem('appsDashboard.viewMode');
      fixtures.apps = [softn, app, draft];
      fixtures.summaries = {
        'app-2': { softn: true, installed: true, version: 7, access: 'members', backend: true, tables: 14, bytes: 3145728, domain: 'booking.example.com', members: 128 },
        'app-3': { softn: true, installed: true, version: 1, access: 'application', backend: false, tables: null, bytes: null, domain: null, members: 0 },
      };
    });

    it('is what the page opens with, and shows every app on one screen', async () => {
      await renderAt('/apps', <AppsDashboard />);
      await act(async () => {});
      expect(rows()).toHaveLength(3);
      expect(container.textContent).not.toContain('Show more');
      // The installed version, where the app's own row would say v1 for ever.
      expect(rows()[0]).toContain('Booking Desk');
      expect(rows()[0]).toContain('Live v7');
      expect(rows()[0]).toContain('booking.example.com');
      expect(rows()[0]).toContain('Members · 128');
      expect(rows()[0]).toContain('14 tables · 3.0 MB');
      expect(rows()[1]).toContain('2 forms');
      expect(rows()[2]).toContain('Draft');
      expect(rows()[2]).toContain('Anyone');
      expect(rows()[2]).toContain('In each browser');
      expect(container.textContent).toContain('3 apps · 2 live · 1 not live');
    });

    it('leads from a row to the app\'s page, its data and its settings', async () => {
      await renderAt('/apps', <AppsDashboard />);
      await act(async () => {});
      const hrefs = (label: string) => container.querySelector(`a[aria-label="${label}"]`)?.getAttribute('href');
      expect([...container.querySelectorAll('tbody th a')].map(a => a.getAttribute('href'))).toEqual(['/apps/app-2/softn', '/apps/app-1/studio', '/apps/app-3/softn']);
      expect(hrefs('Data of Booking Desk')).toBe('/apps/app-2/softn/data');
      expect(hrefs('Settings of Booking Desk')).toBe('/apps/app-2/softn/settings');
      expect(hrefs('Settings of Plumbing Operations')).toBe('/apps/app-1/settings');
      // An app that keeps its data in each browser has no data to open here.
      expect(hrefs('Data of Tide Chart')).toBeUndefined();
      expect(hrefs('Open Booking Desk')).toBe('https://booking.example.com');
    });

    it('filters by kind and status, and finds an app by its own domain', async () => {
      await renderAt('/apps', <AppsDashboard />);
      await act(async () => {});
      await press('Forms');
      expect(rows().map(row => row.includes('Plumbing Operations'))).toEqual([true]);
      await press('All kinds');
      await press('Draft');
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toContain('Tide Chart');
      await press('Any status');
      const search = container.querySelector<HTMLInputElement>('input[aria-label="Search apps by name, address or template"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'booking.example');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toContain('Booking Desk');
    });

    it('sorts by a heading, and says so to a screen reader', async () => {
      await renderAt('/apps', <AppsDashboard />);
      await act(async () => {});
      const heading = () => [...container.querySelectorAll('thead th')].find(th => th.textContent?.trim() === 'App')!;
      const names = () => [...container.querySelectorAll('tbody th a')].map(a => a.textContent);
      // As the server gave them: most recently changed first.
      expect(names()).toEqual(['Booking Desk', 'Plumbing Operations', 'Tide Chart']);
      await act(async () => { heading().querySelector('button')!.click(); });
      expect(heading().getAttribute('aria-sort')).toBe('ascending');
      expect(names()).toEqual(['Booking Desk', 'Plumbing Operations', 'Tide Chart']);
      await act(async () => { heading().querySelector('button')!.click(); });
      expect(heading().getAttribute('aria-sort')).toBe('descending');
      expect(names()).toEqual(['Tide Chart', 'Plumbing Operations', 'Booking Desk']);
      // A third press returns to the server's order.
      await act(async () => { heading().querySelector('button')!.click(); });
      expect(heading().getAttribute('aria-sort')).toBeNull();
    });

    it('says what deleting a SoftN app does to its data', async () => {
      await renderAt('/apps', <AppsDashboard />);
      await act(async () => {});
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Remove Booking Desk"]')!.click(); });
      expect(document.body.textContent).toContain('moves to the recycle bin with its database and members');
      expect(document.body.textContent).not.toContain('Its forms and their records stay');
    });
  });

  it('organizes the Manage page and links back to the App Studio', async () => {
    await renderAt('/apps/app-1/settings?tab=manage', <AppSettings />);

    for (const heading of ['Content & data', 'Experience & delivery', 'Tools & portability']) {
      expect(container.textContent).toContain(heading);
    }
    expect(container.textContent).toContain('Plumbing Operations');
    // The sections are links in a row, each at its own address, and the open one says so.
    const sections = Array.from(container.querySelectorAll('nav[aria-label="App settings sections"] a'));
    expect(sections.map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['General', '/apps/app-1/settings', null],
      ['Appearance', '/apps/app-1/settings?tab=theme', null],
      ['Navigation', '/apps/app-1/settings?tab=menu', null],
      ['Access', '/apps/app-1/settings?tab=access', null],
      ['Manage', '/apps/app-1/settings?tab=manage', 'page'],
    ]);
    expect(container.querySelector('[role="tab"]')).toBeNull();
    // How many forms the app holds, on the row that opens them.
    const forms = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.startsWith('Forms'))!;
    expect(forms.textContent).toContain('2');

    const studio = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'App Studio')!;
    await act(async () => { studio.click(); });
    expect(routeRef.current).toBe('/apps/app-1/studio');
  });

  it('moves between sections by their links and keeps what was typed', async () => {
    await renderAt('/apps/app-1/settings', <AppSettings />);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    const name = () => container.querySelector<HTMLInputElement>('#app-name');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name()!, 'Plumbing Ops');
      name()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const link = (label: string) => Array.from(container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="App settings sections"] a')).find(a => a.textContent === label)!;
    await act(async () => { link('Navigation').click(); });
    expect(routeRef.current).toBe('/apps/app-1/settings?tab=menu');
    expect(link('Navigation').getAttribute('aria-current')).toBe('page');
    expect(container.textContent).toContain('Starting screen');
    expect(name()).toBeNull();
    expect(container.textContent).toContain('You have unsaved changes');
    await act(async () => { link('General').click(); });
    expect(routeRef.current).toBe('/apps/app-1/settings');
    expect(name()!.value).toBe('Plumbing Ops');
  });

  // The runtime applies the accent and the font. theme.backgroundColor reaches only the web app
  // manifest's background_color, so it is offered for what it does, and not previewed behind the app.
  it('says what the background color does, and does not preview it as the app\'s', async () => {
    fixtures.apps = [{ ...app, theme: { ...app.theme, backgroundColor: '#112233' } }];
    await renderAt('/apps/app-1/settings?tab=theme', <AppSettings />);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

    expect(container.querySelector('input[aria-label="Accent color picker"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Splash color hex value"]')?.value).toBe('#112233');
    expect(container.textContent).toContain('Installed app splash color');
    expect(container.textContent).not.toContain('Background color');
    expect(container.innerHTML).not.toContain('rgb(17, 34, 51)');
  });
});
