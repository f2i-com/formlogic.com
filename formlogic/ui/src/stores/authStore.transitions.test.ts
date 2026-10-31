// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ login: vi.fn(), logout: vi.fn(async () => ({})), getMe: vi.fn(), lockVault: vi.fn(), lockLocalVault: vi.fn(), vaultState: vi.fn(), oaiy: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { login: calls.login, logout: calls.logout, getMe: calls.getMe, onSessionExpired: vi.fn(), removeSessionExpiredCallback: vi.fn(), setAuthenticated: vi.fn(), setDemoMode: vi.fn() } }));
vi.mock('./formStore', () => ({ useFormStore: { setState: vi.fn(), getState: () => ({ storageMode: 'api', forms: [], deviceFormsOwner: null }) }, clearAllDebounceTimers: vi.fn() }));
vi.mock('./appStore', () => ({ useAppStore: { setState: vi.fn() } }));
vi.mock('./appUserStore', () => ({ useAppUserStore: { getState: () => ({ reset: vi.fn() }) } }));
vi.mock('./appRuntimeStore', () => ({ useAppRuntimeStore: { getState: () => ({ reset: vi.fn() }) } }));
vi.mock('./responseStore', () => ({ useResponseStore: { setState: vi.fn() } }));
vi.mock('./vaultStore', () => ({ lockVaultForSessionTeardown: calls.lockVault, useVaultStore: { setState: calls.vaultState, getState: () => ({ lock: calls.lockLocalVault }) } }));
vi.mock('../client-runtime/oaiy/oaiyRuntime', () => ({ setOaiyToken: calls.oaiy, setOaiyTokenAccount: vi.fn(), forgetOaiyTokenOf: vi.fn() }));
vi.mock('../client-runtime/offlineQueue', () => ({ purgeQueueForOwner: vi.fn(async () => {}) }));
vi.mock('../client-runtime/nativeOfflineQueue', () => ({ purgeNativeQueue: vi.fn(async () => {}) }));
vi.mock('./toastStore', () => ({ toast: { warning: vi.fn() } }));
import { handleSessionBroadcast, useAuthStore } from './authStore';
import { currentSessionGeneration } from '../lib/sessionGeneration';
import { nativeAppStorage } from '../lib/nativeAppStorage';
const KEY = 'formlogic-session-transition';
const user = (id: string) => ({ id, email: `${id}@example.test` });
const messages: Record<string, unknown>[] = [];
const handle = handleSessionBroadcast as (data: Record<string, unknown>) => Promise<void>;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); messages.length = 0;
  useAuthStore.setState({ user: user('a'), isLoading: false, isInitialized: true });
  vi.stubGlobal('BroadcastChannel', class { postMessage(value: Record<string, unknown>) { messages.push(value); } close() {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState({ user: null }); });

it('successful A-to-B sign-in announces the new cookie identity without broadcasting credentials', async () => {
  calls.login.mockResolvedValue({ data: { user: user('b') } });
  expect((await useAuthStore.getState().login('b@example.test', 'synthetic-password')).success).toBe(true);
  const transition = messages.find(value => value.type === 'fl-session-transition');
  expect(transition).toMatchObject({ userId: 'b' });
  expect(typeof transition?.revision).toBe('string');
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(transition);
  expect(JSON.stringify(transition)).not.toContain('synthetic-password');
});
it('a current cross-tab identity transition signs out a mismatched local member', async () => {
  const transition = { type: 'fl-session-transition', userId: 'b', revision: 'revision-b' };
  localStorage.setItem(KEY, JSON.stringify(transition));
  await handle(transition);
  expect(useAuthStore.getState().user).toBeNull();
  expect(messages).toEqual([]);
});
it('a same-member current transition fences runtime work without forgetting the member identity', async () => {
  const transition = { type: 'fl-session-transition', userId: 'a', revision: 'revision-a-new' };
  localStorage.setItem(KEY, JSON.stringify(transition)); const generation = currentSessionGeneration();
  await handle(transition);
  expect(useAuthStore.getState().user?.id).toBe('a');
  expect(currentSessionGeneration()).toBeGreaterThan(generation);
});
it('an older same-member logout broadcast cannot terminate a newer successful sign-in', async () => {
  await useAuthStore.getState().logout();
  const old = messages.find(value => value.type === 'fl-teardown');
  expect(old?.revision).toEqual(expect.any(String));
  calls.login.mockResolvedValue({ data: { user: user('a') } });
  await useAuthStore.getState().login('a@example.test', 'synthetic-password');
  const generation = currentSessionGeneration();
  await handle(old!);
  expect(useAuthStore.getState().user?.id).toBe('a'); expect(currentSessionGeneration()).toBe(generation);
});
it('rejects a versioned teardown whose shared marker belongs to another revision', async () => {
  localStorage.setItem(KEY, JSON.stringify({ type: 'fl-session-transition', userId: 'a', revision: 'new' }));
  await handle({ type: 'fl-teardown', userId: 'a', reason: 'logout', revision: 'old' });
  expect(useAuthStore.getState().user?.id).toBe('a');
});
it('never hydrates a principal from a transition message', async () => {
  useAuthStore.setState({ user: null });
  const transition = { type: 'fl-session-transition', userId: 'b', revision: 'remote-b' };
  localStorage.setItem(KEY, JSON.stringify(transition)); await handle(transition);
  expect(useAuthStore.getState().user).toBeNull();
});

it('a remote logout also cancels an in-flight sign-in when this tab has no user yet', async () => {
  useAuthStore.setState({ user: null });
  let resolve!: (value: unknown) => void;
  calls.login.mockReturnValue(new Promise(r => { resolve = r; }));
  const pending = useAuthStore.getState().login('a@example.test', 'synthetic-password');
  const transition = { type: 'fl-teardown', userId: 'a', reason: 'logout', revision: 'logout-during-login' };
  localStorage.setItem(KEY, JSON.stringify(transition)); await handle(transition);
  resolve({ data: { user: user('a') } });
  expect((await pending).success).toBe(false);
  expect(useAuthStore.getState().user).toBeNull();
  expect(useAuthStore.getState().isLoading).toBe(false);
});

it('a storage event cancels startup loading without installing the other tab identity', async () => {
  useAuthStore.setState({ user: null, isLoading: true });
  const transition = { type: 'fl-session-transition', userId: 'b', revision: 'storage-event-b' };
  localStorage.setItem(KEY, JSON.stringify(transition));
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: JSON.stringify(transition) }));
  expect(useAuthStore.getState().user).toBeNull();
  expect(useAuthStore.getState().isLoading).toBe(false);
});

