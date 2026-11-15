// @vitest-environment jsdom
// The diagram canvas around React Flow: what it sends to the gateway and where the focus goes.
// React Flow itself is a stand-in here (it measures and drags with a real layout, which jsdom does
// not have): it draws each card as React Flow does (.react-flow__node, data-id, focusable), hands
// the canvas the same callbacks, and moves the selected cards on an arrow key as React Flow does.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import type { Blueprint, BlueprintElement, BlueprintOperation } from '../../types/blueprints';
import { useToastStore } from '../../stores/toastStore';
import { DiagramCanvas } from './DiagramCanvas';

type FlowProps = {
  nodes: Node[];
  edges: Edge[];
  nodeTypes: Record<string, React.ComponentType<Record<string, unknown>>>;
  onNodesChange: (changes: NodeChange[]) => void;
  onSelectionChange: (selection: { nodes: Node[]; edges: Edge[] }) => void;
  onDoubleClick: (event: React.MouseEvent) => void;
};

const flow = vi.hoisted(() => ({ props: null as unknown as FlowProps }));
const h = vi.hoisted(() => ({
  commitBlueprintOperations: vi.fn(),
  listBlueprintChangeSets: vi.fn(),
  undoBlueprint: vi.fn(),
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const nodes = () => flow.props?.nodes ?? [];
  const reactFlow = {
    getNodes: () => nodes(),
    getNode: (id: string) => nodes().find((node) => node.id === id),
    getInternalNode: (id: string) => {
      const node = nodes().find((candidate) => candidate.id === id);
      return node ? { internals: { positionAbsolute: node.position } } : undefined;
    },
    screenToFlowPosition: (point: { x: number; y: number }) => point,
    setCenter: async () => true,
    getZoom: () => 1,
    fitView: async () => true,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport: async () => true,
  };
  const STEPS: Record<string, [number, number]> = { ArrowRight: [5, 0], ArrowLeft: [-5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
  function FakeFlow(props: FlowProps) {
    flow.props = props;
    return (
      <div className="react-flow">
        <div className="react-flow__pane" onDoubleClick={props.onDoubleClick} />
        {props.nodes.map((node) => {
          const Card = props.nodeTypes[node.type ?? 'blueprint'];
          return (
            <div
              key={node.id}
              className="react-flow__node"
              data-id={node.id}
              tabIndex={0}
              onKeyDown={(event) => {
                const step = STEPS[event.key];
                if (!step || !node.selected) return;
                props.onNodesChange(props.nodes.filter((each) => each.selected).map((each) => ({
                  id: each.id, type: 'position' as const, position: { x: each.position.x + step[0], y: each.position.y + step[1] }, dragging: false,
                })));
              }}
            >
              <Card id={node.id} data={node.data} selected={Boolean(node.selected)} />
            </div>
          );
        })}
        {props.edges.map((edge) => <div key={edge.id} className="react-flow__edge" data-id={edge.id} tabIndex={0} />)}
      </div>
    );
  }
  return {
    ...actual,
    ReactFlow: FakeFlow,
    useReactFlow: () => reactFlow,
    useConnection: () => null,
    Handle: () => null,
    NodeResizer: () => null,
    Background: () => null,
    Controls: () => null,
  };
});

vi.mock('../../lib/api', () => ({ api: h }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onReload = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  h.listBlueprintChangeSets.mockResolvedValue({ data: { changeSets: [] } });
  h.commitBlueprintOperations.mockResolvedValue({ data: { changeSetId: 'cs', semanticRevision: 2, layoutRevision: 2 } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useToastStore.getState().clearToasts();
});

const card = (id: string, elementType: string, properties: Record<string, unknown>, layout = { x: 100, y: 100 }): BlueprintElement =>
  ({ id, elementType, resourceRef: null, properties, layout }) as BlueprintElement;

const diagram = (elements: BlueprintElement[], semanticRevision = 1): Blueprint => ({
  id: 'bp-1', appId: null, name: 'Sketch', status: 'draft', semanticRevision, layoutRevision: 1,
  viewport: null, createdAt: '', updatedAt: '', elements,
});

async function show(blueprint: Blueprint) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DiagramCanvas blueprint={blueprint} onReload={onReload} onRevisions={() => undefined} />
      </MemoryRouter>,
    );
  });
}

/** Selects these cards as React Flow does: their `selected` changes, then the selection is told. */
async function select(...ids: string[]) {
  await act(async () => {
    flow.props.onNodesChange(ids.map((id) => ({ id, type: 'select' as const, selected: true })));
  });
  await act(async () => {
    flow.props.onSelectionChange({ nodes: flow.props.nodes.filter((node) => ids.includes(node.id)), edges: [] });
  });
}

const cardElement = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const panel = () => container.querySelector<HTMLElement>('[data-selection-panel]');
const panelButton = (name: string) => [...(panel()?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim().startsWith(name) || button.getAttribute('aria-label') === name);
/** The operations of each batch sent to the gateway, in order. */
const sent = () => h.commitBlueprintOperations.mock.calls.map((call) => (call[1] as { operations: BlueprintOperation[] }).operations);
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

describe('DiagramCanvas', () => {
  it("the panel's Delete deletes the one element it shows, not everything selected with it", async () => {
    await show(diagram([
      card('el-flow', 'flow', { title: 'Send reminder' }),
      card('el-desk', 'actor', { title: 'Front desk' }, { x: 500, y: 100 }),
      card('el-manager', 'actor', { title: 'Manager' }, { x: 300, y: 400 }),
      card('el-line', 'edge', { edgeType: 'triggers', sourceId: 'el-desk', targetId: 'el-flow', state: 'concept' }),
    ]));
    await select('el-flow', 'el-desk');
    expect(panel()?.textContent).toContain('Flow');

    await act(async () => panelButton('Delete element')!.click());
    await settle();

    expect(sent()).toHaveLength(1);
    expect(sent()[0].map((op) => `${op.type} ${op.targetId}`)).toEqual([
      'blueprint.element.delete el-line',
      'blueprint.element.delete el-flow',
    ]);
  });

  it('puts two forms asked for at once (two quick double-clicks) side by side, not one on the other', async () => {
    let land: (value: unknown) => void = () => undefined;
    h.commitBlueprintOperations.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    await show(diagram([]));
    const pane = container.querySelector('.react-flow__pane')!;
    const doubleClick = () => act(async () => {
      pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 300, clientY: 400 }));
    });
    await doubleClick();
    await doubleClick(); // before the first form has come back
    await act(async () => land({ data: { changeSetId: 'cs', semanticRevision: 2, layoutRevision: 2 } }));
    await settle();

    const places = sent().map((ops) => ops[0].layout);
    expect(places).toHaveLength(2);
    expect(places[1]).not.toEqual(places[0]);
    // Not overlapping: the second form's box (200 x 64) keeps clear of the first.
    const [a, b] = places as Array<{ x: number; y: number }>;
    expect(Math.abs(a.x - b.x) >= 200 || Math.abs(a.y - b.y) >= 64).toBe(true);
  });

  it('gives the focus back to the card when its panel is closed from the keyboard', async () => {
    await show(diagram([card('el-rooms', 'form', { title: 'Rooms', fields: [] })]));

    await select('el-rooms');
    const close = panelButton('Close the panel')!;
    close.focus();
    await act(async () => close.click()); // Enter on a button is a click
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(cardElement('el-rooms'));

    await select('el-rooms');
    const save = panelButton('Save')!;
    save.focus();
    await act(async () => { save.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(cardElement('el-rooms'));
  });

  it('saves a card moved with the arrow keys, once, when the keys stop', async () => {
    await show(diagram([card('el-rooms', 'form', { title: 'Rooms', fields: [] }, { x: 120, y: 120 })]));
    await select('el-rooms');
    const rooms = cardElement('el-rooms');
    rooms.focus();
    for (let press = 0; press < 4; press++) {
      await act(async () => { rooms.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    }
    expect(sent()).toHaveLength(0);
    await act(async () => { await new Promise((done) => setTimeout(done, 600)); });

    expect(sent()).toEqual([[expect.objectContaining({ type: 'blueprint.layout.set', targetId: 'el-rooms', layout: { x: 140, y: 120 } })]]);
    // A layout batch: no semantic precondition, so it cannot conflict.
    expect(h.commitBlueprintOperations.mock.calls[0][1]).not.toHaveProperty('baseSemanticRevision');
  });

  it("says the diagram changed elsewhere when the gateway refuses with revision_conflict (its code beside the message)", async () => {
    h.commitBlueprintOperations.mockResolvedValueOnce({ error: 'The blueprint changed since you loaded it — reload and retry', status: 409, code: 'revision_conflict' });
    await show(diagram([card('el-orders', 'form', { title: 'Orders', fields: [] })]));
    await select('el-orders');
    await act(async () => panelButton('Save')!.click());
    await settle();

    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((each) => each.title)).toContain('Blueprint changed elsewhere');
    expect(onReload).toHaveBeenCalled();
  });

  it('shows the fields as the diagram now holds them in the panel left open across a reload', async () => {
    const orders = (fields: Array<{ name: string; type: string }>) => card('el-orders', 'form', { title: 'Orders', fields });
    await show(diagram([orders([{ name: 'customer', type: 'short_text' }])]));
    await select('el-orders');
    // A field typed on the card comes back with the diagram; the panel stays open.
    await show(diagram([orders([{ name: 'customer', type: 'short_text' }, { name: 'total', type: 'short_text' }])], 2));
    const names = [...(panel()?.querySelectorAll<HTMLInputElement>('input[aria-label^="Field name"]') ?? [])].map((input) => input.value);
    expect(names).toEqual(['customer', 'total']);

    await act(async () => panelButton('Save')!.click());
    await settle();
    expect(sent()[0][0].properties).toMatchObject({ fields: [{ name: 'customer', type: 'short_text' }, { name: 'total', type: 'short_text' }] });
  });
});
