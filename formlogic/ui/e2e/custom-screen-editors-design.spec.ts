import { expect, test, type Page } from '@playwright/test';

const screen = {
  enabled: true, _trust: 'untrusted', html: '<h1>Request board</h1>',
  files: [{ path: 'index.html', content: '<h1>Request board</h1>' }, { path: 'styles.css', content: 'body { margin: 0; }' }],
};
const app = { id: 'editor-app', name: 'Service desk', slug: 'service-desk', ownerId: 'editor-owner', status: 'draft', settings: {}, theme: {}, navConfig: [], customScreen: screen };
const form = {
  id: 'editor-form', title: 'Service requests', status: 'published', settings: {}, theme: {},
  fields: [{ id: 'site', label: 'Site', type: 'short_text', properties: {}, order: 0 }],
  responseCount: 0, customScreen: screen, createdAt: '2026-01-01', updatedAt: '2026-01-01',
};

async function serveFixtures(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const payloads: Record<string, unknown> = {
      '/api/health': { status: 'ok' },
      '/api/auth/me': { user: { id: app.ownerId, name: 'Owner', email: 'owner@example.test' } },
      '/api/apps': { apps: [app] },
      [`/api/apps/${app.id}`]: { app },
      [`/api/apps/${app.id}/forms`]: { forms: [{ id: 'attachment', appId: app.id, formId: form.id, displayName: form.title, isVisible: true, settings: {} }] },
      '/api/forms': { forms: [form], count: 1 },
      [`/api/forms/${form.id}`]: { form },
      [`/api/forms/${form.id}/responses`]: { responses: [], count: 0 },
    };
    return route.fulfill({ json: payloads[path] ?? {
      apps: [], forms: [], roles: [], flows: [], bindings: [], groups: [], permissions: [], users: [],
      invitations: [], versions: [], domains: [], blueprints: [], notices: [], installations: [], connections: [], available: false,
    } });
  });
}

for (const width of [390, 1440]) {
  test(`screen and app-home editors keep code usable at ${width}px`, async ({ page }) => {
    await serveFixtures(page);
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [path, destination] of [
      [`/forms/${form.id}/screen/edit`, `/builder/${form.id}`],
      [`/apps/${app.id}/home/edit`, `/apps/${app.id}/studio/screens`],
    ]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const code = page.locator('.monaco-editor').first();
      await expect(code).toBeVisible();
      const preview = page.getByText(/^Live preview/);
      if (width === 390) {
        await expect(preview).toHaveCount(0);
        expect((await code.boundingBox())!.width).toBeGreaterThan(330);
        const files = page.getByRole('button', { name: 'Files index.html', exact: true });
        await files.click();
        await expect(files).toHaveAttribute('aria-expanded', 'true');
        await page.getByRole('button', { name: 'styles.css', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Files styles.css', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(preview).toBeVisible();
        await expect(code).toBeHidden();
        await page.getByRole('button', { name: 'Edit code', exact: true }).click();
        await expect(code).toBeVisible();
      } else {
        await expect(preview).toBeVisible();
        await expect(page.getByRole('button', { name: 'index.html', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Hide preview', exact: true }).click();
        await expect(preview).toHaveCount(0);
        await expect(code).toBeVisible();
      }
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === destination);
      if (destination.startsWith('/builder/')) await expect(page.getByRole('button', { name: 'Back to Forms' })).toBeVisible();
      else await expect(page.getByRole('navigation', { name: 'Current app location' }).locator('[aria-current="page"]')).toHaveText('Screens');
    }
    await page.goto('/forms');
    await expect(page.getByRole('heading', { name: 'No standalone forms' })).toBeVisible();
    await page.getByRole('button', { name: 'Service desk 1 form' }).click();
    await page.getByRole('button', { name: 'Add a form in App Studio' }).click();
    await expect(page).toHaveURL(url => url.pathname === '/apps/editor-app/studio/data');
    expect(errors.filter(message => message.includes('Missing requestHandler'))).toEqual([]);
  });
}
