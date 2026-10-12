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

  // The Start is typed the same way. A cleared Start that snaps back to "1" puts the next key
  // after that 1: "0" arrives as "10", and a Start of 10 pushes the End from 5 to 11.
  it('lets the Start be cleared and retyped without moving the End', () => {
    render(scale);
    const input = inputLabelled('Start');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const key = (k: string) => act(() => { setValue.call(input, k === 'Backspace' ? input.value.slice(0, -1) : input.value + k); input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => input.focus());
    key('Backspace');
    expect(input.value).toBe('');
    expect(latest?.properties.scaleStart).toBe(1);
    key('0');
    expect(latest?.properties.scaleStart).toBe(0);
    expect(latest?.properties.scaleEnd).toBe(5);
    act(() => input.blur());
    expect(input.value).toBe('0');
    expect(history.filter((f) => f.properties.scaleEnd !== 5)).toEqual([]);
  });

  it('moves the End above a Start the author settles on, and not before', () => {
    render(scale);
    const input = inputLabelled('Start');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => input.focus());
    act(() => { setValue.call(input, '7'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(input.value).toBe('7');
    expect(latest?.properties.scaleEnd).toBe(5);
    expect(latest?.properties.scaleStart).toBe(1);
    act(() => input.blur());
    expect(latest?.properties.scaleStart).toBe(7);
    expect(latest?.properties.scaleEnd).toBe(8);
    expect(history.filter((f) => (f.properties.scaleStart ?? 1) >= (f.properties.scaleEnd ?? 10))).toEqual([]);
  });
});

describe('FieldSettingsPanel number bounds', () => {
  const age: FormField = { id: 'n1', type: 'number', label: 'Age', required: false, properties: { min: 18, max: 65 } } as FormField;

  // A Max of 99 arrives as "9" and then "99". The 9 is below the Min of 18, and the editor keeps
  // Min at or below Max: correcting on the first key stored a Min of 9, which the form then
  // enforced, and nothing on screen said the Min had changed.
  it('keeps the Min when a Max of 99 is typed key by key', () => {
    render(age);
    type(inputLabelled('Max'), ['9', '99']);
    expect(latest?.properties.max).toBe(99);
    expect(latest?.properties.min).toBe(18);
    expect(history.filter((f) => f.properties.min !== 18)).toEqual([]);
  });

  it('keeps the Max when a Min of 70 is retyped as 7', () => {
    render(age);
    const input = inputLabelled('Min');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => input.focus());
    for (const value of ['7', '70', '7']) act(() => { setValue.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => input.blur());
    expect(latest?.properties.min).toBe(7);
    expect(latest?.properties.max).toBe(65);
    expect(history.filter((f) => f.properties.max !== 65)).toEqual([]);
  });

  it('still brings the other bound along for a value the author settles on', () => {
    render(age);
    type(inputLabelled('Max'), ['9']);
    expect(latest?.properties.max).toBe(9);
    expect(latest?.properties.min).toBe(9);
    // Never stored with Min above Max on the way there: no answer would pass.
    expect(history.filter((f) => (f.properties.min ?? -Infinity) > (f.properties.max ?? Infinity))).toEqual([]);
  });

  it('still clears a bound when its box is emptied', () => {
    render(age);
    type(inputLabelled('Max'), ['']);
    expect(latest?.properties.max).toBeUndefined();
    expect(latest?.properties.min).toBe(18);
  });
});

describe('FieldSettingsPanel number settings that always hold a value', () => {
  /** Keys as a keyboard sends them: each is applied to what the box shows at that moment. */
  function press(input: HTMLInputElement, keys: string[]) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => input.focus());
    for (const k of keys) {
      act(() => { setValue.call(input, k === 'Backspace' ? input.value.slice(0, -1) : input.value + k); input.dispatchEvent(new Event('input', { bubbles: true })); });
    }
  }

  // Cleared to retype it, the box must stay cleared. Filled back in with the default at once, the
  // next key lands after it: a 3 typed over Max Stars 5 read "53" and was stored as 10.
  it('lets Max Stars be cleared and retyped', () => {
    render({ id: 'r1', type: 'rating', label: 'Rate us', required: false, properties: { maxStars: 5 } } as FormField);
    const input = inputLabelled('Max Stars');
    press(input, ['Backspace']);
    expect(input.value).toBe('');
    expect(latest?.properties.maxStars).toBe(5);
    press(input, ['3']);
    expect(latest?.properties.maxStars).toBe(3);
    act(() => input.blur());
    expect(input.value).toBe('3');
  });

  it('puts back what was stored when Max Stars is left empty', () => {
    render({ id: 'r1', type: 'rating', label: 'Rate us', required: false, properties: { maxStars: 4 } } as FormField);
    const input = inputLabelled('Max Stars');
    press(input, ['Backspace']);
    act(() => input.blur());
    expect(input.value).toBe('4');
    expect(latest?.properties.maxStars).toBe(4);
  });

  it('lets Max File Size be cleared and retyped', () => {
    render({ id: 'f1', type: 'file_upload', label: 'Attachment', required: false, properties: {} } as FormField);
    const input = inputLabelled('Max File Size (MB)');
    press(input, ['Backspace', 'Backspace']);
    expect(input.value).toBe('');
    press(input, ['2', '5']);
    expect(latest?.properties.maxFileSize).toBe(25 * 1024 * 1024);
  });

  it('lets the number of files be cleared and retyped', () => {
    render({ id: 'f1', type: 'file_upload', label: 'Attachment', required: false, properties: { allowMultiple: true, maxFiles: 20 } } as FormField);
    const input = inputLabelled('Maximum number of files');
    press(input, ['Backspace', 'Backspace']);
    expect(input.value).toBe('');
    press(input, ['3']);
    expect(latest?.properties.maxFiles).toBe(3);
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
