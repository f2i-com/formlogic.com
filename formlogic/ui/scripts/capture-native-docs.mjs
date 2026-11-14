import { sessionJsonHeaders } from '../../../scripts/session-request.mjs';
// Real local UI captures with a dedicated fictional project; never uses real customer data.
// Run from ui with FORMLOGIC_REVIEW_PASSWORD set and the local API/native runtime running.
// The account is admin@formlogic.local unless FORMLOGIC_REVIEW_EMAIL names another: one kept for
// these pictures, never an account that holds real apps. Only dialogs are photographed, so no
// picture shows the account's app list.
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
  // 1088 x 1076: the dialog's picture is then 1024 x 970, the size the Records picture has.
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1088, height: 1076 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const login = await context.request.post('/api/auth/login', { headers: sessionJsonHeaders(origin), data: { email: process.env.FORMLOGIC_REVIEW_EMAIL || 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
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
  // Installed again only when it differs, so the version the pictures show does not climb with every run.
  const held = existing.project?.files ?? {};
  if (Object.keys(held).length !== Object.keys(project.files).length || Object.entries(project.files).some(([path, text]) => held[path] !== text)) {
    const installed = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: existing.project?.version ?? 0 } });
    assert(installed.ok(), await installed.text());
  }
  const data = await (await context.request.get(`/api/apps/${app.id}/native/records?table=items`)).json();
  for (const title of ['Arrange a site visit for the community centre', 'Prepare the maintenance estimate', 'Confirm Friday’s team handover']) {
    if (data.rows.some(row => row.title === title)) continue;
    const created = await context.request.post(`/api/apps/${app.id}/native/records`, { headers, data: { table: 'items', action: 'create', values: { title } } });
    assert(created.ok(), await created.text());
  }
  const errors = [];
  // The dialog as it opens from the app's Records page, on a page of the given context.
  const openHosting = async (from) => {
    const opened = await from.newPage();
    opened.on('pageerror', error => errors.push(error.message));
    await opened.goto(`/apps/${app.id}/records`);
    await opened.getByRole('button', { name: 'Backend code', exact: true }).click();
    const dialog = opened.getByRole('dialog', { name: 'Native app hosting', exact: true });
    await expect(dialog.locator('.monaco-editor')).toBeVisible();
    return dialog;
  };
  // `forReadme`: the pictures the repository's own documents show are kept beside them too.
  const capture = async (locator, name, forReadme = true) => {
    await locator.page().evaluate(() => document.fonts.ready);
    await locator.screenshot({ path: fileURLToPath(new URL(name, output)), type: 'jpeg', quality: 90, animations: 'disabled' });
    if (forReadme) await copyFile(new URL(name, output), new URL(name, readme));
    console.log(`Captured ${name}`);
  };
  // Source. The file list stands beside the editor once the dialog is 1024 px wide; under that it
  // is stacked over it. The two pictures keep the 896 x 990 they have always had, so the dialog is
  // drawn 1024 wide at seven eighths of its size.
  const source = await browser.newContext({ baseURL: origin, storageState: await context.storageState(), viewport: { width: 1088, height: 1255 }, deviceScaleFactor: 0.875, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const files = await openHosting(source);
  await files.getByRole('navigation', { name: 'Project files' }).getByRole('button', { name: /main\.logic$/ }).click();
  await expect(files.locator('.view-lines')).toContainText('createItem');
  await capture(files, 'native-backend.jpg');
  // The first page is the first file under Pages.
  await files.locator('nav[aria-label="Project files"] section[aria-label="Pages"] button').first().click();
  await expect(files.locator('.view-lines')).toContainText('Service desk');
  await capture(files, 'native-screens.jpg');
  await source.close();
  // Records: the data manager on the app's one table, a row opened from it, and that row's editor.
  const openRecords = async (from) => {
    const dialog = await openHosting(from);
    await dialog.getByRole('tab', { name: 'records', exact: true }).click();
    await expect(dialog.getByLabel('Rows of items', { exact: true }).getByText('Prepare the maintenance estimate')).toBeVisible();
    return dialog;
  };
  // A row is opened by its key, then edited from what opens: a panel beside the rows, or a sheet on a phone.
  const openEditor = async (dialog) => {
    await dialog.getByRole('button', { name: /open row 1$/i }).click();
    await dialog.page().getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = dialog.page().getByRole('dialog', { name: 'Edit row', exact: true });
    await expect(editor.getByLabel('title', { exact: true })).toHaveValue('Arrange a site visit for the community centre');
    return editor;
  };
  const hosting = await openRecords(context);
  await capture(hosting, 'native-records.jpg');
  await capture(await openEditor(hosting), 'native-record-editor.jpg');
  // The phone's picture is taken on a phone from the start: a window narrowed with the editor
  // open leaves the row's sheet drawn over it.
  const phone = await browser.newContext({ baseURL: origin, storageState: await context.storageState(), viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const small = await openEditor(await openRecords(phone));
  assert(await small.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await capture(small, 'native-record-editor-mobile.jpg');
  await phone.close();
  // The same app's App Studio: the Overview's guide, each step with what the app has of it.
  const wide = await browser.newContext({ baseURL: origin, storageState: await context.storageState(), viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const studio = await wide.newPage();
  studio.on('pageerror', error => errors.push(error.message));
  await studio.goto(`/apps/${app.id}/studio/plan`);
  const guide = studio.getByRole('region', { name: 'Build your app in five steps', exact: true });
  await expect(guide.getByRole('listitem')).toHaveCount(5);
  await expect(guide).toContainText('Only you so far');
  await capture(guide, 'app-studio-steps.jpg', false);
  await wide.close();
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
