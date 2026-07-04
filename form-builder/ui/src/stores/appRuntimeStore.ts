import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';
import { toast } from './toastStore';
import type { LinkedRecord } from '../lib/api';
import type { AppRuntimeConfig, AppRuntimeForm, AppUserPermissions, AppReportItem, AppReportSpec, AppReportResult, DashboardScreen } from '../types/app';
import type { CustomScreen } from '../types/form';

// Demo report + dashboard authoring stays per-browser (the shared demo is read-only on the server).
const demoReportsKey = (appId: string) => `formlogic-demo-reports-${appId}`;
const demoDashboardKey = (appId: string) => `formlogic-demo-dashboard-${appId}`;
const demoFormDashboardKey = (formId: string) => `formlogic-demo-form-dashboard-${formId}`;

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
  fetchResponsePage: (formId: string, options: { limit: number; offset: number; search?: string; resolve?: boolean }) => Promise<{ rows: unknown[]; total: number }>;
  /** Newest rows of a form as {id, answers, submittedAt} — demo-aware; powers dashboard list/activity widgets. */
  fetchRecentRows: (formId: string, limit: number) => Promise<Array<{ id: string; answers: Record<string, unknown>; submittedAt: string }>>;
  createResponse: (formId: string, answers: Record<string, unknown>) => Promise<unknown>;
  updateResponse: (formId: string, responseId: string, data: Record<string, unknown>) => Promise<unknown>;
  deleteResponse: (formId: string, responseId: string) => Promise<boolean>;

  // Linked records
  lookupRecords: (formId: string, options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; ids?: string[] }) => Promise<LinkedRecord[]>;

  // Reports
  runReport: (spec: AppReportSpec) => Promise<AppReportResult | null>;
  runReportBatch: (specs: AppReportSpec[]) => Promise<(AppReportResult | null)[]>;
  saveReports: (reports: AppReportItem[]) => Promise<boolean>;

  // Dashboard (widget home screen, stored on app.customScreen)
  saveDashboard: (screen: DashboardScreen) => Promise<boolean>;
  // Section-screen dashboard for one form (stored on that form's customScreen)
  saveFormDashboard: (formId: string, screen: DashboardScreen) => Promise<boolean>;

  // Permission helpers
  /** True only for the app owner (someone who can manage/edit the app + its dashboards). */
  isOwner: () => boolean;
  canSubmit: (formId: string) => boolean;
  canViewOwn: (formId: string) => boolean;
  canViewAll: (formId: string) => boolean;
  canEdit: (formId: string) => boolean;
  canDelete: (formId: string) => boolean;
  canExport: (formId: string) => boolean;
  canViewAnalytics: (formId: string) => boolean;
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
            const app = data.app as AppRuntimeConfig['app'];
            // Demo authors reports + dashboards in their browser only — merge any local ones over the server set.
            if (api.isDemoMode() && app?.id) {
              try {
                const raw = localStorage.getItem(demoReportsKey(app.id));
                if (raw) { app.reports = JSON.parse(raw) as AppReportItem[]; }
                const dash = localStorage.getItem(demoDashboardKey(app.id));
                if (dash) { app.customScreen = JSON.parse(dash) as CustomScreen; }
                for (const f of forms) {
                  const fd = localStorage.getItem(demoFormDashboardKey(f.formId));
                  if (fd) { f.customScreen = JSON.parse(fd) as CustomScreen; }
                }
              } catch { /* ignore */ }
            }
            const config: AppRuntimeConfig = {
              app,
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

      fetchResponsePage: async (formId, options) => {
        const slug = get().appSlug;
        if (!slug) return { rows: [], total: 0 };
        const result = await api.getAppResponsesPage(slug, formId, options);
        if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Failed to load responses');
        return { rows: result.data?.responses ?? [], total: result.data?.total ?? 0 };
      },

      fetchRecentRows: async (formId, limit) => {
        const map = (r: Record<string, unknown>) => ({ id: String(r.id ?? ''), answers: (r.answers as Record<string, unknown>) ?? {}, submittedAt: String(r.submittedAt ?? '') });
        try {
          if (!api.isDemoMode()) {
            const { rows } = await get().fetchResponsePage(formId, { limit, offset: 0 });
            return (rows as Record<string, unknown>[]).map(map);
          }
          const rows = (await get().fetchResponses(formId, { limit })) as Record<string, unknown>[];
          return rows.map(map);
        } catch { return []; }
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

      runReport: async (spec) => {
        const slug = get().appSlug;
        if (!slug) return null;
        const result = await api.runReport(slug, spec as unknown as Record<string, unknown>);
        if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Failed to run report');
        return result.data ?? null;
      },

      runReportBatch: async (specs) => {
        const slug = get().appSlug;
        if (!slug || specs.length === 0) return specs.map(() => null);
        const result = await api.runReportBatch(slug, specs as unknown as Record<string, unknown>[]);
        if (result.error || !result.data) return specs.map(() => null);
        const arr = result.data.results ?? [];
        // A per-spec {error:true} entry (one broken widget) maps to null, not a thrown batch.
        return specs.map((_, i) => { const r = arr[i]; return r && !r.error ? r : null; });
      },

      saveReports: async (reports) => {
        const cfg = get().config;
        if (!cfg) return false;
        // Optimistic: reflect immediately in the runtime.
        set({ config: { ...cfg, app: { ...cfg.app, reports } } });
        // Demo keeps report authoring in the browser; real owners persist to the app.
        if (api.isDemoMode()) {
          try { localStorage.setItem(demoReportsKey(cfg.app.id), JSON.stringify(reports)); } catch { /* ignore */ }
          return true;
        }
        const r = await api.updateApp(cfg.app.id, { reports });
        if (r.error) { toast.error('Failed to save report', typeof r.error === 'string' ? r.error : undefined); return false; }
        return true;
      },

      saveDashboard: async (screen) => {
        const cfg = get().config;
        if (!cfg) return false;
        const existing = cfg.app.customScreen ?? {};
        const customScreen: CustomScreen = { ...existing, enabled: true, kind: 'dashboard', dashboard: screen };
        // Optimistic: reflect immediately so the home re-renders with the saved layout.
        set({ config: { ...cfg, app: { ...cfg.app, customScreen } } });
        if (api.isDemoMode()) {
          try { localStorage.setItem(demoDashboardKey(cfg.app.id), JSON.stringify(customScreen)); } catch { /* ignore */ }
          return true;
        }
        const r = await api.updateApp(cfg.app.id, { customScreen });
        if (r.error) { toast.error('Failed to save dashboard', typeof r.error === 'string' ? r.error : undefined); return false; }
        return true;
      },

      saveFormDashboard: async (formId, screen) => {
        const cfg = get().config;
        if (!cfg) return false;
        const existing = (cfg.forms.find((f) => f.formId === formId)?.customScreen ?? {}) as CustomScreen;
        const customScreen: CustomScreen = { ...existing, enabled: true, kind: 'dashboard', dashboard: screen };
        // Optimistic: update this form's section screen in the runtime config.
        set({ config: { ...cfg, forms: cfg.forms.map((f) => (f.formId === formId ? { ...f, customScreen } : f)) } });
        if (api.isDemoMode()) {
          try { localStorage.setItem(demoFormDashboardKey(formId), JSON.stringify(customScreen)); } catch { /* ignore */ }
          return true;
        }
        const r = await api.updateForm(formId, { customScreen } as unknown as Record<string, unknown>);
        if (r.error) { toast.error('Failed to save section screen', typeof r.error === 'string' ? r.error : undefined); return false; }
        return true;
      },

      // Permission helpers check both app-level and form-level permissions.
      // NOTE: manage_app is NOT a data-access wildcard — the server
      // (AppUserService::hasPermission) only treats the real app owner as a
      // wildcard, so enabling controls on manage_app alone would show actions the
      // server then rejects (403). Gate each control on its specific permission.
      // Single source of truth for "is this the app owner" (gates Edit-dashboard / owner-only
      // affordances). Prefers the explicit backend `canManage` capability; falls back to ownerId
      // presence (only sent for the owner) for older/demo configs that predate the flag.
      isOwner: () => {
        const app = get().config?.app;
        return !!(app?.canManage ?? app?.ownerId);
      },

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

      canViewAnalytics: (formId) => {
        const p = get().permissions;
        if (!p?.appLevel) return false;
        return p.appLevel.includes('view_analytics') || (p.formLevel?.[formId]?.includes('view_analytics') ?? false);
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
