// @vitest-environment jsdom
// Simple Mode on a choice question: a rule compares what is stored for an answer, the option's
// value, which stays option_1 when the option is renamed. Typed from the label, it never matched.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConditionalLogic, FormField } from '../../types/form';
import { LogicEditor } from './LogicEditor';

vi.mock('../../hooks/useFormLogic', () => ({
  useExpressionTester: () => ({ result: null, isTesting: false, testExpression: vi.fn() }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const field = (id: string, type: FormField['type'], label: string, extra: Partial<FormField> = {}): FormField =>
  ({ id, type, label, required: false, properties: {}, order: 0, ...extra });

const dropdown = field('plan', 'dropdown', 'Plan', {
  properties: { options: [{ id: 'o1', label: 'Yes', value: 'option_1' }, { id: 'o2', label: 'No', value: 'option_2' }] },
});
const notes = field('notes', 'short_text', 'Notes');
const when = field('when', 'date', 'When');

function render(allFields: FormField[], onSave: (logic: ConditionalLogic | undefined) => void = () => {}, target = field('follow_up', 'short_text', 'Follow up')) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<LogicEditor isOpen onClose={() => {}} field={target} allFields={[target, ...allFields]} onSave={onSave} />);
  });
}

const buttonNamed = (name: string) => {
  const found = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button named ${name}`);
  return found;
};
const expression = () => document.body.querySelector('code')?.textContent;
const valueBox = () => document.body.querySelector<HTMLElement>('[aria-label="Value for condition 1"]');
const comboboxes = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="combobox"]'));
/** The boxes run: when met, field, operator, then the value when it is a picker. */
const operatorBox = () => comboboxes()[2];

function choose(box: HTMLButtonElement, label: string) {
  act(() => box.click());
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.textContent?.trim() === label);
  if (!option) throw new Error(`no option ${label}: ${document.body.querySelector('[role="listbox"]')?.textContent}`);
  act(() => option.click());
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('a condition on a choice question', () => {
  it('picks from the options, and writes the value of the one picked', () => {
    render([dropdown]);
    act(() => buttonNamed('Add Condition').click());

    choose(valueBox()!.querySelector<HTMLButtonElement>('[role="combobox"]')!, 'Yes');

    expect(expression()).toBe('plan === "option_1"');
  });

  it('offers the options for does not equal and contains as well', () => {
    render([dropdown]);
    act(() => buttonNamed('Add Condition').click());

    choose(operatorBox(), 'does not equal');
    choose(valueBox()!.querySelector<HTMLButtonElement>('[role="combobox"]')!, 'No');
    expect(expression()).toBe('plan !== "option_2"');

    choose(operatorBox(), 'contains');
    expect(expression()).toBe('isNotEmpty(plan) && plan.includes("option_2")');
    expect(valueBox()?.querySelector('[role="combobox"]')?.textContent).toContain('No');
  });

  it('keeps a typed box for what does not compare with an option', () => {
    render([dropdown]);
    act(() => buttonNamed('Add Condition').click());
    choose(operatorBox(), 'is greater than');
    expect(valueBox()?.tagName).toBe('INPUT');
  });

  it('still shows a value no option holds, and leaves it in the rule', () => {
    render([notes, dropdown]);
    act(() => buttonNamed('Add Condition').click());
    typeInto(valueBox() as HTMLInputElement, 'Yes');

    choose(comboboxes()[1], 'Plan');

    expect(expression()).toBe('plan === "Yes"');
    expect(valueBox()?.querySelector('[role="combobox"]')?.textContent).toContain('Yes (not an option)');
  });

  // A rule made earlier opens as it is stored, in Expression Mode, and saves as it was.
  it('leaves a stored rule as it is', () => {
    const onSave = vi.fn();
    render([dropdown], onSave, field('follow_up', 'short_text', 'Follow up', { conditionalLogic: { expression: 'plan === "Yes"', action: 'show' } }));
    expect(document.body.querySelector('textarea')?.value).toBe('plan === "Yes"');

    act(() => buttonNamed('Save Condition').click());

    expect(onSave).toHaveBeenCalledWith({ expression: 'plan === "Yes"', action: 'show' });
  });
});

describe('a condition on a date', () => {
  it('asks for a date, so the value has the shape the answer does', () => {
    render([when]);
    act(() => buttonNamed('Add Condition').click());
    expect((valueBox() as HTMLInputElement).type).toBe('date');

    choose(operatorBox(), 'is greater than');
    typeInto(valueBox() as HTMLInputElement, '2026-01-01');

    expect(expression()).toBe('isNotEmpty(when) && when > "2026-01-01"');
  });
});

describe('saving a rule', () => {
  it('leaves quoted text that is also a field\'s name', () => {
    const onSave = vi.fn();
    const manager = field('mgr_1', 'short_text', 'Manager');
    const role = field('role_1', 'short_text', 'Role');
    render([manager, role], onSave, field('follow_up', 'short_text', 'Follow up', { conditionalLogic: { expression: 'role_1 === "x"', action: 'show' } }));

    const box = document.body.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'role === "manager" && manager !== ""');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => buttonNamed('Save Condition').click());

    expect(onSave).toHaveBeenCalledWith({ expression: 'role_1 === "manager" && mgr_1 !== ""', action: 'show' });
  });
});
