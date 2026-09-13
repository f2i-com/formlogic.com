import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { createFormlogicProject } from '../src/lib/softn/project';

// Runs against the existing SoftN deployment served locally; no live account data.
test('Exported forms run together and keep their records separate', async ({ page }, testInfo) => {
  test.skip(!process.env.SOFTN_REVIEW_URL, 'Set SOFTN_REVIEW_URL to a local SoftN runtime.');
  const project = createFormlogicProject({ app: { id: 'export-review', name: 'Customer workspace' }, origin: 'http://127.0.0.1:5173', forms: [
    { id: 'contacts', title: 'Contacts', fields: [{ id: 'name', type: 'short_text', label: 'Full name', required: true }] },
    { id: 'bookings', title: 'Appointments', fields: [{ id: 'name', type: 'short_text', label: 'Guest name', required: true }] },
  ] });
  const bytes = zipSync(Object.fromEntries(Object.entries(project.files).map(([path, source]) => [path, strToU8(source)])));
  await page.route('**/examples/review-forms.softn', route => route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(bytes) }));
  await page.goto(`${process.env.SOFTN_REVIEW_URL}/web/?open=%2Fexamples%2Freview-forms.softn`);
  await expect(page.getByRole('heading', { name: 'Customer workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Full name' }).fill('Lance Contact');
  await page.getByRole('button', { name: 'Add record', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('cell', { name: 'Lance Contact', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Appointments', exact: true }).click();
  await page.getByRole('textbox', { name: 'Guest name' }).fill('Friday Appointment');
  await page.getByRole('button', { name: 'Add record', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('cell', { name: 'Friday Appointment', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Lance Contact', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Lance Contact', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Friday Appointment', exact: true })).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('combined-form-app.png'), fullPage: true });
});
