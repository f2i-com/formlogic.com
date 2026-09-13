import { test, expect } from '@playwright/test';

// Browser-only fixtures: no notices, account changes, or upgrades reach a real server.
const user = { id: 'admin-preview', email: 'admin@example.test', name: 'Site administrator', isAdmin: true, mfaEnabled: true };
const account = { id: 'user-preview', email: 'lance@example.test', name: 'Lance', plan: 'free', isAdmin: false, isDemo: false, online: true, apps: [], forms: [], flows: [], createdAt: '2026-09-01' };
const plans = { freeName: 'Free', paidName: 'Supporter', freeDescription: 'Build with your own AI', paidDescription: 'Support FormLogic', pricePerMonthCents: 500, paymentsEnabled: false, siteAiEnabled: false };
const overview = { stats: { users: 128, admins: 2, onlineUsers: 8, signups7d: 16, apps: 43, forms: 96, flows: 24, responses: 12600 }, version: '0.0.1', maintenance: { enabled: false, message: '' }, sessionEpoch: 0 };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    const fixtures: Record<string, unknown> = {
      '/auth/me': { user }, '/admin/overview': overview,
      '/admin/users': { users: [account], total: 1, page: 1, pages: 1 },
      '/admin/users/user-preview': { user: account },
      '/admin/users/user-preview/payments': { payments: [], plan: 'free', cloudUntil: null, complimentary: false },
      '/admin/maintenance': { maintenance: { enabled: false, message: 'We will be back shortly.' }, onlineUsers: 8 },
      '/admin/plans': { plans }, '/admin/notices': { notices: [] },
      '/admin/backups': { runs: [], lastRun: null },
      '/admin/allowances': { allowances: [{ plan: 'free', metric: 'ai_messages', monthlyValue: 100, enabled: false }] },
      '/admin/upgrade/status': { currentVersion: '0.0.1', layout: { supported: true, mode: 'deployed' }, staged: null, backups: [], history: [], maintenance: { enabled: false } },
      '/health/deep': { status: 'ok', timestamp: '2026-09-13T00:00:00Z', checks: { quickjs: { ok: true, critical: true, name: 'sandboxRuntime', detail: 'ZIPP runtime launcher executable + shared prelude present' }, database: { ok: true, critical: true, detail: 'Database connection ready' }, scheduled_backup: { ok: true, critical: false, detail: 'No scheduled backup yet', warning: 'Set up a daily backup schedule.' } } },
      '/forms': { forms: [] }, '/apps': { apps: [] }, '/notices': { notices: [] }, '/billing/status': { plan: 'free', paymentsEnabled: false },
    };
    await route.fulfill({ json: fixtures[path] ?? {} });
  });
});
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  for (const theme of ['light', 'dark']) {
    test(`admin navigation and layout ${viewport.width}px ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(theme => localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme, sidebarCollapsed: true }, version: 0 })), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Installation status' })).toBeVisible();
      for (const [label, path, content] of [['Overview', '/admin', 'Manage your installation'], ['Users', '/admin/users', 'lance@example.test'], ['Platform', '/admin/platform', 'Plans & bring your own AI'], ['Updates', '/admin/upgrade', 'Check for updates'], ['System health', '/admin/doctor', 'All critical checks passing']]) {
        await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(path + '$'));
        await expect(page.getByText(content, { exact: false }).first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label} horizontal overflow`).toBe(true);
        if (label === 'System health') {
          await expect(page.getByText('ZIPP runtime', { exact: true })).toBeVisible();
          await expect(page.getByText('ZIPP runtime launcher executable + shared prelude present', { exact: true })).toBeVisible();
          await expect(page.getByText('QuickJS runtime', { exact: true })).toHaveCount(0);
        }
        if (label === 'Platform') {
          const price = page.getByLabel('Price per 30 days (USD)');
          await expect(page.getByRole('button', { name: 'Save plan settings' })).toBeDisabled();
          await price.fill('8.00');
          await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
          await expect(price).toHaveValue('5.00');
          await page.getByRole('navigation', { name: 'Platform settings' }).getByRole('link', { name: 'Usage limits' }).click();
          await expect(page.getByRole('heading', { name: 'AI & credits allowances' })).toBeInViewport();
          await page.getByRole('navigation', { name: 'Platform settings' }).getByRole('link', { name: 'Plans & AI' }).click();
        }
        await page.screenshot({ path: testInfo.outputPath(`${label.replaceAll(' ', '-')}.png`), fullPage: true });
      }
      await page.goto('/admin/users/user-preview');
      await expect(page.getByRole('heading', { name: 'lance@example.test' })).toBeVisible();
      await expect(page.getByText('No payments on record.')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Account horizontal overflow').toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
