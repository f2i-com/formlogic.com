// @vitest-environment jsdom
// A timeout is typed a key at a time: limited at every key, the 5 of 5000 became 250 and the next
// digits landed after it, and a sync binding held submissions for four minutes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowBinding, FlowDefinition } from '../../types/flows';
import { FormFlowBindingEditor } from './FormFlowBindingEditor';

vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const flow = { id: 'fl1', slug: 'notify', name: 'Notify', flowJson: { nodes: [], edges: [] } } as unknown as FlowDefinition;
const binding = { id: 'b1', flow: 'notify', mode: 'sync', inputMap: {}, timeoutMs: 30000, enabled: true } as unknown as FlowBinding;

let root: Root | null = null;
let host: HTMLElement | null = null;
let onSave: ReturnType<typeof vi.fn>;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render() {
  onSave = vi.fn(async () => ({ ok: true }));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<FormFlowBindingEditor fields={[]} flows={[flow]} binding={binding} onSave={onSave as never} onDone={() => {}} onCancel={() => {}} />);
  });
}

const timeout = () => document.body.querySelector<HTMLInputElement>('#timeout-input')!;

function set(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(timeout(), value);
    timeout().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Select what is there and type over it: the first key replaces it, and each next one lands after what the box then shows. */
function type(keys: string) {
  [...keys].forEach((key, i) => set(i === 0 ? key : timeout().value + key));
}

const leave = () => act(() => { timeout().focus(); timeout().blur(); });

async function save() {
  const button = Array.from(document.body.querySelectorAll('button')).find((b) => /^(Save|Update)/.test(b.textContent?.trim() ?? ''))!;
  await act(async () => button.click());
  return onSave.mock.calls[0][1] as { timeoutMs: number };
}

describe('the sync timeout', () => {
  it('takes what is typed, one key at a time', async () => {
    render();
    type('5000');
    expect(timeout().value).toBe('5000');
    leave();
    expect((await save()).timeoutMs).toBe(5000);
  });

  it('can be cleared and typed afresh', async () => {
    render();
    set('');
    type('800');
    leave();
    expect((await save()).timeoutMs).toBe(800);
  });

  it('is brought inside its limits when the input is left', () => {
    render();
    type('99');
    leave();
    expect(timeout().value).toBe('250');
    type('999999');
    leave();
    expect(timeout().value).toBe('300000');
  });

  it('falls back to the default when left empty', () => {
    render();
    set('');
    leave();
    expect(timeout().value).toBe('30000');
  });
});
