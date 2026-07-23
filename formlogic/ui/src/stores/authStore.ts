import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import { browserTimezone } from '../lib/timezone';
import { bumpSessionGeneration, setSessionOwner } from '../lib/sessionGeneration';
import { useFormStore, clearAllDebounceTimers } from './formStore';
import { useAppStore } from './appStore';
import { useAppUserStore } from './appUserStore';
import { useAppRuntimeStore } from './appRuntimeStore';
import { useResponseStore } from './responseStore';
import { toast } from './toastStore';

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
  /** Platform administrator (unlocks the /admin panel). */
  isAdmin?: boolean;
  /** Two-factor authentication switched on (drives the Settings card + signup nudge). */
  mfaEnabled?: boolean;
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

/**
 * Centralized, awaited whole-client teardown (audit FL-10/FL-11). Purges all
 * user-specific in-memory state + persisted localStorage + cached app data; for
 * account deletion it also erases the user's chat database and queued offline
 * submissions. Shared by logout(), the session-expired (401) path, account
 * deletion, and cross-tab propagation, so an ended session can't leave a previous
 * user's data to flash to (or be sent by) the next user on a shared device.
 */
export async function teardownUserSession(
  userId: string | null,
  reason: SessionTeardownReason,
  broadcast = true
): Promise<void> {
  // The generation bump comes FIRST (audit FL-11): an authenticated request still in
  // flight compares its captured generation on resolve and DISCARDS its result rather
  // than repopulating the stores this teardown is about to clear.
  bumpSessionGeneration();

  await clearUserSessionData();

  if (userId && reason === 'account-deleted') {
    // A deleted account leaves NOTHING behind (audit FL-10): the per-user chat DB
    // (plaintext transcripts + image data URIs) and the user's queued offline
    // submissions are erased, not merely detached.
    try {
      const chat = await import('../components/chat/chatStore');
      await chat.deleteChatDataForUser(userId);
    } catch {
      // best-effort — teardown must never block account deletion
    }
    try {
      const queue = await import('../client-runtime/offlineQueue');
      await queue.purgeQueueForOwner(userId);
    } catch {
      // best-effort
    }
  }

  // Propagate to sibling tabs (audit FL-10): a teardown in one tab must not leave
  // another tab's stores hydrated with the dead session's data.
  if (broadcast && typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage({ type: 'fl-teardown', reason });
      channel.close();
    } catch {
      // BroadcastChannel unavailable — single-tab cleanup still holds
    }
  }
}

/**
 * Purge all user-specific in-memory state + persisted localStorage + cached app data.
 * Prefer teardownUserSession() — it adds the FL-11 generation bump, per-user database
 * erasure, and cross-tab propagation.
 */
