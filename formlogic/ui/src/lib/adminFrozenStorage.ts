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
export function frozenWhileActing(alsoWhen: () => boolean = () => false) {
  return frozenWhen(() => api.isAdminActing() || alsoWhen());
}

/**
 * Whether a tab in `tabMode` must leave the stored forms and responses alone. Storage mode is held
 * per tab and storage is shared, so a tab in the cloud can sit beside one keeping forms on this
 * device. Every write sends out the whole snapshot, and a cloud tab's has none of them in it: left
 * to write, it would erase them, and it has nothing of its own there worth keeping. Going by the
 * mode's own key, which only a choice of mode writes.
 */
export function besideDeviceForms(tabMode: string): boolean {
  return tabMode !== 'local' && localStorage.getItem('formlogic_storage_mode') === 'local';
}

/** The storage above, for any condition. A condition that can't be read freezes nothing. */
export function frozenWhen(frozen: () => boolean) {
  const isFrozen = () => {
    try {
      return frozen();
    } catch {
      return false;
    }
  };
  // Like zustand's default localStorage factory, degrade to a no-op where localStorage
  // doesn't exist (node test environments, exotic embeds) or merely reading it throws (an
  // embedded form where the browser blocks third-party storage: `typeof` doesn't help there).
  const store = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  const raw: StateStorage = {
    getItem: (name) => store()?.getItem(name) ?? null,
    setItem: (name, value) => {
      if (isFrozen()) return;
      store()?.setItem(name, value);
    },
    removeItem: (name) => store()?.removeItem(name),
  };
  return createJSONStorage(() => raw);
}
