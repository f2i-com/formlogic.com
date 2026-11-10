// App AI and app payments, end to end, in a real browser against the real stack: a visitor with no
// account asks an app for a picture, the site's AI draws it (the App AI worker and the .env upstream),
// the app is delivered it, and the visitor pays 5 cents to download it: the app asks for the charge,
// FormLogic's wallet opens over the app, a top-up goes through PayPal, and the second request is paid.
//
// Needs the App AI stack (one origin, several PHP workers):
// - bin/app-ai-worker.php --watch;
// - AI_BASE_URL at the stand-in for Studio's gateway (backend/tests/Support/stub-images-server.php);
// - PAYPAL_BASE_URL at the stand-in for PayPal (backend/tests/Support/stub-paypal-server.php), with
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID and APP_ENV=development;
// - an administrator account: E2E_APP_AI_EMAIL and E2E_APP_AI_PASSWORD.
// The visitor pays as a person does on a development site: with the wallet's own "Pay with the
// stand-in PayPal" button, which the sheet shows where a stand-in answers for PayPal. PayPal's own
// script is never asked for (it knows nothing of a stand-in's orders), and the test checks it is not.
import { sessionHeaders } from './session-request';
import { expect, test } from '@playwright/test';

const EMAIL = process.env.E2E_APP_AI_EMAIL;
const PASSWORD = process.env.E2E_APP_AI_PASSWORD;

const UI = `<logic>
var message = 'Ready.';
var jobId = '';
var balance = '';
var got = '';
var who = '';
var where = '';
function read(response) { if (!response) return {}; if (typeof response.body === 'object') return response.body || {}; try { return JSON.parse(response.body || '{}'); } catch (problem) { return {}; } }
function poll() {
  softn.net.fetch('/api/latest', { method: 'GET', timeout: 15000 }, function (response) {
    var body = read(response);
    if (body.wallet) balance = 'Balance ' + body.wallet.balanceCents;
    if (body.job && body.job.status === 'done') { message = 'Drawn.'; return; }
    if (body.job && body.job.status === 'failed') { message = 'Failed: ' + body.job.code; return; }
    setTimeout(poll, 1000);
  });
}
function draw() {
  message = 'Asking…';
  softn.net.fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { prompt: 'A coffee cup logo' }, timeout: 15000 }, function (response) {
    var body = read(response);
    if (!response || !response.ok) { message = 'Not asked: ' + (body.error || (response && response.status)); return; }
    jobId = body.id;
    message = 'Drawing…';
    poll();
  });
}
function download() {
  softn.net.fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { job: jobId }, timeout: 20000 }, function (response) {
    var body = read(response);
    if (response && response.ok) { got = 'Got a ' + String(body.picture || '').length + ' character picture'; message = 'Downloaded.'; balance = 'Balance ' + body.balanceCents; return; }
    if (response && response.status === 402) { message = 'Top up to download.'; openWallet(); return; }
    message = 'Not downloaded: ' + (body.error || (response && response.status));
  });
}
function openWallet() {
  softn.backend.call('formlogicWallet', { op: 'open' }, function (answer) {
    if (answer && answer.result) balance = 'Balance ' + answer.result.balanceCents;
    message = 'Wallet closed.';
  });
}
function whoAmI() {
  softn.net.fetch('/api/latest', { method: 'GET', timeout: 15000 }, function (response) {
    var body = read(response);
    who = body.owner ? 'You own this shop.' : 'A visitor.';
    where = 'From ' + (body.addressKey || 'nowhere');
  });
}
</logic>
<Stack padding="24"><Text>Logo shop</Text><Button onClick={draw}>Draw</Button><Button onClick={download}>Download</Button><Button onClick={whoAmI}>Who am I</Button><Text>{message}</Text><Text>{balance}</Text><Text>{got}</Text><Text>{who}</Text><Text>{where}</Text></Stack>`;

