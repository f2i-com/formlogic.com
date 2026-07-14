// FormLogic Flows — authoring-time graph lint (presentation/authoring aid, NOT the executor).
//
// A stricter check than the executor's structural validate: it also verifies that every
// $nodes.<id> / nodes.<id> reference inside node data (selectors, filters, templates, code,
// output values) points at a node that exists, and that every Condition node routes BOTH its
// True and False handle somewhere. Used by the starter-template + pack-flow tests so a shipped
// flow reads correctly AND can actually run. The executor semantics are unchanged.
import type { WorkflowGraph } from '../../types/flows';
import { effectiveNodeData, evalShowIf, getNodeSpec } from './editor/nodeCatalog';

/** The named inputs a Trigger (input) node declares in `data.inputs` (each { name, example? }). */
export function triggerInputNames(graph: WorkflowGraph): string[] {
  const names: string[] = [];
  for (const node of graph.nodes ?? []) {
    if (node.type !== 'input') continue;
    const inputs = (node.data as { inputs?: unknown } | undefined)?.inputs;
    if (!Array.isArray(inputs)) continue;
    for (const row of inputs) {
      if (row && typeof row === 'object' && typeof (row as { name?: unknown }).name === 'string') {
        const name = (row as { name: string }).name.trim();
        if (name !== '') names.push(name);
      }
    }
  }
  return names;
}

/** Collect every `$nodes.<id>` / `nodes.<id>` node id referenced anywhere in a JSON value's strings. */
function collectNodeRefs(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const re = /(?:\$nodes|nodes)\.([A-Za-z0-9_-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) out.add(m[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNodeRefs(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectNodeRefs(v, out);
  }
}

/**
 * Return a list of problems (empty = clean). Checks: unique ids, edges → existing nodes, every
 * node-output reference resolves to a real node, and each Condition node routes both branches.
 */
export function lintFlowGraph(graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes ?? []) {
    if (ids.has(node.id)) problems.push(`duplicate node id '${node.id}'`);
    ids.add(node.id);
  }

  for (const edge of graph.edges ?? []) {
    if (!ids.has(edge.source)) problems.push(`edge source '${edge.source}' is not a node`);
    if (!ids.has(edge.target)) problems.push(`edge target '${edge.target}' is not a node`);
  }

  // Every $nodes.<id> reference in node data must point at a node that exists.
  for (const node of graph.nodes ?? []) {
    const refs = new Set<string>();
    collectNodeRefs(node.data ?? {}, refs);
    for (const ref of refs) {
      if (!ids.has(ref)) problems.push(`node '${node.id}' references missing node '$nodes.${ref}'`);
    }
  }

  // Condition nodes must route BOTH True and False somewhere (a handle-less edge = the True branch).
  for (const node of graph.nodes ?? []) {
    if (node.type !== 'condition') continue;
    const out = (graph.edges ?? []).filter((e) => e.source === node.id);
    const hasTrue = out.some((e) => e.sourceHandle === 'true' || e.sourceHandle === undefined || e.sourceHandle === '');
    const hasFalse = out.some((e) => e.sourceHandle === 'false');
    if (!hasTrue) problems.push(`condition node '${node.id}' has no True target`);
    if (!hasFalse) problems.push(`condition node '${node.id}' has no False target`);
  }

  return problems;
}

/** An authored value that reads as "not set yet" for a required-property lint. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/**
 * Per-node authoring issues keyed by node id (for the canvas warning badge). A superset of
 * lintFlowGraph's checks, attributed to the specific node so a card can show its own problems:
 * missing required (visible) property, a dangling edge, an unresolved $nodes.<id> reference, a
 * duplicate id, and (for Condition) an unrouted branch. Presentation only — never blocks a run,
 * and a property hidden by its `showIf` is not flagged.
 */
export function lintNodeIssues(graph: WorkflowGraph): Record<string, string[]> {
  const issues: Record<string, string[]> = {};
  const push = (id: string, msg: string) => {
    (issues[id] ??= []).push(msg);
  };
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const ids = new Set(nodes.map((n) => n.id));

  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) push(node.id, `Duplicate node id '${node.id}'`);
    seen.add(node.id);
  }

  // Dangling edges — attribute to whichever endpoint DOES exist.
  for (const edge of edges) {
    const srcOk = ids.has(edge.source);
    const tgtOk = ids.has(edge.target);
    if (!srcOk && tgtOk) push(edge.target, `Incoming edge from a missing node '${edge.source}'`);
    else if (srcOk && !tgtOk) push(edge.source, `Edge points to a missing node '${edge.target}'`);
  }

  // Unresolved $nodes.<id> references inside node data.
  for (const node of nodes) {
    const refs = new Set<string>();
    collectNodeRefs(node.data ?? {}, refs);
    for (const ref of refs) {
      if (!ids.has(ref)) push(node.id, `References a missing node $nodes.${ref}`);
    }
  }

  // Condition branch routing (mirrors lintFlowGraph, per node).
  for (const node of nodes) {
    if (node.type !== 'condition') continue;
    const out = edges.filter((e) => e.source === node.id);
    const hasTrue = out.some((e) => e.sourceHandle === 'true' || e.sourceHandle === undefined || e.sourceHandle === '');
    const hasFalse = out.some((e) => e.sourceHandle === 'false');
    if (!hasTrue) push(node.id, 'No True branch connected');
    if (!hasFalse) push(node.id, 'No False branch connected');
  }

  // Missing required (currently-visible) properties.
  for (const node of nodes) {
    const spec = getNodeSpec(node.type);
    if (!spec) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const effective = effectiveNodeData(spec, data);
    for (const p of spec.properties) {
      if (!p.required) continue;
      if (!evalShowIf(p.showIf, effective)) continue; // hidden field — not authored yet is fine
      if (isEmptyValue(data[p.key])) push(node.id, `${p.label} is required`);
    }
  }

  return issues;
}
