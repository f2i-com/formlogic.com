// @vitest-environment jsdom
// Local mode takes the forms in the store as whole forms, and in cloud mode most are rows of the forms
// list with no fields. So the menu loads every form before keeping them on this device, and stays
// in the cloud when one can't be loaded or they don't fit.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useFormStore } from '../../stores/formStore';
import { useToastStore } from '../../stores/toastStore';
import type { Form } from '../../types/form';
import { UserMenu } from './UserMenu';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const field = { id: 'name', type: 'short_text', label: 'Name', required: false, order: 0, properties: {} };
const row = (id: string) => ({ id, title: id, fields: [], fieldCount: 1, settings: {}, theme: {}, updatedAt: '2026-10-01 00:00:00' }) as unknown as Form;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(api, 'healthCheck').mockResolvedValue({ data: { status: 'ok' } } as never);
  vi.spyOn(api, 'getForms').mockResolvedValue({ data: { forms: [] } } as never);
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test', name: 'Ann' } });
  useFormStore.setState({ storageMode: 'api', forms: [row('a'), row('b')], isInitialized: true, isLoading: false, error: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
  useFormStore.setState({ storageMode: 'local', forms: [] });
});

async function chooseThisDevice() {
  await act(async () => { root.render(<MemoryRouter><UserMenu onOpenAuth={() => {}} /></MemoryRouter>); });
  await act(async () => { (host.querySelector('button[aria-label="User menu"]') as HTMLButtonElement).click(); });
  const item = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Keep new forms on this device');
  if (!item) throw new Error(`no such item in: ${host.textContent}`);
  await act(async () => { item.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('Keep new forms on this device', () => {
  it('loads every form first, so none is stored without its fields', async () => {
    vi.spyOn(api, 'getForm').mockImplementation(async (id: string) => ({ data: { form: { ...row(id), fields: [field] } } }) as never);

    await chooseThisDevice();

    expect(useFormStore.getState().storageMode).toBe('local');
    expect(useFormStore.getState().forms.map((f) => f.fields.length)).toEqual([1, 1]);
    const stored = JSON.parse(localStorage.getItem('formlogic-forms') ?? '{}') as { state: { forms: Form[] } };
    expect(stored.state.forms.map((f) => f.fields.length)).toEqual([1, 1]);
  });

  it('stays in the cloud, and says why, when a form cannot be loaded', async () => {
    vi.spyOn(api, 'getForm').mockImplementation(async (id: string) => (
      id === 'b' ? { error: 'Server error (500)', status: 500 } : { data: { form: { ...row(id), fields: [field] } } }
    ) as never);

    await chooseThisDevice();

    expect(useFormStore.getState().storageMode).toBe('api');
    expect(localStorage.getItem('formlogic_storage_mode')).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Could not keep forms on this device');
  });

  // With nothing in `forms` yet, loading "every" form succeeds at once. The switch then told the
  // person their forms were stored, and the list still on its way landed in device storage as rows.
  it.each([
    ['the list is still loading', { forms: [], isLoading: true }],
    ['the list failed to load', { forms: [], error: 'Failed to load forms' }],
  ])('stays in the cloud, and says why, while %s', async (_name, state) => {
    useFormStore.setState(state);

    await chooseThisDevice();

    expect(useFormStore.getState().storageMode).toBe('api');
    expect(localStorage.getItem('formlogic_storage_mode')).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Could not keep forms on this device']);
  });

  it('stays in the cloud when the forms do not fit in this browser’s storage', async () => {
    vi.spyOn(api, 'getForm').mockImplementation(async (id: string) => ({ data: { form: { ...row(id), fields: [field] } } }) as never);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'formlogic-forms' && value.includes('"storageMode":"local"')) throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });

    await chooseThisDevice();

    expect(useFormStore.getState().storageMode).toBe('api');
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Could not keep forms on this device');
  });
});
