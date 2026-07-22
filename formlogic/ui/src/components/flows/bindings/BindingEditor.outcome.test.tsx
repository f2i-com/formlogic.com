// @vitest-environment jsdom
// §9.1 "Another Flow" trigger editor: for flow.* outcome events the BindingEditor shows a
// source-flow picker that MANAGES the condition expression (the claim-time enforcement
// surface), warns on self-handling and on manual mode, and leaves hand-written custom
// conditions alone. Non-outcome events must not grow the picker.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingEditor } from './BindingEditor';
import type { FlowBinding, FlowDefinition } from '../../../types/flows';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function flowDef(overrides: Partial<FlowDefinition>): FlowDefinition {
  return {
    id: 'flow-a',
    ownerUserId: 'owner-1',
    appId: 'app-1',
    name: 'Flow A',
    slug: 'flow-a',
    description: null,
    engine: 'formlogic@1',
    flowJson: { nodes: [], edges: [] },
    inputSchema: null,
    outputSchema: null,
    nodeCapabilities: null,
    version: 1,
    enabled: true,
    createdAt: '2026-07-23T00:00:00Z',
    updatedAt: '2026-07-23T00:00:00Z',
    ...overrides,
  };
}

function binding(overrides: Partial<FlowBinding>): FlowBinding {
  return {
    id: 'binding-1',
    appId: 'app-1',
    formId: null,
    connectorId: null,
    flowDefinitionId: 'flow-a',
    flow: 'flow-a',
    event: 'flow.failed',
    mode: 'async',
    condition: null,
    inputMap: null,
    outputActions: null,
    timeoutMs: 30000,
    retryPolicy: null,
    fallbackPolicy: null,
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-07-23T00:00:00Z',
    updatedAt: '2026-07-23T00:00:00Z',
    ...overrides,
  };
}

const handlerFlow = flowDef({ id: 'flow-a', slug: 'flow-a', name: 'Flow A' });
const sourceFlow = flowDef({ id: 'flow-b', slug: 'flow-b', name: 'Flow B' });

function render(b: FlowBinding) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <BindingEditor
        binding={b}
        flows={[handlerFlow]}
        sourceFlows={[handlerFlow, sourceFlow]}
        lockFlow
        onSave={async () => null}
        onSaved={() => undefined}
        onDelete={() => undefined}
      />,
    );
  });
}

function sourcePicker(): HTMLSelectElement | null {
  return host?.querySelector<HTMLSelectElement>('select[aria-label="Outcome source flow"]') ?? null;
}

function conditionInput(): HTMLInputElement {
  const el = host?.querySelector<HTMLInputElement>('input[aria-label="Binding condition expression"]');
  if (!el) throw new Error('condition input not rendered');
  return el;
}

function setPicker(value: string) {
  const select = sourcePicker();
  if (!select) throw new Error('source picker not rendered');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('BindingEditor outcome-trigger UX (§9.1)', () => {
  it('shows the source-flow picker only for flow.* outcome events', () => {
    render(binding({ event: 'form.submitted' }));
    expect(sourcePicker()).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    render(binding({ event: 'flow.failed' }));
    const select = sourcePicker();
    expect(select).not.toBeNull();
    expect(select?.value).toBe('');
    const labels = [...(select?.options ?? [])].map((option) => option.textContent);
    expect(labels).toContain('Any flow in this app');
    expect(labels).toContain('Flow B (flow-b)');
    expect(host?.textContent).toContain('at most once per run tree');
  });

  it('writes and clears the managed condition through the picker', () => {
    render(binding({ event: 'flow.failed' }));
    setPicker('flow-b');
    expect(conditionInput().value).toBe("event.data.flowId === 'flow-b'");
    setPicker('');
    expect(conditionInput().value).toBe('');
  });

  it('selects the source flow parsed from an existing managed condition and warns on self-handling', () => {
    render(binding({ event: 'flow.failed', condition: { type: 'expression', expr: "event.data.flowId === 'flow-a'" } }));
    expect(sourcePicker()?.value).toBe('flow-a');
    expect(host?.textContent).toContain('This flow handles its own outcome');
  });

  it('shows custom conditions as Custom and never rewrites them', () => {
    const expr = "event.data.flowId === 'flow-b' && event.data.depth > 1";
    render(binding({ event: 'flow.failed', condition: { type: 'expression', expr } }));
    expect(sourcePicker()?.value).toBe('__custom__');
    expect(conditionInput().value).toBe(expr);
  });

  it('warns that manual-mode bindings never receive outcome events', () => {
    render(binding({ event: 'flow.succeeded', mode: 'manual' }));
    expect(host?.textContent).toContain('Manual-mode bindings never receive outcome events');
  });

  it('surfaces a managed condition pointing at a flow missing from the source list', () => {
    render(binding({ event: 'flow.failed', condition: { type: 'expression', expr: "event.data.flowId === 'flow-gone'" } }));
    const select = sourcePicker();
    expect(select?.value).toBe('flow-gone');
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toContain('Missing flow (flow-gon...)');
  });

  it('renders flow.* payload chips instead of the generic event hints', () => {
    render(binding({ event: 'flow.failed' }));
    expect(host?.textContent).toContain('$event.data.error.code');
    expect(host?.textContent).not.toContain('$event.data.callerPhone');
  });
});
