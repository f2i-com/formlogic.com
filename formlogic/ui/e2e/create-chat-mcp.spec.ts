import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { registerTestAccount, sessionHeaders } from './session-request';

// Route scripted model requests through Playwright even when the local site has an installed PWA.
test.use({ serviceWorkers: 'block' });

test('Site AI can create a React starter through MCP in Ask first after the owner approves', async ({ context, page }) => {
  test.setTimeout(100_000);
  const password = 'Local-chat-' + randomUUID();
  const signup = await registerTestAccount(context.request, {
    name: 'MCP creator test', email: 'site-create-' + randomUUID() + '@example.com', password,
  });
  expect(signup.status()).toBe(201);
  const headers = { ...sessionHeaders(), 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value };
  const appName = 'Practice planner';
  const apps = async (): Promise<{name: string; id: string}[]> => (await (await context.request.get('/api/apps')).json()).apps;
  let grantId = '';
  try {
    // Script only the model and its availability. The account, scope, approval and installed app are real.
    await page.route('**/api/ai/preferences', route => route.fulfill({ json: { data: { aiSource: 'site', chatToolMode: 'confirm', siteAiActions: true } } }));
    let round = 0;
    const functionNames: string[][] = [];
    await page.route('**/api/ai/chat', route => {
      const body = route.request().postDataJSON();
      functionNames.push(body.tools.map((tool: {name: string}) => tool.name));
      const ask = ++round === 1 || round === 3;
      return route.fulfill({ json: { data: { stopReason: ask ? 'tool_calls' : 'stop',
        content: ask ? '' : round === 2 ? 'Stopped here.' : 'Your practice planner is ready.',
        toolCalls: ask ? [{ id: 'call-' + round, name: 'call_workspace_tool', arguments: { name: 'create_softn_app', arguments: { name: appName, template: 'react' } } }] : [],
      } } });
    });
    await page.goto('/apps/new');
    await page.getByRole('button', { name: 'Connect MCP', exact: true }).click();
    const modal = page.getByRole('dialog');
    const [minted] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/mcp/tokens' && response.request().method() === 'POST'),
      modal.getByRole('button', { name: 'Use in workspace chat', exact: true }).click(),
    ]);
    grantId = (await minted.json()).id;
    await expect(modal.getByRole('status').filter({ hasText: 'Connected ·' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'React app', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const chat = page.getByRole('region', { name: 'App creation chat' });
    await chat.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(chat.getByText('Stopped here.', { exact: true })).toBeVisible();
    expect(await apps()).toHaveLength(0);
    await chat.getByRole('textbox', { name: 'Chat message' }).fill('Create the practice planner now.');
    await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    const approve = chat.getByRole('button', { name: 'Approve', exact: true }).last();
    await expect(approve).toBeEnabled();
    expect(await apps()).toHaveLength(0);
    await approve.click();
    await expect(chat.getByText('Your practice planner is ready.', { exact: true })).toBeVisible();
    const made = await apps();
    expect(made).toHaveLength(1);
    expect(made[0].name).toBe(appName);
    const installed = await context.request.get('/api/apps/' + made[0].id + '/native');
    expect((await installed.json()).project.files['App.jsx']).toBeTruthy();
    expect(round).toBe(4);
    expect(functionNames.every(names => names.length === 2 && names.includes('call_workspace_tool') && names.includes('list_workspace_tools'))).toBe(true);
  } finally {
    if (grantId) await context.request.delete('/api/mcp/tokens/' + grantId, { headers });
    expect((await context.request.delete('/api/auth/me', { headers, data: { password } })).ok()).toBe(true);
  }
});

test('Create app chat offers only granted tools and runs a Vue starter after approval', async ({ context, page }) => {
  test.setTimeout(90000);
  // A local provider on an origin allowed by FormLogic's production content policy.
  const baseUrl = 'http://127.0.0.1:17872/test-model/v1';
  const endpoint = baseUrl + '/chat/completions';
  const providerId = 'create-test';
  const connection = createHash('sha256').update(JSON.stringify([providerId, endpoint])).digest('hex');
  const name = 'Reading club ' + randomUUID().slice(0, 8);
  const password = 'Local-app-tools-' + randomUUID();
  const signup = await registerTestAccount(context.request, {
    name: 'App creator test', email: 'create-tools-' + randomUUID() + '@example.com', password,
  });
  expect(signup.status()).toBe(201);
  const headers = { ...sessionHeaders(), 'X-CSRF-Token': (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value };
  const user = (await (await context.request.get('/api/auth/me')).json()).user;
  const prefs = { aiSource: 'custom', customProviderId: providerId, chatToolMode: 'confirm' };
  const apiTool = () => context.request.post('/api/ai/chat-tools/custom', { headers, data: { connection, tool: 'list_apps', input: {} } });
  let created = '';
  try {
    expect((await context.request.put('/api/ai/preferences', { headers, data: prefs })).ok()).toBe(true);
    expect((await apiTool()).status()).toBe(403);
    await page.addInitScript(({ userId, providerId, baseUrl }) => {
      localStorage.setItem('formlogic-ai-services:' + userId, JSON.stringify({ v: 1, providers: [{
        id: providerId, name: 'Local test provider', kind: 'custom', baseUrl, model: 'test',
        enabled: true, capabilities: ['chat'], createdAt: '', updatedAt: '',
      }] }));
    }, { userId: user.id, providerId, baseUrl });
    await page.goto('/settings#ai');
    const grant = page.getByRole('checkbox', { name: /Allow workspace tools in chat/ });
    await grant.click();
    await expect(grant).toBeChecked();
    await expect.poll(async () => (await (await context.request.get('/api/ai/preferences')).json()).data?.customToolConnection).toBe(connection);
    let offered = false;
    let hostCredentialsSent = false;
    await page.route(endpoint, async route => {
      const req = route.request();
      const body = req.postDataJSON();
      if (req.headers()['x-csrf-token'] || req.headers()['cookie']) hostCredentialsSent = true;
      offered ||= body.tools?.some((t: { function: { name: string } }) => t.function.name === 'create_softn_app') === true;
      const hasReply = body.messages.some((m: { role: string }) => m.role === 'tool')
        || !body.tools?.some((t: { function: { name: string } }) => t.function.name === 'create_softn_app');
      await route.fulfill({ json: { choices: [{ message: hasReply ? { role: 'assistant', content: 'Your app is ready.' } : {
        role: 'assistant', content: null, tool_calls: [{ id: 'new_vue', type: 'function', function: {
          name: 'create_softn_app', arguments: JSON.stringify({ name, template: 'vue' }),
        } }],
      } }] } });
    });
    await page.goto('/apps/new');
    await page.getByRole('button', { name: 'Vue app', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Describe your app' });
    await composer.fill('Build a Vue app for a reading club');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const approval = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approval).toBeVisible();
    const apps = async (): Promise<{ id: string; name: string }[]> => (await (await context.request.get('/api/apps')).json()).apps;
    expect((await apps()).some(a => a.name === name)).toBe(false);
    await approval.click();
    await expect.poll(async () => { created = (await apps()).find(a => a.name === name)?.id ?? ''; return created; }).not.toBe('');
    const read = await context.request.get('/api/apps/' + created + '/native');
    const project = (await read.json()).project;
    expect(project.version).toBe(1);
    expect(project.files['App.vue']).toContain('<template>');
    expect(project.files['server/main.logic']).toBeTruthy();
    await expect(page.getByText('Your app is ready.', { exact: true })).toBeVisible();
    expect(offered).toBe(true);
    expect(hostCredentialsSent).toBe(false);
    await page.goto('/settings#ai');
    await grant.click();
    await expect(grant).not.toBeChecked();
    await expect.poll(async () => (await apiTool()).status()).toBe(403);
  } finally {
    if (created) await context.request.delete('/api/apps/' + created, { headers });
    expect((await context.request.delete('/api/auth/me', { headers, data: { password } })).ok()).toBe(true);
  }
});
