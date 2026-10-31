// @vitest-environment jsdom
// Device-only forms and their responses exist nowhere else, and a session ends by itself every day.
// So a session that expired leaves them, with the choice of mode, for the same person to come back
// to. They have no owner of their own: another account's sign-in erases them, or it would see them
// and could move them into its own account. A sign-out still removes them, having warned first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/chat/chatStore', () => ({ deleteChatDataForUser: vi.fn(async () => {}) }));
vi.mock('./vaultStore', () => ({ lockVaultForSessionTeardown: vi.fn(), useVaultStore: { setState: vi.fn(), getState: () => ({ lock: vi.fn() }) } }));
vi.mock('../lib/api', () => {
  const named: Record<string, unknown> = { logout: vi.fn(async () => ({})) };
  return {
    api: new Proxy(named, { get: (target, key: string) => (key in target ? target[key] : (target[key] = vi.fn(() => false))) }),
    newIdempotencyKey: () => 'key',
  };
});

import { api } from '../lib/api';
import { deviceFormsOnSignOut, handleSessionBroadcast, teardownUserSession, useAuthStore } from './authStore';
import { useFormStore } from './formStore';
import { useResponseStore } from './responseStore';
import { readModelCatalogCache, readProviderCatalogCache, writeModelCatalogCache, writeProviderCatalogCache } from '../components/settings/aiModelCatalog';
import type { Form, LocalFormResponse } from '../types/form';

const form = (id: string) => ({ id, title: id, fields: [], settings: {}, theme: {} }) as unknown as Form;
const response = { id: 'r1', formId: 'mine', answers: { a: 1 }, submittedAt: '2026-10-01T00:00:00.000Z', completionTime: 1 } as unknown as LocalFormResponse;

const stored = (key: string) => JSON.parse(localStorage.getItem(key) ?? '{}') as { state?: { forms?: Form[]; responses?: LocalFormResponse[]; deviceFormsOwner?: string | null } };

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
  useFormStore.setState({ storageMode: 'local', forms: [form('mine')], pendingDeletions: [], deviceFormsOwner: null });
  useResponseStore.setState({ responses: [response] });
  localStorage.setItem('formlogic_storage_mode', 'local');
});

afterEach(() => {
  useAuthStore.setState({ user: null });
  useFormStore.setState({ storageMode: 'local', forms: [], deviceFormsOwner: null });
  useResponseStore.setState({ responses: [] });
});

function expectKept() {
  expect(useFormStore.getState().forms.map((f) => f.id)).toEqual(['mine']);
  expect(useResponseStore.getState().responses.map((r) => r.id)).toEqual(['r1']);
  expect(stored('formlogic-forms').state?.forms?.map((f) => f.id)).toEqual(['mine']);
  expect(stored('formlogic-responses').state?.responses?.map((r) => r.id)).toEqual(['r1']);
  expect(localStorage.getItem('formlogic_storage_mode')).toBe('local');
}

function expectErased() {
  expect(useFormStore.getState().forms).toEqual([]);
  expect(useResponseStore.getState().responses).toEqual([]);
  expect(stored('formlogic-forms').state?.forms ?? []).toEqual([]);
  expect(stored('formlogic-responses').state?.responses ?? []).toEqual([]);
  expect(localStorage.getItem('formlogic_storage_mode')).toBeNull();
}

