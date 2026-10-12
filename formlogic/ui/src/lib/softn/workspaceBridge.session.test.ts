import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../api', () => ({ api: { getAppRuntime: vi.fn(), getAppResponses: vi.fn() } }));
import { api } from '../api';
import { workspaceBridge } from './workspaceBridge';
const config = { app: { name: 'Workspace' }, forms: [{ formId: 'f1', displayName: 'Notes' }], permissions: { formLevel: {} } };
type GuardedBridge = (slug: string, action: string, input: Record<string, unknown>, navigate: (path: string) => void, isCurrent: () => boolean) => Promise<unknown>;
const guarded = workspaceBridge as GuardedBridge;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.getAppRuntime).mockResolvedValue({ data: config } as Awaited<ReturnType<typeof api.getAppRuntime>>); });
it.each(['workspaceOpen', 'workspaceDashboard', 'workspaceRecords'])('does not continue a late %s lookup after a session boundary', async action => {
  let resolve!: (value: unknown) => void; let current = true;
  vi.mocked(api.getAppRuntime).mockReturnValue(new Promise(done => { resolve = done as typeof resolve; }));
  const navigate = vi.fn(); const result = guarded('notes', action, { formId: 'f1' }, navigate, () => current).catch(() => undefined);
  current = false; resolve({ data: config }); await result;
  expect(navigate).not.toHaveBeenCalled(); expect(api.getAppResponses).not.toHaveBeenCalled();
});
it('does not issue even the initial lookup for a stale frame', async () => {
  await guarded('notes', 'workspaceInfo', {}, vi.fn(), () => false).catch(() => undefined);
  expect(api.getAppRuntime).not.toHaveBeenCalled();
});
it('keeps current-session navigation available', async () => {
  const navigate = vi.fn(); await guarded('notes', 'workspaceOpen', { formId: 'f1' }, navigate, () => true);
  expect(navigate).toHaveBeenCalledWith('/app/notes/form/f1');
});
