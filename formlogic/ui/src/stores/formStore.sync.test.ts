// FL-SYNC-001 — non-destructive sync: an unverifiable existence check never becomes a
// create, a failed offline deletion stays in the outbox, and conflict resolution keeps a
// conflict (and both copies) whenever its chosen operation wasn't acknowledged — a failed
// "keep mine" can never be followed by the storage-mode switch that would reload the
// server copy over it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form } from '../types/form';

vi.mock('../lib/api', () => ({
  api: {
    isDemoMode: vi.fn(() => false),
    isAdminActing: vi.fn(() => false),
    setAdminActing: vi.fn(),
    isAuthenticated: vi.fn(() => true),
    healthCheck: vi.fn(async () => ({ data: { status: 'ok' } })),
    getForm: vi.fn(),
    getForms: vi.fn(async () => ({ data: { forms: [] } })),
    createForm: vi.fn(),
    updateForm: vi.fn(),
    deleteForm: vi.fn(),
  },
}));
vi.mock('./toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { api } from '../lib/api';
import { clearAllDebounceTimers, useFormStore, type SyncConflict } from './formStore';

const mocked = {
  getForm: vi.mocked(api.getForm),
  createForm: vi.mocked(api.createForm),
  updateForm: vi.mocked(api.updateForm),
  deleteForm: vi.mocked(api.deleteForm),
};

function makeForm(id: string, overrides: Partial<Form> = {}): Form {
  return {
    id,
    title: `Form ${id}`,
    description: '',
    status: 'draft',
    fields: [],
    settings: {} as Form['settings'],
    theme: {} as Form['theme'],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  } as unknown as Form;
}

function conflictFor(id: string): SyncConflict {
  return { id, title: `Form ${id}`, localUpdatedAt: '2026-07-10T00:00:00.000Z', serverUpdatedAt: '2026-07-11 00:00:00' };
}

beforeEach(() => {
  clearAllDebounceTimers();
  Object.values(mocked).forEach((m) => m.mockReset());
  useFormStore.setState({
    forms: [],
    storageMode: 'local',
    isInitialized: true,
    pendingDeletions: [],
    syncConflicts: null,
    syncSwitchAfter: false,
    savingFormIds: {},
    saveErrors: {},
  });
});

describe('syncToApi existence checks (FL-SYNC-001)', () => {
  it('a 500 on the existence check never becomes a create', async () => {
    useFormStore.setState({ forms: [makeForm('f1')] });
    mocked.getForm.mockResolvedValue({ error: 'Server error (500)', status: 500 } as never);

    const result = await useFormStore.getState().syncToApi();

    expect(mocked.createForm).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('left untouched');
  });

  it('a definitive 404 creates the offline-made form', async () => {
    useFormStore.setState({ forms: [makeForm('f1')] });
    mocked.getForm.mockResolvedValue({ error: 'Form not found', status: 404 } as never);
    mocked.createForm.mockResolvedValue({ data: { form: makeForm('f1') } } as never);

    const result = await useFormStore.getState().syncToApi();

    expect(mocked.createForm).toHaveBeenCalledTimes(1);
    expect(result.synced).toBe(1);
  });

  it('a failed offline deletion stays in the outbox; a 404 clears it', async () => {
    useFormStore.setState({ pendingDeletions: ['dead-1', 'dead-2', 'dead-3'] });
    mocked.deleteForm.mockImplementation(async (id: string) => {
      if (id === 'dead-1') return { error: 'Server error (500)', status: 500 } as never;
      if (id === 'dead-2') return { error: 'Form not found', status: 404 } as never;
      return { data: { success: true } } as never;
    });

    const result = await useFormStore.getState().syncToApi();

    expect(useFormStore.getState().pendingDeletions).toEqual(['dead-1']);
    expect(result.deleted).toBe(1); // only the acknowledged deletion counts
  });
});

// GET /forms leaves the fields out, and a PUT replaces the server's fields with whatever it holds,
// an empty list included. A row of the list that went to device-only mode looks like an empty form:
// renamed there and pushed back, it wiped the live form's fields.
describe('a form whose fields never reached this device', () => {
  const listRow = (overrides: Partial<Form> = {}) => makeForm('f1', { fieldCount: 3, updatedAt: '2026-07-20T00:00:00.000Z', ...overrides });
  const onServer = { data: { form: makeForm('f1', { updatedAt: '2026-07-10 00:00:00' }) } } as never;

  it('is pushed without fields, and the rest of its changes still arrive', async () => {
    useFormStore.setState({ forms: [listRow({ title: 'Renamed offline' })] });
    mocked.getForm.mockResolvedValue(onServer);
    mocked.updateForm.mockResolvedValue({ data: {} } as never);

    const result = await useFormStore.getState().syncToApi();

    expect(result.success).toBe(true);
    const sent = mocked.updateForm.mock.calls[0][1];
    expect(sent).not.toHaveProperty('fields');
    expect(sent.title).toBe('Renamed offline');
  });

  it('keeps the server’s fields when the owner added one to the copy that showed none', async () => {
    const added = { id: 'note', type: 'short_text', label: 'Note', required: false, order: 0, properties: {} };
    useFormStore.setState({ forms: [listRow({ fields: [added] as Form['fields'] })] });
    mocked.getForm.mockResolvedValue(onServer);
    mocked.updateForm.mockResolvedValue({ data: {} } as never);

    await useFormStore.getState().syncToApi();

    expect(mocked.updateForm.mock.calls[0][1]).not.toHaveProperty('fields');
  });

  it('is pushed without fields by a "keep mine" too', async () => {
    useFormStore.setState({ forms: [listRow({ id: 'c1' })], syncConflicts: [conflictFor('c1')] });
    mocked.updateForm.mockResolvedValue({ data: {} } as never);

    await useFormStore.getState().resolveSyncConflicts({ c1: 'mine' });

    expect(mocked.updateForm.mock.calls[0][1]).not.toHaveProperty('fields');
  });

  it('still sends the fields of a form that has them, an emptied one included', async () => {
    useFormStore.setState({
      forms: [{ ...listRow(), _fieldsLoaded: true } as Form, makeForm('mine', { updatedAt: '2026-07-20T00:00:00.000Z' })],
    });
    mocked.getForm.mockImplementation(async (id: string) => ({ data: { form: makeForm(id, { updatedAt: '2026-07-10 00:00:00' }) } }) as never);
    mocked.updateForm.mockResolvedValue({ data: {} } as never);

    await useFormStore.getState().syncToApi();

    expect(mocked.updateForm.mock.calls.map(([, sent]) => sent.fields)).toEqual([[], []]);
  });

  it('is fetched when opened on this device, instead of opening empty', async () => {
    const field = { id: 'name', type: 'short_text', label: 'Name', required: false, order: 0, properties: {} };
    useFormStore.setState({ forms: [listRow()] });
    mocked.getForm.mockResolvedValue({ data: { form: makeForm('f1', { fields: [field] as Form['fields'], fieldCount: 1 }) } } as never);

    await useFormStore.getState().loadFullForm('f1');

    expect(useFormStore.getState().forms[0].fields).toHaveLength(1);
  });

  it('keeps what the owner changed on this device when its fields arrive', async () => {
    const field = { id: 'name', type: 'short_text', label: 'Name', required: false, order: 0, properties: {} };
    useFormStore.setState({ forms: [listRow({ title: 'Renamed offline' })] });
    mocked.getForm.mockResolvedValue({ data: { form: makeForm('f1', { title: 'Old title', fields: [field] as Form['fields'], fieldCount: 1, updatedAt: '2026-07-10 00:00:00' }) } } as never);

    await useFormStore.getState().loadFullForm('f1');

    const held = useFormStore.getState().forms[0];
    expect(held.fields).toHaveLength(1);
    expect(held.title).toBe('Renamed offline');
    expect(held.updatedAt).toBe('2026-07-20T00:00:00.000Z'); // still newer, so the rename reaches the server
  });

  it('is fetched even when the owner added a field to the copy that showed none', async () => {
    const added = { id: 'note', type: 'short_text', label: 'Note', required: false, order: 0, properties: {} };
    const real = [{ ...added, id: 'a' }, { ...added, id: 'b' }, { ...added, id: 'c' }];
    useFormStore.setState({ forms: [listRow({ fields: [added] as Form['fields'] })] });
    mocked.getForm.mockResolvedValue({ data: { form: makeForm('f1', { fields: real as Form['fields'], fieldCount: 3 }) } } as never);

    await useFormStore.getState().loadFullForm('f1');

    expect(useFormStore.getState().forms[0].fields.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not reach for the server for a form made on this device', async () => {
    useFormStore.setState({ forms: [makeForm('mine')] });

    await useFormStore.getState().loadFullForm('mine');

    expect(mocked.getForm).not.toHaveBeenCalled();
  });
});

// A form's `fieldCount` goes stale the moment a field is deleted, so a complete form with no mark
// (stored by an older client, a Duplicate from the server) would read as a row of the forms list:
// the deletion left out of the PUT, undone when the form is opened, and sync reporting success.
describe('a complete form whose copy carries no mark', () => {
  const trio = ['a', 'b', 'c'].map((id, order) => ({ id, type: 'short_text', label: id, required: false, order, properties: {} })) as Form['fields'];
  const complete = () => makeForm('f1', { fields: trio, fieldCount: 3, updatedAt: '2026-07-20T00:00:00.000Z' });

  it('sends a deleted field’s absence to the server', async () => {
    useFormStore.setState({ forms: [complete()] });
    mocked.getForm.mockResolvedValue({ data: { form: makeForm('f1', { updatedAt: '2026-07-10 00:00:00' }) } } as never);
    mocked.updateForm.mockResolvedValue({ data: {} } as never);

    useFormStore.getState().deleteField('f1', 'a');
    await useFormStore.getState().syncToApi();

    expect(mocked.updateForm.mock.calls[0][1].fields?.map((f) => f.id)).toEqual(['b', 'c']);
  });

  it('keeps the deletion when the form is opened again', async () => {
    useFormStore.setState({ forms: [complete()] });

    useFormStore.getState().deleteField('f1', 'a');
    await useFormStore.getState().loadFullForm('f1');

    expect(mocked.getForm).not.toHaveBeenCalled();
    expect(useFormStore.getState().forms[0].fields.map((f) => f.id)).toEqual(['b', 'c']);
  });

  it('can leave the cloud after a field was deleted from a Duplicate', async () => {
    useFormStore.setState({ storageMode: 'api', forms: [complete()], isInitialized: true, isLoading: false, error: null });

    useFormStore.getState().deleteField('f1', 'a');
    clearAllDebounceTimers();

    await expect(useFormStore.getState().loadAllFullForms()).resolves.toBe(true);
    expect(mocked.getForm).not.toHaveBeenCalled();
  });

  it('does not vouch for a row of the forms list that a field was added to', () => {
    const added = { type: 'short_text', label: 'Note', required: false, properties: {} };
    useFormStore.setState({ forms: [makeForm('f1', { fieldCount: 3 })] });

    useFormStore.getState().addField('f1', added as Parameters<ReturnType<typeof useFormStore.getState>['addField']>[1]);

    expect(useFormStore.getState().forms[0]).not.toHaveProperty('_fieldsLoaded');
  });
});

describe('loading every form before leaving the cloud', () => {
  beforeEach(() => useFormStore.setState({ storageMode: 'api', isInitialized: true, isLoading: false, error: null }));
  const fields = [{ id: 'name', type: 'short_text', label: 'Name', required: false, order: 0, properties: {} }] as Form['fields'];

  // One request per form takes a while, and anything can refresh the list in that time.
  it('refuses, and marks nothing, when a refresh put rows without fields back meanwhile', async () => {
    const full = (id: string) => ({ data: { form: makeForm(id, { fields, fieldCount: 1 }) } }) as never;
    const rows = [makeForm('a', { fieldCount: 1 }), makeForm('b', { fieldCount: 1 })];
    useFormStore.setState({ forms: rows });
    mocked.getForm.mockImplementation(async (id: string) => {
      if (id === 'b') useFormStore.setState({ forms: rows });
      return full(id);
    });
    mocked.getForm.mockImplementationOnce(async (id: string) => full(id));

    await expect(useFormStore.getState().loadAllFullForms()).resolves.toBe(false);

    expect(useFormStore.getState().forms.filter((f) => '_fieldsLoaded' in f && f.id === 'a')).toEqual([]);
  });

  it('marks only what it loaded', async () => {
    const lateRow = makeForm('late', { fieldCount: 0 });
    useFormStore.setState({ forms: [makeForm('a', { fieldCount: 1 })] });
    mocked.getForm.mockImplementation(async (id: string) => {
      useFormStore.setState((s) => ({ forms: [...s.forms, lateRow] }));
      return { data: { form: makeForm(id, { fields, fieldCount: 1 }) } } as never;
    });

    await expect(useFormStore.getState().loadAllFullForms()).resolves.toBe(true);

    expect(useFormStore.getState().forms.find((f) => f.id === 'late')).not.toHaveProperty('_fieldsLoaded');
  });

  it.each([
    ['the list is still loading', { isLoading: true }],
    ['the first load has not finished', { isInitialized: false }],
    ['the list failed to load', { error: 'Failed to load forms' }],
  ])('refuses while %s', async (_name, state) => {
    useFormStore.setState({ forms: [], ...state });

    await expect(useFormStore.getState().loadAllFullForms()).resolves.toBe(false);
  });

  it('leaves every form with its fields', async () => {
    useFormStore.setState({ forms: [makeForm('a', { fieldCount: 1 }), makeForm('empty', { fieldCount: 0 })] });
    mocked.getForm.mockImplementation(async (id: string) => ({ data: { form: makeForm(id, { fields: id === 'a' ? fields : [], fieldCount: id === 'a' ? 1 : 0 }) } }) as never);

    await expect(useFormStore.getState().loadAllFullForms()).resolves.toBe(true);

    expect(useFormStore.getState().forms.map((f) => f.fields.length)).toEqual([1, 0]);
  });

  it('says so when one cannot be loaded', async () => {
    useFormStore.setState({ forms: [makeForm('a', { fieldCount: 1 })] });
    mocked.getForm.mockResolvedValue({ error: 'Server error (500)', status: 500 } as never);

    await expect(useFormStore.getState().loadAllFullForms()).resolves.toBe(false);
  });
});

// In cloud mode the device holds no forms, so a failed health check leaves forms: [] exactly as a
// new account has, and the Dashboard told an owner to create their first form.
describe('a save of the fields says what it started from', () => {
  const failFields = (id: string) => useFormStore.setState({ saveErrors: { [id]: ['fields'] } });

  it('names the revision it holds and keeps the one that comes back', async () => {
    useFormStore.setState({ storageMode: 'api', forms: [makeForm('f1', { fieldsRevision: 'one' })] });
    failFields('f1');
    mocked.updateForm.mockResolvedValue({ data: { form: makeForm('f1', { fieldsRevision: 'two' }) } });

    expect(await useFormStore.getState().retryFormSaves('f1')).toBe(true);

    expect(mocked.updateForm.mock.calls[0][1]).toMatchObject({ expectedFieldsRevision: 'one' });
    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('two');
  });

  it('waits for the save before it, so it starts from where that one ended', async () => {
    useFormStore.setState({ storageMode: 'api', forms: [makeForm('f1', { fieldsRevision: 'one' })] });
    let finishFirst: (value: unknown) => void = () => {};
    mocked.updateForm.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }) as never);
    mocked.updateForm.mockResolvedValue({ data: { form: makeForm('f1', { fieldsRevision: 'three' }) } });

    failFields('f1');
    const first = useFormStore.getState().retryFormSaves('f1');
    failFields('f1');
    const second = useFormStore.getState().retryFormSaves('f1');
    await new Promise((resolve) => setTimeout(resolve));
    expect(mocked.updateForm).toHaveBeenCalledTimes(1);

    finishFirst({ data: { form: makeForm('f1', { fieldsRevision: 'two' }) } });
    await Promise.all([first, second]);

    expect(mocked.updateForm).toHaveBeenCalledTimes(2);
    expect(mocked.updateForm.mock.calls[1][1]).toMatchObject({ expectedFieldsRevision: 'two' });
  });

  it('keeps the edit and the save error when another tab got there first', async () => {
    useFormStore.setState({ storageMode: 'api', forms: [makeForm('f1', { fieldsRevision: 'one' })] });
    failFields('f1');
    mocked.updateForm.mockResolvedValue({ error: 'This form was changed somewhere else', status: 409, code: 'form_changed' });

    expect(await useFormStore.getState().retryFormSaves('f1')).toBe(false);

    expect(useFormStore.getState().saveErrors.f1).toEqual(['fields']);
    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('one');
  });

  it('does not hold a save whose answer was lost against the retry', async () => {
    useFormStore.setState({ storageMode: 'api', forms: [makeForm('f1', { fieldsRevision: 'one' })] });
    failFields('f1');
    mocked.updateForm.mockResolvedValueOnce({ error: 'Network error' });
    mocked.updateForm.mockResolvedValue({ data: { form: makeForm('f1', { fieldsRevision: 'two' }) } });

    expect(await useFormStore.getState().retryFormSaves('f1')).toBe(false);
    expect(await useFormStore.getState().retryFormSaves('f1')).toBe(true);

    expect(mocked.updateForm.mock.calls[1][1]).not.toHaveProperty('expectedFieldsRevision');
    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('two');
  });

  it('says nothing for a copy that has no revision', async () => {
    useFormStore.setState({ storageMode: 'api', forms: [makeForm('f1')] });
    failFields('f1');
    mocked.updateForm.mockResolvedValue({ data: { form: makeForm('f1') } });

    await useFormStore.getState().retryFormSaves('f1');

    expect(mocked.updateForm.mock.calls[0][1]).not.toHaveProperty('expectedFieldsRevision');
  });
});

