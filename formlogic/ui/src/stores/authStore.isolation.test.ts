// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  logout: vi.fn(async () => ({})), login: vi.fn(), getMe: vi.fn(), updateProfile: vi.fn(),
  expiry: null as null | (() => void),
  forms: vi.fn(), apps: vi.fn(), appUsers: vi.fn(), runtime: vi.fn(), responses: vi.fn(),
  purgeBrowser: vi.fn(async () => {}), purgeNative: vi.fn(async () => {}),
}));
vi.mock('../lib/api', () => ({ api: {
  logout: calls.logout, login: calls.login, getMe: calls.getMe, updateProfile: calls.updateProfile,
  onSessionExpired: (cb: () => void) => { calls.expiry = cb; }, removeSessionExpiredCallback: vi.fn(),
  setAuthenticated: vi.fn(), setDemoMode: vi.fn(),
} }));
vi.mock('./formStore', () => ({ useFormStore: { setState: calls.forms }, clearAllDebounceTimers: vi.fn() }));
vi.mock('./appStore', () => ({ useAppStore: { setState: calls.apps } }));
vi.mock('./appUserStore', () => ({ useAppUserStore: { getState: () => ({ reset: calls.appUsers }) } }));
vi.mock('./appRuntimeStore', () => ({ useAppRuntimeStore: { getState: () => ({ reset: calls.runtime }) } }));
vi.mock('./responseStore', () => ({ useResponseStore: { setState: calls.responses } }));
vi.mock('./vaultStore', () => ({ lockVaultForSessionTeardown: vi.fn(), useVaultStore: { setState: vi.fn() } }));
vi.mock('../client-runtime/oaiy/oaiyRuntime', () => ({ setOaiyToken: vi.fn() }));
vi.mock('../client-runtime/offlineQueue', () => ({ purgeQueueForOwner: calls.purgeBrowser }));
vi.mock('../client-runtime/nativeOfflineQueue', () => ({ purgeNativeQueue: calls.purgeNative }));
vi.mock('../components/chat/chatStore', () => ({ deleteChatDataForUser: vi.fn(async () => {}) }));
vi.mock('./toastStore', () => ({ toast: { warning: vi.fn() } }));

import { handleSessionBroadcast, teardownUserSession, useAuthStore } from './authStore';
import { nativeAppStorage } from '../lib/nativeAppStorage';
import { currentSessionGeneration, isSessionGenerationCurrent } from '../lib/sessionGeneration';
const open = nativeAppStorage as unknown as (slug: string, scope: unknown) => ReturnType<typeof nativeAppStorage>;
const user = (id: string) => ({ id, email: `${id}@example.test` });
const member = (id = 'a') => open('cafe', { access: 'members', appId: 'app-one', userId: id });
const app = () => open('cafe', { access: 'application', appId: 'app-one' });
const save = (value: ReturnType<typeof open>, secret = 'synthetic-session') => value.mutate({ operation: 'set', key: 'session', value: secret });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  useAuthStore.setState({ user: null, isLoading: false, isInitialized: false, error: null });
  localStorage.clear(); vi.clearAllMocks(); calls.logout.mockResolvedValue({});
  useAuthStore.setState({ user: user('a') });
});
afterEach(() => { vi.restoreAllMocks(); useAuthStore.setState({ user: null }); });

