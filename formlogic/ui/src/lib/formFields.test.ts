// Field writes from outside the builder. The store is the real one, so what is proved is that the
// builder's next save goes out from where the server now is: a write that left it behind cost one
// person in one tab a "changed somewhere else" for their own edit.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form, FormField } from '../types/form';

const server = vi.hoisted(() => ({ fields: [] as unknown[], revision: 'one' }));

vi.mock('./api', () => ({
  api: {
    isDemoMode: vi.fn(() => false),
    isAdminActing: vi.fn(() => false),
    setAdminActing: vi.fn(),
    getForm: vi.fn(async () => ({ data: { form: { id: 'f1', title: 'F', fields: server.fields, settings: {}, theme: {}, status: 'draft', fieldsRevision: server.revision } } })),
    updateForm: vi.fn(),
  },
}));
vi.mock('../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { api } from './api';
import { refreshFormFields, saveFormFields } from './formFields';
import { clearAllDebounceTimers, flushDebouncedSave, useFormStore } from '../stores/formStore';

const field = (id: string): FormField => ({ id, type: 'short_text', label: id, required: false, properties: {}, order: 0 });
const mocked = api as unknown as { updateForm: ReturnType<typeof vi.fn>; getForm: ReturnType<typeof vi.fn> };

/** The server's own rule: a save naming a revision the fields have left is refused. */
function serverSaves() {
  mocked.updateForm.mockImplementation(async (_id: string, body: { fields?: FormField[]; expectedFieldsRevision?: string }) => {
    if (body.expectedFieldsRevision && body.expectedFieldsRevision !== server.revision) {
      return { error: 'This form was changed somewhere else', status: 409, code: 'form_changed' };
    }
    if (body.fields) {
      server.fields = body.fields;
      server.revision = `${server.revision}+`;
    }
    return { data: { form: { id: 'f1', fieldsRevision: server.revision } } };
  });
}

beforeEach(() => {
  clearAllDebounceTimers();
  vi.clearAllMocks();
  server.fields = [field('name')];
  server.revision = 'one';
  serverSaves();
  const held = { id: 'f1', title: 'F', fields: [field('name')], settings: {}, theme: {}, status: 'draft', fieldsRevision: 'one', _fieldsLoaded: true } as unknown as Form;
  useFormStore.setState({ forms: [held], storageMode: 'api', isInitialized: true, savingFormIds: {}, saveErrors: {} });
});

describe('saveFormFields', () => {
  it('says which state of the fields it was made from', async () => {
    await saveFormFields('f1', [field('name'), field('more')], { fieldsRevision: 'one' });
    expect(mocked.updateForm.mock.calls[0][1]).toMatchObject({ expectedFieldsRevision: 'one' });
  });

  it('sends no revision for a copy that has none, as an old read has not', async () => {
    await saveFormFields('f1', [field('name')]);
    expect(mocked.updateForm.mock.calls[0][1]).not.toHaveProperty('expectedFieldsRevision');
  });

  it('writes nothing over a field added elsewhere, and says so plainly', async () => {
    server.fields = [field('name'), field('from_elsewhere')];
    server.revision = 'two';

    const result = await saveFormFields('f1', [field('name'), field('mine')], { fieldsRevision: 'one' });

    expect(result.ok).toBe(false);
    expect(result.changedElsewhere).toBe(true);
    expect(result.error).toContain('changed somewhere else');
    expect(server.fields).toEqual([field('name'), field('from_elsewhere')]);
    // The builder's copy has caught up too, so its next edit is not refused as well.
    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('two');
  });

  it('reports any other refusal as it came', async () => {
    mocked.updateForm.mockResolvedValue({ error: 'Field ID is reserved', status: 400 });
    const result = await saveFormFields('f1', [field('name')], { fieldsRevision: 'one' });
    expect(result).toEqual({ ok: false, error: 'Field ID is reserved' });
    expect(mocked.getForm).not.toHaveBeenCalled();
  });

  it('leaves the builder able to save straight after', async () => {
    await saveFormFields('f1', [field('name'), field('relation')], { fieldsRevision: 'one' });

    useFormStore.getState().updateField('f1', 'name', { label: 'Full name' });
    await flushDebouncedSave('f1');

    expect(useFormStore.getState().saveErrors.f1).toBeUndefined();
    expect((server.fields as FormField[]).map((f) => f.id)).toEqual(['name', 'relation']);
    expect((server.fields as FormField[])[0].label).toBe('Full name');
  });
});

// The site chat's update_form runs on the server, round the store.
describe('refreshFormFields', () => {
  const chatEdits = () => {
    server.fields = [field('name'), field('from_chat')];
    server.revision = 'chat';
  };

  it('brings the builder to the chat\'s fields, so its next save is not refused', async () => {
    chatEdits();
    await refreshFormFields('f1');

    expect(useFormStore.getState().forms[0].fields.map((f) => f.id)).toEqual(['name', 'from_chat']);
    useFormStore.getState().updateField('f1', 'name', { label: 'Full name' });
    await flushDebouncedSave('f1');
    expect(useFormStore.getState().saveErrors.f1).toBeUndefined();
    expect((server.fields as FormField[]).map((f) => f.id)).toEqual(['name', 'from_chat']);
  });

  it('leaves an edit that is still on its way, rather than drop it', async () => {
    useFormStore.getState().updateField('f1', 'name', { label: 'Half typed' });
    chatEdits();
    await refreshFormFields('f1');

    expect(mocked.getForm).not.toHaveBeenCalled();
    expect(useFormStore.getState().forms[0].fields[0].label).toBe('Half typed');
    clearAllDebounceTimers();
  });

  it('leaves an edit whose save failed', async () => {
    useFormStore.setState({ saveErrors: { f1: ['fields'] } });
    await refreshFormFields('f1');
    expect(mocked.getForm).not.toHaveBeenCalled();
  });

  it('has nothing to do for a form this tab has not opened', async () => {
    await refreshFormFields('another');
    useFormStore.setState({ forms: [{ id: 'f1', title: 'F', fields: [] } as unknown as Form] });
    await refreshFormFields('f1');
    expect(mocked.getForm).not.toHaveBeenCalled();
  });
});
