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
//     and are dropped on every exit. Once the create request has been SENT and no verdict
//     came back, the vault may exist: from then on nothing calls the kit void or says
//     nothing was saved until the server has said there is no vault (checkSetup);
//   - lock() bumps the vault GENERATION (forcing remount of anything holding
//     decrypted data), clears the decrypted LRU, tells the worker to lock and then
//     terminates it (bounded: a wedged worker is hard-terminated after ~250ms), and
//     broadcasts on BroadcastChannel('fl-vault') so every other tab locks too
//     (worker terminated there as well). The status flips to 'locked' ONLY after
//     the worker is dead — never 'locked' with a live worker holding keys. (One bounded
//     exception: refreshStatus meeting the very vault a setup has just sent says 'locked'
//     while that setup's worker still holds its secrets — nothing has adopted them yet,
//     the wizard that owns them is still open, and every exit of the setup terminates
//     that worker);
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
  /** Locked, signed out or the worker died — the setup is gone. Whether the vault may exist
   *  anyway depends on whether a request had gone out: the message says which. */
  | 'setup_interrupted'
  /** A different vault already exists on the account (another session got there first). */
  | 'vault_exists'
  /** The request got no verdict (network / 5xx / rate limit): the vault MAY exist, and the
   *  same kit can be re-sent — a retry meets a 409 for that same vault and adopts it. */
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
  /** True when the vault DOES exist on the server but could not be left unlocked here (a lock,
   *  or the worker was lost): the store has it, locked, and the user unlocks it as usual. */
  vaultCreated?: boolean;
}

/** What asking the server about a setup whose create request got no verdict found. */
export type CheckSetupOutcome =
  /** The server holds exactly this vault: it was adopted (unlocked) — the saved kit is its kit. */
  | 'created'
  /** The server has no vault. The setup is kept (until the caller drops it) and can still be sent. */
  | 'not_created'
  /** The server holds a DIFFERENT vault: the setup was discarded and that vault opens locked. */
  | 'other_vault'
  /** The setup is gone (a lock, a sign-out): `error` says whether the vault may exist. */
  | 'interrupted'
  /** The server could not be asked (or a request is in flight): nothing is concluded, nothing dropped. */
  | 'unknown';

export interface CheckSetupResult {
  outcome: CheckSetupOutcome;
  error?: string;
  /** With 'interrupted': the vault DOES exist (the store has it, locked) — see CommitSetupResult. */
  vaultCreated?: boolean;
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
  /** Ask the server what became of a setup whose create request got no verdict — so the
   *  caller never has to guess whether the vault (and therefore the saved kit) matters. */
  checkSetup: (setupId: string) => Promise<CheckSetupResult>;
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
  /**
   * True from the moment the create request is SENT until a verdict comes back (created,
   * refused, or the server showing another vault / none at all). While it is set the vault
   * MAY exist on the server even though this tab never heard, so the kit the user saved may
   * be the only way into it: nothing may call it void, say "nothing was saved", or tell the
   * user to throw it away. Only a verdict clears it.
   */
  sent: boolean;
}

let pendingSetup: PendingSetup | null = null;
/** The setup that was dropped last, and whether it was dropped with a request unanswered:
 *  so a caller asking about a setup that is gone is told the truth, not a guess. */
let endedSetup: { id: string; sent: boolean } | null = null;
let nextSetupId = 1;
/** True while prepareSetup runs (its Argon2id derivation takes a moment): one at a time. */
let preparing = false;

const SETUP_VOID_MESSAGE =
  'This setup was interrupted (you were signed out or the vault was locked). Nothing was saved and that recovery kit is void — start again to get a new one.';

/** For a setup that had sent its request: the vault may exist, so the saved kit still matters. */
const SETUP_MAYBE_CREATED_MESSAGE =
  'This setup was interrupted (you were signed out or the vault was locked) before FormLogic confirmed that your vault was created, so it may already exist. '
  + 'Keep the recovery kit you saved: if a vault exists, unlock it with your vault passphrase — or with that kit if you have forgotten the passphrase. '
  + 'Start again only if FormLogic tells you there is no vault.';

/** Shown with `save_failed`: the request got no verdict and the same kit can be sent again. */
const SETUP_UNCONFIRMED_MESSAGE =
  'FormLogic did not confirm that the vault was created, so it may already exist. Your recovery kit is unchanged — keep it, check your connection and try again.';

/** Shown when the server itself could not be asked what became of the request. */
const SETUP_UNCHECKED_MESSAGE =
  'FormLogic could not be reached to check whether your vault was created, so it may already exist. Keep your recovery kit either way.';

const SETUP_OTHER_VAULT_MESSAGE =
  'A vault already exists for this account, so nothing new was created. Unlock it with its vault passphrase — the recovery kit you just saw does not belong to it.';

/** What to say about a setup that is no longer there. */
function endedSetupMessage(setupId: string): string {
  return endedSetup?.id === setupId && endedSetup.sent ? SETUP_MAYBE_CREATED_MESSAGE : SETUP_VOID_MESSAGE;
}

