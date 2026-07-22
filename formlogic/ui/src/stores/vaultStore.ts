// Vault state store (docs/E2EE_PRIVATE_FORMS_PLAN.md §10, §16-P2).
//
// Holds ONLY wrapped vault material + status — never passphrases, never unwrapped
// keys, never decrypted answers. Lifecycle:
//   - unlock/create/recovery go through the crypto worker (secrets stay there);
//   - lock() bumps the vault GENERATION (forcing remount of anything holding
//     decrypted data), clears the decrypted LRU, tells the worker to lock and then
//     terminates it, and broadcasts on BroadcastChannel('fl-vault') so every other
//     tab locks too (worker terminated there as well);
//   - auto-lock fires after 30 min idle (configurable via setAutoLockMinutes);
//   - logout locks via authStore's session purge hook.

import { create } from 'zustand';
import { api } from '../lib/api';
import { getCryptoClient } from '../lib/crypto/cryptoClient';
import { usePrivateDataStore } from './privateDataStore';
import type { VaultWire } from '../types/e2ee';

export type VaultStatus = 'unknown' | 'none' | 'locked' | 'unlocked';

export const DEFAULT_AUTO_LOCK_MINUTES = 30;
const CHANNEL_NAME = 'fl-vault';

interface VaultState {
  status: VaultStatus;
  /** Wrapped vault material as served by the API (no secrets). */
  vault: VaultWire | null;
  /** Bumped on every lock — private-data components key on it to force remount. */
  generation: number;
  autoLockMinutes: number;
  /** Epoch ms when idle auto-lock next fires (null while locked). Display/diagnostics. */
  autoLockAt: number | null;
  /** True while a lock was initiated locally (suppresses re-broadcast loops). */
  locking: boolean;

  refreshStatus: () => Promise<void>;
  setup: (userId: string, passphrase: string) => Promise<{ ok: boolean; recoveryDisplay?: string; error?: string }>;
  unlock: (userId: string, passphrase: string) => Promise<{ ok: boolean; error?: string; code?: string }>;
  recoveryUnlock: (userId: string, recoveryCode: string, newPassphrase: string) => Promise<{ ok: boolean; error?: string; code?: string }>;
  changePassphrase: (userId: string, currentPassphrase: string, newPassphrase: string) => Promise<{ ok: boolean; error?: string; code?: string }>;
  lock: (broadcast?: boolean) => void;
  setAutoLockMinutes: (minutes: number) => void;
  noteActivity: () => void;
}

// --- module-scope machinery (channel + idle timer) ---------------------------

let channel: BroadcastChannel | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let lastActivity = Date.now();
let activityListenersBound = false;

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      const msg = event.data as { type?: string };
      if (msg?.type === 'lock') {
        // Another tab locked — lock here too (without re-broadcasting).
        useVaultStore.getState().lock(false);
      }
    };
  } catch {
    channel = null;
  }
}