const SERVER = `function owner(req) { var f = req.context && req.context.formlogic ? req.context.formlogic : {}; return f.visitor ? f.visitor.id : (f.userId || ''); }
function createJob(req) {
  var id = softn.crypto.randomHex(16);
  softn.sql.execute("INSERT INTO ai_jobs(id, kind, prompt, size, owner) VALUES(?,?,?,?,?)", [id, 'picture', String((req.body || {}).prompt || 'A logo'), '512x512', owner(req)]);
  return { status: 201, body: { id: id } };
}
function latest(req) {
  var row = softn.sql.first("SELECT j.id, d.status, d.code FROM ai_jobs j LEFT JOIN deliveries d ON d.job_id = j.id WHERE j.owner = ? ORDER BY j.rowid DESC LIMIT 1", [owner(req)]);
  return { status: 200, body: { job: row || null, wallet: req.context.formlogic.wallet || null, owner: req.context.formlogic.owner === true, addressKey: req.context.formlogic.addressKey || '' } };
}
function deliver(req) {
  if (!(req.context.formlogic.ai && req.context.formlogic.ai.delivery === true)) return { status: 403, body: { error: 'not a delivery' } };
  var b = req.body || {};
  softn.sql.execute("INSERT OR REPLACE INTO deliveries(job_id, status, picture, code) VALUES(?,?,?,?)", [String(b.jobId), String(b.status), b.picture || null, b.code || null]);
  return { status: 200, body: { ok: true } };
}
function download(req) {
  var job = String((req.body || {}).job || '');
  var picture = softn.sql.first("SELECT picture FROM deliveries WHERE job_id = ? AND status = 'done'", [job]);
  if (!picture) return { status: 404, body: { error: 'No picture yet.' } };
  var payment = req.context.formlogic.payment;
  if (!payment) return { status: 402, body: { formlogicCharge: { id: 'download:' + job, item: 'download' } }, rollback: true };
  if (payment.status !== 'paid') return { status: 402, body: { error: 'Top up to download.', code: payment.code } };
  softn.sql.execute("INSERT OR IGNORE INTO purchases(job_id, buyer, charge_id) VALUES(?,?,?)", [job, owner(req), payment.chargeId]);
  return { status: 200, body: { picture: picture.picture, balanceCents: payment.balanceCents } };
}`;

