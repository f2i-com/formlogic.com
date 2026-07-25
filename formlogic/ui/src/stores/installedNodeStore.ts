// Installed contributed flow-node definitions (ADR-010 / FLOW-204) — fetched once per
// session when a flow editor mounts, read non-reactively by the registry's installed-package
// provider, and subscribed to (via `version`) by the palette/canvas so their memoized lists
// recompute when definitions arrive or change. NOT persisted: the server list is cheap and
// authoritative (install/uninstall invalidates it server-side).
import { create } from 'zustand';
import { api, type InstalledFlowNodeDefinition } from '../lib/api';
import { flowNodeRegistry } from '../components/flows/registry/FlowNodeRegistry';

interface InstalledNodeState {
  definitions: InstalledFlowNodeDefinition[];
  /** Bumped on every successful load — memo dependency for palette/canvas lists. */
  version: number;
  loaded: boolean;
  loading: boolean;
  /** Fetch (or re-fetch after install/uninstall). Errors leave the previous list in place. */
  refresh: () => Promise<void>;
}

export const useInstalledNodeStore = create<InstalledNodeState>((set, get) => ({
  definitions: [],
  version: 0,
  loaded: false,
  loading: false,
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await api.listFlowNodeDefinitions();
      if (res.data) {
        set((s) => ({ definitions: res.data!.definitions, version: s.version + 1, loaded: true, loading: false }));
        // FLOW-202: the provider set is unchanged but its underlying data is not — tell the
        // registry, so consumers memoizing on its revision recompute too.
        flowNodeRegistry.refresh();
      } else {
        set({ loading: false, loaded: true });
      }
    } catch {
      // Keep whatever we had — the editor degrades to core nodes only.
      set({ loading: false, loaded: true });
    }
  },
}));
