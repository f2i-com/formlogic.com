// @vitest-environment jsdom
/**
 * The SoftN app's page: its sections are addresses (the overview at the page itself, then data,
 * api, members, edit, automations, history, domains and settings); an app with nothing installed starts from its setup choices; one
 * arriving from "Create app" or the chat opens straight into the editor it asked for, once;
 * editor changes are installed at once while the app is not published and kept as a draft to
 * publish once it is; Publish makes a draft app live.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeProject } from '../../lib/nativeHosting';

const mocks = vi.hoisted(() => ({
  getNativeProject: vi.fn(),
  saveNativeProject: vi.fn(),
  installNativeStarter: vi.fn(),
  publishApp: vi.fn(),
  getAppDomains: vi.fn(),
  createAppDomain: vi.fn(),
  getAppAi: vi.fn(),
  getNativeDataSummary: vi.fn(),
  getAppUsers: vi.fn(),
  listFlows: vi.fn(),
  getAppForms: vi.fn(),
  getAppSignInCodes: vi.fn(),
  withMediaBytes: vi.fn(),
  keepUnchanged: vi.fn(),
  dataManager: null as null | { table?: string; view?: string; query?: string; onNavigate(table: string | undefined, view: string, query?: string, options?: { replace?: boolean }): void },
  editor: null as null | { kind: string; brief?: unknown; applyLabel?: string; onApply(bytes: Uint8Array): Promise<void>; onClose(): void },
  history: null as null | { app: { name: string }; version: number; open?: number; file?: string; backend: boolean; readOnly: boolean; waiting: string | null; onRestored(result: { version: number; restored: number; databaseAhead: string[] }): void },
  appApi: null as null | { app: { name: string }; access?: string; manifest?: string; version: number; dirty: boolean; readOnly: boolean },
  designer: null as null | { mode: string; access?: string; waiting?: string | null; onCreate(design: unknown): Promise<boolean>; onMode(mode: string): void; onClose(): void },
}));
vi.mock('../../components/design/DatabaseDesigner', () => ({
  DatabaseDesigner: (props: NonNullable<typeof mocks.designer>) => { mocks.designer = props; return <p data-testid="designer">designer {props.mode}, {props.access}</p>; },
}));
// lib/nativeHosting is stood in for below, so the backend is added to the page as withBackend would, without its checks.
vi.mock('../../lib/softnBackend', () => ({
  STARTER_ORIGIN: 'https://app.example',
  backendOf: () => null,
  withBackend: (project: NativeProject, backend: { server: unknown; files: Record<string, string> }) =>
    ({ ...project, files: { ...project.files, ...backend.files, 'manifest.json': JSON.stringify({ id: 'a', server: backend.server }) } }),
}));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
vi.mock('../../lib/api', () => ({ api: {
  getNativeProject: mocks.getNativeProject, saveNativeProject: mocks.saveNativeProject, installNativeStarter: mocks.installNativeStarter, publishApp: mocks.publishApp,
  getAppDomains: mocks.getAppDomains, createAppDomain: mocks.createAppDomain,
  getAppAi: mocks.getAppAi,
  getNativeDataSummary: mocks.getNativeDataSummary, getAppUsers: mocks.getAppUsers, listFlows: mocks.listFlows, getAppForms: mocks.getAppForms,
  getAppSignInCodes: mocks.getAppSignInCodes,
  getPassKinds: async () => ({ data: { passes: [] } }),
  isAdminActing: () => false, isDemoMode: () => false,
} }));
vi.mock('../../hooks/useAiReady', () => ({ useAiReady: () => ({ ready: true, reason: null, recheck: async () => true }) }));
vi.mock('../../lib/nativeHosting', () => ({
  exportNativeProject: () => new Uint8Array([1]),
  importNativeProject: async () => ({ version: 0, files: { 'manifest.json': '{"id":"a"}', 'ui/main.ui': '<Text>Changed</Text>' }, assets: {}, access: 'application' }),
  declaresFormlogicAi: (project: { files: Record<string, string> }) => 'formlogicAi' in JSON.parse(project.files['manifest.json'] ?? '{}'),
  declaresFormlogicPayments: () => false,
  phoneCodeProvider: (project: { files: Record<string, string> }) => JSON.parse(project.files['manifest.json'] ?? '{}').config?.app?.verificationProvider ?? null,
}));
// The page holds the app's media by name: their bytes are read for a download or an editor, and a save names what the server has.
vi.mock('../../lib/nativeMedia', () => ({ withMediaBytes: mocks.withMediaBytes, keepUnchanged: mocks.keepUnchanged, pictureUrl: () => '' }));
// The settings of an app with a backend, which read the server themselves.
vi.mock('../../components/apps/PhoneSignInPanel', () => ({ PhoneSignInPanel: () => <p>phone sign-in</p> }));
vi.mock('../../components/apps/AppAiPanel', () => ({ AppAiPanel: () => <p>ai settings</p> }));
vi.mock('../../components/studio/AppEditorDialog', () => ({
  AppEditorDialog: (props: NonNullable<typeof mocks.editor>) => { mocks.editor = props; return <p>editor:{props.kind}</p>; },
}));
vi.mock('../../components/data', () => ({
  DataManager: (props: NonNullable<typeof mocks.dataManager>) => { mocks.dataManager = props; return <p data-testid="data-manager">data:{props.table ?? ''}:{props.view}</p>; },
}));
vi.mock('../../components/apps/SoftnMembers', () => ({
  SoftnMembers: ({ app, project }: { app: { name: string }; project: { access?: string } }) => <p data-testid="softn-members">members of {app.name}, {project.access}</p>,
}));
vi.mock('../../components/studio/AppEngineSelect', () => ({ AppEngineSelect: () => null }));
vi.mock('../../components/studio/NativeAppPanel', () => ({
  NativeEditor: ({ surface, saveLabel }: { surface?: string; saveLabel?: string }) => <p data-testid="source-editor">source editor: {surface}, {saveLabel}</p>,
}));
vi.mock('../../components/apps/SoftnAutomations', () => ({
  SoftnAutomations: ({ app }: { app: { name: string } }) => <p data-testid="softn-automations">automations of {app.name}</p>,
}));
vi.mock('../../components/apps/SoftnHistory', () => ({
  SoftnHistory: (props: NonNullable<typeof mocks.history>) => { mocks.history = props; return <p data-testid="softn-history">history of {props.app.name}, version {props.version}, open {String(props.open)}, file {String(props.file)}</p>; },
}));
vi.mock('../../components/apps/SoftnApi', () => ({
  SoftnApi: (props: NonNullable<typeof mocks.appApi>) => { mocks.appApi = props; return <p data-testid="softn-api">api of {props.app.name}, version {props.version}</p>; },
}));
vi.mock('../../components/studio/NativeAppView', () => ({ NativeAppView: ({ slug }: { slug: string }) => <p>running {slug}</p> }));

const { SoftnAppWorkspace } = await import('./SoftnAppWorkspace');
const { useAppStore } = await import('../../stores/appStore');
const { useUIStore } = await import('../../stores/uiStore');
const { useAuthStore } = await import('../../stores/authStore');
const { toast } = await import('../../stores/toastStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const installed = (version: number): NativeProject => ({ version, home: true, access: 'members', files: { 'manifest.json': '{"id":"a"}', 'ui/main.ui': '<Text>Hi</Text>' }, assets: {} });
const app = (status: 'draft' | 'published') => ({ id: 'app-1', name: 'Recipes', slug: 'recipes', status, ownerId: 'u1', canManage: true, settings: { softnApp: true }, theme: {}, navConfig: [] });

beforeEach(() => {
  for (const mock of [mocks.getNativeProject, mocks.saveNativeProject, mocks.installNativeStarter, mocks.publishApp]) mock.mockReset();
  mocks.withMediaBytes.mockReset().mockImplementation(async (_id: string, project: NativeProject) => project);
  mocks.keepUnchanged.mockReset().mockImplementation(async (project: NativeProject) => project);
  mocks.editor = null;
  mocks.saveNativeProject.mockImplementation(async (_id: string, project: NativeProject, expected: number) => ({ data: { project: { ...project, version: expected + 1 } } }));
  mocks.publishApp.mockResolvedValue({ data: { app: app('published'), version: 1 } });
  mocks.getAppDomains.mockReset().mockResolvedValue({ data: { domains: [] } });
  mocks.createAppDomain.mockReset();
  mocks.getNativeDataSummary.mockReset().mockResolvedValue({ data: { installed: true, tables: [] } });
  mocks.getAppUsers.mockReset().mockResolvedValue({ data: { users: [], count: 0 } });
  mocks.listFlows.mockReset().mockResolvedValue({ data: { flows: [] } });
  mocks.getAppForms.mockReset().mockResolvedValue({ data: { forms: [] } });
  mocks.getAppSignInCodes.mockReset().mockResolvedValue({ data: { plugin: null, provider: null, fields: [], values: {}, kept: {}, keptWithoutPlugin: false } });
  mocks.dataManager = null;
  mocks.history = null;
  mocks.appApi = null;
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.test' } as never });
  useUIStore.getState().setSoftnOpen(null);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

/** The page at one of its addresses: the overview unless a section is named. */
async function render(status: 'draft' | 'published', project: NativeProject | null, at = '') {
  useAppStore.setState({ apps: [app(status)] as never, fetchApps: vi.fn(async () => {}) });
  mocks.getNativeProject.mockResolvedValue({ data: { available: true, ready: true, preflight: { ok: true, checks: [] }, project } });
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[`/apps/app-1/softn${at}`]}><Routes><Route path="/apps/:appId/softn/*" element={<SoftnAppWorkspace />} /></Routes></MemoryRouter>));
  await act(async () => {});
}
const button = (text: RegExp) => [...document.body.querySelectorAll('button')].find(b => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
/** The section the page says it is showing. */
const section = () => container.querySelector('nav[aria-label="App sections"] a[aria-current="page"]')?.textContent;
const withBackend = (version: number): NativeProject => ({ ...installed(version), files: { 'manifest.json': '{"id":"a","server":{"entry":"server/main.logic"}}', 'ui/main.ui': '<Text>Hi</Text>' } });

describe('SoftnAppWorkspace', () => {
  describe('what the App Studio did for a SoftN app', () => {
    it('has automations as a section of the page, for the owner of an app with a backend', async () => {
      await render('published', withBackend(1), '/automations');
      expect(section()).toBe('Automations');
      expect(container.querySelector('[data-testid="softn-automations"]')!.textContent).toBe('automations of Recipes');
    });

    it('says on the overview what runs by itself, with the way into the section', async () => {
      mocks.listFlows.mockResolvedValue({ data: { flows: [{ id: 'f1', enabled: true }, { id: 'f2', enabled: false }, { id: 'f3', enabled: true }] } });
      await render('published', withBackend(1));
      const card = container.querySelector('section[aria-label="Automations"]')!;
      expect(card.textContent).toContain('3 automations · 2 running');
      expect(card.querySelector('a')!.getAttribute('href')).toBe('/apps/app-1/softn/automations');
      expect(mocks.listFlows).toHaveBeenCalledWith('app-1');
      await act(async () => root.unmount());
      // None yet: it says so, and what one would be for.
      mocks.listFlows.mockResolvedValue({ data: { flows: [] } });
      await render('published', withBackend(1));
      expect(container.querySelector('section[aria-label="Automations"]')!.textContent).toContain('Nothing runs by itself yet');
      await act(async () => root.unmount());
      // A read that fails is not "nothing yet".
      mocks.listFlows.mockResolvedValue({ error: 'Server error', status: 500 });
      await render('published', withBackend(1));
      expect(container.querySelector('section[aria-label="Automations"]')!.textContent).not.toContain('Nothing runs by itself yet');
      await act(async () => root.unmount());
      // An app with no backend has no such section, so no card and no request for it.
      mocks.listFlows.mockClear();
      await render('published', installed(1));
      expect(container.querySelector('section[aria-label="Automations"]')).toBeNull();
      expect(mocks.listFlows).not.toHaveBeenCalled();
    });

    it('leaves the section out for an app with no backend, and says why at its address', async () => {
      await render('published', installed(1), '/automations');
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent)).not.toContain('Automations');
      expect(container.querySelector('[data-testid="softn-automations"]')).toBeNull();
      expect(container.textContent).toContain('This app has no database on the server yet.');
      expect(container.querySelector('a[href="/apps/app-1/softn/data"]:not(nav a)')!.textContent).toBe('Add a backend');
    });

    it('names the studio only for an app that also holds forms, as the way to those forms', async () => {
      mocks.getAppForms.mockResolvedValue({ data: { forms: [{ id: 'af1', formId: 'f1' }, { id: 'af2', formId: 'f2' }] } });
      await render('published', withBackend(1), '/settings');
      expect(mocks.getAppForms).toHaveBeenCalledWith('app-1');
      expect(button(/^This app’s forms \(App Studio\)$/)).toBeDefined();
      await act(async () => root.unmount());
      // A read of its forms that fails offers nothing rather than a way to somewhere that would send it back.
      mocks.getAppForms.mockResolvedValue({ error: 'Server error', status: 500 });
      await render('published', withBackend(1), '/settings');
      expect(button(/App Studio/)).toBeUndefined();
      await act(async () => root.unmount());
      // Its forms are not asked for until Settings is open.
      mocks.getAppForms.mockClear();
      await render('published', withBackend(1), '/edit');
      expect(mocks.getAppForms).not.toHaveBeenCalled();
    });

    it('opens the database designer over the Data section of an app with no backend, and installs the backend it makes', async () => {
      await render('draft', installed(1), '/data?design=diagram');
      expect(container.querySelector('[data-testid="designer"]')!.textContent).toBe('designer diagram, members');
      const { importSql } = await import('../../lib/sqlSchema');
      const { TASKS_SQLITE } = await import('../../lib/__fixtures__/schemas');
      let madeHere = false;
      await act(async () => { madeHere = await mocks.designer!.onCreate(importSql(TASKS_SQLITE, 'members').design); });
      // A draft app's backend is installed at once: the designer may forget the design.
      expect(madeHere).toBe(true);
      const saved = mocks.saveNativeProject.mock.calls.at(-1)![1] as NativeProject;
      expect(JSON.parse(saved.files['manifest.json']).server.routes.map((route: { method: string; path: string }) => `${route.method} ${route.path}`))
        .toEqual(['GET /api/projects', 'POST /api/projects', 'PUT /api/projects', 'DELETE /api/projects', 'GET /api/tasks', 'POST /api/tasks', 'PUT /api/tasks', 'DELETE /api/tasks']);
      expect(saved.files['server/migrations/001.sql']).toContain('CREATE TABLE tasks');
      expect(saved.files['ui/main.ui']).toBe('<Text>Hi</Text>');
      expect(container.textContent).toContain('Backend made: 2 tables and 8 routes for its page.');
      expect(container.querySelector('[data-testid="designer"]')).toBeNull();
      await act(async () => root.unmount());
      // An app that has a backend gets no designer at that address; an older address still opens it.
      await render('draft', withBackend(1), '/data?design=diagram');
      expect(container.querySelector('[data-testid="designer"]')).toBeNull();
      await act(async () => root.unmount());
      await render('draft', installed(1), '/data?design=steps');
      expect(container.querySelector('[data-testid="designer"]')!.textContent).toBe('designer diagram, members');
    });

    it('shows the phone sign-in codes, and links to them, only for an app whose manifest names a provider for its codes', async () => {
      const links = () => [...container.querySelectorAll('a')].map(a => a.textContent ?? '');
      for (const at of ['/settings', '']) {
        await render('published', withBackend(1), at);
        expect(container.textContent).not.toContain('phone sign-in');
        expect(links().some(text => text.includes('Phone sign-in codes'))).toBe(false);
        await act(async () => root.unmount());
      }
      const texting: NativeProject = { ...withBackend(1), files: { ...withBackend(1).files, 'manifest.json': '{"id":"a","server":{"entry":"server/main.logic"},"config":{"app":{"verificationProvider":"twilio-verify"}}}' } };
      await render('published', texting, '/settings');
      expect(container.textContent).toContain('phone sign-in');
      expect(links()).toContain('Phone sign-in codes');
      await act(async () => root.unmount());
      await render('published', texting);
      expect(links().some(text => text.includes('Phone sign-in codes'))).toBe(true);
    });

    it('still shows the phone sign-in codes where details are kept for an app that names no provider now, so they can be forgotten', async () => {
      mocks.getAppSignInCodes.mockResolvedValue({ data: { plugin: null, provider: null, fields: [], values: {}, kept: {}, keptWithoutPlugin: true } });
      await render('published', withBackend(1), '/settings');
      await act(async () => {});
      expect(mocks.getAppSignInCodes).toHaveBeenCalledWith('app-1');
      expect(container.textContent).toContain('phone sign-in');
    });

    it('has no link or button named for the studio anywhere on the page of an app with no forms', async () => {
      for (const at of ['', '/edit', '/members', '/automations', '/history', '/domains', '/settings']) {
        await render('published', withBackend(1), at);
        expect([...container.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(href => href?.includes('/studio'))).toEqual([]);
        expect(button(/App Studio/)).toBeUndefined();
        await act(async () => root.unmount());
      }
      await render('published', withBackend(1));
    });

    it('opens the files as source code and nothing else, saying what saving them does', async () => {
      await render('published', withBackend(1), '/edit');
      await act(async () => button(/^Edit the source code$/)!.click());
      expect(document.querySelector('[data-testid="source-editor"]')!.textContent).toBe('source editor: source, Publish changes');
      await act(async () => root.unmount());
      // Not live yet: saving the files makes a version only its owner sees.
      await render('draft', withBackend(1), '/edit');
      await act(async () => button(/^Edit the source code$/)!.click());
      expect(document.querySelector('[data-testid="source-editor"]')!.textContent).toBe('source editor: source, Save changes');
    });
  });

  describe('sections', () => {
    it('opens on the overview, which says what the app holds and starts nothing', async () => {
      mocks.getNativeDataSummary.mockResolvedValue({ data: { installed: true, tables: ['bookings', 'rooms'], summary: { tables: [{ name: 'bookings', rows: 8214, columns: 9 }, { name: 'rooms', rows: 12, columns: 3 }], bytes: 3145728, hiddenTables: 1 } } });
      mocks.getAppUsers.mockResolvedValue({ data: { users: [], count: 4 } });
      await render('published', withBackend(7));
      expect(section()).toBe('Overview');
      expect(container.textContent).toContain('Live, version 7');
      expect(container.textContent).toContain('2 tables · 8,226 rows · 3.0 MB');
      expect(container.textContent).toContain('You and 3 other people can use it.');
      // The largest table is a link into the data section, at that table.
      expect((container.querySelector('a[href="/apps/app-1/softn/data/bookings"]') as HTMLAnchorElement).textContent).toContain('8,214');
      // The app itself runs under Edit: an owner looking at ten apps starts none of them.
      expect(container.querySelector('[data-testid="softn-app-preview"]')).toBeNull();
    });

    it('gives every section an address, and takes the table and the view from it', async () => {
      await render('published', withBackend(1), '/data/bookings/structure');
      expect(section()).toBe('Data');
      expect(container.querySelector('[data-testid="data-manager"]')!.textContent).toBe('data:bookings:structure');
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.getAttribute('href'))).toEqual([
        '/apps/app-1/softn', '/apps/app-1/softn/data', '/apps/app-1/softn/api', '/apps/app-1/softn/members', '/apps/app-1/softn/edit', '/apps/app-1/softn/automations', '/apps/app-1/softn/history', '/apps/app-1/softn/domains', '/apps/app-1/softn/settings']);
      // The data manager asks for another table: the address follows, and the default view is left out of it.
      await act(async () => mocks.dataManager!.onNavigate('rooms', 'browse'));
      expect(container.querySelector('[data-testid="data-manager"]')!.textContent).toBe('data:rooms:browse');
      await act(async () => mocks.dataManager!.onNavigate('rooms', 'export'));
      expect(container.querySelector('[data-testid="data-manager"]')!.textContent).toBe('data:rooms:export');
    });

    it('keeps what is being looked at in a table in the address, and hands it back to the data manager', async () => {
      await render('published', withBackend(1), '/data/bookings?q=nuts&sort=starts_at');
      expect(mocks.dataManager!.query).toBe('q=nuts&sort=starts_at');
      // A linked ID: another table, filtered to the row it points at, with that row open.
      await act(async () => mocks.dataManager!.onNavigate('customers', 'browse', 'filter=%5B%5D&row=%7B%22id%22%3A%221458%22%7D'));
      expect(container.querySelector('[data-testid="data-manager"]')!.textContent).toBe('data:customers:browse');
      expect(mocks.dataManager!.query).toBe('filter=%5B%5D&row=%7B%22id%22%3A%221458%22%7D');
      // Opening a table from the list asks for no query: the address has none.
      await act(async () => mocks.dataManager!.onNavigate('rooms', 'browse'));
      expect(mocks.dataManager!.query).toBe('');
    });

    it('sends an address that names no section to the overview', async () => {
      await render('published', installed(1), '/records');
      expect(section()).toBe('Overview');
    });

    it('offers a backend, not an empty table list, to an app that keeps its data in each browser', async () => {
      await render('published', installed(1), '/data');
      expect(container.querySelector('[data-testid="data-manager"]')).toBeNull();
      expect(container.textContent).toContain('This app has no database on the server.');
      expect(mocks.getNativeDataSummary).not.toHaveBeenCalled();
    });
  });

  // Every version a later one replaced, and going back to one: a section after Automations.
  describe('history', () => {
    it('is a section of the page after Automations, for an app with a backend and one without', async () => {
      await render('published', withBackend(3), '/history');
      expect(section()).toBe('History');
      expect(container.querySelector('[data-testid="softn-history"]')!.textContent).toBe('history of Recipes, version 3, open undefined, file undefined');
      const names = [...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent);
      expect(names.slice(names.indexOf('Automations'), names.indexOf('Automations') + 2)).toEqual(['Automations', 'History']);
      expect(mocks.history).toMatchObject({ backend: true, readOnly: false, waiting: null });
      await act(async () => root.unmount());
      // A JavaScript app or a SoftN app with no backend has versions too.
      await render('draft', installed(2), '/history');
      expect(section()).toBe('History');
      expect(mocks.history).toMatchObject({ version: 2, backend: false });
    });

    it('takes the version that is open, and the file open in it, from the address', async () => {
      await render('published', withBackend(9), '/history/7?file=server%2Fmain.logic');
      expect(section()).toBe('History');
      expect(mocks.history).toMatchObject({ open: 7, file: 'server/main.logic' });
      await act(async () => root.unmount());
      // Anything but a version's number there is no version.
      await render('published', withBackend(9), '/history/seven');
      expect(mocks.history!.open).toBeUndefined();
    });

    it('reads the project again and reloads the preview once a version is gone back to', async () => {
      await render('published', withBackend(3), '/history');
      expect(mocks.getNativeProject).toHaveBeenCalledTimes(1);
      mocks.getNativeProject.mockResolvedValue({ data: { available: true, ready: true, preflight: { ok: true, checks: [] }, project: withBackend(4) } });
      await act(async () => mocks.history!.onRestored({ version: 4, restored: 2, databaseAhead: [] }));
      await act(async () => {});
      expect(mocks.getNativeProject).toHaveBeenCalledTimes(2);
      expect(mocks.history!.version).toBe(4);
      expect(container.textContent).toContain('Version 4');
    });

    it('is the owner\'s alone: nobody else is offered it, or shown it at its address', async () => {
      useAuthStore.setState({ user: { id: 'manager', email: 'manager@example.test' } as never });
      await render('published', withBackend(3), '/history/2');
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent)).not.toContain('History');
      expect(container.querySelector('[data-testid="softn-history"]')).toBeNull();
      expect(container.textContent).toContain('Only the app’s owner sees its earlier versions and goes back to one.');
    });
  });

  // The app's API (components/apps/SoftnApi): a section after Data, for the owner of an app with a backend.
  describe('api', () => {
    it('is a section after Data that shows the live app: its installed manifest, who can use it and its version', async () => {
      await render('published', withBackend(5), '/api');
      expect(section()).toBe('API');
      const names = [...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent);
      expect(names.slice(names.indexOf('Data'), names.indexOf('Data') + 2)).toEqual(['Data', 'API']);
      expect(container.querySelector('[data-testid="softn-api"]')!.textContent).toBe('api of Recipes, version 5');
      expect(mocks.appApi).toMatchObject({ access: 'members', manifest: '{"id":"a","server":{"entry":"server/main.logic"}}', dirty: false, readOnly: false });
    });

    it('is not offered for an app with no backend, and says why at its address', async () => {
      await render('published', installed(1), '/api');
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent)).not.toContain('API');
      expect(container.querySelector('[data-testid="softn-api"]')).toBeNull();
      expect(container.textContent).toContain('This app has no backend, so it has no API.');
      expect(container.querySelector('a[href="/apps/app-1/softn/data"]:not(nav a)')!.textContent).toBe('Add a backend');
    });

    it('is the owner\'s alone: nobody else is offered it, or shown it at its address', async () => {
      useAuthStore.setState({ user: { id: 'manager', email: 'manager@example.test' } as never });
      await render('published', withBackend(3), '/api');
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent)).not.toContain('API');
      expect(container.querySelector('[data-testid="softn-api"]')).toBeNull();
      expect(container.textContent).toContain('Only the app’s owner sees its API and the calls it has had.');
    });

    it('stays while the live app has a backend that an unpublished draft takes out: the live one still answers calls', async () => {
      window.localStorage.clear();
      // A draft kept in this browser, without the backend the installed version has, taken back.
      window.localStorage.setItem('formlogic:native-draft:u1:app-1', JSON.stringify({ baseVersion: 2, savedAt: new Date().toISOString(), project: installed(2) }));
      await render('published', withBackend(2), '/api');
      await act(async () => button(/^Recover them$/)!.click());
      await act(async () => {});
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent)).toContain('API');
      expect(container.querySelector('[data-testid="softn-api"]')).not.toBeNull();
      expect(mocks.appApi).toMatchObject({ manifest: '{"id":"a","server":{"entry":"server/main.logic"}}', dirty: true });
      window.localStorage.clear();
    });
  });

  // Who can use the app is a section of its own page: it used to send the owner into App Studio.
  describe('members', () => {
    it('is a section of the app\'s own page, and the overview and the settings lead to it', async () => {
      await render('published', installed(1), '/members');
      expect(section()).toBe('Members');
      expect(container.querySelector('[data-testid="softn-members"]')!.textContent).toBe('members of Recipes, members');
      await act(async () => root.unmount());
      await render('published', installed(1));
      expect((container.querySelector('a[href="/apps/app-1/softn/members"]:not(nav a)') as HTMLAnchorElement).textContent).toBe('Members');
      expect(container.querySelector('a[href="/apps/app-1/studio/access"]')).toBeNull();
      await act(async () => root.unmount());
      await render('published', installed(1), '/settings');
      expect([...container.querySelectorAll('#settings-access a')].map(a => a.getAttribute('href'))).toEqual(['/apps/app-1/softn/members']);
    });

    it('is the owner\'s alone: nobody else is offered it, or shown it at its address', async () => {
      useAuthStore.setState({ user: { id: 'manager', email: 'manager@example.test' } as never });
      await render('published', installed(1), '/members');
      expect([...container.querySelectorAll('nav[aria-label="App sections"] a')].map(a => a.textContent)).not.toContain('Members');
      expect(container.querySelector('[data-testid="softn-members"]')).toBeNull();
      expect(container.textContent).toContain('Only the app’s owner manages who can use it.');
    });
  });

  it('lets the owner give the app a domain, opening the app itself by default', async () => {
    await render('published', installed(1), '/domains');
    await act(async () => {});
    expect(section()).toBe('Domains');
    expect(container.textContent).toContain('Custom domains');
    expect(container.textContent).toContain('full screen on your domain');
    expect((container.querySelector('select[aria-label="Domain mode"]') as HTMLSelectElement).value).toBe('runtime_direct');
  });

  it('shows the domains panel to the owner alone, as the server allows', async () => {
    useAuthStore.setState({ user: { id: 'manager', email: 'manager@example.test' } as never });
    await render('published', installed(1), '/domains');
    expect(container.textContent).not.toContain('Custom domains');
    expect(mocks.getAppDomains).not.toHaveBeenCalled();
  });

  // An app that asks for AI and has it off: one line for its owner, leading to its AI settings.
  describe('"This app can use AI"', () => {
    const asksForAi = (version: number): NativeProject => ({
      ...installed(version),
      files: { 'manifest.json': '{"id":"a","server":{"entry":"server/main.logic"},"formlogicAi":{"uses":["pictures"]}}', 'ui/main.ui': '<Text>Hi</Text>' },
    });
    const prompt = () => container.querySelector('[data-testid="app-ai-prompt"]');
    beforeEach(() => {
      window.localStorage.clear();
      mocks.getAppAi.mockReset().mockResolvedValue({ data: { declared: { uses: ['pictures'], purpose: 'Draws.', table: 'ai_jobs', deliver: '/deliver' }, settings: { mode: 'off' } } });
    });

    it('tells the owner, and opens the app\'s AI settings', async () => {
      await render('published', asksForAi(1));
      expect(mocks.getAppAi).toHaveBeenCalledWith('app-1');
      expect(prompt()?.textContent).toBe('This app can use AI. Set it up');
      await act(async () => button(/^Set it up$/)!.click());
      expect(section()).toBe('Settings');
      expect(container.querySelector('#app-ai-settings')!.textContent).toContain('ai settings');
      // On the settings themselves the line would only repeat the panel below it.
      expect(prompt()).toBeNull();
    });

    it('never tells anyone but the owner', async () => {
      useAuthStore.setState({ user: { id: 'manager', email: 'manager@example.test' } as never });
      await render('published', asksForAi(1));
      expect(prompt()).toBeNull();
      expect(mocks.getAppAi).not.toHaveBeenCalled();
    });

    it('says nothing for an app that does not ask for AI', async () => {
      await render('published', installed(1));
      expect(prompt()).toBeNull();
      expect(mocks.getAppAi).not.toHaveBeenCalled();
    });
  });

  // navigator.clipboard does not exist on plain HTTP, and the click did nothing at all.
  describe('Copy link', () => {
    const copyButton = () => [...container.querySelectorAll('button')].find(b => /recipes$/.test(b.textContent ?? '')) as HTMLButtonElement;
    afterEach(() => { delete (document as { execCommand?: unknown }).execCommand; });

    it('works where only the older way of copying does', async () => {
      const execCommand = vi.fn(() => true);
      Object.assign(document, { execCommand });
      await render('published', installed(1));
      await act(async () => copyButton().click());
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(container.textContent).toContain('Link copied');
    });

    it('says so when nothing could copy', async () => {
      const failed = vi.spyOn(toast, 'error');
      Object.assign(document, { execCommand: () => false });
      await render('published', installed(1));
      await act(async () => copyButton().click());
      expect(failed).toHaveBeenCalledWith('Copy failed', expect.any(String));
      expect(container.textContent).not.toContain('Link copied');
    });
  });

  it('previews the app in place at the width chosen, never framing a page of FormLogic', async () => {
    await render('draft', installed(1), '/edit');
    const preview = container.querySelector('[data-testid="softn-app-preview"]')!;
    expect(preview.textContent).toBe('running recipes');
    // A FormLogic page may not be framed: the browser refused the preview on a real server.
    expect(container.querySelector('iframe')).toBeNull();
    await act(async () => (container.querySelector('button[aria-label="Phone width"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="softn-app-preview"]')!.className).toContain('w-[390px]');
  });

  it('offers the ways to start for an app with nothing installed, and opens the Visual Builder on the starter', async () => {
    await render('draft', null);
    expect(container.textContent).toContain('Set up Recipes');
    mocks.installNativeStarter.mockResolvedValue({ data: { project: installed(1) } });
    mocks.getNativeProject.mockResolvedValue({ data: { available: true, ready: true, preflight: { ok: true, checks: [] }, project: installed(1) } });
    await act(async () => button(/Start building/)!.click());
    await act(async () => {});
    expect(mocks.installNativeStarter).toHaveBeenCalledWith('app-1');
    expect(mocks.editor?.kind).toBe('builder');
  });

  it('opens AI Studio on the request it was brought here with, once', async () => {
    useUIStore.getState().setSoftnOpen({ appId: 'app-1', editor: 'studio', brief: { prompt: 'A recipe box.', kind: 'build' } });
    await render('draft', installed(1));
    expect(mocks.editor?.kind).toBe('studio');
    expect(mocks.editor?.brief).toEqual({ prompt: 'A recipe box.', kind: 'build' });
    expect(mocks.editor?.applyLabel).toBe('Save changes');
    expect(useUIStore.getState().softnOpen).toBeNull();
    // Back from the editor, the page shows the app running with what was changed.
    await act(async () => mocks.editor!.onClose());
    expect(section()).toBe('Edit');
    expect(container.textContent).toContain('Change your app');
  });

  it('installs editor changes at once while the app is not published, so the preview shows them', async () => {
    useUIStore.getState().setSoftnOpen({ appId: 'app-1', editor: 'builder' });
    await render('draft', installed(1));
    await act(async () => { await mocks.editor!.onApply(new Uint8Array([2])); });
    expect(mocks.saveNativeProject).toHaveBeenCalledWith('app-1', expect.objectContaining({ access: 'members', home: true, files: expect.objectContaining({ 'ui/main.ui': '<Text>Changed</Text>' }) }), 1);
  });

  it('keeps editor changes to a published app as a draft until Publish changes', async () => {
    useUIStore.getState().setSoftnOpen({ appId: 'app-1', editor: 'builder' });
    await render('published', installed(3));
    expect(mocks.editor?.applyLabel).toBe('Keep changes');
    await act(async () => { await mocks.editor!.onApply(new Uint8Array([2])); });
    await act(async () => mocks.editor!.onClose());
    expect(mocks.saveNativeProject).not.toHaveBeenCalled();
    expect(container.textContent).toContain('You have changes that are not live yet');
    await act(async () => button(/Publish changes/)!.click());
    expect(mocks.saveNativeProject).toHaveBeenCalledWith('app-1', expect.anything(), 3);
    expect(mocks.publishApp).not.toHaveBeenCalled();
  });

  it('publishes a draft app', async () => {
    await render('draft', installed(1));
    expect(container.textContent).toContain('Draft, version 1');
    await act(async () => button(/^Publish$/)!.click());
    expect(mocks.publishApp).toHaveBeenCalledWith('app-1');
  });

  describe('the app’s media', () => {
    const named = (): NativeProject => ({ ...installed(2), assets: { 'assets/model.glb': { kept: 'a'.repeat(64), size: 24_000_000 } } });
    const created = vi.fn(() => 'blob:download');
    beforeEach(() => {
      created.mockClear();
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    });

    it('are read by name, and their bytes only for a download', async () => {
      const project = named();
      await render('draft', project, '/edit');
      expect(mocks.getNativeProject).toHaveBeenCalledWith('app-1', { media: 'refs' });
      expect(mocks.withMediaBytes).not.toHaveBeenCalled();
      await act(async () => button(/Download as \.softn/)!.click());
      expect(mocks.withMediaBytes).toHaveBeenCalledWith('app-1', project);
      expect(created).toHaveBeenCalledTimes(1);
    });

    it('says why a download could not be had, and downloads nothing', async () => {
      mocks.withMediaBytes.mockRejectedValue(new Error('assets/model.glb is no longer on the server as this page has it: the app was changed since the page was opened. Reload the page and try again.'));
      await render('draft', named(), '/edit');
      await act(async () => button(/Download as \.softn/)!.click());
      expect(container.textContent).toContain('assets/model.glb is no longer on the server');
      expect(created).not.toHaveBeenCalled();
    });

    it('are read before an editor opens on the app', async () => {
      useUIStore.getState().setSoftnOpen({ appId: 'app-1', editor: 'builder' });
      const project = named();
      await render('draft', project);
      expect(mocks.withMediaBytes).toHaveBeenCalledWith('app-1', project);
      expect(mocks.editor?.kind).toBe('builder');
    });

    it('hold back uploads while they are read for an editor, which then opens', async () => {
      let arrive: (project: NativeProject) => void = () => {};
      mocks.withMediaBytes.mockImplementation(() => new Promise<NativeProject>(resolve => { arrive = resolve; }));
      const project = named();
      await render('draft', project, '/edit');
      await act(async () => button(/Edit visually/)!.click());
      expect(button(/Upload a new version/)!.disabled, 'no new version comes in under the editor').toBe(true);
      expect(button(/Edit visually/)!.disabled).toBe(true);
      await act(async () => arrive(project));
      expect(mocks.editor?.kind).toBe('builder');
    });

    it('keep what was typed for AI Studio where the editor could not be opened', async () => {
      mocks.withMediaBytes.mockRejectedValue(new Error('The app’s media could not be downloaded. Check your connection and try again.'));
      await render('draft', named(), '/edit');
      const area = container.querySelector('#softn-change') as HTMLTextAreaElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      await act(async () => { setValue.call(area, 'Add a search box'); area.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => button(/Make this change/)!.click());
      expect(container.textContent).toContain('Check your connection');
      expect((container.querySelector('#softn-change') as HTMLTextAreaElement).value).toBe('Add a search box');
      expect(mocks.editor).toBeNull();
    });

    it('go back to the server by name where it has them, as keepUnchanged makes the draft', async () => {
      const kept = { 'assets/model.glb': { kept: 'b'.repeat(64), size: 24_000_000 } };
      mocks.keepUnchanged.mockImplementation(async (project: NativeProject) => ({ ...project, assets: kept }));
      useUIStore.getState().setSoftnOpen({ appId: 'app-1', editor: 'builder' });
      await render('draft', installed(1));
      await act(async () => { await mocks.editor!.onApply(new Uint8Array([2])); });
      expect(mocks.keepUnchanged).toHaveBeenCalledWith(expect.objectContaining({ files: expect.objectContaining({ 'ui/main.ui': '<Text>Changed</Text>' }) }), installed(1));
      expect(mocks.saveNativeProject).toHaveBeenCalledWith('app-1', expect.objectContaining({ assets: kept }), 1);
    });
  });
});
