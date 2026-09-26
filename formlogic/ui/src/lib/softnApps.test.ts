import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  installNativeStarter: vi.fn(),
  saveNativeProject: vi.fn(),
  importNativeProject: vi.fn(),
}));
vi.mock('./api', () => ({ api: { installNativeStarter: mocks.installNativeStarter, saveNativeProject: mocks.saveNativeProject } }));
vi.mock('./nativeHosting', () => ({ importNativeProject: mocks.importNativeProject }));
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ createApp: mocks.createApp, error: null }) } }));

const { createSoftnApp, isSoftnApp, softnWorkspacePath } = await import('./softnApps');

const app = { id: 'app-1', name: 'Recipes', slug: 'recipes', settings: { softnApp: true } };
const project = { version: 1, files: { 'manifest.json': '{}' }, assets: {}, access: 'members', home: true };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
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

  it('creates nothing for a file that is not a SoftN app with a backend', async () => {
    mocks.importNativeProject.mockRejectedValue(new Error('This app has no native server entry.'));
    await expect(createSoftnApp({ name: 'Coffee', start: { kind: 'upload', file: new File([], 'x.softn') } })).rejects.toThrow('no native server entry');
    expect(mocks.createApp).not.toHaveBeenCalled();
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
});
