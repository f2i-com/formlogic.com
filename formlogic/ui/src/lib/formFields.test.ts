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

  // A title's save used to drop the refresh, and the next field edit was refused for a change
  // nobody here had seen, with Retry refused too and only a reload left, which lost that edit.
  it('waits for a save on its way, and then takes the chat\'s fields', async () => {
    useFormStore.setState({ savingFormIds: { f1: 1 } });
    chatEdits();
    const refreshing = refreshFormFields('f1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocked.getForm).not.toHaveBeenCalled();

    useFormStore.setState({ savingFormIds: {} });
    await refreshing;

    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('chat');
  });

  it('stops waiting for a save that never lands, and leaves the copy', async () => {
    vi.useFakeTimers();
    useFormStore.setState({ savingFormIds: { f1: 1 } });
    chatEdits();
    const refreshing = refreshFormFields('f1');

    await vi.advanceTimersByTimeAsync(30_000);
    await refreshing;
    vi.useRealTimers();

    expect(mocked.getForm).not.toHaveBeenCalled();
    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('one');
  });

  it('leaves an edit that was on its way and got refused, rather than drop it', async () => {
    useFormStore.getState().updateField('f1', 'name', { label: 'Half typed' });
    chatEdits();
    const refreshing = refreshFormFields('f1');
    await flushDebouncedSave('f1');
    await refreshing;

    expect(mocked.getForm).not.toHaveBeenCalled();
    expect(useFormStore.getState().forms[0].fields[0].label).toBe('Half typed');
  });

  it('leaves an edit whose save failed', async () => {
    useFormStore.setState({ saveErrors: { f1: ['fields'] } });
    await refreshFormFields('f1');
    expect(mocked.getForm).not.toHaveBeenCalled();
  });

  /** A read the test ends when it chooses, as a slow network would. */
  function holdRead() {
    let answer!: () => void;
    mocked.getForm.mockImplementationOnce(() => {
      // As the server stood when it was read, whenever the answer gets back.
      const { fields, revision } = server;
      return new Promise((resolve) => {
        answer = () => resolve({ data: { form: { id: 'f1', title: 'F', fields, settings: {}, theme: {}, status: 'draft', fieldsRevision: revision } } });
      });
    });
    return () => answer();
  }

  it('does not replace an edit made during the read', async () => {
    chatEdits();
    const answer = holdRead();
    const refreshing = refreshFormFields('f1');
    await vi.waitFor(() => expect(mocked.getForm).toHaveBeenCalled());

    useFormStore.getState().updateField('f1', 'name', { label: 'Typed during the read' });
    answer();
    await refreshing;

    const held = useFormStore.getState();
    expect(held.forms[0].fields.map((f) => f.label)).toEqual(['Typed during the read']);
    expect(held.fieldHistory.f1.past).toHaveLength(1);
    clearAllDebounceTimers();
  });

  it('does not replace an edit that was made and saved during the read', async () => {
    const answer = holdRead();
    const refreshing = refreshFormFields('f1');
    await vi.waitFor(() => expect(mocked.getForm).toHaveBeenCalled());

    useFormStore.getState().updateField('f1', 'name', { label: 'Saved during the read' });
    await flushDebouncedSave('f1');
    answer();
    await refreshing;

    expect(useFormStore.getState().forms[0].fields[0].label).toBe('Saved during the read');
  });

  it('does not replace a title changed during the read', async () => {
    const answer = holdRead();
    const refreshing = refreshFormFields('f1');
    await vi.waitFor(() => expect(mocked.getForm).toHaveBeenCalled());

    useFormStore.setState((s) => ({ forms: s.forms.map((f) => ({ ...f, title: 'Mine' })) }));
    answer();
    await refreshing;

    expect(useFormStore.getState().forms[0].title).toBe('Mine');
  });

  it('does not apply a read over anything marked unsaved since it began', async () => {
    chatEdits();
    const answer = holdRead();
    const refreshing = refreshFormFields('f1');
    await vi.waitFor(() => expect(mocked.getForm).toHaveBeenCalled());

    useFormStore.setState({ savingFormIds: { f1: 1 } });
    answer();
    await refreshing;

    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('one');
  });

  it('keeps undo when the fields came back as they were', async () => {
    useFormStore.setState({ fieldHistory: { f1: { past: [[field('before')]], future: [] } } });
    server.revision = 'one';

    await refreshFormFields('f1');

    expect(mocked.getForm).toHaveBeenCalled();
    expect(useFormStore.getState().fieldHistory.f1.past).toHaveLength(1);
  });

  it('drops undo when they did not: it would restore fields from before the chat\'s', async () => {
    useFormStore.setState({ fieldHistory: { f1: { past: [[field('before')]], future: [] } } });
    chatEdits();

    await refreshFormFields('f1');

    expect(useFormStore.getState().fieldHistory.f1).toBeUndefined();
  });

  it('does not let a failed save of something else hold back the refresh', async () => {
    useFormStore.setState({ saveErrors: { f1: ['theme'] } });
    chatEdits();

    await refreshFormFields('f1');

    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('chat');
    useFormStore.getState().updateField('f1', 'name', { label: 'Full name' });
    await flushDebouncedSave('f1');
    expect(useFormStore.getState().saveErrors.f1).toEqual(['theme']);
    expect((server.fields as FormField[]).map((f) => f.id)).toEqual(['name', 'from_chat']);
  });

  it('keeps what such a failed save holds, for its Retry to send', async () => {
    useFormStore.setState((s) => ({ saveErrors: { f1: ['meta'] }, forms: s.forms.map((f) => ({ ...f, title: 'Not saved yet' })) }));
    chatEdits();

    await refreshFormFields('f1');

    const form = useFormStore.getState().forms[0];
    expect(form.title).toBe('Not saved yet');
    expect(form.fields.map((f) => f.id)).toEqual(['name', 'from_chat']);
  });

  // Two update_form calls in one turn, with the first read still out when the second begins.
  it('takes every write of a turn, in order', async () => {
    chatEdits();
    const answerFirst = holdRead();
    const answerSecond = holdRead();
    const first = refreshFormFields('f1');
    await vi.waitFor(() => expect(mocked.getForm).toHaveBeenCalledTimes(1));

    server.fields = [field('name'), field('from_chat'), field('and_again')];
    server.revision = 'chat2';
    const second = refreshFormFields('f1');
    answerFirst();
    await first;
    await vi.waitFor(() => expect(mocked.getForm).toHaveBeenCalledTimes(2));
    answerSecond();
    await second;

    const form = useFormStore.getState().forms[0];
    expect(form.fieldsRevision).toBe('chat2');
    expect(form.fields.map((f) => f.id)).toEqual(['name', 'from_chat', 'and_again']);
  });

  // A real conflict stays one: the person is told, and nothing is overwritten either way.
  it('still has an edit that was waiting when the chat\'s change landed refused', async () => {
    useFormStore.getState().updateField('f1', 'name', { label: 'Half typed' });
    chatEdits();
    const refreshing = refreshFormFields('f1');
    await flushDebouncedSave('f1');
    await refreshing;

    expect(useFormStore.getState().saveErrors.f1).toEqual(['fields']);
    expect((server.fields as FormField[]).map((f) => f.id)).toEqual(['name', 'from_chat']);
  });

  it('has nothing to do for a form this tab has not opened', async () => {
    await refreshFormFields('another');
    useFormStore.setState({ forms: [{ id: 'f1', title: 'F', fields: [] } as unknown as Form] });
    await refreshFormFields('f1');
    expect(mocked.getForm).not.toHaveBeenCalled();
  });
});
