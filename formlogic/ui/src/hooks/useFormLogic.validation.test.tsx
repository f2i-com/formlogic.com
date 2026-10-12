// @vitest-environment jsdom
// A 'custom' validation rule (an expression) is checked nowhere a person fills a form: not on the
// public form, not in an app, not on the server. This hook was the one place that evaluated one,
// so it skips them too (ValidationEditor tells the form's author the rule is not checked).
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFieldValidation } from './useFormLogic';
import { validateWithExpression } from '../lib/formlogic';
import type { FormField } from '../types/form';

vi.mock('../lib/formlogic', () => ({ validateWithExpression: vi.fn(async () => 'Rejected by a custom rule') }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const handle: { validate: (() => Promise<boolean>) | null } = { validate: null };

function Probe({ field, value }: { field: FormField; value: unknown }) {
  const v = useFieldValidation(field, value);
  useEffect(() => { handle.validate = v.validate; });
  return <output>{v.error ?? ''}</output>;
}

function field(validation: FormField['validation']): FormField {
  return { id: 'code', type: 'short_text', label: 'Code', required: false, validation, properties: {}, order: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  handle.validate = null;
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });

it('does not check a custom expression rule', async () => {
  await act(async () => root.render(<Probe value="bad" field={field([
    { id: 'r1', type: 'custom', message: 'Must be ok', expression: 'value === "ok" ? null : "Must be ok"' },
  ])} />));
  let ok = false;
  await act(async () => { ok = await handle.validate!(); });
  expect(ok).toBe(true);
  expect(validateWithExpression).not.toHaveBeenCalled();
  expect(container.textContent).toBe('');
});

it('still checks the rules every screen and the server check', async () => {
  await act(async () => root.render(<Probe value="ab" field={field([
    { id: 'r1', type: 'custom', message: 'Must be ok', expression: '"Must be ok"' },
    { id: 'r2', type: 'minLength', value: 3, message: 'At least 3' },
  ])} />));
  let ok = true;
  await act(async () => { ok = await handle.validate!(); });
  expect(ok).toBe(false);
  expect(container.textContent).toBe('At least 3');
});
