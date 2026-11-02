import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FRONTEND_BASE_URL, sessionHeaders } from './session-request';

// An app's age gate (docs/AGE_GATE_AND_SITE_AI.md): the owner turns it on, a member is stopped until
// they confirm their age on FormLogic's own site, gets in, and is stopped again once they withdraw it.
// On a custom domain the confirmation still happens on FormLogic, never on the domain.
const PORT = new URL(E2E_FRONTEND_BASE_URL).port || '80';
const RUN = Date.now().toString(36);
const DOMAIN = `adults-${RUN}.e2e-apps.com`;
const site = (domain: string) => `http://${domain}:${PORT}`;
const PASSWORD = 'age-gate-e2e-password-1';
const FRAME = 'iframe[title="Hosted app"]';

test.use({
  launchOptions: {
    args: ['--host-resolver-rules=MAP *.e2e-apps.com 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${site(DOMAIN)}`],
  },
});

const project = { home: true, access: 'members', assets: {}, files: {
  'manifest.json': JSON.stringify({ id: `com.formlogic.e2e.agegate.${RUN}`, name: 'Grown-ups', version: '1.0.0', main: 'ui/main.ui' }),
  'ui/main.ui': '<Stack padding="24"><Text>Grown-ups only app is running</Text></Stack>',
} };

async function register(request: APIRequestContext, email: string) {
  const registered = await request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: PASSWORD, name: email.split('@')[0] } });
  expect(registered.ok(), await registered.text()).toBe(true);
}

async function publishGatedApp(context: BrowserContext, name: string) {
  const csrf = (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value;
  const headers = { 'X-CSRF-Token': csrf };
  const created = await context.request.post('/api/apps', { headers, data: { name, slug: name, settings: { softnApp: true, allowSelfRegistration: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const { app } = await created.json();
  const saved = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: 0 } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await context.request.post(`/api/apps/${app.id}/publish`, { headers });
  expect(published.ok(), await published.text()).toBe(true);
  return app as { id: string; slug: string };
}

/** The owner turns the gate on the way an owner does, in the SoftN app's Settings tab. */
async function turnOnTheGate(page: Page, appId: string) {
  await page.goto(`/apps/${appId}/softn`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Only for people over an age' }).click();
  await expect(page.getByText('Now only for people aged 18 and over', { exact: true })).toBeVisible();
}

async function joinAndMeetTheGate(page: Page) {
  await page.getByRole('button', { name: 'Join app' }).click();
  await expect(page.getByRole('heading', { name: 'For people aged 18 and over' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(FRAME)).toHaveCount(0);
}

async function confirmOnFormLogic(page: Page) {
  await page.getByRole('button', { name: 'Confirm your age' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm your age' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(E2E_FRONTEND_BASE_URL);
  await expect(page.getByRole('button', { name: 'Confirm and continue' })).toBeDisabled();
  await page.getByLabel('I am 18 or older.').check();
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
}

test('a member confirms their age before an age-gated app opens, and withdrawing it closes the app again', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await register(page.context().request, `age-owner-${RUN}@e2e-apps.com`);
  const app = await publishGatedApp(page.context(), `grown-ups-${RUN}`);
  await turnOnTheGate(page, app.id);
  // The owner is never asked.
  await page.goto(`/app/${app.slug}`);
  await expect(page.frameLocator(FRAME).getByText('Grown-ups only app is running')).toBeVisible({ timeout: 60_000 });

  const member = await browser.newContext();
  await register(member.request, `age-member-${RUN}@e2e-apps.com`);
  const visit = await member.newPage();
  await visit.goto(`/app/${app.slug}`);
  await joinAndMeetTheGate(visit);
  // The server refuses the app's code and data, whatever the page does.
  const refused = await visit.evaluate(slug => fetch(`/api/app/${slug}/native`).then(async response => ({ status: response.status, body: await response.json() })), app.slug);
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('age_verification_required');

  await confirmOnFormLogic(visit);
  await expect(visit).toHaveURL(new RegExp(`/app/${app.slug}$`));
  await expect(visit.frameLocator(FRAME).getByText('Grown-ups only app is running')).toBeVisible({ timeout: 60_000 });

  // Withdrawn in Settings, the app asks again.
  await visit.goto('/settings#security');
  await expect(visit.getByText(/18\+ · you confirmed it/)).toBeVisible();
  await visit.getByRole('button', { name: 'Withdraw' }).click();
  await expect(visit.getByText('You have none.')).toBeVisible();
  await visit.goto(`/app/${app.slug}`);
  await expect(visit.getByRole('heading', { name: 'For people aged 18 and over' })).toBeVisible({ timeout: 30_000 });
  await member.close();
});

test('on its own domain the age is confirmed on FormLogic, and the member comes back to the domain', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await register(page.context().request, `age-domain-owner-${RUN}@e2e-apps.com`);
  const app = await publishGatedApp(page.context(), `grown-ups-domain-${RUN}`);
  await turnOnTheGate(page, app.id);
  await page.goto(`/apps/${app.id}/softn`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Custom domain').fill(DOMAIN);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();

  const visitor = await browser.newContext();
  const home = await visitor.newPage();
  await home.goto(`${site(DOMAIN)}/`);
  await home.getByRole('button', { name: 'Create an account' }).click();
  await home.getByLabel(/name/i).first().fill('Domain member');
  await home.getByLabel(/email/i).first().fill(`age-domain-member-${RUN}@e2e-apps.com`);
  await home.getByLabel(/password/i).first().fill(PASSWORD);
  const confirm = home.getByLabel(/confirm/i);
  if (await confirm.count()) await confirm.first().fill(PASSWORD);
  const terms = home.getByRole('checkbox');
  if (await terms.count()) await terms.first().check();
  await home.getByRole('button', { name: /create|sign up/i }).first().click();
  await home.getByRole('button', { name: 'Continue' }).click({ timeout: 30_000 });
  await joinAndMeetTheGate(home);
  expect(new URL(home.url()).host).toBe(`${DOMAIN}:${PORT}`);

  await confirmOnFormLogic(home);
  // Back on the domain, where the app now opens.
  await expect.poll(() => new URL(home.url()).host, { timeout: 30_000 }).toBe(`${DOMAIN}:${PORT}`);
  await expect(home.frameLocator(FRAME).getByText('Grown-ups only app is running')).toBeVisible({ timeout: 60_000 });
  await visitor.close();
});
