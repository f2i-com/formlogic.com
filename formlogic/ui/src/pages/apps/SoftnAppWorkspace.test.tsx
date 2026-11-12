// @vitest-environment jsdom
/**
 * The SoftN app's page: its sections are addresses (the overview at the page itself, then data,
 * members, edit, domains and settings); an app with nothing installed starts from its setup choices; one
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
  dataManager: null as null | { table?: string; view?: string; query?: string; onNavigate(table: string | undefined, view: string, query?: string, options?: { replace?: boolean }): void },
  editor: null as null | { kind: string; brief?: unknown; applyLabel?: string; onApply(bytes: Uint8Array): Promise<void>; onClose(): void },
}));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
vi.mock('../../lib/api', () => ({ api: {
  getNativeProject: mocks.getNativeProject, saveNativeProject: mocks.saveNativeProject, installNativeStarter: mocks.installNativeStarter, publishApp: mocks.publishApp,
  getAppDomains: mocks.getAppDomains, createAppDomain: mocks.createAppDomain,
  getAppAi: mocks.getAppAi,
  getNativeDataSummary: mocks.getNativeDataSummary, getAppUsers: mocks.getAppUsers,
  getPassKinds: async () => ({ data: { passes: [] } }),
  isAdminActing: () => false, isDemoMode: () => false,
} }));
vi.mock('../../hooks/useAiReady', () => ({ useAiReady: () => ({ ready: true, reason: null, recheck: async () => true }) }));
vi.mock('../../lib/nativeHosting', () => ({
  exportNativeProject: () => new Uint8Array([1]),
  importNativeProject: async () => ({ version: 0, files: { 'manifest.json': '{"id":"a"}', 'ui/main.ui': '<Text>Changed</Text>' }, assets: {}, access: 'application' }),
  declaresFormlogicAi: (project: { files: Record<string, string> }) => 'formlogicAi' in JSON.parse(project.files['manifest.json'] ?? '{}'),
  declaresFormlogicPayments: () => false,
}));
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
vi.mock('../../components/studio/NativeAppPanel', () => ({ NativeEditor: () => <p>source editor</p> }));
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
  mocks.editor = null;
  mocks.saveNativeProject.mockImplementation(async (_id: string, project: NativeProject, expected: number) => ({ data: { project: { ...project, version: expected + 1 } } }));
  mocks.publishApp.mockResolvedValue({ data: { app: app('published'), version: 1 } });
  mocks.getAppDomains.mockReset().mockResolvedValue({ data: { domains: [] } });
  mocks.createAppDomain.mockReset();
  mocks.getNativeDataSummary.mockReset().mockResolvedValue({ data: { installed: true, tables: [] } });
  mocks.getAppUsers.mockReset().mockResolvedValue({ data: { users: [], count: 0 } });
  mocks.dataManager = null;
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
        '/apps/app-1/softn', '/apps/app-1/softn/data', '/apps/app-1/softn/members', '/apps/app-1/softn/edit', '/apps/app-1/softn/domains', '/apps/app-1/softn/settings']);
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
});
