// @vitest-environment jsdom
// A read that failed is not an empty list: the dock said "No flows in this scope yet" for an app
// it could not read, and counted that app's triggers as none.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listFlows: vi.fn(),
  listFlowBindings: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    isDemoMode: () => false,
    listWorkspaceFlows: async () => ({ data: { flows: [] } }),
    listFormFlowBindings: async () => ({ data: { bindings: [] } }),
    getFormAppContexts: async () => ({ data: { contexts: [{ appId: 'a1', appName: 'Shop', isPublished: true }] } }),
    listFlows: h.listFlows,
    listFlowBindings: h.listFlowBindings,
    listMyFlowRuns: async () => ({ data: { runs: [] } }),
  },
}));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: h.toastError, info: vi.fn(), warning: vi.fn() } }));

import { FormFlowsPanel } from './FormFlowsPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let onCountChange: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  onCountChange = vi.fn();
  h.listFlows.mockResolvedValue({ data: { flows: [] } });
  h.listFlowBindings.mockResolvedValue({ data: { bindings: [] } });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MemoryRouter><FormFlowsPanel formId="f1" formTitle="F" fields={[]} onClose={() => {}} onCountChange={onCountChange as never} /></MemoryRouter>);
  });
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

describe('an app section that could not be read', () => {
  it.each([
    ['its flows', () => h.listFlows.mockResolvedValue({ error: 'Server unavailable', status: 503 })],
    ['its bindings', () => h.listFlowBindings.mockResolvedValue({ error: 'Server unavailable', status: 503 })],
  ])('says so when %s failed, and leaves the trigger count alone', async (_what, fail) => {
    fail();
    await render();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not load this app');
    expect(h.toastError).toHaveBeenCalled();
    expect(onCountChange).not.toHaveBeenCalled();
    // The workspace section was read, and it is empty.
    expect(document.body.textContent?.match(/No flows in this scope yet/g)).toHaveLength(1);
  });

  it('can be tried again', async () => {
    h.listFlows.mockResolvedValueOnce({ error: 'Server unavailable', status: 503 });
    await render();

    const retry = Array.from(document.body.querySelectorAll('[role="alert"] button')).find((b) => b.textContent?.trim() === 'Try again') as HTMLButtonElement;
    await act(async () => retry.click());
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(onCountChange).toHaveBeenCalledWith(0);
  });
});

it('counts as ever when everything was read', async () => {
  await render();
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(onCountChange).toHaveBeenCalledWith(0);
  expect(document.body.textContent?.match(/No flows in this scope yet/g)).toHaveLength(2);
});
