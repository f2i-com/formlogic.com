// Audit FL-29 — automated accessibility smoke over the golden-path surfaces.
//
// Axe (via @axe-core/playwright) scans each page for WCAG A/AA violations of
// the serious/critical impact tiers; any hit FAILS the run with the offending
// nodes named. Moderate/minor findings are reported to the console without
// failing (burn-down visibility, no blind churn). Runs with the normal E2E
// stack (live app + seeded test account) on every configured browser project.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

async function expectNoSeriousViolations(page: Page, surface: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical'
  );
  const advisory = results.violations.filter(
    (violation) => violation.impact !== 'serious' && violation.impact !== 'critical'
  );
  for (const violation of advisory) {
    console.log(
      `[a11y advisory] ${surface}: ${violation.id} (${violation.impact}) × ${violation.nodes.length}`
    );
  }
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 3).map((node) => node.target),
    })),
    `${surface} must have no serious/critical WCAG A/AA violations`
  ).toEqual([]);
}

test.describe('accessibility smoke (axe)', () => {
  test('login page', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').waitFor();
    await expectNoSeriousViolations(page, 'login');
  });

  test('dashboard', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.getByRole('main').waitFor();
    await expectNoSeriousViolations(page, 'dashboard');
  });

  test('settings (switches, modals, AI card)', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await page.goto('/settings');
    await page.getByRole('main').waitFor();
    await expectNoSeriousViolations(page, 'settings');
  });

  test('forms list', async ({ page }) => {
    await login(page);
    await page.goto('/forms');
    await page.getByRole('main').waitFor();
    await expectNoSeriousViolations(page, 'forms');
  });

  test('flows workspace', async ({ page }) => {
    await login(page);
    await page.goto('/flows');
    await page.getByRole('main').waitFor();
    await expectNoSeriousViolations(page, 'flows');
  });
});
