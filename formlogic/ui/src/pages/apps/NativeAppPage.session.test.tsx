// @vitest-environment jsdom
import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), frame: vi.fn(), userId: 'alice', listeners: new Set<() => void>() }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.get } }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ appSlug: 'notes' }), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => {
  const id = useSyncExternalStore(listener => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); }, () => mocks.userId);
  return selector({ user: id ? { id } : null });
} }));
vi.mock('../../components/studio/HostedAppFrame', () => ({ HostedAppFrame: (props: unknown) => { mocks.frame(props); return <div data-frame="mounted" />; } }));
import NativeAppPage from './NativeAppPage';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const scope = { access: 'members', appId: 'app-123', userId: 'alice' };
const project = (storageScope: unknown = scope, access = 'members') => ({ version: 1, client: { 'manifest.json': '{}' }, assets: {}, access, storageScope });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function mount() { await act(async () => root.render(<NativeAppPage />)); }
async function owner(id: string) { await act(async () => { setSessionOwner(id || null); bumpSessionGeneration(); mocks.userId = id; for (const listener of mocks.listeners) listener(); }); }
beforeEach(() => { vi.resetAllMocks(); mocks.userId = 'alice'; setSessionOwner('alice'); bumpSessionGeneration(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it('passes the exact admitted server scope and access to the native frame', async () => {
  mocks.get.mockResolvedValue({ data: { project: project() } }); await mount();
  expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ native: expect.objectContaining({ access: 'members', storageScope: scope }) }));
});
it.each([undefined, null, {}, { access: 'members', appId: 'app-123' }, { access: 'members', appId: 'app-123', userId: 'bob' }, { access: 'application', appId: 'app-123' }, { access: 'members', appId: '', userId: 'alice' }])('refuses missing, malformed or mismatched scope %j before mounting', async bad => {
  mocks.get.mockResolvedValue({ data: { project: { ...project(), storageScope: bad } } }); await mount();
  expect(mocks.frame).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it('preserves application-mode anonymous access with the admitted app scope', async () => {
  await owner(''); const application = { access: 'application', appId: 'app-123' };
  mocks.get.mockResolvedValue({ data: { project: project(application, 'application') } }); await mount();
  expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ native: expect.objectContaining({ storageScope: application }) }));
});
it('does not adopt a late account A GET after account B signs in', async () => {
  const late = deferred<unknown>(); mocks.get.mockReturnValueOnce(late.promise).mockResolvedValue({ error: 'Denied' }); await mount(); await owner('bob');
  await act(async () => late.resolve({ data: { project: project() } })); expect(mocks.frame).not.toHaveBeenCalled();
});
it('does not adopt a GET from an ended session when the same account signs in again', async () => {
  const old = deferred<unknown>(); const fresh = deferred<unknown>(); mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise); await mount();
  await act(async () => { bumpSessionGeneration(); });
  await act(async () => old.resolve({ data: { project: project() } })); expect(mocks.frame).not.toHaveBeenCalled();
  await act(async () => fresh.resolve({ data: { project: project() } })); expect(mocks.frame).toHaveBeenCalledTimes(1);
});
it('removes admitted member UI immediately on a session boundary even with the same owner', async () => {
  mocks.get.mockResolvedValueOnce({ data: { project: project() } }).mockReturnValue(new Promise(() => undefined)); await mount();
  expect(container.querySelector('[data-frame]')).not.toBeNull();
  await act(async () => { bumpSessionGeneration(); }); expect(container.querySelector('[data-frame]')).toBeNull();
});
it('keeps explicit server denial instead of mounting any supplied project', async () => {
  mocks.get.mockResolvedValue({ error: 'Membership required', data: { project: project() } }); await mount();
  expect(mocks.frame).not.toHaveBeenCalled(); expect(container.textContent).toContain('Membership required');
});
it('shows a bounded failure when a runtime GET rejects', async () => {
  mocks.get.mockRejectedValue(new Error('offline')); await mount();
  expect(mocks.frame).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
