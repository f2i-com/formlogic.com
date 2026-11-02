import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FRONTEND_BASE_URL, sessionHeaders } from './session-request';

// A SoftN app on its own domain, on real hostnames: the browser resolves them to this server, so
// Origin, Host, cookies and the page's address are all what a visitor's would be. That is what a
// `?__flhost=` preview cannot show. The insecure-origin flag stands in for HTTPS, which the test
// server doesn't have, so the browser behaves as it does in production. CORS_ALLOWED_ORIGINS
// stays as it is: nothing here may depend on a domain being listed.
const PORT = new URL(E2E_FRONTEND_BASE_URL).port || '80';
const RUN = Date.now().toString(36);
const MEMBERS_DOMAIN = `members-${RUN}.e2e-apps.com`;
const PUBLIC_DOMAIN = `public-${RUN}.e2e-apps.com`;
const site = (domain: string) => `http://${domain}:${PORT}`;
// Only the browser resolves these names, so a call outside a page names the host in its header.
const asDomain = (domain: string) => ({ Host: `${domain}:${PORT}`, Origin: site(domain) });

test.use({
  launchOptions: {
    args: [
      '--host-resolver-rules=MAP *.e2e-apps.com 127.0.0.1',
      `--unsafely-treat-insecure-origin-as-secure=${site(MEMBERS_DOMAIN)},${site(PUBLIC_DOMAIN)}`,
    ],
  },
});

const PASSWORD = 'domain-e2e-password-1';
const FRAME = 'iframe[title="Hosted app"]';

function project(access: 'members' | 'application') {
  return { home: false, access, assets: {}, files: {
    'manifest.json': JSON.stringify({ id: `com.formlogic.e2e.domain.${access}`, name: 'Domain app', version: '1.0.0', main: 'ui/main.ui', config: { server: { allowedOrigins: ['https://domain-app.example'] } }, server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: [{ path: '/api/visits', method: 'POST', handler: 'visit', transaction: 'write', authorization: 'anonymous' }],
    } }),
    'ui/main.ui': `<logic>
var message = 'Ready';
function save() {
  softn.net.fetch('https://domain-app.example/api/visits', {method:'POST',body:{}}, function(response) {
    message = response.ok ? 'Saved for ' + JSON.parse(response.body).actor : 'Refused';
  });
}
</logic>
<Stack padding="24"><Text>Domain app is running</Text><Button onClick={save}>Save a visit</Button><Text>{message}</Text></Stack>`,
    'server/main.logic': 'function visit(req) { softn.sql.execute("INSERT INTO visits(actor) VALUES(?)",[String(req.context.formlogic ? req.context.formlogic.userId : "anonymous")]); return {status:201,body:{actor:req.context.formlogic ? req.context.formlogic.userId : "anonymous"}}; }',
    'server/migrations/001.sql': 'CREATE TABLE visits(id INTEGER PRIMARY KEY,actor TEXT);',
  } };
}

async function signInOnPlatform(request: APIRequestContext, email: string) {
  const registered = await request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: PASSWORD, name: 'Domain owner' } });
  expect(registered.ok(), await registered.text()).toBe(true);
}

