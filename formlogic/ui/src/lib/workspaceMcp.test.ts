// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { setSessionOwner } from './sessionGeneration';
import { callWorkspaceMcpTool, connectWorkspaceMcp, disconnectWorkspaceMcp, getWorkspaceMcp, listWorkspaceMcpTools } from './workspaceMcp';

vi.mock('./api', () => ({ api: { createMcpToken: vi.fn(), revokeMcpToken: vi.fn(), isAdminActing: () => false, getCsrfToken: () => 'test-only-csrf' } }));

const issue = { appId: 'app-1', creator: false, scopeLabel: 'Sketchbook', connectors: false, extraScopes: [] };
const secret = 'test-only-opaque-credential';
const grant = 'grant-1';
const send = vi.fn<typeof fetch>();
function issued() {
  return { data: { id: grant, token: secret, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), idleTimeout: 900, mcpUrl: 'https://unused.example/api/mcp' } };
}

beforeEach(() => {
  vi.useFakeTimers();
  setSessionOwner('alice');
  vi.mocked(api.createMcpToken).mockReset().mockResolvedValue(issued());
  vi.mocked(api.revokeMcpToken).mockReset().mockResolvedValue({ data: { success: true } });
  send.mockReset().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = request.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
      : request.method === 'tools/list' ? { tools: [
        { name: 'get_form', description: 'Read a form', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'update_form', description: 'Save a form', inputSchema: { type: 'object' } },
      ] } : { content: [{ type: 'text', text: '{"updated":true}' }] };
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  vi.stubGlobal('fetch', send);
});

afterEach(() => { setSessionOwner(null); sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('workspace MCP connection', () => {
  it('uses the local bearer-only transport and the catalog granted to this connection', async () => {
    await connectWorkspaceMcp(issue);
    expect(api.createMcpToken).toHaveBeenCalledWith('app-1', false, false, []);
    expect(getWorkspaceMcp()).toMatchObject({ id: grant, scopeLabel: 'Sketchbook', status: 'connected' });
    expect(JSON.stringify(getWorkspaceMcp())).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    const tools = await listWorkspaceMcpTools(grant);
    expect(tools.map(t => [t.name, t.readOnly])).toEqual([['get_form', true], ['update_form', false]]);
    expect(await callWorkspaceMcpTool(grant, 'update_form', { formId: 'f' })).toEqual({ updated: true });
    expect(send.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const [url, init] of send.mock.calls) {
      expect(url).toBe('/api/mcp');
      expect(init).toMatchObject({ credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'origin' });
      expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer ' + secret);
      expect(new Headers(init!.headers).get('X-CSRF-Token')).toBe('test-only-csrf');
      expect(String(init?.body)).not.toContain(secret);
      expect(String(init?.body)).not.toContain('test-only-csrf');
    }
  });

  it('keeps an ended grant selected and revokes that grant on explicit disconnect', async () => {
    await connectWorkspaceMcp(issue);
    send.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(listWorkspaceMcpTools(grant)).rejects.toThrow('401');
    expect(getWorkspaceMcp()?.status).toBe('unavailable');
    await expect(callWorkspaceMcpTool(grant, 'list_apps', {})).rejects.toThrow('unavailable');
    expect(send).toHaveBeenCalledTimes(3);
    await disconnectWorkspaceMcp(grant);
    expect(api.revokeMcpToken).toHaveBeenCalledWith(grant);
    expect(getWorkspaceMcp()).toBeNull();
  });

  it('fences an earlier turn after expiry and keeps an expired grant selected', async () => {
    await connectWorkspaceMcp(issue);
    vi.advanceTimersByTime(840_000);
    await listWorkspaceMcpTools(grant);
    vi.advanceTimersByTime(899_999);
    expect(getWorkspaceMcp()?.status).toBe('connected');
    vi.advanceTimersByTime(1);
    expect(getWorkspaceMcp()?.status).toBe('expired');
    await expect(callWorkspaceMcpTool(grant, 'update_form', {})).rejects.toThrow('unavailable');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('drops the previous owner, aborts its requests and rejects a late server reply', async () => {
    await connectWorkspaceMcp(issue);
    let release!: (response: Response) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const outbound = listWorkspaceMcpTools(grant);
    const init = send.mock.lastCall![1]!;
    setSessionOwner('bob');
    expect(getWorkspaceMcp()).toBeNull();
    expect(init.signal?.aborted).toBe(true);
    release(Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init.body)).id, result: { tools: [] } }));
    await expect(outbound).rejects.toThrow('unavailable');
    await expect(listWorkspaceMcpTools(grant)).rejects.toThrow('unavailable');
  });

  it('restores only the signed-in owner’s selection after a reload, requiring fresh consent', async () => {
    setSessionOwner(null);
    sessionStorage.setItem('formlogic.workspace-mcp-selection', JSON.stringify({ owner: 'alice', id: grant, scopeLabel: 'Sketchbook', expiresAt: issued().data.expiresAt }));
    setSessionOwner('alice');
    expect(getWorkspaceMcp()).toMatchObject({ id: grant, status: 'unavailable' });
    await expect(listWorkspaceMcpTools(grant)).rejects.toThrow('unavailable');
    expect(send).not.toHaveBeenCalled();
  });
});
