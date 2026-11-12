import { sessionHeaders } from './session-request';
/**
 * A SoftN app built over MCP, as an outside AI builds one, end to end against the real backend and
 * in a real browser:
 *
 *   - the connection is told how (get_softn_guide: FormLogic's own page, SoftN's guide by section,
 *     a component's reference);
 *   - the app FormLogic's page gives as its worked example (backend/resources/softn-on-formlogic.md,
 *     "A page and its backend, complete") is installed exactly as that page writes it: its pages
 *     as .html, their logic as .js, a stylesheet, a backend with four routes and a second
 *     migration. The files are read out of the page itself, so what an AI is shown is what runs;
 *   - the app draws, saves through its own backend, and the data tools read and change what it saved;
 *   - a connection without the records permissions reads the app, not its data.
 *
 * It makes its own app and deletes it. Runs against the seeded golden-path account
 * (E2E_EMAIL / E2E_PASSWORD).
 */
import { readFileSync } from 'node:fs';
import { expect, request as apiRequest, test, type APIRequestContext, type BrowserContext } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';
const BUILDER = ['apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write'];

let headers: Record<string, string> = {};
let created: string[] = [];
/** The MCP client: a context of its own with no cookies, as an AI outside the browser has none (and the endpoint takes only the bearer token). */
let mcp: APIRequestContext;

async function login(context: BrowserContext) {
  const r = await context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email: EMAIL, password: PASSWORD } });
  expect(r.ok(), await r.text()).toBe(true);
  const csrf = (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value;
  headers = { 'X-CSRF-Token': csrf };
}

/** A one-hour MCP connection with these permissions, as "Connect an AI" makes one. */
async function connect(context: BrowserContext, scopes: string[]): Promise<string> {
  const made = await context.request.post('/api/mcp/tokens', { headers, data: { scopes, ttl: 3600, idle: 900 } });
  expect(made.ok(), await made.text()).toBe(true);
  return (await made.json()).token as string;
}

/** One tool call over MCP: what it answered (JSON where it is JSON), and whether the tool said it failed. */
async function tool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await request.post('/api/mcp', { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(r.ok(), await r.text()).toBe(true);
  const result = (await r.json()).result as { content: { text: string }[]; isError?: boolean };
  const text = result.content.map(part => part.text).join('\n');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tool's answer is whatever JSON it is
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* prose */ }
  return { failed: result.isError === true, text, data };
}

/** The files of the worked example, from the page an AI is given: each `path` line followed by its fenced block. */
function exampleFiles(): Record<string, string> {
  const page = readFileSync('../backend/resources/softn-on-formlogic.md', 'utf8').replace(/\r\n/g, '\n');
  const section = page.slice(page.indexOf('## A page and its backend, complete'), page.indexOf('## When the app is already live'));
  const files: Record<string, string> = {};
  for (const match of section.matchAll(/^`([\w./-]+)`[^\n]*:\n\n```\w*\n([\s\S]*?)\n```/gm)) files[match[1]] = `${match[2]}\n`;
  return files;
}

