// @vitest-environment jsdom
/**
 * The SoftN app workspace: an app with nothing installed starts from its setup choices; one
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
  editor: null as null | { kind: string; brief?: unknown; applyLabel?: string; onApply(bytes: Uint8Array): Promise<void>; onClose(): void },
}));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
vi.mock('../../lib/api', () => ({ api: {
  getNativeProject: mocks.getNativeProject, saveNativeProject: mocks.saveNativeProject, installNativeStarter: mocks.installNativeStarter, publishApp: mocks.publishApp,
  isAdminActing: () => false, isDemoMode: () => false,
} }));
vi.mock('../../hooks/useAiReady', () => ({ useAiReady: () => ({ ready: true, reason: null, recheck: async () => true }) }));
vi.mock('../../lib/nativeHosting', () => ({
  exportNativeProject: () => new Uint8Array([1]),
  importNativeProject: async () => ({ version: 0, files: { 'manifest.json': '{"id":"a"}', 'ui/main.ui': '<Text>Changed</Text>' }, assets: {}, access: 'application' }),
}));
vi.mock('../../components/studio/AppEditorDialog', () => ({
  AppEditorDialog: (props: NonNullable<typeof mocks.editor>) => { mocks.editor = props; return <p>editor:{props.kind}</p>; },
}));
vi.mock('../../components/studio/NativeRecordsBrowser', () => ({ NativeRecordsBrowser: () => <p>records</p> }));
vi.mock('../../components/studio/AppEngineSelect', () => ({ AppEngineSelect: () => null }));
vi.mock('../../components/studio/NativeAppPanel', () => ({ NativeEditor: () => <p>source editor</p> }));

const { SoftnAppWorkspace } = await import('./SoftnAppWorkspace');
const { useAppStore } = await import('../../stores/appStore');
const { useUIStore } = await import('../../stores/uiStore');

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
  useUIStore.getState().setSoftnOpen(null);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render(status: 'draft' | 'published', project: NativeProject | null) {
  useAppStore.setState({ apps: [app(status)] as never, fetchApps: vi.fn(async () => {}) });
  mocks.getNativeProject.mockResolvedValue({ data: { available: true, ready: true, preflight: { ok: true, checks: [] }, project } });
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={['/apps/app-1/softn']}><Routes><Route path="/apps/:appId/softn" element={<SoftnAppWorkspace />} /></Routes></MemoryRouter>));
  await act(async () => {});
}
const button = (text: RegExp) => [...document.body.querySelectorAll('button')].find(b => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

describe('SoftnAppWorkspace', () => {
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
    await act(async () => mocks.editor!.onClose());
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
    expect(container.textContent).toContain('Not published');
    await act(async () => button(/^Publish$/)!.click());
    expect(mocks.publishApp).toHaveBeenCalledWith('app-1');
  });
});
