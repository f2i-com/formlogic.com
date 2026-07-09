// Pure FlowEditor helpers kept outside the React component for focused Vitest coverage.
//
// These helpers cover persistence metadata and undo coalescing without a React Flow test harness.
import type { WorkflowGraph } from '../../../types/flows';
import { getNodeSpec } from './nodeCatalog';

export const PATCH_HISTORY_COALESCE_MS = 1000;

export interface PatchHistoryBurst {
  key: string;
  atMs: number;
}

/** A coalescible properties-panel patch is exactly one field on exactly one selected node. */
export function patchHistoryKey(nodeId: string | null, patch: Record<string, unknown>): string | null {
  if (!nodeId) return null;
  const keys = Object.keys(patch);
  if (keys.length !== 1) return null;
  return `${nodeId}:${keys[0]}`;
}

export function shouldPushPatchHistory(
  previous: PatchHistoryBurst | null,
  key: string | null,
  nowMs: number,
  windowMs = PATCH_HISTORY_COALESCE_MS,
): boolean {
  if (!key || !previous) return true;
  return previous.key !== key || nowMs - previous.atMs > windowMs;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Recompute persisted nodeCapabilities from the CURRENT graph only.
 *
 * Evidence checked for T5: browser executor/client-runtime and the desktop runner read
 * nodeCapabilities only as runtime gates; backend FlowService sanitizes/stores them; binding
 * outputActions dispatch connector calls through their connector surfaces rather than this editor
 * metadata. There is no editor-supported manual capability list to preserve, so unioning with the
 * previous flow row only leaves stale grants after nodes are deleted.
 */
export function computeCapabilitiesFromGraph(graph: WorkflowGraph): string[] {
  const caps = new Set<string>();
  for (const node of graph.nodes) {
    const spec = getNodeSpec(node.type);
    if (spec?.capability) caps.add(spec.capability);

    const data = node.data ?? {};
    if (node.type === 'connector_request') {
      const connectorId = nonEmptyString(data.connectorId) ?? nonEmptyString(data.connector);
      const command = nonEmptyString(data.command);
      if (connectorId && command) caps.add(`connector.${connectorId}.${command}`);
    }
    if (node.type === 'aokie_speak') {
      caps.add('connector.aokie.call.operatorSpeak');
    }
  }
  return [...caps];
}
