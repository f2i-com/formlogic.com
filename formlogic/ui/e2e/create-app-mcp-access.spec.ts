import { randomUUID } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import { registerTestAccount, sessionHeaders } from './session-request';

test.use({ serviceWorkers: 'block' }); // Route model requests to the scripted provider in every browser.

/** Only the model is scripted. The scope selection, grant, MCP transport, tool calls and roles are real. */
for (const source of ['custom', 'site'] as const) test(`Create chat with ${source} AI discovers a granted MCP tool, confirms its write, and honors revocation during the next approval`, async ({ page, context, baseURL }) => {
  test.setTimeout(100_000);
  const password = 'Workspace-test-' + randomUUID();
  const signup = await registerTestAccount(context.request, {
    name: 'Workspace tester', email: 'workspace-access-' + randomUUID() + '@example.com', password,
  });
  expect(signup.status()).toBe(201);
  const cookies = await context.cookies();
  const csrf = cookies.find(cookie => cookie.name === 'formlogic_csrf')!.value;
  const headers = { ...sessionHeaders(), 'X-CSRF-Token': csrf };
  const mcp = await request.newContext({ baseURL });
  let grant = '', connectionId = '', revoked = false;
  try {
    const user = (await (await context.request.get('/api/auth/me')).json()).user;
    const providerId = 'workspace-mcp-test';
    const baseUrl = 'http://127.0.0.1:17872/workspace-mcp-test/v1';
    const endpoint = source === 'custom' ? baseUrl + '/chat/completions' : '**/api/ai/chat';
    const prefs = await context.request.put('/api/ai/preferences', { headers, data: {
      aiSource: source, customProviderId: source === 'custom' ? providerId : null, chatToolMode: 'confirm',
    } });
    expect(prefs.ok()).toBe(true);
    if (source === 'custom') {
      await page.addInitScript(({ userId, providerId, baseUrl }) => {
        localStorage.setItem('formlogic-ai-services:' + userId, JSON.stringify({ v: 1, providers: [{
          id: providerId, name: 'Workspace test model', kind: 'custom', baseUrl, model: 'test',
          enabled: true, capabilities: ['chat'], createdAt: '', updatedAt: '',
        }] }));
      }, { userId: user.id, providerId, baseUrl });
      await page.goto('/settings#ai');
      const customGrant = page.getByRole('checkbox', { name: /Allow workspace tools in chat/ });
      await customGrant.click();
      await expect(customGrant).toBeChecked();
      await expect.poll(async () => !!(await (await context.request.get('/api/ai/preferences')).json()).data.customToolConnection).toBe(true);
    } else {
      const site = (await (await context.request.get('/api/ai/preferences')).json()).data;
      test.skip(site.siteAiActions === false, 'This host uses a text-only Site AI.');
    }

    // Only apps made by this connection may be edited. Even an app owned by the same person is outside it.
    const existingApp = await context.request.post('/api/apps', { headers, data: { name: 'Existing workspace' } });
    expect(existingApp.ok()).toBe(true);
    const existingId = (await existingApp.json()).app.id as string;
    await page.goto('/apps/new');
    await page.getByRole('button', { name: 'Connect MCP', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const attach = dialog.getByRole('button', { name: 'Use in workspace chat', exact: true });
    const [mint] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/mcp/tokens' && response.request().method() === 'POST'),
      attach.click(),
    ]);
    const minted = await mint.json();
    grant = minted.token;
    connectionId = minted.id;
    expect(Boolean(grant && connectionId)).toBe(true);
    await expect(dialog.getByRole('status').filter({ hasText: 'Connected · Apps made by this connection' })).toBeVisible();
    expect(await page.evaluate(secret =>
      [document.body.innerText, JSON.stringify(localStorage), JSON.stringify(sessionStorage)].some(text => text.includes(secret)), grant)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const sessions = await (await context.request.get('/api/mcp/tokens')).json();
    const session = sessions.sessions.find((s: { id: string }) => s.id === connectionId);
    expect(session.creator).toBe(true);
    expect(session.scopes).not.toContain('responses:write');

    const create = await mcp.post('/api/mcp', { headers: { Authorization: 'Bearer ' + grant }, data: {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_app', arguments: { name: 'Connected workspace' } },
    } });
    const created = (await create.json()).result;
    expect(created.isError).not.toBe(true);
    const appId = JSON.parse(created.content[0].text).id as string;
    const roles = async () => (await (await context.request.get('/api/apps/' + appId + '/roles')).json()).roles.map((r: { name: string }) => r.name);
    const approvedRole = 'Review team', revokedRole = 'Late proposal';
    const steps = [
      { name: 'list_workspace_tools', arguments: { query: 'create_app_role' } },
      { name: 'call_workspace_tool', arguments: { name: 'list_app_roles', arguments: { appId: existingId } } },
      { name: 'call_workspace_tool', arguments: { name: 'create_app_role', arguments: { appId, name: approvedRole } } },
      { name: 'call_workspace_tool', arguments: { name: 'create_app_role', arguments: { appId, name: revokedRole } } },
    ];
    const feedback: string[] = [];
    const requestedNames: string[][] = [];
    let round = 0, secretReachedModel = false, fallbackCalls = 0;
    page.on('request', req => {
      if (new URL(req.url()).pathname === '/api/ai/chat-tools/custom') fallbackCalls++;
    });
    await page.route(endpoint, async route => {
      const req = route.request();
      const allHeaders = await req.allHeaders();
      // The same-origin Site AI route authenticates the browser; the model is given its body.
      // A directly connected external provider must receive neither the browser cookies nor CSRF.
      const wire = (source === 'custom' ? JSON.stringify(allHeaders) : '') + (req.postData() || '');
      secretReachedModel ||= (source === 'custom' && Boolean(allHeaders.cookie || allHeaders['x-csrf-token']))
        || [grant, ...cookies.map(cookie => cookie.value).filter(value => value.length > 15)].some(secret => wire.includes(secret));
      const body = req.postDataJSON();
      requestedNames.push(Array.isArray(body.tools) ? body.tools.map((t: { name?: string; function?: { name: string } }) => t.name ?? t.function?.name) : []);
      const toolMessages = body.messages.filter((m: { role: string }) => m.role === 'tool');
      if (toolMessages.length) feedback.push(toolMessages.at(-1).content);
      const action = steps[round++];
      if (source === 'site') {
        await route.fulfill({ json: { data: {
          content: action ? '' : 'Finished checking the connection.',
          toolCalls: action ? [{ id: 'call_' + round, ...action }] : [],
          stopReason: action ? 'tool_calls' : 'stop',
        } } });
        return;
      }
      const message = action ? { role: 'assistant', content: null, tool_calls: [{
        id: 'call_' + round, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) },
      }] } : { role: 'assistant', content: 'Finished checking the connection.' };
      await route.fulfill({ json: { choices: [{ message }] } });
    });
    await page.getByRole('textbox', { name: 'Describe your app' }).fill('Check the scope of my connection, then ask before creating each requested role.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const approve = page.getByRole('button', { name: 'Approve', exact: true, disabled: false });
    await expect(approve).toBeVisible();
    expect(await roles()).not.toContain(approvedRole);
    expect(feedback[0]).toContain('create_app_role');
    expect(feedback[1]).toMatch(/only|scope|created by|did not create|connection/i);
    await approve.click();
    await expect.poll(roles).toContain(approvedRole);
    await expect.poll(() => round).toBeGreaterThanOrEqual(4);
    await expect(approve).toBeVisible();
    expect(await roles()).not.toContain(revokedRole);
    const remove = await context.request.delete('/api/mcp/tokens/' + connectionId, { headers });
    expect(remove.ok()).toBe(true);
    revoked = true;
    const denial = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mcp' && [401, 403].includes(response.status()));
    await approve.click();
    await denial;
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
    expect(await roles()).not.toContain(revokedRole);
    expect(fallbackCalls).toBe(0);
    expect(requestedNames.every(names => names.length === 2 && names.includes('list_workspace_tools') && names.includes('call_workspace_tool'))).toBe(true);
    expect(secretReachedModel).toBe(false);
  } finally {
    if (connectionId && !revoked) await context.request.delete('/api/mcp/tokens/' + connectionId, { headers });
    await mcp.dispose();
    const deleted = await context.request.delete('/api/auth/me', { headers, data: { password } });
    expect(deleted.ok()).toBe(true);
  }
});
