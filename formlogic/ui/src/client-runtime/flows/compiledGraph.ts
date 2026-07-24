// RUN-301 browser leg (ADR-010 / plan §9.3): a flow whose graph stores CONTRIBUTED node
// types (namespaced dotted types from installed extensions) executes the SERVER-compiled
// canonical IR — the compiler is the only lowering authority, and no client-side compile
// path exists or may be added. Plain core graphs pass through without a request, so the
// common case (and every demo-local flow, which can never carry contributed types) costs
// nothing. A blocked or failed compile is a typed run refusal ('invalid_flow' — the same
// code the missing-definition placeholder documents), never an unknown-node crash mid-run.
import { api } from '../../lib/api';
import type { WorkflowGraph } from '../../types/flows';

/** True when the graph stores contributed (dotted) node types that need server lowering. */
export function graphHasContributedNodes(graph: WorkflowGraph | null | undefined): boolean {
  return !!graph && Array.isArray(graph.nodes)
    && graph.nodes.some((n) => typeof n?.type === 'string' && n.type.includes('.'));
}

export type ResolvedExecutableGraph =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; error: { code: 'invalid_flow'; message: string } };

/**
 * Resolve the graph a browser run should EXECUTE. Deterministic per (flow revision,
 * installed definitions), so callers resolve once per run — retry loops must not re-resolve.
 */
export async function resolveExecutableGraph(
  flowId: string | undefined,
  graph: WorkflowGraph,
): Promise<ResolvedExecutableGraph> {
  if (!graphHasContributedNodes(graph)) {
    return { ok: true, graph };
  }
  if (!flowId) {
    return {
      ok: false,
      error: { code: 'invalid_flow', message: 'this run context cannot compile contributed extension nodes (missing flow id)' },
    };
  }
  try {
    const res = await api.compileFlow(flowId);
    const ir = res.data?.ok ? res.data.ir : null;
    if (ir && Array.isArray(ir.nodes) && Array.isArray(ir.edges)) {
      // Keep everything else the stored graph carries (graphVersion, …); only the node/edge
      // sets are the compiler's.
      return { ok: true, graph: { ...graph, nodes: ir.nodes, edges: ir.edges } as WorkflowGraph };
    }
    const firstError = res.data?.diagnostics?.find((d) => d.severity === 'error');
    const detail = firstError?.message
      ?? (typeof res.error === 'string' && res.error !== '' ? res.error : 'the server compile did not return IR');
    return {
      ok: false,
      error: { code: 'invalid_flow', message: `contributed extension nodes could not be compiled: ${detail}` },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_flow',
        message: 'contributed extension nodes could not be compiled: ' + (err instanceof Error ? err.message : 'network error'),
      },
    };
  }
}
