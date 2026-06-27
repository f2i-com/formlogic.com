import { test, expect, type Page } from '@playwright/test';

// Verifies that signing in auto-enables cloud (API) storage so server-backed
// features work without a manual toggle. No storage-mode seeding here on purpose:
// the app defaults to local storage, and login should switch a signed-in user to
// cloud (syncing any local forms first).

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

test('signing in auto-enables cloud storage', async ({ page }) => {
  await login(page);
  // The app should sync (0 local forms) and switch to API mode, persisting the
  // preference to localStorage.
  await expect
    .poll(
      () => page.evaluate(() => {
        try { return localStorage.getItem('formlogic_storage_mode'); } catch { return null; }
      }),
      { timeout: 20_000, message: 'storage mode should auto-switch to api after login' }
    )
    .toBe('api');
});
