// @vitest-environment node
//
// formlogic-python/1 end to end in the page's own plumbing: a flow runs through the executor,
// the executor deps flowDispatcher builds, engine.ts (watchdog, request ids, Worker protocol)
// and the REAL formlogic.worker.ts module with the installed ZIPP engine. Vitest has no Worker,
// so a stand-in runs the worker module in this thread and passes messages through
// structuredClone, as postMessage would. A Python logic_block and a Python condition feed a
// JavaScript logic_block and a template, which is how authors mix the two languages.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './formlogic.worker';
import type { WorkflowGraph } from '../../types/flows';

vi.mock('./zipp-bytes', () => ({
  // The page verifies and caches these bytes; here they are the installed engine itself.
  getZippWasmBytes: async () => {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(new URL('../../../vendor/zipp-wasm/zipp_wasm_bg.wasm', import.meta.url));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
}));

const CASE_TIMEOUT_MS = 30_000;

/** Every request the page posted, as the worker module received it. */
const requests: WorkerRequest[] = [];

/** The worker module, run in this thread behind the Worker interface engine.ts uses. */
class InProcessWorker {
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly scope: { onmessage: ((event: { data: unknown }) => unknown) | null; postMessage(message: WorkerResponse): void };
  private readonly loaded: Promise<unknown>;

  constructor() {
    this.scope = {
      onmessage: null,
      postMessage: (message) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(message) })),
    };
    vi.stubGlobal('self', this.scope);
    this.loaded = import('./formlogic.worker');
  }

  postMessage(message: WorkerRequest | WorkerInit): void {
    const copy = structuredClone(message);
    if (!('type' in copy)) requests.push(copy);
    void this.loaded.then(() => this.scope.onmessage?.({ data: copy }));
  }

  terminate(): void {
    this.onmessage = null;
  }
}

const CUSTOMERS = [
  { phone: '+61400000000', name: 'Other' },
  { phone: '+61491570156', name: 'Ada' },
];

function graph(pythonBlock: string): WorkflowGraph {
  return {
    nodes: [
      { id: 'in', type: 'input' },
      { id: 'py', type: 'logic_block', data: { language: 'python', expr: pythonBlock } },
      { id: 'known', type: 'condition', data: { language: 'python', expr: 'nodes["py"]["found"]' } },
      { id: 'js', type: 'logic_block', data: { expr: 'return nodes.py.greeting + ", " + nodes.py.name + "!";' } },
      { id: 'tpl', type: 'template', data: { template: '{{nodes.js}} ({{nodes.py.visits}} visits)' } },
      { id: 'unknown', type: 'template', data: { template: 'no match for {{inputs.from}}' } },
      { id: 'out', type: 'output' },
    ],
    edges: [
      { source: 'in', target: 'py' },
      { source: 'py', target: 'known' },
      { source: 'known', target: 'js', sourceHandle: 'true' },
      { source: 'known', target: 'unknown', sourceHandle: 'false' },
      { source: 'js', target: 'tpl' },
      { source: 'tpl', target: 'out' },
      { source: 'unknown', target: 'out' },
    ],
  };
}

const PYTHON_BLOCK = [
  'matches = [c for c in inputs["customers"] if c["phone"] == inputs["from"]]',
  'result = {',
  '    "found": len(matches) > 0,',
  '    "name": matches[0]["name"] if matches else None,',
  '    "greeting": kv["greeting"],',
  '    "visits": sum(1 for c in inputs["customers"] if c["name"] != "Other") * 2,',
  '}',
].join('\n');

describe('a Python logic_block feeding JavaScript, through engine.ts and the worker module', () => {
  beforeAll(() => {
    vi.stubGlobal('Worker', InProcessWorker as unknown as typeof Worker);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  async function run(inputs: Record<string, unknown>) {
    const { executeFlow } = await import('../../client-runtime/flows/flowExecutor');
    const { buildWorkspaceExecutorDeps } = await import('../../client-runtime/flows/flowDispatcher');
    const outputs: Record<string, unknown> = {};
    const outcome = await executeFlow(graph(PYTHON_BLOCK), {
      inputs,
      deps: { ...buildWorkspaceExecutorDeps(), kvList: async () => ({ greeting: 'Hello' }) },
      flowSlug: 'smoke',
      onNodeStatus: (nodeId, state, detail) => {
        if (state === 'done') outputs[nodeId] = detail?.output;
      },
    });
    return { outcome, outputs };
  }

  it('matches the caller in Python and greets them from JavaScript', async () => {
    requests.length = 0;
    const { outcome, outputs } = await run({ from: '+61491570156', customers: CUSTOMERS });

    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe('done');
    expect(outputs.py).toEqual({ found: true, name: 'Ada', greeting: 'Hello', visits: 2 });
    expect(outputs.known).toBe(true);
    expect(outputs.js).toBe('Hello, Ada!');
    expect(outcome.result).toBe('Hello, Ada! (2 visits)');

    // What crossed to the Worker: Python for the two Python nodes, nothing for JavaScript.
    expect(requests.map((r) => [r.kind, r.language])).toEqual([
      ['flow', 'python'],
      ['condition', 'python'],
      ['flow', 'javascript'],
    ]);
    expect(requests[0].context).toMatchObject({ inputs: { from: '+61491570156' }, kv: { greeting: 'Hello' } });
  }, CASE_TIMEOUT_MS);

  it('takes the false branch when Python finds no match', async () => {
    const { outcome, outputs } = await run({ from: '+61000000000', customers: CUSTOMERS });
    expect(outcome.status).toBe('done');
    expect(outputs.py).toEqual({ found: false, name: null, greeting: 'Hello', visits: 2 });
    expect(outputs.known).toBe(false);
    expect(outcome.result).toBe('no match for +61000000000');
  }, CASE_TIMEOUT_MS);

  it('fails the run at the author line when the Python raises', async () => {
    const { executeFlow } = await import('../../client-runtime/flows/flowExecutor');
    const { buildWorkspaceExecutorDeps } = await import('../../client-runtime/flows/flowDispatcher');
    const broken: WorkflowGraph = {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'py', type: 'logic_block', data: { language: 'python', expr: 'x = 1\nresult = inputs["missing"]' } },
      ],
      edges: [{ source: 'in', target: 'py' }],
    };
    const outcome = await executeFlow(broken, {
      inputs: {},
      deps: { ...buildWorkspaceExecutorDeps(), kvList: async () => ({}) },
    });
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('node_failed');
    expect(outcome.error?.message).toMatch(/KeyError: 'missing' \(line 2\)/);
  }, CASE_TIMEOUT_MS);
});
