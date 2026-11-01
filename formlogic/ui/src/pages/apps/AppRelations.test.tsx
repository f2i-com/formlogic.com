// @vitest-environment jsdom
// Adding and deleting a relation, against the server's own rules for a field save: an id it would
// refuse, a revision it would refuse, and the real store behind them, so that what the builder's
// copy does next is part of what is proved.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form, FormField } from '../../types/form';

const server = vi.hoisted(() => ({
  forms: {} as Record<string, { id: string; title: string; fields: unknown[]; settings: object; theme: object; status: string; fieldsRevision: string }>,
  unreadable: new Set<string>(),
  refusals: [] as string[],
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));

vi.mock('../../lib/api', () => ({
  api: {
    isDemoMode: () => false,
    isAdminActing: () => false,
    setAdminActing: () => {},
    getForm: vi.fn(async (id: string) => (server.unreadable.has(id) ? { error: 'Server unavailable', status: 503 } : { data: { form: server.forms[id] } })),
    updateForm: vi.fn(async (id: string, body: { fields: Array<{ id: string }>; expectedFieldsRevision?: string }) => {
      const form = server.forms[id];
      if (body.expectedFieldsRevision && body.expectedFieldsRevision !== form.fieldsRevision) {
        return { error: 'This form was changed somewhere else', status: 409, code: 'form_changed' };
      }
      // FormService::fieldIdError
      const bad = body.fields.find((f) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.id));
      if (bad) {
        server.refusals.push(bad.id);
        return { error: `Field ID must start with a letter or underscore: ${bad.id}`, status: 400 };
      }
      form.fields = body.fields;
      form.fieldsRevision = `${form.fieldsRevision}+`;
      return { data: { form } };
    }),
  },
}));
vi.mock('../../stores/toastStore', () => ({ toast: toasts }));

import { clearAllDebounceTimers, flushDebouncedSave, useFormStore } from '../../stores/formStore';
import { useAppStore } from '../../stores/appStore';
import { AppRelationsManager } from './AppRelationsManager';
import { RelationFormModal } from './RelationFormModal';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const field = (id: string, type: FormField['type'] = 'short_text', extra: Partial<FormField> = {}) =>
  ({ id, type, label: id, required: false, properties: {}, order: 0, ...extra }) as FormField;
const link = (id: string) => field(id, 'linked_record', { properties: { targetFormId: 'customers' } });

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  clearAllDebounceTimers();
  vi.clearAllMocks();
  server.refusals = [];
  server.unreadable = new Set();
  server.forms = {
    orders: { id: 'orders', title: 'Orders', fields: [field('total')], settings: {}, theme: {}, status: 'draft', fieldsRevision: 'one' },
    customers: { id: 'customers', title: 'Customers', fields: [field('name')], settings: {}, theme: {}, status: 'draft', fieldsRevision: 'one' },
  };
  useFormStore.setState({ forms: [], storageMode: 'api', isInitialized: true, savingFormIds: {}, saveErrors: {}, fieldHistory: {} });
  useAppStore.setState({ fetchAppForms: vi.fn(async () => [
    { formId: 'orders', displayName: 'Orders' },
    { formId: 'customers', displayName: 'Customers' },
  ]) as never });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(element);
  });
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

function setInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function addRelation(label: string) {
  const onSave = vi.fn();
  await mount(
    <RelationFormModal isOpen onClose={() => {}} onSave={onSave} defaultSourceFormId="orders"
      appForms={[{ formId: 'orders', displayName: 'Orders' }, { formId: 'customers', displayName: 'Customers' }]} />
  );
  const target = document.body.querySelector<HTMLSelectElement>('#relation-target-form')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(target, 'customers');
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  setInput(document.body.querySelector<HTMLInputElement>('input[placeholder^="e.g."]')!, label);
  const create = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Create')!;
  await act(async () => { create.click(); });
  return onSave;
}

const held = (id: string) => useFormStore.getState().forms.find((f) => f.id === id) as Form;

describe('adding a relation', () => {
  it('is saved, under an id the server takes', async () => {
    const onSave = await addRelation('Customer');

    expect(onSave).toHaveBeenCalled();
    expect(server.refusals).toEqual([]);
    expect(toasts.error).not.toHaveBeenCalled();
    expect((server.forms.orders.fields as FormField[]).map((f) => f.id)).toEqual(['total', 'customer']);
  });

  // The server refuses `value` and the other reserved names, as it did the hyphens of a uuid.
  it('steers round a reserved name and an id in use', async () => {
    server.forms.orders.fields = [field('customer')];
    await addRelation('Customer');
    expect((server.forms.orders.fields as FormField[]).at(-1)?.id).toBe('customer_1');
  });

  it('checks the reserved names the builder does', async () => {
    await addRelation('Value');
    expect((server.forms.orders.fields as FormField[]).at(-1)?.id).toBe('value_1');
  });

  it('refreshes the builder\'s copy, so its next edit is not refused as someone else\'s change', async () => {
    useFormStore.setState({ forms: [{ ...server.forms.orders, fields: [field('total')], _fieldsLoaded: true } as unknown as Form] });

    await addRelation('Customer');
    expect(held('orders').fields.map((f) => f.id)).toEqual(['total', 'customer']);

    useFormStore.getState().updateField('orders', 'total', { label: 'Order total' });
    await flushDebouncedSave('orders');

    expect(useFormStore.getState().saveErrors.orders).toBeUndefined();
    expect((server.forms.orders.fields as FormField[]).map((f) => f.id)).toEqual(['total', 'customer']);
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

async function openRelations() {
  await mount(
    <MemoryRouter initialEntries={['/apps/a1/relations']}>
      <Routes><Route path="/apps/:appId/relations" element={<AppRelationsManager />} /></Routes>
    </MemoryRouter>
  );
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

describe('deleting a relation', () => {
  beforeEach(() => {
    server.forms.orders.fields = [field('total'), link('customer')];
  });

  it('refreshes the builder\'s copy the same way', async () => {
    useFormStore.setState({ forms: [{ ...server.forms.orders, fields: [field('total'), link('customer')], _fieldsLoaded: true } as unknown as Form] });
    await openRelations();

    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Delete relation"]')!.click());
    const confirm = Array.from(document.body.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1)!;
    await act(async () => Array.from(confirm.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Delete')!.click());
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

    expect((server.forms.orders.fields as FormField[]).map((f) => f.id)).toEqual(['total']);
    expect(held('orders').fields.map((f) => f.id)).toEqual(['total']);

    useFormStore.getState().updateField('orders', 'total', { label: 'Order total' });
    await flushDebouncedSave('orders');
    expect(useFormStore.getState().saveErrors.orders).toBeUndefined();
    expect((server.forms.orders.fields as FormField[]).map((f) => f.id)).toEqual(['total']);
  });
});

describe('the relations list', () => {
  it('says which form it could not read, instead of leaving its relations out', async () => {
    server.forms.orders.fields = [field('total'), link('customer')];
    server.unreadable = new Set(['orders']);
    await openRelations();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not load Orders');
    expect(document.body.textContent).not.toContain('No relations yet');

    server.unreadable = new Set();
    await act(async () => Array.from(alert!.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Try again')!.click());
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('customer');
  });

  it('is empty only when every form was read', async () => {
    await openRelations();
    expect(document.body.textContent).toContain('No relations yet');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});

// The check above stands in for the server: hold it to what the server's code says.
it('checks ids with the pattern FormService uses', () => {
  const php = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../backend/src/Services/FormService.php'), 'utf8');
  expect(php).toContain("preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/', $id)");
});
