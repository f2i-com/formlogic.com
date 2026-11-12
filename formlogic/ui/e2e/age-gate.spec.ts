import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FRONTEND_BASE_URL, sessionHeaders } from './session-request';

// The age gate plugin (docs/AGE_GATE_AND_SITE_AI.md): an administrator installs the plugin that
// ships with FormLogic, an owner makes an app ask for its pass, and a member is stopped until they
// get it on the plugin's own page on FormLogic's site (a SoftN app, in the runner and the sandboxed
// frame), gets in, and is stopped again once they withdraw it. On a custom domain the pass is still
// met on FormLogic, never on the domain.
//
// The administrator: E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, made by e2e.yml with bin/bootstrap-admin.php.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const PLUGIN = 'formlogic.age-gate';
const PORT = new URL(E2E_FRONTEND_BASE_URL).port || '80';
const RUN = Date.now().toString(36);
const DOMAIN = `adults-${RUN}.e2e-apps.com`;
const site = (domain: string) => `http://${domain}:${PORT}`;
const PASSWORD = 'age-gate-e2e-password-1';
const FRAME = 'iframe[title="Hosted app"]';

test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Needs an administrator (E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD) to install the plugin');

test.use({
  launchOptions: {
    args: ['--host-resolver-rules=MAP *.e2e-apps.com 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${site(DOMAIN)}`],
  },
});

const project = { home: true, access: 'members', assets: {}, files: {
  'manifest.json': JSON.stringify({ id: `com.formlogic.e2e.agegate.${RUN}`, name: 'Grown-ups', version: '1.0.0', main: 'ui/main.ui' }),
  'ui/main.ui': '<Stack padding="24"><Text>Grown-ups only app is running</Text></Stack>',
} };

const csrfOf = async (context: BrowserContext | APIRequestContext) => {
  const state = 'cookies' in context ? { cookies: await context.cookies() } : await context.storageState();
  return state.cookies.find(cookie => cookie.name === 'formlogic_csrf')!.value;
};

/** The plugin is installed and on, as an administrator does it under Admin → Plugins. */
test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: E2E_FRONTEND_BASE_URL });
  const signedIn = await admin.post('/api/auth/login', { headers: sessionHeaders(), data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  const csrf = { 'X-CSRF-Token': await csrfOf(admin) };
  const confirmed = await admin.post('/api/admin/confirm', { headers: csrf, data: { password: ADMIN_PASSWORD } });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  const headers = { ...csrf, 'X-Admin-Confirmation': (await confirmed.json()).confirmation };
  const listed = await (await admin.get('/api/admin/plugins', { headers })).json();
  const installed = listed.installed.find((plugin: { manifestId: string }) => plugin.manifestId === PLUGIN);
  if (!installed) {
    const install = await admin.post(`/api/admin/plugins/${PLUGIN}/install`, { headers, data: {} });
    expect(install.status(), await install.text()).toBe(201);
  } else if (!installed.enabled) {
    const enable = await admin.put(`/api/admin/plugins/${PLUGIN}`, { headers, data: { enabled: true } });
    expect(enable.ok(), await enable.text()).toBe(true);
  }
  await admin.dispose();
});

async function register(request: APIRequestContext, email: string) {
  const registered = await request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: PASSWORD, name: email.split('@')[0] } });
  expect(registered.ok(), await registered.text()).toBe(true);
}

