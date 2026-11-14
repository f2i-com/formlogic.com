import { sessionHeaders } from './session-request';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Native source highlighting and full-record CRUD work on desktop and mobile', async ({ page, context }) => {
  test.setTimeout(150000);
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Requires the local review account.');
  const login = await context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  expect(login.ok()).toBe(true);
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value };
  const listed = await (await context.request.get('/api/apps')).json();
  let app = listed.apps.find((item: { slug: string }) => item.slug === 'native-source-record-review');
  if (!app) {
    const result = await context.request.post('/api/apps', { headers, data: { name: 'Source and records review', slug: 'native-source-record-review' } });
    expect(result.status()).toBe(201); app = (await result.json()).app;
  }
  const existing = await (await context.request.get(`/api/apps/${app.id}/native`)).json();
  const project = JSON.parse(await readFile('../backend/resources/native-app-starter.json', 'utf8'));
  project.files['ui/main.ui'] = '<logic>\nvar message = "Hello";\n</logic>\n<style>\n.demo { color: red; padding: 12px; }\n</style>\n<Stack><Text>{message}</Text></Stack>';
  const install = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: existing.project?.version ?? 0 } });
  expect(install.ok(), await install.text()).toBe(true);
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(`/apps/${app.id}/records`);
  await page.getByRole('button', { name: 'Backend code', exact: true }).click();
  const hosting = page.getByRole('dialog', { name: 'Native app hosting', exact: true });
  const colours = (label: string) => page.getByRole('region', { name: label }).locator('.view-line span').evaluateAll(spans => [...new Set(spans.filter(span => span.textContent?.trim()).map(span => getComputedStyle(span).color))]);
  // Every file is in one list beside the editor: a file is opened by its name there.
  const openFile = (path: string) => hosting.locator(`nav[aria-label="Project files"] button[title="${path}"]`).click();
  const source = page.getByRole('textbox', { name: 'Private backend source', exact: true });
  await expect(source).toBeVisible();
  await expect.poll(async () => (await colours('Private backend source editor')).length).toBeGreaterThanOrEqual(3);
  await page.getByRole('region', { name: 'Private backend source editor' }).locator('.view-lines').click(); await source.press('Control+End'); await source.press('Enter');
  await page.keyboard.insertText('// Source editor browser review');
  await openFile('ui/main.ui');
  await expect.poll(async () => (await colours('Interface source editor')).length).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: '../../../ecosystem-audit/native-source-editor-desktop.png' });
  await openFile('server/main.logic');
  await expect(page.getByRole('region', { name: 'Private backend source editor' })).toContainText('Source editor browser review');
  // The file the draft changed is marked in the list, and the one that has run is not to be changed.
  await expect(hosting.getByRole('button', { name: 'server/main.logic, changed', exact: true })).toBeVisible();
  await openFile('server/migrations/001.sql');
  await expect(page.getByRole('region', { name: 'Private backend source editor' })).toContainText('SQL · Read-only');
  await source.press('Control+End'); await page.keyboard.insertText('should not be saved');
  await expect.poll(async () => (await colours('Private backend source editor')).length).toBeGreaterThanOrEqual(2);
  await hosting.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect(hosting.getByText('Installed. The app uses its private SQLite database and ZIPP backend. Existing records were preserved.', { exact: true })).toBeVisible();
  const saved = await (await context.request.get(`/api/apps/${app.id}/native`)).json();
  expect(saved.project.files['server/main.logic']).toContain('Source editor browser review');
  expect(saved.project.files['server/migrations/001.sql']).toBe(project.files['server/migrations/001.sql']);
  await openFile('ui/main.ui');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await hosting.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../../ecosystem-audit/native-source-editor-mobile.png' });
  await hosting.getByRole('tab', { name: 'records', exact: true }).click();
  // The dialog's records are the data manager the app's own page has. On a phone its tables are
  // one list to choose from, its rows are cards, and a row opens as a sheet over the page.
  const browser = hosting.getByRole('region', { name: 'Database records browser' });
  await browser.getByRole('combobox', { name: 'Table', exact: true }).selectOption('items');
  await browser.getByRole('button', { name: 'Add row', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add row', exact: true });
  const stamp = `CRUD review ${Date.now()}`;
  const title = `${stamp} ${'Full source text '.repeat(40)}`;
  await editor.getByLabel('title', { exact: true }).fill(title);
  expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../../ecosystem-audit/native-record-create-mobile.png' });
  await editor.getByRole('button', { name: 'Add row', exact: true }).click();
  await expect(browser.getByText('Row added.', { exact: true })).toBeVisible();
  // The row just added opens by itself, wherever it falls among the rows; it is found by a search too.
  const sheet = page.getByRole('dialog', { name: /^Row id \d+ of items$/ });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  await browser.getByRole('searchbox', { name: 'Search this table' }).fill(stamp);
  const cards = browser.getByRole('list', { name: 'Rows of items' }).getByRole('listitem');
  await expect(cards).toHaveCount(1);
  await cards.first().getByRole('button', { name: /^Open row / }).click();
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit row', exact: true });
  await expect(edit.getByLabel('title', { exact: true })).toHaveValue(title);
  await edit.getByLabel('title', { exact: true }).fill(title + ' Edited');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  // The open row is read again after the change: it shows the whole new value.
  await expect(sheet.locator('[data-column="title"] dd')).toContainText('Full source text Edited');
  // Wide, the same open row stands beside the rows.
  await page.setViewportSize({ width: 1440, height: 900 });
  const details = browser.getByRole('complementary', { name: /^Row id \d+ of items$/ });
  await details.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(edit.getByLabel('title', { exact: true })).toHaveValue(title + ' Edited');
  await page.screenshot({ path: '../../../ecosystem-audit/native-record-edit-desktop.png' });
  await edit.getByRole('button', { name: 'Delete row', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this row?', exact: true });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(edit).toBeVisible();
  await edit.getByRole('button', { name: 'Delete row', exact: true }).click();
  await confirm.getByRole('button', { name: 'Delete the row', exact: true }).click();
  await expect(browser.getByText('Row deleted.', { exact: true })).toBeVisible();
  const records = await (await context.request.get(`/api/apps/${app.id}/native/records?table=items`)).json();
  expect(records.rows.some((row: { title: string }) => row.title === title + ' Edited')).toBe(false);
  await hosting.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await page.getByRole('button', { name: 'Backend code', exact: true }).click();
  await expect(hosting.locator('.monaco-editor.vs')).toBeVisible();
  await expect.poll(async () => (await colours('Private backend source editor')).length).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: '../../../ecosystem-audit/native-source-editor-light.png' });
  expect(browserErrors).toEqual([]);
});
