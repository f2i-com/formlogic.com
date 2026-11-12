// Pure FlowEditor helpers kept outside the React component for focused Vitest coverage.
//
// These helpers cover persistence metadata and undo coalescing without a React Flow test harness.
import type { WorkflowGraph } from '../../../types/flows';
import { flowNodeRegistry } from '../registry/FlowNodeRegistry';

export const PATCH_HISTORY_COALESCE_MS = 1000;

export const FLOW_LAYOUT = {
  /** The canvas keeps this much beside the open list of steps. */
  CANVAS_FLOOR: 440,
  /** …and this much beside the list's narrow rail, which costs little. */
  RAIL_CANVAS_FLOOR: 360,
  /** The least canvas a side panel may leave. With less, the panel is a sheet over the canvas. */
  SIDE_CANVAS_FLOOR: 320,
  PALETTE_W: 256,
  PALETTE_RAIL_W: 56,
  PROPS_W: 320,
  RIGHT_PANEL_W: 384,
} as const;

export type FlowPaletteTier = 'inline' | 'rail' | 'hidden';
export type FlowPropertiesTier = 'inline' | 'sheet';
export type FlowRightPanelTier = 'rail' | 'drawer';

export interface ResolvedEditorLayout {
  palette: FlowPaletteTier;
  properties: FlowPropertiesTier;
  rightPanel: FlowRightPanelTier;
}

export interface ResolveEditorLayoutInput {
  /** The editor's own measured width: the sidebar and a docked chat take their share of the window. */
  editorWidth?: number | null;
  selectedNode?: boolean;
  /** Triggers, Run history or a test run is open at the right. */
  rightPanelOpen?: boolean;
  paletteCollapsedPreference?: boolean;
  belowMd?: boolean;
  /** First-paint fallback before ResizeObserver has reported a measured container width. */
  legacyInline?: boolean;
}

function measured(width: number | null | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

/**
 * Resolve the editor's chrome from its measured width: the list of steps at the left, the canvas,
 * and ONE panel at the right.
 *
 * Only one thing stands at the right at a time: a selected step's properties, or else the open
 * panel (Triggers, Run history, a test run), which the properties cover while a step is selected.
 * The right side keeps its place beside the canvas on any screen wider than a phone, and the list
 * of steps gives way first (to its rail, then out of sight, where "Add step" opens it). A side
 * panel is a sheet over the canvas only on a phone, or where it would leave the canvas less than
 * SIDE_CANVAS_FLOOR (a tablet held upright with the sidebar open).
 *
 * The collapse preference is a preference only: pressure from the canvas floor can force the
 * rail, but the resolver never asks callers to overwrite the stored choice.
 */
export function resolveEditorLayout(input: ResolveEditorLayoutInput): ResolvedEditorLayout {
  const legacyInline = input.legacyInline !== false;
  const palettePrefersRail = input.paletteCollapsedPreference === true;

  if (input.belowMd === true) return { palette: 'hidden', properties: 'sheet', rightPanel: 'drawer' };
  if (!measured(input.editorWidth)) {
    return legacyInline
      ? { palette: palettePrefersRail ? 'rail' : 'inline', properties: 'inline', rightPanel: 'rail' }
      : { palette: 'hidden', properties: 'sheet', rightPanel: 'drawer' };
  }

  const width = input.editorWidth;
  const properties: FlowPropertiesTier = width - FLOW_LAYOUT.PROPS_W >= FLOW_LAYOUT.SIDE_CANVAS_FLOOR ? 'inline' : 'sheet';
  const rightPanel: FlowRightPanelTier = width - FLOW_LAYOUT.RIGHT_PANEL_W >= FLOW_LAYOUT.SIDE_CANVAS_FLOOR ? 'rail' : 'drawer';

  // What takes room at the right now. A sheet or a drawer lies over the canvas and takes none.
  const side = input.selectedNode === true
    ? (properties === 'inline' ? FLOW_LAYOUT.PROPS_W : 0)
    : input.rightPanelOpen === true && rightPanel === 'rail' ? FLOW_LAYOUT.RIGHT_PANEL_W : 0;
  const room = width - side;
  const palette: FlowPaletteTier = !palettePrefersRail && room - FLOW_LAYOUT.PALETTE_W >= FLOW_LAYOUT.CANVAS_FLOOR
    ? 'inline'
    : room - FLOW_LAYOUT.PALETTE_RAIL_W >= FLOW_LAYOUT.RAIL_CANVAS_FLOOR ? 'rail' : 'hidden';

  return { palette, properties, rightPanel };
}

export function sameResolvedEditorLayout(a: ResolvedEditorLayout, b: ResolvedEditorLayout): boolean {
  return a.palette === b.palette && a.properties === b.properties && a.rightPanel === b.rightPanel;
}

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
    // FLOW-203: through the registry — a contributed node's declared capability belongs in the
    // saved flow's capability list too, or the row under-declares its own reach.
    const spec = flowNodeRegistry.resolveKnownNodeSpec(node.type);
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
