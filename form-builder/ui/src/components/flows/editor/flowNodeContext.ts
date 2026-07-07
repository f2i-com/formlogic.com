// FormLogic Flows editor — React context shared by the canvas node cards.
//
// Kept in its own module (not FlowNode.tsx) so the node component file only exports components —
// otherwise Fast Refresh can't hot-reload it.
import { createContext } from 'react';
import type { NodeSummaryForms } from './nodeSummary';
import type { NodeStatusMap } from '../runStatus';

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
