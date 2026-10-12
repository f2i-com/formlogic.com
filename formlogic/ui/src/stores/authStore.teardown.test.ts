import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Submissions queued on the device hold the person's answers in plain text, and a row left behind
// is sent with whoever signs in next. Signing out, deleting the account and a sign-out in another
// tab remove them; a session that merely expired keeps them, so the same person can sign back in
// and send what they queued (often offline, which is exactly when a session runs out).
const queues = vi.hoisted(() => ({
  purgeBrowser: vi.fn(async (userId: string | null) => { void userId; }),
  purgeNative: vi.fn(async () => {}),
  browserCount: vi.fn(async (userId: string | null) => (userId ? 2 : 0)),
  nativeCount: vi.fn(async () => 1),
}));
vi.mock('../client-runtime/offlineQueue', () => ({
  purgeQueueForOwner: queues.purgeBrowser,
  unsentCountFor: queues.browserCount,
}));
vi.mock('../client-runtime/nativeOfflineQueue', () => ({
  purgeNativeQueue: queues.purgeNative,
  nativeUnsentCount: queues.nativeCount,
}));
vi.mock('../components/chat/chatStore', () => ({ deleteChatDataForUser: vi.fn(async () => {}) }));
vi.mock('./vaultStore', () => ({ lockVaultForSessionTeardown: vi.fn(), useVaultStore: { setState: vi.fn() } }));
vi.mock('../client-runtime/oaiy/oaiyRuntime', async (original) => ({
  ...(await original<typeof import('../client-runtime/oaiy/oaiyRuntime')>()),
  setOaiyToken: vi.fn(),
}));
// The stores this teardown resets read a good many api flags; every one not named here answers false.
vi.mock('../lib/api', () => {
  const named: Record<string, unknown> = { logout: vi.fn(async () => ({})) };
  return {
    api: new Proxy(named, { get: (target, key: string) => (key in target ? target[key] : (target[key] = vi.fn(() => false))) }),
    newIdempotencyKey: () => 'key',
  };
});

import { handleSessionBroadcast, teardownUserSession, unsentSubmissionsOnSignOut, useAuthStore } from './authStore';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  useAuthStore.setState({ user: null });
});

describe('queued submissions at the end of a session', () => {
  it.each(['logout', 'account-deleted'] as const)('are removed on %s, for the account that leaves', async (reason) => {
    await teardownUserSession('u1', reason, false);
    expect(queues.purgeBrowser).toHaveBeenCalledWith('u1');
    expect(queues.purgeNative).toHaveBeenCalledTimes(1);
  });

  it('are kept when the session only expired', async () => {
    await teardownUserSession('u1', 'session-expired', false);
    expect(queues.purgeBrowser).not.toHaveBeenCalled();
    expect(queues.purgeNative).not.toHaveBeenCalled();
  });

  it('are removed when the person signs out from the menu', async () => {
    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
    await useAuthStore.getState().logout();
    expect(queues.purgeBrowser).toHaveBeenCalledWith('u1');
    expect(queues.purgeNative).toHaveBeenCalledTimes(1);
  });

  it('are counted, before the sign-out, for the warning: exactly what the sign-out removes', async () => {
    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
    expect(await unsentSubmissionsOnSignOut()).toBe(3);
    expect(queues.browserCount).toHaveBeenCalledWith('u1');
  });
});

describe('a sign-out in another tab', () => {
  it('removes the account’s queued submissions here too', async () => {
    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
    await handleSessionBroadcast({ type: 'fl-teardown', reason: 'logout', userId: 'u1' });
    expect(useAuthStore.getState().user).toBeNull();
    expect(queues.purgeBrowser).toHaveBeenCalledWith('u1');
    expect(queues.purgeNative).toHaveBeenCalledTimes(1);
  });

  it('names this tab’s account when an older tab sent no id', async () => {
    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
    await handleSessionBroadcast({ type: 'fl-teardown', reason: 'logout' });
    expect(queues.purgeBrowser).toHaveBeenCalledWith('u1');
  });

  it('keeps them when the other tab’s session only expired', async () => {
    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
    await handleSessionBroadcast({ type: 'fl-teardown', reason: 'session-expired', userId: 'u1' });
    expect(useAuthStore.getState().user).toBeNull();
    expect(queues.purgeBrowser).not.toHaveBeenCalled();
    expect(queues.purgeNative).not.toHaveBeenCalled();
  });
});
