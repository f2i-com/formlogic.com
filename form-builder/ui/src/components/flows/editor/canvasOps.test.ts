// Pure canvas operations (canvasOps.ts): copy/paste id-rewire, Dagre auto-layout mapping, and
// edge-control geometry. These back the editor's keyboard shortcuts + context menu, so they must
// be deterministic and never invent dangling edges.
import { describe, expect, it } from 'vitest';
import { cloneSelection, dagreLayout, edgeLabelTransform, midpoint, mintNodeId } from './canvasOps';
import type { FlowRFEdge, FlowRFNode } from './flowGraph';

const node = (id: string, type: string, x = 0, y = 0, data?: Record<string, unknown>): FlowRFNode => ({
  id,
  type,
  position: { x, y },
  data: data ?? {},
});

describe('mintNodeId', () => {
  it('returns the first free <type>-<n> id', () => {
    expect(mintNodeId('logic_block', new Set())).toBe('logic_block-1');
    expect(mintNodeId('logic_block', new Set(['logic_block-1', 'logic_block-2']))).toBe('logic_block-3');
  });
});

describe('cloneSelection (copy/paste id-rewire)', () => {
  const nodes: FlowRFNode[] = [
    node('a', 'template', 0, 0, { template: 'hi {{inputs.n}}' }),
    node('b', 'condition', 100, 0),
    node('outsider', 'output', 300, 0),
  ];
  const edges: FlowRFEdge[] = [
    { id: 'e:a:->b:', source: 'a', target: 'b' },
    { id: 'e:b:true->outsider:', source: 'b', target: 'outsider', sourceHandle: 'true' },
  ];

  it('mints fresh, non-colliding ids and rewires internal edges to them', () => {
    const existing = nodes.map((n) => n.id);
    const { nodes: cloned, edges: clonedEdges, idMap } = cloneSelection([nodes[0], nodes[1]], edges, existing);
    // New ids, none colliding with existing.
    for (const n of cloned) expect(existing).not.toContain(n.id);
    expect(idMap.a).toBe(cloned[0].id);
    expect(idMap.b).toBe(cloned[1].id);
    // Only the wholly-internal a→b edge is carried; b→outsider is dropped (outsider not selected).
    expect(clonedEdges).toHaveLength(1);
    expect(clonedEdges[0].source).toBe(idMap.a);
    expect(clonedEdges[0].target).toBe(idMap.b);
    // The rewired edge id references the new node ids.
    expect(clonedEdges[0].id).toContain(idMap.a);
    expect(clonedEdges[0].id).toContain(idMap.b);
  });

  it('offsets positions, marks the clones selected, and deep-copies data', () => {
    const { nodes: cloned } = cloneSelection([nodes[0]], [], ['a'], { x: 40, y: 40 });
    expect(cloned[0].position).toEqual({ x: 40, y: 40 });
    expect(cloned[0].selected).toBe(true);
    // Mutating the clone's data must not touch the source.
    (cloned[0].data as { template: string }).template = 'changed';
    expect((nodes[0].data as { template: string }).template).toBe('hi {{inputs.n}}');
  });

  it('preserves condition sourceHandle routing on carried edges', () => {
    const withInternalBranch: FlowRFEdge[] = [{ id: 'x', source: 'b', target: 'a', sourceHandle: 'false' }];
    const { edges: cloned } = cloneSelection([nodes[0], nodes[1]], withInternalBranch, ['a', 'b']);
    expect(cloned[0].sourceHandle).toBe('false');
  });
});

describe('dagreLayout', () => {
  const chain: FlowRFNode[] = [node('in', 'input'), node('mid', 'logic_block'), node('out', 'output')];
  const chainEdges: FlowRFEdge[] = [
    { id: 'e1', source: 'in', target: 'mid' },
    { id: 'e2', source: 'mid', target: 'out' },
  ];

  it('maps every node to a top-left position', () => {
    const pos = dagreLayout(chain, chainEdges);
    expect(Object.keys(pos).sort()).toEqual(['in', 'mid', 'out']);
    for (const p of Object.values(pos)) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
    }
  });

  it('lays a chain out left-to-right (LR): x increases along the chain', () => {
    const pos = dagreLayout(chain, chainEdges, { direction: 'LR' });
    expect(pos.mid.x).toBeGreaterThan(pos.in.x);
    expect(pos.out.x).toBeGreaterThan(pos.mid.x);
  });

  it('is deterministic — same graph + options give identical positions', () => {
    const a = dagreLayout(chain, chainEdges);
    const b = dagreLayout(chain, chainEdges);
    expect(a).toEqual(b);
  });

  it('ignores edges that reference a missing node', () => {
    const pos = dagreLayout([node('only', 'input')], [{ id: 'e', source: 'only', target: 'ghost' }]);
    expect(pos.only).toBeDefined();
  });
});

describe('edge geometry', () => {
  it('midpoint averages the endpoints', () => {
    expect(midpoint(0, 0, 10, 20)).toEqual({ x: 5, y: 10 });
  });
  it('edgeLabelTransform centres the control at the point', () => {
    expect(edgeLabelTransform(12, 34)).toBe('translate(-50%, -50%) translate(12px, 34px)');
  });
});
