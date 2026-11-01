// @vitest-environment jsdom
// The Studio's Data step writes a form's whole field list from a copy it read once, so a save has
// to say what it started from, and a field has to get the id the builder would give it.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, AppForm } from '../../../types/app';
import type { Form, FormField } from '../../../types/form';

const h = vi.hoisted(() => ({
  updateForm: vi.fn(),
  updateAppForm: vi.fn(),
  getAppsFormUsage: vi.fn(),
  getForm: vi.fn(),
  toastError: vi.fn(),
  location: '',
}));

vi.mock('../../../lib/api', () => ({
  api: {
    isDemoMode: () => false,
    isAdminActing: () => false,
    setAdminActing: () => {},
    updateForm: h.updateForm,
    updateAppForm: h.updateAppForm,
    getAppsFormUsage: h.getAppsFormUsage,
    getForm: h.getForm,
  },
}));
vi.mock('../../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: h.toastError, info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../vault/VaultSetupWizard', () => ({ VaultSetupWizard: () => null }));
vi.mock('../../vault/VaultUnlockDialog', () => ({ VaultUnlockDialog: () => null }));
vi.mock('../../apps/ExportDataMenu', () => ({ ExportDataMenu: () => null }));
vi.mock('../NativeDatabaseTables', () => ({ NativeDatabaseTables: () => null }));
vi.mock('../../../pages/apps/RelationFormModal', () => ({ RelationFormModal: () => null }));

import { useAppStore } from '../../../stores/appStore';
import { clearAllDebounceTimers, useFormStore } from '../../../stores/formStore';
import { DataStep } from './DataStep';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const field = (id: string, extra: Partial<FormField> = {}) =>
  ({ id, type: 'short_text', label: id, required: false, properties: {}, order: 0, ...extra }) as FormField;
const form = (extra: Partial<Form> = {}) =>
  ({ id: 'f1', title: 'Customers', fields: [field('name')], settings: {}, theme: {}, status: 'draft', fieldsRevision: 'one', responseCount: 0, ...extra }) as unknown as Form;
const app = { id: 'a1', name: 'Shop', slug: 'shop', settings: {} } as unknown as App;
const attachment = { formId: 'f1', displayName: 'Customers' } as unknown as AppForm;

let root: Root | null = null;
let host: HTMLElement | null = null;
let onReloadForms: ReturnType<typeof vi.fn>;

function WhereAmI() {
  const location = useLocation();
  useEffect(() => { h.location = `${location.pathname}${location.search}`; }, [location]);
  return null;
}

beforeEach(() => {
  clearAllDebounceTimers();
  vi.clearAllMocks();
  onReloadForms = vi.fn(async () => undefined);
  h.updateForm.mockResolvedValue({ data: { form: form() } });
  h.updateAppForm.mockResolvedValue({ data: {} });
  h.getAppsFormUsage.mockResolvedValue({ data: { apps: [{ appId: 'a1', appName: 'Shop', forms: [{ formId: 'f1' }] }] } });
  h.getForm.mockResolvedValue({ data: { form: form({ fieldsRevision: 'two' }) } });
  useAppStore.setState({ fetchFormAppUsage: vi.fn(async () => ({})) as never });
  useFormStore.setState({ forms: [], storageMode: 'api', isInitialized: true, savingFormIds: {}, saveErrors: {} });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(current: Form = form()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={[`/apps/a1/studio/data`]}>
        <WhereAmI />
        <DataStep app={app} appForms={[attachment]} formsById={{ f1: current }} unreadableFormIds={[]} formsResolving={false} onReloadForms={onReloadForms as never} />
      </MemoryRouter>
    );
  });
}

