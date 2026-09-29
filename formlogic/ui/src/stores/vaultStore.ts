// Vault state store (docs/E2EE_PRIVATE_FORMS_PLAN.md §10, §16-P2).
//
// Holds ONLY wrapped vault material + status — never passphrases, never unwrapped
// keys, never decrypted answers. Lifecycle:
//   - unlock/create/recovery go through the crypto worker (secrets stay there);
//   - creating a vault is TWO-PHASE (plan D5): prepareSetup generates the wrappers and
//     the recovery kit locally and sends NOTHING; only commitSetup — which needs the kit
//     typed back exactly — sends the create request. Until then the store still says
//     'none': a closed tab, a lock or a sign-out drops the prepared vault and the user
//     simply starts again. A vault therefore never exists without a kit that was shown
//     and confirmed. The prepared wrappers and kit live in module scope (not in state)
//     and are dropped on every exit;
//   - lock() bumps the vault GENERATION (forcing remount of anything holding
//     decrypted data), clears the decrypted LRU, tells the worker to lock and then
//     terminates it (bounded: a wedged worker is hard-terminated after ~250ms), and
//     broadcasts on BroadcastChannel('fl-vault') so every other tab locks too
//     (worker terminated there as well). The status flips to 'locked' ONLY after
//     the worker is dead — never 'locked' with a live worker holding keys;
//   - a recovery-rewrap / passphrase-CAS failure (unknown server state) forces the
//     same full lock + terminate;
//   - auto-lock fires after 30 min idle (configurable via setAutoLockMinutes);
//   - logout locks via authStore's session purge hook.

import { create } from 'zustand';
import { api } from '../lib/api';
import { getCryptoClient } from '../lib/crypto/cryptoClient';
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent } from '../lib/sessionGeneration';
import { usePrivateDataStore } from './privateDataStore';
import type { VaultWire } from '../types/e2ee';

export type VaultStatus = 'unknown' | 'none' | 'locked' | 'unlocked';

export const DEFAULT_AUTO_LOCK_MINUTES = 30;
const CHANNEL_NAME = 'fl-vault';

/** Outcome of prepareSetup: the kit to show, and the token that identifies this setup. */
export interface PrepareSetupResult {
  ok: boolean;
  /** Identifies the prepared vault; commitSetup/abandonSetup only act on their own token. */
  setupId?: string;
  /** The recovery kit (FLRK1-…) to show the user. Nothing has been sent anywhere. */
  recoveryDisplay?: string;
  error?: string;
}

export type CommitSetupCode =
  /** The typed-back kit is not the one shown — nothing was sent; the setup is still open. */
  | 'kit_mismatch'
  /** Locked, signed out or the worker died while the kit was on screen — start again. */
  | 'setup_interrupted'
  /** A vault already exists on the account (another session got there first). */
  | 'vault_exists'
  /** The request did not get through (network / 5xx / rate limit) — the same kit can be re-sent. */
  | 'save_failed'
  /** The server refused this vault outright — start again. */
  | 'setup_rejected'
  | 'setup_busy';

export interface CommitSetupResult {
  ok: boolean;
  code?: CommitSetupCode;
  error?: string;
  /** True when the prepared vault no longer exists: the caller must start over. */
  discarded?: boolean;
}

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
  /** True from the moment a vault has been prepared locally until it is committed or
   *  dropped — the vault is NOT on the server in that window. */
  setupPending: boolean;

  refreshStatus: () => Promise<void>;
  /** Phase 1 of vault creation: generate the wrappers + recovery kit locally. Sends nothing. */
  prepareSetup: (userId: string, passphrase: string) => Promise<PrepareSetupResult>;
  /** Phase 2: the kit typed back must match; only then is the create request sent. */
  commitSetup: (setupId: string, typedKit: string) => Promise<CommitSetupResult>;
  /** Drop a prepared vault (and its kit) without creating anything. Acts only on its own token. */
  abandonSetup: (setupId?: string) => Promise<void>;
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

/**
 * A recovery-rewrap / passphrase-CAS failure leaves the vault in an UNKNOWN state
 * (review 2026-07-22): the worker holds secrets derived from a vault the server may
 * have moved past. Force a full lock: terminate the worker, bump the generation
 * (dropping decrypted state), and only then report locked.
 */
async function forceLockAfterUnknownState(): Promise<void> {
  stopIdleTimer();
  dropPendingSetup();
  await getCryptoClient().lockAndTerminate();
  const gen = useVaultStore.getState().generation + 1;
  useVaultStore.setState({
    generation: gen,
    status: useVaultStore.getState().vault ? 'locked' : 'none',
    autoLockAt: null,
  });
  usePrivateDataStore.getState().setGeneration(gen);
  usePrivateDataStore.getState().clear();
}

