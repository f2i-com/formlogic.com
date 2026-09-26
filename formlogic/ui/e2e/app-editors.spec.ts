import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Apps a test created, deleted after it. A review app reused across runs carries the last run's
 * draft, and the next run's save is then refused as a stale version ("The project changed. Reload
 * before importing.").
 */
const created: string[] = [];
test.afterEach(async ({ context }) => {
  const csrf = (await context.cookies()).find(c => c.name === 'formlogic_csrf')?.value;
  for (const id of created.splice(0)) {
    const r = await context.request.delete(`/api/apps/${id}`, { headers: csrf ? { 'X-CSRF-Token': csrf } : {} }).catch((e: Error) => e);
    if (r instanceof Error || !r.ok()) console.log('CLEANUP FAILED: app', id, 'was not deleted:', r instanceof Error ? r.message : r.status());
  }
});

test('Builder and Studio return an editable native app without losing its backend', async ({ page, context }) => {
  test.setTimeout(180000);
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0,400)); });
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Local review account required.');
  await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value };
  const app = (await (await context.request.post('/api/apps', { headers, data: { name: 'Editor integration review' } })).json()).app;
  created.push(app.id);
  const project = JSON.parse(readFileSync('../backend/resources/native-app-starter.json', 'utf8'));
  const save = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: 0 } });
  expect(save.ok(), await save.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Site AI stands in for a connected AI before the hosting panel asks whether one is ready.
  await page.route('**/api/ai/preferences', route => route.fulfill({ json: { data: { aiSource: 'site', chatToolMode: 'auto' } } }));
  await page.goto(`/apps/${app.id}/records`);
  await page.getByRole('button', { name: 'Native app hosting', exact: true }).click();
  let aiRequests = 0;
  let releaseCancelled: () => void = () => {};
  const cancelledReply = new Promise<void>(resolve => { releaseCancelled = resolve; });
  await page.route('**/api/ai/chat', async route => {
    aiRequests++;
    if (aiRequests === 1) await cancelledReply;
    const body = route.request().postDataJSON() as { messages: Array<{ role: string; content: string; isError?: boolean }> };
    expect(body.messages.some(m => m.content.includes('Update the heading'))).toBe(true);
    // Studio's agent works in rounds: it reads and writes the file (it only overwrites a file it has
    // read), then finishes once it has those results.
    if (body.messages.some(m => m.role === 'tool')) {
      expect(body.messages.filter(m => m.role === 'tool' && m.isError).map(m => m.content)).toEqual([]);
      await route.fulfill({ json: { data: { content: '', toolCalls: [{ id: 'call-finish', name: 'finish', arguments: { summary: 'Updated the heading.' } }], stopReason: 'tool_calls' } } }).catch(() => {});
      return;
    }
    const source = project.files['ui/main.ui'].replace('My app', 'AI edited app').replace('Save example item', 'Save edited item');
    await route.fulfill({ json: { data: { content: 'Changing the heading.', toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { path: 'ui/main.ui' } }, { id: 'call-write', name: 'write_file', arguments: { path: 'ui/main.ui', content: source } }], stopReason: 'tool_calls' } } }).catch(() => {});
  });
  for (const kind of ['Visual Builder', 'AI Studio']) {
    await page.getByRole('button', { name: `Open ${kind}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: kind, exact: true });
    await expect(editor.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled({ timeout: 60000 });
    const frame = page.frameLocator(kind === 'Visual Builder' ? 'iframe[title="App visual editor"]' : 'iframe[title="App AI editor"]');
    if (kind === 'Visual Builder') {
      await frame.getByRole('button', { name: 'Data', exact: true }).click();
      await expect(frame.getByRole('heading', { name: 'Your app data lives in FormLogic' })).toBeVisible();
      await frame.getByRole('button', { name: 'Design', exact: true }).click();
      await frame.getByRole('treeitem', { name: 'Select Button component', exact: true }).click();
      await frame.getByLabel('Text', { exact: true }).fill('Save edited item');
      await frame.getByLabel('Text', { exact: true }).press('Tab');
    } else {
      await frame.getByRole('button', { name: 'AI', exact: true }).click();
      await frame.getByRole('textbox', { name: 'Message to AI' }).fill('Update the heading to AI edited app, preserving all other files.');
      await frame.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Review changes', exact: true })).toBeDisabled();
      await expect(editor.getByRole('status')).toContainText('AI is editing your draft');
      await frame.getByRole('button', { name: 'Stop the agent', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled();
      releaseCancelled();
      await frame.getByRole('textbox', { name: 'Message to AI' }).fill('Update the heading to AI edited app, preserving all other files.');
      await frame.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(frame.getByText('Updated the heading.', { exact: true })).toBeVisible({ timeout: 30000 });
      expect(aiRequests).toBe(3); // the stopped request, then the read and write, then the finish
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(frame.getByRole('button', { name: 'AI Chat', exact: true })).toBeVisible();
      await frame.getByRole('button', { name: 'AI Chat', exact: true }).click();
      await expect(frame.getByRole('textbox', { name: 'Message to AI' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: '../../../ecosystem-audit/embedded-studio-mobile.png' });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.screenshot({ path: `../../../ecosystem-audit/embedded-${kind.replace(' ', '-').toLowerCase()}.png` });
    await editor.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Native app hosting', exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toBeDisabled({ timeout: 20000 });
    const returned = (await (await context.request.get(`/api/apps/${app.id}/native`)).json()).project;
    expect(returned.files['server/main.logic']).toBe(project.files['server/main.logic']);
    expect(returned.files['server/migrations/001.sql']).toBe(project.files['server/migrations/001.sql']);
    expect(JSON.parse(returned.files['manifest.json']).server).toEqual(JSON.parse(project.files['manifest.json']).server);
    expect(returned.files['ui/main.ui']).toContain('Save edited item');
    expect(returned.files['ui/main.ui']).toContain('function saveItem');
    if (kind === 'AI Studio') expect(returned.files['ui/main.ui']).toContain('AI edited app');
  }
  await page.goto(`/app/${app.slug}`);
  const runtime = page.frameLocator('iframe[title="Hosted app"]');
  await runtime.getByRole('button', { name: 'Save edited item', exact: true }).click();
  await expect(runtime.getByText('Item saved in your app database', { exact: true })).toBeVisible();
  const records = (await (await context.request.get(`/api/apps/${app.id}/native/records?table=items`)).json()).rows;
  expect(records.some((r: {title: string}) => r.title === 'My first item')).toBe(true);
});

test('Existing hosted apps keep private actions when edited in Builder and Studio', async ({ page, context }) => {
  test.setTimeout(90000);
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Local review account required.');
  await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value };
  const app = (await (await context.request.post('/api/apps', { headers, data: { name: 'Hosted editor review' } })).json()).app;
  created.push(app.id);
  const pkg = JSON.parse(readFileSync('../backend/resources/connected-workspace.json', 'utf8'));
  pkg.actions = { hello: { access: 'owner', mode: 'read', source: 'function onRequest(ctx) { return {message:"Preserved private action"}; }' } };
  const saved = await context.request.put(`/api/apps/${app.id}/hosting`, { headers, data: { package: pkg, expectedVersion: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  let version = (await saved.json()).deployment.version as number;
  await page.goto(`/apps/${app.id}/studio/screens`);
  await page.getByText('Hosting & app tools', { exact: true }).click();
  await page.getByRole('button', { name: 'App hosting', exact: true }).click();
  for (const kind of ['Visual Builder', 'AI Studio']) {
    await page.getByRole('button', { name: `Open ${kind}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: kind, exact: true });
    await expect(editor.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled({ timeout: 30000 });
    await editor.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'App hosting', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
    // The button disables as the publish starts; the version line moves once it has committed.
    version++;
    await expect(page.getByText(`Version ${version} live`, { exact: true })).toBeVisible({ timeout: 20000 });
    const hosting = await context.request.get(`/api/apps/${app.id}/hosting`);
    expect(hosting.ok(), await hosting.text()).toBe(true);
    expect((await hosting.json()).deployment.actions).toEqual(pkg.actions);
  }
});

