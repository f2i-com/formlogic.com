import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { sessionHeaders } from './session-request';

// A download sealed with a passphrase, and back, through the real page. The file has to be useless
// without the passphrase, and the restore has to ask for it.
const RUN = Date.now().toString(36);
const PASSPHRASE = 'correct horse battery staple';

test('an account backup with a passphrase downloads sealed and restores with it', async ({ page, context }) => {
  test.setTimeout(120_000);
  const email = `backup-${RUN}@e2e-apps.com`;
  const registered = await context.request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: 'backup-e2e-password-1', name: 'Backup' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value };
  const planted = `Sealed form ${RUN}`;
  const created = await context.request.post('/api/forms', { headers, data: { title: planted, fields: [{ id: 'name', type: 'short_text', label: 'Name', required: false }] } });
  expect(created.ok(), await created.text()).toBe(true);

  await page.goto('/settings#backup');
  await expect(page.getByRole('heading', { name: 'Backup & restore', exact: true })).toBeVisible();

  const passphrase = page.getByLabel('Passphrase (optional)');
  await passphrase.fill('too short');
  await expect(page.getByRole('button', { name: 'Download backup' })).toBeDisabled();
  await passphrase.fill(PASSPHRASE);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip\.flbk$/);
  const sealed = await readFile(await download.path());
  expect(sealed.subarray(0, 6).toString()).toBe('FLBK1\n');
  expect(sealed.includes(planted)).toBe(false);
  await expect(passphrase).toHaveValue('');

  await page.locator('input[type="file"][accept*=".flbk"]').setInputFiles({ name: 'backup.zip.flbk', mimeType: 'application/octet-stream', buffer: sealed });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Restore backup' })).toBeDisabled();

  await dialog.getByLabel('Passphrase').fill('the wrong one entirely');
  await dialog.getByRole('button', { name: 'Restore backup' }).click();
  await expect(page.getByText('That does not open this backup', { exact: false }).first()).toBeVisible();

  await page.locator('input[type="file"][accept*=".flbk"]').setInputFiles({ name: 'backup.zip.flbk', mimeType: 'application/octet-stream', buffer: sealed });
  await dialog.getByLabel('Passphrase').fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Restore backup' }).click();
  await expect(page.getByText('Created 0 apps, 1 form', { exact: false }).first()).toBeVisible();
});
