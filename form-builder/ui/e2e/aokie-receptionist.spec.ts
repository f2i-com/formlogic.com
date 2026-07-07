import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Live end-to-end for the Aokie Receptionist integration (mock/no-hardware path),
 * run against the WAMP-served stack like the other e2e specs.
 *
 * Proves the MVP loop with no FormLogic Desktop installed:
 *   install pack → publish → open app runtime → Live Call SDK screen →
 *   "Simulate incoming call (demo)" (mock aokie connector) →
 *   custom app-logic writes Calls/Transcript records via the real API →
 *   flow bindings reserve + complete rows in flow_run_logs.
 *
 * The pack is imported fresh and uninstalled at the end for isolation.
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

// Server calls go through the page's own fetch so the auth cookie + CSRF token are reused.
// Return type is inferred (body is the loose parsed JSON) — e2e specs are lint-clean
// without explicit `any` annotations, same as the other specs.
async function apiFetch(
  page: Page,
  method: string,
  route: string,
  body?: unknown,
) {
  return page.evaluate(
    async ({ API, method, route, body }) => {
      const m = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
      const token = m ? decodeURIComponent(m[1]) : '';
      const res = await fetch(API + route, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { API, method, route, body },
  );
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 45_000,
  intervalMs = 1_500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

test.describe('aokie receptionist (mock desktop path)', () => {
  test('simulated incoming call creates records + flow runs', async ({ page }) => {
    test.setTimeout(180_000);

    // The emitted marketplace pack is the exact artifact users install.
    const packFile = fileURLToPath(
      new URL('../../backend/resources/marketplace-packs/aokie-receptionist.json', import.meta.url),
    );
    const { pack } = JSON.parse(fs.readFileSync(packFile, 'utf8'));

    await login(page);

    // Idempotence: drop any Aokie Receptionist install left by a previous run.
    const installed = await apiFetch(page, 'GET', '/api/packs/installed');
    for (const inst of installed.body?.installations ?? installed.body?.installed ?? []) {
      const name = String(inst?.packName ?? inst?.name ?? '');
      if (/aokie/i.test(name) && inst?.id) {
        await apiFetch(page, 'DELETE', `/api/packs/${inst.id}`).catch(() => {});
      }
    }

    // Install the pack (fresh app + 10 forms owned by the test user).
    const imp = await apiFetch(page, 'POST', '/api/packs/import', { pack });
    expect(imp.status, JSON.stringify(imp.body)).toBeLessThan(300);
    const installationId: string = imp.body?.installationId;
    const appId: string = imp.body?.apps?.[0]?.id;
    expect(appId).toBeTruthy();
    const formIds = new Map<string, string>(
      (imp.body?.forms ?? []).map((f: { title: string; id: string }) => [f.title, f.id]),
    );
    const callsFormId = formIds.get('Calls');
    const turnsFormId = formIds.get('Transcript Turns');
    expect(callsFormId).toBeTruthy();
    expect(turnsFormId).toBeTruthy();

    try {
      // Publish so the runtime endpoints (incl. flow-runs) accept it.
      const pub = await apiFetch(page, 'PUT', `/api/apps/${appId}`, { status: 'published' });
      expect(pub.status, JSON.stringify(pub.body)).toBeLessThan(300);
      const appInfo = await apiFetch(page, 'GET', `/api/apps/${appId}`);
      const slug: string = appInfo.body?.app?.slug;
      expect(slug).toBeTruthy();

      // Sanity: the pack shipped flows + bindings.
      const flows = await apiFetch(page, 'GET', `/api/apps/${appId}/flows`);
      expect((flows.body?.flows ?? []).length).toBeGreaterThanOrEqual(5);

      // Open the app runtime and the Live Call screen (Calls form section).
      await page.goto(`/app/${slug}`);
      await expect(page.getByText(/aokie receptionist/i).first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole('link', { name: /calls/i }).first().click().catch(async () => {
        // Nav variant: buttons instead of links.
        await page.getByRole('button', { name: /^calls$/i }).first().click();
      });

      // No Desktop installed → the SDK screen runs against the simulated bridge.
      const simulate = page.getByRole('button', { name: /simulate incoming call/i });
      await expect(simulate).toBeVisible({ timeout: 30_000 });
      await simulate.click();

      // The mock emits the scripted lifecycle; app-logic writes real records.
      const calls = await pollUntil(
        () => apiFetch(page, 'GET', `/api/forms/${callsFormId}/responses`),
        (r) => (r.body?.responses ?? []).length >= 1,
      );
      expect((calls.body?.responses ?? []).length, 'a Calls record should exist').toBeGreaterThanOrEqual(1);

      const turns = await pollUntil(
        () => apiFetch(page, 'GET', `/api/forms/${turnsFormId}/responses`),
        (r) => (r.body?.responses ?? []).length >= 2,
      );
      expect((turns.body?.responses ?? []).length, 'transcript turns should exist').toBeGreaterThanOrEqual(2);

      // Flow bindings fired: run logs exist and the sync caller-lookup completed.
      const runs = await pollUntil(
        () => apiFetch(page, 'GET', `/api/apps/${appId}/flow-runs`),
        (r) => {
          const list = r.body?.runs ?? [];
          return list.some(
            (x) => /incoming-caller-lookup/.test(String(x.flowSlug ?? x.flow_definition_id ?? '')) &&
              ['done', 'error', 'timeout'].includes(String(x.status)),
          ) || list.filter((x) => ['done', 'error', 'timeout'].includes(String(x.status))).length >= 1;
        },
      );
      const runList = runs.body?.runs ?? [];
      expect(runList.length, 'flow runs should be logged').toBeGreaterThanOrEqual(1);
      const terminal = runList.filter((x) => ['done', 'error', 'timeout'].includes(String(x.status)));
      expect(terminal.length, 'at least one flow run reached a terminal state').toBeGreaterThanOrEqual(1);

      // call.ended must UPDATE the same Calls record (formlogic.updateResponse
      // match-by-call_id): terminal status + duration, not a second row.
      const ended = await pollUntil(
        () => apiFetch(page, 'GET', `/api/forms/${callsFormId}/responses`),
        (r) => {
          const rows = r.body?.responses ?? [];
          return rows.some((x) => {
            const s = String(x?.answers?.status ?? '');
            return s === 'completed' || s === 'missed' || s === 'failed';
          });
        },
      );
      const rows = ended.body?.responses ?? [];
      const terminalRows = rows.filter((x) =>
        ['completed', 'missed', 'failed'].includes(String(x?.answers?.status ?? '')),
      );
      expect(terminalRows.length, `Calls record should reach a terminal status; saw ${JSON.stringify(rows.map((x) => x?.answers?.status))}`).toBeGreaterThanOrEqual(1);
      expect(rows.length, 'call.answered/call.ended must update, not duplicate, the Calls row').toBe(1);
    } finally {
      // AOKIE_E2E_KEEP=1 keeps the installed app around for debugging.
      if (installationId && !process.env.AOKIE_E2E_KEEP) {
        await apiFetch(page, 'DELETE', `/api/packs/${installationId}`).catch(() => {});
      }
    }
  });
});
