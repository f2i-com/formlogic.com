import { test, expect, type Page } from '@playwright/test';

/**
 * Product-differentiator golden paths (launch-review #9, priority 1-2): a marketplace app's dashboard
 * renders POPULATED widgets, and an app's records grid shows seeded data. Runs against the public Live
 * Demo (server-read-only; per-browser overlay), which has the marketplace pre-installed and seeded, so
 * the widgets have real data. Needs the demo provisioned (php bin/provision-demo.php); the whole
 * suite is the release gate (e2e.yml).
 */
const API = process.env.E2E_API_URL || 'http://api.formlogic.local';

/** Mint the shared Demo session (no signup) and return the first demo app's slug. */
async function startDemo(page: Page): Promise<string> {
  const r = await page.context().request.post(`${API}/api/demo/start`, {
    headers: { 'Content-Type': 'application/json' },
    data: {},
  });
  expect(r.ok(), 'demo/start should succeed (is the demo provisioned?)').toBeTruthy();
  const apps = await page.context().request.get(`${API}/api/demo/apps`);
  const body = await apps.json();
  const list = body.apps ?? body.data?.apps ?? [];
  expect(list.length, 'demo should have apps').toBeGreaterThan(0);
  return list[0].slug as string;
}

test('marketplace app dashboard renders populated recharts widgets', async ({ page }) => {
  const slug = await startDemo(page);
  await page.goto(`/app/${slug}`);

  const chart = page.locator('svg.recharts-surface').first();
  await expect(chart).toBeVisible({ timeout: 20000 });
  expect(await page.locator('svg.recharts-surface').count()).toBeGreaterThan(0);

  // "Populated", not just present: the charts contain rendered geometry (bars/points/slices/lines),
  // not an empty axis.
  await page.waitForTimeout(1500);
  const geometry = await page.locator(
    'svg.recharts-surface .recharts-bar-rectangle, svg.recharts-surface .recharts-dot, svg.recharts-surface .recharts-pie-sector, svg.recharts-surface path.recharts-curve'
  ).count();
  expect(geometry, 'charts should have rendered data geometry').toBeGreaterThan(0);
});

test('opening an app records grid shows seeded records', async ({ page }) => {
  const slug = await startDemo(page);

  await page.goto(`/app/${slug}/records`);
  const firstForm = page.getByRole('button').filter({ hasText: 'View records' }).first();
  await expect(firstForm).toBeVisible({ timeout: 15000 });
  await firstForm.click();

  await expect(page.getByText(/\d+ records?/)).toBeVisible({ timeout: 15000 });
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 15000 });
  expect(await rows.count()).toBeGreaterThan(0);
});