async function clearUserSessionData(): Promise<void> {
  // Cancel pending debounced saves so stale callbacks can't fire after the purge.
  clearAllDebounceTimers();

  // Lock the E2EE vault (terminates the crypto worker, bumps the vault
  // generation so every decrypted cache drops, and propagates to other tabs).
  // Dynamic import keeps the crypto worker out of the base bundle for sessions
  // that never touch private forms.
  try {
    const vault = await import('./vaultStore');
    vault.lockVaultForSessionTeardown();
    vault.useVaultStore.setState({ status: 'unknown', vault: null });
  } catch {
    // Never let vault teardown block the logout path.
  }

  useFormStore.setState({ forms: [], isInitialized: false, isLoading: false, activeFormId: null, selectedFieldId: null, error: null, savingFormIds: {} });
  useAppStore.setState({ apps: [], activeAppId: null, isLoading: false, _loadingCount: 0, error: null });
  useAppUserStore.getState().reset();
  useAppRuntimeStore.getState().reset();
  useResponseStore.setState({ responses: [], currentFormId: null, currentAnswers: {}, currentStep: 0, startTime: null });

  try {
    localStorage.removeItem('formlogic-auth');
    localStorage.removeItem('formlogic-forms');
    localStorage.removeItem('formlogic-apps');
    localStorage.removeItem('formlogic-responses');
    localStorage.removeItem('formlogic-app-runtime');
    localStorage.removeItem('formlogic_storage_mode');
  } catch {
    // localStorage may be unavailable (e.g. private browsing)
  }

  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('app-')).map((k) => caches.delete(k)));
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
            set({ user: null, error: null });
            // Purge the same data logout() does, so an expired session doesn't leave the
            // previous user's forms/apps/responses to flash to the next person.
            void teardownUserSession(expiredUserId, 'session-expired');
            // Tell the user why they were bounced to the landing page.
            toast.warning('Session expired', 'Please sign in again to continue.');
          }
        };
        api.onSessionExpired(_authSessionCallback);

        set({ isLoading: true });

        // Check if we have a valid session by calling getMe()
        // The HttpOnly cookie will be sent automatically
        try {
          const result = await api.getMe();
          if (result.error || !result.data) {
            // No valid session
            api.setAuthenticated(false);
            const hydratedUser = get().user;
            set({ user: null, isLoading: false, isInitialized: true });
            // A DEFINITIVE 401 on a previously hydrated session is a session end
            // (audit FL-10): the hydrated forms/apps/responses must be purged, not
            // merely orphaned by user:null. A network failure (no status) keeps the
            // local data — this app is offline-first.
            if (hydratedUser && result.status === 401) {
              void teardownUserSession(hydratedUser.id, 'session-expired');
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
          }
        } catch {
          api.setAuthenticated(false);
          set({ user: null, isLoading: false, isInitialized: true });
        }
      },

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });

        try {
          const result = await api.login(email, password);

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

          return { success: true };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Login failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      verifyMfa: async (mfaToken: string, code: string, rememberBrowser: boolean) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.verifyMfa(mfaToken, code, rememberBrowser);
          if (result.error || !result.data?.user) {
            const message = result.error || 'Verification failed';
            set({ isLoading: false, error: message });
            return { success: false, error: message };
          }
          bumpSessionGeneration(); // a NEW identity begins (audit FL-11)
          set({ user: result.data.user, isLoading: false, error: null });
          return { success: true };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Verification failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      startDemo: async () => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.startDemo();
          if (result.error || !result.data) {
            set({ isLoading: false, error: result.error || 'Could not start the demo' });
            return { success: false, error: result.error || 'Could not start the demo' };
          }
          api.setDemoMode(!!result.data.user.isDemo);
          bumpSessionGeneration(); // a NEW identity begins (audit FL-11)
          set({ user: result.data.user, isLoading: false, error: null });
          return { success: true };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Could not start the demo';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      register: async (email: string, password: string, name?: string) => {
        set({ isLoading: true, error: null });

        try {
          // Auto-capture the browser's timezone so the new account shows record
          // times in the user's own clock by default (editable later in Profile).
          const result = await api.register(email, password, name, browserTimezone() || undefined);

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

          return { success: true };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Registration failed';
          set({ isLoading: false, error: errorMessage });
          return { success: false, error: errorMessage };
        }
      },

      logout: async () => {
        const leavingUserId = get().user?.id ?? null;
        try {
          // Call the logout endpoint to clear the HttpOnly cookie
          await api.logout();
        } catch {
          // Even if the API call fails, clear local state
        }
        api.setDemoMode(false);
        set({ user: null, error: null });

        // Purge all user-specific in-memory + persisted + cached data (shared with the
        // session-expired path) so nothing leaks between sessions on a shared device.
        await teardownUserSession(leavingUserId, 'logout');
      },

      updateProfile: async (data: Partial<User>) => {
        set({ isLoading: true, error: null });

        try {
          const result = await api.updateProfile(data);

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
useAuthStore.subscribe((state) => setSessionOwner(state.user?.id ?? null));

// Cross-tab teardown (audit FL-10): when another tab ends the session (logout,
// expiry, account deletion), clear THIS tab's stores too — without re-broadcasting.
// Browser-only: vitest runs in node, and the module-level channel would leak there.
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    const sessionChannel = new BroadcastChannel(SESSION_CHANNEL);
    sessionChannel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (!data || data.type !== 'fl-teardown') return;
      if (useAuthStore.getState().user === null) return;
      useAuthStore.setState({ user: null, error: null });
      void teardownUserSession(null, 'remote-teardown', false);
    };
  } catch {
    // BroadcastChannel construction failed — single-tab behavior remains correct.
  }
}