const button = (name: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

function setInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function quickAdd(label: string) {
  // The row stays open after a save, for the next field.
  if (button('Add field')) await act(async () => button('Add field').click());
  setInput(document.body.querySelector<HTMLInputElement>('input[placeholder="e.g. Customer name"]')!, label);
  await act(async () => button('Save field').click());
  const [, body] = h.updateForm.mock.calls.at(-1)!;
  return body as { fields: FormField[]; expectedFieldsRevision?: string };
}

describe('quick-adding a field', () => {
  // Value, Count, Finance and Format are refused by the server; Class, Case and New save, and
  // no rule can read them.
  it('names it as the builder does', async () => {
    await render();
    for (const [label, id] of [['Value', 'value_1'], ['Count', 'count_1'], ['Finance', 'finance_1'], ['Class', 'class_1'], ['Default', 'default_1'], ['New', 'new_1']]) {
      expect((await quickAdd(label)).fields.at(-1)?.id).toBe(id);
    }
  });

  it('numbers a label in use as the builder does', async () => {
    await render(form({ fields: [field('email')] }));
    expect((await quickAdd('Email')).fields.at(-1)?.id).toBe('email_1');
  });

  it('says what it started from', async () => {
    await render();
    expect((await quickAdd('Phone')).expectedFieldsRevision).toBe('one');
  });

  it('does not take out a field added elsewhere: it says so and reads the form again', async () => {
    h.updateForm.mockResolvedValue({ error: 'This form was changed somewhere else', status: 409, code: 'form_changed' });
    await render();
    await quickAdd('Phone');

    expect(h.toastError).toHaveBeenCalledWith('Could not add the field', expect.stringContaining('changed somewhere else'));
    expect(onReloadForms).toHaveBeenCalled();
  });
});

describe('the Required toggle', () => {
  const toggle = async () => {
    const box = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
  };

  it('says what it started from', async () => {
    await render();
    await toggle();
    expect(h.updateForm.mock.calls[0][1]).toMatchObject({ expectedFieldsRevision: 'one' });
  });

  it('reads the form again after a refusal, so the next try is made from what is there', async () => {
    h.updateForm.mockResolvedValue({ error: 'This form was changed somewhere else', status: 409, code: 'form_changed' });
    await render();
    await toggle();

    expect(h.toastError).toHaveBeenCalledWith('Could not save the change', expect.stringContaining('changed somewhere else'));
    expect(onReloadForms).toHaveBeenCalled();
  });
});

describe('a link to the builder', () => {
  // The builder's linked-record settings read the app from the address.
  it('says which app it is opened from', async () => {
    await render();
    await act(async () => button('Open builder').click());
    expect(h.location).toBe('/builder/f1?appId=a1');
  });
});

describe('renaming a data type', () => {
  const nameBox = () => document.body.querySelector<HTMLInputElement>('#studio-type-name')!;

  async function rename(to: string) {
    const box = nameBox();
    await act(async () => box.focus());
    setInput(box, to);
    await act(async () => box.blur());
  }

  it('renames the form too when no other app shows it, and the builder\'s copy with it', async () => {
    useFormStore.setState({ forms: [form({ title: 'Customers' })] });
    await render();
    await rename('Clients');

    expect(h.updateAppForm).toHaveBeenCalledWith('a1', 'f1', { displayName: 'Clients' });
    expect(h.updateForm).toHaveBeenCalledWith('f1', { title: 'Clients' });
    expect(useFormStore.getState().forms[0].title).toBe('Clients');
  });

  it('leaves the form\'s title when another app shows it', async () => {
    h.getAppsFormUsage.mockResolvedValue({ data: { apps: [{ appId: 'other', appName: 'Other', forms: [{ formId: 'f1' }] }] } });
    await render();
    await rename('Clients');

    expect(h.updateAppForm).toHaveBeenCalled();
    expect(h.updateForm).not.toHaveBeenCalled();
  });

  it('leaves the form\'s title when it cannot tell who else shows it', async () => {
    h.getAppsFormUsage.mockResolvedValue({ error: 'Server unavailable', status: 503 });
    await render();
    await rename('Clients');

    expect(h.updateAppForm).toHaveBeenCalled();
    expect(h.updateForm).not.toHaveBeenCalled();
  });

  it('says so when the title could not be changed, and shows what is stored', async () => {
    useFormStore.setState({ forms: [form({ title: 'Customers' })] });
    h.updateForm.mockResolvedValue({ error: 'Title refused', status: 422 });
    await render();
    await rename('Clients');

    expect(h.toastError).toHaveBeenCalledWith('Could not rename', expect.stringContaining('Title refused'));
    expect(onReloadForms).toHaveBeenCalled();
    expect(useFormStore.getState().forms[0].title).toBe('Customers');
  });

  it('leaves everything as it was on Escape', async () => {
    await render();
    const box = nameBox();
    await act(async () => box.focus());
    setInput(box, 'Clients');
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    expect(h.updateAppForm).not.toHaveBeenCalled();
    expect(nameBox().value).toBe('Customers');
  });
});
