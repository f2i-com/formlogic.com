import { test, expect, type Page } from '@playwright/test';

/**
 * Launch-critical golden paths. Runs against the live stack (api.formlogic.local +
 * formlogic.local) and the seeded test account — `npm run test:e2e` (see e2e README notes).
 * Forms/data are created and deleted per test for isolation. Traces + screenshots are captured
 * on failure (playwright.config.ts).
 *
 * These intentionally exercise REAL server behaviour (where the security fixes live): hidden-field
 * server-authority, field-aware uploads, onSubmit reject/compute, required validation — plus the
 * core build→publish→submit→view promise via the UI.
 */

const API = process.env.E2E_API_URL || 'http://api.formlogic.local';
const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

// All server calls go through the page's own fetch so the auth cookie + CSRF token are reused.
function api(page: Page) {
  return {
    createForm: (body: Record<string, unknown>) =>
      page.evaluate(async ({ API, body }) => {
        const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
        const token = m ? decodeURIComponent(m[1]) : '';
        const res = await fetch(API + '/api/forms', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        return (j?.form?.id as string) || '';
      }, { API, body }),
    deleteForm: (id: string) =>
      page.evaluate(async ({ API, id }) => {
        const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
        const token = m ? decodeURIComponent(m[1]) : '';
        await fetch(API + '/api/forms/' + id, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': token } });
      }, { API, id }),
    submit: (formId: string, answers: Record<string, unknown>) =>
      page.evaluate(async ({ API, formId, answers }) => {
        const res = await fetch(API + '/api/forms/' + formId + '/responses', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, { API, formId, answers }),
    responses: (formId: string) =>
      page.evaluate(async ({ API, formId }) => {
        const res = await fetch(API + '/api/forms/' + formId + '/responses', { credentials: 'include' });
        return await res.json();
      }, { API, formId }),
  };
}

const field = (id: string, type: string, props: Record<string, unknown> = {}, required = false, label?: string) =>
  ({ id, type, label: label ?? id, required, properties: props, order: 0 });

test.describe('launch golden paths', () => {
  test('auth: login then logout', async ({ page }) => {
    await login(page);
    await expect(page).not.toHaveURL(/\/login/);
    // Clear the session (HttpOnly cookie + persisted client state) — the root then renders the
    // public landing instead of the dashboard.
    await page.context().clearCookies();
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    await page.goto('/');
    // The landing hero heading ("Build business apps from forms") — proves logout landed on the
    // signed-out landing page. Keep in sync with Landing.tsx's <h1>.
    await expect(page.getByRole('heading', { name: /build business apps/i })).toBeVisible({ timeout: 20_000 });
  });

  test('build → publish → submit public response → view', async ({ page }) => {
    await login(page);
    const a = api(page);
    const formId = await a.createForm({
      title: 'E2E Public Flow',
      status: 'published',
      settings: { presentationMode: 'classic', defaultPresentationMode: 'classic' },
      fields: [field('full_name', 'short_text', {}, true, 'Full Name')],
    });
    expect(formId).toBeTruthy();
    try {
      // Fill + submit through the public form UI (classic = all on one page).
      await page.goto('/form/' + formId);
      await expect(page.getByText('Full Name')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('textbox').first().fill('E2E Tester');
      await page.getByRole('button', { name: /submit/i }).click();
      await expect(page.getByRole('heading', { name: /thank you/i })).toBeVisible({ timeout: 20_000 });
      // It persisted server-side.
      const data = await a.responses(formId);
      expect(data.responses?.[0]?.answers?.full_name).toBe('E2E Tester');
    } finally {
      await a.deleteForm(formId);
    }
  });

  test('required-field validation rejects an empty submission', async ({ page }) => {
    await login(page);
    const a = api(page);
    const formId = await a.createForm({
      title: 'E2E Required', status: 'published',
      fields: [field('email', 'email', {}, true, 'Email')],
    });
    try {
      const r = await a.submit(formId, {}); // missing required
      expect(r.status).toBe(400);
      const ok = await a.submit(formId, { email: 'a@b.com' });
      expect(ok.status).toBe(201);
    } finally {
      await a.deleteForm(formId);
    }
  });

  test('hidden field is server-controlled (tamper ignored, calc computed)', async ({ page }) => {
    await login(page);
    const a = api(page);
    const formId = await a.createForm({
      title: 'E2E Hidden', status: 'published',
      fields: [
        field('amount', 'number', {}, false, 'Amount'),
        field('secret', 'hidden', { defaultValue: 'server-only' }, false, 'Secret'),
        field('doubled', 'calculated', { calculationExpression: 'amount * 2' }, false, 'Doubled'),
      ],
    });
    try {
      const r = await a.submit(formId, { amount: 21, secret: 'HACKED' });
      expect(r.status).toBe(201);
      const data = await a.responses(formId);
      const ans = data.responses?.[0]?.answers ?? {};
      expect(ans.secret).toBe('server-only'); // forged value stripped, default seeded
      expect(ans.doubled).toBe(42);            // calc computed server-side
    } finally {
      await a.deleteForm(formId);
    }
  });

  test('field-aware upload rejects a wrong-type file', async ({ page }) => {
    await login(page);
    const a = api(page);
    const formId = await a.createForm({
      title: 'E2E Upload', status: 'published',
      fields: [field('photo', 'file_upload', { acceptedFileTypes: ['image/png'], maxFileSize: 5242880 }, false, 'Photo')],
    });
    try {
      // Upload a text/plain file to a PNG-only field → 400 (field-aware constraint).
      const res = await page.evaluate(async ({ API, formId }) => {
        const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
        const token = m ? decodeURIComponent(m[1]) : '';
        const fd = new FormData();
        fd.append('file', new Blob(['hello not an image'], { type: 'text/plain' }), 'note.txt');
        fd.append('fieldId', 'photo');
        const r = await fetch(API + '/api/forms/' + formId + '/upload', {
          method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': token }, body: fd,
        });
        return r.status;
      }, { API, formId });
      expect(res).toBe(400);
    } finally {
      await a.deleteForm(formId);
    }
  });

  test('onSubmit script can reject and can write computed values', async ({ page }) => {
    await login(page);
    const a = api(page);
    const script = `function onSubmit(ctx){ if (Number(ctx.answers.amount) < 0) return { reject: true, message: 'No negatives' }; ctx.db.setField('tripled', Number(ctx.answers.amount) * 3); ctx.db.addTag('processed'); return {}; }`;
    const formId = await a.createForm({
      title: 'E2E Script', status: 'published', logicScript: script,
      fields: [field('amount', 'number', {}, false, 'Amount')],
    });
    try {
      const rejected = await a.submit(formId, { amount: -5 });
      expect(rejected.status).toBe(422);
      const ok = await a.submit(formId, { amount: 4 });
      expect(ok.status).toBe(201);
      const data = await a.responses(formId);
      const row = data.responses?.[0];
      expect(row?.computed?.tripled).toBe(12);
      expect(row?.tags).toContain('processed');
    } finally {
      await a.deleteForm(formId);
    }
  });
});
