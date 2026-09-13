import { expect, test } from '@playwright/test';

test('A browser app saves through its .logic backend into the project SQLite database', async ({ page, context }) => {
  test.setTimeout(120_000);
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Requires the isolated local review account.');
  const login = await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  expect(login.ok()).toBe(true);
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value };
  const listed = await (await context.request.get('/api/apps')).json();
  let app = listed.apps.find((item: { slug: string }) => item.slug === 'native-notes-review');
  if (!app) {
    const created = await context.request.post('/api/apps', { headers, data: { name: 'Native notes — local review', slug: 'native-notes-review' } });
    expect(created.status()).toBe(201);
    app = (await created.json()).app;
  }
  const existing = await (await context.request.get(`/api/apps/${app.id}/native`)).json();
  const title = `Browser note ${Date.now()}`;
  const project = { home: true, access: 'members', assets: {}, files: {
    'manifest.json': JSON.stringify({ id: 'com.formlogic.review.notes', name: 'Native notes', version: '1.0.0', main: 'ui/main.ui', config: { server: { allowedOrigins: ['https://notes.example'] } }, server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: [{ path: '/api/notes', method: 'POST', handler: 'createNote', transaction: 'write', authorization: 'anonymous' }],
    } }),
    'ui/main.ui': `<logic>
var message = 'Ready';
function saveNote() {
  softn.net.fetch('https://notes.example/api/notes', {method:'POST',body:{title:${JSON.stringify(title)}}}, function(response) {
    var result = JSON.parse(response.body);
    message = response.ok ? 'Saved: ' + result.title : 'Error: ' + (result.error || response.status);
  });
}
</logic>
<Stack padding="24"><Text>Native notes</Text><Button onClick={saveNote}>Save example note</Button><Text>{message}</Text></Stack>`,
    'server/main.logic': 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES(?)",[req.body.title]); return {status:201,body:{title:req.body.title,actor:req.context.formlogic.userId}}; }',
    'server/migrations/001.sql': 'CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT);',
  } };
  const saved = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: existing.project?.version ?? 0 } });
  expect(saved.status(), await saved.text()).toBe(200);
  const flowSlug = 'native-record-review';
  const currentFlows = (await (await context.request.get(`/api/apps/${app.id}/flows`)).json()).flows;
  const flowPayload = { name: 'Review new record', slug: flowSlug, enabled: true, executionLocation: 'auto', flowJson: {
    nodes: [{ id: 'in', type: 'input', position: { x: 0, y: 0 } }, { id: 'out', type: 'output', position: { x: 250, y: 0 } }],
    edges: [{ id: 'in-out', source: 'in', target: 'out' }],
  } };
  const existingFlow = currentFlows.find((item: { slug: string }) => item.slug === flowSlug);
  const flowResponse = existingFlow
    ? await context.request.put(`/api/apps/${app.id}/flows/${existingFlow.id}`, { headers, data: flowPayload })
    : await context.request.post(`/api/apps/${app.id}/flows`, { headers, data: flowPayload });
  expect(flowResponse.ok(), await flowResponse.text()).toBe(true);
  const flow = (await flowResponse.json()).flow;
  const bindings = (await (await context.request.get(`/api/apps/${app.id}/flow-bindings`)).json()).bindings;
  await page.goto(`/apps/${app.id}/studio/automations`);
  await page.getByRole('button', { name: 'Connect database event', exact: true }).click();
  await page.getByLabel('Database event table', { exact: true }).selectOption('notes');
  await page.getByLabel('Database event flow', { exact: true }).selectOption(flow.id);
  if (!bindings.some((binding: { event: string; flowDefinitionId: string }) => binding.event === 'app.record.created.notes' && binding.flowDefinitionId === flow.id)) {
    await page.getByRole('button', { name: 'Connect trigger', exact: true }).click();
    await expect(page.getByText('Trigger connected. Future committed changes will queue this flow.', { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Database automations' }).getByText('notes · record created', { exact: true })).toBeVisible();
  await page.screenshot({ path: '../../../ecosystem-audit/native-record-automations-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await page.getByRole('region', { name: 'Database automations' }).boundingBox())?.width ?? 0).toBeGreaterThan(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: 'Connect trigger', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../../ecosystem-audit/native-record-automations-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  let externalRequests = 0;
  page.on('request', request => { if (new URL(request.url()).hostname === 'notes.example') externalRequests++; });
  await page.goto(`/app/${app.slug}`);
  const frame = page.frameLocator('iframe[title="Hosted app"]');
  const nativeResponse = page.waitForResponse(response => response.url().endsWith(`/api/app/${app.slug}/native/request`));
  await frame.getByRole('button', { name: 'Save example note', exact: true }).click();
  expect((await (await nativeResponse).json()).result.body.actor).toBe(app.ownerId);
  await expect(frame.getByText(`Saved: ${title}`, { exact: true })).toBeVisible();
  expect(externalRequests).toBe(0);
  const rows = await (await context.request.get(`/api/apps/${app.id}/native/records?table=notes`)).json();
  expect(rows.rows.some((row: { title: string }) => row.title === title)).toBe(true);
  // The member app's browser dispatcher claims the queued event and resolves inputMap.
  await expect.poll(async () => {
    const history = await (await context.request.get(`/api/apps/${app.id}/flow-runs?flowId=${flow.id}`)).json();
    return history.runs.find((run: { inputSnapshot?: { event?: { data?: { record?: { title?: string } } } } }) => run.inputSnapshot?.event?.data?.record?.title === title)?.status;
  }, { timeout: 60_000 }).toBe('done');
  const history = await (await context.request.get(`/api/apps/${app.id}/flow-runs?flowId=${flow.id}`)).json();
  const completed = history.runs.find((run: { inputSnapshot?: { event?: { data?: { record?: { title?: string } } } } }) => run.inputSnapshot?.event?.data?.record?.title === title);
  expect(JSON.stringify(completed.result)).toContain(title);
  await page.goto(`/apps/${app.id}/records`);
  await page.getByRole('button', { name: 'Database records', exact: true }).click();
  await page.getByLabel('Database table', { exact: true }).selectOption('notes');
  const recordBrowser = page.getByRole('region', { name: 'Database records browser', exact: true });
  await expect(recordBrowser.getByRole('table').getByText(title, { exact: true })).toBeVisible();
  await recordBrowser.getByRole('searchbox', { name: 'Filter records on this page' }).fill(title);
  await recordBrowser.getByRole('button', { name: /^View record / }).click();
  await expect(recordBrowser.getByRole('heading', { name: /^Record [0-9]+$/, level: 4 })).toBeVisible();
  await page.screenshot({ path: '../../../ecosystem-audit/native-record-browser-desktop.png' });
  await recordBrowser.getByRole('button', { name: 'Close record details', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(recordBrowser.getByRole('table')).toHaveCount(0);
  await expect(recordBrowser.getByRole('article')).toHaveCount(1);
  await expect(recordBrowser.getByRole('article').getByText(title, { exact: true })).toBeVisible();
  await recordBrowser.getByRole('button', { name: 'View details', exact: true }).click();
  await expect(recordBrowser.getByRole('heading', { name: /^Record [0-9]+$/, level: 4 })).toBeVisible();
  const modal = page.getByRole('dialog');
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../../ecosystem-audit/native-record-browser-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'backend', exact: true }).click();
  const source = page.getByLabel('Private backend source', { exact: true });
  await expect(source).toContainText('function createNote');
  await source.fill((await source.inputValue()) + '\n// Saved through the FormLogic backend editor.\n');
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect(page.getByText('Installed. The app uses its private SQLite database and ZIPP backend. Existing records were preserved.', { exact: true })).toBeVisible();
  const updated = await (await context.request.get(`/api/apps/${app.id}/native`)).json();
  expect(updated.project.files['server/main.logic']).toContain('Saved through the FormLogic backend editor.');
  const preserved = await (await context.request.get(`/api/apps/${app.id}/native/records?table=notes`)).json();
  expect(preserved.rows.some((row: { title: string }) => row.title === title)).toBe(true);
  // This review app remains a draft; visiting anonymously must not expose it.
  const visitor = await page.context().browser()!.newContext();
  try {
    const response = await visitor.request.get(new URL(`/api/app/${app.slug}/native`, page.url()).href);
    expect(response.status()).toBe(404);
  } finally { await visitor.close(); }
});
