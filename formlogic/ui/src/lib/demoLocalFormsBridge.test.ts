// The demo-local FORMS bridge: demolocal_ forms live in formStore, but the custom-screen
// Studio (/forms/:id/screen/edit) and Play (/forms/:id/screen) read + save through
// api.getForm/updateForm — these tests pin that in demo mode those api calls serve and
// mutate the store's copy (browser-only) instead of 404ing/403ing against the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { useFormStore } from '../stores/formStore';

const initialForms = useFormStore.getState().forms;

beforeEach(() => {
  api.setDemoMode(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  api.setDemoMode(false);
  useFormStore.setState({ forms: initialForms });
});

describe('demo-local forms through the api bridge', () => {
  it('getForm serves a demo-created form from the store, and updateForm saves a screen to it', async () => {
    // createForm in demo mode mints a demolocal_ id and never calls the server.
    const created = await useFormStore.getState().createForm('Bridge test', 'demo-local');
    expect(created).not.toBeNull();
    expect(created!.id.startsWith('demolocal_')).toBe(true);

    const fetched = await api.getForm(created!.id);
    expect(fetched.error).toBeUndefined();
    expect(fetched.data?.form.title).toBe('Bridge test');

    // The Studio's save path: updateForm with a customScreen persists into the store.
    const screen = { enabled: true, entry: 'index.ts', files: [{ path: 'index.ts', content: 'export {}' }] };
    const saved = await api.updateForm(created!.id, { customScreen: screen });
    expect(saved.error).toBeUndefined();
    expect(saved.data?.form.customScreen?.files?.[0].path).toBe('index.ts');
    expect(useFormStore.getState().getForm(created!.id)?.customScreen?.enabled).toBe(true);
  });

  it('an unknown demolocal id is an honest 404, never a server request', async () => {
    const missing = await api.getForm('demolocal_does-not-exist');
    expect(missing.status).toBe(404);
    expect(String(missing.error)).toContain('demo form');
    const missingUpdate = await api.updateForm('demolocal_does-not-exist', { title: 'x' });
    expect(missingUpdate.status).toBe(404);
  });

  it('treats local demo forms as a successful fallback when the shared API is unavailable', async () => {
    const created = await useFormStore.getState().createForm('Offline browser form', '');
    expect(created).not.toBeNull();
    vi.spyOn(
      api as unknown as { request: (...args: unknown[]) => Promise<unknown> },
      'request',
    ).mockResolvedValue({ error: 'offline', status: 503 });

    const res = await api.getForms();

    expect(res.error).toBeUndefined();
    expect(res.data?.forms.some((form) => form.id === created!.id)).toBe(true);
  });

  it('adds each local demo form only to the first page of the shared catalogue', async () => {
    const created = await useFormStore.getState().createForm('Paged browser form', '');
    expect(created).not.toBeNull();
    // Reproduce a previously-corrupted persisted snapshot too: the overlay must
    // collapse duplicate local ids before combining them with server results.
    useFormStore.setState({ forms: [created!, created!] });
    vi.spyOn(
      api as unknown as { request: (...args: unknown[]) => Promise<unknown> },
      'request',
    ).mockResolvedValue({ data: { forms: [], count: 216 } });

    const first = await api.getForms({ limit: 200, offset: 0 });
    const second = await api.getForms({ limit: 200, offset: 200 });

    expect(first.data?.forms.filter((form) => form.id === created!.id)).toHaveLength(1);
    expect(first.data?.count).toBe(217);
    expect(second.data?.forms.some((form) => form.id === created!.id)).toBe(false);
    expect(second.data?.count).toBe(217);
  });

  it('outside demo mode the bridge never engages (real ids go to the server path)', async () => {
    api.setDemoMode(false);
    // A demolocal id without demo mode falls through to request(); jsdom has no server,
    // so all we assert is that the STORE copy is not served (the bridge stayed out).
    const created = await useFormStore.getState().createForm('Non-demo', '');
    expect(created).not.toBeNull();
    const res = await api.getForm(created!.id);
    expect(res.data?.form.title).not.toBe('Non-demo');
  });
});
