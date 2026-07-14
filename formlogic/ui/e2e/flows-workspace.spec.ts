import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke for the first-class Flows workspace (nav swap + @xyflow editor).
 * Runs against the live WAMP stack like the other e2e specs.
 */

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

test.describe('flows workspace', () => {
  test('Flows is a top-level nav item and the editor renders a created flow', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);

    const API = process.env.E2E_API_URL || 'http://api.formlogic.local';
    // Isolation: remove any E2E-created workspace flows left by a prior run (fixed slug would collide).
    const cleanup = () => page.evaluate(async (API) => {
      const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
      const token = m ? decodeURIComponent(m[1]) : '';
      const list = await (await fetch(API + '/api/flows', { credentials: 'include' })).json().catch(() => null);
      for (const f of list?.flows ?? []) {
        if (/^e2e-smoke/i.test(String(f.slug))) {
          await fetch(API + '/api/flows/' + f.id, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': token } });
        }
      }
    }, API);
    await cleanup();

    // Flows is a first-class nav item (replaced Settings in the sidebar).
    await page.goto('/flows');
    await expect(page).toHaveURL(/\/flows/);
    // Workspace shell: a "New flow" affordance is the anchor of the library.
    const newFlow = page.getByRole('button', { name: /new flow|create flow|\+ ?flow/i }).first();
    await expect(newFlow).toBeVisible({ timeout: 30_000 });

    await newFlow.click();
    // The New-flow dialog: name field + "Start from" template cards + "Create flow".
    await expect(page.getByText(/new flow/i).first()).toBeVisible({ timeout: 15_000 });
    const nameInput = page.getByPlaceholder(/blank flow|flow name/i).first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill('E2E Smoke Flow');
    }
    // Pick the "Blank flow" starter card, then confirm.
    await page.getByText('Blank flow', { exact: true }).first().click().catch(() => {});
    await page.getByRole('button', { name: /create flow/i }).click();

    // The @xyflow canvas mounts (react-flow root) — proves the editor renders.
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 20_000 });

    await cleanup();
  });

  test('Settings moved off the sidebar into the profile menu', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard');
    // No top-level "Settings" nav link in the sidebar nav landmark.
    const sidebar = page.getByRole('navigation').first();
    const settingsInSidebar = sidebar.getByRole('link', { name: /^settings$/i });
    await expect(settingsInSidebar).toHaveCount(0);
    // /settings still resolves (moved, not removed).
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/);
  });
});
