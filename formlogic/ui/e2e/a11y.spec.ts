// Audit FL-29 — automated accessibility smoke over the golden-path surfaces.
//
// Axe (via @axe-core/playwright) scans each page for WCAG A/AA violations of
// the serious/critical impact tiers; any hit FAILS the run with the offending
// nodes named. Moderate/minor findings are reported to the console without
// failing (burn-down visibility, no blind churn). Runs with the normal E2E
// stack (live app + seeded test account) on every configured browser project.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL || 'http://api.formlogic.local';
const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

// The dashboard renders its action row ("Start with a form" / "Start from a template")
// only once the account owns a form; a fresh CI account sees the getting-started state,
// whose "Browse templates" opens the FORM template picker, not the packs modal. Make that
// precondition explicit instead of depending on which sibling spec created a form first
// (with two workers that ordering is a coin toss — the button was "detached" one run and
// "not found" the next).
async function ensureOwnsAForm(page: Page) {
  await page.evaluate(async ({ API }) => {
    const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
    const token = m ? decodeURIComponent(m[1]) : '';
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const list = await fetch(API + '/api/forms?limit=1', { credentials: 'include', headers })
      .then((r) => r.json())
      .catch(() => null);
    const forms = Array.isArray(list?.forms) ? list.forms : Array.isArray(list) ? list : [];
    if (forms.length > 0) return;
    const res = await fetch(API + '/api/forms', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        title: 'a11y fixture form',
        status: 'draft',
        fields: [{ id: 'note', type: 'short_text', label: 'Note', required: false, properties: {}, order: 0 }],
      }),
    });
    if (!res.ok) throw new Error(`could not create the a11y fixture form: HTTP ${res.status}`);
  }, { API });
}

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

async function expectNoSeriousViolations(page: Page, surface: string, scope?: string) {
  // `scope` limits the scan to one region. A modal opens ON TOP of a page, so an unscoped
  // scan attributes that page's pre-existing findings to the modal — which both blames the
  // wrong surface and lets a real modal defect hide in the noise.
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (scope) {
    builder = builder.include(scope);
    // Modals fade in (Modal.tsx: opacity 0 → 1 over 150 ms). A scan that starts mid-fade
    // measures text blended with the backdrop and reports colour-contrast failures that do
    // not exist at rest — seen on a slow CI runner, never locally. Wait until the scoped
    // region and every ancestor are fully opaque before measuring.
    await page.waitForFunction(
      (selector) => {
        let el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return false;
        for (; el; el = el.parentElement) {
          if (getComputedStyle(el).opacity !== '1') return false;
        }
        return true;
      },
      scope,
      { timeout: 10_000 }
    );
  }
  const results = await builder.analyze();
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

  // MKT-606: the Install Center. Scanned at the surfaces where someone actually decides to
  // install something — a review a screen-reader user cannot follow is not a review.
  test('marketplace gallery', async ({ page }) => {
    await login(page);
    await page.goto('/packs');
    // The gallery is a full-bleed marketing-style page without an AppShell <main>; wait on
    // its own heading instead of assuming a landmark it does not render.
    await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 });
    await expectNoSeriousViolations(page, 'marketplace gallery');
  });

  test('packs modal — marketplace and installed tabs', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await ensureOwnsAForm(page);
    await page.goto('/');
    await page.getByRole('main').waitFor();
    // The dashboard fills in AFTER mount: the headline's counts, the CreateBand above the
    // action row (AI-availability probe) and the forms list all land from separate API
    // calls, each shifting the action row. On a slow runner Playwright saw the button as
    // "not stable" / detached for the whole click timeout. Let the page go quiet first.
    await page.waitForLoadState('networkidle');
    // The dashboard's template entry was renamed from "Import pack" to "Start from a template".
    const templateButton = page.getByRole('button', { name: /start from a template/i }).first();
    await expect(templateButton).toBeVisible();
    await templateButton.click();
    // The catalog grid is a list of buttons; scan it before switching tabs.
    await page.getByRole('button', { name: /^Installed/ }).first().waitFor({ timeout: 20_000 });
    await expectNoSeriousViolations(page, 'packs modal (marketplace)', '[role="dialog"]');

    await page.getByRole('button', { name: /^Installed/ }).first().click();
    await page.waitForTimeout(600);
    await expectNoSeriousViolations(page, 'packs modal (installed)', '[role="dialog"]');

    // The extension detail panel carries the review content — slots, grants, dependencies.
    const details = page.getByRole('button', { name: /^Details$/ });
    if ((await details.count()) > 0) {
      await details.first().click();
      await page.getByText('Contributed flow nodes').first().waitFor({ timeout: 10_000 });
      await expectNoSeriousViolations(page, 'packs modal (extension details)', '[role="dialog"]');
    }
  });
});
