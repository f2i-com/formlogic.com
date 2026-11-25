// Installed contributed flow-node definitions (ADR-010 / FLOW-204) — fetched once per
// session when a flow editor mounts, read non-reactively by the registry's installed-package
// provider, and subscribed to (via `version`) by the palette/canvas so their memoized lists
// recompute when definitions arrive or change. NOT persisted: the server list is cheap and
// authoritative (install/uninstall invalidates it server-side).
import { create } from 'zustand';
import { api, type InstalledFlowNodeDefinition } from '../lib/api';
import { flowNodeRegistry } from '../components/flows/registry/FlowNodeRegistry';
import {
  currentSessionGeneration,
  isSessionGenerationCurrent,
  subscribeSessionGeneration,
} from '../lib/sessionGeneration';

interface InstalledNodeState {
  definitions: InstalledFlowNodeDefinition[];
  /** Bumped on every successful load — memo dependency for palette/canvas lists. */
  version: number;
  loaded: boolean;
  loading: boolean;
  /** Fetch (or re-fetch after install/uninstall). Errors leave the previous list in place. */
  refresh: () => Promise<void>;
  /** Drop cached installed definitions on session teardown / account switch. */
  reset: () => void;
}

export const useInstalledNodeStore = create<InstalledNodeState>((set, get) => ({
  definitions: [],
  version: 0,
  loaded: false,
  loading: false,
  reset: () => {
    set((s) => ({ definitions: [], version: s.version + 1, loaded: false, loading: false }));
    flowNodeRegistry.refresh();
  },
  refresh: async () => {
    if (get().loading) return;
    const gen = currentSessionGeneration();
    set({ loading: true });
    try {
      const res = await api.listFlowNodeDefinitions();
      if (!isSessionGenerationCurrent(gen)) return;
      if (res.data) {
        set((s) => ({ definitions: res.data!.definitions, version: s.version + 1, loaded: true, loading: false }));
        // FLOW-202: the provider set is unchanged but its underlying data is not — tell the
        // registry, so consumers memoizing on its revision recompute too.
        flowNodeRegistry.refresh();
      } else {
        set({ loading: false, loaded: true });
      }
    } catch {
      if (!isSessionGenerationCurrent(gen)) return;
      // Keep whatever we had — the editor degrades to core nodes only.
      set({ loading: false, loaded: true });
    }
  },
}));

// Never carry User A's installed extension nodes across logout / account switch.
subscribeSessionGeneration(() => {
  useInstalledNodeStore.getState().reset();
});
