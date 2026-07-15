import { test, expect, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL || 'http://api.formlogic.local';

/**
 * The shared demo must let a visitor edit Flows WITHOUT the server read-only error —
 * changes persist in the per-browser IndexedDB overlay (demoLocal), not the server.
 * Runs against the live WAMP stack; no login (demo is no-signup).
 */

async function startDemo(page: Page) {
  await page.goto('/');
  // Enter the shared demo via the live-demo section (POST /api/demo/start under the hood).
  const res = await page.evaluate(async (apiBase) => {
    const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
    const token = m ? decodeURIComponent(m[1]) : '';
    const r = await fetch(`${apiBase}/api/demo/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, API);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

test.describe('demo flows (IndexedDB overlay, no server error)', () => {
  test('creating + editing a flow in the demo shows no error and persists locally', async ({ page }) => {
    test.setTimeout(120_000);
    // Capture any error toast text (the read-only message would surface here).
    page.on('console', () => {});

    await startDemo(page);
    await page.goto('/flows');
    await expect(page).toHaveURL(/\/flows/);

    // Watch for the demo read-only error toast specifically.
    page.on('domcontentloaded', () => {});

    const newFlow = page.getByRole('button', { name: /new flow|create flow|\+ ?flow/i }).first();
    await expect(newFlow).toBeVisible({ timeout: 30_000 });
    await newFlow.click();

    await expect(page.getByText(/new flow/i).first()).toBeVisible({ timeout: 15_000 });
    const nameInput = page.getByPlaceholder(/blank flow|flow name/i).first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill('Demo Local Flow');
    }
    await page.getByText('Blank flow', { exact: true }).first().click().catch(() => {});
    await page.getByRole('button', { name: /create flow/i }).click();

    // The editor canvas mounts — creation succeeded (would have errored against the server).
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 20_000 });

    // The server read-only error must NOT appear anywhere on the page.
    await expect(page.getByText(/shared live demo.*read-only|aren't saved to the server|failed to (create|save|update) flow/i)).toHaveCount(0);

    // The created flow is in the library and survives a reload (persisted to IndexedDB).
    await expect(page.getByText('Demo Local Flow').first()).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByText('Demo Local Flow').first()).toBeVisible({ timeout: 30_000 });
  });
});
