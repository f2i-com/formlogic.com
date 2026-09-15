// @vitest-environment jsdom
// DOM tests for the Test Run drawer's location-aware run dispatch (plan §5.7):
//   - 'auto' keeps the browser runner as the primary action (untouched);
//   - 'cloud' runs POST /api/flows/{id}/run and renders the executed-location badge,
//     upgrade copy on flow_credits_exceeded, and the offending node names on
//     cloud_unsupported_node (forwarded to the editor chrome via onCloudRunFeedback);
//   - 'desktop' rides the E2E relay with a live queue position + node progress and the
//     final sealed result.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runFlowCloudMock, runFlowOnDesktopMock, executeFlowMock, getDesktopConnectionsMock, compileFlowMock } = vi.hoisted(() => ({
  runFlowCloudMock: vi.fn(),
  runFlowOnDesktopMock: vi.fn(),
  executeFlowMock: vi.fn(),
  getDesktopConnectionsMock: vi.fn(),
  compileFlowMock: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    api: {
      isDemoMode: () => false,
      runFlowCloud: (...args: unknown[]) => runFlowCloudMock(...args),
      getDesktopConnections: () => getDesktopConnectionsMock(),
      compileFlow: (...args: unknown[]) => compileFlowMock(...args),
    },
  };
});

vi.mock('../../client-runtime/desktop/desktopFlowRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client-runtime/desktop/desktopFlowRun')>();
  return {
    ...actual,
    runFlowOnDesktop: (...args: unknown[]) => runFlowOnDesktopMock(...args),
  };
});

vi.mock('../../client-runtime/flows/flowExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client-runtime/flows/flowExecutor')>();
  return {
    ...actual,
    executeFlow: (...args: unknown[]) => executeFlowMock(...args),
  };
});

vi.mock('../../client-runtime/flows/flowDispatcher', () => ({
  buildWorkspaceExecutorDeps: () => ({}),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => undefined,
}));

