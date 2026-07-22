// WorkflowGraph ↔ React Flow serialization round-trip (flowGraph.ts).
//
// The stored graph is what the backend, the v0 executor, and the future full F2I engine read,
// so the editor's converters must not lose or invent fields: a graph → React Flow → graph
// round-trip has to be an identity (for a graph the editor fully models — placed nodes, data,
// and condition handles).
import { describe, expect, it } from 'vitest';
import { assignEdgeIds, edgeId, graphToReactFlow, reactFlowToGraph } from './flowGraph';
import type { WorkflowGraph } from '../../../types/flows';

const GRAPH: WorkflowGraph = {
  nodes: [
    { id: 'in', type: 'input', position: { x: 80, y: 160 } },
    { id: 'cond', type: 'condition', position: { x: 340, y: 160 }, data: { expr: 'inputs.n > 0' } },
    { id: 'yes', type: 'template', position: { x: 620, y: 80 }, data: { template: 'positive {{inputs.n}}' } },
    { id: 'no', type: 'template', position: { x: 620, y: 260 }, data: { template: 'non-positive' } },
    { id: 'out', type: 'output', position: { x: 900, y: 160 } },
  ],
  edges: [
    { source: 'in', target: 'cond' },
    { source: 'cond', target: 'yes', sourceHandle: 'true' },
    { source: 'cond', target: 'no', sourceHandle: 'false' },
    { source: 'yes', target: 'out' },
    { source: 'no', target: 'out' },
  ],
};

describe('flowGraph serialization', () => {
  it('round-trips a fully-modelled graph as an identity', () => {
    const { nodes, edges } = graphToReactFlow(GRAPH);
    const back = reactFlowToGraph(nodes, edges);
    expect(back).toEqual(GRAPH);
  });

  it('preserves condition sourceHandles through React Flow edges', () => {
    const { edges } = graphToReactFlow(GRAPH);
    const trueEdge = edges.find((e) => e.target === 'yes');
    const falseEdge = edges.find((e) => e.target === 'no');
    expect(trueEdge?.sourceHandle).toBe('true');
    expect(falseEdge?.sourceHandle).toBe('false');
  });

  it('gives every React Flow node a defined type, position and data', () => {
    const { nodes } = graphToReactFlow(GRAPH);
    for (const n of nodes) {
      expect(typeof n.type).toBe('string');
      expect(typeof n.position.x).toBe('number');
      expect(n.data).toBeDefined();
    }
  });

  it('assigns a deterministic fallback position to unplaced nodes', () => {
    const g: WorkflowGraph = { nodes: [{ id: 'a', type: 'input' }, { id: 'b', type: 'output' }], edges: [] };
    const first = graphToReactFlow(g).nodes;
    const second = graphToReactFlow(g).nodes;
    expect(first[0].position).toEqual(second[0].position);
    expect(first[1].position).not.toEqual(first[0].position);
  });

  it('omits empty data and undefined handles on the way back to storage', () => {
    const back = reactFlowToGraph(
      [{ id: 'x', type: 'input', position: { x: 1, y: 2 }, data: {} }],
      [{ id: 'e', source: 'x', target: 'x' }],
    );
    expect(back.nodes[0]).toEqual({ id: 'x', type: 'input', position: { x: 1, y: 2 } });
    expect(back.nodes[0]).not.toHaveProperty('data');
    expect(back.edges[0]).toEqual({ source: 'x', target: 'x' });
  });

  it('edgeId is stable and handle-aware', () => {
    expect(edgeId({ source: 'a', target: 'b' })).toBe('e:a:->b:');
    expect(edgeId({ source: 'a', target: 'b', sourceHandle: 'true' })).toBe('e:a:true->b:');
  });

  it('STORED graph-v2 edge ids round-trip verbatim; editor-synthesized ids do not persist', () => {
    const stored: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'input', position: { x: 0, y: 0 } },
        { id: 'b', type: 'output', position: { x: 100, y: 0 } },
      ],
      edges: [{ id: 'edge-1', source: 'a', target: 'b' }],
    };
    const rf = graphToReactFlow(stored);
    expect(rf.edges[0].id).toBe('edge-1'); // stored id wins over the synthesized endpoint id
    const back = reactFlowToGraph(rf.nodes, rf.edges);
    expect(back.edges[0].id).toBe('edge-1');
    // An RF edge with no persistId marker (editor-created / legacy load) stays id-less.
    const legacy = reactFlowToGraph(rf.nodes, [{ id: 'e:a:->b:', source: 'a', target: 'b' }]);
    expect(legacy.edges[0]).not.toHaveProperty('id');
  });

  it('assignEdgeIds gives every edge a stable id, keeps stored ids, and dedupes collisions', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'input' },
        { id: 'b', type: 'output' },
      ],
      edges: [
        { id: 'kept', source: 'a', target: 'b' },
        { source: 'a', target: 'b', sourceHandle: 'x' },
        { source: 'a', target: 'b' }, // collides with nothing (distinct endpoints hash)
        { source: 'a', target: 'b' }, // true duplicate — needs a suffix
      ],
    };
    const out = assignEdgeIds(g);
    const ids = out.edges.map((e) => e.id);
    expect(ids[0]).toBe('kept');
    expect(ids[1]).toBe('e:a:x->b:');
    expect(ids[2]).toBe('e:a:->b:');
    expect(ids[3]).toBe('e:a:->b:#2');
    expect(new Set(ids).size).toBe(4);
    // Idempotent: a fully-id'd graph is returned as-is (same reference — no spurious dirty).
    expect(assignEdgeIds(out)).toBe(out);
    // Pure: the input graph was not mutated.
    expect(g.edges[1]).not.toHaveProperty('id');
  });

  it('the round trip is a FIXPOINT — round-tripping its own output changes nothing', () => {
    // FlowEditor seeds its last-saved baseline with the round-tripped stored graph and
    // derives `dirty` by comparing serializations. That is only sound if a second round
    // trip is byte-identical to the first — otherwise merely OPENING a flow reads as an
    // edit and the autosave bumps a version (the regression this pins). Storage-authored
    // quirks (missing positions, fractional coords, extra key order) may normalize on the
    // FIRST pass, but the normal form must be stable.
    const stored = {
      nodes: [
        { id: 'a', type: 'input', data: { label: 'In' } }, // no position → fallback assigned
        { id: 'b', data: {}, type: 'output', position: { x: 10.4, y: 99.6 } }, // fractional + odd key order
      ],
      edges: [{ source: 'a', target: 'b', sourceHandle: 'out' }],
    };
    const once = (() => {
      const rf = graphToReactFlow(stored as never);
      return reactFlowToGraph(rf.nodes, rf.edges);
    })();
    const twice = (() => {
      const rf = graphToReactFlow(once);
      return reactFlowToGraph(rf.nodes, rf.edges);
    })();
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
