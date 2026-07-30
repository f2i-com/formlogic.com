// @vitest-environment jsdom
// Audit XR-02 — characterization tests pinning SelectionPanel's save/delete
// contract across every element family, so the extraction out of
// DiagramCanvas.tsx (and any future refactor) stays behavior-neutral:
//   - form: trimmed title (empty -> 'Untitled'), fields filtered/trimmed,
//     description dropped (superseded by the linked sticky), NO noteText arg;
//   - concept (actor/flow/...): title + the linked-note text as arg 2;
//   - note/text: body saved as properties.text, title removed;
//   - ER relation edge: label managed (trimmed; empty DELETES the key),
//     cardinality + fkField written;
//   - plain connector edge: label only, never cardinality;
//   - drawings (ink/image/shape): no Save button at all, Delete still works.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlueprintElement } from '../../types/blueprints';
import { SelectionPanel } from './SelectionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function element(overrides: Partial<BlueprintElement>): BlueprintElement {
  return {
    id: 'el-1',
    elementType: 'form',
    resourceRef: null,
    properties: {},
    layout: null,
    ...overrides,
  } as BlueprintElement;
}

async function render(
  el: BlueprintElement,
  opts: { linkedNoteText?: string | null; onSave?: (p: Record<string, unknown>, n?: string) => void; onDelete?: () => void } = {},
) {
  await act(async () => {
    root.render(
      <SelectionPanel
        element={el}
        busy={false}
        linkedNoteText={opts.linkedNoteText ?? null}
        onSave={opts.onSave ?? (() => {})}
        onDelete={opts.onDelete ?? (() => {})}
      />,
    );
  });
}

function setValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function byLabel<T extends HTMLElement>(label: string): T {
  const node = container.querySelector(`[aria-label="${label}"]`);
  expect(node, `element labelled "${label}"`).toBeTruthy();
  return node as T;
}

function clickButton(text: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));
  expect(button, `button "${text}"`).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('SelectionPanel (diagram selection editor)', () => {
  it('form: trims the title, filters empty fields, drops description, sends no note arg', async () => {
    const onSave = vi.fn();
    await render(
      element({
        elementType: 'form',
        properties: {
          title: 'Bookings',
          description: 'old how-it-works',
          fields: [{ name: 'customer', type: 'short_text' }],
        },
      }),
      { onSave },
    );
    setValue(byLabel<HTMLInputElement>('Entity title'), '  Reservations  ');
    setValue(byLabel<HTMLInputElement>('Field name 1'), '  guest  ');
    clickButton('Save');
    expect(onSave).toHaveBeenCalledTimes(1);
    const [props, note] = onSave.mock.calls[0];
    expect(props.title).toBe('Reservations');
    expect(props.fields).toEqual([{ name: 'guest', type: 'short_text' }]);
    expect('description' in props).toBe(false);
    expect(note).toBeUndefined();
  });

  it('form: an emptied title saves as Untitled', async () => {
    const onSave = vi.fn();
    await render(element({ elementType: 'form', properties: { title: 'X' } }), { onSave });
    setValue(byLabel<HTMLInputElement>('Entity title'), '   ');
    clickButton('Save');
    expect(onSave.mock.calls[0][0].title).toBe('Untitled');
  });

  it('concept (actor): passes the notes text as the second save argument', async () => {
    const onSave = vi.fn();
    await render(element({ elementType: 'actor', properties: { title: 'Receptionist' } }), {
      onSave,
      linkedNoteText: 'answers the phone',
    });
    setValue(byLabel<HTMLTextAreaElement>('Concept notes'), 'books appointments');
    clickButton('Save');
    const [props, note] = onSave.mock.calls[0];
    expect(props.title).toBe('Receptionist');
    expect(note).toBe('books appointments');
  });

  it('note: saves the body as properties.text and removes any title', async () => {
    const onSave = vi.fn();
    await render(element({ elementType: 'note', properties: { title: 'stale', text: 'old' } }), { onSave });
    setValue(byLabel<HTMLTextAreaElement>('Body text'), 'remember the milk');
    clickButton('Save');
    const [props, note] = onSave.mock.calls[0];
    expect(props.text).toBe('remember the milk');
    expect('title' in props).toBe(false);
    expect(note).toBeUndefined();
  });

  it('ER relation edge: writes trimmed label, cardinality and fkField', async () => {
    const onSave = vi.fn();
    await render(
      element({
        elementType: 'edge',
        properties: { edgeType: 'relation', sourceId: 'a', targetId: 'b', cardinality: '1:N', fkField: '' },
      }),
      { onSave },
    );
    setValue(byLabel<HTMLInputElement>('Relationship name'), ' places ');
    setValue(byLabel<HTMLSelectElement>('How many records link to each other'), '1:1');
    setValue(byLabel<HTMLInputElement>('Relation FK field'), ' customer ');
    clickButton('Save');
    const [props] = onSave.mock.calls[0];
    expect(props.label).toBe('places');
    expect(props.cardinality).toBe('1:1');
    expect(props.fkField).toBe('customer');
    expect(props.sourceId).toBe('a');
  });

  it('edge: clearing the label DELETES the key; a plain connector never gains cardinality', async () => {
    const onSave = vi.fn();
    await render(
      element({
        elementType: 'edge',
        properties: { edgeType: 'relation', sourceId: 'a', targetId: 'b', label: 'old name' },
      }),
      { onSave },
    );
    // No cardinality on the stored edge -> a plain connector: no cardinality select.
    expect(container.querySelector('[aria-label="Relation cardinality"]')).toBeNull();
    setValue(byLabel<HTMLInputElement>('Relationship name'), '   ');
    clickButton('Save');
    const [props] = onSave.mock.calls[0];
    expect('label' in props).toBe(false);
    expect('cardinality' in props).toBe(false);
  });

  it('drawings: no Save button, Delete still routes through onDelete', async () => {
    const onDelete = vi.fn();
    await render(element({ elementType: 'ink', properties: { path: 'M0 0', w: 10, h: 10 } }), { onDelete });
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim().startsWith('Save'))).toBe(false);
    clickButton('Delete');
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
