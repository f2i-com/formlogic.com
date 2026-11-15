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
  opts: {
    linkedNoteText?: string | null; onSave?: (p: Record<string, unknown>, n?: string) => void; onDelete?: () => void;
    linkTargets?: Array<{ id: string; label: string }>; onLink?: (id: string) => void;
  } = {},
) {
  await act(async () => {
    root.render(
      <SelectionPanel
        element={el}
        busy={false}
        linkedNoteText={opts.linkedNoteText ?? null}
        onSave={opts.onSave ?? (() => {})}
        onDelete={opts.onDelete ?? (() => {})}
        linkTargets={opts.linkTargets}
        onLink={opts.onLink}
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

  it('form: names each field type in words, keeps a type it does not offer, and saves on Enter', async () => {
    const onSave = vi.fn();
    await render(
      element({ elementType: 'form', properties: { title: 'Guests', fields: [{ name: 'email', type: 'email' }, { name: 'stars', type: 'rating' }] } }),
      { onSave },
    );
    const first = byLabel<HTMLSelectElement>('Field type 1');
    expect([...first.options].map((option) => option.textContent)).toEqual(['Short text', 'Long text', 'Number', 'Date', 'Email', 'Phone', 'Checkbox (yes or no)', 'Dropdown (one of a list)']);
    expect(byLabel<HTMLSelectElement>('Field type 2').value).toBe('rating');
    expect(container.textContent).not.toContain('Not saved yet');
    const title = byLabel<HTMLInputElement>('Entity title');
    setValue(title, 'Visitors');
    expect(container.textContent).toContain('Not saved yet');
    act(() => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Visitors', fields: [{ name: 'email', type: 'email' }, { name: 'stars', type: 'rating' }] });
  });

  it('links to another card chosen from a list, without a line drawn by hand', async () => {
    const onLink = vi.fn();
    await render(element({ elementType: 'form', properties: { title: 'Orders' } }), {
      onLink,
      linkTargets: [{ id: 'el-2', label: 'Form: Customers' }, { id: 'el-3', label: 'Flow: Send a receipt' }],
    });
    const list = container.querySelector('select[id^="link-"]') as HTMLSelectElement;
    expect([...list.options].map((option) => option.textContent)).toEqual(['Choose something to link this to…', 'Form: Customers', 'Flow: Send a receipt']);
    act(() => setValue(list, 'el-3'));
    expect(onLink).toHaveBeenCalledWith('el-3');
    // Nothing to link to, or a line itself: no list.
    await render(element({ elementType: 'edge', properties: { edgeType: 'relation', sourceId: 'a', targetId: 'b' } }), { onLink, linkTargets: [{ id: 'el-2', label: 'Form: Customers' }] });
    expect(container.querySelector('select[id^="link-"]')).toBeNull();
  });

  it('drawings: no Save button, Delete still routes through onDelete', async () => {
    const onDelete = vi.fn();
    await render(element({ elementType: 'ink', properties: { path: 'M0 0', w: 10, h: 10 } }), { onDelete });
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim().startsWith('Save'))).toBe(false);
    clickButton('Delete');
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

// The panel stays open while the diagram comes back after a change, so the element it shows can
// change under it: a field typed on the card, another tab, Undo, its own Save. (Each render below
// is the same panel given the element as the diagram now holds it, as the canvas does.)
describe('SelectionPanel: the element changing while the panel is open', () => {
  const fieldNames = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label^="Field name"]')].map((input) => input.value);
  const saysNotSaved = () => (container.textContent ?? '').includes('Not saved yet');
  const form = (properties: Record<string, unknown>) => element({ id: 'el-orders', elementType: 'form', properties });

  it('takes in a field added on the card, and its next Save keeps it', async () => {
    const onSave = vi.fn();
    await render(form({ title: 'Orders', fields: [{ name: 'customer', type: 'short_text' }] }), { onSave });
    await render(form({ title: 'Orders', fields: [{ name: 'customer', type: 'short_text' }, { name: 'total', type: 'short_text' }] }), { onSave });
    expect(fieldNames()).toEqual(['customer', 'total']);
    expect(saysNotSaved()).toBe(false);

    const title = byLabel<HTMLInputElement>('Entity title');
    setValue(title, 'Orders renamed');
    act(() => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Orders renamed', fields: [{ name: 'customer', type: 'short_text' }, { name: 'total', type: 'short_text' }] });
  });

  it('keeps what was typed when the element changes elsewhere, takes the rest, and its retry keeps both', async () => {
    const onSave = vi.fn();
    const before = { title: 'Orders', fields: [{ name: 'customer', type: 'short_text' }] };
    await render(form(before), { onSave });
    setValue(byLabel<HTMLInputElement>('Entity title'), 'Orders v3');
    clickButton('Save'); // refused: another tab added a field first (409), and the diagram comes back with it
    await render(form({ ...before, fields: [...before.fields, { name: 'added_in_other_tab', type: 'number' }] }), { onSave });

    expect(byLabel<HTMLInputElement>('Entity title').value).toBe('Orders v3');
    expect(fieldNames()).toEqual(['customer', 'added_in_other_tab']);
    expect(saysNotSaved()).toBe(true);
    clickButton('Save');
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0]).toMatchObject({
      title: 'Orders v3',
      fields: [{ name: 'customer', type: 'short_text' }, { name: 'added_in_other_tab', type: 'number' }],
    });
  });

  it('says nothing is left unsaved once its own Save comes back tidied', async () => {
    const onSave = vi.fn();
    await render(form({ title: 'Invoices', fields: [] }), { onSave });
    clickButton('Add'); // a field row left empty
    setValue(byLabel<HTMLInputElement>('Entity title'), 'Invoices to send ');
    clickButton('Save');
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Invoices to send', fields: [] });
    await render(form(onSave.mock.calls[0][0]), { onSave });

    expect(saysNotSaved()).toBe(false);
    expect(byLabel<HTMLInputElement>('Entity title').value).toBe('Invoices to send');
    expect(fieldNames()).toEqual([]);
  });

  it('keeps on typing after Save without calling its own change one made elsewhere', async () => {
    const onSave = vi.fn();
    await render(form({ title: 'Rooms', fields: [] }), { onSave });
    const title = byLabel<HTMLInputElement>('Entity title');
    setValue(title, 'Guest rooms');
    clickButton('Save');
    setValue(title, 'Guest rooms and suites'); // typed on while the save is on its way
    await render(form(onSave.mock.calls[0][0]), { onSave });
    expect(byLabel<HTMLInputElement>('Entity title').value).toBe('Guest rooms and suites');
    expect(container.textContent).toContain('Not saved yet');
    expect(container.textContent).not.toContain('Changed elsewhere');
  });

  it('merges the fields by name when they were changed here and elsewhere', async () => {
    const onSave = vi.fn();
    await render(form({ title: 'Orders', fields: [{ name: 'customer', type: 'short_text' }, { name: 'notes', type: 'short_text' }] }), { onSave });
    clickButton('Add');
    setValue(byLabel<HTMLInputElement>('Field name 3'), 'price');
    // Elsewhere: a field added, another's type changed, and one taken out.
    await render(form({ title: 'Orders', fields: [{ name: 'customer', type: 'email' }, { name: 'total', type: 'number' }] }), { onSave });
    expect(fieldNames()).toEqual(['customer', 'price', 'total']);
    clickButton('Save');
    expect(onSave.mock.calls[0][0].fields).toEqual([{ name: 'customer', type: 'email' }, { name: 'price', type: 'short_text' }, { name: 'total', type: 'number' }]);
  });

  it('says so when a value typed here was changed elsewhere too, and can take the saved one', async () => {
    const onSave = vi.fn();
    await render(form({ title: 'Orders', fields: [] }), { onSave });
    setValue(byLabel<HTMLInputElement>('Entity title'), 'Purchases');
    await render(form({ title: 'Sales', fields: [] }), { onSave });
    expect(byLabel<HTMLInputElement>('Entity title').value).toBe('Purchases');
    expect(container.textContent).toContain('Changed elsewhere too since you began');
    clickButton('take the saved version');
    expect(byLabel<HTMLInputElement>('Entity title').value).toBe('Sales');
    expect(saysNotSaved()).toBe(false);
    expect(container.textContent).not.toContain('Changed elsewhere');
  });

  it("takes in a note's text written on the card (and after Undo), so Save does not write the old text back", async () => {
    const onSave = vi.fn();
    const note = (text: string) => element({ id: 'el-note', elementType: 'note', properties: { text } });
    await render(note('Call the supplier'), { onSave });
    await render(note('Call the supplier on Monday'), { onSave });
    expect(byLabel<HTMLTextAreaElement>('Body text').value).toBe('Call the supplier on Monday');
    clickButton('Save');
    expect(onSave.mock.calls[0][0].text).toBe('Call the supplier on Monday');
  });
});
