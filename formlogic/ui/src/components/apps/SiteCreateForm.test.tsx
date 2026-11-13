// @vitest-environment jsdom
/**
 * "Create app" → JavaScript app: a name and the .zip of a build land in the new app's workspace
 * with the app running, what will not work when hosted going with it; a zip this host cannot
 * take says why and creates nothing.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { SiteCreateForm } from './SiteCreateForm';
import { useAppStore } from '../../stores/appStore';

const mocks = vi.hoisted(() => ({ createApp: vi.fn(), saveNativeProject: vi.fn(), deleteApp: vi.fn() }));
// The form, the reading of the zip and the app list are the real ones: only the server is not.
vi.mock('../../lib/api', () => ({
  api: { createApp: mocks.createApp, saveNativeProject: mocks.saveNativeProject, deleteApp: mocks.deleteApp, isAdminActing: () => false, isDemoMode: () => false },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const seen: { path: string; state: unknown } = { path: '/apps/new', state: null };
function Probe() { const location = useLocation(); React.useEffect(() => { seen.path = location.pathname; seen.state = location.state; }); return null; }

const app = { id: 'app-1', name: 'Shop', slug: 'shop', settings: { softnApp: true } };

beforeEach(() => {
  for (const mock of [mocks.createApp, mocks.saveNativeProject, mocks.deleteApp]) mock.mockReset();
  mocks.createApp.mockResolvedValue({ data: { app } });
  mocks.saveNativeProject.mockImplementation(async (_id: string, project: unknown) => ({ data: { project } }));
  mocks.deleteApp.mockResolvedValue({ data: { success: true } });
  useAppStore.setState({ apps: [], error: null, isLoading: false, _loadingCount: 0 });
  seen.path = '/apps/new'; seen.state = null;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render(disabled = false) {
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={['/apps/new']}><Probe /><Routes>
    <Route path="/apps/new" element={<SiteCreateForm disabled={disabled} />} />
    <Route path="/apps/:appId/softn/*" element={<p>workspace</p>} />
  </Routes></MemoryRouter>));
}
const type = async (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
};
const nameField = () => container.querySelector('#site-app-name') as HTMLInputElement;
const buildField = () => container.querySelector('#site-app-build') as HTMLInputElement;
const createButton = () => [...container.querySelectorAll('button')].find(button => /Create from this build/.test(button.textContent ?? '')) as HTMLButtonElement;
const build = (files: Record<string, string>, name = 'dist.zip') => new File([zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])))], name);
const pick = async (file: File) => {
  Object.defineProperty(buildField(), 'files', { value: [file], configurable: true });
  await act(async () => { buildField().dispatchEvent(new Event('change', { bubbles: true })); });
};
/** The Create button's spinner: shown while the form works, gone once it has said or opened something. */
const busy = () => container.querySelector('button .animate-spin') !== null;
const settle = async (until: () => boolean) => {
  for (let turn = 0; turn < 200 && !until(); turn++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
};
/** Press Create and let the zip be read, the app made and its build saved. */
const create = async () => {
  await act(async () => { createButton().click(); });
  await settle(() => !busy());
};

describe('SiteCreateForm', () => {
  it('asks for a name and a build, and creates only once it has both', async () => {
    await render();
    expect(container.querySelector('label[for="site-app-name"]')?.textContent).toBe('App name');
    expect(container.querySelector('label[for="site-app-build"]')?.textContent).toBe('Your build (.zip)');
    expect(buildField().accept).toBe('.zip');
    expect(container.textContent).toContain('Zip the folder your build made, the one with index.html in it (dist or build).');
    expect(createButton().disabled).toBe(true);
    await type(nameField(), 'Shop');
    expect(createButton().disabled).toBe(true);
    await pick(build({ 'index.html': '<p>Hi</p>' }));
    expect(container.textContent).toContain('dist.zip');
    expect(createButton().disabled).toBe(false);
    // A name of spaces alone is no name.
    await type(nameField(), '   ');
    expect(createButton().disabled).toBe(true);
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('creates the app from the build and opens its workspace, with what will not work when hosted', async () => {
    await render();
    await type(nameField(), 'Shop');
    await pick(build({ 'dist/index.html': '<script type="module" src="/assets/app.js"></script>', 'dist/LICENSE': 'MIT', 'dist/assets/app.js': 'navigator.serviceWorker.register("./sw.js")' }));
    await create();
    expect(mocks.createApp).toHaveBeenCalledWith({ name: 'Shop', settings: { softnApp: true } });
    const [id, project, expected] = mocks.saveNativeProject.mock.calls[0] as [string, { files: Record<string, string>; assets: Record<string, string> }, number];
    expect([id, expected]).toEqual(['app-1', 0]);
    expect(JSON.parse(project.files['manifest.json'])).toEqual({ name: 'Shop', version: '1.0.0', site: { entry: 'index.html' } });
    expect(Object.keys(project.assets).sort()).toEqual(['site/assets/app.js', 'site/index.html']);
    expect(seen.path).toBe('/apps/app-1/softn/edit');
    // What was left out of the build first, then what in it will not work when hosted. A file
    // named from the site's root (/assets/app.js) is neither: the hosted page finds it.
    expect(seen.state).toEqual({ siteWarnings: [
      expect.stringContaining('1 file was left out of the app: dist/LICENSE.'),
      expect.stringContaining('assets/app.js registers a service worker'),
    ] });
  });

  it('opens the workspace with no warnings to show for a build that has none', async () => {
    await render();
    await type(nameField(), 'Shop');
    await pick(build({ 'index.html': '<script type="module" src="./assets/app.js"></script>', 'assets/app.js': 'console.log(1)' }));
    await create();
    expect(seen.path).toBe('/apps/app-1/softn/edit');
    expect(seen.state).toBeNull();
  });

  it('shows why a zip cannot be taken, creates nothing, and takes another', async () => {
    await render();
    await type(nameField(), 'Shop');
    await pick(build({ 'src/main.ts': 'export {}', 'package.json': '{}' }, 'project.zip'));
    await create();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This zip has no index.html: zip the folder your build made (dist or build).');
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.saveNativeProject).not.toHaveBeenCalled();
    expect(seen.path).toBe('/apps/new');
    // Choosing another file clears what was said of the last one.
    await pick(build({ 'index.html': '<script type="module" src="/src/main.tsx"></script>', 'package.json': '{}', 'src/main.tsx': 'x' }, 'source.zip'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await create();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This looks like a project\'s source, not its build: build it, then zip the folder the build made (dist or build).');
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('shows the server\'s refusal and leaves no app behind', async () => {
    mocks.saveNativeProject.mockResolvedValue({ error: 'Native project exceeds 64 MB' });
    await render();
    await type(nameField(), 'Shop');
    await pick(build({ 'index.html': '<p>Hi</p>' }));
    await create();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Native project exceeds 64 MB');
    expect(mocks.deleteApp).toHaveBeenCalledWith('app-1');
    expect(useAppStore.getState().apps).toEqual([]);
    expect(seen.path).toBe('/apps/new');
    expect(createButton().disabled).toBe(false);
  });

  it('is busy while it works, and one press creates one app', async () => {
    let finish!: (value: { data: { app: typeof app } }) => void;
    mocks.createApp.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await type(nameField(), 'Shop');
    await pick(build({ 'index.html': '<p>Hi</p>' }));
    await act(async () => { createButton().click(); createButton().click(); });
    await settle(() => mocks.createApp.mock.calls.length > 0);
    expect(createButton().disabled).toBe(true);
    expect(busy()).toBe(true);
    expect(nameField().disabled).toBe(true);
    await act(async () => { finish({ data: { app } }); });
    await settle(() => seen.path !== '/apps/new');
    expect(mocks.createApp).toHaveBeenCalledTimes(1);
    expect(seen.path).toBe('/apps/app-1/softn/edit');
  });

  it('creates nothing where apps are not hosted (the shared demo)', async () => {
    await render(true);
    expect(nameField().disabled).toBe(true);
    expect(createButton().disabled).toBe(true);
  });
});
