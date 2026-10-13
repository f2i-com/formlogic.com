// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), frame: vi.fn(), slug: 'app' }));
vi.mock('../../lib/api', () => ({ api: { getHostedRuntime: mocks.get } }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ appSlug: mocks.slug }), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('../../components/studio/HostedAppFrame', () => ({ HostedAppFrame: (props: unknown) => { mocks.frame(props); return <div data-frame="mounted" />; } }));
import HostedAppPage from './HostedAppPage';
import { HostedDashboardHome } from '../../components/app-runtime/HostedDashboardHome';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const actor = { version: 1, appId: 'app-a', userId: 'alice', roleId: 'member', isOwner: false, sessionId: 'a'.repeat(64) };
const data = (identity: unknown = actor) => ({ actor: identity, name: 'Private app', deployment: { version: 1, client: { 'manifest.json': '{}' } } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); mocks.slug = 'app'; setSessionOwner('alice'); bumpSessionGeneration(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
for (const surface of ['page', 'dashboard']) {
  const mount = () => act(async () => root.render(surface === 'page' ? <HostedAppPage /> : <HostedDashboardHome slug={mocks.slug} />));
  it.each([undefined, null, {}, { ...actor, userId: 'bob' }])(`${surface} refuses missing or wrong-user runtime identity %#`, async identity => {
    mocks.get.mockResolvedValue({ data: { ...data(), actor: identity } }); await mount(); expect(mocks.frame).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it(`${surface} clears immediately and refetches for same-user session changes`, async () => {
    mocks.get.mockResolvedValueOnce({ data: data() }).mockReturnValue(new Promise(() => {})); await mount(); expect(container.querySelector('[data-frame]')).not.toBeNull();
    await act(async () => { bumpSessionGeneration(); }); expect(container.querySelector('[data-frame]')).toBeNull(); expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it(`${surface} drops late A GET after B signs in`, async () => {
    const late = deferred<unknown>(); mocks.get.mockReturnValueOnce(late.promise).mockResolvedValue({ error: 'Denied' }); await mount();
    await act(async () => setSessionOwner('bob')); await act(async () => late.resolve({ data: data() })); expect(mocks.frame).not.toHaveBeenCalled();
  });
  it(`${surface} does not lend old app source to a new slug`, async () => {
    mocks.get.mockResolvedValueOnce({ data: data() }).mockReturnValue(new Promise(() => {})); await mount(); mocks.frame.mockClear(); mocks.slug = 'other'; await mount();
    expect(mocks.frame).not.toHaveBeenCalled(); expect(container.querySelector('[data-frame]')).toBeNull();
  });
  it(`${surface} preserves trusted admission from GET`, async () => {
    mocks.get.mockResolvedValue({ data: data() }); await mount(); expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ hostedAdmission: expect.objectContaining({ slug: 'app', actor }) }));
  });
}
