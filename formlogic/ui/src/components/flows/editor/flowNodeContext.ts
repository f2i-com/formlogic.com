// FormLogic Flows editor — React context shared by the canvas node cards.
//
// Kept in its own module (not FlowNode.tsx) so the node component file only exports components —
// otherwise Fast Refresh can't hot-reload it.
import { createContext } from 'react';
import type { NodeSummaryForms } from './nodeSummary';
import type { NodeStatusMap } from '../runStatus';
import type { FlowsDesktopPresence } from '../useFlowsDesktopPresence';
import type { FlowBinding } from '../../../types/flows';

/**
 * Lets a node card name a picked form by its title instead of its UUID. FlowEditor provides it;
 * absent (e.g. an isolated render) the summaries fall back to the raw form ref.
 */
export const FlowFormsContext = createContext<NodeSummaryForms | null>(null);

/** Per-node authoring + run signals the canvas node cards render (status pills, lint badges). */
export interface FlowNodeSignals {
  /** Live run status from the current Test Run's onNodeStatus (idle nodes are absent). */
  status: NodeStatusMap;
  /** Authoring lint issues keyed by node id (missing required prop / dangling edge / bad ref). */
  issues: Record<string, string[]>;
}

export const EMPTY_NODE_SIGNALS: FlowNodeSignals = { status: {}, issues: {} };

/**
 * Run status + lint issues for every node, provided by FlowEditor. Kept in context (NOT node
 * data) so it never mutates the serialized graph — status/issues are ephemeral view state.
 */
export const FlowNodeSignalsContext = createContext<FlowNodeSignals>(EMPTY_NODE_SIGNALS);

export const EMPTY_DESKTOP_PRESENCE: FlowsDesktopPresence = { kind: 'none' };

/**
 * Current FormLogic Desktop presence for editor-only affordances (palette degradation and node
 * badges). Like node signals, this is view state and must never be serialized into node data.
 */
export const FlowDesktopPresenceContext = createContext<FlowsDesktopPresence>(EMPTY_DESKTOP_PRESENCE);

/**
 * Bindings for the currently selected flow, shown by Trigger node cards as event chips. This is
 * view state from the workspace, not graph node data, so changing bindings never dirties the graph.
 */
export const FlowTriggerBindingsContext = createContext<readonly FlowBinding[]>([]);
