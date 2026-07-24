import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowGraph } from '../../types/flows';

// RUN-301 browser leg: plain core graphs pass through WITHOUT a request; graphs with
// contributed (dotted) types execute the SERVER-compiled canonical IR; a blocked or
// failed compile is a typed 'invalid_flow' refusal — never an unknown-node crash.

const compileFlow = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { compileFlow: (...args: unknown[]) => compileFlow(...args) },
}));

import { graphHasContributedNodes, resolveExecutableGraph } from './compiledGraph';

const coreGraph: WorkflowGraph = {
  nodes: [
    { id: 'in', type: 'input', data: {}, position: { x: 0, y: 0 } },
    { id: 't', type: 'template', data: { template: 'x' }, position: { x: 1, y: 0 } },
  ],
  edges: [{ source: 'in', target: 't' }],
};

const contributedGraph: WorkflowGraph = {
  nodes: [
    { id: 'in', type: 'input', data: {}, position: { x: 0, y: 0 } },
    { id: 'g', type: 'com.acme.presets.greet', data: {}, position: { x: 1, y: 0 } },
  ],
  edges: [{ source: 'in', target: 'g' }],
};

beforeEach(() => {
  compileFlow.mockReset();
});

describe('graphHasContributedNodes', () => {
  it('detects dotted (namespaced) node types only', () => {
    expect(graphHasContributedNodes(coreGraph)).toBe(false);
    expect(graphHasContributedNodes(contributedGraph)).toBe(true);
    expect(graphHasContributedNodes(null)).toBe(false);
  });
});

describe('resolveExecutableGraph', () => {
  it('passes a core-only graph through without any request', async () => {
    const resolved = await resolveExecutableGraph('flow-1', coreGraph);
    expect(resolved).toEqual({ ok: true, graph: coreGraph });
    expect(compileFlow).not.toHaveBeenCalled();
  });

  it('substitutes the server-compiled IR for a contributed graph', async () => {
    const irNodes = [
      { id: 'in', type: 'input', data: {}, position: { x: 0, y: 0 } },
      { id: 'g', type: 'template', data: { template: 'Hello!' }, position: { x: 1, y: 0 } },
    ];
    compileFlow.mockResolvedValue({
      data: { ok: true, irVersion: 1, irDigest: 'd', ir: { irVersion: 1, compiler: 'c', nodes: irNodes, edges: contributedGraph.edges }, locks: [], diagnostics: [] },
    });
    const resolved = await resolveExecutableGraph('flow-1', contributedGraph);
    expect(compileFlow).toHaveBeenCalledWith('flow-1');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.graph.nodes[1].type).toBe('template');
      expect(resolved.graph.nodes[1].data).toEqual({ template: 'Hello!' });
    }
  });

  it('refuses typed when the compile blocks, surfacing the first error diagnostic', async () => {
    compileFlow.mockResolvedValue({
      data: {
        ok: false,
        irVersion: 1,
        irDigest: null,
        ir: null,
        locks: [],
        diagnostics: [{ severity: 'error', code: 'binding_unresolved', nodeId: 'g', message: 'service bindings are not available yet' }],
      },
    });
    const resolved = await resolveExecutableGraph('flow-1', contributedGraph);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('invalid_flow');
      expect(resolved.error.message).toContain('service bindings are not available yet');
    }
  });

  it('refuses typed on transport failure and on a missing flow id', async () => {
    compileFlow.mockRejectedValue(new Error('network down'));
    const failed = await resolveExecutableGraph('flow-1', contributedGraph);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain('network down');

    const noId = await resolveExecutableGraph(undefined, contributedGraph);
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.error.message).toContain('missing flow id');
  });
});
