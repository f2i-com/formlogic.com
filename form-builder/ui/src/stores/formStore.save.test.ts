// FL-SAVE-001 — truthful save state: a failed server sync is STICKY in saveErrors (per
// failed slice) until a later save of that slice succeeds; flushFormSaves() runs pending
// debounced saves, retries failures once, and reports honestly so publish/preview/retry
// callers can refuse to announce success the server never acknowledged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form } from '../types/form';

vi.mock('../lib/api', () => ({
  api: {
    isDemoMode: vi.fn(() => false),
    updateForm: vi.fn(),
    getForms: vi.fn(async () => ({ data: { forms: [] } })),
  },
  isDemoLocalFormId: vi.fn(() => false),
}));
vi.mock('./toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { api } from '../lib/api';
import { clearAllDebounceTimers, flushFormSaves, useFormStore } from './formStore';

const mockedUpdateForm = vi.mocked(api.updateForm);

const FORM_ID = 'form-save-test';

function seedForm(): Form {
  return {
    id: FORM_ID,
    title: 'Save test',
    description: '',
    status: 'draft',
    fields: [],
    settings: {} as Form['settings'],
    theme: {} as Form['theme'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Form;
}

beforeEach(() => {
  clearAllDebounceTimers();
  mockedUpdateForm.mockReset();
  useFormStore.setState({
    forms: [seedForm()],
    storageMode: 'api',
    isInitialized: true,
    savingFormIds: {},
    saveErrors: {},
  });
});

describe('FL-SAVE-001 truthful save state', () => {
  it('a failed meta save is sticky in saveErrors and flushFormSaves reports ok:false', async () => {
    mockedUpdateForm.mockResolvedValue({ error: 'boom' } as never);

    await useFormStore.getState().updateForm(FORM_ID, { title: 'New title' });
    // updateForm resolves immediately (it only schedules the write) — the flush is
    // what actually runs it, and it must NOT claim success.
    const { ok } = await flushFormSaves(FORM_ID);

    expect(ok).toBe(false);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toContain('meta');
  });

  it('a later successful save of the failed slice clears the sticky error', async () => {
    mockedUpdateForm.mockResolvedValue({ error: 'boom' } as never);
    await useFormStore.getState().updateForm(FORM_ID, { title: 'New title' });
    await flushFormSaves(FORM_ID);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toEqual(['meta']);

    mockedUpdateForm.mockResolvedValue({ data: { form: seedForm() } } as never);
    const { ok } = await flushFormSaves(FORM_ID);

    expect(ok).toBe(true);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toBeUndefined();
    // The Saving… counter must not be left stuck by the retry pass.
    expect(useFormStore.getState().savingFormIds[FORM_ID]).toBeUndefined();
  });

  it('tracks failures per slice: a theme failure does not blame meta', async () => {
    mockedUpdateForm.mockResolvedValue({ error: 'boom' } as never);
    useFormStore.getState().updateFormTheme(FORM_ID, { primaryColor: '#123456' });
    await flushFormSaves(FORM_ID);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toEqual(['theme']);
  });

  it('a thrown network error is recorded the same as an error-valued response', async () => {
    mockedUpdateForm.mockRejectedValue(new Error('offline'));
    await useFormStore.getState().updateForm(FORM_ID, { title: 'Offline edit' });
    const { ok } = await flushFormSaves(FORM_ID);
    expect(ok).toBe(false);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toContain('meta');
  });

  it('flushFormSaves with nothing pending and no errors is an ok no-op', async () => {
    const { ok } = await flushFormSaves(FORM_ID);
    expect(ok).toBe(true);
    expect(mockedUpdateForm).not.toHaveBeenCalled();
  });

  it('retryFormSaves retries ONLY the failed slices', async () => {
    mockedUpdateForm.mockResolvedValue({ error: 'boom' } as never);
    useFormStore.getState().updateFormTheme(FORM_ID, { primaryColor: '#123456' });
    await flushFormSaves(FORM_ID);
    mockedUpdateForm.mockClear();

    mockedUpdateForm.mockResolvedValue({ data: { form: seedForm() } } as never);
    const ok = await useFormStore.getState().retryFormSaves(FORM_ID);

    expect(ok).toBe(true);
    expect(mockedUpdateForm).toHaveBeenCalledTimes(1);
    expect(mockedUpdateForm.mock.calls[0][1]).toHaveProperty('theme');
  });

  it('setFormLocal mutates locally without scheduling a server write (publish rollback)', async () => {
    useFormStore.getState().setFormLocal(FORM_ID, { status: 'draft' });
    await flushFormSaves(FORM_ID);
    expect(mockedUpdateForm).not.toHaveBeenCalled();
    expect(useFormStore.getState().forms[0].status).toBe('draft');
  });

  it('deleting a form drops its sticky save errors', async () => {
    mockedUpdateForm.mockResolvedValue({ error: 'boom' } as never);
    await useFormStore.getState().updateForm(FORM_ID, { title: 'x' });
    await flushFormSaves(FORM_ID);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toBeDefined();

    vi.mocked(api).deleteForm = vi.fn(async () => ({ data: { success: true } })) as never;
    await useFormStore.getState().deleteForm(FORM_ID);
    expect(useFormStore.getState().saveErrors[FORM_ID]).toBeUndefined();
  });
});