function stopIdleTimer(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

function startIdleTimer(): void {
  stopIdleTimer();
  const { autoLockMinutes } = useVaultStore.getState();
  useVaultStore.setState({ autoLockAt: lastActivity + autoLockMinutes * 60_000 });
  idleTimer = setInterval(() => {
    const { status, autoLockMinutes: minutes } = useVaultStore.getState();
    if (status !== 'unlocked') return;
    if (Date.now() - lastActivity >= minutes * 60_000) {
      useVaultStore.getState().lock();
    }
  }, 15_000);
}

function bindActivityListeners(): void {
  if (activityListenersBound || typeof window === 'undefined') return;
  activityListenersBound = true;
  const note = () => useVaultStore.getState().noteActivity();
  window.addEventListener('pointerdown', note, { passive: true });
  window.addEventListener('keydown', note, { passive: true });
}

/** Exported for authStore's session purge: lock everywhere without a circular import. */
export function lockVaultForSessionTeardown(): void {
  useVaultStore.getState().lock();
}

/** The backend wraps success bodies in {data: {vault: …}} — pull the vault out. */
function vaultFromBody(body: Record<string, unknown> | null): VaultWire | null {
  const data = body?.data as { vault?: VaultWire } | undefined;
  return data?.vault ?? null;
}

export const useVaultStore = create<VaultState>()((set, get) => ({
  status: 'unknown',
  vault: null,
  generation: 0,
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  autoLockAt: null,
  locking: false,

  refreshStatus: async () => {
    if (!api.isAuthenticated()) {
      set({ status: 'none', vault: null });
      return;
    }
    const res = await api.getVault();
    if (res.error) {
      // An unreachable vault endpoint must not strand the UI in 'unknown' — treat as
      // locked state only if we already hold wrapped material; otherwise 'none'.
      if (get().vault) set({ status: 'locked' });
      else set({ status: 'none' });
      return;
    }
    const vault = res.data?.vault ?? null;
    if (!vault) {
      set({ status: 'none', vault: null });
      return;
    }
    const client = getCryptoClient();
    let unlocked = false;
    try {
      unlocked = (await client.status()).unlocked && client.isRunning;
    } catch {
      unlocked = false;
    }
    set({ status: unlocked ? 'unlocked' : 'locked', vault });
  },

  setup: async (userId, passphrase) => {
    ensureChannel();
    const client = getCryptoClient();
    try {
      const { vault, recoveryDisplay } = await client.createVault(userId, passphrase);
      const res = await api.createVault(vault);
      if (!res.ok) {
        await client.lockAndTerminate();
        set({ status: 'none', vault: null });
        return { ok: false, error: res.body?.message as string ?? 'Could not save the vault' };
      }
      // The server returns the stored vault ({data:{vault}}) — adopt it verbatim.
      set({ status: 'unlocked', vault: vaultFromBody(res.body) ?? vault });
      lastActivity = Date.now();
      bindActivityListeners();
      startIdleTimer();
      // Private-data surfaces remount under the new generation.
      const gen = get().generation + 1;
      set({ generation: gen });
      usePrivateDataStore.getState().setGeneration(gen);
      return { ok: true, recoveryDisplay };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Vault setup failed' };
    }
  },

  unlock: async (userId, passphrase) => {
    ensureChannel();
    let vault = get().vault;
    if (!vault) {
      const res = await api.getVault();
      vault = res.data?.vault ?? null;
      if (!vault) return { ok: false, error: 'No vault found for this account', code: 'vault_not_found' };
      set({ vault });
    }
    const client = getCryptoClient();
    try {
      await client.unlock(userId, passphrase, vault);
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'vault_unlock_failed';
      return { ok: false, error: e instanceof Error ? e.message : 'Unlock failed', code };
    }
    const gen = get().generation + 1;
    set({ status: 'unlocked', generation: gen });
    usePrivateDataStore.getState().setGeneration(gen);
    lastActivity = Date.now();
    bindActivityListeners();
    startIdleTimer();
    return { ok: true };
  },

  recoveryUnlock: async (userId, recoveryCode, newPassphrase) => {
    ensureChannel();
    let vault = get().vault;
    if (!vault) {
      const res = await api.getVault();
      vault = res.data?.vault ?? null;
      if (!vault) return { ok: false, error: 'No vault found for this account', code: 'vault_not_found' };
      set({ vault });
    }
    const client = getCryptoClient();
    let rewrap;
    try {
      ({ rewrap } = await client.recoveryUnlock(userId, recoveryCode, newPassphrase, vault));
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'recovery_invalid';
      const message = code === 'recovery_invalid'
        ? 'That recovery code is not valid — check each group and try again.'
        : e instanceof Error ? e.message : 'Recovery failed';
      return { ok: false, error: message, code };
    }
    // Recovery replaces the passphrase: the version-checked rewrap endpoint is the
    // same one as a passphrase change (only the passphrase-side fields move).
    const res = await api.changeVaultPassphrase(vault.version, rewrap);
    if (!res.ok) {
      const conflict = res.status === 409;
      return {
        ok: false,
        error: conflict
          ? 'The vault was changed in another session — reload and try again.'
          : (res.body?.message as string) ?? 'Could not save the re-encrypted vault',
        code: conflict ? 'vault_version_conflict' : undefined,
      };
    }
    const updated = vaultFromBody(res.body) ?? { ...vault, ...rewrap, version: vault.version + 1 };
    const gen = get().generation + 1;
    set({ status: 'unlocked', vault: updated, generation: gen });
    usePrivateDataStore.getState().setGeneration(gen);
    lastActivity = Date.now();
    bindActivityListeners();
    startIdleTimer();
    return { ok: true };
  },

  changePassphrase: async (userId, currentPassphrase, newPassphrase) => {
    const vault = get().vault;
    if (!vault || get().status !== 'unlocked') {
      return { ok: false, error: 'The vault is locked', code: 'vault_locked' };
    }
    const client = getCryptoClient();
    let rewrap;
    try {
      ({ rewrap } = await client.changePassphrase(userId, currentPassphrase, newPassphrase, vault));
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'vault_unlock_failed';
      const message = code === 'vault_unlock_failed'
        ? 'The current passphrase is incorrect.'
        : e instanceof Error ? e.message : 'Passphrase change failed';
      return { ok: false, error: message, code };
    }
    // Rewrap-only (§11): version-checked against the backend; 409 → reload required.
    const res = await api.changeVaultPassphrase(vault.version, rewrap);
    if (!res.ok) {
      const conflict = res.status === 409;
      return {
        ok: false,
        error: conflict
          ? 'The vault was changed in another session — reload and try again.'
          : (res.body?.message as string) ?? 'Could not save the new passphrase',
        code: conflict ? 'vault_version_conflict' : undefined,
      };
    }
    set({ vault: vaultFromBody(res.body) ?? { ...vault, ...rewrap, version: vault.version + 1 } });
    return { ok: true };
  },

  lock: (broadcast = true) => {
    if (get().locking) return;
    set({ locking: true });
    try {
      stopIdleTimer();
      const gen = get().generation + 1;
      // 1. Bump the generation — private-data components remount empty (§10).
      set({ generation: gen });
      // 2. Drop the decrypted LRU + error map.
      usePrivateDataStore.getState().setGeneration(gen);
      usePrivateDataStore.getState().clear();
      // 3. Terminate the crypto worker (its secrets die with its heap).
      void getCryptoClient().lockAndTerminate();
      // 4. Propagate to every other tab.
      if (broadcast) {
        ensureChannel();
        try {
          channel?.postMessage({ type: 'lock' });
        } catch {
          /* channel unavailable — this tab still locked */
        }
      }
      set({ status: get().vault ? 'locked' : 'none', autoLockAt: null });
    } finally {
      set({ locking: false });
    }
  },

  setAutoLockMinutes: (minutes) => {
    const clamped = Math.max(1, Math.min(24 * 60, Math.floor(minutes)));
    set({ autoLockMinutes: clamped });
  },

  noteActivity: () => {
    lastActivity = Date.now();
    const { status, autoLockMinutes } = get();
    if (status === 'unlocked') set({ autoLockAt: lastActivity + autoLockMinutes * 60_000 });
  },
}));

/** Test hook: reset module-scope machinery between tests. */
export function __resetVaultStoreForTests(): void {
  stopIdleTimer();
  if (channel) {
    try { channel.close(); } catch { /* ignore */ }
    channel = null;
  }
  activityListenersBound = false;
  lastActivity = Date.now();
  useVaultStore.setState({ status: 'unknown', vault: null, generation: 0, autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, autoLockAt: null, locking: false });
}
