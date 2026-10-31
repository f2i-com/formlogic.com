// @vitest-environment jsdom
// Leaving the editor: what happens to edits autosave has not sent yet. The canvas is a stub
// that moves a node, which is enough to make the graph dirty without React Flow's measuring.
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import { FlowEditor } from './FlowEditor';
import { useInstalledNodeStore } from '../../../stores/installedNodeStore';
import { useToastStore } from '../../../stores/toastStore';
import type { FlowDefinition } from '../../../types/flows';

const h = vi.hoisted(() => ({ moves: 0 }));

vi.mock('./FlowCanvas', () => ({
  FlowCanvas: ({ nodes, onNodesChange }: { nodes: Array<{ position: { x: number } }>; onNodesChange: (changes: NodeChange[]) => void }) => (
    <button
      type="button"
      data-testid="edit"
      data-x={nodes[0]?.position.x}
      onClick={() => onNodesChange([{ id: 'n1', type: 'position', position: { x: 100 + 10 * ++h.moves, y: 40 } }])}
    >
      Edit
    </button>
  ),
}));
vi.mock('../../../hooks/useServiceCatalog', () => ({ fetchServiceCatalogOnce: async () => null }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// A new id per test: saves from a closed editor are kept by flow id, outside any component.
let flowNumber = 0;
let flow: FlowDefinition;

type SavePatch = Parameters<ComponentProps<typeof FlowEditor>['onSave']>[0];

let root: Root | null = null;
let host: HTMLElement | null = null;
const realRefresh = useInstalledNodeStore.getState().refresh;
const onBack = vi.fn();

async function renderEditor(onSave: (patch: SavePatch) => Promise<boolean>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <FlowEditor flow={flow} onBack={onBack} onSave={onSave} onOpenTestRun={() => {}} onToggleHistory={() => {}} historyOpen={false} />,
    );
  });
}

const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const edit = () => click(host!.querySelector('[data-testid="edit"]'));
const back = () => click(host!.querySelector('[aria-label="Back to flows"]'));
const buttonNamed = (name: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === name);
const shownX = () => Number(host!.querySelector('[data-testid="edit"]')!.getAttribute('data-x'));
const sentX = (patch: SavePatch) => patch.flowJson.nodes[0].position!.x;
const pastAutosave = () => act(async () => { await vi.advanceTimersByTimeAsync(1400); });

function closeEditor() {
  act(() => root!.unmount());
  root = null;
  host!.remove();
}

beforeEach(() => {
  vi.useFakeTimers();
  onBack.mockReset();
  flowNumber += 1;
  flow = {
    id: `f${flowNumber}`, slug: 'f', name: 'Flow', appId: null,
    flowJson: { nodes: [{ id: 'n1', type: 'input', position: { x: 0, y: 0 }, data: {} }], edges: [] },
  } as unknown as FlowDefinition;
  useInstalledNodeStore.setState({ loaded: true, refresh: async () => undefined });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useInstalledNodeStore.setState({ refresh: realRefresh });
  useToastStore.getState().clearToasts();
  vi.useRealTimers();
});

