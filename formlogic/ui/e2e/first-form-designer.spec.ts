import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { sessionHeaders } from './session-request';

test('Create a forms app, design its first question and reopen the saved form', async ({ page, context }, testInfo) => {
  const login = await context.request.post('/api/auth/login', {
    headers: sessionHeaders(),
    data: { email: process.env.E2E_EMAIL || 'test@example.com', password: process.env.E2E_PASSWORD || 'password123' },
  });
  expect(login.ok()).toBe(true);
  const csrf = (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value;
  const headers = { ...sessionHeaders(), 'X-CSRF-Token': csrf };
  const appName = `Workshop ${randomUUID().slice(0, 8)}`;
  const formName = 'Session request';
  let appId: string | undefined;
  let formId: string | undefined;
  try {
    await page.goto('/apps/new');
    await page.getByRole('link', { name: /^(Create a forms app|Forms app)/ }).click();
    await expect(page.getByRole('heading', { name: 'Create a forms app' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('create-forms-app.png'), animations: 'disabled' });
    await page.getByLabel('App name', { exact: true }).fill(appName);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/apps' && response.request().method() === 'POST');
    await page.getByLabel('App name', { exact: true }).press('Enter');
    const app = (await (await created).json()).app;
    expect(app.name).toBe(appName);
    appId = app.id;
    const first = page.getByRole('dialog', { name: 'Add your first form' });
    const name = first.getByRole('textbox', { name: 'Form name' });
    await expect(name).toBeFocused();
    await name.fill(formName);
    const attached = page.waitForResponse(response => new URL(response.url()).pathname === `/api/apps/${appId}/forms` && response.request().method() === 'POST');
    await name.press('Enter');
    const link = await attached;
    expect(link.ok()).toBe(true);
    formId = link.request().postDataJSON().formId;
    await expect(page).toHaveURL(url => url.pathname === `/builder/${formId}` && url.searchParams.get('appId') === appId);
    await expect(page.getByLabel('Form title', { exact: true })).toHaveValue(formName);
    await page.screenshot({ path: testInfo.outputPath('first-question.png'), animations: 'disabled' });
    const search = page.getByRole('textbox', { name: 'Search field types' });
    if (await search.isVisible()) {
      await page.getByRole('button', { name: 'Browse all fields' }).click();
      await expect(search).toBeFocused();
    }
    await page.getByRole('button', { name: 'Add short text field', exact: true }).click();
    const label = page.getByRole('textbox', { name: 'Label', exact: true });
    await label.fill('Which session would you like?');
    const sheet = page.getByRole('dialog', { name: 'Field settings' });
    if (await sheet.isVisible()) await page.keyboard.press('Escape');
    if (!await search.isVisible()) await page.getByRole('button', { name: 'Add field', exact: true }).first().click();
    await search.fill('email');
    await search.press('Enter');
    await expect.poll(async () => {
      const { form } = await (await context.request.get(`/api/forms/${formId}`)).json();
      return form.fields.map((field: { type: string; label: string }) => [field.type, field.label]);
    }).toEqual([['short_text', 'Which session would you like?'], ['email', 'Email address']]);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit field: Which session would you like?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit field: Email address' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally {
    if (appId) expect((await context.request.delete(`/api/apps/${appId}`, { headers })).ok()).toBe(true);
    if (formId) expect((await context.request.delete(`/api/forms/${formId}`, { headers })).ok()).toBe(true);
  }
});
