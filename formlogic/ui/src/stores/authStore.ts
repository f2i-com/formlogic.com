import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';
import { api } from '../lib/api';
import { browserTimezone } from '../lib/timezone';
import { bumpSessionGeneration, currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent, setSessionOwner } from '../lib/sessionGeneration';
import { clearNativeMemberStorage } from '../lib/nativeAppStorage';
import { useFormStore, clearAllDebounceTimers } from './formStore';
import { useAppStore } from './appStore';
import { useAppUserStore } from './appUserStore';
import { useAppRuntimeStore } from './appRuntimeStore';
import { useResponseStore } from './responseStore';
import { toast } from './toastStore';
import { lockVaultForSessionTeardown, useVaultStore } from './vaultStore';
import { forgetAppLocalAccessOf, setAppLocalAccessAccount } from '../client-runtime/appLocalAccess';
import { clearDesktopToken } from '../client-runtime/desktop/desktopPairing';
import { forgetOaiyTokenOf, setOaiyToken, setOaiyTokenAccount } from '../client-runtime/oaiy/oaiyRuntime';

interface User {
  id: string;
  email: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  /** IANA timezone the user prefers record times shown in ('' / undefined = unset). */
  timezone?: string;
  /** True for the shared public "Demo" account (drives the demo banner). */
  isDemo?: boolean;
  /** Signed in on an app's own domain: this session opens that app and nothing else. */
  domainSession?: boolean;
  /** Platform administrator (unlocks the /admin panel). */
  isAdmin?: boolean;
  /** Two-factor authentication switched on (drives the Settings card + signup nudge). */
  mfaEnabled?: boolean;
  /** Verified by an administrator for the host-JavaScript client engine. Advisory only: it decides
   *  whether the app-settings engine select offers that option, never whether it takes effect. */
  isCodeTrustVerified?: boolean;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; mfaRequired?: boolean; mfaToken?: string }>;
  /** Step 2 of an MFA login: exchange the pending token + authenticator code for the session. */
  verifyMfa: (mfaToken: string, code: string, rememberBrowser: boolean) => Promise<{ success: boolean; error?: string }>;
  startDemo: () => Promise<{ success: boolean; error?: string }>;
  register: (email: string, password: string, name?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<{ success: boolean; error?: string }>;
  clearError: () => void;
}

let _authSessionCallback: (() => void) | null = null;

/** Why a session is being torn down — 'account-deleted' additionally erases per-user databases. */
export type SessionTeardownReason = 'logout' | 'session-expired' | 'account-deleted' | 'remote-teardown';

const SESSION_CHANNEL = 'formlogic-session';
const SESSION_TRANSITION_KEY = 'formlogic-session-transition';
type SessionMessage = { type?: string; reason?: string; userId?: unknown; revision?: unknown; ordered?: unknown };
let lastHandledTransition: string | null = null;
let unconfirmedMemberOwner: string | null = null;

/** Ordering metadata only: never a credential and never used to hydrate a user. */
function publishSessionTransition(type: 'fl-teardown' | 'fl-session-transition', userId: string | null, reason?: SessionTeardownReason): void {
  const revision = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const message = { type, userId, revision, ordered: true, ...(reason ? { reason } : {}) };
  lastHandledTransition = revision;
  try { localStorage.setItem(SESSION_TRANSITION_KEY, JSON.stringify(message)); }
  catch { message.ordered = false; } // Do not let an older retained marker suppress this boundary.
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage(message);
      channel.close();
    } catch { /* The storage event remains available in browsers without BroadcastChannel. */ }
  }
}

/** A sibling tab has already installed the next shared-origin snapshot. Clear
 * this tab's memory without letting persisted-store setters overwrite it. */
function withMemoryOnlyPersistence(run: () => void): void {
  type Persistor = {
    getOptions: () => { storage?: PersistStorage<unknown> };
    setOptions: (options: { storage: PersistStorage<unknown> }) => void;
  };
  const restore: (() => void)[] = [];
  try {
    for (const store of [useAuthStore, useFormStore, useAppStore, useAppRuntimeStore, useResponseStore]) {
      const persistor = (store as unknown as { persist?: Persistor }).persist;
      const storage = persistor?.getOptions().storage;
      if (!persistor || !storage) continue;
      persistor.setOptions({ storage: { getItem: key => storage.getItem(key), setItem: () => {}, removeItem: () => {} } });
      restore.push(() => persistor.setOptions({ storage }));
    }
    run();
  } finally {
    for (const reset of restore.reverse()) reset();
  }
}

