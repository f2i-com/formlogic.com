// Real local UI captures with a dedicated fictional project; never uses real customer data.
// Run from ui with FORMLOGIC_REVIEW_PASSWORD set and the local API/native runtime running.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const origin = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use the local review server.');
assert(process.env.FORMLOGIC_REVIEW_PASSWORD, 'Set the local review password in the environment.');
const output = new URL('../public/images/docs/', import.meta.url);
const readme = new URL('../../../docs/images/', import.meta.url);
await mkdir(output, { recursive: true });
await mkdir(readme, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const login = await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  assert(login.ok(), 'The review account must be available.');
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf').value };
  const apps = (await (await context.request.get('/api/apps')).json()).apps;
  let app = apps.find(app => app.slug === 'documentation-service-desk');
  if (!app) {
    const created = await context.request.post('/api/apps', { headers, data: { name: 'Service desk · documentation demo', slug: 'documentation-service-desk' } });
    assert(created.ok(), await created.text()); app = (await created.json()).app;
  }
  const project = JSON.parse(await readFile(new URL('../../backend/resources/native-app-starter.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(project.files['manifest.json']);
  manifest.name = 'Service desk';
  project.files['manifest.json'] = JSON.stringify(manifest, null, 2);
  project.files['ui/main.ui'] = `<logic>
var message = 'Ready for your next request';
function saveItem() {
  softn.net.fetch('https://app.example/api/items', {
    method: 'POST', body: { title: 'Arrange a site visit' }
  }, function(response) {
    message = response.ok ? 'Request saved' : 'Please try again';
  });
}
</logic>

<Stack padding="28" gap="16">
  <Text size="28" weight="bold">Service desk</Text>
  <Text>Keep your team and customer requests in one place.</Text>
  <Button onClick={saveItem}>Add a request</Button>
  <Text>{message}</Text>
</Stack>`;
  const existing = await (await context.request.get(`/api/apps/${app.id}/native`)).json();
  const installed = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: existing.project?.version ?? 0 } });
  assert(installed.ok(), await installed.text());
  const data = await (await context.request.get(`/api/apps/${app.id}/native/records?table=items`)).json();
  for (const title of ['Arrange a site visit for the community centre', 'Prepare the maintenance estimate', 'Confirm Friday’s team handover']) {
    if (data.rows.some(row => row.title === title)) continue;
    const created = await context.request.post(`/api/apps/${app.id}/native/records`, { headers, data: { table: 'items', action: 'create', values: { title } } });
    assert(created.ok(), await created.text());
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/apps/${app.id}/records`);
  await page.getByRole('button', { name: 'Backend code', exact: true }).click();
  const hosting = page.getByRole('dialog', { name: 'Native app hosting', exact: true });
  const capture = async (locator, name) => {
    await page.evaluate(() => document.fonts.ready);
    await locator.screenshot({ path: fileURLToPath(new URL(name, output)), type: 'jpeg', quality: 90, animations: 'disabled' });
    await copyFile(new URL(name, output), new URL(name, readme));
    console.log(`Captured ${name}`);
  };
  await expect(hosting.locator('.monaco-editor')).toBeVisible();
  await capture(hosting, 'native-backend.jpg');
  await hosting.getByRole('tab', { name: 'screens', exact: true }).click();
  await expect(hosting.locator('.view-lines')).toContainText('Service desk');
  await capture(hosting, 'native-screens.jpg');
  await hosting.getByRole('tab', { name: 'records', exact: true }).click();
  await hosting.getByLabel('Database table', { exact: true }).selectOption('items');
  await expect(hosting.getByRole('table').getByText('Prepare the maintenance estimate')).toBeVisible();
  await capture(hosting, 'native-records.jpg');
  await hosting.getByRole('button', { name: 'View record 1', exact: true }).click();
  await hosting.getByRole('button', { name: 'Edit record', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit database record', exact: true });
  await expect(editor.getByLabel('title', { exact: true })).toHaveValue('Arrange a site visit for the community centre');
  await capture(editor, 'native-record-editor.jpg');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await capture(editor, 'native-record-editor-mobile.jpg');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
