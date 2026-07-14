import { createContext, useContext, useMemo } from 'react';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useAppUserStore } from '../../stores/appUserStore';
import { useFormStore } from '../../stores/formStore';

/**
 * Platform-admin ACTING mode — the plumbing that lets the REAL owner UIs
 * (form builder, flows workspace, app manager) manage ANOTHER user's account.
 *
 * While an AdminActingBoundary is mounted:
 *  - api.setAdminActing({ownerId}) rewrites owner endpoints onto the server's
 *    /admin/users/{ownerId} mirror (and refuses record-data endpoints);
 *  - the owner's apps/forms fill the in-memory stores (persistence is frozen
 *    by frozenWhileActing, so the admin's own localStorage stays untouched);
 *  - useResourcePaths() makes in-page navigation stay inside /admin/... routes.
 *
 * On exit the stores are purged and rehydrated back to the admin's own world.
 * The 150 ms teardown debounce only avoids refetch churn when hopping between
 * acting routes (settings → builder) — correctness never depends on it: every
 * boundary re-resolves the owner and re-enters acting mode on mount.
 */

export interface AdminActing {
  ownerId: string;
  ownerEmail: string;
  ownerName?: string | null;
}

export const AdminActingContext = createContext<AdminActing | null>(null);

/** The acting context, or null when this UI is running for the owner themselves. */
export function useAdminActing(): AdminActing | null {
  return useContext(AdminActingContext);
}

let teardownTimer: ReturnType<typeof setTimeout> | null = null;

export function enterActing(ctx: AdminActing): void {
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  api.setAdminActing({ ownerId: ctx.ownerId });
}

export function exitActing(): void {
  if (!api.isAdminActing()) return;

  // SYNCHRONOUS teardown, in this exact order:
  // 1. Purge the owner's forms while persistence is STILL FROZEN — the purge's
  //    set() must never reach localStorage. (Reversed, a local-mode admin's own
  //    snapshot was overwritten with the purged/empty array and their forms were
  //    permanently lost — persistence unfreezes only after the purge.)
  useFormStore.getState().purgeAdminForeign();
  // 2. Members/invitations/groups are keyed by appId and not persisted — reset.
  useAppUserStore.setState({ users: {}, groups: {}, invitations: {} });
  // 3. Drop the acting flag NOW (not debounced): anything the next page fetches
  //    (e.g. browser-back to the admin's own /apps) must route to their own
  //    endpoints immediately, not flash the owner's world for 150ms.
  api.setAdminActing(null);
  // 4. Restore the admin's own persisted snapshots into memory.
  void useFormStore.persist.rehydrate();
  void useAppStore.persist.rehydrate();

  // Only the NETWORK refetch is debounced — hopping between two acting routes
  // (settings → builder) re-enters acting within the window (enterActing cancels
  // the timer) and must not refetch the admin's own world in between. The awaits
  // enforce ordering: initialize()'s wholesale set must land AFTER rehydrate.
  if (teardownTimer) clearTimeout(teardownTimer);
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (api.isAdminActing()) return; // another boundary took over
    void (async () => {
      await useFormStore.persist.rehydrate();
      if (useFormStore.getState().storageMode === 'api') {
        useFormStore.setState({ isInitialized: false });
        await useFormStore.getState().initialize();
      }
      await useAppStore.persist.rehydrate();
      await useAppStore.getState().fetchApps();
    })();
  }, 150);
}

/**
 * Path builders that keep in-page navigation inside the acting route space.
 * Outside acting mode they return the normal owner paths, so shared pages can
 * use them unconditionally.
 */
export function useResourcePaths() {
  const acting = useAdminActing();
  const prefix = acting ? '/admin' : '';
  return useMemo(() => ({
    /** A per-app management sub-page, e.g. appSub(id, 'settings?tab=manage'). */
    appSub: (appId: string, sub: string) => `${prefix}/apps/${appId}/${sub}`,
    builder: (formId: string, appId?: string) =>
      `${prefix}/builder/${formId}${appId ? `?appId=${appId}` : ''}`,
    preview: (formId: string) => `${prefix}/preview/${formId}`,
    screenEdit: (formId: string) => `${prefix}/forms/${formId}/screen/edit`,
    homeEdit: (appId: string) => `${prefix}/apps/${appId}/home/edit`,
    /** "Back to my apps" — while acting, back means the owner's admin page. */
    appsHome: () => (acting ? `/admin/users/${acting.ownerId}` : '/apps'),
    /** "Back to my forms" — same. */
    formsHome: () => (acting ? `/admin/users/${acting.ownerId}` : '/forms'),
  }), [acting, prefix]);
}
