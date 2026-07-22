// Vault lifecycle tests (plan §16-P2 gates): multi-tab lock propagation via
// BroadcastChannel('fl-vault'), worker termination on lock, vault-generation
// invalidation of decrypted state (the remount contract), and idle auto-lock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  api: {
    isAuthenticated: () => true,
    getVault: vi.fn(),
    createVault: vi.fn(),
    changeVaultPassphrase: vi.fn(),
  },
  newIdempotencyKey: () => 'idem-test',
}));

import { api } from '../lib/api';
import { CryptoClient, createInlineWorker, setCryptoClientForTests, getCryptoClient } from '../lib/crypto/cryptoClient';
import { useVaultStore, __resetVaultStoreForTests, DEFAULT_AUTO_LOCK_MINUTES } from './vaultStore';
import { usePrivateDataStore } from './privateDataStore';
import type { VaultWire } from '../types/e2ee';

const USER = 'user-1';
const PASS = 'correct horse battery staple';

async function makeVaultWire(): Promise<{ wire: VaultWire; recoveryDisplay: string }> {
  const client = new CryptoClient(createInlineWorker);
  const { vault, recoveryDisplay } = await client.createVault(USER, PASS);
  return { wire: vault, recoveryDisplay };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('vaultStore lock semantics', () => {
  beforeEach(() => {
    __resetVaultStoreForTests();
    usePrivateDataStore.getState().clear();
    setCryptoClientForTests(new CryptoClient(createInlineWorker));
    vi.mocked(api.getVault).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetVaultStoreForTests();
    setCryptoClientForTests(null);
  });

  async function unlockStore(wire: VaultWire): Promise<void> {
    vi.mocked(api.getVault).mockResolvedValue({ data: { vault: wire } });
    const result = await useVaultStore.getState().unlock(USER, PASS);
    expect(result.ok).toBe(true);
    expect(useVaultStore.getState().status).toBe('unlocked');
  }

  it('lock() bumps the generation and wipes the decrypted LRU (remount contract)', async () => {
    const { wire } = await makeVaultWire();
    await unlockStore(wire);
    const genBefore = useVaultStore.getState().generation;
    // Simulate decrypted content sitting in the in-memory cache.
    usePrivateDataStore.getState().setGeneration(genBefore);
    usePrivateDataStore.getState().put('rec-1', 1, { v: 1, answers: { secret: 'canary-plaintext' } });
    expect(usePrivateDataStore.getState().get('rec-1')).toBeDefined();

    useVaultStore.getState().lock();

    expect(useVaultStore.getState().generation).toBeGreaterThan(genBefore);
    expect(useVaultStore.getState().status).toBe('locked');
    expect(usePrivateDataStore.getState().get('rec-1')).toBeUndefined();
    expect(usePrivateDataStore.getState().generation).toBe(useVaultStore.getState().generation);
  });

  it('lock() terminates the crypto worker (fresh worker on next op)', async () => {
    const { wire } = await makeVaultWire();
    await unlockStore(wire);
    const client = getCryptoClient();
    expect(client.isRunning).toBe(true);
    expect((await client.status()).unlocked).toBe(true);

    useVaultStore.getState().lock();
    await flushAsync();

    expect(client.isRunning).toBe(false);
    expect((await client.status()).unlocked).toBe(false);
  });

  it('lock() broadcasts on fl-vault so other tabs lock too', async () => {
    const { wire } = await makeVaultWire();
    await unlockStore(wire);

    // A "second tab" listener on the same channel name.
    const received: unknown[] = [];
    const otherTab = new BroadcastChannel('fl-vault');
    otherTab.onmessage = (e) => received.push(e.data);
    try {
      useVaultStore.getState().lock();
      await flushAsync();
      expect(received).toContainEqual({ type: 'lock' });
    } finally {
      otherTab.close();
    }
  });

  it('a lock message from another tab locks this one (generation bump, no re-broadcast loop)', async () => {
    const { wire } = await makeVaultWire();
    await unlockStore(wire);
    const genBefore = useVaultStore.getState().generation;

    // "Another tab" initiates the lock.
    const otherTab = new BroadcastChannel('fl-vault');
    const echoes: unknown[] = [];
    const spy = new BroadcastChannel('fl-vault');
    spy.onmessage = (e) => echoes.push(e.data);
    try {
      otherTab.postMessage({ type: 'lock' });
      await flushAsync();
      expect(useVaultStore.getState().status).toBe('locked');
      expect(useVaultStore.getState().generation).toBeGreaterThan(genBefore);
      // The propagated lock must NOT re-broadcast (echoes only ever holds nothing
      // from our store; otherTab's own post isn't delivered to spy? it IS — filter).
      const fromStore = echoes.filter((m) => JSON.stringify(m) === JSON.stringify({ type: 'lock' }));
      expect(fromStore.length).toBeLessThanOrEqual(1); // at most otherTab's own message
    } finally {
      otherTab.close();
      spy.close();
    }
  });

  it('auto-locks after the configured idle interval', async () => {
    // Fake timers BEFORE unlock so the idle interval is captured by them.
    vi.useFakeTimers();
    const { wire } = await makeVaultWire();
    await unlockStore(wire);
    expect(useVaultStore.getState().autoLockAt).not.toBeNull();

    // Idle past the default 30-minute budget + one 15s check tick.
    vi.advanceTimersByTime(DEFAULT_AUTO_LOCK_MINUTES * 60_000 + 16_000);

    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().autoLockAt).toBeNull();
  });

  it('stays unlocked while there is activity inside the interval', async () => {
    vi.useFakeTimers();
    const { wire } = await makeVaultWire();
    await unlockStore(wire);

    // 29 idle minutes, then activity, then 29 more — never crosses 30 idle.
    vi.advanceTimersByTime(29 * 60_000);
    useVaultStore.getState().noteActivity();
    vi.advanceTimersByTime(29 * 60_000);
    expect(useVaultStore.getState().status).toBe('unlocked');
    // One more idle stretch past the budget locks it.
    vi.advanceTimersByTime(2 * 60_000 + 16_000);
    expect(useVaultStore.getState().status).toBe('locked');
  });
});
