import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Opening a second app before the first has loaded starts two loads, and nothing makes the slow one
// answer first. A late answer used to land on whatever was open by then: the first app's menu and
// role at the second app's address, or "Unable to Load" over a working app. What the store holds
// also decides what the app may use of the viewer's computer, so a late answer from an app they
// manage could wave the next one through.
vi.mock('../lib/api', () => ({
  api: {
    getAppRuntime: vi.fn(),
    onSessionExpired: vi.fn(),
    removeSessionExpiredCallback: vi.fn(),
    isDemoMode: () => false,
  },
  newIdempotencyKey: () => 'key',
}));
vi.mock('../client-runtime/desktop/desktopClient', () => ({ setConnectorCapabilityContext: vi.fn() }));
vi.mock('../client-runtime/connectors/packConnectorDriver', () => ({ syncPackConnectors: vi.fn() }));
vi.mock('../client-runtime/nativeOfflineQueue', () => ({ enqueueNativeSubmission: vi.fn(), flushQueuesWhenDue: vi.fn(async () => null) }));

import { api } from '../lib/api';
import { __resetAppLocalAccessForTests, appMayUseThisComputer } from '../client-runtime/appLocalAccess';
import { syncPackConnectors } from '../client-runtime/connectors/packConnectorDriver';
import { useAppRuntimeStore } from './appRuntimeStore';

const runtime = (slug: string, canManage: boolean) => ({
  data: { app: { id: `id-${slug}`, slug, name: slug, canManage }, forms: [{ formId: `${slug}-form` }], permissions: { formLevel: {} }, user: { roleName: `${slug} role` } },
});

/** Each load's answer, for the test to hand back in the order it wants. */
function deferredLoads() {
  const answers = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  vi.mocked(api.getAppRuntime).mockImplementation((slug: string) => new Promise((resolve, reject) => {
    answers.set(slug, { resolve, reject });
  }) as never);
  return answers;
}

const state = () => useAppRuntimeStore.getState();

beforeEach(() => {
  __resetAppLocalAccessForTests();
  vi.mocked(api.getAppRuntime).mockReset();
  vi.mocked(syncPackConnectors).mockClear();
  state().reset();
  vi.mocked(syncPackConnectors).mockClear();
});

afterEach(() => {
  __resetAppLocalAccessForTests();
});

describe('a load that is no longer the live one', () => {
  it('does not replace the app opened since', async () => {
    const answers = deferredLoads();
    const a = state().initialize('a');
    const b = state().initialize('b');
    answers.get('b')!.resolve(runtime('b', false));
    await b;
    answers.get('a')!.resolve(runtime('a', false));
    await a;

    expect(state().appSlug).toBe('b');
    expect(state().config?.app.slug).toBe('b');
    expect(state().roleName).toBe('b role');
    expect(vi.mocked(syncPackConnectors).mock.calls.map(([config]) => config?.app.slug)).toEqual(['b']);
  });

  it('does not put an error over a working app, by answer or by throwing', async () => {
    for (const fail of ['answer', 'throw'] as const) {
      const answers = deferredLoads();
      const a = state().initialize('a');
      const b = state().initialize('b');
      answers.get('b')!.resolve(runtime('b', false));
      await b;
      if (fail === 'answer') answers.get('a')!.resolve({ error: 'Access denied' });
      else answers.get('a')!.reject(new Error('Network down'));
      await a;

      expect(state().error).toBeNull();
      expect(state().config?.app.slug).toBe('b');
    }
  });

  it('does not end the wait for the app still loading', async () => {
    const answers = deferredLoads();
    const a = state().initialize('a');
    void state().initialize('b');
    answers.get('a')!.resolve(runtime('a', false));
    await a;

    expect(state().config).toBeNull();
    expect(state().isLoading).toBe(true);
  });

  it('does not let an app the viewer manages vouch for the one they moved to', async () => {
    const answers = deferredLoads();
    const a = state().initialize('mine');
    const b = state().initialize('theirs');
    answers.get('theirs')!.resolve(runtime('theirs', false));
    await b;
    answers.get('mine')!.resolve(runtime('mine', true));
    await a;

    // With nobody to ask, an app the viewer doesn't manage is refused.
    expect(await appMayUseThisComputer('theirs')).toBe(false);
  });

  it('does not refill the store after sign-out', async () => {
    const answers = deferredLoads();
    const a = state().initialize('a');
    state().reset();
    answers.get('a')!.resolve(runtime('a', true));
    await a;

    expect(state().config).toBeNull();
    expect(state().appSlug).toBeNull();
    expect(state().isLoading).toBe(false);
    expect(syncPackConnectors).toHaveBeenCalledTimes(1); // only reset()'s teardown
  });

  it('still loads the app when nothing has moved on', async () => {
    const answers = deferredLoads();
    const a = state().initialize('a');
    answers.get('a')!.resolve(runtime('a', true));
    await a;

    expect(state().config?.app.slug).toBe('a');
    expect(await appMayUseThisComputer('a')).toBe(true);
  });
});