/**
 * Centralized session boundary (audit FL-10/FL-11): fences callbacks, resets local
 * stores and attempts storage cleanup. Cross-tab memory-only cleanup preserves a
 * newer shared-origin snapshot; member-key cleanup remains scoped to the leaving
 * principal. Browser failures can prevent physical deletion, and the legacy
 * unowned Workbox queue still has a separate conservative purge policy below.
 * Account deletion also requests erasure of that user's chat database.
 *
 * Submissions still queued on the device (pending or failed) are removed for every
 * reason except 'session-expired': see forgetQueuedSubmissions.
 *
 * So is what a member keeps in this browser, for the same reasons and one more: for an app
 * with no backend it is the only copy of their records, and a session ends by itself every
 * day. Only asking to leave erases it. Until then it stays under their id, which no other
 * account can open (nativeAppStorage's assertScope).
 */
export async function teardownUserSession(
  userId: string | null,
  reason: SessionTeardownReason,
  broadcast = true,
  memoryOnly = false
): Promise<void> {
  if (unconfirmedMemberOwner === userId) unconfirmedMemberOwner = null;
  const leaving = reason !== 'session-expired';
  // An old caller may finish after another identity has already signed in. Only
  // its private namespace belongs to it; B's stores and callbacks must survive.
  if (currentSessionOwner() !== null && currentSessionOwner() !== userId) {
    if (userId && leaving) clearNativeMemberStorage(userId);
    return;
  }
  // The generation bump comes FIRST (audit FL-11): an authenticated request still in
  // flight compares its captured generation on resolve and DISCARDS its result rather
  // than repopulating the stores this teardown is about to clear.
  const generation = bumpSessionGeneration();
  if (userId && leaving) clearNativeMemberStorage(userId);
  // Publish before awaiting cleanup, so a delayed A teardown cannot announce a
  // newer boundary after B has signed in and published its transition.
  if (broadcast) publishSessionTransition('fl-teardown', userId, reason);

  await clearUserSessionData(generation, memoryOnly);

  if (reason !== 'session-expired') await forgetQueuedSubmissions(userId, generation);

  if (userId && reason === 'account-deleted') {
    try {
      forgetOaiyTokenOf(userId);
      forgetAppLocalAccessOf(userId);
    } catch {
      // never let it block the erasure below
    }
    // Request erasure of the deleted account's per-user chat DB (audit FL-10):
    // plaintext transcripts and image data URIs must not merely be detached.
    try {
      const chat = await import('../components/chat/chatStore');
      await chat.deleteChatDataForUser(userId);
    } catch {
      // best-effort — teardown must never block account deletion
    }
  }
}

/**
 * Remove the submissions an account has queued on this device, pending or failed: its rows
 * in the browser queue and its items in this app's native runtime queue, each with the ones
 * from before they carried an owner. They hold answers in plain text, and an unstamped one
 * left behind is sent with whoever signs in next. Signing out says the device should forget
 * this account, and so do an account deletion and a sign-out in another tab.
 *
 * Not on 'session-expired': the person did not ask to leave, a session often runs out while
 * the device is offline (which is when the queue is used), and browser rows and native items
 * are stamped with their owner, so no other account can send or see them. They wait for the
 * same person to sign in again; offlineQueue.ts removes a browser row once it is old and
 * someone else uses the device.
 */
async function forgetQueuedSubmissions(userId: string | null, generation: number): Promise<void> {
  if (userId) {
    try {
      const queue = await import('../client-runtime/offlineQueue');
      await queue.purgeQueueForOwner(userId);
    } catch {
      // best-effort — teardown must never block on IndexedDB
    }
  }
  try {
    const native = await import('../client-runtime/nativeOfflineQueue');
    if (!userId && !isSessionGenerationCurrent(generation)) return;
    // This account's items and the unstamped ones; with no account, every item, as before.
    await native.purgeNativeQueue(userId ?? undefined);
  } catch {
    // best-effort
  }
}

/**
 * How many submissions the signed-in account would lose by signing out now: exactly what
 * forgetQueuedSubmissions removes. The sign-out buttons ask first when it is not zero.
 */
