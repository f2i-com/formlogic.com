// @vitest-environment jsdom
// Duplicating a flow. The library card is a stub that hands over its onDuplicate: the slug
// handling and the server's refusal live here, not in the card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { FlowDefinition } from '../../types/flows';
import { FlowsWorkspace } from './FlowsWorkspace';

const h = vi.hoisted(() => ({ duplicate: null as ((flow: FlowDefinition) => Promise<void>) | null }));

vi.mock('../../components/flows/FlowsOverview', () => ({
  FlowsOverview: ({ onDuplicate }: { onDuplicate: (flow: FlowDefinition) => Promise<void> }) => {
    h.duplicate = onDuplicate;
    return null;
  },
}));
vi.mock('../../components/flows/editor/FlowEditor', () => ({ FlowEditor: () => null }));
vi.mock('../../components/flows/NewFlowDialog', () => ({ NewFlowDialog: () => null }));
vi.mock('../../components/flows/useFlowsDesktopPresence', () => ({ useFlowsDesktopPresence: () => ({}) }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const flow = (slug: string, name = slug) =>
  ({ id: slug, slug, name, description: null, appId: null, flowJson: { nodes: [], edges: [] }, nodeCapabilities: [] }) as unknown as FlowDefinition;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function renderWorkspace(flows: FlowDefinition[]) {
  vi.spyOn(api, 'listWorkspaceFlows').mockResolvedValue({ data: { flows } } as never);
  vi.spyOn(api, 'getApps').mockResolvedValue({ data: { apps: [] } } as never);
  vi.spyOn(api, 'getForms').mockResolvedValue({ data: { forms: [] } } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MemoryRouter initialEntries={['/flows?view=existing']}><FlowsWorkspace /></MemoryRouter>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  h.duplicate = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks();
});

describe('duplicating a flow', () => {
  it('picks a free slug when a copy already exists, as creating a flow does', async () => {
    const create = vi.spyOn(api, 'createWorkspaceFlow').mockImplementation(async (body) => ({ data: { flow: flow(body.slug!, body.name) } }) as never);
    await renderWorkspace([flow('greet', 'Greet'), flow('greet-copy', 'Greet copy')]);

    await act(async () => h.duplicate!(flow('greet', 'Greet')));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'greet-copy-2', name: 'Greet copy 2' }));
  });

  it('keeps the plain copy name the first time', async () => {
    const create = vi.spyOn(api, 'createWorkspaceFlow').mockImplementation(async (body) => ({ data: { flow: flow(body.slug!, body.name) } }) as never);
    await renderWorkspace([flow('greet', 'Greet')]);

    await act(async () => h.duplicate!(flow('greet', 'Greet')));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'greet-copy', name: 'Greet copy' }));
  });

  it("shows the server's reason when the copy is refused", async () => {
    vi.spyOn(api, 'createWorkspaceFlow').mockResolvedValue({ error: 'Flow limit reached' } as never);
    await renderWorkspace([flow('greet', 'Greet')]);

    await act(async () => h.duplicate!(flow('greet', 'Greet')));

    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ title: 'Failed to duplicate flow', message: 'Flow limit reached' })]);
  });
});