import { TestRunDrawer } from './TestRunDrawer';
import type { CloudRunFeedback } from './editor/executionLocation';
import type { FlowDefinition, WorkflowGraphNode } from '../../types/flows';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function flowWith(location: string | null, nodes: WorkflowGraphNode[] = [{ id: 'list-1', type: 'formlogic_list_responses' }]): FlowDefinition {
  return {
    id: 'flow-1',
    ownerUserId: 'u1',
    appId: null,
    name: 'Echo flow',
    slug: 'echo',
    description: null,
    engine: 'f2i',
    flowJson: {
      nodes,
      edges: [],
    },
    inputSchema: null,
    outputSchema: null,
    nodeCapabilities: null,
    version: 1,
    enabled: true,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...(location === null ? {} : { executionLocation: location }),
  } as FlowDefinition;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDrawer(
  props: Record<string, unknown> = {},
  location: string | null = 'auto',
  nodes?: WorkflowGraphNode[],
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TestRunDrawer flow={flowWith(location, nodes)} onClose={() => undefined} {...props} />);
  });
  await flush();
  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text);
  if (!btn) throw new Error(`button "${text}" not found; have: ${[...container.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return btn as HTMLButtonElement;
}

async function click(btn: HTMLButtonElement): Promise<void> {
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  executeFlowMock.mockResolvedValue({ status: 'done', result: { echoed: true }, nodesExecuted: 1 });
  getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [] } });
});

it('runs on the explicitly selected remote computer without invoking the browser runner', async () => {
  getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [
    { desktopInstanceId: 'oaiy-home', deviceName: 'Home PC', lastSeenAt: new Date().toISOString() },
    { desktopInstanceId: 'oaiy-office', deviceName: 'Office PC', lastSeenAt: new Date().toISOString() },
  ] } });
  runFlowOnDesktopMock.mockResolvedValue({ ok: true, data: { status: 'done', result: 'remote' } });
  const container = await renderDrawer({}, 'desktop');
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = 'oaiy-office';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(buttonByText(container, 'Run via Desktop relay'));
  expect(runFlowOnDesktopMock).toHaveBeenCalledWith('flow-1', expect.objectContaining({ instanceId: 'oaiy-office' }));
  expect(executeFlowMock).not.toHaveBeenCalled();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = '';
});

describe('TestRunDrawer — run dispatch per executionLocation', () => {
  it('auto: the browser runner stays the primary action', async () => {
    const container = await renderDrawer({}, 'auto');
    const primary = buttonByText(container, 'Run in browser');
    await click(primary);
    await flush();
    expect(executeFlowMock).toHaveBeenCalledTimes(1);
    expect(runFlowCloudMock).not.toHaveBeenCalled();
    expect(runFlowOnDesktopMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Ran in this browser');
    expect(container.textContent).toContain('"echoed": true');
  });

  it('a flow without the field behaves exactly like auto', async () => {
    const container = await renderDrawer({}, null);
    expect(buttonByText(container, 'Run in browser')).toBeTruthy();
    expect(container.querySelector('[data-testid="run-location-badge"]')).toBeNull();
  });

  it('cloud: runs the cloud endpoint and renders the executed location', async () => {
    runFlowCloudMock.mockResolvedValue({
      data: { runId: 'run-1', status: 'done', result: { booked: true }, executionLocation: 'cloud', nodesExecuted: 3 },
      status: 200,
    });
    const container = await renderDrawer({}, 'cloud');
    await click(buttonByText(container, 'Run on FormLogic Cloud'));
    await flush();
    expect(runFlowCloudMock).toHaveBeenCalledWith('flow-1', {});
    expect(container.textContent).toContain('Ran on FormLogic Cloud');
    expect(container.textContent).toContain('"booked": true');
    expect(container.textContent).toContain('3 nodes executed');
  });

  it('cloud: flow_credits_exceeded surfaces upgrade copy, not a generic error', async () => {
    runFlowCloudMock.mockResolvedValue({
      error: 'Cloud flow run allowance exhausted',
      code: 'flow_credits_exceeded',
      status: 402,
    });
    const container = await renderDrawer({}, 'cloud');
    await click(buttonByText(container, 'Run on FormLogic Cloud'));
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('Out of Cloud run credits');
    expect(alert!.textContent).toContain('Upgrade your plan');
  });

  it('cloud: cloud_unsupported_node names the nodes and forwards the feedback', async () => {
    runFlowCloudMock.mockResolvedValue({
      error: 'Flow has nodes the cloud runner cannot execute',
      code: 'cloud_unsupported_node',
      status: 422,
      details: { nodes: ['logic_block', 'condition'] },
    });
    const feedback: CloudRunFeedback[] = [];
    const container = await renderDrawer({ onCloudRunFeedback: (_id: string, f: CloudRunFeedback) => feedback.push(f) }, 'cloud');
    await click(buttonByText(container, 'Run on FormLogic Cloud'));
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('logic_block, condition');
    expect(feedback).toEqual([{ kind: 'unsupported', nodes: ['logic_block', 'condition'] }]);
  });

  it('cloud: a missing cloud runner on the server reports unavailability to the editor', async () => {
    runFlowCloudMock.mockResolvedValue({ error: 'Not found', code: 'not_found', status: 404 });
    const feedback: CloudRunFeedback[] = [];
    const container = await renderDrawer({ onCloudRunFeedback: (_id: string, f: CloudRunFeedback) => feedback.push(f) }, 'cloud');
    await click(buttonByText(container, 'Run on FormLogic Cloud'));
    await flush();
    expect(feedback).toEqual([{ kind: 'unavailable', reason: 'this FormLogic server has no cloud runner' }]);
    expect(container.textContent).toContain('Cloud runs are not available on this FormLogic server yet.');
  });

  it('cloud: a successful run clears earlier warnings via the ok feedback', async () => {
    runFlowCloudMock.mockResolvedValue({
      data: { runId: 'run-2', status: 'done', result: null, executionLocation: 'cloud' },
      status: 200,
    });
    const feedback: CloudRunFeedback[] = [];
    const container = await renderDrawer({ onCloudRunFeedback: (_id: string, f: CloudRunFeedback) => feedback.push(f) }, 'cloud');
    await click(buttonByText(container, 'Run on FormLogic Cloud'));
    await flush();
    expect(feedback).toEqual([{ kind: 'ok' }]);
  });

  it('desktop: shows the queue position, node progress, and the sealed result', async () => {
    let finish: ((value: unknown) => void) | null = null;
    runFlowOnDesktopMock.mockImplementation((_flowId: string, opts: {
      onState?: (s: unknown) => void;
      onProgress?: (p: unknown) => void;
    }) => {
      opts.onState?.({ state: 'queued', position: 2 });
      opts.onProgress?.({ nodeId: 'list-1', status: 'running' });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const container = await renderDrawer({}, 'desktop');
    await click(buttonByText(container, 'Run via Desktop relay'));
    await flush();

    // Mid-flight: the queue position line and the live node timeline are visible.
    expect(container.textContent).toContain('Queued #2');
    expect(container.textContent).toContain('list-1');
    expect(container.querySelector('[data-testid="run-location-badge"]')).toBeNull();

    await act(async () => {
      runFlowOnDesktopMock.mock.calls[0][1].onState?.({ state: 'done' });
      finish!({ ok: true, data: { status: 'done', result: { sent: 1 } } });
    });
    await flush();
    expect(container.textContent).toContain('Ran on your Desktop');
    expect(container.textContent).toContain('"sent": 1');
    expect(container.textContent).not.toContain('Queued #2');
  });

  it('desktop: a typed relay refusal renders as a run error', async () => {
    runFlowOnDesktopMock.mockResolvedValue({
      ok: false,
      error: { code: 'desktop_offline', message: 'Desktop is offline' },
    });
    const container = await renderDrawer({}, 'desktop');
    await click(buttonByText(container, 'Run via Desktop relay'));
    await flush();
    expect(container.textContent).toContain('desktop_offline: Desktop is offline');
  });

  // formlogic-python/1: the Desktop that claims a relay run fetches the flow and runs it; one
  // built before Python would run `result = inputs["n"] // 2` as JavaScript (`// 2` is a
  // comment). The server refuses the enqueue (409 language_unsupported); the drawer says why
  // before the click instead.
  describe('desktop relay and Python code', () => {
    const PY_NODES = [
      { id: 'in', type: 'input' },
      { id: 'half', type: 'logic_block', data: { language: 'python', expr: 'result = inputs["n"] // 2' } },
    ];
    const now = () => new Date().toISOString();

    async function selectComputer(container: HTMLElement, id: string): Promise<void> {
      const select = container.querySelector('select')!;
      await act(async () => {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    it('is disabled, with the reason, when no online computer advertises Python', async () => {
      getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [
        { desktopInstanceId: 'oaiy-home', deviceName: 'Home PC', lastSeenAt: now(), capabilities: ['relay.flows'] },
      ] } });
      const container = await renderDrawer({}, 'desktop', PY_NODES);
      const relay = buttonByText(container, 'Run via Desktop relay');
      expect(relay.disabled).toBe(true);
      const note = container.querySelector('[data-testid="relay-language-note"]');
      expect(note?.textContent).toContain('Python');
      expect(note?.textContent).toContain('run it in the browser');
      await click(relay);
      expect(runFlowOnDesktopMock).not.toHaveBeenCalled();
      // The browser run stays available.
      expect(buttonByText(container, 'Run in browser').disabled).toBe(false);
    });

    it('is enabled once the target computer advertises logic-language:python', async () => {
      getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [
        { desktopInstanceId: 'oaiy-home', deviceName: 'Home PC', lastSeenAt: now(), capabilities: ['relay.flows', 'logic-language:python'] },
      ] } });
      runFlowOnDesktopMock.mockResolvedValue({ ok: true, data: { status: 'done', result: 2 } });
      const container = await renderDrawer({}, 'desktop', PY_NODES);
      const relay = buttonByText(container, 'Run via Desktop relay');
      expect(relay.disabled).toBe(false);
      expect(container.querySelector('[data-testid="relay-language-note"]')).toBeNull();
      await click(relay);
      await flush();
      expect(runFlowOnDesktopMock).toHaveBeenCalledTimes(1);
    });

    it('follows the explicitly selected computer', async () => {
      getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [
        { desktopInstanceId: 'oaiy-home', deviceName: 'Home PC', lastSeenAt: now(), capabilities: ['logic-language:python'] },
        { desktopInstanceId: 'oaiy-office', deviceName: 'Office PC', lastSeenAt: now(), capabilities: [] },
      ] } });
      const container = await renderDrawer({}, 'desktop', PY_NODES);
      expect(buttonByText(container, 'Run via Desktop relay').disabled).toBe(false);
      await selectComputer(container, 'oaiy-office');
      expect(buttonByText(container, 'Run via Desktop relay').disabled).toBe(true);
      expect(container.querySelector('[data-testid="relay-language-note"]')?.textContent).toContain('Office PC');
      await selectComputer(container, 'oaiy-home');
      expect(buttonByText(container, 'Run via Desktop relay').disabled).toBe(false);
    });

    it('sees Python that a package preset lowers to, through the server compile', async () => {
      getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [
        { desktopInstanceId: 'oaiy-home', deviceName: 'Home PC', lastSeenAt: now(), capabilities: [] },
      ] } });
      compileFlowMock.mockResolvedValue({ data: { ok: true, ir: {
        nodes: [{ id: 'in', type: 'input' }, { id: 'h', type: 'logic_block', data: { language: 'python', expr: '1' } }],
        edges: [],
      } } });
      const container = await renderDrawer({}, 'desktop', [{ id: 'in', type: 'input' }, { id: 'h', type: 'com.acme.py.halve', data: {} }]);
      expect(compileFlowMock).toHaveBeenCalledWith('flow-1');
      expect(buttonByText(container, 'Run via Desktop relay').disabled).toBe(true);
    });

    it('leaves JavaScript flows alone', async () => {
      getDesktopConnectionsMock.mockResolvedValue({ data: { connections: [
        { desktopInstanceId: 'oaiy-home', deviceName: 'Home PC', lastSeenAt: now(), capabilities: [] },
      ] } });
      const container = await renderDrawer({}, 'desktop', [{ id: 'l', type: 'logic_block', data: { expr: 'inputs.n / 2' } }]);
      expect(buttonByText(container, 'Run via Desktop relay').disabled).toBe(false);
      expect(container.querySelector('[data-testid="relay-language-note"]')).toBeNull();
      expect(compileFlowMock).not.toHaveBeenCalled();
    });
  });

  it('desktop and cloud flows still offer a browser run as the secondary action', async () => {
    const desktopContainer = await renderDrawer({}, 'desktop');
    buttonByText(desktopContainer, 'Run in browser');
    await act(async () => {
      root!.unmount();
    });
    root = null;
    document.body.innerHTML = '';
    const cloudContainer = await renderDrawer({}, 'cloud');
    buttonByText(cloudContainer, 'Run in browser');
  });
});