it('locks the old vault and pairing token before cleanup yields to another identity', async () => {
  const pending = useAuthStore.getState().logout();
  expect(calls.lockVault).toHaveBeenCalledTimes(1);
  expect(calls.vaultState).toHaveBeenCalledWith({ status: 'unknown', vault: null });
  expect(calls.oaiy).toHaveBeenCalledWith(null);
  useAuthStore.setState({ user: user('b') });
  vi.clearAllMocks(); await pending;
  expect(calls.lockVault).not.toHaveBeenCalled();
  expect(calls.oaiy).not.toHaveBeenCalled();
});

it('marks a broadcast unordered when the shared ordering marker could not be written', async () => {
  localStorage.setItem(KEY, JSON.stringify({ type: 'fl-session-transition', userId: 'a', revision: 'older' }));
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === KEY) throw new Error('synthetic marker quota');
    return original.call(this, key, value);
  });
  await useAuthStore.getState().logout();
  expect(messages.find(value => value.type === 'fl-teardown')).toMatchObject({ ordered: false });
});

it('does not let an older retained marker suppress a current unordered boundary', async () => {
  localStorage.setItem(KEY, JSON.stringify({ type: 'fl-session-transition', userId: 'a', revision: 'older-retained' }));
  await handle({ type: 'fl-teardown', userId: 'a', reason: 'logout', revision: 'uncommitted-remote', ordered: false });
  expect(useAuthStore.getState().user).toBeNull();
});

