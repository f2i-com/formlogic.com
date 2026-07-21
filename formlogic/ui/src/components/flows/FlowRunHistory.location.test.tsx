// @vitest-environment jsdom
// The run-history Location column (plan §5.7): every row shows the as-executed location
// (browser / desktop / cloud) and '—' when the row predates the column.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listMyFlowRunsMock } = vi.hoisted(() => ({
  listMyFlowRunsMock: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    api: {
      isDemoMode: () => false,
      listMyFlowRuns: (...args: unknown[]) => listMyFlowRunsMock(...args),
    },
  };
});

import { FlowRunHistory } from './FlowRunHistory';
import type { FlowRunLog } from '../../types/flows';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function run(overrides: Partial<FlowRunLog> & { executionLocation?: string | null }): FlowRunLog & { executionLocation?: string | null } {
  return {
    runId: 'run-1',
    appId: null,
    formId: null,
    responseId: null,
    bindingId: 'b1',
    flowDefinitionId: null,
    flow: 'echo',
    triggerEvent: 'form.submitted',
    correlationId: 'c1',
    idempotencyKey: 'k1',
    status: 'done',
    runtime: null,
    claimedBy: null,
    inputSnapshot: null,
    result: null,
    outputActions: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-07-09T00:00:00Z',
    ...overrides,
  };
}

async function renderHistory(runs: Array<FlowRunLog & { executionLocation?: string | null }>): Promise<HTMLElement> {
  listMyFlowRunsMock.mockResolvedValue({
    data: { runs, page: 1, offset: 0, limit: 25, total: runs.length },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FlowRunHistory flowId="flow-1" />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('FlowRunHistory — Location column (plan §5.7)', () => {
  it('renders the Location header and each run\'s as-executed location', async () => {
    const container = await renderHistory([
      run({ runId: 'r1', executionLocation: 'cloud', triggerEvent: 'test.cloud' }),
      run({ runId: 'r2', executionLocation: 'desktop', triggerEvent: 'test.desktop' }),
      run({ runId: 'r3', executionLocation: 'browser', triggerEvent: 'test.browser' }),
      run({ runId: 'r4', executionLocation: null, triggerEvent: 'test.legacy' }),
    ]);
    const header = [...container.querySelectorAll('th')].map((th) => th.textContent);
    expect(header).toContain('Location');

    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.length).toBe(4);
    const locationCells = rows.map((tr) => tr.querySelectorAll('td')[2]?.textContent);
    expect(locationCells).toEqual(['cloud', 'desktop', 'browser', '—']);
  });

  it('a run without the field (absent, not null) also renders —', async () => {
    const legacy = run({ runId: 'r5', triggerEvent: 'test.absent' });
    delete legacy.executionLocation;
    const container = await renderHistory([legacy]);
    const cell = container.querySelector('tbody tr')?.querySelectorAll('td')[2];
    expect(cell?.textContent).toBe('—');
  });
});
