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

const { runFlowCloudMock, runFlowOnDesktopMock, executeFlowMock } = vi.hoisted(() => ({
  runFlowCloudMock: vi.fn(),
  runFlowOnDesktopMock: vi.fn(),
  executeFlowMock: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    api: {
      isDemoMode: () => false,
      runFlowCloud: (...args: unknown[]) => runFlowCloudMock(...args),
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
import type { FlowDefinition } from '../../types/flows';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function flowWith(location: string | null): FlowDefinition {
  return {
    id: 'flow-1',
    ownerUserId: 'u1',
    appId: null,
    name: 'Echo flow',
    slug: 'echo',
    description: null,
    engine: 'f2i',
    flowJson: {
      nodes: [{ id: 'list-1', type: 'formlogic_list_responses' }],
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

async function renderDrawer(props: Record<string, unknown> = {}, location: string | null = 'auto'): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TestRunDrawer flow={flowWith(location)} onClose={() => undefined} {...props} />);
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
    await click(buttonByText(container, 'Run on Desktop'));
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
    await click(buttonByText(container, 'Run on Desktop'));
    await flush();
    expect(container.textContent).toContain('desktop_offline: Desktop is offline');
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
