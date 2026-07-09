// Pure FlowEditor behavior: undo coalescing and persisted capability metadata.
import { describe, expect, it } from 'vitest';
import {
  computeCapabilitiesFromGraph,
  patchHistoryKey,
  shouldPushPatchHistory,
  type PatchHistoryBurst,
} from './flowEditorLogic';
import type { WorkflowGraph } from '../../../types/flows';

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
