import { expect, test } from '@playwright/test';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

test('The form picker discovers a new template file and creates its fields', async ({ page, context }) => {
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Requires the isolated local review account.');
  const login = await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  expect(login.ok()).toBe(true);
  await page.goto('/forms');
  const open = () => page.getByRole('button', { name: 'New form', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Create new form', exact: true });
  await open();
  await expect(picker.getByRole('heading', { name: 'Contact Form', exact: true })).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  const id = `local-template-review-${Date.now()}`;
  const directory = resolve('../backend/storage/form-templates');
  const file = resolve(directory, `${id}.json`);
  expect(file.startsWith(directory)).toBe(true);
  await mkdir(directory, { recursive: true });
  const template = { id, name: 'Site visit request', category: 'local-review', categoryLabel: 'Local review', description: 'A starter loaded from a new JSON file', fields: [{ type: 'short_text', label: 'Site address', required: true, properties: {} }, { type: 'date', label: 'Preferred visit', required: false, properties: {} }] };
  try {
    await writeFile(file, JSON.stringify(template));
    await open();
    await picker.getByRole('button', { name: 'Local review', exact: true }).click();
    await picker.getByRole('button', { name: /Site visit request/ }).click();
    await picker.getByRole('button', { name: 'Create form', exact: true }).click();
    await expect(page).toHaveURL(/\/builder\//);
    const formId = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect.poll(async () => {
      const result = await (await context.request.get(`/api/forms/${formId}`)).json();
      return result.form?.fields?.map((field: { label: string }) => field.label);
    }).toEqual(['Site address', 'Preferred visit']);
    await writeFile(file, JSON.stringify({ ...template, name: 'Updated site visit' }));
    await page.goto('/forms');
    await open();
    await expect(picker.getByRole('heading', { name: 'Updated site visit', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await picker.getByRole('combobox', { name: 'Category' }).selectOption('local-review');
    expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: '../../../ecosystem-audit/form-template-folder-mobile.png' });
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.route('**/api/form-templates', route => route.fulfill({ status: 503, json: { error: true, message: 'Template service temporarily unavailable' } }));
    await open();
    await expect(picker.getByRole('alert')).toContainText('You can still start with a blank form');
    await picker.getByRole('button', { name: /Blank form/ }).click();
    await expect(picker.getByRole('button', { name: 'Create form', exact: true })).toBeEnabled();
  } finally { await unlink(file); }
});
