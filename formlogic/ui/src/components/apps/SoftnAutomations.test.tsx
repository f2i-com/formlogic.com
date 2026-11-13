// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App } from '../../types/app';

const mocks = vi.hoisted(() => ({ listFlows: vi.fn(), listFlowBindings: vi.fn(), step: null as null | Record<string, unknown> }));
vi.mock('../../lib/api', () => ({ api: { listFlows: mocks.listFlows, listFlowBindings: mocks.listFlowBindings } }));
vi.mock('../studio/steps/AutomationsStep', () => ({
  AutomationsStep: (props: Record<string, unknown>) => { mocks.step = props; return <p data-testid="step">{(props.flows as unknown[]).length} flows</p>; },
}));
const { SoftnAutomations } = await import('./SoftnAutomations');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const app = { id: 'app-1', name: 'Recipes', slug: 'recipes' } as App;
const flow = { id: 'f1', name: 'Welcome', slug: 'welcome', enabled: true };

beforeEach(() => {
  mocks.listFlows.mockReset(); mocks.listFlowBindings.mockReset(); mocks.step = null;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const mount = async () => { await act(async () => root.render(<SoftnAutomations app={app} />)); await act(async () => {}); };

it('shows the app’s flows and what starts them, and sends the flow editor back to this section', async () => {
  mocks.listFlows.mockResolvedValue({ data: { flows: [flow] } });
  mocks.listFlowBindings.mockResolvedValue({ data: { bindings: [{ id: 'b1', flowDefinitionId: 'f1' }] } });
  await mount();
  expect(mocks.listFlows).toHaveBeenCalledWith('app-1');
  expect(container.querySelector('[data-testid="step"]')!.textContent).toBe('1 flows');
  expect(mocks.step).toMatchObject({ app, flows: [flow], bindings: [{ id: 'b1', flowDefinitionId: 'f1' }], returnTo: { path: '/apps/app-1/softn/automations', label: 'Recipes' } });
  // A SoftN app's automations start from its own tables: no forms are handed over.
  expect(mocks.step!.appForms).toEqual([]);
});

it('says a failed read failed instead of "no automations yet", and tries again when asked', async () => {
  mocks.listFlows.mockResolvedValue({ error: 'Server error', status: 500 });
  mocks.listFlowBindings.mockResolvedValue({ data: { bindings: [] } });
  await mount();
  expect(container.querySelector('[data-testid="step"]')).toBeNull();
  expect(container.textContent).toContain('The app’s automations could not be loaded');
  mocks.listFlows.mockResolvedValue({ data: { flows: [] } });
  const retry = [...container.querySelectorAll('button')].find(node => /Try again/.test(node.textContent ?? ''))!;
  await act(async () => retry.click());
  await act(async () => {});
  expect(container.querySelector('[data-testid="step"]')!.textContent).toBe('0 flows');
});

it('keeps what is shown when a later read fails', async () => {
  mocks.listFlows.mockResolvedValue({ data: { flows: [flow] } });
  mocks.listFlowBindings.mockResolvedValue({ data: { bindings: [] } });
  await mount();
  mocks.listFlows.mockResolvedValue({ error: 'Server error', status: 500 });
  await act(async () => { await (mocks.step!.onReloadFlows as () => Promise<void>)(); });
  expect(container.querySelector('[data-testid="step"]')!.textContent).toBe('1 flows');
  mocks.listFlows.mockResolvedValue({ data: { flows: [flow, { ...flow, id: 'f2' }] } });
  await act(async () => { await (mocks.step!.onReloadFlows as () => Promise<void>)(); });
  expect(container.querySelector('[data-testid="step"]')!.textContent).toBe('2 flows');
});
