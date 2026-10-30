import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  installNativeStarter: vi.fn(),
  saveNativeProject: vi.fn(),
  importNativeProject: vi.fn(),
  demo: false,
}));
vi.mock('./api', () => ({ api: { installNativeStarter: mocks.installNativeStarter, saveNativeProject: mocks.saveNativeProject, isDemoMode: () => mocks.demo } }));
vi.mock('./nativeHosting', () => ({ importNativeProject: mocks.importNativeProject }));
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ createApp: mocks.createApp, error: null }) } }));

const { createSoftnApp, isSoftnApp, projectHasBackend, softnWorkspacePath } = await import('./softnApps');

const app = { id: 'app-1', name: 'Recipes', slug: 'recipes', settings: { softnApp: true } };
const project = { version: 1, files: { 'manifest.json': '{}' }, assets: {}, access: 'members', home: true };

beforeEach(() => {
  for (const mock of [mocks.createApp, mocks.installNativeStarter, mocks.saveNativeProject, mocks.importNativeProject]) mock.mockReset();
  mocks.demo = false;
  mocks.createApp.mockResolvedValue(app);
});

describe('createSoftnApp', () => {
  it('creates an app marked as a SoftN app and installs the starter as its first version', async () => {
    mocks.installNativeStarter.mockResolvedValue({ data: { project } });
    const created = await createSoftnApp({ name: '  Recipes ', description: ' Favourites ', start: { kind: 'starter' } });
    expect(mocks.createApp).toHaveBeenCalledWith({ name: 'Recipes', description: 'Favourites', settings: { softnApp: true } });
    expect(mocks.installNativeStarter).toHaveBeenCalledWith('app-1');
    expect(created).toEqual({ app, project });
  });

  it('installs an uploaded file for members only, open at the app address', async () => {
    mocks.importNativeProject.mockResolvedValue({ version: 0, files: { 'manifest.json': '{}' }, assets: {}, access: 'application' });
    mocks.saveNativeProject.mockResolvedValue({ data: { project } });
    const file = new File([new Uint8Array([1])], 'coffee.softn');
    await createSoftnApp({ name: 'Coffee', start: { kind: 'upload', file } });
    expect(mocks.saveNativeProject).toHaveBeenCalledWith('app-1', { version: 0, files: { 'manifest.json': '{}' }, assets: {}, access: 'members', home: true }, 0);
  });

  it('creates nothing for a file this host cannot take', async () => {
    mocks.importNativeProject.mockRejectedValue(new Error('This file is a FormLogic app project with backend actions, not a SoftN app.'));
    await expect(createSoftnApp({ name: 'Coffee', start: { kind: 'upload', file: new File([], 'x.softn') } })).rejects.toThrow('backend actions');
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('names an uploaded app after the app it carries when no name is given', async () => {
    mocks.importNativeProject.mockResolvedValue({ version: 0, files: { 'manifest.json': JSON.stringify({ name: 'Field notes', main: 'ui/main.ui' }) }, assets: {}, access: 'application' });
    mocks.saveNativeProject.mockResolvedValue({ data: { project } });
    await createSoftnApp({ name: '  ', start: { kind: 'upload', file: new File([new Uint8Array([1])], 'fieldnotes.softn') } });
    expect(mocks.createApp).toHaveBeenCalledWith({ name: 'Field notes', description: undefined, settings: { softnApp: true } });
  });

  it('creates nothing in the shared demo, whose apps stay in the browser', async () => {
    mocks.demo = true;
    await expect(createSoftnApp({ name: 'Coffee', start: { kind: 'upload', file: new File([], 'x.softn') } })).rejects.toThrow('available after sign-up');
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.importNativeProject).not.toHaveBeenCalled();
  });

  it('keeps the app and says why when its first version could not be installed', async () => {
    mocks.installNativeStarter.mockResolvedValue({ error: 'The server needs the native app runtime installed.' });
    const created = await createSoftnApp({ name: 'Recipes', start: { kind: 'starter' } });
    expect(created).toEqual({ app, project: null, error: 'The server needs the native app runtime installed.' });
  });
});

describe('isSoftnApp and its workspace', () => {
  it('reads the settings flag, and nothing else, as a SoftN app', () => {
    expect(isSoftnApp({ settings: { softnApp: true } as never })).toBe(true);
    expect(isSoftnApp({ settings: { appKind: 'custom' } as never })).toBe(false);
    expect(isSoftnApp(null)).toBe(false);
    expect(softnWorkspacePath('a-1')).toBe('/apps/a-1/softn');
  });

  it('reads a backend from the manifest\'s server block, and nothing else', () => {
    const withManifest = (manifest: string) => ({ version: 0, files: { 'manifest.json': manifest }, assets: {}, access: 'application' as const });
    expect(projectHasBackend(withManifest(JSON.stringify({ main: 'ui/main.ui', server: { entry: 'server/main.logic' } })))).toBe(true);
    expect(projectHasBackend(withManifest(JSON.stringify({ main: 'ui/main.ui' })))).toBe(false);
    expect(projectHasBackend(withManifest('not json'))).toBe(false);
  });
});