describe('a session that expires in device-only mode', () => {
  it('leaves the forms, their responses and the mode', async () => {
    useAuthStore.setState({ user: null });
    await teardownUserSession('u1', 'session-expired', false);
    expectKept();
    expect(useFormStore.getState().deviceFormsOwner).toBe('u1');
  });

  it('leaves them for the same person, who signs in to find them', async () => {
    await teardownUserSession('u1', 'session-expired', false);
    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });
    expectKept();
    expect(useFormStore.getState().deviceFormsOwner).toBeNull();
  });

  it('erases them when another account signs in', async () => {
    await teardownUserSession('u1', 'session-expired', false);
    useAuthStore.setState({ user: { id: 'u2', email: 'b@example.test' } });
    expectErased();
    expect(useFormStore.getState().deviceFormsOwner).toBeNull();
  });

  it('keeps them in a sibling tab’s memory, whose next edit would otherwise empty storage', async () => {
    await handleSessionBroadcast({ type: 'fl-teardown', reason: 'session-expired', userId: 'u1' });
    expect(useAuthStore.getState().user).toBeNull();
    expect(useFormStore.getState().forms.map((f) => f.id)).toEqual(['mine']);
    expect(useResponseStore.getState().responses.map((r) => r.id)).toEqual(['r1']);
  });

  it('forgets them in a sibling tab’s memory when another account signs in there', async () => {
    await handleSessionBroadcast({ type: 'fl-teardown', reason: 'session-expired', userId: 'u1' });
    const before = localStorage.getItem('formlogic-forms');
    await handleSessionBroadcast({ type: 'fl-session-transition', userId: 'u2', revision: 'r-2', ordered: false });
    expect(useFormStore.getState().forms).toEqual([]);
    expect(localStorage.getItem('formlogic-forms')).toBe(before); // the tab it happened in owns storage
  });

  it('does not keep a form an admin’s acting session loaded', async () => {
    useFormStore.setState({ forms: [form('mine'), { ...form('theirs'), _adminForeign: true } as Form] });
    await teardownUserSession('u1', 'session-expired', false);
    expect(useFormStore.getState().forms.map((f) => f.id)).toEqual(['mine']);
  });
});

// A device-only user whose session expired lands on the home page and opens the demo. The demo can't
// use these forms, so erasing them for it protects nothing; its writes and its sign-out must not
// reach them either, and it starts as it does in any browser.
describe('a demo session', () => {
  const demoUser = { id: 'demo', email: 'demo@example.test', isDemo: true };
  afterEach(() => { vi.mocked(api.isDemoMode).mockReturnValue(false); });

  async function expireThenOpenTheDemo() {
    await teardownUserSession('u1', 'session-expired', false);
    useAuthStore.setState({ user: null });
    vi.mocked(api.isDemoMode).mockReturnValue(true);
    useAuthStore.setState({ user: demoUser });
  }

  it('starts without them, in the mode a fresh browser has', async () => {
    await expireThenOpenTheDemo();
    expect(useFormStore.getState().forms).toEqual([]);
    expect(useResponseStore.getState().responses).toEqual([]);
    expect(localStorage.getItem('formlogic_storage_mode')).toBeNull();
  });

  it('gives them back to their owner, after its writes and its sign-out', async () => {
    await expireThenOpenTheDemo();
    useFormStore.setState({ storageMode: 'api', forms: [form('seeded')] });
    localStorage.setItem('formlogic_storage_mode', 'api');
    await useAuthStore.getState().logout();
    vi.mocked(api.isDemoMode).mockReturnValue(false);

    useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test' } });

    expectKept();
    expect(useFormStore.getState().storageMode).toBe('local');
    expect(useFormStore.getState().deviceFormsOwner).toBeNull();
  });

  it('leaves them to be erased by another account’s sign-in, as ever', async () => {
    await expireThenOpenTheDemo();
    await useAuthStore.getState().logout();
    vi.mocked(api.isDemoMode).mockReturnValue(false);

    useAuthStore.setState({ user: { id: 'u2', email: 'b@example.test' } });

    expect(useFormStore.getState().forms).toEqual([]);
    expect(Object.keys(localStorage).filter((key) => key.includes('parked'))).toEqual([]);
  });

  it('touches nothing for someone with nothing kept', async () => {
    useFormStore.setState({ deviceFormsOwner: null });
    vi.mocked(api.isDemoMode).mockReturnValue(true);
    useAuthStore.setState({ user: demoUser });
    expect(useFormStore.getState().forms.map((f) => f.id)).toEqual(['mine']);
    expect(Object.keys(localStorage).filter((key) => key.includes('parked'))).toEqual([]);
  });
});