test.describe('a SoftN app built over MCP', () => {
  test.beforeEach(async ({ context, baseURL }) => { created = []; await login(context); mcp = await apiRequest.newContext({ baseURL }); });
  test.afterEach(async ({ context }) => {
    await mcp.dispose();
    for (const id of created) {
      const r = await context.request.delete(`/api/apps/${id}`, { headers }).catch((e: Error) => e);
      if (r instanceof Error || !r.ok()) console.log('CLEANUP FAILED: app', id, 'was not deleted:', r instanceof Error ? r.message : r.status());
    }
  });

  test('the worked example an AI is shown installs, runs, and its data is read and changed', async ({ context, page }) => {
    test.setTimeout(180_000);
    const request = mcp;
    const token = await connect(context, [...BUILDER, 'responses:read', 'responses:write']);

    // What the connection is told before it writes anything.
    const start = await tool(request, token, 'get_softn_guide');
    expect(start.failed, start.text).toBe(false);
    expect(start.data.guide).toContain('# SoftN apps on FormLogic');
    expect(start.data.guide).toContain('`language`');
    const backend = await tool(request, token, 'get_softn_guide', { topic: 'language#backend' });
    expect(backend.data.guide).toContain('softn.sql.execute');
    const button = await tool(request, token, 'lookup_softn_components', { names: ['Button'] });
    // The reference comes with the installed Softn release; a checkout without one says so in words.
    expect(button.failed ? button.text : button.data.components).toMatch(/## Button|not installed on this server/);

    const made = await tool(request, token, 'create_softn_app', { name: `Task board ${Date.now()}`, request: 'A shared task board.' });
    expect(made.failed, made.text).toBe(false);
    const appId = made.data.app.id as string;
    created.push(appId);
    expect(made.data.version).toBe(1);

    const starter = await tool(request, token, 'get_native_app_project', { appId });
    const example = exampleFiles();
    expect(Object.keys(example).sort()).toEqual(['index.html', 'main.js', 'manifest.json', 'server/main.logic', 'server/migrations/002.sql', 'styles.css']);
    // "keep the id the app already has"
    const manifest = { id: JSON.parse(starter.data.sources['manifest.json']).id, ...JSON.parse(example['manifest.json']) };
    const installed = await tool(request, token, 'update_native_app_files', { appId, expectedVersion: 1, files: { ...example, 'manifest.json': JSON.stringify(manifest, null, 2) }, remove: ['ui/main.ui'] });
    expect(installed.failed, installed.text).toBe(false);
    expect(installed.data.version).toBe(2);
    expect(installed.data.files).toEqual(expect.arrayContaining(['index.html', 'main.js', 'styles.css']));
    expect(installed.data.files).not.toContain('ui/main.ui');

    const stands = await tool(request, token, 'get_softn_app', { appId });
    expect(stands.data.manifest.main).toBe('index.html');
    expect(stands.data.routes).toHaveLength(4);

    // In the browser, as its owner: the page draws and saves through its own backend.
    await page.goto(new URL(made.data.appUrl).pathname);
    const app = page.frameLocator('iframe').first();
    await expect(app.getByRole('heading', { name: 'Task board' })).toBeVisible({ timeout: 60_000 });
    await expect(app.getByText('Nothing yet')).toBeVisible({ timeout: 20_000 });
    await app.getByPlaceholder('What needs doing?').fill('Water the plants');
    await app.getByRole('button', { name: 'Add' }).click();
    await expect(app.getByText('Water the plants')).toBeVisible({ timeout: 20_000 });
    await app.getByPlaceholder('What needs doing?').fill('Call the plumber');
    await app.getByPlaceholder('What needs doing?').press('Enter');
    await expect(app.getByText('2 tasks')).toBeVisible({ timeout: 20_000 });
    // The component draws its own tick over the input, so the click is sent to the input itself.
    await app.getByRole('checkbox').first().click({ force: true });
    await expect(app.locator('.is-done')).toHaveCount(1, { timeout: 20_000 });

    // The data tools see what the page saved, searched and sorted as the owner's data manager does it.
    const rows = await tool(request, token, 'list_native_app_records', { appId, table: 'items', sort: 'id', dir: 'asc' });
    expect(rows.failed, rows.text).toBe(false);
    expect(rows.data.total).toBe(2);
    expect(rows.data.rows.map((row: { title: string }) => row.title)).toEqual(['Water the plants', 'Call the plumber']);
    const found = await tool(request, token, 'list_native_app_records', { appId, table: 'items', search: 'plumber' });
    expect(found.data.matching).toBe(1);
    const record = await tool(request, token, 'get_native_app_record', { appId, table: 'items', key: found.data.keys[0] });
    const corrected = await tool(request, token, 'change_native_app_record', { appId, action: 'update', table: 'items', key: found.data.keys[0], revision: record.data.record.revision, values: { title: 'Call the plumber back' } });
    expect(corrected.failed, corrected.text).toBe(false);
    await page.reload();
    await expect(page.frameLocator('iframe').first().getByText('Call the plumber back')).toBeVisible({ timeout: 60_000 });

    // A version whose backend does not start is refused with what to fix, and the app stays as it was.
    const broken = await tool(request, token, 'update_native_app_files', { appId, expectedVersion: 2, files: { 'server/main.logic': 'function listItems(req) { return { status: 200, body: { items: [] } }; }' } });
    expect(broken.failed).toBe(true);
    expect(broken.text).toContain('backend could not start');
    expect((await tool(request, token, 'get_softn_app', { appId })).data.version).toBe(2);
  });

  test('a connection given only the building permissions reads the app, not its data or its people', async ({ context }) => {
    const request = mcp;
    const token = await connect(context, BUILDER);
    const made = await tool(request, token, 'create_softn_app', { name: `Scope check ${Date.now()}`, request: 'x' });
    expect(made.failed, made.text).toBe(false);
    const appId = made.data.app.id as string;
    created.push(appId);
    expect((await tool(request, token, 'get_softn_app', { appId })).failed).toBe(false);
    expect((await tool(request, token, 'get_native_app_project', { appId })).failed).toBe(false);
    for (const [name, args] of [
      ['list_native_app_records', { appId, table: 'items' }],
      ['get_native_app_record', { appId, table: 'items', key: { id: '1' } }],
      ['change_native_app_record', { appId, action: 'create', table: 'items', values: { title: 'no' } }],
      ['list_app_members', { appId }],
    ] as const) {
      const refused = await tool(request, token, name, args);
      expect(refused.failed, `${name} was not refused`).toBe(true);
      expect(refused.text).toContain('lacks the required scope');
    }
    // What only FormLogic's own chat can do is not offered here.
    const listed = await request.post('/api/mcp', { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    const names = ((await listed.json()).result.tools as { name: string }[]).map(t => t.name);
    expect(names).toContain('get_softn_guide');
    expect(names).not.toContain('edit_softn_app');
    expect(names).not.toContain('list_native_app_records');
  });
});
