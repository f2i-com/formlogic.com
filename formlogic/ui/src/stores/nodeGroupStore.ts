import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { generateId } from '../lib/utils';

/**
 * User-defined palette groups — a person's own way of organising the nodes they have installed.
 *
 * Deliberately separate from a definition's declared `display.category`. That one is the
 * AUTHOR's request, checked against a host allowlist so a package cannot invent palette
 * sections. This is the user's own arrangement: they can make any group they like, name it
 * anything, and put any node in it, because it is their palette and nobody else sees it.
 *
 * A node lives in at most one user group. Putting it in a second MOVES it — two copies of the
 * same node in one palette is not organisation, it is a duplicate to hunt through.
 *
 * Stored locally rather than on the account. It is a view preference like a collapsed sidebar,
 * and keeping it local avoids a table, an API and a sync story for something that is only ever
 * read by the person who set it. The visible cost is that it does not follow you to another
 * browser; if that turns out to matter, this store is the only thing that has to move.
 */
export interface NodeGroup {
  id: string;
  name: string;
  /** Node types in this group, in the order the user arranged them. */
  nodeTypes: string[];
  collapsed?: boolean;
}

interface NodeGroupState {
  groups: NodeGroup[];
  createGroup: (name: string) => string | null;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => void;
  /** Move `nodeType` into `groupId`, removing it from any other group. */
  assignNode: (nodeType: string, groupId: string) => void;
  /** Take `nodeType` out of user grouping entirely — it returns to its default section. */
  unassignNode: (nodeType: string) => void;
  /** Reorder the groups themselves. */
  moveGroup: (id: string, direction: -1 | 1) => void;
  /** Reorder a node within its group. */
  moveNode: (nodeType: string, direction: -1 | 1) => void;
  toggleCollapsed: (id: string) => void;
  /** Which group a node belongs to, if any. */
  groupOf: (nodeType: string) => NodeGroup | undefined;
}

const MAX_GROUPS = 24;
const MAX_NAME = 40;

export const useNodeGroupStore = create<NodeGroupState>()(
  persist(
    (set, get) => ({
      groups: [],

      createGroup: (name) => {
        const trimmed = name.trim().slice(0, MAX_NAME);
        if (!trimmed) return null;
        const { groups } = get();
        if (groups.length >= MAX_GROUPS) return null;
        // A duplicate name would make two sections indistinguishable in the palette, which is
        // the opposite of organising. Reuse the existing one instead of adding a twin.
        const existing = groups.find((g) => g.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const id = generateId();
        set({ groups: [...groups, { id, name: trimmed, nodeTypes: [] }] });
        return id;
      },

      renameGroup: (id, name) => {
        const trimmed = name.trim().slice(0, MAX_NAME);
        if (!trimmed) return;
        // Same rule createGroup enforces: two sections with the same name are indistinguishable
        // in the palette, which is the opposite of organising. Renaming ONTO an existing name
        // is refused rather than silently creating the twin the create path prevents.
        const clash = get().groups.some(
          (g) => g.id !== id && g.name.toLowerCase() === trimmed.toLowerCase()
        );
        if (clash) return;
        set({ groups: get().groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)) });
      },

      deleteGroup: (id) => {
        // Deleting a group releases its nodes rather than hiding them: they reappear in their
        // default sections, so nothing a user installed can vanish from the palette.
        set({ groups: get().groups.filter((g) => g.id !== id) });
      },

      assignNode: (nodeType, groupId) => {
        set({
          groups: get().groups.map((g) => {
            const without = g.nodeTypes.filter((t) => t !== nodeType);
            if (g.id !== groupId) return without.length === g.nodeTypes.length ? g : { ...g, nodeTypes: without };
            return { ...g, nodeTypes: [...without, nodeType] };
          }),
        });
      },

      unassignNode: (nodeType) => {
        set({
          groups: get().groups.map((g) => {
            const without = g.nodeTypes.filter((t) => t !== nodeType);
            return without.length === g.nodeTypes.length ? g : { ...g, nodeTypes: without };
          }),
        });
      },

      moveGroup: (id, direction) => {
        const groups = [...get().groups];
        const index = groups.findIndex((g) => g.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= groups.length) return;
        [groups[index], groups[target]] = [groups[target], groups[index]];
        set({ groups });
      },

      moveNode: (nodeType, direction) => {
        set({
          groups: get().groups.map((g) => {
            const index = g.nodeTypes.indexOf(nodeType);
            if (index < 0) return g;
            const target = index + direction;
            if (target < 0 || target >= g.nodeTypes.length) return g;
            const nodeTypes = [...g.nodeTypes];
            [nodeTypes[index], nodeTypes[target]] = [nodeTypes[target], nodeTypes[index]];
            return { ...g, nodeTypes };
          }),
        });
      },

      toggleCollapsed: (id) => {
        set({ groups: get().groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) });
      },

      groupOf: (nodeType) => get().groups.find((g) => g.nodeTypes.includes(nodeType)),
    }),
    { name: 'formlogic.flows.nodeGroups' }
  )
);
