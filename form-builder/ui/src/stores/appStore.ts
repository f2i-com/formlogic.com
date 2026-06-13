import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import { useFormStore } from './formStore';
import { toast } from './toastStore';
import type { App, AppForm, AppRole } from '../types/app';

interface AppState {
  apps: App[];
  activeAppId: string | null;
  isLoading: boolean;
  _loadingCount: number;
  error: string | null;

  // App CRUD
  fetchApps: () => Promise<void>;
  createApp: (data: Partial<App>) => Promise<App | null>;
  updateApp: (id: string, data: Partial<App>) => Promise<boolean>;
  deleteApp: (id: string) => Promise<void>;
  getApp: (id: string) => App | undefined;
  setActiveApp: (id: string | null) => void;

  // Form management
  fetchAppForms: (appId: string) => Promise<AppForm[]>;
  addFormToApp: (appId: string, formId: string, displayName?: string) => Promise<boolean>;
  removeFormFromApp: (appId: string, formId: string) => Promise<void>;
  updateAppForm: (appId: string, formId: string, data: Partial<AppForm>) => Promise<void>;
  reorderAppForms: (appId: string, formIds: string[]) => Promise<void>;

  // Role management
  fetchRoles: (appId: string) => Promise<AppRole[]>;
  createRole: (appId: string, data: { name: string; description?: string }) => Promise<AppRole | null>;
  updateRole: (appId: string, roleId: string, data: Partial<AppRole>) => Promise<void>;
  deleteRole: (appId: string, roleId: string) => Promise<boolean>;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => {
      const startLoading = () => set((s) => ({ _loadingCount: s._loadingCount + 1, isLoading: true }));
      const stopLoading = () => set((s) => {
        const next = Math.max(0, s._loadingCount - 1);
        return { _loadingCount: next, isLoading: next > 0 };
      });

      return ({
      apps: [],
      activeAppId: null,
      isLoading: false,
      _loadingCount: 0,
      error: null,

      fetchApps: async () => {
        startLoading(); set({ error: null });
        try {
          const result = await api.getApps();
          if (result.error) {
            set({ error: result.error });
          } else {
            set({ apps: (result.data?.apps as App[]) ?? [] });
          }
        } catch (e) {
          set({ error: e instanceof Error ? e.message : 'Failed to fetch apps' });
        } finally {
          stopLoading();
        }
      },

      createApp: async (data) => {
        startLoading(); set({ error: null });
        try {
          const result = await api.createApp(data);
          if (result.error) {
            set({ error: result.error });
            return null;
          }
          const app = result.data?.app as App;
          set((s) => ({ apps: [...s.apps, app] }));
          return app;
        } catch (e) {
          set({ error: e instanceof Error ? e.message : 'Failed to create app' });
          return null;
        } finally {
          stopLoading();
        }
      },

      updateApp: async (id, data) => {
        startLoading(); set({ error: null });
        try {
          const result = await api.updateApp(id, data);
          if (result.error) {
            toast.error('Update failed', result.error);
            return false;
          }
          if (result.data) {
            set((s) => ({
              apps: s.apps.map((a) => (a.id === id ? (result.data!.app as App) : a)),
            }));
          }
          return true;
        } catch {
          toast.error('Update failed', 'Could not update the app. Please try again.');
          return false;
        } finally {
          stopLoading();
        }
      },

      deleteApp: async (id) => {
        startLoading(); set({ error: null });
        try {
          const result = await api.deleteApp(id);
          if (result.error) {
            toast.error('Delete failed', result.error);
            return;
          }
          set((s) => ({
            apps: s.apps.filter((a) => a.id !== id),
            activeAppId: s.activeAppId === id ? null : s.activeAppId,
          }));
        } catch {
          toast.error('Delete failed', 'Could not delete the app. Please try again.');
        } finally {
          stopLoading();
        }
      },

      getApp: (id) => get().apps.find((a) => a.id === id),

      setActiveApp: (id) => set({ activeAppId: id }),

      fetchAppForms: async (appId) => {
        const result = await api.getAppForms(appId);
        if (result.error) {
          toast.error('Load failed', 'Could not load app forms.');
        }
        return (result.data?.forms ?? []) as AppForm[];
      },

      addFormToApp: async (appId, formId, displayName) => {
        try {
          // Ensure the form exists on the server (may only be in local storage)
          const form = useFormStore.getState().forms.find((f) => f.id === formId);
          if (form) {
            const syncResult = await api.createForm(form);
            // Ignore "already exists" errors — the form is already on the server
            if (syncResult.error && !syncResult.error.toLowerCase().includes('already exists')) {
              toast.error('Sync failed', syncResult.error);
              return false;
            }
          }
          const result = await api.addAppForm(appId, formId, displayName);
          if (result.error) {
            toast.error('Failed to add form', result.error);
            return false;
          }
          return true;
        } catch {
          toast.error('Failed to add form', 'An unexpected error occurred.');
          return false;
        }
      },

      removeFormFromApp: async (appId, formId) => {
        try {
          const result = await api.removeAppForm(appId, formId);
          if (result.error) toast.error('Remove failed', result.error);
        } catch {
          toast.error('Remove failed', 'Could not remove the form. Please try again.');
        }
      },

      updateAppForm: async (appId, formId, data) => {
        try {
          const result = await api.updateAppForm(appId, formId, data);
          if (result.error) toast.error('Update failed', result.error);
        } catch {
          toast.error('Update failed', 'Could not update the form. Please try again.');
        }
      },

      reorderAppForms: async (appId, formIds) => {
        try {
          const result = await api.reorderAppForms(appId, formIds);
          if (result.error) toast.error('Reorder failed', result.error);
        } catch {
          toast.error('Reorder failed', 'Could not reorder forms. Please try again.');
        }
      },

      fetchRoles: async (appId) => {
        const result = await api.getAppRoles(appId);
        if (result.error) {
          toast.error('Load failed', 'Could not load roles.');
        }
        return (result.data?.roles ?? []) as AppRole[];
      },

      createRole: async (appId, data) => {
        const result = await api.createAppRole(appId, data);
        if (result.error) {
          toast.error('Create failed', result.error);
          return null;
        }
        return (result.data?.role as AppRole) ?? null;
      },

      updateRole: async (appId, roleId, data) => {
        const result = await api.updateAppRole(appId, roleId, data);
        if (result.error) {
          toast.error('Update failed', result.error);
        }
      },

      deleteRole: async (appId, roleId) => {
        const result = await api.deleteAppRole(appId, roleId);
        if (result.error) {
          toast.error('Delete failed', result.error);
          return false;
        }
        return true;
      },
    })},
    {
      name: 'formlogic-apps',
      partialize: (state) => ({
        apps: state.apps,
        activeAppId: state.activeAppId,
      }),
    }
  )
);
