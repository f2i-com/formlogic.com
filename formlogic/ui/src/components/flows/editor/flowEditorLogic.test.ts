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
  it('keeps a step\'s properties beside the canvas down to the least canvas a side panel may leave', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PROPS_W + FLOW_LAYOUT.SIDE_CANVAS_FLOOR,
      selectedNode: true,
    }).properties).toBe('inline');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PROPS_W + FLOW_LAYOUT.SIDE_CANVAS_FLOOR - 1,
      selectedNode: true,
    }).properties).toBe('sheet');
  });

  it('never turns the properties into a sheet on a desktop window, sidebar open or not', () => {
    // The editor's width at 1024, 1280 and 1440 wide with the sidebar open (256), and at 1024
    // with it collapsed (64). At 1024 with the sidebar this used to be a sheet over the window.
    for (const editorWidth of [768, 1024, 1184, 960]) {
      expect(resolveEditorLayout({ editorWidth, selectedNode: true }).properties).toBe('inline');
      expect(resolveEditorLayout({ editorWidth, rightPanelOpen: true }).rightPanel).toBe('rail');
    }
  });

  it('degrades the palette from expanded to rail to hidden around the canvas floors', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR,
      paletteCollapsedPreference: false,
    }).palette).toBe('inline');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR - 1,
      paletteCollapsedPreference: false,
    }).palette).toBe('rail');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_RAIL_W + FLOW_LAYOUT.RAIL_CANVAS_FLOOR - 1,
      paletteCollapsedPreference: false,
    }).palette).toBe('hidden');
  });

  it('has the palette give way to what stands at the right, never the other way round', () => {
    const fitsBoth = FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PROPS_W;
    expect(resolveEditorLayout({ editorWidth: fitsBoth, selectedNode: true })).toMatchObject({ palette: 'inline', properties: 'inline' });
    expect(resolveEditorLayout({ editorWidth: fitsBoth - 1, selectedNode: true })).toMatchObject({ palette: 'rail', properties: 'inline' });
    // The wider panel (Triggers, Run history, a test run) takes more from the palette.
    expect(resolveEditorLayout({ editorWidth: fitsBoth, rightPanelOpen: true })).toMatchObject({ palette: 'rail', rightPanel: 'rail' });
    // 1024 wide with the sidebar open: the panel stays, the palette is out of the way.
    expect(resolveEditorLayout({ editorWidth: 768, rightPanelOpen: true })).toMatchObject({ palette: 'hidden', rightPanel: 'rail' });
    expect(resolveEditorLayout({ editorWidth: 768, selectedNode: true })).toMatchObject({ palette: 'rail', properties: 'inline' });
  });

  it('counts one thing at the right: a selected step\'s properties cover an open panel', () => {
    const width = FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR + FLOW_LAYOUT.PROPS_W;
    // With both open at once the palette would have to make room for 320 + 384; it makes room
    // for the properties alone, because they stand in the panel's place.
    expect(resolveEditorLayout({ editorWidth: width, selectedNode: true, rightPanelOpen: true }).palette).toBe('inline');
  });

  it('layers the palette collapse preference under forced space tiers', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.PALETTE_W + FLOW_LAYOUT.CANVAS_FLOOR + 80,
      paletteCollapsedPreference: true,
    }).palette).toBe('rail');
  });

  it('moves the right panel from inline rail to drawer when the measured editor is tight', () => {
    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.SIDE_CANVAS_FLOOR + FLOW_LAYOUT.RIGHT_PANEL_W,
      rightPanelOpen: true,
    }).rightPanel).toBe('rail');

    expect(resolveEditorLayout({
      editorWidth: FLOW_LAYOUT.SIDE_CANVAS_FLOOR + FLOW_LAYOUT.RIGHT_PANEL_W - 1,
      rightPanelOpen: true,
    }).rightPanel).toBe('drawer');
  });

  it('gives a drawer or a sheet no room: the palette keeps its place under them', () => {
    // A tablet held upright with the sidebar open (768 - 256).
    expect(resolveEditorLayout({ editorWidth: 512, selectedNode: true })).toMatchObject({ palette: 'rail', properties: 'sheet' });
    expect(resolveEditorLayout({ editorWidth: 512, rightPanelOpen: true })).toMatchObject({ palette: 'rail', rightPanel: 'drawer' });
  });

  it('preserves the sub-md mobile behavior and first-paint legacy fallback', () => {
    expect(resolveEditorLayout({
      belowMd: true,
      editorWidth: 1200,
      selectedNode: true,
      rightPanelOpen: true,
    })).toMatchObject({ palette: 'hidden', properties: 'sheet', rightPanel: 'drawer' });

    expect(resolveEditorLayout({
      editorWidth: null,
      legacyInline: true,
      selectedNode: true,
      rightPanelOpen: true,
    })).toMatchObject({ palette: 'inline', properties: 'inline', rightPanel: 'rail' });

    expect(resolveEditorLayout({
      editorWidth: null,
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