test('A visitor gets a picture from the site\'s AI and pays 5 cents to download it', async ({ browser, context }) => {
  test.setTimeout(240_000);
  test.skip(!EMAIL || !PASSWORD, 'Requires the App AI stack and an administrator account (see the header).');
  const login = await context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email: EMAIL, password: PASSWORD } });
  expect(login.ok(), await login.text()).toBe(true);
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'formlogic_csrf')!.value;
  const confirmed = await context.request.post('/api/admin/confirm', { headers: { 'X-CSRF-Token': csrf }, data: { password: PASSWORD } });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  const admin = { 'X-CSRF-Token': csrf, 'X-Admin-Confirmation': (await confirmed.json()).confirmation };

  // The site: payments and Site AI on, apps may use its AI (the .env upstream) and take payments.
  // No computer is chosen for the site's AI: one left chosen would be asked instead, and is not there.
  expect((await context.request.delete('/api/admin/site-ai-desktop', { headers: admin })).ok()).toBe(true);
  const plansAnswer = await (await context.request.get('/api/admin/plans', { headers: admin })).json();
  const plans = plansAnswer.plans ?? plansAnswer.data ?? plansAnswer;
  expect((await context.request.put('/api/admin/plans', { headers: admin, data: { ...plans, paymentsEnabled: true, siteAiEnabled: true } })).ok()).toBe(true);
  expect((await context.request.put('/api/admin/app-ai', { headers: admin, data: { allowApps: true, pictureModel: 'stub-image' } })).ok()).toBe(true);
  expect((await context.request.put('/api/admin/app-payments', { headers: admin, data: { enabled: true, packages: [200, 500], maxChargeCents: 500, dailyLimitCents: 500 } })).ok()).toBe(true);

  // The app: open to anyone, asking for pictures and selling a download for 5 cents.
  const slug = `logo-shop-${Date.now()}`;
  const created = await context.request.post('/api/apps', { headers: { 'X-CSRF-Token': csrf }, data: { name: 'Logo shop (e2e)', slug, settings: { softnApp: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const app = (await created.json()).app;
  const manifest = {
    id: 'com.formlogic.e2e.logo-shop', name: 'Logo shop', version: '1.0.0', main: 'ui/main.ui',
    server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql', 'crypto'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: [
        { path: '/api/jobs', method: 'POST', handler: 'createJob', transaction: 'write', authorization: 'anonymous' },
        { path: '/api/latest', method: 'GET', handler: 'latest', transaction: 'read', authorization: 'anonymous' },
        { path: '/api/download', method: 'POST', handler: 'download', transaction: 'write', authorization: 'anonymous' },
        { path: '/api/site/ai/deliver', method: 'POST', handler: 'deliver', transaction: 'write', authorization: 'anonymous' },
      ],
    },
    formlogicAi: { uses: ['pictures'], purpose: 'Draws a logo from your words.', jobs: { table: 'ai_jobs', deliver: '/api/site/ai/deliver' } },
    formlogicPayments: { purpose: 'Pay 5 cents to download a logo.', items: [{ id: 'download', label: 'Download a logo', priceCents: 5 }], routes: ['/api/download'] },
  };
  const project = { home: true, access: 'application', assets: {}, files: {
    'manifest.json': JSON.stringify(manifest), 'ui/main.ui': UI, 'server/main.logic': SERVER,
    'server/migrations/001.sql': "CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT, owner TEXT);\nCREATE TABLE deliveries(job_id TEXT PRIMARY KEY, status TEXT, picture TEXT, code TEXT);\nCREATE TABLE purchases(job_id TEXT, buyer TEXT, charge_id TEXT, PRIMARY KEY (job_id, buyer));",
  } };
  const installed = await context.request.put(`/api/apps/${app.id}/native`, { headers: { 'X-CSRF-Token': csrf }, data: { project, expectedVersion: 0 } });
  expect(installed.ok(), await installed.text()).toBe(true);
  expect((await context.request.post(`/api/apps/${app.id}/publish`, { headers: { 'X-CSRF-Token': csrf }, data: {} })).ok()).toBe(true);
  const ai = await context.request.put(`/api/apps/${app.id}/ai`, { headers: { 'X-CSRF-Token': csrf }, data: { mode: 'site', perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500 } });
  expect(ai.ok(), await ai.text()).toBe(true);
  const payments = await context.request.put(`/api/apps/${app.id}/payments`, { headers: { 'X-CSRF-Token': csrf }, data: { enabled: true, prices: { download: 5 } } });
  expect(payments.ok(), await payments.text()).toBe(true);

  // The visitor: no account, their own browser.
  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  const page = await visitor.newPage();
  const askedOfPayPal: string[] = [];
  page.on('request', (request) => { if (/paypal\.com/i.test(request.url())) askedOfPayPal.push(request.url()); });
  await page.goto(`/app/${slug}`);
  const frame = page.frameLocator('iframe[title="Hosted app"]');
  await frame.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(frame.getByText('Drawn.', { exact: true })).toBeVisible({ timeout: 90_000 });

  await frame.getByRole('button', { name: 'Download', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /Your balance with/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('wallet-balance')).toHaveText('$0.00');
  // A development site: the sheet says its PayPal is a stand-in, and pays through it with one button.
  await expect(sheet.getByTestId('wallet-stand-in')).toContainText('a stand-in answers for PayPal here, and no money moves');
  await sheet.getByRole('button', { name: 'Pay with the stand-in PayPal' }).click();
  await expect(sheet.getByTestId('wallet-balance')).toHaveText('$2.00');
  await expect(sheet).toContainText('Added. Your balance is $2.00.');
  expect(askedOfPayPal, 'PayPal itself is never asked for anything').toEqual([]);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(frame.getByText('Wallet closed.', { exact: true })).toBeVisible();
  await expect(frame.getByText('Balance 200', { exact: true })).toBeVisible();

  await frame.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(frame.getByText('Downloaded.', { exact: true })).toBeVisible();
  await expect(frame.getByText('Balance 195', { exact: true })).toBeVisible();
  await expect(frame.getByText(/Got a \d+ character picture/)).toBeVisible();

  // The administrator sees the top-up with PayPal's ids, and the owner the sale.
  const overview = await (await context.request.get('/api/admin/app-payments', { headers: admin })).json();
  expect(overview.data.topups.some((t: { appId: string; status: string; amountCents: number; captureId: string | null }) => t.appId === app.id && t.status === 'completed' && t.amountCents === 200 && t.captureId !== null)).toBe(true);
  const sales = await (await context.request.get(`/api/apps/${app.id}/payments`)).json();
  expect(sales.data.sales.today.cents).toBe(5);
  const owner = await (await context.request.get(`/api/apps/${app.id}/ai`)).json();
  expect(owner.data.log[0].status).toBe('done');

  // The shop is open to anyone, and its owner is still its owner: in the browser where they are
  // signed in to FormLogic the same page's backend is told so (`formlogic.owner`), and nobody else's.
  await frame.getByRole('button', { name: 'Who am I', exact: true }).click();
  await expect(frame.getByText('A visitor.', { exact: true })).toBeVisible();
  // The backend is also told where each request came from, as a key it can count by
  // (`formlogic.addressKey`): never the address.
  const from = await frame.getByText(/^From [0-9a-f]{32}$/).innerText();
  const ownersPage = await context.newPage();
  await ownersPage.goto(`/app/${slug}`);
  const ownersFrame = ownersPage.frameLocator('iframe[title="Hosted app"]');
  await ownersFrame.getByRole('button', { name: 'Who am I', exact: true }).click();
  await expect(ownersFrame.getByText('You own this shop.', { exact: true })).toBeVisible();
  // Two browsers on this machine are two visitors at one address: the same key.
  await expect(ownersFrame.getByText(from, { exact: true })).toBeVisible();
  await ownersPage.close();
  await visitor.close();
});
