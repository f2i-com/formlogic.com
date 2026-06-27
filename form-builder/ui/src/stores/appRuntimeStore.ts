import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import { toast } from './toastStore';
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
  roleName: string | null;

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
  lookupRecords: (formId: string, options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; ids?: string[] }) => Promise<LinkedRecord[]>;

  // Permission helpers
  canSubmit: (formId: string) => boolean;
  canViewOwn: (formId: string) => boolean;
  canViewAll: (formId: string) => boolean;
  canEdit: (formId: string) => boolean;
  canDelete: (formId: string) => boolean;
  canExport: (formId: string) => boolean;
}

let _appRuntimeSessionCallback: (() => void) | null = null;

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
      roleName: null,

      initialize: async (appSlug: string) => {
        // Register cleanup callback (replace previous to avoid stale closures on HMR)
        if (_appRuntimeSessionCallback) {
          api.removeSessionExpiredCallback(_appRuntimeSessionCallback);
        }
        _appRuntimeSessionCallback = () => {
          get().reset();
        };
        api.onSessionExpired(_appRuntimeSessionCallback);

        set({ isLoading: true, error: null, appSlug, config: null, permissions: null, roleName: null, activeFormId: null });
        try {
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
            const appUser = data.user as Record<string, unknown> | undefined;
            set({
              config,
              permissions: perms ?? null,
              roleName: (appUser?.roleName as string) ?? null,
              isLoading: false,
              activeFormId: null,
            });
          }
        } catch (e) {
          set({ error: e instanceof Error ? e.message : 'Failed to load app', isLoading: false });
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
        roleName: null,
      }),

      fetchResponses: async (formId, options) => {
        const slug = get().appSlug;
        if (!slug) return [];
        // Throw on API/network failure so the consumer's .catch surfaces an error
        // state instead of rendering a misleading empty "0 responses" table.
        if (options?.resolve) {
          const result = await api.getAppResponsesResolved(slug, formId, options);
          if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Failed to load responses');
          return result.data?.responses ?? [];
        }
        const result = await api.getAppResponses(slug, formId, options);
        if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Failed to load responses');
        return result.data?.responses ?? [];
      },

      createResponse: async (formId, answers) => {
        const slug = get().appSlug;
        if (!slug) throw new Error('App not initialized');
        const result = await api.createAppResponse(slug, formId, { answers });
        if (result.error) throw new Error(result.error);
        if (!result.data?.response) throw new Error('Submission failed: no response was returned.');
        return result.data.response;
      },

      updateResponse: async (formId, responseId, data) => {
        const slug = get().appSlug;
        if (!slug) throw new Error('App not initialized');
        const result = await api.updateAppResponse(slug, formId, responseId, data);
        if (result.error) throw new Error(result.error);
        if (!result.data?.response) throw new Error('Update failed: no response was returned.');
        return result.data.response;
      },

      deleteResponse: async (formId, responseId) => {
        const slug = get().appSlug;
        if (!slug) return false;
        const result = await api.deleteAppResponse(slug, formId, responseId);
        if (result.error) {
          // Surface the failure — otherwise the dialog just closes, the row stays,
          // and the user gets no signal that the delete failed.
          toast.error('Delete failed', typeof result.error === 'string' ? result.error : 'Could not delete this response. Please try again.');
          return false;
        }
        return true;
      },

      lookupRecords: async (formId, options) => {
        const slug = get().appSlug;
        if (!slug) return [];
        const result = await api.lookupLinkedRecords(slug, formId, options);
        if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Failed to look up records');
        return result.data?.records ?? [];
      },

      // Permission helpers check both app-level and form-level permissions.
      // NOTE: manage_app is NOT a data-access wildcard — the server
      // (AppUserService::hasPermission) only treats the real app owner as a
      // wildcard, so enabling controls on manage_app alone would show actions the
      // server then rejects (403). Gate each control on its specific permission.
      canSubmit: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('submit_responses') || (p.formLevel?.[formId]?.includes('submit_responses') ?? false);
      },

      canViewOwn: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('view_own_responses') || (p.formLevel?.[formId]?.includes('view_own_responses') ?? false);
      },

      canViewAll: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('view_all_responses') || (p.formLevel?.[formId]?.includes('view_all_responses') ?? false);
      },

      canEdit: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('edit_responses') || (p.formLevel?.[formId]?.includes('edit_responses') ?? false);
      },

      canDelete: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('delete_responses') || (p.formLevel?.[formId]?.includes('delete_responses') ?? false);
      },

      canExport: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('export_responses') || (p.formLevel?.[formId]?.includes('export_responses') ?? false);
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