async function publishGatedApp(context: BrowserContext, name: string) {
  const headers = { 'X-CSRF-Token': await csrfOf(context) };
  const created = await context.request.post('/api/apps', { headers, data: { name, slug: name, settings: { softnApp: true, allowSelfRegistration: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const { app } = await created.json();
  const saved = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project, expectedVersion: 0 } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await context.request.post(`/api/apps/${app.id}/publish`, { headers });
  expect(published.ok(), await published.text()).toBe(true);
  return app as { id: string; slug: string };
}

/** The owner turns the requirement on the way an owner does, in the SoftN app's Settings section. */
async function turnOnTheGate(page: Page, appId: string) {
  await page.goto(`/apps/${appId}/softn`);
  await page.getByRole('navigation', { name: 'App sections' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Only for people over an age' }).click();
  await expect(page.getByText('Members are asked before it opens.', { exact: true })).toBeVisible();
}

async function joinAndMeetTheGate(page: Page) {
  await page.getByRole('button', { name: 'Join app' }).click();
  await expect(page.getByRole('heading', { name: 'For people aged 18 and over' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(FRAME)).toHaveCount(0);
}

/** On FormLogic's own site, in the plugin's page: its own SoftN app, running in the frame. */
async function passInThePlugin(page: Page, appName: string) {
  await expect(page.getByRole('heading', { name: `Before you open ${appName}` })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).origin).toBe(E2E_FRONTEND_BASE_URL);
  expect(new URL(page.url()).pathname).toBe(`/plugins/${PLUGIN}/verify`);
  const plugin = page.frameLocator(FRAME);
  await expect(plugin.getByText(`${appName} is for people aged 18 and over.`)).toBeVisible({ timeout: 60_000 });
  await plugin.getByRole('button', { name: 'I am 18 or older' }).click();
}

test('a member gets the age gate plugin\'s pass before an app that asks for it opens, and withdrawing it closes the app again', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await register(page.context().request, `age-owner-${RUN}@e2e-apps.com`);
  const name = `grown-ups-${RUN}`;
  const app = await publishGatedApp(page.context(), name);
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
  expect(refused.body.code).toBe('pass_required');

  await visit.getByRole('button', { name: 'Confirm your age' }).click();
  await passInThePlugin(visit, name);
  await expect(visit).toHaveURL(new RegExp(`/app/${app.slug}$`), { timeout: 30_000 });
  await expect(visit.frameLocator(FRAME).getByText('Grown-ups only app is running')).toBeVisible({ timeout: 60_000 });

  // Withdrawn in Settings, the app asks again.
  await visit.goto('/settings#security');
  await expect(visit.getByText(/Age 18\+ · your word · Age gate/)).toBeVisible();
  await visit.getByRole('button', { name: 'Withdraw' }).click();
  await expect(visit.getByText('You have none.')).toBeVisible();
  await visit.goto(`/app/${app.slug}`);
  await expect(visit.getByRole('heading', { name: 'For people aged 18 and over' })).toBeVisible({ timeout: 30_000 });
  await member.close();
});

test('at its /native address too, the page says how to get the pass and comes back to the app', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await register(page.context().request, `age-native-owner-${RUN}@e2e-apps.com`);
  const name = `grown-ups-native-${RUN}`;
  const app = await publishGatedApp(page.context(), name);
  // Off: the app opens at /app/<slug>/native rather than at its address.
  const saved = await page.context().request.put(`/api/apps/${app.id}/native`, { headers: { 'X-CSRF-Token': await csrfOf(page.context()) }, data: { project: { ...project, home: false }, expectedVersion: 1 } });
  expect(saved.status(), await saved.text()).toBe(200);
  await turnOnTheGate(page, app.id);

  const member = await browser.newContext();
  await register(member.request, `age-native-member-${RUN}@e2e-apps.com`);
  expect((await member.request.post(`/api/app/${app.slug}/join`, { headers: { 'X-CSRF-Token': await csrfOf(member) } })).ok()).toBe(true);
  const visit = await member.newPage();
  await visit.goto(`/app/${app.slug}/native`);
  await expect(visit.getByText('This app is for people aged 18 and over. Confirm your age to open it.')).toBeVisible({ timeout: 30_000 });
  await visit.getByRole('link', { name: 'Confirm your age' }).click();
  await passInThePlugin(visit, name);
  await expect(visit).toHaveURL(new RegExp(`/app/${app.slug}/native$`), { timeout: 30_000 });
  await expect(visit.frameLocator(FRAME).getByText('Grown-ups only app is running')).toBeVisible({ timeout: 60_000 });
  await member.close();
});

test('on its own domain the pass is met on FormLogic, and the member comes back to the domain', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await register(page.context().request, `age-domain-owner-${RUN}@e2e-apps.com`);
  const name = `grown-ups-domain-${RUN}`;
  const app = await publishGatedApp(page.context(), name);
  await turnOnTheGate(page, app.id);
  await page.goto(`/apps/${app.id}/softn/domains`);
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

  await home.getByRole('button', { name: 'Confirm your age' }).click();
  await passInThePlugin(home, name);
  // Back on the domain, where the app now opens.
  await expect.poll(() => new URL(home.url()).host, { timeout: 30_000 }).toBe(`${DOMAIN}:${PORT}`);
  await expect(home.frameLocator(FRAME).getByText('Grown-ups only app is running')).toBeVisible({ timeout: 60_000 });
  await visitor.close();
});
