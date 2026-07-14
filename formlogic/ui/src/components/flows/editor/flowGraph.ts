// FormLogic Flows editor — WorkflowGraph ↔ React Flow serialization.
//
// The editor works on React Flow's { nodes, edges } shape; storage (flow_definitions.flow_json)
// is the F2I-compatible WorkflowGraph ({ nodes:[{id,type,data,position}], edges:[{source,target,
// sourceHandle?,targetHandle?}] }). These pure converters round-trip losslessly (see
// flowGraph.test.ts): the stored graph is what the backend, the v0 executor, and the future
// full F2I engine all read, so the editor must never mutate a foreign field it doesn't model.
import type { Edge, Node } from '@xyflow/react';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../../../types/flows';

/** React Flow node data carries the stored `node.data` verbatim (a plain JSON record). */
export type FlowRFNodeData = Record<string, unknown>;
export type FlowRFNode = Node<FlowRFNodeData>;
export type FlowRFEdge = Edge;

/** Deterministic React Flow edge id from its endpoints (WorkflowGraph edges have no id). */
export function edgeId(edge: WorkflowGraphEdge): string {
  return `e:${edge.source}:${edge.sourceHandle ?? ''}->${edge.target}:${edge.targetHandle ?? ''}`;
}

/**
 * Grid fallback position for a node the stored graph didn't place (older graphs / imports
 * omit `position`). Deterministic so an unplaced graph lays out the same every load.
 */
function fallbackPosition(index: number): { x: number; y: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { x: 80 + col * 280, y: 80 + row * 180 };
}

/** WorkflowGraph → React Flow nodes/edges. */
export function graphToReactFlow(graph: WorkflowGraph): { nodes: FlowRFNode[]; edges: FlowRFEdge[] } {
  const nodes: FlowRFNode[] = (graph.nodes ?? []).map((n, i) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? fallbackPosition(i),
    data: (n.data ?? {}) as FlowRFNodeData,
  }));
  const edges: FlowRFEdge[] = (graph.edges ?? []).map((e) => ({
    id: edgeId(e),
    source: e.source,
    target: e.target,
    ...(e.sourceHandle !== undefined ? { sourceHandle: e.sourceHandle } : {}),
    ...(e.targetHandle !== undefined ? { targetHandle: e.targetHandle } : {}),
  }));
  return { nodes, edges };
}

/** React Flow nodes/edges → WorkflowGraph (drops RF-only fields; keeps data/position/handles). */
export function reactFlowToGraph(nodes: FlowRFNode[], edges: FlowRFEdge[]): WorkflowGraph {
  const outNodes: WorkflowGraphNode[] = nodes.map((n) => {
    const data = (n.data ?? {}) as FlowRFNodeData;
    const node: WorkflowGraphNode = {
      id: n.id,
      type: String(n.type ?? ''),
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    };
    if (Object.keys(data).length > 0) node.data = data;
    return node;
  });
  const outEdges: WorkflowGraphEdge[] = edges.map((e) => {
    const edge: WorkflowGraphEdge = { source: e.source, target: e.target };
    if (e.sourceHandle !== undefined && e.sourceHandle !== null) edge.sourceHandle = e.sourceHandle;
    if (e.targetHandle !== undefined && e.targetHandle !== null) edge.targetHandle = e.targetHandle;
    return edge;
  });
  return { nodes: outNodes, edges: outEdges };
}