export async function unsentSubmissionsOnSignOut(): Promise<number> {
  const userId = useAuthStore.getState().user?.id ?? null;
  if (!userId) return 0;
  try {
    const [queue, native] = await Promise.all([
      import('../client-runtime/offlineQueue'),
      import('../client-runtime/nativeOfflineQueue'),
    ]);
    const [browser, nativeCount] = await Promise.all([queue.unsentCountFor(userId), native.nativeUnsentCount(userId)]);
    return browser + nativeCount;
  } catch {
    return 0;
  }
}

/**
 * Purge all user-specific in-memory state + persisted localStorage + cached app data.
 * Prefer teardownUserSession() — it adds the FL-11 generation bump, per-user database
 * erasure, and cross-tab propagation.
 */
/**
 * Delete every request Workbox has parked under `queueName` in its
 * background-sync store (schema: DB `workbox-background-sync`, store `requests`,
 * index `queueName`). Resolves quietly when the database does not exist.
 */
async function purgeBackgroundSyncQueue(queueName: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const open = indexedDB.open('workbox-background-sync');
    open.onerror = () => resolve();
    open.onblocked = () => resolve();
    open.onupgradeneeded = () => {
      // The DB did not exist; opening created an empty one. Abort so it stays absent.
      open.transaction?.abort();
      resolve();
    };
    open.onsuccess = () => {
      const db = open.result;
      try {
        if (!db.objectStoreNames.contains('requests')) {
          db.close();
          resolve();
          return;
        }
        const tx = db.transaction('requests', 'readwrite');
        const store = tx.objectStore('requests');
        const cursorReq = store.index('queueName').openCursor(IDBKeyRange.only(queueName));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); resolve(); };
      } catch {
        db.close();
        resolve();
      }
    };
  });
}

