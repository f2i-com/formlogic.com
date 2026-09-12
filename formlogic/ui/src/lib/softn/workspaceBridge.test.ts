import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../api', () => ({ api: { getAppRuntime: vi.fn(), getAppResponses: vi.fn() } }));
import { api } from '../api';
import { workspaceBridge } from './workspaceBridge';

describe('connected workspace boundary', () => {
  const runtime = { app: { name: 'Studio' }, forms: [{ formId: 'calls', displayName: 'Calls' }, { formId: 'private', displayName: 'Storage', hidden: true }], permissions: { formLevel: {} } };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getAppRuntime).mockResolvedValue({ data: runtime } as never);
  });
  it('rejects records from outside the current app before querying them', async () => {
    await expect(workspaceBridge('studio', 'workspaceRecords', { formId: 'foreign' }, vi.fn())).rejects.toThrow('not available');
    expect(api.getAppResponses).not.toHaveBeenCalled();
  });
  it('retains server permission denials instead of exposing records', async () => {
    vi.mocked(api.getAppResponses).mockResolvedValue({ error: 'Permission denied' });
    await expect(workspaceBridge('studio', 'workspaceRecords', { formId: 'calls' }, vi.fn())).rejects.toThrow('Permission denied');
    expect(api.getAppResponses).toHaveBeenCalledWith('studio', 'calls', { limit: 12, offset: 0 });
  });
  it('only opens current visible forms through an encoded app route', async () => {
    const navigate = vi.fn();
    await expect(workspaceBridge('studio', 'workspaceOpen', { formId: 'private' }, navigate)).rejects.toThrow('stores data');
    expect(navigate).not.toHaveBeenCalled();
    await workspaceBridge('studio', 'workspaceOpen', { formId: 'calls', url: 'https://untrusted.example' }, navigate);
    expect(navigate).toHaveBeenCalledWith('/app/studio/form/calls');
  });
  it('rechecks app access on every call', async () => {
    await workspaceBridge('studio', 'workspaceInfo', {}, vi.fn());
    vi.mocked(api.getAppRuntime).mockResolvedValue({ error: 'Membership revoked' });
    await expect(workspaceBridge('studio', 'workspaceRecords', { formId: 'calls' }, vi.fn())).rejects.toThrow('Membership revoked');
    expect(api.getAppResponses).not.toHaveBeenCalled();
  });
  it('recognizes app-wide read access without treating management as data access', async () => {
    vi.mocked(api.getAppRuntime).mockResolvedValue({ data: { ...runtime, permissions: { appLevel: ['view_all_responses'], formLevel: {} } } } as never);
    const info = await workspaceBridge('studio', 'workspaceInfo', {}, vi.fn()) as { forms: Array<{ canRead: boolean }> };
    expect(info.forms[0].canRead).toBe(true);
    vi.mocked(api.getAppRuntime).mockResolvedValue({ data: { ...runtime, permissions: { appLevel: ['manage_app'], formLevel: {} } } } as never);
    const restricted = await workspaceBridge('studio', 'workspaceInfo', {}, vi.fn()) as { forms: Array<{ canRead: boolean }> };
    expect(restricted.forms[0].canRead).toBe(false);
  });
  it('passes bounded pagination and preserves structured record details', async () => {
    vi.mocked(api.getAppResponses).mockResolvedValue({ data: { responses: [{id:'r',answers:{caller_name:'Alex',status:'requested'}}],count:30,scope:'all' } });
    const data = await workspaceBridge('studio', 'workspaceRecords', {formId:'calls',offset:12}, vi.fn()) as {records:Array<{answers:Record<string,unknown>}>};
    expect(api.getAppResponses).toHaveBeenCalledWith('studio','calls',{limit:12,offset:12});
    expect(data.records[0].answers.status).toBe('requested');
  });

});
