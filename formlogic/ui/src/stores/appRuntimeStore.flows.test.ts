import { beforeEach, describe, expect, it, vi } from 'vitest';

// The server lets only the app owner and a role granted execute_flows load and run an app's flows
// (FlowController::resolveRuntime answers any other member 403). The runtime starts its flow
// dispatcher only for those viewers, so other members' pages stop logging that refusal.
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
import { useAppRuntimeStore } from './appRuntimeStore';

const state = () => useAppRuntimeStore.getState();

async function open(app: Record<string, unknown>, appLevel: string[]) {
  vi.mocked(api.getAppRuntime).mockResolvedValue({
    data: { app: { id: 'app-1', slug: 'notes', name: 'Notes', ...app }, forms: [], permissions: { appLevel, formLevel: {} }, user: { roleName: 'Member' } },
  } as never);
  await state().initialize('notes');
}

beforeEach(() => {
  vi.mocked(api.getAppRuntime).mockReset();
  state().reset();
});

describe('canRunFlows', () => {
  it('is false before an app has loaded', () => {
    expect(state().canRunFlows()).toBe(false);
  });

  it('is true for the app owner, with or without an explicit grant', async () => {
    await open({ canManage: true }, []);
    expect(state().canRunFlows()).toBe(true);
  });

  it('is true for a member whose role is granted execute_flows', async () => {
    await open({ canManage: false }, ['submit_responses', 'execute_flows']);
    expect(state().canRunFlows()).toBe(true);
  });

  it('is false for a member without execute_flows', async () => {
    await open({ canManage: false }, ['submit_responses', 'view_own_responses']);
    expect(state().canRunFlows()).toBe(false);
  });

  it('is false again once the app is closed', async () => {
    await open({ canManage: true }, []);
    state().reset();
    expect(state().canRunFlows()).toBe(false);
  });
});
