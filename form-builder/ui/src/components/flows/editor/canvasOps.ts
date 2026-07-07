// FormLogic Flows editor — pure canvas operations (copy/paste rewire, auto-layout, edge geometry).
//
// Extracted from the React components so the graph transforms are deterministic + unit-testable:
// FlowEditor wires these to keyboard shortcuts + the context menu, FlowEdge uses the geometry
// helpers. None of this touches execution semantics — it only rearranges the authoring graph.
import dagre from 'dagre';
import { edgeId } from './flowGraph';
import type { FlowRFEdge, FlowRFNode } from './flowGraph';

/** A fresh, non-colliding node id of the form `<type>-<n>` given the ids already in use. */
export function mintNodeId(type: string, taken: Set<string>): string {
  const base = type || 'node';
  let i = 1;
  let id = `${base}-${i}`;
  while (taken.has(id)) id = `${base}-${++i}`;
  return id;
}

export interface CloneResult {
  nodes: FlowRFNode[];
  edges: FlowRFEdge[];
  /** old node id → new node id. */
  idMap: Record<string, string>;
}

/**
 * Clone a selection of nodes (and the edges wholly inside it) with fresh, non-colliding ids, a
 * position offset, and everything marked selected. Edges with an endpoint OUTSIDE the selection are
 * dropped (they'd dangle). Node `data` is deep-copied so the paste is fully independent. Pure.
 */
export function cloneSelection(
  selNodes: FlowRFNode[],
  selEdges: FlowRFEdge[],
  existingIds: Iterable<string>,
  offset: { x: number; y: number } = { x: 40, y: 40 },
): CloneResult {
  const taken = new Set(existingIds);
  const idMap: Record<string, string> = {};
  const nodes: FlowRFNode[] = selNodes.map((n) => {
    const id = mintNodeId(String(n.type ?? 'node'), taken);
    taken.add(id);
    idMap[n.id] = id;
    return {
      ...n,
      id,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      selected: true,
      data: n.data ? (JSON.parse(JSON.stringify(n.data)) as FlowRFNode['data']) : n.data,
    };
  });
  const selIds = new Set(selNodes.map((n) => n.id));
  const edges: FlowRFEdge[] = selEdges
    .filter((e) => selIds.has(e.source) && selIds.has(e.target))
    .map((e) => {
      const source = idMap[e.source];
      const target = idMap[e.target];
      return {
        ...e,
        id: edgeId({ source, target, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined }),
        source,
        target,
        selected: true,
      };
    });
  return { nodes, edges, idMap };
}

export interface DagreLayoutOptions {
  direction?: 'LR' | 'TB';
  nodeWidth?: number;
  nodeHeight?: number;
  nodesep?: number;
  ranksep?: number;
}

/**
 * Lay out a graph with Dagre and return each node's NEW top-left position keyed by id (React Flow
 * positions are top-left; Dagre reports centres, so we convert). Deterministic for a given graph +
 * options — the layout test relies on this. Nodes Dagre couldn't place keep no entry (caller keeps
 * the old position). Only edges whose endpoints both exist are fed to Dagre.
 */
export function dagreLayout(
  nodes: FlowRFNode[],
  edges: FlowRFEdge[],
  options: DagreLayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const width = options.nodeWidth ?? 224; // matches the node card (w-56)
  const height = options.nodeHeight ?? 96;
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: options.direction ?? 'LR',
    nodesep: options.nodesep ?? 44,
    ranksep: options.ranksep ?? 90,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width, height });
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      positions[n.id] = { x: Math.round(p.x - width / 2), y: Math.round(p.y - height / 2) };
    }
  }
  return positions;
}

/** Geometric midpoint of two points — the fallback anchor for an edge's inline control. */
export function midpoint(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

/** CSS transform placing an absolutely-positioned edge control centred at flow-space (x, y). */
export function edgeLabelTransform(x: number, y: number): string {
  return `translate(-50%, -50%) translate(${x}px, ${y}px)`;
}
