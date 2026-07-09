// Pure FlowEditor helpers kept outside the React component for focused Vitest coverage.
//
// These helpers cover persistence metadata and undo coalescing without a React Flow test harness.
import type { WorkflowGraph } from '../../../types/flows';
import { getNodeSpec } from './nodeCatalog';

export const PATCH_HISTORY_COALESCE_MS = 1000;

export const FLOW_LAYOUT = {
  CANVAS_FLOOR: 440,
  PALETTE_W: 256,
  PALETTE_RAIL_W: 56,
  PROPS_W: 320,
  RIGHT_PANEL_W: 384,
  LIBRARY_W: 288,
  LIBRARY_RAIL_W: 56,
} as const;

export type FlowPaletteTier = 'inline' | 'rail' | 'hidden';
export type FlowPropertiesTier = 'inline' | 'sheet';
export type FlowRightPanelTier = 'rail' | 'drawer';
export type FlowLibraryTier = 'expanded' | 'rail';

export interface ResolvedEditorLayout {
  palette: FlowPaletteTier;
  properties: FlowPropertiesTier;
  rightPanel: FlowRightPanelTier;
  library: FlowLibraryTier;
}

export interface ResolveEditorLayoutInput {
  editorWidth?: number | null;
  workspaceWidth?: number | null;
  selectedNode?: boolean;
  selectedFlow?: boolean;
  rightPanelOpen?: boolean;
  paletteCollapsedPreference?: boolean;
  libraryCollapsedPreference?: boolean;
  belowMd?: boolean;
  /** First-paint fallback before ResizeObserver has reported a measured container width. */
  legacyInline?: boolean;
}

function measured(width: number | null | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

/**
 * Resolve the flows workspace/editor chrome from measured container width.
 *
 * User collapse preferences are treated as preferences only: pressure from the canvas floor can
 * force a rail/sheet/drawer, but the resolver never asks callers to overwrite persisted prefs.
 */
export function resolveEditorLayout(input: ResolveEditorLayoutInput): ResolvedEditorLayout {
  const belowMd = input.belowMd === true;
  const legacyInline = input.legacyInline !== false;
  const selectedNode = input.selectedNode === true;
  const selectedFlow = input.selectedFlow === true;
  const palettePrefersRail = input.paletteCollapsedPreference === true;
  const libraryPrefersRail = input.libraryCollapsedPreference === true;

  let properties: FlowPropertiesTier = 'sheet';
  let palette: FlowPaletteTier = 'hidden';

  if (!belowMd && !measured(input.editorWidth)) {
    properties = selectedNode && legacyInline ? 'inline' : 'sheet';
    palette = legacyInline ? (palettePrefersRail ? 'rail' : 'inline') : 'hidden';
  } else if (!belowMd) {
    const editorWidth = measured(input.editorWidth) ? input.editorWidth : 0;
    const canInlineProperties =
      selectedNode && editorWidth - FLOW_LAYOUT.PROPS_W - FLOW_LAYOUT.PALETTE_RAIL_W >= FLOW_LAYOUT.CANVAS_FLOOR;
    properties = canInlineProperties ? 'inline' : 'sheet';

    const propertiesWidth = canInlineProperties ? FLOW_LAYOUT.PROPS_W : 0;
    if (!palettePrefersRail && editorWidth - propertiesWidth - FLOW_LAYOUT.PALETTE_W >= FLOW_LAYOUT.CANVAS_FLOOR) {
      palette = 'inline';
    } else if (editorWidth - propertiesWidth - FLOW_LAYOUT.PALETTE_RAIL_W >= FLOW_LAYOUT.CANVAS_FLOOR) {
      palette = 'rail';
    } else {
      palette = 'hidden';
    }
  }

  let library: FlowLibraryTier = libraryPrefersRail ? 'rail' : 'expanded';
  let rightPanel: FlowRightPanelTier = 'drawer';

  if (!belowMd && !measured(input.workspaceWidth)) {
    library = libraryPrefersRail ? 'rail' : 'expanded';
    rightPanel = legacyInline ? 'rail' : 'drawer';
  } else if (!belowMd) {
    const workspaceWidth = measured(input.workspaceWidth) ? input.workspaceWidth : 0;
    const expandedLibraryFits =
      !selectedFlow ||
      workspaceWidth - FLOW_LAYOUT.LIBRARY_W - FLOW_LAYOUT.CANVAS_FLOOR - FLOW_LAYOUT.PALETTE_RAIL_W >= 0;
    library = libraryPrefersRail || !expandedLibraryFits ? 'rail' : 'expanded';

    const libraryWidth = library === 'rail' ? FLOW_LAYOUT.LIBRARY_RAIL_W : FLOW_LAYOUT.LIBRARY_W;
    rightPanel =
      input.rightPanelOpen === true &&
      workspaceWidth - libraryWidth - FLOW_LAYOUT.CANVAS_FLOOR - FLOW_LAYOUT.PALETTE_RAIL_W >= FLOW_LAYOUT.RIGHT_PANEL_W
        ? 'rail'
        : 'drawer';
  }

  return { palette, properties, rightPanel, library };
}

export function sameResolvedEditorLayout(a: ResolvedEditorLayout, b: ResolvedEditorLayout): boolean {
  return a.palette === b.palette && a.properties === b.properties && a.rightPanel === b.rightPanel && a.library === b.library;
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