/** The backend wraps success bodies in {data: {vault: …}} — pull the vault out. */
function vaultFromBody(body: Record<string, unknown> | null): VaultWire | null {
  const data = body?.data as { vault?: VaultWire } | undefined;
  return data?.vault ?? null;
}

// --- two-phase vault creation (plan D5) --------------------------------------

/**
 * A vault that exists ONLY in this tab: wrappers + kit generated, nothing sent. The
 * secrets behind it are in the crypto worker's heap; the recovery kit (a secret in its
 * own right) is held only so the typed-back confirmation can be checked HERE, and is
 * dropped on every exit. Module scope on purpose: not Zustand state, so it is never
 * broadcast to subscribers or serialised by devtools.
 */
interface PendingSetup {
  id: string;
  userId: string;
  /** Auth session that prepared it — a sign-out/sign-in in between voids it. */
  sessionGeneration: number;
  vault: VaultWire;
  recoveryDisplay: string;
  /** True while the create request is in flight (nothing may tear the setup down then). */
  committing: boolean;
}

let pendingSetup: PendingSetup | null = null;
let nextSetupId = 1;
/** True while prepareSetup runs (its Argon2id derivation takes a moment): one at a time. */
let preparing = false;

const SETUP_VOID_MESSAGE =
  'This setup was interrupted (you were signed out or the vault was locked). Nothing was saved and that recovery kit is void — start again to get a new one.';

