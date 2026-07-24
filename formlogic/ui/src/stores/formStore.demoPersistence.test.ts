// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../lib/api';
import { useFormStore } from './formStore';

const initialState = useFormStore.getState();

beforeEach(() => {
  localStorage.clear();
  api.setDemoMode(true);
  useFormStore.setState({ forms: [], storageMode: 'local' });
});

afterEach(() => {
  api.setDemoMode(false);
  useFormStore.setState(initialState, true);
  localStorage.clear();
});

describe('shared-demo form persistence', () => {
  it('stores browser-created forms without caching the seeded catalogue', async () => {
    const local = await useFormStore.getState().createForm('Browser form', '');
    expect(local).not.toBeNull();
    const seeded = { ...local!, id: 'seeded-cloud-form', title: 'Seeded cloud form' };

    useFormStore.setState({ forms: [seeded, local!], storageMode: 'local' });

    const persisted = JSON.parse(localStorage.getItem('formlogic-forms') ?? '{}') as {
      state?: { forms?: Array<{ id: string }> };
    };
    expect(persisted.state?.forms?.map((form) => form.id)).toEqual([local!.id]);
  });
});
