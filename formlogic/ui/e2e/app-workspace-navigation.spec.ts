import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { appSections, openAppSection } from './app-sections';
import { sessionHeaders } from './session-request';

test.use({ serviceWorkers: 'block' });

test('web and forms apps share a workspace menu and keep the right tools on deep links', async ({ page, context }) => {
  const login = await context.request.post('/api/auth/login', {
    headers: sessionHeaders(),
    data: { email: process.env.E2E_EMAIL || 'test@example.com', password: process.env.E2E_PASSWORD || 'password123' },
  });
  expect(login.ok(), 'signed in to the local workspace').toBe(true);
  const csrf = (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value;
  const headers = { ...sessionHeaders(), 'X-CSRF-Token': csrf };
  const run = randomUUID().slice(0, 8);
  const created: string[] = [];
  let formId: string | undefined;
  const make = async (name: string, web: boolean) => {
    const result = await context.request.post('/api/apps', { headers, data: { name, settings: web ? { softnApp: true } : {} } });
    expect(result.ok()).toBe(true);
    const { app } = await result.json() as { app: { id: string; name: string } };
    expect(app.name).toBe(name);
    created.push(app.id);
    return app;
  };
  try {
    const forms = await make(`Form workspace ${run}`, false);
    const web = await make(`Web workspace ${run}`, true);
    const installed = await context.request.post(`/api/apps/${web.id}/native/starter`, {
      headers, data: { template: 'javascript', home: true, access: 'members' },
    });
    expect(installed.ok()).toBe(true);

    await page.goto('/apps');
    const list = page.getByRole('main');
    await list.getByRole('link', { name: forms.name, exact: true }).click();
    await expect(page.getByRole('heading', { name: forms.name, exact: true, level: 1 })).toBeVisible();
    const menu = await appSections(page);
    await expect(menu.getByRole('link', { name: 'Forms', exact: true })).toHaveAttribute('href', `/apps/${forms.id}/studio/data`);
    await expect(menu.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
    await openAppSection(page, 'Screens');
    await expect(page).toHaveURL(url => url.pathname === `/apps/${forms.id}/studio/screens`);
    const current = page.getByRole('navigation', { name: 'Current app location' }).locator('[aria-current="page"]');
    await expect(current).toHaveText('Screens');
    await openAppSection(page, 'Records');
    await expect(page).toHaveURL(url => url.pathname === `/apps/${forms.id}/records`);
    await expect(current).toHaveText('Records');
    await expect((await appSections(page)).getByRole('link', { name: 'Records', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload({ waitUntil: 'commit' });
    await expect(current).toHaveText('Records');
    await expect((await appSections(page)).getByRole('link', { name: 'Records', exact: true })).toHaveAttribute('aria-current', 'page');
    await openAppSection(page, 'Members');
    await expect(page).toHaveURL(url => url.pathname === `/apps/${forms.id}/studio/access`);
    await expect(current).toHaveText('Members');
    const position = page.getByRole('button', { name: 'Dock position', exact: true });
    if (await position.isVisible()) {
      await position.click();
      await page.getByRole('button', { name: 'Dock top', exact: true }).click();
      const horizontal = page.getByRole('navigation', { name: 'App shortcuts', exact: true });
      await expect(horizontal.getByRole('link', { name: 'Members', exact: true })).toHaveAttribute('aria-current', 'page');
      await horizontal.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === `/apps/${forms.id}/settings`);
      await position.click();
      await page.getByRole('button', { name: 'Dock bottom', exact: true }).click();
      await expect(horizontal.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    }

    await openAppSection(page, 'Overview');
    await page.getByRole('button', { name: 'Back to apps', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/apps');
    await list.getByRole('link', { name: web.name, exact: true }).click();
    await expect(page.getByRole('heading', { name: web.name, exact: true, level: 1 })).toBeVisible();
    const webMenu = await appSections(page);
    await expect(webMenu.getByRole('link', { name: 'Forms', exact: true })).toHaveCount(0);
    await expect(webMenu.getByRole('link', { name: 'Edit', exact: true })).toHaveAttribute('href', `/apps/${web.id}/web/edit`);
    await openAppSection(page, 'Settings');
    await expect(page).toHaveURL(url => url.pathname === `/apps/${web.id}/web/settings`);
    await page.goto(`/apps/${web.id}/softn/data`);
    await expect(page).toHaveURL(url => url.pathname === `/apps/${web.id}/web/data`);
    await expect((await appSections(page)).getByRole('link', { name: 'Data', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // After attaching a form, both workspaces belong to one app. Follow real hyperlinks across
    // the project, form tools and records, and ensure their destinations stay available.
    const draft = await context.request.post('/api/forms', { headers, data: { title: `Intake ${run}`, fields: [], status: 'draft' } });
    expect(draft.ok()).toBe(true);
    formId = (await draft.json()).form.id;
    const attachment = await context.request.post(`/api/apps/${web.id}/forms`, { headers, data: { formId, displayName: 'Intake' } });
    expect(attachment.ok()).toBe(true);
    await page.reload({ waitUntil: 'commit' });
    const links = async () => (await appSections(page)).getByRole('link').evaluateAll(elements => elements.map(link => [
      link.getAttribute('aria-label') ?? link.textContent?.trim(), link.getAttribute('href'),
    ]));
    const formPath = `/apps/${web.id}/studio/data`;
    const editPath = `/apps/${web.id}/web/edit`;
    const recordsPath = `/apps/${web.id}/records`;
    const initialMenu = await appSections(page);
    await expect(initialMenu.locator(`a[href="${formPath}"]`)).toBeVisible();
    await expect(initialMenu.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', `/apps/${web.id}/web/settings`);
    await expect(initialMenu.getByRole('link', { name: 'Form settings', exact: true })).toHaveAttribute('href', `/apps/${web.id}/settings`);
    const destinations = await links();
    for (const [path, label] of [[formPath, 'Forms'], [recordsPath, 'Form records'], [`/apps/${web.id}/settings`, 'Form settings'], [editPath, 'Edit']]) {
      await (await appSections(page)).locator(`a[href="${path}"]`).click();
      await expect(page).toHaveURL(url => url.pathname === path);
      await expect(current).toHaveText(label);
      await expect((await appSections(page)).locator(`a[href="${path}"]`)).toHaveAttribute('aria-current', 'page');
      await expect.poll(links).toEqual(destinations);
    }
  } finally {
    for (const id of created) expect((await context.request.delete(`/api/apps/${id}`, { headers })).ok()).toBe(true);
    if (formId) expect((await context.request.delete(`/api/forms/${formId}`, { headers })).ok()).toBe(true);
  }
});

const memberApps = [
  { id: 'forms-member-app', name: 'Volunteer intake', slug: 'volunteers', settings: {} },
  { id: 'web-member-app', name: 'Meet calendar', slug: 'meet-calendar', settings: { softnApp: true } },
].map(app => ({ ...app, canManage: false, status: 'published', navConfig: [], theme: {}, updatedAt: '2026-09-01T00:00:00Z' }));

for (const app of memberApps) test(`ordinary members open ${app.name} from the app list and management bookmark`, async ({ page, context }) => {
  await context.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'member', name: 'Member', email: 'member@example.test' } } });
    if (path === '/api/apps') return route.fulfill({ json: { apps: memberApps } });
    const match = memberApps.find(item => path === '/api/apps/' + item.id || path === '/api/app/' + item.slug);
    if (match) return route.fulfill({ json: { app: match } });
    if (path.endsWith('/membership')) return route.fulfill({ json: { isMember: true, status: 'active' } });
    return route.fulfill({ json: { apps: [], forms: [], flows: [], roles: [], permissions: [], users: [], domains: [], installations: [], versions: [], summaries: [], count: 0 } });
  });
  const runtimePath = '/app/' + app.slug;
  await page.goto('/apps');
  const entry = page.getByRole('main').getByRole('link', { name: app.name, exact: true });
  await expect(entry).toHaveAttribute('href', runtimePath);
  await entry.click();
  await expect(page).toHaveURL(url => url.pathname === runtimePath);

  const bookmark = await context.newPage();
  await bookmark.goto(`/apps/${app.id}/${app.settings.softnApp ? 'web/edit' : 'studio/screens'}`, { waitUntil: 'commit' });
  await expect(bookmark).toHaveURL(url => url.pathname === runtimePath);
  await expect(bookmark.getByRole('navigation', { name: 'App sections', exact: true })).toHaveCount(0);
  await expect(bookmark.getByRole('button', { name: 'Sections', exact: true })).toHaveCount(0);
});