async function clearUserSessionData(generation: number, memoryOnly: boolean): Promise<void> {
  // Cancel pending debounced saves so stale callbacks can't fire after the purge.
  clearAllDebounceTimers();

  // Complete shared synchronous cleanup before any await can let a new identity
  // populate these stores. Asynchronous cleanup below checks the same boundary.
  const resetStores = () => {
    useFormStore.setState({ forms: [], isInitialized: false, isLoading: false, activeFormId: null, selectedFieldId: null, error: null, savingFormIds: {} });
    useAppStore.setState({ apps: [], activeAppId: null, isLoading: false, _loadingCount: 0, error: null });
    useAppUserStore.getState().reset();
    useAppRuntimeStore.getState().reset();
    useResponseStore.setState({ responses: [], currentFormId: null, currentAnswers: {}, currentStep: 0, startTime: null });
  };
  if (memoryOnly) withMemoryOnlyPersistence(resetStores);
  else resetStores();

  if (!memoryOnly) try {
    localStorage.removeItem('formlogic-auth');
    localStorage.removeItem('formlogic-forms');
    localStorage.removeItem('formlogic-apps');
    localStorage.removeItem('formlogic-responses');
    localStorage.removeItem('formlogic-app-runtime');
    localStorage.removeItem('formlogic_storage_mode');
    // App-logic `storage.set` state is keyed by APP, not by user; the next
    // account's scripts would read the previous member's values.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('formlogic-applogic-')) localStorage.removeItem(k);
    }
  } catch {
    // localStorage may be unavailable (e.g. private browsing)
  }

  // Importing these modules does not create a crypto worker or contact hardware.
  // Lock synchronously: a deferred import must not leave A's vault/token alive
  // when B starts, or clear B's newly initialized state when it finally resolves.
  try {
    if (memoryOnly) useVaultStore.getState().lock(false);
    else lockVaultForSessionTeardown();
    useVaultStore.setState({ status: 'unknown', vault: null });
  } catch {
    // Never let vault teardown block the logout path.
  }

  // The OAIY pairing token drives the operator's real hardware, so it must not
  // reach the next session, the shared demo account included. What an account
  // keeps stays under its id, out of reach until it signs in again, so signing
  // out does not mean pairing again, and this never deletes it: another tab's
  // sign-out runs this too. What this tab holds for no account goes.
  try {
    setOaiyTokenAccount(null);
    setOaiyToken(null);
    clearDesktopToken(); // the tab's FormLogic Desktop token, for the same reason
  } catch {
    // never let it block logout
  }

  // Workbox's background-sync queue retains unowned plaintext app-form requests.
  // Replay carries the original CSRF header, which the server binds to the auth
  // cookie; an A request with a new B cookie is rejected by that check. Retention
  // still needs cleanup, so the app-form queue is emptied on every teardown:
  // the owner-stamped copy in the offline queue (offlineQueue.ts) is the one that
  // waits for its owner. The public-form queue is kept: it is not kept per account
  // (a visitor who never signed in may have a submission waiting in it), and Workbox
  // never sends what has waited more than 24 hours. Its route does identify a signed-in
  // submitter (authOptional), so a public submission replayed after an account
  // switch is recorded with the account signed in at that moment.
  try {
    // Retain the existing conservative purge: these legacy Workbox entries have
    // no owner stamp. Skipping it on a generation change would retain private bytes.
    // Owner-scoping this separate queue is outside native snapshot isolation.
    await purgeBackgroundSyncQueue('formSubmissionQueue');
  } catch {
    // IndexedDB unavailable, or no queue yet — nothing to purge
  }

  try {
    if (!memoryOnly && typeof caches !== 'undefined') {
      const keys = await caches.keys();
      if (isSessionGenerationCurrent(generation)) await Promise.all(keys.filter((k) => k.startsWith('app-')).map((k) => caches.delete(k)));
    }
  } catch {
    // Cache API may be unavailable; non-fatal.
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isLoading: false,
      isInitialized: false,
      error: null,

      initialize: async () => {
        const state = get();
        if (state.isInitialized || state.isLoading) return;

        // Register session expiry callback (replace previous to avoid stale closures on HMR)
        if (_authSessionCallback) {
          api.removeSessionExpiredCallback(_authSessionCallback);
        }
        _authSessionCallback = () => {
          const current = get();
          if (current.user) {
            const expiredUserId = current.user.id;
            set({ user: null, error: null, isLoading: false, isInitialized: true });
            // Purge the same data logout() does, so an expired session doesn't leave the
            // previous user's forms/apps/responses to flash to the next person.
            void teardownUserSession(expiredUserId, 'session-expired');
            // Tell the user why they were bounced to the landing page.
            toast.warning('Session expired', 'Please sign in again to continue.');
          }
        };
        api.onSessionExpired(_authSessionCallback);

        set({ isLoading: true });
        const generation = currentSessionGeneration();
        const forgetUnconfirmedIdentity = () => {
          unconfirmedMemberOwner = get().user?.id ?? unconfirmedMemberOwner;
          set({ user: null, isLoading: false, isInitialized: true });
        };

        // Check if we have a valid session by calling getMe()
        // The HttpOnly cookie will be sent automatically
        try {
          const result = await api.getMe();
          if (!isSessionGenerationCurrent(generation)) return;
          if (result.error || !result.data) {
            // No valid session
            api.setAuthenticated(false);
            const hydratedUserId = get().user?.id ?? unconfirmedMemberOwner;
            if (result.status === 401) set({ user: null, isLoading: false, isInitialized: true });
            else forgetUnconfirmedIdentity();
            // A DEFINITIVE 401 on a previously hydrated session is a session end
            // (audit FL-10): the hydrated forms/apps/responses must be purged, not
            // merely orphaned by user:null. A network failure (no status) keeps the
            // local data — this app is offline-first.
            if (hydratedUserId && result.status === 401) {
              void teardownUserSession(hydratedUserId, 'session-expired');
            }
          } else {
            // Mark the API client as authenticated so session-expired
            // callbacks will fire correctly on subsequent 401 responses
            api.setAuthenticated(true);
            api.setDemoMode(!!result.data.user.isDemo);
            set({
              user: result.data.user,
              isLoading: false,
              isInitialized: true,
            });
            if (state.user?.id !== result.data.user.id) publishSessionTransition('fl-session-transition', result.data.user.id);
          }
        } catch {
          if (!isSessionGenerationCurrent(generation)) return;
          api.setAuthenticated(false);
          forgetUnconfirmedIdentity();
        }
      },

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        const generation = currentSessionGeneration();

        try {
          const result = await api.login(email, password);
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };

          if (result.error || !result.data) {
            set({ isLoading: false, error: result.error || 'Login failed' });
            return { success: false, error: result.error || 'Login failed' };
          }

          // Two-factor challenge: the password checked out but this browser is
          // unknown — no session yet, the Login page collects a code. `user`
          // must stay null here (setting it would auto-navigate away).
          if (result.data.mfaRequired && result.data.mfaToken) {
            set({ isLoading: false, error: null });
            return { success: false, mfaRequired: true, mfaToken: result.data.mfaToken };
          }
          if (!result.data.user) {
            set({ isLoading: false, error: 'Login failed' });
            return { success: false, error: 'Login failed' };
          }

          bumpSessionGeneration(); // a NEW identity begins (audit FL-11)
          set({
            user: result.data.user,
            isLoading: false,
            error: null,
          });
          publishSessionTransition('fl-session-transition', result.data.user.id);

          return { success: true };
        } catch (error) {
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          const errorMessage = error instanceof Error ? error.message : 'Login failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      verifyMfa: async (mfaToken: string, code: string, rememberBrowser: boolean) => {
        set({ isLoading: true, error: null });
        const generation = currentSessionGeneration();
        try {
          const result = await api.verifyMfa(mfaToken, code, rememberBrowser);
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          if (result.error || !result.data?.user) {
            const message = result.error || 'Verification failed';
            set({ isLoading: false, error: message });
            return { success: false, error: message };
          }
          bumpSessionGeneration(); // a NEW identity begins (audit FL-11)
          set({ user: result.data.user, isLoading: false, error: null });
          publishSessionTransition('fl-session-transition', result.data.user.id);
          return { success: true };
        } catch (error) {
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          const errorMessage = error instanceof Error ? error.message : 'Verification failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      startDemo: async () => {
        set({ isLoading: true, error: null });
        const generation = currentSessionGeneration();
        try {
          const result = await api.startDemo();
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          if (result.error || !result.data) {
            set({ isLoading: false, error: result.error || 'Could not start the demo' });
            return { success: false, error: result.error || 'Could not start the demo' };
          }
          api.setDemoMode(!!result.data.user.isDemo);
          bumpSessionGeneration(); // a NEW identity begins (audit FL-11)
          set({ user: result.data.user, isLoading: false, error: null });
          publishSessionTransition('fl-session-transition', result.data.user.id);
          return { success: true };
        } catch (error) {
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          const errorMessage = error instanceof Error ? error.message : 'Could not start the demo';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      register: async (email: string, password: string, name?: string) => {
        set({ isLoading: true, error: null });
        const generation = currentSessionGeneration();

        try {
          // Auto-capture the browser's timezone so the new account shows record
          // times in the user's own clock by default (editable later in Profile).
          const result = await api.register(email, password, name, browserTimezone() || undefined);
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };

          if (result.error || !result.data) {
            set({ isLoading: false, error: result.error || 'Registration failed' });
            return { success: false, error: result.error || 'Registration failed' };
          }

          bumpSessionGeneration(); // a NEW identity begins (audit FL-11)
          set({
            user: result.data.user,
            isLoading: false,
            error: null,
          });
          publishSessionTransition('fl-session-transition', result.data.user.id);

          return { success: true };
        } catch (error) {
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          const errorMessage = error instanceof Error ? error.message : 'Registration failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      logout: async () => {
        const leavingUserId = get().user?.id ?? unconfirmedMemberOwner;
        api.setAuthenticated(false);
        api.setDemoMode(false);
        set({ user: null, error: null, isLoading: false });
        // Fence and remove private state before the network can yield to a late callback.
        const cleanup = teardownUserSession(leavingUserId, 'logout');
        try {
          // Call the logout endpoint to clear the HttpOnly cookie
          await api.logout();
        } catch {
          // Even if the API call fails, clear local state
        }
        // Purge all user-specific in-memory + persisted + cached data (shared with the
        // session-expired path) so nothing leaks between sessions on a shared device.
        await cleanup;
      },

      updateProfile: async (data: Partial<User>) => {
        set({ isLoading: true, error: null });
        const generation = currentSessionGeneration();

        try {
          const result = await api.updateProfile(data);
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };

          if (result.error || !result.data) {
            set({ isLoading: false, error: result.error || 'Update failed' });
            return { success: false, error: result.error || 'Update failed' };
          }

          set({
            user: result.data.user,
            isLoading: false,
            error: null,
          });

          return { success: true };
        } catch (error) {
          if (!isSessionGenerationCurrent(generation)) return { success: false, error: 'Session changed. Please try again.' };
          const errorMessage = error instanceof Error ? error.message : 'Update failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'formlogic-auth',
      // Only persist user data for UI convenience (not for auth - that's handled by HttpOnly cookie)
      partialize: (state) => ({
        user: state.user,
      }),
    }
  )
);

// Mirror the signed-in owner into the session module (audit FL-09): the offline
// queue stamps every row with its owner and flushes only the current owner's rows.
setSessionOwner(useAuthStore.getState().user?.id ?? null);
useAuthStore.subscribe((state) => {
  const next = state.user?.id ?? null;
  setSessionOwner(next); // Fences the old owner: its private storage opens to nobody else.
  if (next) unconfirmedMemberOwner = null;
});

// Cross-tab teardown (audit FL-10): when another tab ends the session (logout,
// expiry, account deletion), clear THIS tab's stores too — without re-broadcasting.
// An expiry there is an expiry here (queued submissions kept); anything else is a remote
// teardown, which forgets the account's queued submissions as a sign-out does.
export async function handleSessionBroadcast(data: SessionMessage | null): Promise<void> {
  if (!data || (data.type !== 'fl-teardown' && data.type !== 'fl-session-transition')) return;
  if (typeof data.revision === 'string') {
    if (data.revision === lastHandledTransition) return;
    try {
      const latest: unknown = JSON.parse(localStorage.getItem(SESSION_TRANSITION_KEY) ?? 'null');
      if (data.ordered !== false && latest && typeof latest === 'object' && (latest as SessionMessage).revision !== data.revision) return;
    } catch { /* Without shared ordering metadata, a matching teardown is conservative. */ }
    lastHandledTransition = data.revision;
  } else if (data.type === 'fl-session-transition') return;
  const user = useAuthStore.getState().user;
  if (data.type === 'fl-session-transition') {
    if (typeof data.userId !== 'string' || data.userId.length === 0) return;
    if (user === null || user.id === data.userId) {
      if (unconfirmedMemberOwner !== data.userId) unconfirmedMemberOwner = null;
      // Refetch admission, never install the broadcast's claimed identity.
      bumpSessionGeneration();
      withMemoryOnlyPersistence(() => useAuthStore.setState({ isLoading: false, error: null }));
      return;
    }
  } else if (user !== null && typeof data.userId === 'string' && data.userId !== user.id) return;
  if (user === null) {
    // A tab can be awaiting startup or sign-in without a hydrated user. The
    // ended cookie still invalidates that pending continuation.
    bumpSessionGeneration();
    const leaving = typeof data.userId === 'string' ? data.userId : unconfirmedMemberOwner;
    if (leaving && data.reason !== 'session-expired') clearNativeMemberStorage(leaving);
    if (leaving === unconfirmedMemberOwner) unconfirmedMemberOwner = null;
    withMemoryOnlyPersistence(() => useAuthStore.setState({ isLoading: false, error: null }));
    return;
  }
  // Captured before the store forgets it. A tab from before the id was sent names none.
  const userId = user.id;
  api.setAuthenticated(false);
  api.setDemoMode(false);
  withMemoryOnlyPersistence(() => useAuthStore.setState({ user: null, error: null, isLoading: false }));
  await teardownUserSession(userId, data.reason === 'session-expired' ? 'session-expired' : 'remote-teardown', false, true);
}

// Whose OAIY token and allowed apps this page uses. The shared demo account never keeps either.
const followLocalAccount = (user: User | null) => {
  const account = user && !user.isDemo ? user.id : null;
  setOaiyTokenAccount(account);
  setAppLocalAccessAccount(account);
};
followLocalAccount(useAuthStore.getState().user);
useAuthStore.subscribe((state) => followLocalAccount(state.user));

// Browser-only: vitest runs in node, and the module-level channel would leak there.
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    const sessionChannel = new BroadcastChannel(SESSION_CHANNEL);
    sessionChannel.onmessage = (event: MessageEvent) => {
      void handleSessionBroadcast(event.data as SessionMessage | null);
    };
  } catch {
    // BroadcastChannel construction failed — single-tab behavior remains correct.
  }
}

// localStorage delivers the same transition when BroadcastChannel is unavailable.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== SESSION_TRANSITION_KEY || !event.newValue) return;
    try { void handleSessionBroadcast(JSON.parse(event.newValue) as SessionMessage); } catch { /* Invalid ordering metadata is ignored. */ }
  });
}
