import { sessionHeaders } from './session-request';
/**
 * Hosted SoftN apps, end to end in a real browser against the real backend:
 *
 *   - Create app → SoftN app, started visually: the starter runs in the app's workspace, the
 *     Visual Builder's change is installed at once, the app saves to its own database, the Data
 *     tab shows the record, and Publish makes it live.
 *   - Built with AI: AI Studio builds the app from the description while FormLogic shows it
 *     working, and the change is installed when the owner keeps it.
 *   - Uploaded: a .softn file becomes the app's first version, with a backend of its own or
 *     none (an app that runs in the browser alone, named after itself, downloads as it came).
 *   - From the chat: a create_softn_app result takes the person to the new app, where AI Studio
 *     builds it from their request.
 *
 * The AI provider is the only thing stubbed, as in app-editors-roundtrip.spec.ts: Studio's agent
 * reads and writes files over FormLogic's tool-call bridge, and the site chat's stream carries the
 * tool result. A Studio from before the bridge's `agentRuns` (the pinned SoftN release may be one)
 * is not sent the request; FormLogic shows it to paste, so these journeys paste it and go on.
 * Runs against the seeded golden-path account (E2E_EMAIL / E2E_PASSWORD); each test creates its
 * own apps and deletes them.
 */
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { openStudioAiPanel } from './studio-panel';

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';
const STARTER = JSON.parse(readFileSync('../backend/resources/native-app-starter.json', 'utf8')) as { files: Record<string, string> };

let created: string[] = [];
let headers: Record<string, string> = {};

async function login(context: BrowserContext) {
  const r = await context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email: EMAIL, password: PASSWORD } });
  expect(r.ok(), await r.text()).toBe(true);
  const csrf = (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value;
  headers = { 'X-CSRF-Token': csrf };
}

async function nativeProject(context: BrowserContext, id: string) {
  return (await (await context.request.get(`/api/apps/${id}/native`)).json()).project as { version: number; files: Record<string, string>; access: string; home: boolean } | null;
}

/** The app id in the workspace's address, recorded for deletion. */
async function workspaceAppId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/apps\/[^/]+\/softn$/, { timeout: 30000 });
  const id = /\/apps\/([^/]+)\/softn$/.exec(new URL(page.url()).pathname)![1];
  if (!created.includes(id)) created.push(id);
  return id;
}

/** The running app inside the workspace's preview. */
const preview = (page: Page) => page.frameLocator('iframe[title="App preview"]').frameLocator('iframe[title="Hosted app"]');

/**
 * Studio's agent, scripted: it reads the page and writes it back with the new heading, and the
 * round that sees those results finishes. Answers only Studio's tool-call requests (aiTools).
 */
function studioAgent(context: BrowserContext, appId: () => string, from: () => string, heading: string) {
  const requests: Array<{ aiTools: unknown }> = [];
  const handle = async (route: Route, body: { aiTools?: unknown; messages: Array<{ role: string; content: string; isError?: boolean }> }) => {
    requests.push({ aiTools: body.aiTools });
    if (body.messages.some(m => m.role === 'tool')) {
      const errors = body.messages.filter(m => m.role === 'tool' && m.isError).map(m => m.content);
      expect(errors).toEqual([]);
      await route.fulfill({ json: { data: { content: '', toolCalls: [{ id: 'call-finish', name: 'finish', arguments: { summary: `Built ${heading}.` } }], stopReason: 'tool_calls' } } });
      return;
    }
    // Studio can ask before the test has read the new app's id from the address bar: wait for the id, do not ask for app "".
    await expect.poll(appId, { timeout: 30000 }).not.toBe('');
    const current = (await nativeProject(context, appId()))!.files['ui/main.ui'];
    expect(current).toContain(from());
    await route.fulfill({ json: { data: { content: 'Writing the page.', toolCalls: [
      { id: 'call-read', name: 'read_file', arguments: { path: 'ui/main.ui' } },
      { id: 'call-write', name: 'write_file', arguments: { path: 'ui/main.ui', content: current.replace(from(), heading) } },
    ], stopReason: 'tool_calls' } } });
  };
  return { requests, handle };
}