describe('reopening a flow whose save is still on its way', () => {
  function slowSaves() {
    const answers: Array<(landed: boolean) => void> = [];
    const onSave = vi.fn<(patch: SavePatch) => Promise<boolean>>(() => new Promise((resolve) => { answers.push(resolve); }));
    return { onSave, answers };
  }

  it('starts from the graph being saved, not the old copy of the flow', async () => {
    const { onSave } = slowSaves();
    await renderEditor(onSave);
    await edit();
    const edited = shownX();
    closeEditor();

    await renderEditor(onSave); // the workspace still holds the old flowJson

    expect(edited).toBeGreaterThan(0);
    expect(shownX()).toBe(edited);
  });

  it('has nothing left to save once that save lands', async () => {
    const { onSave, answers } = slowSaves();
    await renderEditor(onSave);
    await edit();
    closeEditor();
    await renderEditor(onSave);

    await act(async () => answers[0](true));
    await pastAutosave();

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('builds the next edit on that graph, and sends it only after that save answers', async () => {
    const { onSave, answers } = slowSaves();
    await renderEditor(onSave);
    await edit();
    const flushed = shownX();
    closeEditor();
    await renderEditor(onSave);

    await edit();
    const newer = shownX();
    await pastAutosave();
    expect(onSave).toHaveBeenCalledTimes(1); // the older graph must not land last

    await act(async () => answers[0](true));

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(sentX(onSave.mock.calls[0][0])).toBe(flushed);
    expect(sentX(onSave.mock.calls[1][0])).toBe(newer);
  });

  it('marks the graph unsaved and tries again when that save fails', async () => {
    const { onSave, answers } = slowSaves();
    await renderEditor(onSave);
    await edit();
    const edited = shownX();
    closeEditor();
    await renderEditor(onSave);

    await act(async () => answers[0](false));
    await pastAutosave();

    expect(shownX()).toBe(edited);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(sentX(onSave.mock.calls[1][0])).toBe(edited);
  });

  it('also covers an autosave that was running when the editor closed', async () => {
    const { onSave, answers } = slowSaves();
    await renderEditor(onSave);
    await edit();
    const edited = shownX();
    await pastAutosave();
    closeEditor();

    await renderEditor(onSave);

    expect(shownX()).toBe(edited);
    await act(async () => answers[0](true));
    await pastAutosave();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest of two closed editors in order', async () => {
    const { onSave, answers } = slowSaves();
    await renderEditor(onSave);
    await edit();
    closeEditor();
    await renderEditor(onSave);
    await edit();
    const newest = shownX();
    closeEditor();

    await renderEditor(onSave);

    expect(shownX()).toBe(newest);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => answers[0](true));
    expect(sentX(onSave.mock.calls[1][0])).toBe(newest);
  });

  it('goes back to the flow it is given once the save has answered', async () => {
    const { onSave, answers } = slowSaves();
    await renderEditor(onSave);
    await edit();
    closeEditor();
    await act(async () => answers[0](true));

    await renderEditor(onSave);

    expect(shownX()).toBe(0);
  });
});

describe('leaving the flow editor', () => {
  it('saves edits the debounce was still holding when the editor unmounts', async () => {
    const onSave = vi.fn(async () => true);
    await renderEditor(onSave);
    await edit();
    expect(onSave).not.toHaveBeenCalled();

    act(() => root!.unmount());
    root = null;

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]).toMatchObject([{ nodeCapabilities: expect.any(Array) }]);
    expect((onSave.mock.calls[0] as unknown as [SavePatch])[0].flowJson.nodes[0].position!.y).toBe(40);
  });

  it('sends nothing on unmount when nothing changed', async () => {
    const onSave = vi.fn(async () => true);
    await renderEditor(onSave);
    act(() => root!.unmount());
    root = null;
    expect(onSave).not.toHaveBeenCalled();
  });

  it('waits for a running save, then sends newer edits, so the older graph cannot land last', async () => {
    const order: string[] = [];
    let finishFirst: (ok: boolean) => void = () => undefined;
    const onSave = vi.fn((patch: SavePatch) => {
      order.push(`start ${patch.flowJson.nodes[0].position!.x}`);
      return onSave.mock.calls.length === 1 ? new Promise<boolean>((resolve) => { finishFirst = resolve; }) : Promise.resolve(true);
    });
    await renderEditor(onSave);
    await edit();
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); }); // autosave starts
    await edit(); // newer than what is on its way

    act(() => root!.unmount());
    root = null;
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => finishFirst(true));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(order[1]).not.toBe(order[0]);
  });

  it('does not send a graph a running save already carries', async () => {
    const onSave = vi.fn(() => new Promise<boolean>(() => undefined));
    await renderEditor(onSave);
    await edit();
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });

    act(() => root!.unmount());
    root = null;

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Back saves first, then leaves', async () => {
    const onSave = vi.fn(async () => true);
    await renderEditor(onSave);
    await edit();

    await back();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(buttonNamed('Leave without saving')).toBeUndefined();
  });

  it('Back with nothing to save leaves at once', async () => {
    const onSave = vi.fn(async () => true);
    await renderEditor(onSave);
    await back();
    expect(onSave).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('asks before leaving when the save fails, and Stay keeps the edits', async () => {
    const onSave = vi.fn(async () => false);
    await renderEditor(onSave);
    await edit();

    await back();

    expect(onBack).not.toHaveBeenCalled();
    await click(buttonNamed('Stay'));
    expect(onBack).not.toHaveBeenCalled();
  });

  it('asks when an earlier save failed, and leaving anyway sends nothing more', async () => {
    const onSave = vi.fn(async () => false);
    await renderEditor(onSave);
    await edit();
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); }); // autosave fails and stops
    const before = onSave.mock.calls.length;

    await back();
    await click(buttonNamed('Leave without saving'));

    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    root = null;
    expect(onSave.mock.calls.length).toBe(before + 1); // the retry from Back, and no flush after it
  });

  it('treats a rejected save as a failed one: Back asks instead of doing nothing', async () => {
    const onSave = vi.fn(async (): Promise<boolean> => { throw new Error('offline'); });
    await renderEditor(onSave);
    await edit();

    await back();

    expect(onBack).not.toHaveBeenCalled();
    expect(buttonNamed('Leave without saving')).toBeDefined();
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ title: 'Failed to save flow', message: 'offline' })]);
  });

  it('can save again after a rejected save, so autosave is not stuck', async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true);
    await renderEditor(onSave);
    await edit();
    await pastAutosave();
    await edit();
    await pastAutosave();

    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected save from an editor that has closed', async () => {
    const onSave = vi.fn(async (): Promise<boolean> => { throw new Error('offline'); });
    await renderEditor(onSave);
    await edit();

    closeEditor();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ message: 'offline' })]);
  });

  it('warns before the tab closes while edits are unsaved, and stops once they are saved', async () => {
    const closing = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const onSave = vi.fn(async () => true);
    await renderEditor(onSave);
    expect(closing()).toBe(false);

    await edit();
    expect(closing()).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(closing()).toBe(false);
  });
});
