// @vitest-environment jsdom
// Settings are typed one key at a time, and each key re-renders the field from what was stored.
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { FormField } from '../../types/form';
import { FieldSettingsPanel } from './FieldSettingsPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: FormField | null = null;
/** Every state the field was stored in, as an autosave could have sent it. */
let history: FormField[] = [];

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
  history = [];
});

function Harness({ initial }: { initial: FormField }) {
  const [field, setField] = useState(initial);
  useEffect(() => { latest = field; history.push(field); }, [field]);
  return <FieldSettingsPanel field={field} allFields={[field]} onUpdate={(updates) => setField((f) => ({ ...f, ...updates }))} />;
}

function render(field: FormField) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<MemoryRouter><Harness initial={field} /></MemoryRouter>);
  });
}

function inputLabelled(text: string): HTMLInputElement {
  const label = Array.from(host!.querySelectorAll('label')).find((l) => l.textContent === text);
  const input = label && host!.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`);
  if (!input) throw new Error(`no input labelled ${text}`);
  return input;
}

/** Type into a controlled input the way React sees it: one value per keystroke, then leave it. */
function type(input: HTMLInputElement, values: string[]) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => input.focus());
  for (const value of values) {
    act(() => {
      setValue.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  act(() => input.blur());
}

const scale: FormField = {
  id: 'q1', type: 'scale', label: 'How likely?', required: false,
  properties: { scaleStart: 1, scaleEnd: 5 },
} as FormField;

describe('FieldSettingsPanel scale bounds', () => {
  // "10" arrives as "1" and then "10": the first key must not push the Start down to make room for
  // an End of 1, or a 1-10 scale is saved as 0-10.
  it('keeps the Start when an End of 10 is typed key by key', () => {
    render(scale);
    type(inputLabelled('End'), ['1', '10']);
    expect(latest?.properties.scaleEnd).toBe(10);
    expect(latest?.properties.scaleStart).toBe(1);
    expect(history.filter((f) => (f.properties.scaleStart ?? 1) >= (f.properties.scaleEnd ?? 10))).toEqual([]);
  });

  it('still moves the Start below an End the author settles on', () => {
    render({ ...scale, properties: { scaleStart: 3, scaleEnd: 10 } } as FormField);
    type(inputLabelled('End'), ['2']);
    expect(latest?.properties.scaleEnd).toBe(2);
    expect(latest?.properties.scaleStart).toBe(1);
    // Never stored the other way round on the way there: a 3-2 scale draws no buttons at all.
    expect(history.filter((f) => (f.properties.scaleStart ?? 1) >= (f.properties.scaleEnd ?? 10))).toEqual([]);
  });

  it('keeps what was stored while the End is cleared to type a new one', () => {
    render(scale);
    const input = inputLabelled('End');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => input.focus());
    act(() => { setValue.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(input.value).toBe('');
    expect(latest?.properties.scaleEnd).toBe(5);
    act(() => input.blur());
    expect(input.value).toBe('5');
  });
});

describe('FieldSettingsPanel accepted file types', () => {
  const upload: FormField = { id: 'f1', type: 'file_upload', label: 'Attachment', required: false, properties: {} } as FormField;

  /** Each key is added to what the input shows at that moment, as a keyboard does. */
  function keys(input: HTMLInputElement, text: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => input.focus());
    for (const key of text) {
      act(() => {
        setValue.call(input, input.value + key);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  }

  it('takes a second type typed after a comma', () => {
    render(upload);
    const input = inputLabelled('Accepted File Types');
    keys(input, '.pdf, .jpg');
    expect(input.value).toBe('.pdf, .jpg');
    expect(latest?.properties.acceptedFileTypes).toEqual(['.pdf', '.jpg']);
    act(() => input.blur());
    expect(input.value).toBe('.pdf, .jpg');
  });
});