// Storage mode is held per tab, and both tabs share one storage. A cloud tab beside a device tab
// decided from its own memory, so its sign-out gave no warning and its expiry cleared the forms.
describe('this tab in the cloud, a tab beside it on this device', () => {
  const asStoredByTheOtherTab = (forms: Form[]) => JSON.stringify({ state: { forms, storageMode: 'local', pendingDeletions: [], deviceFormsOwner: null }, version: 0 });

  beforeEach(() => {
    const responses = localStorage.getItem('formlogic-responses');
    useFormStore.setState({ storageMode: 'api', forms: [form('cloud-row')] });
    useResponseStore.setState({ responses: [] });
    localStorage.setItem('formlogic-forms', asStoredByTheOtherTab([form('mine')]));
    localStorage.setItem('formlogic-responses', responses as string);
    // This tab goes on working: every write of a persisted store sends out its whole snapshot.
    useFormStore.setState({ isLoading: false });
    useResponseStore.setState({ currentStep: 0 });
  });

  it('counts the stored forms for the sign-out warning', () => {
    expect(deviceFormsOnSignOut()).toBe(1);
  });

  it('keeps them when the session expires here', async () => {
    await teardownUserSession('u1', 'session-expired', false);
    expectKept();
    expect(useFormStore.getState().deviceFormsOwner).toBe('u1');
  });

  it('leaves them to a sign-out here, which the warning has named', async () => {
    await teardownUserSession('u1', 'logout', false);
    expect(localStorage.getItem('formlogic-forms')).toBeNull();
  });

  // The hold is on a tab's writes while the device mode stands, not on leaving that mode.
  it('stops holding the stored forms once the person moves to the cloud', async () => {
    useFormStore.setState({ isInitialized: false, isLoading: false });
    useFormStore.getState().setStorageMode('api');
    await vi.waitFor(() => expect(stored('formlogic-forms').state?.forms).toEqual([]));
  });
});

describe('what does not keep them', () => {
  it('a sign-out', async () => {
    await teardownUserSession('u1', 'logout', false);
    expectErased();
  });

  it('an expiry in cloud mode, which has nothing of its own on the device', async () => {
    localStorage.setItem('formlogic_storage_mode', 'api');
    useFormStore.setState({ storageMode: 'api' });
    await teardownUserSession('u1', 'session-expired', false);
    expect(useFormStore.getState().forms).toEqual([]);
    expect(localStorage.getItem('formlogic-forms')).toBeNull();
    expect(useFormStore.getState().deviceFormsOwner).toBeNull();
  });

  it('an expiry of the shared demo', async () => {
    vi.mocked(api.isDemoMode).mockReturnValueOnce(true);
    await teardownUserSession('u1', 'session-expired', false);
    expect(useFormStore.getState().forms).toEqual([]);
  });
});

describe('the count for the sign-out warning', () => {
  it('is what a sign-out would take off the device', () => {
    useFormStore.setState({ forms: [form('a'), form('b'), { ...form('theirs'), _adminForeign: true } as Form] });
    expect(deviceFormsOnSignOut()).toBe(2);
  });

  it('is nothing in cloud mode or in the demo', () => {
    localStorage.setItem('formlogic_storage_mode', 'api');
    useFormStore.setState({ storageMode: 'api' });
    expect(deviceFormsOnSignOut()).toBe(0);
    localStorage.setItem('formlogic_storage_mode', 'local');
    useFormStore.setState({ storageMode: 'local' });
    vi.mocked(api.isDemoMode).mockReturnValueOnce(true);
    expect(deviceFormsOnSignOut()).toBe(0);
  });
});

// The account's desktop answered these; they must not fill the next account's AI pickers.
describe('the desktop provider and model lists', () => {
  it.each(['logout', 'session-expired'] as const)('are dropped on %s', async (reason) => {
    writeProviderCatalogCache([]);
    writeModelCatalogCache('provider-a', [{ id: 'm', label: 'M' }]);
    await teardownUserSession('u1', reason, false);
    expect(readProviderCatalogCache()).toBeNull();
    expect(readModelCatalogCache('provider-a')).toBeNull();
  });
});