/**
 * The create request got no verdict. If the setup still stands, the same vault and kit can
 * be sent again; if something dropped it meanwhile (a lock, a sign-out) there is nothing
 * left to retry — and the vault may exist.
 */
function unconfirmedResult(pending: PendingSetup): CommitSetupResult {
  if (pendingSetup === pending) return { ok: false, code: 'save_failed', error: SETUP_UNCONFIRMED_MESSAGE };
  return { ok: false, code: 'setup_interrupted', discarded: true, error: SETUP_MAYBE_CREATED_MESSAGE };
}

/** The same normalisation the recovery paths use: case, spaces and hyphens do not matter. */
function normalizeKit(text: string): string {
  return text.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Forget the prepared vault and its kit NOW (synchronously). The worker is the caller's job. */
function dropPendingSetup(): void {
  if (pendingSetup) endedSetup = { id: pendingSetup.id, sent: pendingSetup.sent };
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
 * The vault now exists on the server (the create request succeeded, or a look at the server
 * found this very vault). It is adopted as UNLOCKED only if this setup is still the live
 * one: nothing locked or signed out meanwhile AND the worker still holds its secrets — that
 * can be lost outside the store's knowledge (a crash on a low-memory phone) in the time
 * between the request going out and its answer being known, and "unlocked" without secrets
 * would be a lie. Otherwise it opens locked (or, for a different sign-in, is not adopted at
 * all: that store must not receive this account's vault).
 */
async function adoptCreatedVault(pending: PendingSetup, stored: VaultWire): Promise<CommitSetupResult> {
  let holdsSecrets = false;
  if (pendingSetup === pending && isSessionGenerationCurrent(pending.sessionGeneration)) {
    const client = getCryptoClient();
    const wasRunning = client.isRunning; // status() would spawn a fresh, empty worker
    try {
      const worker = await client.status();
      holdsSecrets = wasRunning && worker.unlocked && worker.userId === pending.userId;
    } catch {
      holdsSecrets = false;
    }
  }
  // Decided AFTER the worker was asked: a lock or sign-out can land while it answers.
  const sameSession = isSessionGenerationCurrent(pending.sessionGeneration);
  const live = pendingSetup === pending && sameSession && holdsSecrets;
  pending.sent = false; // a verdict: the vault exists
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
      vaultCreated: true,
      error: 'Your vault was created, but it could not be left unlocked (the session was locked, or its worker was lost). Unlock it with your vault passphrase.',
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

/**
 * After a setup whose create request never got a verdict has been dropped: the vault may
 * exist on the server, so bring the store in line with it rather than leaving it saying
 * there is none. Reads only — it can mark the vault as present and LOCKED, never unlock it.
 */
async function syncStoreWithServer(): Promise<void> {
  const res = await api.getVault();
  const vault = res.data?.vault ?? null;
  const state = useVaultStore.getState();
  if (vault && !pendingSetup && state.status !== 'unlocked') {
    useVaultStore.setState({ vault, status: 'locked' });
  }
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
    // A vault exists on the server. A setup still waiting to create one is void — unless
    // it is not ours to void: its create request is in flight (that request's own answer
    // settles it), or this IS the vault it prepared (an earlier attempt got through and only
    // its answer was lost, so the kit is this vault's kit and the setup's owner adopts it on
    // the next confirm). Either way the store says locked: the setup's worker holds this
    // vault's secrets but nothing has adopted them yet.
    if (pendingSetup && (pendingSetup.committing || isSameVault(vault, pendingSetup.vault))) {
      set({ vault, status: 'locked' });
      return;
    }
    // Otherwise the setup is void, and the worker it left unlocked holds a DIFFERENT
    // vault's secrets, which must never be mistaken for this account's.
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
        pendingSetup = { id: setupId, userId, sessionGeneration, vault, recoveryDisplay, committing: false, sent: false };
        set({ setupPending: true });
        return { ok: true, setupId, recoveryDisplay };
      } catch (e) {
        await client.lockAndTerminate();
        return { ok: false, error: e instanceof Error ? e.message : 'Vault setup failed' };
      }
    } catch (e) {
      // A preflight request that throws (instead of reporting a failure) must not leave the
      // caller waiting on a promise that never settles.
      return { ok: false, error: e instanceof Error ? e.message : 'Vault setup failed' };
    } finally {
      preparing = false;
    }
  },

  commitSetup: async (setupId, typedKit) => {
    const pending = pendingSetup;
    if (!pending || pending.id !== setupId) {
      return { ok: false, code: 'setup_interrupted', discarded: true, error: endedSetupMessage(setupId) };
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
        // An earlier attempt of this very setup may have got through: then the kit is not void.
        const message = pending.sent ? SETUP_MAYBE_CREATED_MESSAGE : SETUP_VOID_MESSAGE;
        if (pendingSetup === pending) await discardPendingSetup();
        return { ok: false, code: 'setup_interrupted', discarded: true, error: message };
      }

      // The ONLY place the vault is sent to the server. From here until a verdict comes
      // back the vault may exist (see PendingSetup.sent).
      pending.sent = true;
      const res = await api.createVault(pending.vault);
      // The server returns the stored vault ({data:{vault}}) — adopt it verbatim.
      if (res.ok) return await adoptCreatedVault(pending, vaultFromBody(res.body) ?? pending.vault);

      const body = (res.body ?? {}) as { code?: string; message?: string };
      if (res.status === 409 && body.code === 'vault_exists') {
        // Either an earlier attempt of THIS setup got through (its response was lost) or
        // another session created a vault first. Only the server can say which.
        const existing = await api.getVault();
        const theirs = existing.data?.vault ?? null;
        if (theirs && isSameVault(theirs, pending.vault)) return await adoptCreatedVault(pending, theirs);
        // The server says a vault exists but the look at it failed, or showed none: conclude
        // nothing. Discarding here would throw away the very kit that opens it.
        if (!theirs) return unconfirmedResult(pending);
        // A DIFFERENT vault: a verdict — this one can never be created.
        pending.sent = false;
        const stillThisSession = pendingSetup === pending && isSessionGenerationCurrent(pending.sessionGeneration);
        await discardPendingSetup();
        if (stillThisSession) set({ vault: theirs, status: 'locked' });
        return { ok: false, code: 'vault_exists', discarded: true, error: SETUP_OTHER_VAULT_MESSAGE };
      }
      if (res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500) {
        // No verdict came back (a dropped connection, a server error, a rate limit). The
        // very same vault and kit can be sent again — regenerating would make the kit the
        // user wrote down useless — and if the first attempt did get through, the retry
        // meets a 409 for that same vault and is adopted above.
        return unconfirmedResult(pending);
      }
      pending.sent = false; // a refusal is a verdict: nothing was saved
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
      if (pending.sent) return unconfirmedResult(pending);
      return { ok: false, code: 'save_failed', error: e instanceof Error ? e.message : 'Could not save the vault' };
    } finally {
      pending.committing = false;
    }
  },

  checkSetup: async (setupId) => {
    const pending = pendingSetup;
    if (!pending || pending.id !== setupId) {
      return { outcome: 'interrupted', error: endedSetupMessage(setupId) };
    }
    if (pending.committing) {
      return { outcome: 'unknown', error: 'The vault is still being saved — wait for it to finish.' };
    }
    // No request was ever sent: there is nothing to ask the server about.
    if (!pending.sent) return { outcome: 'not_created' };

    let res: Awaited<ReturnType<typeof api.getVault>>;
    try {
      res = await api.getVault();
    } catch {
      // A request that throws is no answer: conclude nothing.
      return { outcome: 'unknown', error: SETUP_UNCHECKED_MESSAGE };
    }
    // If the setup was dropped (a lock, a sign-out) or started saving while the server was
    // being asked, this answer is no longer about it.
    if (pendingSetup !== pending) return { outcome: 'interrupted', error: endedSetupMessage(setupId) };
    if (pending.committing) return { outcome: 'unknown', error: 'The vault is being saved — wait for it to finish.' };
    if (res.error) return { outcome: 'unknown', error: SETUP_UNCHECKED_MESSAGE };

    const theirs = res.data?.vault ?? null;
    if (!theirs) {
      pending.sent = false; // the server has no vault: now nothing was saved
      return { outcome: 'not_created' };
    }
    if (isSameVault(theirs, pending.vault)) {
      const adopted = await adoptCreatedVault(pending, theirs);
      if (adopted.ok) return { outcome: 'created' };
      return { outcome: 'interrupted', error: adopted.error, ...(adopted.vaultCreated ? { vaultCreated: true } : {}) };
    }
    // Somebody else's vault: this one can never be created.
    pending.sent = false;
    const stillThisSession = isSessionGenerationCurrent(pending.sessionGeneration);
    await discardPendingSetup();
    if (stillThisSession) set({ vault: theirs, status: 'locked' });
    return { outcome: 'other_vault', error: SETUP_OTHER_VAULT_MESSAGE };
  },

  abandonSetup: async (setupId) => {
    const pending = pendingSetup;
    if (!pending) return;
    // Only the holder of a setup may drop it (several closed wizards can be mounted at once).
    if (setupId !== undefined && pending.id !== setupId) return;
    // Once the request is out let it finish — tearing the worker down under it would
    // leave a vault on the server that this tab cannot open.
    if (pending.committing) return;
    const mayExist = pending.sent;
    await discardPendingSetup();
    // A request that never got a verdict may have created the vault: the store must not go on
    // saying there is none. (Nothing is unlocked by this — the worker is gone.)
    if (mayExist) await syncStoreWithServer().catch(() => undefined);
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
  endedSetup = null;
  nextSetupId = 1;
  preparing = false;
  useVaultStore.setState({ status: 'unknown', vault: null, generation: 0, autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, autoLockAt: null, locking: false, setupPending: false });
}
