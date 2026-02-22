import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import { useFormStore } from './formStore';
import { useAppStore } from './appStore';
import { useAppRuntimeStore } from './appRuntimeStore';

interface User {
  id: string;
  email: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (email: string, password: string, name?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<{ success: boolean; error?: string }>;
  clearError: () => void;
}

let _authSessionCallback: (() => void) | null = null;

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
            set({ user: null, error: null });
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
            set({ user: null, isLoading: false, isInitialized: true });
          } else {
            // Mark the API client as authenticated so session-expired
            // callbacks will fire correctly on subsequent 401 responses
            api.setAuthenticated(true);
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

      register: async (email: string, password: string, name?: string) => {
        set({ isLoading: true, error: null });

        try {
          const result = await api.register(email, password, name);

          if (result.error || !result.data) {
            set({ isLoading: false, error: result.error || 'Registration failed' });
            return { success: false, error: result.error || 'Registration failed' };
          }

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
        try {
          // Call the logout endpoint to clear the HttpOnly cookie
          await api.logout();
        } catch {
          // Even if the API call fails, clear local state
        }
        set({ user: null, error: null });

        // Clear in-memory state of all user-specific stores immediately
        // so stale data never leaks between sessions
        useFormStore.setState({ forms: [], isInitialized: false, isLoading: false, activeFormId: null, selectedFieldId: null, error: null });
        useAppStore.setState({ apps: [], activeAppId: null, isLoading: false, error: null });
        useAppRuntimeStore.getState().reset();

        // Clear persisted data from localStorage to prevent data
        // leakage if another user logs in on the same browser
        try {
          localStorage.removeItem('formlogic-auth');
          localStorage.removeItem('formlogic-forms');
          localStorage.removeItem('formlogic-apps');
          localStorage.removeItem('formlogic-responses');
          localStorage.removeItem('formlogic-app-runtime');
        } catch {
          // localStorage may be unavailable (e.g. private browsing)
        }
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
