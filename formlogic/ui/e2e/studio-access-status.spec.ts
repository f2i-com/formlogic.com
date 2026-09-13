import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) test(`Users and roles with no vault or desktop ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install();
  const localRequests: string[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  const app = { id: 'access-review', ownerId: 'review', name: 'Customer hub', slug: 'customer-hub', status: 'draft', settings: {}, theme: {}, navConfig: [], createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' };
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^http:\/\/127\.0\.0\.1:17[89]72\//, route => {
    localRequests.push(route.request().url());
    return route.abort('connectionrefused');
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (['17872', '17972'].includes(url.port)) return route.fallback();
    const path = url.pathname.replace(/^.*\/api/, '');
    if (!['GET', 'OPTIONS'].includes(route.request().method())) writes.push(path);
    if (path === '/auth/me') return route.fulfill({ json: { user: { id: 'review', name: 'Reviewer', email: 'review@example.test' } } });
    if (path === '/vault') return route.fulfill({ json: { data: { vault: null } } });
    if (path === '/apps') return route.fulfill({ json: { apps: [app] } });
    if (path === '/apps/access-review') return route.fulfill({ json: { app } });
    if (path === '/apps/access-review/roles') return route.fulfill({ json: { roles: [{ id: 'owner', appId: app.id, name: 'Owner', isSystem: true, sortOrder: 0 }, { id: 'member', appId: app.id, name: 'Member', sortOrder: 1 }] } });
    return route.fulfill({ json: { forms: [], roles: [], users: [], invitations: [], permissions: [], flows: [], bindings: [], versions: [], notices: [], connections: [], keys: [], items: [], nodes: [] } });
  });
  await page.goto('/apps/access-review/studio/access');
  await expect(page.getByRole('heading', { name: 'Users & roles', level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading permissions' })).toHaveCount(0);
  await expect(page.getByText('Everything in this app', { exact: true })).toBeVisible();
  const sections = page.getByRole('tablist', { name: 'Access sections' });
  for (const name of ['People & invites', 'Sign-up', 'Roles']) {
    await sections.getByRole('tab', { name, exact: true }).click();
    await expect(sections.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.getByRole('status', { name: 'Loading permissions' })).toHaveCount(0);
  await expect(page.getByText('Everything in this app', { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(localRequests).toEqual([]);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  // An explicit connection action still starts discovery on the desktop shell.
  if (width === 1440) {
    await page.getByRole('button', { name: 'Desktop connection: No desktop', exact: true }).click();
    await expect.poll(() => localRequests.length).toBeGreaterThan(0);
  }
});