test('Coffee.Dating media and private backend survive both editor round trips', async ({ page, context }) => {
  test.setTimeout(150000);
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Local review account required.');
  await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value };
  const apps = (await (await context.request.get('/api/apps')).json()).apps;
  const sourceApp = apps.find((a: {slug: string}) => a.slug === 'coffee-dating-native-review');
  test.skip(!sourceApp, 'Requires the local Coffee.Dating review fixture.');
  const source = (await (await context.request.get(`/api/apps/${sourceApp.id}/native`)).json()).project;
  let app = apps.find((a: {slug: string}) => a.slug === 'coffee-editor-roundtrip-review');
  if (!app) app = (await (await context.request.post('/api/apps', { headers, data: { name: 'Coffee editor roundtrip review', slug: 'coffee-editor-roundtrip-review' } })).json()).app;
  const old = (await (await context.request.get(`/api/apps/${app.id}/native`)).json()).project;
  const saved = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project: source, expectedVersion: old?.version ?? 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto(`/apps/${app.id}/records`);
  await page.getByRole('button', { name: 'Native app hosting', exact: true }).click();
  for (const kind of ['Visual Builder', 'AI Studio']) {
    await page.getByRole('button', { name: `Open ${kind}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: kind, exact: true });
    await expect(editor.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled({ timeout: 45000 });
    await editor.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Native app hosting', exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toBeDisabled();
    const returned = (await (await context.request.get(`/api/apps/${app.id}/native`)).json()).project;
    expect(returned.assets).toEqual(source.assets);
    for (const [path, content] of Object.entries(source.files)) {
      if (path.startsWith('server/') || path.endsWith('.logic')) expect(returned.files[path], path).toEqual(content);
    }
    expect(JSON.parse(returned.files['manifest.json']).server).toEqual(JSON.parse(source.files['manifest.json']).server);
    expect(returned.access).toBe('application');
  }
  expect((await (await context.request.get(`/api/apps/${sourceApp.id}/native`)).json()).project.version).toBe(source.version);
});
