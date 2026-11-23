// @vitest-environment jsdom
// The app-first sidebar (App Studio redesign): the user's apps are the primary
// navigation — published/draft state shown per app, owner clicks land in the
// App Studio, member clicks open the live runtime, and Forms/Automations stay
// visible while Diagrams/Templates/Recycle bin live under More tools.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { AppNavigationProvider } from './AppNavigationContext';
import { AppManagementHeader, useAppNavigationGuard, useAppSectionSidebar } from './useAppSectionSidebar';
import { AppManagementPages } from './AppManagementPages';
import { softnNavigationItems, type AppSectionItem } from './softnNavigation';
import { useHostedWorkspaceNavigation } from './useFormsWorkspaceNavigation';
import { useAppStore } from '../../stores/appStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { DEFAULT_APP_SETTINGS, type AppListItem, type AppSummary } from '../../types/app';
import { api } from '../../lib/api';
import { bumpSessionGeneration } from '../../lib/sessionGeneration';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

// The sidebar refreshes the apps list on mount, so the fixture apps flow
// through the mocked list endpoint (not preset store state, which the
// refresh would replace).
const h = vi.hoisted(() => ({ apps: [] as unknown[], summaries: {} as Record<string, Partial<AppSummary>> }));

vi.mock('../../lib/api', () => ({
  api: {
    getApps: vi.fn(async () => ({ data: { apps: h.apps, count: h.apps.length } })),
    getAppsSummary: vi.fn(async () => ({ data: { apps: h.summaries } })),
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
  bumpSessionGeneration();
  localStorage.clear();
  h.apps = [];
  h.summaries = {};
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

function RegisteredPage({ app, items, leave }: { app: AppListItem; items: AppSectionItem[]; leave: (to: string) => void }) {
  useAppSectionSidebar(app, items, leave);
  return null;
}

function EditingApp({ app }: { app: AppListItem }) {
  const navigate = useNavigate();
  const items = useHostedWorkspaceNavigation(app.id, { isOwner: true, managesMembers: true, hasForms: true, backend: true, liveBackend: false }, true);
  useAppSectionSidebar(app, items, navigate);
  return null;
}

function ManagementHeaderWithGuard({ leave }: { leave: (to: string) => void }) {
  useAppNavigationGuard(leave);
  return React.useContext(AppManagementHeader);
}

async function renderSidebar(initialPath = '/', page?: React.ReactNode, managementPage = page) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <AppNavigationProvider>
          <PathProbe />
          <Sidebar />
          <Routes>
            <Route path="/apps/:appId/web/*" element={page ?? null} />
            <Route element={<AppManagementPages />}>
              <Route path="/apps/:appId/settings" element={managementPage ?? null} />
              <Route path="/apps/:appId/roles" element={managementPage ?? null} />
            </Route>
            <Route path="*" element={<></>} />
          </Routes>
        </AppNavigationProvider>
      </MemoryRouter>
    );
  });
}

