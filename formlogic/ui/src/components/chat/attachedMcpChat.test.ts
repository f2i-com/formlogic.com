import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDefaultLlmTools, type AiPreferences } from '../../client-runtime/flows/aiDefault';
import { callWorkspaceMcpTool, getWorkspaceMcp, listWorkspaceMcpTools } from '../../lib/workspaceMcp';
import { sendChatTurn, type ChatToolProposal } from './chatEngine';

vi.mock('../../client-runtime/flows/aiDefault', async importOriginal => ({
  ...await importOriginal<typeof import('../../client-runtime/flows/aiDefault')>(), resolveDefaultLlmTools: vi.fn(),
}));
vi.mock('../../lib/workspaceMcp', () => ({ getWorkspaceMcp: vi.fn(), listWorkspaceMcpTools: vi.fn(), callWorkspaceMcpTool: vi.fn() }));

const grant = { id: 'scoped', expiresAt: '', scopeLabel: 'Test app', status: 'connected' } as const;
const prefs: AiPreferences = { aiSource: 'site', chatToolMode: 'confirm', desktopProviderId: null, desktopModel: null, customProviderId: null };
const catalog = [
  { name: 'list_app_roles', description: 'List roles', inputSchema: { type: 'object' }, readOnly: true },
  { name: 'create_app_role', description: 'Create a role', inputSchema: { type: 'object', required: ['name'] }, readOnly: false },
];
const fetchPreferences = vi.fn(async () => ({ ok: true, data: prefs }) as const);
const turn = { threadId: 't', messages: [{ role: 'user', content: 'Set up a reviewer role' }] };
const model = vi.mocked(resolveDefaultLlmTools);
function request(name: string, args: Record<string, unknown>) {
  model.mockResolvedValueOnce({ ok: true, data: { source: 'site', text: '', stopReason: 'tool_calls', toolCalls: [{ id: 'step', name, arguments: args }] } });
}
function finish() {
  model.mockResolvedValueOnce({ ok: true, data: { source: 'site', text: 'Finished', stopReason: 'stop', toolCalls: [] } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getWorkspaceMcp).mockReturnValue(grant);
  vi.mocked(listWorkspaceMcpTools).mockResolvedValue(catalog);
  fetchPreferences.mockResolvedValue({ ok: true, data: prefs });
});

describe('attached MCP in workspace chat', () => {
  it('continues building through MCP after creating a starter with a brief', async () => {
    vi.mocked(listWorkspaceMcpTools).mockResolvedValue(['create_softn_app', 'get_native_app_project', 'update_native_app_files']
      .map(name => ({ name, description: name, inputSchema: { type: 'object' }, readOnly: name === 'get_native_app_project' })));
    vi.mocked(callWorkspaceMcpTool).mockResolvedValueOnce({ app: { id: 'reading-room' }, request: 'Build a reading journal' })
      .mockResolvedValueOnce({ version: 1 }).mockResolvedValueOnce({ version: 2 });
    for (const [name, args] of [
      ['create_softn_app', { template: 'react', name: 'Reading Room', request: 'Build a reading journal' }],
      ['get_native_app_project', { appId: 'reading-room' }],
      ['update_native_app_files', { appId: 'reading-room', expectedVersion: 1, files: { 'App.jsx': 'export default () => null' } }],
    ] as const) {
      request('list_workspace_tools', { query: name });
      request('call_workspace_tool', { name, arguments: args });
    }
    finish();
    const activity = vi.fn();
    const out = await sendChatTurn({ ...turn, events: { onToolActivity: activity, onToolProposal: p => p.respond!(true) } }, { fetchPreferences });
    expect(out.ok).toBe(true);
    expect(activity.mock.calls[0][0].link).toEqual({ kind: 'softnApp', id: 'reading-room' });
    expect(callWorkspaceMcpTool).toHaveBeenCalledTimes(3);
  });

  it('discovers only granted names and their real schemas with two model functions', async () => {
    request('list_workspace_tools', {});
    request('list_workspace_tools', { query: 'create_app_role' });
    request('call_workspace_tool', { name: 'create_softn_app', arguments: {} });
    finish();
    expect(await sendChatTurn(turn, { fetchPreferences })).toMatchObject({ ok: true });
    const { messages, tools } = model.mock.calls.at(-1)![0];
    expect(tools.map(t => t.name)).toEqual(['list_workspace_tools', 'call_workspace_tool']);
    const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    expect(results).toEqual([{ tools: catalog.map(t => t.name) }, catalog[1], { error: expect.stringContaining('unavailable') }]);
    expect(callWorkspaceMcpTool).not.toHaveBeenCalled();
  });

  it('runs reads, checks Ask first against the underlying write, and honors denial', async () => {
    request('call_workspace_tool', { name: 'list_app_roles', arguments: {} });
    request('call_workspace_tool', { name: 'create_app_role', arguments: { name: 'Reviewer', approved: true } });
    finish();
    const proposal = vi.fn((p: ChatToolProposal) => { p.respond!(false); });
    expect(await sendChatTurn({ ...turn, events: { onToolProposal: proposal } }, { fetchPreferences })).toMatchObject({ ok: true });
    expect(callWorkspaceMcpTool).toHaveBeenCalledTimes(1);
    expect(callWorkspaceMcpTool).toHaveBeenCalledWith('scoped', 'list_app_roles', {}, expect.any(AbortSignal));
    expect(proposal).toHaveBeenCalledTimes(1);
    expect(proposal).toHaveBeenCalledWith(expect.objectContaining({ tool: 'create_app_role', input: { name: 'Reviewer', approved: true } }));
  });

  it('cannot transfer a pending approval to a replacement grant', async () => {
    request('call_workspace_tool', { name: 'create_app_role', arguments: { name: 'Reviewer' } });
    const proposal = (p: ChatToolProposal) => {
      vi.mocked(getWorkspaceMcp).mockReturnValue({ ...grant, id: 'broader-replacement' });
      p.respond!(true);
    };
    const out = await sendChatTurn({ ...turn, events: { onToolProposal: proposal } }, { fetchPreferences });
    expect(out).toMatchObject({ ok: false, error: { code: 'mcp_unavailable' } });
    expect(callWorkspaceMcpTool).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('keeps a revoked grant or an unsupported desktop source from reaching account-wide tools', async () => {
    const mintToolGrant = vi.fn();
    const tunnelChat = vi.fn();
    const fetchFn = vi.fn();
    vi.mocked(getWorkspaceMcp).mockReturnValue({ ...grant, status: 'unavailable' });
    expect(await sendChatTurn(turn, { fetchPreferences, fetchFn })).toMatchObject({ ok: false, source: 'site' });
    vi.mocked(getWorkspaceMcp).mockReturnValue(grant);
    fetchPreferences.mockResolvedValue({ ok: true, data: { ...prefs, aiSource: 'desktop' } });
    expect(await sendChatTurn(turn, { fetchPreferences, mintToolGrant, tunnelChat })).toMatchObject({ ok: false, source: 'desktop' });
    expect(model).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mintToolGrant).not.toHaveBeenCalled();
    expect(tunnelChat).not.toHaveBeenCalled();
  });
});
