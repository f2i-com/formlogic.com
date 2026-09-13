import { expect, test } from '@playwright/test';
import { readFileSync, cpSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

test('folder pack installs an editable workspace connected to its real forms', async ({ page, context }) => {
  test.setTimeout(180000);
  test.skip(!process.env.FORMLOGIC_REVIEW_PASSWORD, 'Local review account required');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const catalogResponse = await context.request.get('/api/packs/catalog?limit=50');
  expect(catalogResponse.ok(), await catalogResponse.text()).toBe(true);
  const catalog = await catalogResponse.json();
  expect(catalog.packs.filter((p: {folderSource?: boolean}) => p.folderSource)).toHaveLength(29);
  expect(catalog.packs.filter((p: {slug: string}) => p.slug === 'aokie-receptionist')).toHaveLength(1);
  await page.goto('/packs/clinic-appointment-intake');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download app sources', exact: true }).click();
  const download = await downloadEvent;
  const archive = unzipSync(readFileSync((await download.path())!));
  expect(JSON.parse(strFromU8(archive['pack.json'])).id).toBe('clinic-appointment-intake');
  expect(archive['install.json']).toBeTruthy();
  const pack = JSON.parse(strFromU8(archive['manifest.json']));
  const bundle = Object.keys(archive).find(path => path.endsWith('.softn'))!;
  const project = unzipSync(archive[bundle]);
  expect(project['server/packGuide.logic']).toBeTruthy();
  expect(project['ui/main.ui']).toBeTruthy();
  expect(JSON.parse(strFromU8(project['formlogic.json'])).actions.packGuide.access).toBe('member');

  // The same download can become a live, editable catalogue folder without rebuilding.
  const sourceRoot = fileURLToPath(new URL('../../backend/storage/pack-projects/', import.meta.url));
  const sourceId = `download-folder-review-${Date.now()}`;
  const sourceFolder = resolve(sourceRoot, sourceId);
  try {
    for (const [path, bytes] of Object.entries(archive)) {
      const target = resolve(sourceFolder, path);
      expect(target.startsWith(sourceFolder + sep)).toBe(true);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const meta = JSON.parse(strFromU8(archive['pack.json']));
    const install = JSON.parse(strFromU8(archive['install.json']));
    meta.id = sourceId; install.packMeta.id = sourceId;
    writeFileSync(resolve(sourceFolder, 'pack.json'), JSON.stringify(meta));
    writeFileSync(resolve(sourceFolder, 'install.json'), JSON.stringify(install));
    const reloaded = await context.request.get(`/api/packs/catalog/${sourceId}/download`);
    expect(reloaded.ok(), await reloaded.text()).toBe(true);
    const recompiled = (await reloaded.json()).pack;
    expect(recompiled.apps[0].hostedProject).toEqual(pack.apps[0].hostedProject);
    expect(recompiled.forms).toEqual(pack.forms);
  } finally {
    expect(dirname(sourceFolder)).toBe(resolve(sourceRoot));
    expect(sourceId.startsWith('download-folder-review-')).toBe(true);
    rmSync(sourceFolder, { recursive: true, force: true });
  }

  await context.request.post('/api/auth/login', { data: { email: 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  const headers = { 'X-CSRF-Token': (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value };
  const previous = (await (await context.request.get('/api/packs/installed')).json()).installations ?? [];
  for (const item of previous) if (item.packId?.startsWith('folder-pack-review-')) await context.request.delete(`/api/packs/${item.id}`, { headers });
  // Isolated copy; never replace a user's installation.
  pack.packMeta.id = `folder-pack-review-${Date.now()}`;
  pack.packMeta.name = 'Folder pack review';
  pack.apps[0].name = 'Clinic folder review';
  const importedResponse = await context.request.post('/api/packs/import', { headers, data: { pack, approvedConnectorGrants: [] } });
  expect(importedResponse.ok(), await importedResponse.text()).toBe(true);
  const imported = await importedResponse.json();
  const id = imported.apps[0].id;
  const app = (await (await context.request.get(`/api/apps/${id}`)).json()).app;
  expect(app.settings.hostedDashboard).toBe(true);
  const deployment = (await (await context.request.get(`/api/apps/${id}/hosting`)).json()).deployment;
  expect(deployment.actions.packGuide.source).toContain('onRequest');
  const patientForm = imported.forms.find((f: {title: string}) => f.title === 'Patient');
  const created = await context.request.post(`/api/app/${app.slug}/forms/${patientForm.id}/responses`, { headers, data: { answers: { full_name: 'Sample Person', date_of_birth: '1990-01-01', phone: '0400000000' } } });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto(`/app/${app.slug}`);
  const frame = page.frameLocator('iframe[title="Hosted app"]');
  await expect(frame.getByRole('heading', { name: 'Clinic folder review', exact: true })).toBeVisible({ timeout: 45000 });
  await expect(frame.getByRole('heading', { name: 'Patients', exact: true })).toBeVisible();
  await frame.getByText('Getting started', { exact: true }).click();
  await expect(frame.getByText('Choose a form or tool to get started.', { exact: true })).toBeVisible();
  await frame.getByLabel('Find a form or tool').fill('Patient');
  const patient = frame.locator('article.card').filter({ has: frame.getByRole('heading', { name: 'Patients', exact: true }) });
  await patient.getByRole('button', { name: 'Recent records' }).click();
  await expect(frame.getByText('Sample Person', { exact: true })).toBeVisible();
  await frame.getByText('Sample Person', { exact: true }).click();
  await expect(frame.getByText('Full Name', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(patient).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await frame.getByRole('heading', { name: 'Clinic folder review', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../../../ecosystem-audit/folder-pack-mobile.png', fullPage: true });
  await frame.getByRole('button', { name: 'Dashboard & reports' }).click();
  await expect(page).toHaveURL(/dashboard=classic/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/apps/${id}/studio/screens`);
  await page.getByText('Hosting & app tools', { exact: true }).click();
  await page.getByRole('button', { name: 'App hosting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Visual Builder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open AI Studio' })).toBeVisible();
  // Imported .softn source keeps server actions private when brought back into hosting.
  await page.getByLabel('Import app project').setInputFiles({ name: 'clinic.softn', mimeType: 'application/zip', buffer: Buffer.from(archive[bundle]) });
  await expect(page.getByText('Project imported as a draft. Review the files and publish when ready.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('adding, editing and hiding a folder updates the live catalogue', async ({ request, baseURL }) => {
  test.skip(!baseURL || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Local server filesystem only');
  const root = fileURLToPath(new URL('../../backend/storage/pack-projects/', import.meta.url));
  const id = `catalog-folder-review-${Date.now()}`;
  const folder = resolve(root, id);
  expect(dirname(folder)).toBe(resolve(root));
  cpSync(fileURLToPath(new URL('../../backend/resources/packs/clinic-appointment-intake', import.meta.url)), folder, { recursive: true, errorOnExist: true });
  try {
    const meta = JSON.parse(readFileSync(resolve(folder, 'pack.json'), 'utf8'));
    const install = JSON.parse(readFileSync(resolve(folder, 'install.json'), 'utf8'));
    meta.id = id; meta.name = 'Folder loading review'; install.packMeta.id = id;
    writeFileSync(resolve(folder, 'pack.json'), JSON.stringify(meta));
    writeFileSync(resolve(folder, 'install.json'), JSON.stringify(install));
    let detail = await (await request.get(`/api/packs/catalog/${id}`)).json();
    expect(detail.pack.name).toBe('Folder loading review');
    meta.name = 'Updated folder loading review';
    writeFileSync(resolve(folder, 'pack.json'), JSON.stringify(meta));
    detail = await (await request.get(`/api/packs/catalog/${id}`)).json();
    expect(detail.pack.name).toBe('Updated folder loading review');
    const alias = 'updated-folder-loading-review';
    const aliasDetail = await (await request.get(`/api/packs/catalog/${alias}`)).json();
    expect(aliasDetail.pack.slug).toBe(id);
    expect((await request.get(`/api/packs/catalog/${alias}/download`)).ok()).toBe(true);
    const listing = await (await request.get('/api/packs/catalog?search=Updated%20folder%20loading')).json();
    expect(listing.packs.map((p: {slug: string}) => p.slug)).toContain(id);
    writeFileSync(resolve(folder, 'pack.json'), JSON.stringify({ ...meta, disabled: true }));
    expect((await request.get(`/api/packs/catalog/${id}`)).status()).toBe(404);
    expect((await request.get(`/api/packs/catalog/${alias}`)).status()).toBe(404);
    expect((await request.get(`/api/packs/catalog/${alias}/download`)).status()).toBe(404);
  } finally {
    // Only the test-created folder directly under the configured local pack root can be removed.
    expect(dirname(folder)).toBe(resolve(root));
    expect(id).toMatch(/^catalog-folder-review-/);
    rmSync(folder, { recursive: true });
  }
});
