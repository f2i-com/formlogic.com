import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { Form } from '../src/types/form';

for (const width of [1440, 390]) test(`Unnamed form, rename and editable app download ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let form: Form | undefined;
  let failRename = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    const method = route.request().method();
    if (path === '/auth/me') return route.fulfill({ json: { user: { id: 'review', name: 'Reviewer', email: 'review@example.test' } } });
    if (path === '/health') return route.fulfill({ json: { status: 'ok' } });
    if (method === 'DELETE') throw new Error('Drafts must not be automatically deleted');
    if (path === '/vault') return route.fulfill({ json: { data: { vault: null } } });
    if (path === '/forms' && method === 'POST') {
      form = route.request().postDataJSON();
      return route.fulfill({ json: { form } });
    }
    if (path === '/forms') return route.fulfill({ json: { forms: form ? [form] : [], count: form ? 1 : 0 } });
    if (form && path === `/forms/${form.id}`) {
      if (method === 'PUT' || method === 'PATCH') {
        if (failRename) return route.fulfill({ status: 503, json: { error: 'Test save failure' } });
        form = { ...form, ...route.request().postDataJSON() };
      }
      return route.fulfill({ json: { form } });
    }
    return route.fulfill({ json: { forms: [], apps: [], roles: [], users: [], invitations: [], permissions: [], flows: [], bindings: [], versions: [], notices: [], connections: [], keys: [], items: [], nodes: [], installations: [], contexts: [], count: 0 } });
  });
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Create new form' });
  await expect(picker.getByRole('button', { name: 'Create form', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: 'Create form', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Form title', exact: true })).toHaveValue('Untitled Form');
  expect(form?.title).toBe('Untitled Form');
  // Loading the workspace must retain a deliberately empty, unnamed draft.
  await page.goto('/forms');
  await page.getByRole('button', { name: 'Card view', exact: true }).click();
  await page.getByRole('link', { name: 'Open Untitled Form in the builder', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Form title', exact: true });
  await title.fill('Customer enquiries');
  await title.press('Enter');
  await expect.poll(() => form?.title).toBe('Customer enquiries');
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Download app project' }).click();
  const exporter = page.getByRole('dialog', { name: 'Create app project' });
  await exporter.getByRole('button', { name: 'Prepare project', exact: true }).click();
  await expect(exporter.getByText('Ready: 1 screen · 0 fields')).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await exporter.getByRole('button', { name: 'Download project', exact: true }).click();
  const download = await downloadEvent;
  const archive = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(archive);
  expect(archive).toMatch(/\.softn$/);
  const files = unzipSync(await readFile(archive));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.files.ui).toHaveLength(2);
  expect(manifest.files.logic).toHaveLength(2);
  expect(strFromU8(files[manifest.files.ui[1]])).toContain('Customer enquiries');
  await page.goto('/forms');
  await page.getByRole('button', { name: 'Card view', exact: true }).click();
  // The actions menu fits itself to the viewport above or below its trigger and
  // focuses its first item without scrolling, so opening it never scrolls the page.
  // It still closes on a page scroll (its fixed position would go stale), though not
  // on its own overflow scroll. The explicit scroll is redundant with click()'s own
  // scroll into view and kept as harmless; wait for the open menu before choosing.
  const actions = page.getByRole('button', { name: 'Actions for Customer enquiries', exact: true });
  await actions.scrollIntoViewIfNeeded();
  await actions.click();
  const actionsMenu = page.getByRole('menu', { name: 'Actions for Customer enquiries', exact: true });
  await expect(actionsMenu).toBeVisible();
  await actionsMenu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename form' });
  await rename.getByRole('textbox', { name: 'Form name', exact: true }).fill('Bookings');
  failRename = true;
  await rename.getByRole('button', { name: 'Save name', exact: true }).first().click();
  await expect(rename.getByRole('alert')).toContainText('could not be saved');
  failRename = false;
  await rename.getByRole('button', { name: 'Save name', exact: true }).first().click();
  await expect(rename).toBeHidden();
  expect(form?.title).toBe('Bookings');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'Rename Bookings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await rename.getByRole('textbox', { name: 'Form name', exact: true }).fill('   ');
  await rename.getByRole('button', { name: 'Save name', exact: true }).first().click();
  await expect(rename).toBeHidden();
  expect(form?.title).toBe('Untitled Form');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('forms-renamed.png'), fullPage: true });
  expect(errors).toEqual([]);
});