describe('Sidebar (app-first)', () => {
  it('opens a forms management deep link with the owner’s app menu and honors its discard guard on both surfaces', async () => {
    h.apps = [makeApp({ id: 'forms', name: 'Workshop' })];
    const leave = vi.fn();
    await renderSidebar('/apps/forms/settings', <ManagementHeaderWithGuard leave={leave} />);
    const [rail, picker] = container.querySelectorAll<HTMLElement>('nav[aria-label="App sections"]');
    expect(rail.querySelector('[aria-current="page"]')?.textContent).toBe('Settings');
    expect(container.querySelector('nav[aria-label="Current app location"]')?.textContent).toBe('WorkshopSettings');
    await act(async () => rail.querySelector<HTMLAnchorElement>('a[href="/apps/forms/studio/access"]')!.click());
    const toggle = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Sections')!;
    await act(async () => toggle.click());
    expect(picker.hidden).toBe(false);
    await act(async () => picker.querySelector<HTMLAnchorElement>('a[href="/apps/forms/studio/access"]')!.click());
    expect(leave.mock.calls).toEqual([['/apps/forms/studio/access'], ['/apps/forms/studio/access']]);
    expect(pathRef.current).toBe('/apps/forms/settings');
    expect(api.getAppsSummary).not.toHaveBeenCalled();
  });

  it.each([
    ['settings', 'Form settings', true],
    ['roles', 'Roles', false],
  ] as const)('restores a mixed app’s combined menu on a direct visit to %s', async (page, label, backend) => {
    const app = makeApp({ id: 'hybrid', formCount: 1, settings: { ...DEFAULT_APP_SETTINGS, softnApp: true } });
    h.apps = [app];
    h.summaries = { [app.id]: { installed: true, backend } };
    await renderSidebar(`/apps/${app.id}/${page}`, <ManagementHeaderWithGuard leave={vi.fn()} />);
    const expected = softnNavigationItems(app.id, { isOwner: true, managesMembers: true, hasForms: true, backend, liveBackend: backend });
    const menus = container.querySelectorAll('nav[aria-label="App sections"]');
    expect(menus).toHaveLength(2);
    for (const menu of menus) {
      expect([...menu.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])).toEqual(expected.map(item => [item.label, item.to]));
      expect(menu.querySelector('[aria-current="page"]')?.textContent).toBe(label);
    }
    expect(api.getAppsSummary).toHaveBeenCalledTimes(1);
  });

  it('keeps a direct hosted management visit scoped to projects without attached forms', async () => {
    const app = makeApp({ id: 'only-code', formCount: 0, settings: { ...DEFAULT_APP_SETTINGS, softnApp: true } });
    h.apps = [app];
    h.summaries = { [app.id]: { installed: true, backend: false } };
    await renderSidebar('/apps/only-code/settings', <ManagementHeaderWithGuard leave={vi.fn()} />);
    const rail = container.querySelector('nav[aria-label="App sections"]')!;
    expect(rail.querySelector('a[href="/apps/only-code/web/edit"]')).not.toBeNull();
    expect(rail.querySelector('a[href="/apps/only-code/studio/data"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Current app location"]')?.textContent).toContain('Settings');
  });

  it('retains the installed app tools when leaving a project that has a backend only in its draft', async () => {
    const app = makeApp({ id: 'mixed-draft', formCount: 1, settings: { ...DEFAULT_APP_SETTINGS, softnApp: true } });
    h.apps = [app];
    await renderSidebar('/apps/mixed-draft/web/edit', <EditingApp app={app} />, <></>);
    const rail = () => container.querySelector('nav[aria-label="App sections"]')!;
    expect(rail().querySelector('[aria-label="API"]')).not.toBeNull();
    await act(async () => rail().querySelector<HTMLAnchorElement>('a[aria-label="Form settings"]')!.click());
    expect(pathRef.current).toBe('/apps/mixed-draft/settings');
    expect(rail().querySelector('[aria-label="API"]')).toBeNull();
    expect(rail().querySelector('[aria-label="Edit"]')).not.toBeNull();
    expect(rail().querySelector('[aria-current="page"]')?.textContent).toBe('Form settings');
    expect(api.getAppsSummary).not.toHaveBeenCalled();
  });

  it('keeps known forms and the project editor reachable if the deployment summary fails', async () => {
    const app = makeApp({ id: 'legacy', formCount: 1, settings: { ...DEFAULT_APP_SETTINGS, softnApp: true } });
    h.apps = [app];
    vi.mocked(api.getAppsSummary).mockRejectedValueOnce(new Error('Offline'));
    await renderSidebar('/apps/legacy/settings');
    const menu = container.querySelector('nav[aria-label="App sections"]')!;
    expect(menu.querySelector('a[href="/apps/legacy/web/edit"]')).not.toBeNull();
    expect(menu.querySelector('a[href="/apps/legacy/studio/data"]')).not.toBeNull();
    expect(menu.querySelector('a[href="/apps/legacy/web/api"]')).toBeNull();
  });

  it('does not look up hosted capabilities or mount owner navigation on a direct member visit', async () => {
    h.apps = [makeApp({ id: 'member-app', canManage: false, formCount: 1, settings: { ...DEFAULT_APP_SETTINGS, softnApp: true } })];
    await renderSidebar('/apps/member-app/settings', <ManagementHeaderWithGuard leave={vi.fn()} />);
    expect(container.querySelector('nav[aria-label="App sections"]')).toBeNull();
    expect(api.getAppsSummary).not.toHaveBeenCalled();
  });

  it('keeps project drafts across internal web sections and guards a switch to its attached forms', async () => {
    const app = makeApp({ id: 'mixed' });
    const items = softnNavigationItems(app.id, { isOwner: true, managesMembers: true, backend: true, liveBackend: true, hasForms: true });
    const leave = vi.fn();
    await renderSidebar('/apps/mixed/web/edit', <RegisteredPage app={app} items={items} leave={leave} />);
    const rail = container.querySelector('nav[aria-label="App sections"]')!;
    await act(async () => rail.querySelector<HTMLAnchorElement>('a[aria-label="Data"]')!.click());
    expect(pathRef.current).toBe('/apps/mixed/web/data');
    expect(leave).not.toHaveBeenCalled();
    await act(async () => rail.querySelector<HTMLAnchorElement>('a[aria-label="Forms"]')!.click());
    expect(leave).toHaveBeenCalledWith('/apps/mixed/studio/data');
    expect(pathRef.current).toBe('/apps/mixed/web/data');
  });

  it('uses the installed app navigation, highlights a nested table and preserves the guarded way back', async () => {
    const app = makeApp({ id: 'notes', name: 'Field Notes' });
    const items = softnNavigationItems(app.id, { isOwner: true, managesMembers: true, backend: true, liveBackend: true });
    const leave = vi.fn();
    await renderSidebar('/apps/notes/web/data/notes/structure', <RegisteredPage app={app} items={items} leave={leave} />);
    const menu = container.querySelector('nav[aria-label="App sections"]')!;
    expect(menu.querySelector('[aria-current="page"]')?.textContent).toBe('Data');
    const linksIn = (name: string) => [...menu.querySelectorAll(`[role="group"][aria-label="${name}"] a`)].map(link => link.textContent);
    expect(linksIn('Build')).toEqual(['Edit', 'Data', 'API', 'Automations']);
    expect(linksIn('Manage')).toEqual(['Members', 'Files', 'Domains', 'History', 'Settings']);
    expect(container.querySelector('nav[aria-label="Workspace"]')).toBeNull();
    expect(container.querySelector('a[href="/settings"]')).toBeNull();
    await act(async () => { container.querySelector<HTMLAnchorElement>('a[aria-label="All apps"]')!.click(); });
    expect(leave).toHaveBeenCalledWith('/apps');
    expect(pathRef.current).toBe('/apps/notes/web/data/notes/structure');
  });

  it('keeps allowed sections reachable on the compact rail when the app has no backend', async () => {
    const app = makeApp({ id: 'draft', name: 'API Playground' });
    const items = softnNavigationItems(app.id, { isOwner: true, managesMembers: true, backend: false, liveBackend: false });
    const previous = useUIStore.getState().sidebarCollapsed;
    try {
      useUIStore.setState({ sidebarCollapsed: true });
      await renderSidebar('/apps/draft/web/overview', <RegisteredPage app={app} items={items} leave={vi.fn()} />);
      const menu = container.querySelector('nav[aria-label="App sections"]')!;
      const links = [...menu.querySelectorAll('a')].map(a => a.getAttribute('aria-label'));
      expect(links).toEqual(['Overview', 'Edit', 'Data', 'Members', 'Files', 'Domains', 'History', 'Settings']);
      expect(menu.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('Overview');
      expect(menu.querySelector('[aria-label="Data"]')?.getAttribute('title')).toBe('Data');
    } finally {
      await act(async () => { useUIStore.setState({ sidebarCollapsed: previous }); });
    }
  });

  it('shows only the sections available to a non-owner and waits for the active app registration', async () => {
    const app = makeApp({ id: 'owned' });
    const access = { isOwner: false, managesMembers: false, backend: true, liveBackend: true };
    const items = softnNavigationItems(app.id, access);
    expect(items.map(item => item.value)).toEqual(['overview', 'edit', 'data', 'domains', 'settings']);
    await renderSidebar('/apps/another/web', <RegisteredPage app={app} items={items} leave={vi.fn()} />);
    expect(container.querySelector('nav[aria-label="Workspace"]')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="App sections"]')).toBeNull();
  });

  it('lists the user apps with their publish state', async () => {
    h.apps = [
      makeApp({ id: 'a1', name: 'Plumbing Operations', status: 'published', publishedVersion: 3 }),
      makeApp({ id: 'a2', name: 'Customer Portal', slug: 'portal', status: 'draft' }),
      makeApp({ id: 'notes', name: 'Field Notes', slug: 'field-notes', status: 'published', publishedVersion: 1, settings: { ...DEFAULT_APP_SETTINGS, softnApp: true } }),
    ];
    await renderSidebar();
    expect(container.textContent).toContain('Apps');
    expect(container.textContent).toContain('Plumbing Operations');
    // One vocabulary for app state everywhere (lib/appStatus): 'Live v3', not one
    // of the five spellings the section used to carry.
    expect(container.textContent).toContain('Live v3');
    expect(container.textContent).toContain('Customer Portal');
    expect(container.textContent).toContain('Draft');
    const notes = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Field Notes'));
    expect(notes?.textContent).toContain('Live');
    expect(notes?.textContent).not.toContain('Live v1');
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
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Your apps'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Plumbing');
    expect(localStorage.getItem('formlogic.sidebar.appsOpen')).toBe('0');

    const viewAll = container.querySelector<HTMLAnchorElement>('a[aria-label="Apps"]')!;
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

  it('keeps the scoped app menu persistent across intra-app sub-menu transitions without flashing the workspace menu', async () => {
    const app = makeApp({ id: 'forms-persist', name: 'Workshop Persist' });
    h.apps = [app];
    const items = softnNavigationItems(app.id, { isOwner: true, managesMembers: true, backend: false, liveBackend: false, hasForms: true });
    function NavTest() {
      const navigate = useNavigate();
      useAppSectionSidebar(app, items, navigate);
      return null;
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/apps/forms-persist/web/edit']}>
          <AppNavigationProvider>
            <PathProbe />
            <Sidebar />
            <Routes>
              <Route path="/apps/:appId/web/*" element={<NavTest />} />
              {/* Simulate a lazy/loading destination route that has not mounted or re-registered yet */}
              <Route path="/apps/:appId/studio/:step?" element={<div data-loading="true" />} />
              <Route path="*" element={<></>} />
            </Routes>
          </AppNavigationProvider>
        </MemoryRouter>
      );
    });
    expect(container.querySelector('nav[aria-label="App sections"]')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Workspace"]')).toBeNull();

    const formsLink = container.querySelector<HTMLAnchorElement>('a[href="/apps/forms-persist/studio/data"]')!;
    await act(async () => { formsLink.click(); });
    expect(pathRef.current).toBe('/apps/forms-persist/studio/data');
    // Even though NavTest unmounted and the studio route hasn't registered yet, the scoped app menu stays mounted!
    const persistentMenu = container.querySelector('nav[aria-label="App sections"]');
    expect(persistentMenu).not.toBeNull();
    expect(persistentMenu?.querySelector('[aria-current="page"]')?.textContent).toBe('Forms');
    expect(container.querySelector('nav[aria-label="Workspace"]')).toBeNull();

    // Leaving the app back to /apps cleanly restores the Workspace menu
    await act(async () => { container.querySelector<HTMLAnchorElement>('a[aria-label="All apps"]')!.click(); });
    expect(pathRef.current).toBe('/apps');
    expect(container.querySelector('nav[aria-label="App sections"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Workspace"]')).not.toBeNull();
  });
});
