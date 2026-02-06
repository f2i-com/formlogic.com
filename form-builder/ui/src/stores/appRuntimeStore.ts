import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import type { LinkedRecord } from '../lib/api';
import type { AppRuntimeConfig, AppRuntimeForm, AppUserPermissions } from '../types/app';

interface AppRuntimeState {
  config: AppRuntimeConfig | null;
  appSlug: string | null;
  activeFormId: string | null;
  sidebarCollapsed: boolean;
  isLoading: boolean;
  error: string | null;
  permissions: AppUserPermissions | null;

  // Actions
  initialize: (appSlug: string) => Promise<void>;
  setActiveForm: (formId: string | null) => void;
  toggleSidebar: () => void;
  reset: () => void;

  // Response CRUD
  fetchResponses: (formId: string, options?: { limit?: number; offset?: number; resolve?: boolean }) => Promise<unknown[]>;
  createResponse: (formId: string, answers: Record<string, unknown>) => Promise<unknown>;
  updateResponse: (formId: string, responseId: string, data: Record<string, unknown>) => Promise<unknown>;
  deleteResponse: (formId: string, responseId: string) => Promise<boolean>;

  // Linked records
  lookupRecords: (formId: string, options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number }) => Promise<LinkedRecord[]>;

  // Permission helpers
  canSubmit: (formId: string) => boolean;
  canViewOwn: (formId: string) => boolean;
  canViewAll: (formId: string) => boolean;
  canEdit: (formId: string) => boolean;
  canDelete: (formId: string) => boolean;
  canExport: (formId: string) => boolean;
}

export const useAppRuntimeStore = create<AppRuntimeState>()(
  persist(
    (set, get) => ({
      config: null,
      appSlug: null,
      activeFormId: null,
      sidebarCollapsed: false,
      isLoading: false,
      error: null,
      permissions: null,

      initialize: async (appSlug: string) => {
        set({ isLoading: true, error: null, appSlug });
        const result = await api.getAppRuntime(appSlug);
        if (result.error) {
          set({ error: result.error, isLoading: false });
          return;
        }
        if (result.data) {
          const data = result.data as Record<string, unknown>;
          const perms = data.permissions as AppUserPermissions | undefined;
          const forms = (data.forms as AppRuntimeForm[]) ?? [];
          const config: AppRuntimeConfig = {
            app: data.app as AppRuntimeConfig['app'],
            forms,
            userPermissions: perms?.formLevel ?? {},
          };
          set({
            config,
            permissions: perms ?? null,
            isLoading: false,
            activeFormId: forms[0]?.formId ?? null,
          });
        }
      },

      setActiveForm: (formId) => set({ activeFormId: formId }),

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      reset: () => set({
        config: null,
        appSlug: null,
        activeFormId: null,
        isLoading: false,
        error: null,
        permissions: null,
      }),

      fetchResponses: async (formId, options) => {
        const slug = get().appSlug;
        if (!slug) return [];
        if (options?.resolve) {
          const result = await api.getAppResponsesResolved(slug, formId, options);
          return result.data?.responses ?? [];
        }
        const result = await api.getAppResponses(slug, formId, options);
        return result.data?.responses ?? [];
      },

      createResponse: async (formId, answers) => {
        const slug = get().appSlug;
        if (!slug) throw new Error('App not initialized');
        const result = await api.createAppResponse(slug, formId, { answers });
        if (result.error) throw new Error(result.error);
        return result.data?.response;
      },

      updateResponse: async (formId, responseId, data) => {
        const slug = get().appSlug;
        if (!slug) throw new Error('App not initialized');
        const result = await api.updateAppResponse(slug, formId, responseId, data);
        if (result.error) throw new Error(result.error);
        return result.data?.response;
      },

      deleteResponse: async (formId, responseId) => {
        const slug = get().appSlug;
        if (!slug) return false;
        const result = await api.deleteAppResponse(slug, formId, responseId);
        return !result.error;
      },

      lookupRecords: async (formId, options) => {
        const slug = get().appSlug;
        if (!slug) return [];
        const result = await api.lookupLinkedRecords(slug, formId, options);
        return result.data?.records ?? [];
      },

      // Permission helpers check both app-level and form-level permissions
      canSubmit: (formId) => {
        const p = get().permissions;
        if (!p) return false;
        return p.appLevel.includes('manage_app') || p.appLevel.includes('submit_responses') || (p.formLevel[formId]?.includes('submit_responses') ?? false);
      },

      canViewOwn: (formId) => {
        const p = get().permissions;
        if (!p) return false;
        return p.appLevel.includes('manage_app') || p.appLevel.includes('view_own_responses') || (p.formLevel[formId]?.includes('view_own_responses') ?? false);
      },

      canViewAll: (formId) => {
        const p = get().permissions;
        if (!p) return false;
        return p.appLevel.includes('manage_app') || p.appLevel.includes('view_all_responses') || (p.formLevel[formId]?.includes('view_all_responses') ?? false);
      },

      canEdit: (formId) => {
        const p = get().permissions;
        if (!p) return false;
        return p.appLevel.includes('manage_app') || p.appLevel.includes('edit_responses') || (p.formLevel[formId]?.includes('edit_responses') ?? false);
      },

      canDelete: (formId) => {
        const p = get().permissions;
        if (!p) return false;
        return p.appLevel.includes('manage_app') || p.appLevel.includes('delete_responses') || (p.formLevel[formId]?.includes('delete_responses') ?? false);
      },

      canExport: (formId) => {
        const p = get().permissions;
        if (!p) return false;
        return p.appLevel.includes('manage_app') || p.appLevel.includes('export_responses') || (p.formLevel[formId]?.includes('export_responses') ?? false);
      },
    }),
    {
      name: 'formlogic-app-runtime',
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        appSlug: state.appSlug,
      }),
    }
  )
);