describe('native member state at actual auth-store boundaries', () => {
  it.each(['logout', 'session-expired', 'account-deleted', 'remote-teardown'] as const)('purges the leaving member synchronously on %s while preserving application mode', async reason => {
    save(member()); save(app(), 'independent');
    const old = member(); const generation = currentSessionGeneration();
    const pending = teardownUserSession('a', reason, false);
    expect(isSessionGenerationCurrent(generation)).toBe(false);
    expect(() => old.read()).toThrow();
    expect(app().read()).toEqual({ session: 'independent' });
    expect(member().read()).toEqual({});
    await pending;
  });
  it('logout fences callbacks and removes the private map before awaiting the API', async () => {
    const endpoint = deferred<Record<string, never>>(); calls.logout.mockReturnValue(endpoint.promise);
    save(member()); const old = member(); const generation = currentSessionGeneration();
    const pending = useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(isSessionGenerationCurrent(generation)).toBe(false);
    expect(() => save(old, 'late')).toThrow();
    useAuthStore.setState({ user: user('b') }); save(member('b'), 'b');
    endpoint.resolve({}); await pending;
    expect(useAuthStore.getState().user?.id).toBe('b');
    expect(member('b').read()).toEqual({ session: 'b' });
  });
  it('delayed A teardown cannot clear B or invalidate B callbacks', async () => {
    save(member()); useAuthStore.setState({ user: user('b') }); save(member('b'), 'b');
    const generation = currentSessionGeneration(); vi.clearAllMocks();
    await teardownUserSession('a', 'logout', false);
    expect(useAuthStore.getState().user?.id).toBe('b');
    expect(isSessionGenerationCurrent(generation)).toBe(true);
    expect(calls.forms).not.toHaveBeenCalled(); expect(calls.apps).not.toHaveBeenCalled();
    expect(member('b').read()).toEqual({ session: 'b' });
  });
  it('A teardown already in flight cannot clear B after its first asynchronous boundary', async () => {
    save(member()); const pending = teardownUserSession('a', 'logout', false);
    useAuthStore.setState({ user: user('b') }); save(member('b'), 'b'); vi.clearAllMocks();
    await pending;
    expect(useAuthStore.getState().user?.id).toBe('b');
    expect(calls.forms).not.toHaveBeenCalled(); expect(calls.apps).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('formlogic-auth')!).state.user.id).toBe('b');
  });
  it('a stale A broadcast leaves active B and B generation unchanged', async () => {
    useAuthStore.setState({ user: user('b') }); save(member('b'), 'b');
    const generation = currentSessionGeneration();
    await handleSessionBroadcast({ type: 'fl-teardown', reason: 'logout', userId: 'a' });
    expect(useAuthStore.getState().user?.id).toBe('b'); expect(isSessionGenerationCurrent(generation)).toBe(true);
    expect(member('b').read()).toEqual({ session: 'b' });
  });
  it.each(['logout', 'session-expired', 'account-deleted'])('a same-member %s broadcast removes private data but preserves application data', async reason => {
    save(member()); save(app(), 'independent');
    await handleSessionBroadcast({ type: 'fl-teardown', reason, userId: 'a' });
    expect(useAuthStore.getState().user).toBeNull(); expect(app().read()).toEqual({ session: 'independent' });
    useAuthStore.setState({ user: user('a') }); expect(member().read()).toEqual({});
  });
  it('a storage removal error cannot let A callbacks recreate data for B', async () => {
    const old = member(); save(old);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    await useAuthStore.getState().logout();
    useAuthStore.setState({ user: user('b') });
    expect(() => save(old, 'late')).toThrow(); expect(member('b').read()).toEqual({});
  });
  it('a direct account transition fences A and removes A while retaining same-user refresh state', () => {
    save(member()); const old = member();
    useAuthStore.setState({ user: { ...user('a'), name: 'Updated name' } });
    expect(member().read()).toEqual({ session: 'synthetic-session' });
    useAuthStore.setState({ user: user('b') }); expect(() => old.read()).toThrow();
    useAuthStore.setState({ user: user('a') }); expect(member().read()).toEqual({});
  });
  it('an old startup reply cannot replace the newer current account', async () => {
    const request = deferred<unknown>(); calls.getMe.mockReturnValue(request.promise);
    const pending = useAuthStore.getState().initialize();
    useAuthStore.setState({ user: user('b') });
    request.resolve({ data: { user: user('a') } }); await pending;
    expect(useAuthStore.getState().user?.id).toBe('b');
  });
  it('a login reply after logout cannot restore the ended account', async () => {
    const request = deferred<unknown>(); calls.login.mockReturnValue(request.promise);
    const pending = useAuthStore.getState().login('a@example.test', 'synthetic');
    await useAuthStore.getState().logout();
    request.resolve({ data: { user: user('a') } });
    expect((await pending).success).toBe(false); expect(useAuthStore.getState().user).toBeNull();
  });
  it('a profile reply authorized as A cannot replace current B', async () => {
    const request = deferred<unknown>(); calls.updateProfile.mockReturnValue(request.promise);
    const pending = useAuthStore.getState().updateProfile({ name: 'A' });
    useAuthStore.setState({ user: user('b') });
    request.resolve({ data: { user: user('a') } });
    expect((await pending).success).toBe(false); expect(useAuthStore.getState().user?.id).toBe('b');
  });
});
