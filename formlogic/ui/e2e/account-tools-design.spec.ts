import { expect, test } from '@playwright/test';

const owner = {
  id: 'owner-review', email: 'studio-and-operations-at-a-very-long-address@example.test',
  name: 'Studio owner', plan: 'free', apps: [], forms: [], flows: [],
};
const diagram = {
  id: 'dispatch', name: 'Dispatch board', appId: null, status: 'draft', semanticRevision: 1, layoutRevision: 0,
  elements: [], viewport: null, createdAt: '2026-09-15T12:00:00Z', updatedAt: '2026-09-15T12:00:00Z',
};

for (const width of [390, 1440]) {
  test(`account tools and acting admin at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    const writes: string[] = [];
    const trashReads: string[] = [];
    const unavailable = new Set(['/blueprints/dispatch', '/blueprints/dispatch/history', '/trash']);
    let holdCheck = false;
    let checked: () => void;
    const checkStarted = new Promise<void>(resolve => { checked = resolve; });
    let complete: () => void;
    const pendingCheck = new Promise<void>(resolve => { complete = resolve; });
    await page.route('**/api/**', async route => {
      const { pathname } = new URL(route.request().url());
      const path = pathname.replace(/^.*\/api\//, '/');
      if (path.endsWith('/trash')) trashReads.push(path);
      if (route.request().method() !== 'GET' && route.request().method() !== 'OPTIONS') writes.push(path);
      if (unavailable.has(path)) {
        await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
        return;
      }
      if (path === '/blueprints/removed') return route.fulfill({ status: 404, json: { error: 'Not found' } });
      if (path === '/ai/preferences' && holdCheck) {
        holdCheck = false;
        checked();
        await pendingCheck;
      }
      const fixtures: Record<string, unknown> = {
        '/auth/me': { user: { id: 'tool-reviewer', name: 'Site administrator', email: 'admin@example.test', isAdmin: true, mfaEnabled: true } },
        '/blueprints': { blueprints: [diagram] }, '/blueprints/dispatch': { blueprint: diagram },
        '/blueprints/dispatch/history': { history: [{ changeSetId: 'first', origin: 'manual', operations: [{ type: 'blueprint.element.create' }], createdAt: diagram.createdAt, semanticRevision: 1 }] },
        '/billing': { paypalEnabled: false, usage: { enforced: true, plan: 'free', forms: { used: 2, limit: 3 }, storage: { usedBytes: 1024, limitBytes: 2048 } } },
        '/ai/preferences': { aiSource: 'hosted' },
        '/trash': { items: [{ id: 'deleted', kind: 'form', name: 'Workshop signups', status: 'trashed', daysRemaining: 4,
          meta: { counts: { responses: 12 } }, sizeBytes: 1234, deletedAt: diagram.createdAt, expiresAt: '2026-10-15T12:00:00Z' }] },
        '/admin/users/owner-review': { user: owner },
        '/admin/users/owner-review/trash': { items: [] },
        '/admin/users/owner-review/payments': { payments: [], plan: 'free' },
      };
      await route.fulfill({ json: fixtures[path] ?? { forms: [], apps: [], items: [], notices: [], providers: [], sources: [], connections: [], nodes: [] } });
    });
    const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Plan usage' })).toBeVisible();
    await fits();
    await page.getByRole('link', { name: 'Set up your AI' }).click();
    await page.getByRole('button', { name: /My own API provider/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add your API connection' })).toBeFocused();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose your default AI' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Save AI settings' })).toBeVisible();
    holdCheck = true;
    await page.getByRole('button', { name: 'Check saved setup' }).click();
    await checkStarted;
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const finished = page.waitForResponse(res => res.url().endsWith('/ai/preferences'));
    complete!();
    await finished;
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Choose a provider below and save your AI settings first.')).toHaveCount(0);
    await fits();

    await page.goto('/trash');
    await expect(page.getByText('Couldn’t load the recycle bin')).toBeVisible();
    unavailable.delete('/trash');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('rowheader', { name: /Workshop signups/ })).toBeVisible();
    await page.getByRole('button', { name: 'Delete forever' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await fits();

    await page.goto('/diagrams/all');
    await page.getByRole('link', { name: 'Dispatch board', exact: true }).click();
    await expect(page.getByText('Couldn’t load the diagram')).toBeVisible();
    unavailable.delete('/blueprints/dispatch');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('button', { name: 'Rename diagram Dispatch board' })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle the build timeline' }).click();
    const timeline = page.getByRole('complementary', { name: 'Build timeline' });
    await expect(timeline.getByText('Couldn’t load the timeline')).toBeVisible();
    unavailable.delete('/blueprints/dispatch/history');
    await timeline.getByRole('button', { name: 'Try again' }).click();
    await expect(timeline.getByText('added 1 element')).toBeVisible();
    await fits();
    await page.goto('/diagrams/removed');
    await expect(page.getByText('This diagram could not be found.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

    const ownReadCount = trashReads.length;
    await page.goto('/admin/users/owner-review/trash');
    const banner = page.getByRole('complementary', { name: 'Administrator access' });
    await expect(banner.getByText(owner.email)).toBeInViewport();
    await expect(page.getByText('The recycle bin is empty.')).toBeVisible();
    expect(new Set(trashReads.slice(ownReadCount))).toEqual(new Set(['/admin/users/owner-review/trash']));
    const details = banner.getByText('Record data is hidden. Changes are live for the owner.', { exact: true });
    await expect(details).toBeInViewport();
    expect(await details.evaluate(el => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).display === 'inline')).toBe(true);
    const height = (await banner.boundingBox())!.height;
    await expect.poll(() => page.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--fl-demo-banner-h')))).toBe(Math.ceil(height));
    await fits();
    await page.screenshot({ path: testInfo.outputPath('acting-access.png') });
    await banner.getByRole('button', { name: 'Exit admin view' }).click();
    await expect(page).toHaveURL(/\/admin\/users\/owner-review$/);
    await expect(banner).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