/**
 * In AI Studio, opened with a request: wait for the agent to build and finish, pasting the
 * request into Studio's chat first when this Studio is from before agentRuns.
 */
async function watchStudioBuild(page: Page, request: string, heading: string) {
  const studio = page.getByRole('dialog', { name: 'AI Studio', exact: true });
  await expect(studio).toBeVisible({ timeout: 30000 });
  const frame = page.frameLocator('iframe[title="App AI editor"]');
  const pasteNotice = studio.getByText('paste yours into its AI chat', { exact: false });
  const finished = studio.getByRole('status').filter({ hasText: `Done: Built ${heading}.` });
  await expect(pasteNotice.or(finished).or(studio.getByRole('status').filter({ hasText: 'AI Studio is building your app' }))).toBeVisible({ timeout: 90000 });
  if (await pasteNotice.isVisible()) {
    await expect(studio.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled({ timeout: 90000 });
    await openStudioAiPanel(frame);
    await frame.getByRole('textbox', { name: 'Message to AI' }).fill(request);
    await frame.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(frame.getByText(`Built ${heading}.`, { exact: true })).toBeVisible({ timeout: 60000 });
  } else {
    await expect(finished).toBeVisible({ timeout: 90000 });
  }
  await expect(studio.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled({ timeout: 30000 });
  await studio.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Saved. The preview shows your changes.', { exact: true })).toBeVisible({ timeout: 60000 });
}

test.describe('hosted SoftN apps', () => {
  test.beforeEach(async ({ context }) => { created = []; await login(context); });
  test.afterEach(async ({ context }) => {
    for (const id of created) {
      const r = await context.request.delete(`/api/apps/${id}`, { headers }).catch((e: Error) => e);
      if (r instanceof Error || !r.ok()) console.log('CLEANUP FAILED: app', id, 'was not deleted:', r instanceof Error ? r.message : r.status());
    }
  });

  test('started visually: the starter runs, the Builder change is installed, the app saves to its database, and it publishes', async ({ page, context }) => {
    test.setTimeout(240000);
    const name = `Recipe Box ${Date.now()}`;
    await page.goto('/apps/new?type=softn');
    await page.locator('#softn-app-name').fill(name);
    await page.getByText('Start from a working app and edit it visually', { exact: true }).click();
    await page.getByRole('button', { name: 'Create and start editing', exact: true }).click();
    const appId = await workspaceAppId(page);

    // The starter is installed as version 1, named after the app, for members only and open at the app's address.
    const first = (await nativeProject(context, appId))!;
    expect(first.version).toBe(1);
    expect(JSON.parse(first.files['manifest.json']).name).toBe(name);
    expect(first).toMatchObject({ access: 'members', home: true });

    // The workspace opened the Visual Builder on it.
    const editor = page.getByRole('dialog', { name: 'Visual Builder', exact: true });
    await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled({ timeout: 90000 });
    const frame = page.frameLocator('iframe[title="App visual editor"]');
    await frame.getByRole('button', { name: 'Design', exact: true }).click();
    await frame.getByRole('treeitem', { name: 'Select Button component', exact: true }).click();
    await frame.getByLabel('Text', { exact: true }).fill('Save a recipe');
    await frame.getByLabel('Text', { exact: true }).press('Tab');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();

    // Not published, so the change is installed at once and the preview runs it.
    await expect(page.getByText('Saved. The preview shows your changes.', { exact: true })).toBeVisible({ timeout: 60000 });
    const second = (await nativeProject(context, appId))!;
    expect(second.version).toBe(2);
    expect(second.files['ui/main.ui']).toContain('Save a recipe');
    expect(second.files['server/main.logic']).toBe(first.files['server/main.logic']);
    // The preview starts the app inside its own frame (the engine loads first): give it time.
    await expect(preview(page).getByRole('button', { name: 'Save a recipe', exact: true })).toBeVisible({ timeout: 60000 });
    await preview(page).getByRole('button', { name: 'Save a recipe', exact: true }).click();
    await expect(preview(page).getByText('Item saved in your app database', { exact: true })).toBeVisible({ timeout: 60000 });

    // The record is in the app's own database, shown on the Data tab.
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByRole('combobox', { name: 'Database table' })).toHaveValue('items', { timeout: 30000 });
    await expect(page.getByRole('region', { name: 'Database records browser' }).getByText('My first item').first()).toBeVisible({ timeout: 30000 });

    // Publish makes it live at its address.
    await expect(page.getByText('Not published', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 30000 });
    const app = await (await context.request.get(`/api/apps/${appId}`)).json();
    expect((app.app ?? app).status).toBe('published');
  });

  test('built with AI: AI Studio builds the app from the description, and keeping it installs the change', async ({ page, context }) => {
    test.setTimeout(240000);
    const name = `Recipe Studio ${Date.now()}`;
    const request = 'A recipe box: a heading that says Family Recipes, and a list of recipes.';
    let appId = '';
    const agent = studioAgent(context, () => appId, () => `<Text>${name}</Text>`, '<Text>Family Recipes</Text>');
    await page.route('**/api/ai/preferences', route => route.fulfill({ json: { data: { aiSource: 'site', chatToolMode: 'auto' } } }));
    await page.route('**/api/ai/chat', async route => {
      const body = route.request().postDataJSON();
      if (body.aiTools === undefined) { await route.fulfill({ status: 500, json: { error: true, message: 'Unexpected chat request' } }); return; }
      await agent.handle(route, body);
    });
    await page.goto('/apps/new?type=softn');
    await page.locator('#softn-app-name').fill(name);
    await page.locator('#softn-app-request').fill(request);
    await page.getByRole('button', { name: 'Create and build with AI', exact: true }).click();
    appId = await workspaceAppId(page);

    await watchStudioBuild(page, request, '<Text>Family Recipes</Text>');
    const built = (await nativeProject(context, appId))!;
    expect(built.version).toBe(2);
    expect(built.files['ui/main.ui']).toContain('<Text>Family Recipes</Text>');
    expect(agent.requests.map(r => r.aiTools)).toEqual([1, 1]);
    await expect(preview(page).getByText('Family Recipes', { exact: true })).toBeVisible({ timeout: 60000 });
  });

  test('uploaded: a .softn file becomes the first version', async ({ page, context }) => {
    test.setTimeout(180000);
    const files = { ...STARTER.files, 'ui/main.ui': STARTER.files['ui/main.ui'].replace('<Text>My app</Text>', '<Text>Uploaded app</Text>') };
    const path = join(tmpdir(), `softn-upload-${Date.now()}.softn`);
    writeFileSync(path, Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p, source]) => [p, strToU8(source)])))));
    await page.goto('/apps/new?type=softn');
    await page.locator('#softn-app-name').fill(`Uploaded ${Date.now()}`);
    await page.getByText('Upload a .softn file', { exact: true }).click();
    await page.getByLabel('Choose a .softn file').setInputFiles(path);
    await page.getByRole('button', { name: 'Create from this file', exact: true }).click();
    const appId = await workspaceAppId(page);
    const project = (await nativeProject(context, appId))!;
    expect(project).toMatchObject({ version: 1, access: 'members', home: true });
    expect(project.files['ui/main.ui']).toContain('Uploaded app');
    await expect(preview(page).getByText('Uploaded app', { exact: true })).toBeVisible({ timeout: 60000 });
  });

  test('uploaded without a backend: a browser-only app is added under its own name, runs, and downloads as it came', async ({ page, context }) => {
    test.setTimeout(180000);
    // Most SoftN apps are like this one: no server block, no id, and seed data of their own.
    const name = `Field notes ${Date.now()}`;
    const files: Record<string, string> = {
      'manifest.json': JSON.stringify({ name, version: '1.0.0', main: 'ui/main.ui', files: { xdb: ['xdb/notes.xdb'] } }),
      'ui/main.ui': '<logic>\nvar count = 0;\nfunction add() { count = count + 1; }\n</logic>\n<Stack padding="24" gap="12"><Text>Browser-only app</Text><Button onClick={add}>Add one</Button><Text>Count: {count}</Text></Stack>',
      'xdb/notes.xdb': JSON.stringify({ collection: 'notes', records: [] }),
    };
    const path = join(tmpdir(), `softn-client-${Date.now()}.softn`);
    writeFileSync(path, Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p, source]) => [p, strToU8(source)])))));
    await page.goto('/apps/new?type=softn');
    await page.getByText('Upload a .softn file', { exact: true }).click();
    await page.getByLabel('Choose a .softn file').setInputFiles(path);
    // Read at once: what it is, and that no name has to be typed.
    await expect(page.getByTestId('softn-drop-zone')).toContainText(`${name} · runs in the browser, no backend`);
    await expect(page.locator('#softn-app-name')).toHaveAttribute('placeholder', name);
    await page.getByRole('button', { name: 'Create from this file', exact: true }).click();
    const appId = await workspaceAppId(page);
    const apps = (await (await context.request.get('/api/apps')).json()).apps as Array<{ id: string; name: string }>;
    expect(apps.find(app => app.id === appId)?.name).toBe(name);
    expect((await nativeProject(context, appId))!.files).toEqual(files);
    // It runs in the preview, its logic answering a click.
    await expect(preview(page).getByText('Browser-only app', { exact: true })).toBeVisible({ timeout: 60000 });
    await preview(page).getByRole('button', { name: 'Add one', exact: true }).click();
    await expect(preview(page).getByText('Count: 1', { exact: true })).toBeVisible();
    // With no backend it has no database here, and the Data tab says so.
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByText('This app has no database on the server.', { exact: true })).toBeVisible();
    // What the owner downloads is what was uploaded.
    await page.getByRole('tab', { name: 'App' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download as .softn', exact: true }).click();
    const saved = join(tmpdir(), `softn-client-download-${Date.now()}.softn`);
    await (await download).saveAs(saved);
    expect(Object.fromEntries(Object.entries(unzipSync(readFileSync(saved))).map(([p, bytes]) => [p, strFromU8(bytes)]))).toEqual(files);
  });

  test('from the chat: a new SoftN app takes the person to AI Studio, which builds it from their request', async ({ page, context }) => {
    test.setTimeout(240000);
    // The app the chat's tool made (create_softn_app runs on the server; the stream is stubbed).
    const name = `Chat Recipes ${Date.now()}`;
    const app = (await (await context.request.post('/api/apps', { headers, data: { name, settings: { softnApp: true } } })).json());
    const appRecord = (app.app ?? app) as { id: string; slug: string };
    created.push(appRecord.id);
    expect((await context.request.post(`/api/apps/${appRecord.id}/native/starter`, { headers, data: {} })).ok()).toBe(true);
    const request = 'Make me a recipe box called Weeknight Dinners.';
    const agent = studioAgent(context, () => appRecord.id, () => `<Text>${name}</Text>`, '<Text>Weeknight Dinners</Text>');
    await page.route('**/api/ai/preferences', route => route.fulfill({ json: { data: { aiSource: 'site', chatToolMode: 'auto' } } }));
    await page.route('**/api/ai/chat', async route => {
      const body = route.request().postDataJSON();
      if (body.aiTools !== undefined) { await agent.handle(route, body); return; }
      const result = { app: { id: appRecord.id, name, slug: appRecord.slug }, version: 1, request, workspaceUrl: `/apps/${appRecord.id}/softn`, next: 'Created.' };
      const frames = [
        `data: ${JSON.stringify({ type: 'tool_result', id: 'tool-1', name: 'create_softn_app', status: 'done', result })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ content: 'I made your app; AI Studio is building it now.' })}\n\n`,
        'event: done\ndata: {"usage":{}}\n\n',
        'event: end\ndata: {}\n\n',
      ];
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: frames.join('') });
    });

    await page.goto('/apps');
    await expect(page.getByRole('button', { name: 'Open chat' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Open chat' }).click();
    await page.getByRole('textbox', { name: 'Chat message' }).fill(request);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page).toHaveURL(new RegExp(`/apps/${appRecord.id}/softn$`), { timeout: 30000 });
    await watchStudioBuild(page, request, '<Text>Weeknight Dinners</Text>');
    expect((await nativeProject(context, appRecord.id))!.files['ui/main.ui']).toContain('<Text>Weeknight Dinners</Text>');
  });
});
