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
