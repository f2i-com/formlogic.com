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
  if (teardownTimer) clearTimeout(teardownTimer);
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (api.isAdminActing()) {
      api.setAdminActing(null);

      // Forms: drop the owner's forms + their save state, restore the admin's
      // persisted snapshot, then re-pull their own cloud forms if applicable.
      const formStore = useFormStore.getState();
      formStore.purgeAdminForeign();
      void useFormStore.persist.rehydrate();
      if (formStore.storageMode === 'api') {
        useFormStore.setState({ isInitialized: false });
        void useFormStore.getState().initialize();
      }

      // Apps: restore the admin's snapshot and refetch their own list.
      void useAppStore.persist.rehydrate();
      void useAppStore.getState().fetchApps();

      // Members/invitations/groups are keyed by appId and not persisted — reset.
      useAppUserStore.setState({ users: {}, groups: {}, invitations: {} });
    }
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
