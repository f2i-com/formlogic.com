// The demo-local FORMS bridge: demolocal_ forms live in formStore, but the custom-screen
// Studio (/forms/:id/screen/edit) and Play (/forms/:id/screen) read + save through
// api.getForm/updateForm — these tests pin that in demo mode those api calls serve and
// mutate the store's copy (browser-only) instead of 404ing/403ing against the server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';
import { useFormStore } from '../stores/formStore';

const initialForms = useFormStore.getState().forms;

beforeEach(() => {
  api.setDemoMode(true);
});

afterEach(() => {
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
