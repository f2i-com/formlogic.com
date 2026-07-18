import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, newIdempotencyKey } from '../lib/api';
import { setConnectorCapabilityContext } from '../client-runtime/desktop/desktopClient';
import { enqueueSubmission } from '../client-runtime/offlineQueue';
import { toast } from './toastStore';
import type { LinkedRecord } from '../lib/api';
import type { AppRuntimeConfig, AppRuntimeForm, AppUserPermissions, AppReportItem, AppReportSpec, AppReportResult, DashboardScreen } from '../types/app';
import type { CustomScreen } from '../types/form';
import type { CustomAppLogicBundle } from '../types/customAppLogic';
import { syncPackConnectors } from '../client-runtime/connectors/packConnectorDriver';

// ── Stable submission intent keys (audit FL-004/C-11) ──────────────────────
// A failed ONLINE submit must reuse its idempotency key on manual retry, so a
// server that actually persisted the first attempt (the ACK was lost) dedupes
// instead of duplicating. Keyed per form; rotated when the payload changes
// (that is a NEW logical submission) or after a confirmed success.
const pendingSubmitKeys = new Map<string, { hash: string; key: string }>();

function stableSubmitKey(formId: string, answers: Record<string, unknown>): string {
  const hash = JSON.stringify(answers);
  const existing = pendingSubmitKeys.get(formId);
  if (existing && existing.hash === hash) return existing.key;
  const fresh = { hash, key: newIdempotencyKey() };
  pendingSubmitKeys.set(formId, fresh);
  return fresh.key;
}

function clearSubmitKey(formId: string): void {
  pendingSubmitKeys.delete(formId);
}

// Demo report + dashboard authoring stays per-browser (the shared demo is read-only on the server).
const demoReportsKey = (appId: string) => `formlogic-demo-reports-${appId}`;
const demoDashboardKey = (appId: string) => `formlogic-demo-dashboard-${appId}`;
const demoFormDashboardKey = (formId: string) => `formlogic-demo-form-dashboard-${formId}`;
const demoCustomLogicKey = (appId: string) => `formlogic-demo-logic-${appId}`;

interface AppRuntimeState {
  config: AppRuntimeConfig | null;
  appSlug: string | null;
  activeFormId: string | null;
  sidebarCollapsed: boolean;
  isLoading: boolean;
  error: string | null;
  permissions: AppUserPermissions | null;
  roleName: string | null;
  /** The viewing member's own account timezone (IANA), from the bootstrap
   *  payload. Overrides the app timezone when displaying record times. */
  memberTimezone: string | null;

  // Actions
  initialize: (appSlug: string) => Promise<void>;
  setActiveForm: (formId: string | null) => void;
  toggleSidebar: () => void;
  reset: () => void;

  // Response CRUD
  fetchResponses: (formId: string, options?: { limit?: number; offset?: number; resolve?: boolean; answersEq?: Record<string, string>; answersPhoneEq?: Record<string, string>; answersGte?: Record<string, string>; answersLte?: Record<string, string> }) => Promise<unknown[]>;
  fetchResponsePage: (formId: string, options: { limit: number; offset: number; search?: string; resolve?: boolean; sort?: string; sortDir?: 'asc' | 'desc' }) => Promise<{ rows: unknown[]; total: number }>;
  /** Newest rows of a form as {id, answers, submittedAt} — demo-aware; powers dashboard list/activity widgets. */
  fetchRecentRows: (formId: string, limit: number) => Promise<Array<{ id: string; answers: Record<string, unknown>; submittedAt: string }>>;
  createResponse: (formId: string, answers: Record<string, unknown>) => Promise<unknown>;
  updateResponse: (formId: string, responseId: string, data: Record<string, unknown>) => Promise<unknown>;
  deleteResponse: (formId: string, responseId: string) => Promise<boolean>;
  /** Bulk clear of one form's records — one backend operation, returns the count. */
  clearFormResponses: (formId: string) => Promise<number>;

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

  // Custom app-logic (sandboxed QuickJS hooks, stored on app.customLogic)
  saveCustomLogic: (bundle: CustomAppLogicBundle) => Promise<boolean>;

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
      memberTimezone: null,

