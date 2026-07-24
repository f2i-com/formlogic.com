import { test, expect, type Page } from '@playwright/test';

/**
 * Launch golden paths, part 2 (audit FL-E2E-001) — the LAUNCH_CHECKLIST follow-ups:
 * app export → import round trip, billing-disabled/self-host behaviour, and app-RBAC
 * (deny-by-default + invitation → member access). API-driven through the page's own
 * fetch (cookie + CSRF reuse), self-cleaning, same conventions as launch-golden-paths.
 */

const API = process.env.E2E_API_URL || 'http://api.formlogic.local';
const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';

async function login(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

/** Authenticated JSON call through the page (session cookie + CSRF token ride along). */
function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ API, method, path, body }) => {
      const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
      const token = m ? decodeURIComponent(m[1]) : '';
      const res = await fetch(API + path, {
        method,
        credentials: 'include',
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'X-CSRF-Token': token } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { API, method, path, body }
  );
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

test.describe('launch golden paths 2', () => {
  test('app export → import round trip preserves the app', async ({ page }) => {
    await login(page);
    const tag = uniq();
    let appId = '';
    let importedId = '';
    let formId = '';
    try {
      const created = await call(page, 'POST', '/api/apps', {
        name: `E2E Export ${tag}`,
        description: 'export/import round trip',
      });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      appId = created.body?.app?.id ?? created.body?.id;
      expect(appId).toBeTruthy();

      const form = await call(page, 'POST', '/api/forms', {
        title: `E2E Export Form ${tag}`,
        status: 'published',
        fields: [{ id: 'note', type: 'short_text', label: 'Note', required: false, properties: {}, order: 0 }],
      });
      formId = form.body?.form?.id ?? form.body?.id;
      expect(formId).toBeTruthy();
      const attach = await call(page, 'POST', `/api/apps/${appId}/forms`, { formId });
      expect(attach.status, JSON.stringify(attach.body)).toBeLessThan(300);

      // Export the whole app as a self-contained pack…
      const exported = await call(page, 'GET', `/api/apps/${appId}/export`);
      expect(exported.status).toBe(200);
      const pack = exported.body?.pack ?? exported.body;
      expect(pack?.forms?.length ?? 0).toBeGreaterThan(0);

      // …and import it back: a NEW app with the same shape must appear.
      // SAFE-001: the import API requires the reviewed grant array (this plain export has none).
      const imported = await call(page, 'POST', '/api/packs/import', { pack, approvedConnectorGrants: [] });
      expect(imported.status, JSON.stringify(imported.body)).toBeLessThan(300);
      importedId =
        imported.body?.app?.id ?? imported.body?.apps?.[0]?.id ?? imported.body?.appId ?? '';
      expect(importedId).toBeTruthy();
      expect(importedId).not.toBe(appId);

      const roundTripped = await call(page, 'GET', `/api/apps/${importedId}/forms`);
      expect(roundTripped.status).toBe(200);
      const forms = roundTripped.body?.forms ?? roundTripped.body ?? [];
      expect(
        forms.some((f: { formTitle?: string; displayName?: string }) =>
          `${f.formTitle ?? ''}${f.displayName ?? ''}`.includes(`E2E Export Form ${tag}`)
        ),
        `imported app carries the form: ${JSON.stringify(forms)}`
      ).toBe(true);
    } finally {
      if (importedId) await call(page, 'DELETE', `/api/apps/${importedId}?deleteForms=1`);
      if (appId) await call(page, 'DELETE', `/api/apps/${appId}`);
      if (formId) await call(page, 'DELETE', `/api/forms/${formId}`);
    }
  });

  test('self-host / billing-disabled: writes succeed, no 402 paywall', async ({ page }) => {
    await login(page);
    // Pre-auth public config must load (the landing/billing UI reads it)…
    const health = await call(page, 'GET', '/api/health');
    expect(health.status).toBe(200);
    // …and with enforcement off (the self-host default), an authed WRITE must
    // succeed rather than 402. This is the audited lapse-policy boundary
    // (FL-003): 402 may only ever appear when CLOUD_PLAN_ENFORCED is on.
    let formId = '';
    try {
      const created = await call(page, 'POST', '/api/forms', {
        title: `E2E Billing ${uniq()}`,
        fields: [{ id: 'x', type: 'short_text', label: 'x', required: false, properties: {}, order: 0 }],
      });
      expect(created.status, JSON.stringify(created.body)).not.toBe(402);
      expect(created.status).toBeLessThan(300);
      formId = created.body?.form?.id ?? created.body?.id;
    } finally {
      if (formId) await call(page, 'DELETE', `/api/forms/${formId}`);
    }
  });

  test('app RBAC: non-members are refused; an invited member gets runtime access', async ({
    browser,
    page,
  }) => {
    await login(page);
    const tag = uniq();
    const memberEmail = `e2e-member-${tag}@example.com`;
    let appId = '';
    let slug = '';

    // A second, isolated browser session for the member-to-be.
    const memberCtx = await browser.newContext();
    const memberPage = await memberCtx.newPage();
    try {
      const created = await call(page, 'POST', '/api/apps', { name: `E2E RBAC ${tag}` });
      appId = created.body?.app?.id ?? created.body?.id;
      slug = created.body?.app?.slug ?? created.body?.slug;
      expect(appId && slug, JSON.stringify(created.body)).toBeTruthy();
      // The runtime serves PUBLISHED apps; a fresh app starts as a draft.
      const published = await call(page, 'PUT', `/api/apps/${appId}`, { status: 'published' });
      expect(published.status, JSON.stringify(published.body)).toBeLessThan(300);

      // Register the member account (self-serve — BETA/self-host default).
      // NOTE: register auto-logs-in via the HttpOnly cookie; no separate login.
      await memberPage.goto('/login');
      const registered = await call(memberPage, 'POST', '/api/auth/register', {
        email: memberEmail,
        password: 'password123!E2E',
        name: 'E2E Member',
      });
      expect(registered.status, JSON.stringify(registered.body)).toBeLessThan(300);
      // Registration sets the auth cookie — the member session is live already.

      // Deny by default: not a member yet → the app runtime must refuse.
      const denied = await call(memberPage, 'GET', `/api/app/${slug}`);
      expect([401, 403, 404]).toContain(denied.status);

      // Owner invites; pick a non-owner system role from the app's real roles.
      const roles = await call(page, 'GET', `/api/apps/${appId}/roles`);
      const roleList: Array<{ id: string; name: string }> = roles.body?.roles ?? roles.body ?? [];
      const memberRole = roleList.find((r) => !/owner/i.test(r.name)) ?? roleList[0];
      expect(memberRole, JSON.stringify(roles.body)).toBeTruthy();
      const invite = await call(page, 'POST', `/api/apps/${appId}/invitations`, {
        email: memberEmail,
        roleId: memberRole.id,
      });
      const token = invite.body?.invitation?.token ?? invite.body?.token;
      expect(token, JSON.stringify(invite.body)).toBeTruthy();

      const accepted = await call(memberPage, 'POST', '/api/apps/invitations/accept', { token });
      expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);

      // Membership grants runtime access — and only role-scoped visibility.
      const runtime = await call(memberPage, 'GET', `/api/app/${slug}`);
      expect(runtime.status, JSON.stringify(runtime.body)).toBe(200);
    } finally {
      if (appId) await call(page, 'DELETE', `/api/apps/${appId}`);
      await memberCtx.close();
    }
  });
});