it('a remote A-to-B transition clears this tab memory without erasing B shared snapshots', async () => {
  const transition = { type: 'fl-session-transition', userId: 'b', revision: 'b-shared-origin' };
  localStorage.setItem(KEY, JSON.stringify(transition));
  const bAuth = JSON.stringify({ state: { user: user('b') }, version: 0 });
  localStorage.setItem('formlogic-auth', bAuth);
  localStorage.setItem('formlogic-forms', 'synthetic-b-forms');
  localStorage.setItem('formlogic-apps', 'synthetic-b-apps');
  localStorage.setItem('formlogic-applogic-b', 'synthetic-b-app-logic');
  await handle(transition);
  expect(useAuthStore.getState().user).toBeNull();
  expect(localStorage.getItem('formlogic-auth')).toBe(bAuth);
  expect(localStorage.getItem('formlogic-forms')).toBe('synthetic-b-forms');
  expect(localStorage.getItem('formlogic-apps')).toBe('synthetic-b-apps');
  expect(localStorage.getItem('formlogic-applogic-b')).toBe('synthetic-b-app-logic');
});

it.each(['network-result', 'network-rejection'])('unconfirmed startup %s fences access but preserves same-member saved data', async failure => {
  const open = () => nativeAppStorage('cafe', { access: 'members', appId: 'app-one', userId: 'a' });
  const old = open(); old.mutate({ operation: 'set', key: 'session', value: 'offline-synthetic-a' });
  useAuthStore.setState({ isInitialized: false });
  if (failure === 'network-result') calls.getMe.mockResolvedValue({ error: 'offline' });
  else calls.getMe.mockRejectedValue(new Error('offline'));
  await useAuthStore.getState().initialize();
  expect(useAuthStore.getState().user).toBeNull();
  expect(() => old.read()).toThrow();
  calls.login.mockResolvedValue({ data: { user: user('a') } });
  await useAuthStore.getState().login('a@example.test', 'synthetic');
  expect(open().read()).toEqual({ session: 'offline-synthetic-a' });
});

it('a later logout removes the member cached during an unconfirmed startup', async () => {
  const open = () => nativeAppStorage('cafe', { access: 'members', appId: 'app-one', userId: 'a' });
  open().mutate({ operation: 'set', key: 'session', value: 'offline-synthetic-a' });
  useAuthStore.setState({ isInitialized: false }); calls.getMe.mockResolvedValue({ error: 'offline' });
  await useAuthStore.getState().initialize();
  await useAuthStore.getState().logout();
  useAuthStore.setState({ user: user('a') });
  expect(open().read()).toEqual({});
});

it('someone else signing in after an unconfirmed startup leaves that member their data', async () => {
  const open = () => nativeAppStorage('cafe', { access: 'members', appId: 'app-one', userId: 'a' });
  open().mutate({ operation: 'set', key: 'session', value: 'offline-synthetic-a' });
  useAuthStore.setState({ isInitialized: false }); calls.getMe.mockResolvedValue({ error: 'offline' });
  await useAuthStore.getState().initialize();
  calls.login.mockResolvedValue({ data: { user: user('b') } });
  await useAuthStore.getState().login('b@example.test', 'synthetic');
  expect(nativeAppStorage('cafe', { access: 'members', appId: 'app-one', userId: 'b' }).read()).toEqual({});
  useAuthStore.setState({ user: user('a') });
  expect(open().read()).toEqual({ session: 'offline-synthetic-a' });
});

it('remote cleanup locks this tab vault without broadcasting a second lock to the new account', async () => {
  const transition = { type: 'fl-session-transition', userId: 'b', revision: 'local-vault-cleanup' };
  localStorage.setItem(KEY, JSON.stringify(transition)); await handle(transition);
  expect(calls.lockLocalVault).toHaveBeenCalledWith(false);
  expect(calls.vaultState).toHaveBeenCalledWith({ status: 'unknown', vault: null });
  expect(calls.lockVault).not.toHaveBeenCalled();
});