      initialize: async (appSlug: string) => {
        // Register cleanup callback (replace previous to avoid stale closures on HMR)
        if (_appRuntimeSessionCallback) {
          api.removeSessionExpiredCallback(_appRuntimeSessionCallback);
        }
        _appRuntimeSessionCallback = () => {
          get().reset();
        };
        api.onSessionExpired(_appRuntimeSessionCallback);

        set({ isLoading: true, error: null, appSlug, config: null, permissions: null, roleName: null, memberTimezone: null, activeFormId: null });
        // SEC-001: connector capabilities are minted for the CURRENT app —
        // the desktop enforces the member's role-derived grants per command.
        setConnectorCapabilityContext(appSlug);
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
                const logic = localStorage.getItem(demoCustomLogicKey(app.id));
                if (logic) { app.customLogic = JSON.parse(logic) as CustomAppLogicBundle; }
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
              memberTimezone: (appUser?.timezone as string) || null,
              isLoading: false,
              activeFormId: null,
            });
            // Pack-declared connectors are app-scoped: (re)register this app's
            // driver bundle against its granted permissions.
            syncPackConnectors(config);
          }
        } catch (e) {
          set({ error: e instanceof Error ? e.message : 'Failed to load app', isLoading: false });
        }
      },

      setActiveForm: (formId) => set({ activeFormId: formId }),

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      reset: () => {
        // Leaving the app tears its pack connectors down with it.
        syncPackConnectors(null);
        set({
          config: null,
          appSlug: null,
          activeFormId: null,
          isLoading: false,
          error: null,
          permissions: null,
          roleName: null,
          memberTimezone: null,
        });
      },

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
        // Let a 403/404/network failure THROW (matches fetchResponses/fetchResponsePage) instead of
        // swallowing it to [] — callers (dashboard list/activity widgets, the SDK's useResponses) need
        // to tell "form deleted or no permission" apart from a genuinely empty form.
        if (!api.isDemoMode()) {
          const { rows } = await get().fetchResponsePage(formId, { limit, offset: 0 });
          return (rows as Record<string, unknown>[]).map(map);
        }
        const rows = (await get().fetchResponses(formId, { limit })) as Record<string, unknown>[];
        return rows.map(map);
      },

      createResponse: async (formId, answers) => {
        const slug = get().appSlug;
        if (!slug) throw new Error('App not initialized');
        // Offline: queue the submission instead of losing it. It flushes to the same idempotent create
        // endpoint on reconnect (the server's payload-hash ledger dedupes the replay), and we return an
        // optimistic response so the UI can proceed to its thank-you/next state.
        if (!api.isDemoMode() && typeof navigator !== 'undefined' && navigator.onLine === false) {
          // In the native runtime, prefer the persistent native queue (survives an app restart);
          // otherwise use the browser IndexedDB queue. Both flush to the SAME idempotent endpoint, so
          // the shared key keeps the submission deduped whichever queue delivers it.
          const key = newIdempotencyKey();
          const bridge = typeof window !== 'undefined' ? window.FormLogicNative : undefined;
          if (bridge?.available && bridge.sync?.enqueueSubmission) {
            try {
              const r = await bridge.sync.enqueueSubmission({ appSlug: slug, formId, idempotencyKey: key, answers });
              return { id: r.id, queued: true, answers, submittedAt: new Date().toISOString() };
            } catch { /* fall through to the browser queue */ }
          }
          const q = await enqueueSubmission({ appSlug: slug, formId, answers, idempotencyKey: key });
          return { id: q.id, queued: true, answers, submittedAt: new Date(q.createdAt).toISOString() };
        }
        // ONE stable idempotency key per logical submission (audit FL-004/C-11):
        // if this request dies after the server persisted it (dropped ACK,
        // captive portal), BOTH the service worker's background-sync replay and
        // a manual user retry carry the SAME key — the server returns the
        // original response instead of creating a duplicate. The key is only
        // rotated on success or when the answers change.
        const idempotencyKey = stableSubmitKey(formId, answers);
        const result = await api.createAppResponse(slug, formId, { answers, idempotencyKey });
        if (result.error) throw new Error(result.error); // key retained for the retry
        if (!result.data?.response) throw new Error('Submission failed: no response was returned.');
        clearSubmitKey(formId);
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

      clearFormResponses: async (formId) => {
        const slug = get().appSlug;
        if (!slug) return 0;
        const result = await api.clearAppFormResponses(slug, formId);
        if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Failed to clear records');
        return result.data?.deleted ?? 0;
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
        // Snapshot the prior slice BEFORE the optimistic set — a failed save must not leave
        // phantom state the server never accepted.
        const prevScreen = cfg.app.customScreen;
        // Optimistic: reflect immediately so the home re-renders with the saved layout.
        set({ config: { ...cfg, app: { ...cfg.app, customScreen } } });
        if (api.isDemoMode()) {
          try { localStorage.setItem(demoDashboardKey(cfg.app.id), JSON.stringify(customScreen)); } catch { /* ignore */ }
          return true;
        }
        const r = await api.updateApp(cfg.app.id, { customScreen });
        if (r.error) {
          // Roll back just this slice on the CURRENT config (unrelated changes that landed
          // while the request was in flight stay intact).
          const cur = get().config;
          if (cur) set({ config: { ...cur, app: { ...cur.app, customScreen: prevScreen } } });
          toast.error('Failed to save dashboard', typeof r.error === 'string' ? r.error : undefined);
          return false;
        }
        // Reconcile with the server's post-sanitize record — a save-time clamp (e.g. a widget
        // referencing a form just removed from the app) must be reflected, not silently dropped.
        const savedApp = (r.data as { app?: Record<string, unknown> } | undefined)?.app;
        if (savedApp && 'customScreen' in savedApp) {
          const cur = get().config;
          if (cur) set({ config: { ...cur, app: { ...cur.app, customScreen: savedApp.customScreen as CustomScreen } } });
        }
        return true;
      },

      saveFormDashboard: async (formId, screen) => {
        const cfg = get().config;
        if (!cfg) return false;
        const existing = (cfg.forms.find((f) => f.formId === formId)?.customScreen ?? {}) as CustomScreen;
        const customScreen: CustomScreen = { ...existing, enabled: true, kind: 'dashboard', dashboard: screen };
        // Snapshot the prior slice BEFORE the optimistic set (rollback target on API failure).
        const prevScreen = cfg.forms.find((f) => f.formId === formId)?.customScreen;
        // Optimistic: update this form's section screen in the runtime config.
        set({ config: { ...cfg, forms: cfg.forms.map((f) => (f.formId === formId ? { ...f, customScreen } : f)) } });
        if (api.isDemoMode()) {
          try { localStorage.setItem(demoFormDashboardKey(formId), JSON.stringify(customScreen)); } catch { /* ignore */ }
          return true;
        }
        const r = await api.updateForm(formId, { customScreen } as unknown as Record<string, unknown>);
        if (r.error) {
          // Roll back only this form's screen on the CURRENT config.
          const cur = get().config;
          if (cur) set({ config: { ...cur, forms: cur.forms.map((f) => (f.formId === formId ? { ...f, customScreen: prevScreen } : f)) } });
          toast.error('Failed to save section screen', typeof r.error === 'string' ? r.error : undefined);
          return false;
        }
        // Reconcile with the server's post-sanitize record, same reasoning as saveDashboard.
        const savedForm = (r.data as { form?: Record<string, unknown> } | undefined)?.form;
        if (savedForm && 'customScreen' in savedForm) {
          const cur = get().config;
          if (cur) set({ config: { ...cur, forms: cur.forms.map((f) => (f.formId === formId ? { ...f, customScreen: savedForm.customScreen as CustomScreen } : f)) } });
        }
        return true;
      },

      saveCustomLogic: async (bundle) => {
        const cfg = get().config;
        if (!cfg) return false;
        // Snapshot the prior slice BEFORE the optimistic set (rollback target on API failure).
        const prevLogic = cfg.app.customLogic;
        // Optimistic: reflect immediately so hooks pick up the new logic without a reload.
        set({ config: { ...cfg, app: { ...cfg.app, customLogic: bundle } } });
        syncPackConnectors(get().config);
        if (api.isDemoMode()) {
          try { localStorage.setItem(demoCustomLogicKey(cfg.app.id), JSON.stringify(bundle)); } catch { /* ignore */ }
          return true;
        }
        const r = await api.updateApp(cfg.app.id, { customLogic: bundle });
        if (r.error) {
          // Roll back only the logic slice on the CURRENT config.
          const cur = get().config;
          if (cur) set({ config: { ...cur, app: { ...cur.app, customLogic: prevLogic } } });
          toast.error('Failed to save app logic', typeof r.error === 'string' ? r.error : undefined);
          syncPackConnectors(get().config);
          return false;
        }
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