/** The same normalisation the recovery paths use: case, spaces and hyphens do not matter. */
function normalizeKit(text: string): string {
  return text.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Forget the prepared vault and its kit NOW (synchronously). The worker is the caller's job. */
function dropPendingSetup(): void {
  pendingSetup = null;
  if (useVaultStore.getState().setupPending) useVaultStore.setState({ setupPending: false });
}

/** Drop the prepared vault AND kill the worker that holds its secrets. */
async function discardPendingSetup(): Promise<void> {
  dropPendingSetup();
  await getCryptoClient().lockAndTerminate();
}

/** True when the server's vault is byte-for-byte the one this tab prepared. */
function isSameVault(a: VaultWire, b: VaultWire): boolean {
  return a.kdfSalt === b.kdfSalt
    && a.wrappedUmk === b.wrappedUmk
    && a.wrappedUmkRecovery === b.wrappedUmkRecovery
    && a.encKeyBundle === b.encKeyBundle
    && a.x25519Pk === b.x25519Pk
    && a.ed25519Pk === b.ed25519Pk;
}

/**
 * The create request succeeded: the vault now exists on the server. It is adopted as
 * UNLOCKED only if this setup is still the live one — nothing locked or signed out while
 * the request was in flight. Otherwise its secrets are gone and it opens locked (or, for
 * a different sign-in, is not adopted at all: that store must not receive this account's
 * vault).
 */
async function adoptCreatedVault(pending: PendingSetup, stored: VaultWire): Promise<CommitSetupResult> {
  const sameSession = isSessionGenerationCurrent(pending.sessionGeneration);
  const live = pendingSetup === pending && sameSession;
  dropPendingSetup();
  if (!live) {
    await getCryptoClient().lockAndTerminate();
    if (!sameSession) {
      return {
        ok: false,
        code: 'setup_interrupted',
        discarded: true,
        error: 'You were signed out while your vault was being created. Sign back in — if it was created, unlock it with your vault passphrase.',
      };
    }
    useVaultStore.setState({ vault: stored, status: 'locked' });
    return {
      ok: false,
      code: 'setup_interrupted',
      discarded: true,
      error: 'Your vault was created, but the session was locked before setup finished. Unlock it with your vault passphrase.',
    };
  }
  useVaultStore.setState({ status: 'unlocked', vault: stored });
  lastActivity = Date.now();
  bindActivityListeners();
  startIdleTimer();
  // Private-data surfaces remount under the new generation.
  const gen = useVaultStore.getState().generation + 1;
  useVaultStore.setState({ generation: gen });
  usePrivateDataStore.getState().setGeneration(gen);
  return { ok: true };
}

export const useVaultStore = create<VaultState>()((set, get) => ({
  status: 'unknown',
  vault: null,
  generation: 0,
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  autoLockAt: null,
  locking: false,
  setupPending: false,

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
    // A vault exists on the server, so a setup still waiting to create one is void — and
    // the worker it left unlocked holds a DIFFERENT vault's secrets, which must never be
    // mistaken for this account's.
    if (pendingSetup) await discardPendingSetup();
    const client = getCryptoClient();
    let unlocked: boolean;
    try {
      unlocked = (await client.status()).unlocked && client.isRunning;
    } catch {
      unlocked = false;
    }
    set({ status: unlocked ? 'unlocked' : 'locked', vault });
  },

  prepareSetup: async (userId, passphrase) => {
    ensureChannel();
    if (preparing || pendingSetup?.committing) {
      return { ok: false, error: 'A vault is already being set up — wait for it to finish.' };
    }
    preparing = true;
    try {
      // A second start replaces the first: its kit is void the moment a new one exists.
      if (pendingSetup) await discardPendingSetup();

      // Refuse BEFORE the Argon2id run — and before any kit is shown — when the create
      // request cannot succeed anyway (a vault already exists, this account may not use
      // vaults, private forms are off on this server). The user must never save a kit
      // for a vault that cannot come into being.
      const existing = await api.getVault();
      if (existing.error) return { ok: false, error: existing.error };
      if (existing.data?.vault) {
        set({ vault: existing.data.vault, ...(get().status === 'unlocked' ? {} : { status: 'locked' as const }) });
        return { ok: false, error: 'A vault already exists for this account — unlock it with your vault passphrase.' };
      }
      const health = await api.healthCheck();
      if (health.data?.privateForms === false) {
        return { ok: false, error: 'Private forms are not enabled on this server.' };
      }

      const client = getCryptoClient();
      const sessionGeneration = currentSessionGeneration();
      try {
        // Generates the wrappers + kit in the worker (which keeps the secrets). NOTHING is
        // sent to the server here: the vault does not exist until commitSetup.
        const { vault, recoveryDisplay } = await client.createVault(userId, passphrase);
        if (!isSessionGenerationCurrent(sessionGeneration)) {
          await client.lockAndTerminate();
          return { ok: false, error: 'You were signed out while the vault was being prepared — try again.' };
        }
        const setupId = `setup-${nextSetupId++}`;
        pendingSetup = { id: setupId, userId, sessionGeneration, vault, recoveryDisplay, committing: false };
        set({ setupPending: true });
        return { ok: true, setupId, recoveryDisplay };
      } catch (e) {
        await client.lockAndTerminate();
        return { ok: false, error: e instanceof Error ? e.message : 'Vault setup failed' };
      }
    } finally {
      preparing = false;
    }
  },

  commitSetup: async (setupId, typedKit) => {
    const pending = pendingSetup;
    if (!pending || pending.id !== setupId) {
      return { ok: false, code: 'setup_interrupted', discarded: true, error: SETUP_VOID_MESSAGE };
    }
    if (pending.committing) {
      return { ok: false, code: 'setup_busy', error: 'The vault is already being saved.' };
    }
    // The typed-back confirmation that gates persistence (plan D5) is enforced HERE, not
    // only in the UI: nothing below runs — and no request is made — unless the kit that
    // was shown has been entered back exactly.
    if (normalizeKit(typedKit) !== normalizeKit(pending.recoveryDisplay)) {
      return { ok: false, code: 'kit_mismatch', error: "That doesn't match your recovery kit — check each group carefully." };
    }
    pending.committing = true;
    try {
      // The setup must still be exactly what the user confirmed: the same sign-in session
      // (the wrappers are bound to this user id — the vault is create-only, so sending
      // them under another account would brick it) and a live worker holding its secrets.
      const client = getCryptoClient();
      const wasRunning = client.isRunning;
      let holdsSecrets = false;
      try {
        const worker = await client.status();
        holdsSecrets = wasRunning && worker.unlocked && worker.userId === pending.userId;
      } catch {
        holdsSecrets = false;
      }
      const sameSession = isSessionGenerationCurrent(pending.sessionGeneration) && currentSessionOwner() === pending.userId;
      if (pendingSetup !== pending || !holdsSecrets || !sameSession) {
        if (pendingSetup === pending) await discardPendingSetup();
        return { ok: false, code: 'setup_interrupted', discarded: true, error: SETUP_VOID_MESSAGE };
      }

      // The ONLY place the vault is sent to the server.
      const res = await api.createVault(pending.vault);
      // The server returns the stored vault ({data:{vault}}) — adopt it verbatim.
      if (res.ok) return await adoptCreatedVault(pending, vaultFromBody(res.body) ?? pending.vault);

      const body = (res.body ?? {}) as { code?: string; message?: string };
      if (res.status === 409 && body.code === 'vault_exists') {
        // Either an earlier attempt of THIS setup got through (its response was lost) or
        // another session created a vault first.
        const existing = await api.getVault();
        const theirs = existing.data?.vault ?? null;
        if (theirs && isSameVault(theirs, pending.vault)) return await adoptCreatedVault(pending, theirs);
        const stillThisSession = pendingSetup === pending && isSessionGenerationCurrent(pending.sessionGeneration);
        await discardPendingSetup();
        if (theirs && stillThisSession) set({ vault: theirs, status: 'locked' });
        return {
          ok: false,
          code: 'vault_exists',
          discarded: true,
          error: 'A vault already exists for this account, so nothing new was created. Unlock it with its vault passphrase — the recovery kit you just saw does not belong to it.',
        };
      }
      if (res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500) {
        // No verdict came back (a dropped connection, a server error, a rate limit). The
        // very same vault and kit can be sent again — regenerating would make the kit the
        // user wrote down useless — and if the first attempt did get through, the retry
        // meets a 409 for that same vault and is adopted above.
        return {
          ok: false,
          code: 'save_failed',
          error: 'FormLogic did not confirm that the vault was created. Your recovery kit is unchanged — check your connection and try again.',
        };
      }
      await discardPendingSetup();
      return {
        ok: false,
        code: 'setup_rejected',
        discarded: true,
        error: body.code === 'kdf_downgrade'
          ? 'The server rejected the vault encryption parameters — reload the app and try again.'
          : body.message ?? 'Could not save the vault',
      };
    } catch (e) {
      // Not a verdict from the server: keep the setup so the same kit can be re-sent.
      return { ok: false, code: 'save_failed', error: e instanceof Error ? e.message : 'Could not save the vault' };
    } finally {
      pending.committing = false;
    }
  },

  abandonSetup: async (setupId) => {
    const pending = pendingSetup;
    if (!pending) return;
    // Only the holder of a setup may drop it (several closed wizards can be mounted at once).
    if (setupId !== undefined && pending.id !== setupId) return;
    // Once the request is out let it finish — tearing the worker down under it would
    // leave a vault on the server that this tab cannot open.
    if (pending.committing) return;
    await discardPendingSetup();
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
      // The worker already adopted the recovered secrets but the server did NOT
      // confirm the rewrap (a 409 means another session rewrote the vault; a network
      // failure leaves acceptance UNKNOWN). Never leave an unlocked worker behind
      // against a possibly-stale vault: force a full lock + terminate (§10).
      await forceLockAfterUnknownState();
      const conflict = res.status === 409;
      const bodyCode = (res.body as { code?: string } | null)?.code;
      return {
        ok: false,
        error: conflict
          ? 'The vault was changed in another session — reload and try again.'
          : bodyCode === 'kdf_downgrade'
            ? 'The server rejected the vault encryption parameters — reload the app and try again.'
            : (res.body?.message as string) ?? 'Could not save the re-encrypted vault',
        code: conflict ? 'vault_version_conflict' : 'vault_state_unknown',
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
      // Same posture as recovery: the rewrap was computed but not confirmed (a 409
      // means the served vault is stale; a network failure is ambiguous) — force
      // lock + terminate rather than leaving an unlocked worker in an unknown state.
      await forceLockAfterUnknownState();
      const conflict = res.status === 409;
      const bodyCode = (res.body as { code?: string } | null)?.code;
      return {
        ok: false,
        error: conflict
          ? 'The vault was changed in another session — reload and try again.'
          : bodyCode === 'kdf_downgrade'
            ? 'The server rejected the vault encryption parameters — reload the app and try again.'
            : (res.body?.message as string) ?? 'Could not save the new passphrase',
        code: conflict ? 'vault_version_conflict' : 'vault_state_unknown',
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
      // A vault prepared but not yet created dies with the worker that holds its
      // secrets: its kit is void, and nothing was ever sent.
      dropPendingSetup();
      const gen = get().generation + 1;
      // 1. Bump the generation — private-data components remount empty (§10). This is
      //    the synchronous plaintext boundary: editors close and drafts drop NOW.
      set({ generation: gen });
      // 2. Drop the decrypted LRU + error map.
      usePrivateDataStore.getState().setGeneration(gen);
      usePrivateDataStore.getState().clear();
      // 3. Terminate the crypto worker (its secrets die with its heap). The status
      //    flips to locked EXACTLY ONCE, only after the worker is actually dead —
      //    never report 'locked' while a live worker may still hold keys. A newer
      //    unlock (generation moved on) supersedes the flip.
      void getCryptoClient().lockAndTerminate().then(() => {
        if (get().generation === gen) {
          set({ status: get().vault ? 'locked' : 'none', autoLockAt: null });
        }
      });
      // 4. Propagate to every other tab.
      if (broadcast) {
        ensureChannel();
        try {
          channel?.postMessage({ type: 'lock' });
        } catch {
          /* channel unavailable — this tab still locked */
        }
      }
      set({ autoLockAt: null });
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
  pendingSetup = null;
  nextSetupId = 1;
  preparing = false;
  useVaultStore.setState({ status: 'unknown', vault: null, generation: 0, autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, autoLockAt: null, locking: false, setupPending: false });
}
