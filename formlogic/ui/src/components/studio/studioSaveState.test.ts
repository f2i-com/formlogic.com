import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackStudioSave, useStudioSaveState } from './studioSaveState';

describe('studioSaveState', () => {
  beforeEach(() => {
    useStudioSaveState.getState().reset();
  });

  it('offers a safe retry for a failed factory operation and clears the failure after success', async () => {
    const operation = vi.fn(async () => (
      operation.mock.calls.length === 1
        ? { error: 'offline' }
        : { data: { ok: true } }
    ));

    await trackStudioSave('Manager permissions', operation, (result) => !result.error);

    expect(useStudioSaveState.getState()).toMatchObject({
      lastError: 'The change could not be saved.',
      failedLabel: 'Manager permissions',
    });
    expect(useStudioSaveState.getState().retry).toEqual(expect.any(Function));

    await useStudioSaveState.getState().retryLast();

    expect(operation).toHaveBeenCalledTimes(2);
    expect(useStudioSaveState.getState()).toMatchObject({
      pending: 0,
      lastLabel: 'Manager permissions',
      lastError: null,
      failedLabel: null,
      retry: null,
    });
  });

  it('does not offer to replay an already-started one-shot promise', async () => {
    await trackStudioSave('Role created', Promise.resolve({ error: 'not created' }), (result) => !result.error);

    expect(useStudioSaveState.getState()).toMatchObject({
      failedLabel: 'Role created',
      retry: null,
    });
  });
});
