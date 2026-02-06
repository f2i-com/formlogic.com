import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import { useFormStore } from './formStore';
import type { App, AppForm, AppRole } from '../types/app';

interface AppState {
  apps: App[];
  activeAppId: string | null;
  isLoading: boolean;
  error: string | null;

  // App CRUD
  fetchApps: () => Promise<void>;
  createApp: (data: Partial<App>) => Promise<App | null>;
  updateApp: (id: string, data: Partial<App>) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;
  getApp: (id: string) => App | undefined;
  setActiveApp: (id: string | null) => void;

  // Form management
  fetchAppForms: (appId: string) => Promise<AppForm[]>;
  addFormToApp: (appId: string, formId: string, displayName?: string) => Promise<void>;
  removeFormFromApp: (appId: string, formId: string) => Promise<void>;
  updateAppForm: (appId: string, formId: string, data: Partial<AppForm>) => Promise<void>;
  reorderAppForms: (appId: string, formIds: string[]) => Promise<void>;

  // Role management
  fetchRoles: (appId: string) => Promise<AppRole[]>;
  createRole: (appId: string, data: { name: string; description?: string }) => Promise<AppRole | null>;
  updateRole: (appId: string, roleId: string, data: Partial<AppRole>) => Promise<void>;
  deleteRole: (appId: string, roleId: string) => Promise<void>;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      apps: [],
      activeAppId: null,
      isLoading: false,
      error: null,

      fetchApps: async () => {
        set({ isLoading: true, error: null });
        const result = await api.getApps();
        if (result.error) {
          set({ error: result.error, isLoading: false });
        } else {
          set({ apps: (result.data?.apps as App[]) ?? [], isLoading: false });
        }
      },

      createApp: async (data) => {
        set({ isLoading: true, error: null });
        const result = await api.createApp(data);
        if (result.error) {
          set({ error: result.error, isLoading: false });
          return null;
        }
        const app = result.data?.app as App;
        set((s) => ({ apps: [...s.apps, app], isLoading: false }));
        return app;
      },

      updateApp: async (id, data) => {
        const result = await api.updateApp(id, data);
        if (!result.error && result.data) {
          set((s) => ({
            apps: s.apps.map((a) => (a.id === id ? (result.data!.app as App) : a)),
          }));
        }
      },

      deleteApp: async (id) => {
        const result = await api.deleteApp(id);
        if (result.error) return;
        set((s) => ({
          apps: s.apps.filter((a) => a.id !== id),
          activeAppId: s.activeAppId === id ? null : s.activeAppId,
        }));
      },

      getApp: (id) => get().apps.find((a) => a.id === id),

      setActiveApp: (id) => set({ activeAppId: id }),

      fetchAppForms: async (appId) => {
        const result = await api.getAppForms(appId);
        return (result.data?.forms ?? []) as AppForm[];
      },

      addFormToApp: async (appId, formId, displayName) => {
        // Ensure the form exists on the server (may only be in local storage)
        const form = useFormStore.getState().forms.find((f) => f.id === formId);
        if (form) {
          await api.createForm(form);
        }
        const result = await api.addAppForm(appId, formId, displayName);
        if (result.error) return;
      },

      removeFormFromApp: async (appId, formId) => {
        const result = await api.removeAppForm(appId, formId);
        if (result.error) return;
      },

      updateAppForm: async (appId, formId, data) => {
        const result = await api.updateAppForm(appId, formId, data);
        if (result.error) return;
      },

      reorderAppForms: async (appId, formIds) => {
        const result = await api.reorderAppForms(appId, formIds);
        if (result.error) return;
      },

      fetchRoles: async (appId) => {
        const result = await api.getAppRoles(appId);
        return (result.data?.roles ?? []) as AppRole[];
      },

      createRole: async (appId, data) => {
        const result = await api.createAppRole(appId, data);
        if (result.error) return null;
        return result.data?.role as AppRole;
      },

      updateRole: async (appId, roleId, data) => {
        await api.updateAppRole(appId, roleId, data);
      },

      deleteRole: async (appId, roleId) => {
        await api.deleteAppRole(appId, roleId);
      },
    }),
    {
      name: 'formlogic-apps',
      partialize: (state) => ({
        apps: state.apps,
        activeAppId: state.activeAppId,
      }),
    }
  )
);
