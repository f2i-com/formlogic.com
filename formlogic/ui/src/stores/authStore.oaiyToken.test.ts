// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OAIY token drives the operator's real hardware. It is kept for an account so
// that signing out and back in asks for no new code, and that is only safe if the
// session boundary hides it from everyone else, the shared demo account above all.
vi.mock('../client-runtime/offlineQueue', () => ({ purgeQueueForOwner: vi.fn(async () => {}), unsentCountFor: vi.fn(async () => 0) }));
vi.mock('../client-runtime/nativeOfflineQueue', () => ({ purgeNativeQueue: vi.fn(async () => {}), nativeUnsentCount: vi.fn(async () => 0) }));
vi.mock('../components/chat/chatStore', () => ({ deleteChatDataForUser: vi.fn(async () => {}) }));
vi.mock('./vaultStore', () => ({ lockVaultForSessionTeardown: vi.fn(), useVaultStore: { setState: vi.fn(), getState: () => ({ lock: vi.fn() }) } }));
vi.mock('../lib/api', () => {
  const named: Record<string, unknown> = { logout: vi.fn(async () => ({})) };
  return {
    api: new Proxy(named, { get: (target, key: string) => (key in target ? target[key] : (target[key] = vi.fn(() => false))) }),
    newIdempotencyKey: () => 'key',
  };
});

import { getOaiyToken, setOaiyToken } from '../client-runtime/oaiy/oaiyRuntime';
import { teardownUserSession, useAuthStore } from './authStore';

const alice = { id: 'alice', email: 'alice@example.test' };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useAuthStore.setState({ user: alice });
  setOaiyToken('alice-token');
});
afterEach(() => {
  useAuthStore.setState({ user: null });
});

describe('the OAIY token at the session boundary', () => {
  it('follows the signed-in account', () => {
    useAuthStore.setState({ user: { id: 'bob', email: 'bob@example.test' } });
    expect(getOaiyToken()).toBeNull();
    useAuthStore.setState({ user: alice });
    expect(getOaiyToken()).toBe('alice-token');
  });

  it('is never the demo account\'s', () => {
    useAuthStore.setState({ user: { id: 'alice', email: 'demo@example.test', isDemo: true } });
    expect(getOaiyToken()).toBeNull();
  });

  it.each(['logout', 'session-expired'] as const)('is out of reach after %s and back with its owner', async (reason) => {
    useAuthStore.setState({ user: null });
    await teardownUserSession('alice', reason, false);
    expect(getOaiyToken()).toBeNull();
    useAuthStore.setState({ user: { id: 'bob', email: 'bob@example.test' } });
    expect(getOaiyToken()).toBeNull();
    useAuthStore.setState({ user: alice });
    expect(getOaiyToken()).toBe('alice-token');
  });

  it('survives another tab\'s sign-out, which clears memory only', async () => {
    useAuthStore.setState({ user: null });
    await teardownUserSession('alice', 'remote-teardown', false, true);
    useAuthStore.setState({ user: alice });
    expect(getOaiyToken()).toBe('alice-token');
  });

  it('is erased when its account is deleted', async () => {
    useAuthStore.setState({ user: null });
    await teardownUserSession('alice', 'account-deleted', false);
    useAuthStore.setState({ user: alice });
    expect(getOaiyToken()).toBeNull();
  });

  it('drops what a tab held for no account, as it always did', async () => {
    useAuthStore.setState({ user: null });
    setOaiyToken('tab-token');
    await teardownUserSession('alice', 'logout', false);
    expect(getOaiyToken()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
