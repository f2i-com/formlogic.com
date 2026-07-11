import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form } from '../../types/form';

/**
 * Acting-mode teardown ordering (data-loss regression):
 *
 * While a platform admin acts on another user's account, the in-memory form
 * store holds the OWNER's forms and persistence is frozen. On exit, the purge
 * MUST run while persistence is still frozen — if the acting flag drops first,
 * the purge's set() writes the purged (owner-less, possibly empty) array over
 * the admin's own localStorage snapshot, and a local-storage-mode admin loses
 * their forms permanently (rehydrate reads back the clobbered snapshot).
 */

const state = vi.hoisted(() => ({ acting: false }));

vi.mock('../../lib/api', () => ({
  api: {
    isDemoMode: () => false,
    isAdminActing: () => state.acting,
    setAdminActing: (v: unknown) => { state.acting = v !== null; },
    getForms: async () => ({ data: { forms: [] } }),
    getApps: async () => ({ data: { apps: [] } }),
    healthCheck: async () => ({ data: { status: 'ok' } }),
    updateForm: vi.fn(),
    deleteForm: vi.fn(),
  },
}));
vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { enterActing, exitActing } from './AdminActingContext';
import { useFormStore } from '../../stores/formStore';

function makeForm(id: string, extra: Record<string, unknown> = {}): Form {
  return {
    id,
    title: `Form ${id}`,
    fields: [],
    settings: { presentationMode: 'both', defaultPresentationMode: 'focused', showProgressBar: true, allowBackNavigation: true, submitButtonText: 'Submit', notifications: { emailNotifications: false }, isClosed: false },
    theme: { primaryColor: '#4f46e5', backgroundColor: '#ffffff', textColor: '#1f2937', fontFamily: 'Inter', borderRadius: 'medium' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    responseCount: 0,
    ...extra,
  } as Form;
}

const memory = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => memory.clear(),
  key: () => null,
  get length() { return memory.size; },
};

describe('acting-mode teardown (local-storage-mode admin)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    memory.clear();
    vi.stubGlobal('localStorage', fakeLocalStorage);
    state.acting = false;
    useFormStore.setState({ forms: [], storageMode: 'local', isInitialized: true, saveErrors: {}, savingFormIds: {}, fieldHistory: {} });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never clobbers the admin snapshot: purge runs while frozen, rehydrate restores the forms', async () => {
    // The admin's own world, persisted while NOT acting.
    const own = makeForm('own-form-1');
    useFormStore.setState({ forms: [own] });
    expect(memory.get('formlogic-forms')).toContain('own-form-1');

    // Enter acting: the owner's forms replace the in-memory slice (as a page's
    // refreshForms would), but the frozen storage drops every persist write.
    enterActing({ ownerId: 'owner-1', ownerEmail: 'owner@x.test' });
    const foreign = makeForm('foreign-form-1', { _adminForeign: true });
    useFormStore.setState({ forms: [foreign] });
    expect(memory.get('formlogic-forms')).toContain('own-form-1');
    expect(memory.get('formlogic-forms')).not.toContain('foreign-form-1');

    // Exit: the purge's set() must ALSO be dropped (it runs before the flag
    // clears), and the flag must be down synchronously so the next page's
    // fetches route to the admin's own endpoints immediately.
    exitActing();
    expect(state.acting).toBe(false);
    expect(memory.get('formlogic-forms')).toContain('own-form-1');
    expect(memory.get('formlogic-forms')).not.toContain('foreign-form-1');
    expect(useFormStore.getState().forms.some((f) => f.id === 'foreign-form-1')).toBe(false);

    // The synchronous rehydrate restores the admin's own forms into memory.
    await useFormStore.persist.rehydrate();
    expect(useFormStore.getState().forms.some((f) => f.id === 'own-form-1')).toBe(true);

    // The debounced network phase must not throw or clobber anything in local mode.
    await vi.advanceTimersByTimeAsync(200);
    expect(useFormStore.getState().forms.some((f) => f.id === 'own-form-1')).toBe(true);
    expect(memory.get('formlogic-forms')).toContain('own-form-1');
  });

  it('an acting-route hop (enterActing within the debounce) cancels the network refetch', async () => {
    enterActing({ ownerId: 'owner-1', ownerEmail: 'owner@x.test' });
    exitActing();
    expect(state.acting).toBe(false);
    // A second boundary mounts right after (settings → builder hop).
    enterActing({ ownerId: 'owner-1', ownerEmail: 'owner@x.test' });
    expect(state.acting).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    // Still acting: the debounced teardown must not have run (it bails/cancels).
    expect(state.acting).toBe(true);
  });
});
