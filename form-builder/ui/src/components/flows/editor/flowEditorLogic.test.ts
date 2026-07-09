// Pure FlowEditor behavior: undo coalescing and persisted capability metadata.
import { describe, expect, it } from 'vitest';
import {
  FLOW_LAYOUT,
  computeCapabilitiesFromGraph,
  patchHistoryKey,
  resolveEditorLayout,
  shouldPushPatchHistory,
  type PatchHistoryBurst,
} from './flowEditorLogic';
import type { WorkflowGraph } from '../../../types/flows';

describe('resolveEditorLayout', () => {
  it('keeps properties inline only when the palette rail and canvas floor still fit', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PROPS_W + FLOW_LAYOUT.PALETTE_RAIL_W + FLOW_LAYOUT.CANVAS_FLOOR,
      selectedNode: true,
    }).properties).toBe('inline');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PROPS_W + FLOW_LAYOUT.PALETTE_RAIL_W + FLOW_LAYOUT.CANVAS_FLOOR - 1,
      selectedNode: true,
    }).properties).toBe('sheet');
  });

  it('degrades the palette from expanded to rail to hidden around the canvas floor', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR,
      paletteCollapsedPreference: false,
    }).palette).toBe('inline');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR - 1,
      paletteCollapsedPreference: false,
    }).palette).toBe('rail');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_RAIL_W + FLOW_LAYOUT.CANVAS_FLOOR - 1,
      paletteCollapsedPreference: false,
    }).palette).toBe('hidden');
  });

  it('layers palette and library collapse preferences under forced space tiers', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR + 80,
      paletteCollapsedPreference: true,
    }).palette).toBe('rail');

    expect(resolveEditorLayout({
      workspaceWidth: FLOW_LAYOUT.LIBRARY_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PALETTE_RAIL_W,
      selectedFlow: true,
      libraryCollapsedPreference: false,
    }).library).toBe('expanded');

    expect(resolveEditorLayout({
      workspaceWidth: FLOW_LAYOUT.LIBRARY_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PALETTE_RAIL_W - 1,
      selectedFlow: true,
      libraryCollapsedPreference: false,
    }).library).toBe('rail');

    expect(resolveEditorLayout({
      workspaceWidth: FLOW_LAYOUT.LIBRARY_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PALETTE_RAIL_W + 120,
      selectedFlow: true,
      libraryCollapsedPreference: true,
    }).library).toBe('rail');
  });

  it('moves the right panel from inline rail to drawer when the measured workspace is tight', () => {
    expect(resolveEditorLayout({
      workspaceWidth: FLOW_LAYOUT.LIBRARY_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PALETTE_RAIL_W + FLOW_LAYOUT.RIGHT_PANEL_W,
      selectedFlow: true,
      rightPanelOpen: true,
    }).rightPanel).toBe('rail');

    expect(resolveEditorLayout({
      workspaceWidth: FLOW_LAYOUT.LIBRARY_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PALETTE_RAIL_W + FLOW_LAYOUT.RIGHT_PANEL_W - 1,
      selectedFlow: true,
      rightPanelOpen: true,
    }).rightPanel).toBe('drawer');
  });

  it('preserves the sub-md mobile behavior and first-paint legacy fallback', () => {
    expect(resolveEditorLayout({
      belowMd: true,
      editorWidth: 1200,
      workspaceWidth: 1600,
      selectedNode: true,
      selectedFlow: true,
      rightPanelOpen: true,
    })).toMatchObject({ palette: 'hidden', properties: 'sheet', rightPanel: 'drawer' });

    expect(resolveEditorLayout({
      editorWidth: null,
      workspaceWidth: null,
      legacyInline: true,
      selectedNode: true,
      rightPanelOpen: true,
    })).toMatchObject({ palette: 'inline', properties: 'inline', rightPanel: 'rail' });

    expect(resolveEditorLayout({
      editorWidth: null,
      workspaceWidth: null,
      legacyInline: false,
      selectedNode: true,
      rightPanelOpen: true,
    })).toMatchObject({ palette: 'hidden', properties: 'sheet', rightPanel: 'drawer' });
  });
});

describe('patch history coalescing', () => {
  it('coalesces consecutive edits to the same node field within one second', () => {
    const key = patchHistoryKey('node-1', { prompt: 'a' });
    expect(key).toBe('node-1:prompt');
    const previous: PatchHistoryBurst = { key: key ?? '', atMs: 1000 };

    expect(shouldPushPatchHistory(null, key, 1000)).toBe(true);
    expect(shouldPushPatchHistory(previous, key, 1800)).toBe(false);
    expect(shouldPushPatchHistory(previous, key, 2101)).toBe(true);
  });

  it('keeps different fields and multi-field patches discrete', () => {
    const previous: PatchHistoryBurst = { key: 'node-1:prompt', atMs: 1000 };

    expect(shouldPushPatchHistory(previous, patchHistoryKey('node-1', { system: 'x' }), 1100)).toBe(true);
    expect(patchHistoryKey('node-1', { system: 'x', prompt: 'y' })).toBeNull();
    expect(shouldPushPatchHistory(previous, null, 1100)).toBe(true);
  });
});

describe('computeCapabilitiesFromGraph', () => {
  it('recomputes static and dynamic capabilities from current nodes only', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'ai', type: 'llm_chat', data: {} },
        { id: 'kv', type: 'storage_set', data: {} },
        { id: 'sms', type: 'connector_request', data: { connectorId: 'aokie', command: 'sms.send' } },
        { id: 'speak', type: 'aokie_speak', data: {} },
      ],
      edges: [],
    };

    expect(computeCapabilitiesFromGraph(graph)).toEqual([
      'model.llm.local',
      'formlogic.kv.write',
      'connector.aokie.sms.send',
      'connector.aokie.call.operatorSpeak',
    ]);
  });

  it('drops stale capabilities when the requiring node is no longer present', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input', data: {} },
        { id: 'out', type: 'output', data: {} },
      ],
      edges: [{ source: 'in', target: 'out' }],
    };

    expect(computeCapabilitiesFromGraph(graph)).toEqual([]);
  });
});