describe('initialize when the API does not answer', () => {
  beforeEach(() => useFormStore.setState({ isInitialized: false, isLoading: false, error: null }));

  it('records the failure in cloud mode', async () => {
    useFormStore.setState({ storageMode: 'api' });
    vi.mocked(api.healthCheck).mockResolvedValueOnce({ error: 'Failed to fetch' } as never);

    await useFormStore.getState().initialize();

    expect(useFormStore.getState().error).toBe('Failed to load forms');
    expect(useFormStore.getState().isInitialized).toBe(true);
  });

  it('is no failure in local mode, whose forms are on the device', async () => {
    useFormStore.setState({ storageMode: 'local' });
    vi.mocked(api.healthCheck).mockResolvedValueOnce({ error: 'Failed to fetch' } as never);

    await useFormStore.getState().initialize();

    expect(useFormStore.getState().error).toBeNull();
  });
});

describe('resolveSyncConflicts (FL-SYNC-001)', () => {
  it("a failed 'keep mine' keeps the conflict and does NOT switch storage mode", async () => {
    useFormStore.setState({
      forms: [makeForm('c1')],
      syncConflicts: [conflictFor('c1')],
      syncSwitchAfter: true,
    });
    mocked.updateForm.mockResolvedValue({ error: 'Server error (503)', status: 503 } as never);

    await useFormStore.getState().resolveSyncConflicts({ c1: 'mine' });

    const state = useFormStore.getState();
    expect(state.syncConflicts).toHaveLength(1);
    expect(state.syncSwitchAfter).toBe(true); // the reconnect stays pending
    expect(state.storageMode).toBe('local'); // a failed keep-mine must never be followed by a cloud reload
  });

  it("a failed 'keep cloud' fetch keeps the local copy and the conflict", async () => {
    const local = makeForm('c1', { title: 'My offline title' });
    useFormStore.setState({ forms: [local], syncConflicts: [conflictFor('c1')] });
    mocked.getForm.mockResolvedValue({ error: 'Network error' } as never);

    await useFormStore.getState().resolveSyncConflicts({ c1: 'cloud' });

    const state = useFormStore.getState();
    expect(state.syncConflicts).toHaveLength(1);
    expect(state.forms[0].title).toBe('My offline title');
  });

  it('partial failure resolves the successes and retains only the failures', async () => {
    useFormStore.setState({
      forms: [makeForm('ok'), makeForm('bad')],
      syncConflicts: [conflictFor('ok'), conflictFor('bad')],
    });
    mocked.updateForm.mockImplementation(async (id: string) =>
      (id === 'ok' ? ({ data: { form: makeForm('ok') } } as never) : ({ error: 'boom', status: 500 } as never))
    );

    await useFormStore.getState().resolveSyncConflicts({ ok: 'mine', bad: 'mine' });

    expect(useFormStore.getState().syncConflicts?.map((c) => c.id)).toEqual(['bad']);
  });

  it('full success clears the conflicts', async () => {
    const serverCopy = makeForm('c1', { title: 'Cloud title' });
    useFormStore.setState({ forms: [makeForm('c1')], syncConflicts: [conflictFor('c1')] });
    mocked.getForm.mockResolvedValue({ data: { form: serverCopy } } as never);

    await useFormStore.getState().resolveSyncConflicts({ c1: 'cloud' });

    const state = useFormStore.getState();
    expect(state.syncConflicts).toBeNull();
    expect(state.forms[0].title).toBe('Cloud title');
  });
});