async function publishApp(context: BrowserContext, request: APIRequestContext, name: string, access: 'members' | 'application') {
  const csrf = (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value;
  const headers = { 'X-CSRF-Token': csrf };
  const created = await request.post('/api/apps', { headers, data: { name, slug: name, settings: { softnApp: true, allowSelfRegistration: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const { app } = await created.json();
  const saved = await request.put(`/api/apps/${app.id}/native`, { headers, data: { project: project(access), expectedVersion: 0 } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await request.post(`/api/apps/${app.id}/publish`, { headers });
  expect(published.ok(), await published.text()).toBe(true);
  const settings = await request.put(`/api/apps/${app.id}`, { headers, data: { settings: { softnApp: true, allowSelfRegistration: true } } });
  expect(settings.ok(), await settings.text()).toBe(true);
  return { app, headers };
}

/** Connects a domain the way an owner does, from the app's Settings tab. */
async function connectDomain(page: Page, appId: string, domain: string) {
  await page.goto(`/apps/${appId}/softn`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Domain mode')).toHaveValue('runtime_direct');
  await page.getByLabel('Custom domain').fill(domain);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(`_formlogic.${domain}`)).toBeVisible();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
}

test('a SoftN app runs full screen on its own domain, and a sign-in for it opens that app alone', async ({ page, context, browser }) => {
  test.setTimeout(240_000);
  const owner = `domain-owner-${RUN}@e2e-apps.com`;
  await signInOnPlatform(context.request, owner);
  const { app } = await publishApp(context, context.request, `domain-members-${RUN}`, 'members');
  const other = await publishApp(context, context.request, `domain-other-${RUN}`, 'members');
  await connectDomain(page, app.id, MEMBERS_DOMAIN);

  const visitor = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const home = await visitor.newPage();
  const refused: string[] = [];
  home.on('response', response => {
    if (response.url().includes('/api/') && [401, 403].includes(response.status())) refused.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await home.goto(`${site(MEMBERS_DOMAIN)}/`);
  await expect(home.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(new URL(home.url()).pathname).toBe('/');
  // Nothing on the domain takes a password: the browser would offer it to the next server there.
  await expect(home.locator('input[type="password"]')).toHaveCount(0);
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify']) {
    const refused = await home.evaluate(url => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"a@e2e-apps.com","password":"x"}' }).then(response => response.status), path);
    expect(refused, path).toBe(403);
  }
  refused.length = 0;

  // A new visitor makes an account on FormLogic and comes back with this app alone.
  const member = `domain-member-${RUN}@e2e-apps.com`;
  await home.getByRole('button', { name: 'Create an account' }).click();
  await expect(home).toHaveURL(new RegExp(`^${E2E_FRONTEND_BASE_URL}/signup`));
  await home.getByLabel(/name/i).first().fill('Domain member');
  await home.getByLabel(/email/i).first().fill(member);
  await home.getByLabel(/password/i).first().fill(PASSWORD);
  const confirm = home.getByLabel(/confirm/i);
  if (await confirm.count()) await confirm.first().fill(PASSWORD);
  const terms = home.getByRole('checkbox');
  if (await terms.count()) await terms.first().check();
  await home.getByRole('button', { name: /create|sign up/i }).first().click();
  // Which site is asking is said before it gets anything.
  await expect(home.getByRole('heading', { name: `Continue to domain-members-${RUN}` })).toBeVisible({ timeout: 30_000 });
  await expect(home.getByText(MEMBERS_DOMAIN, { exact: true })).toBeVisible();
  await home.getByRole('button', { name: 'Continue' }).click();
  await expect(home.getByRole('button', { name: 'Join app' })).toBeVisible({ timeout: 30_000 });
  expect(new URL(home.url()).host).toBe(`${MEMBERS_DOMAIN}:${PORT}`);
  expect(new URL(home.url()).pathname).toBe('/');
  expect(new URL(home.url()).hash).toBe('');
  await home.getByRole('button', { name: 'Join app' }).click();

  const frame = home.frameLocator(FRAME);
  await expect(frame.getByText('Domain app is running')).toBeVisible({ timeout: 60_000 });
  expect(new URL(home.url()).pathname).toBe('/');
  await expect.poll(() => home.title()).toBe(`domain-members-${RUN}`);

  // Nothing around it: the frame is the window, at any size.
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 640, height: 360 }]) {
    await home.setViewportSize(viewport);
    await expect.poll(async () => home.locator(FRAME).boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
    expect(await home.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await home.setViewportSize({ width: 1280, height: 720 });

  // The app's data goes through its backend, as this member.
  const me = await home.evaluate(() => fetch('/api/auth/me').then(response => response.json()));
  expect(me.user.domainSession).toBe(true);
  // Chrome sends the pointer by where the app's frame was last drawn, which lags the size changes
  // above on a slow machine. On CI the click went to the <iframe> in the page around it and never
  // reached the app (v0.1.19's first run, and three runs before v0.1.21); logged, the pointer reached
  // the frame about 0.6 s after the last resize. So the click waits until the pointer over the
  // button is the app's: the button says it is hovered. Moved a pixel each time, so that each try
  // is a new movement.
  const save = frame.getByRole('button', { name: 'Save a visit' });
  let tries = 0;
  await expect(async () => {
    await save.hover({ position: { x: 20 + (tries++ % 2), y: 10 } });
    await expect(frame.locator('button:hover')).toHaveText('Save a visit', { timeout: 250 });
  }).toPass({ timeout: 15_000 });
  await save.click();
  await expect(frame.getByText(`Saved for ${me.user.id}`)).toBeVisible();

  // Nothing the app's own page did was refused: the session's limit fits what the page needs.
  // (Its own /api/app/<slug> answering 401 and 403 is what shows the sign-in form and Join.)
  expect(refused.filter(line => !line.includes('/api/auth/me') && !line.includes(`/api/app/${app.slug}`))).toEqual([]);

  // The cookie is the domain's alone.
  const cookies = await visitor.cookies(site(MEMBERS_DOMAIN));
  const auth = cookies.find(cookie => cookie.name === 'formlogic_auth')!;
  expect(auth.domain).toBe(MEMBERS_DOMAIN);

  // What a domain's owner could collect by repointing the name opens nothing of the account.
  const stolen = { Authorization: `Bearer ${decodeURIComponent(auth.value)}` };
  const onPlatform = await browser.newContext();
  for (const path of ['/api/apps', '/api/forms', '/api/auth/me', `/api/app/${app.slug}/native`]) {
    const response = await onPlatform.request.get(`${E2E_FRONTEND_BASE_URL}${path}`, { headers: stolen });
    expect([401, 403], `${path} on the platform`).toContain(response.status());
  }
  for (const path of ['/api/apps', '/api/forms', '/api/flows', '/api/auth/mfa']) {
    const response = await onPlatform.request.get(`${E2E_FRONTEND_BASE_URL}${path}`, { headers: { ...stolen, Host: asDomain(MEMBERS_DOMAIN).Host } });
    expect(response.status(), `${path} on the domain`).toBe(403);
    expect((await response.json()).code).toBe('app_domain_session_scope');
  }
  // Nor can it touch the account it belongs to. Each of these would be a takeover, or an erasure.
  const domainCall = { headers: { ...stolen, ...asDomain(MEMBERS_DOMAIN), 'X-CSRF-Token': (await visitor.cookies(site(MEMBERS_DOMAIN))).find(cookie => cookie.name === 'formlogic_csrf')!.value, Cookie: `formlogic_auth=${auth.value}` } };
  const changed = await onPlatform.request.put(`${E2E_FRONTEND_BASE_URL}/api/auth/me`, { ...domainCall, data: { email: `stolen-${RUN}@e2e-apps.com`, password: 'stolen-password-1', currentPassword: PASSWORD } });
  expect(changed.status()).toBe(403);
  expect((await changed.json()).code).toBe('app_domain_session_scope');
  expect(changed.headers()['set-cookie'] ?? '').toBe('');
  expect((await onPlatform.request.delete(`${E2E_FRONTEND_BASE_URL}/api/auth/me`, { ...domainCall, data: { password: PASSWORD } })).status()).toBe(403);
  expect((await home.evaluate(() => fetch('/api/auth/me').then(response => response.json()))).user.email).toBe(member);
  // Another app's page takes visitors too, so there this session is nobody: no scope to report.
  const elsewhere = await onPlatform.request.get(`${E2E_FRONTEND_BASE_URL}/api/app/${other.app.slug}/native`, { headers: { ...stolen, Host: asDomain(MEMBERS_DOMAIN).Host } });
  expect(elsewhere.status()).toBe(403);
  await onPlatform.close();

  // Platform pages are not on the domain, signed in or out.
  await home.goto(`${site(MEMBERS_DOMAIN)}/dashboard`);
  await expect(home.frameLocator(FRAME).getByText('Domain app is running')).toBeVisible({ timeout: 60_000 });
  await expect(home.getByRole('navigation')).toHaveCount(0);

  // Still signed in after everything above, including every refusal.
  await home.goto(`${site(MEMBERS_DOMAIN)}/`);
  await expect(home.frameLocator(FRAME).getByText('Domain app is running')).toBeVisible({ timeout: 60_000 });

  // Leaving ends the session itself: what was collected before stops working.
  const leaving = await home.evaluate(csrf => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }).then(response => response.status), (await visitor.cookies(site(MEMBERS_DOMAIN))).find(cookie => cookie.name === 'formlogic_csrf')!.value);
  expect(leaving).toBe(200);
  const afterLeaving = await browser.newContext();
  expect((await afterLeaving.request.get(`${E2E_FRONTEND_BASE_URL}/api/app/${app.slug}/native`, { headers: { ...stolen, Host: asDomain(MEMBERS_DOMAIN).Host } })).status()).toBe(403);
  await afterLeaving.close();

  // An explicit sign-in goes the same way, and the owner gets the same limit.
  await visitor.clearCookies();
  await home.goto(`${site(MEMBERS_DOMAIN)}/`);
  await home.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(home).toHaveURL(new RegExp(`^${E2E_FRONTEND_BASE_URL}/login`));
  await home.getByLabel('Email').fill(owner);
  await home.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await home.getByRole('button', { name: 'Sign In' }).click();
  await home.getByRole('button', { name: 'Continue' }).click();
  await expect(home.frameLocator(FRAME).getByText('Domain app is running')).toBeVisible({ timeout: 60_000 });
  const ownerCookie = (await visitor.cookies(site(MEMBERS_DOMAIN))).find(cookie => cookie.name === 'formlogic_auth')!;
  const ownerToken = { Authorization: `Bearer ${decodeURIComponent(ownerCookie.value)}` };
  const ownerApps = await visitor.request.get(`${E2E_FRONTEND_BASE_URL}/api/apps`, { headers: ownerToken });
  expect([401, 403]).toContain(ownerApps.status());

  await visitor.close();
});

test('a public SoftN app opens on its domain for anyone, and removing the domain ends it', async ({ page, context, browser }) => {
  test.setTimeout(180_000);
  await signInOnPlatform(context.request, `domain-public-${RUN}@e2e-apps.com`);
  const { app, headers } = await publishApp(context, context.request, `domain-public-${RUN}`, 'application');
  await connectDomain(page, app.id, PUBLIC_DOMAIN);

  const visitor = await browser.newContext();
  const home = await visitor.newPage();
  await home.goto(`${site(PUBLIC_DOMAIN)}/`);
  await expect(home.frameLocator(FRAME).getByText('Domain app is running')).toBeVisible({ timeout: 60_000 });
  await home.frameLocator(FRAME).getByRole('button', { name: 'Save a visit' }).click();
  await expect(home.frameLocator(FRAME).getByText('Saved for anonymous')).toBeVisible();
  expect(new URL(home.url()).pathname).toBe('/');

  // Nobody signs in to the platform from a domain that is not connected, or as the demo.
  const demo = await visitor.request.post(`${E2E_FRONTEND_BASE_URL}/api/demo/start`, { headers: { ...asDomain(PUBLIC_DOMAIN), 'Content-Type': 'application/json' }, data: {} });
  expect(demo.status()).toBe(403);

  const domains = await (await context.request.get(`/api/apps/${app.id}/domains`)).json();
  const removed = await context.request.delete(`/api/apps/${app.id}/domains/${domains.domains[0].id}`, { headers });
  expect(removed.ok()).toBe(true);
  const after = await browser.newContext();
  const gone = await after.newPage();
  await gone.goto(`${site(PUBLIC_DOMAIN)}/`);
  await expect(gone.getByRole('heading', { name: "This domain isn't connected yet" })).toBeVisible();
  const signIn = await after.request.post(`${E2E_FRONTEND_BASE_URL}/api/auth/login`, { headers: { ...asDomain(PUBLIC_DOMAIN), 'Content-Type': 'application/json' }, data: { email: 'x@e2e-apps.com', password: PASSWORD } });
  expect(signIn.status()).toBe(403);
  await after.close();
  await visitor.close();
});
