import { test, expect } from '@playwright/test';

/**
 * Live-demo isolation (launch-review #6.3): the shared Demo account is server-read-only, so a visitor
 * cannot pollute the shared dataset. A direct write to an app form as the demo session must be rejected
 * server-side (demo_readonly), independent of the browser-local overlay that makes the demo feel live.
 * ASCII-only (Playwright's loader dislikes non-ASCII in spec files).
 */
const API = process.env.E2E_API_URL || 'http://api.formlogic.local';

test('demo session is server-read-only: an app write is rejected', async ({ page }) => {
  const req = page.context().request;
  const start = await req.post(`${API}/api/demo/start`, { headers: { 'Content-Type': 'application/json' }, data: {} });
  expect(start.ok(), 'demo/start should succeed (is the demo provisioned?)').toBeTruthy();

  const csrf = (await page.context().cookies()).find((c) => c.name === 'formlogic_csrf')?.value ?? '';
  const apps = (await (await req.get(`${API}/api/demo/apps`)).json()).apps ?? [];
  expect(apps.length, 'demo should have apps').toBeGreaterThan(0);

  const cfg = await (await req.get(`${API}/api/app/${apps[0].slug}`)).json();
  const form = (cfg.forms ?? [])[0];
  expect(form, 'demo app should expose a form').toBeTruthy();

  // Attempt a server-side write as the demo account: the read-only middleware must block it (403),
  // BEFORE any per-form permission check, so the shared demo dataset can never be mutated.
  const res = await req.post(`${API}/api/app/${apps[0].slug}/forms/${form.formId}/responses`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: { answers: {} },
  });
  expect(res.status(), 'a demo write must be rejected server-side').toBe(403);
  const body = await res.json().catch(() => ({}));
  expect(body.code ?? body.message ?? body.error, 'rejection should carry an error').toBeTruthy();
});
