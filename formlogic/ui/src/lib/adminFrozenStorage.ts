import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { api } from './api';

/**
 * Zustand persist storage that FREEZES writes while a platform admin is acting
 * on another user's account (AdminActingBoundary → api.setAdminActing). The
 * acting session fills the in-memory stores with the OWNER's apps/forms; this
 * wrapper guarantees none of that ever lands in the admin's own localStorage
 * snapshot — belt and braces beside the stores' own partialize filters. On
 * exit, the boundary calls persist.rehydrate() to restore the pre-acting state.
 *
 * Reads and removals pass through unchanged.
 */
export function frozenWhileActing() {
  // Like zustand's default localStorage factory, degrade to a no-op where
  // localStorage doesn't exist (node test environments, exotic embeds).
  const store = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);
  const raw: StateStorage = {
    getItem: (name) => store()?.getItem(name) ?? null,
    setItem: (name, value) => {
      if (api.isAdminActing()) return;
      store()?.setItem(name, value);
    },
    removeItem: (name) => store()?.removeItem(name),
  };
  return createJSONStorage(() => raw);
}
