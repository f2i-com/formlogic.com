import { test, expect, type Page } from '@playwright/test';

// End-to-end UI test for the ScriptEditor "Run Test" feature (the backend
// test-script endpoint + editable sample answers). Requires the live stack
// (api.formlogic.local + formlogic.local) and the seeded test account.

const API = process.env.E2E_API_URL || 'http://api.formlogic.local';
const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  // leave the login route on success
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

// Create/delete forms through the page's own fetch so the auth cookie + CSRF
// token are reused exactly like the app does.
async function createForm(page: Page, body: Record<string, unknown>): Promise<string> {
  return await page.evaluate(async ({ API, body }) => {
    const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
    const token = m ? decodeURIComponent(m[1]) : '';
    const res = await fetch(API + '/api/forms', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    return j?.form?.id as string;
  }, { API, body });
}

async function deleteForm(page: Page, id: string) {
  await page.evaluate(async ({ API, id }) => {
    const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
    const token = m ? decodeURIComponent(m[1]) : '';
    await fetch(API + '/api/forms/' + id, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-CSRF-Token': token },
    });
  }, { API, id });
}

// Force cloud/API storage mode before the app boots. onSubmit scripts and the
// test endpoint are inherently cloud-mode features (the form must exist
// server-side), and the app defaults to local storage. The store restores its
// mode from this localStorage key on rehydrate.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      // Seed the persisted zustand blob so the store rehydrates in API mode
      // (onRehydrateStorage only applies the mode key when a blob already exists).
      localStorage.setItem('formlogic-forms', JSON.stringify({ state: { forms: [], storageMode: 'api' }, version: 0 }));
      localStorage.setItem('formlogic_storage_mode', 'api');
    } catch { /* ignore */ }
  });
});

test.describe('ScriptEditor Run Test', () => {
  test('runs onSubmit against editable sample answers and shows the result', async ({ page }) => {
    await login(page);

    const formId = await createForm(page, {
      title: 'PW ScriptEditor ' + Date.now(),
      status: 'draft',
      fields: [{ id: 'amount', type: 'number', label: 'Amount' }],
      logicScript:
        'function onSubmit(ctx){ var total = ctx.answers.amount * 2; ctx.db.setField("total", total); ctx.db.addTag("ui-test"); ctx.db.setStatus("reviewed"); return { total: total }; }',
    });
    expect(formId, 'form was created').toBeTruthy();

    try {
      // Direct builder navigation now works (no bounce to /forms).
      await page.goto('/builder/' + formId);

      // Open the Script modal (desktop toolbar button; first match).
      await page.locator('button[aria-label="Backend Logic Script"]').first().click();
      await expect(page.getByLabel('FormLogic script editor')).toBeVisible();

      // Reveal and edit the sample answers.
      await page.getByRole('button', { name: /sample data/i }).click();
      const sample = page.getByLabel('Sample answers JSON');
      await expect(sample).toBeVisible();
      await sample.fill('{ "amount": 25 }');

      // Run the test and assert the rendered result (scoped to the result row so
      // we don't match the same strings in the script editor textarea).
      await page.getByRole('button', { name: /run test/i }).click();
      const result = page.locator('[role="status"]').filter({ hasText: /Ran successfully/i });
      await expect(result).toBeVisible({ timeout: 20_000 });
      await expect(result).toContainText('total=50');
      await expect(result).toContainText('ui-test');
    } finally {
      await deleteForm(page, formId);
    }
  });

  test('reports a rejection from the script', async ({ page }) => {
    await login(page);
    const formId = await createForm(page, {
      title: 'PW Reject ' + Date.now(),
      status: 'draft',
      fields: [{ id: 'amount', type: 'number', label: 'Amount' }],
      logicScript: 'function onSubmit(ctx){ if (ctx.answers.amount < 100) return { reject: true, message: "too small" }; return {}; }',
    });
    expect(formId).toBeTruthy();
    try {
      await page.goto('/builder/' + formId);
      await page.locator('button[aria-label="Backend Logic Script"]').first().click();
      await expect(page.getByLabel('FormLogic script editor')).toBeVisible();
      await page.getByRole('button', { name: /sample data/i }).click();
      await page.getByLabel('Sample answers JSON').fill('{ "amount": 5 }');
      await page.getByRole('button', { name: /run test/i }).click();
      const result = page.locator('[role="status"]').filter({ hasText: /rejected the submission/i });
      await expect(result).toBeVisible({ timeout: 20_000 });
      await expect(result).toContainText('too small');
    } finally {
      await deleteForm(page, formId);
    }
  });
});
