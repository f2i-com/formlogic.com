// What a computer that draws for apps is told, and what an app may ask of a delivery, in a real
// browser against the real stack and a stand-in OAIY computer
// (backend/tests/Support/stub-oaiy-computer.php), which speaks OAIY's side of the sealed lane:
//
// 1. a visitor cancels a picture that is being drawn: the computer's next progress frame is answered
//    409 `cancelled`, it stops there, and the next picture is drawn at once (before, the cancelled
//    one was drawn to its end and held the computer's one place);
// 2. a chat whose model runs on (20,000 characters, whatever `maxTokens` says): the site reads the
//    characters its answer may have, ends the turn, and the computer is told the same way;
// 3. an app's deliver route asks for a follow-up: handed a chat's answer, it writes a picture job,
//    which is drawn for the visitor who asked for the chat, though their page asked for nothing more.
//
// Needs the App AI stack and its administrator (E2E_APP_AI_EMAIL, E2E_APP_AI_PASSWORD), as
// app-ai-setup.spec.ts does; like it, this changes the site's AI settings and unlinks that
// account's computers, so run the App AI specs one at a time (`--workers=1`).
import { expect, test } from '@playwright/test';
import { EMAIL, PASSWORD, nothingSetUp, signIn, startComputer, type StandInComputer } from './app-ai-stack';

const COMPUTER = 'Studio PC';
let computer: StandInComputer | null = null;

const UI = `<logic>
var message = 'Ready.';
var jobId = '';
var got = '';
function read(response) { if (!response) return {}; if (typeof response.body === 'object') return response.body || {}; try { return JSON.parse(response.body || '{}'); } catch (problem) { return {}; } }
function poll() {
  softn.net.fetch('/api/latest', { method: 'GET', timeout: 15000 }, function (response) {
    var job = read(response).job;
    if (job && job.status === 'done') { got = job.kind === 'chat' ? 'Answer of ' + String(job.text || '').length + ' characters' : 'A picture: ' + job.prompt; message = 'Done.'; return; }
    if (job && job.status === 'cancelled') { message = 'Cancelled.'; return; }
    if (job && job.status === 'failed') { message = 'Failed: ' + job.code; return; }
    setTimeout(poll, 1000);
  });
}
function ask(kind, prompt, follow) {
  message = 'Asking…';
  got = '';
  softn.net.fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { kind: kind, prompt: prompt, follow: follow }, timeout: 15000 }, function (response) {
    var body = read(response);
    if (!response || !response.ok) { message = 'Not asked: ' + (body.error || (response && response.status)); return; }
    jobId = body.id;
    message = 'Waiting…';
    poll();
  });
}
function drawSlowly() { ask('picture', '[slow:40] A coffee cup logo', 0); }
function draw() { ask('picture', 'A coffee cup logo', 0); }
function askLong() { ask('chat', '[long:20000] Write a long poem about cats.', 0); }
function askAndDraw() { ask('chat', 'Plan a logo for my cafe.', 1); }
function cancel() { softn.net.fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { id: jobId }, timeout: 15000 }, function (response) {}); }
</logic>
<Stack padding="24"><Text>Logo desk</Text><Button onClick={drawSlowly}>Draw slowly</Button><Button onClick={draw}>Draw</Button><Button onClick={askLong}>Ask</Button><Button onClick={askAndDraw}>Ask and draw</Button><Button onClick={cancel}>Cancel</Button><Text>{message}</Text><Text>{got}</Text></Stack>`;

// The app keeps who asked as FormLogic names them (ai.requester): the same id on their own request
// and on the delivery of their job, which is how the deliver route knows whose follow-up it writes.
const SERVER = `function asking(req) { var f = req.context && req.context.formlogic ? req.context.formlogic : {}; return f.ai && f.ai.requester ? f.ai.requester : ''; }
function createJob(req) {
  var b = req.body || {};
  var id = softn.crypto.randomHex(16);
  var chat = b.kind === 'chat';
  softn.sql.execute("INSERT INTO ai_jobs(id, kind, prompt, size, messages, requester, follow, status) VALUES(?,?,?,?,?,?,?,?)",
    [id, chat ? 'chat' : 'picture', String(b.prompt || ''), chat ? null : '512x512', chat ? JSON.stringify([{ role: 'user', content: String(b.prompt || '') }]) : null, asking(req), Number(b.follow) === 1 ? 1 : 0, 'asked']);
  return { status: 201, body: { id: id } };
}
function cancelJob(req) {
  softn.sql.execute("UPDATE ai_jobs SET status = 'cancelled' WHERE id = ? AND requester = ?", [String((req.body || {}).id || ''), asking(req)]);
  return { status: 200, body: { ok: true } };
}
function latest(req) {
  var row = softn.sql.first("SELECT j.id, j.kind, j.prompt, d.status, d.code, d.text FROM ai_jobs j LEFT JOIN deliveries d ON d.job_id = j.id WHERE j.requester = ? ORDER BY j.rowid DESC LIMIT 1", [asking(req)]);
  return { status: 200, body: { job: row || null } };
}
function deliver(req) {
  var ai = req.context.formlogic.ai;
  if (!(ai && ai.delivery === true)) return { status: 403, body: { error: 'not a delivery' } };
  var b = req.body || {};
  softn.sql.execute("INSERT OR REPLACE INTO deliveries(job_id, status, code, text) VALUES(?,?,?,?)", [String(b.jobId), String(b.status), b.code || null, b.text || null]);
  var asked = softn.sql.first("SELECT requester, follow FROM ai_jobs WHERE id = ?", [String(b.jobId)]);
  if (asked && Number(asked.follow) === 1 && b.status === 'done' && asked.requester === ai.requester) {
    softn.sql.execute("INSERT INTO ai_jobs(id, kind, prompt, size, requester, follow, status) VALUES(?,?,?,?,?,?,?)",
      [softn.crypto.randomHex(16), 'picture', 'Drawn after the plan', '512x512', ai.requester, 0, 'asked']);
  }
  return { status: 200, body: { ok: true } };
}`;

test.afterEach(async ({ context }) => {
  computer?.stop();
  computer = null;
  if (!EMAIL || !PASSWORD) return;
  await nothingSetUp(await signIn(context));
});

test('A cancel and an answer\'s length reach the computer, and a delivery asks for one follow-up', async ({ browser, context }) => {
  test.setTimeout(300_000);
  test.skip(!EMAIL || !PASSWORD, 'Requires the App AI stack and an administrator account (see the header).');
  const admin = await signIn(context);
  await nothingSetUp(admin);

  // The site's AI: a stand-in computer, linked with a one-time code and chosen; apps may use it, and a
  // chat's answer may be 16 tokens (128 characters are read of it).
  const made = await admin.api.post('/api/desktop-links/codes', { headers: { 'X-CSRF-Token': admin.csrf }, data: { scope: 'ai', deviceName: COMPUTER } });
  expect(made.ok(), await made.text()).toBe(true);
  computer = startComputer((await made.json()).data.code, COMPUTER, 280);
  const said = () => computer!.said();
  let connectionId = '';
  await expect.poll(async () => {
    const answer = await (await admin.api.get('/api/admin/site-ai-desktop', { headers: admin.headers })).json();
    const online = ((answer.data ?? answer).candidates ?? []).find((candidate: { online: boolean }) => candidate.online);
    connectionId = online?.connectionId ?? '';
    return connectionId;
  }, { timeout: 60_000 }).not.toBe('');
  expect((await admin.api.put('/api/admin/site-ai-desktop', { headers: admin.headers, data: { connectionId } })).ok()).toBe(true);
  const settings = await admin.api.put('/api/admin/app-ai', { headers: admin.headers, data: { allowApps: true, pictureModel: 'flux-3-image-klein', chatMaxOutput: 16 } });
  expect(settings.ok(), await settings.text()).toBe(true);

  // The app: open to anyone, asking for pictures and chat.
  const slug = `logo-desk-${Date.now()}`;
  const created = await admin.api.post('/api/apps', { headers: { 'X-CSRF-Token': admin.csrf }, data: { name: 'Logo desk (e2e)', slug, settings: { softnApp: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const app = (await created.json()).app;
  const manifest = {
    id: 'com.formlogic.e2e.logo-desk', name: 'Logo desk', version: '1.0.0', main: 'ui/main.ui',
    server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql', 'crypto'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: [
        { path: '/api/jobs', method: 'POST', handler: 'createJob', transaction: 'write', authorization: 'anonymous' },
        { path: '/api/cancel', method: 'POST', handler: 'cancelJob', transaction: 'write', authorization: 'anonymous' },
        { path: '/api/latest', method: 'GET', handler: 'latest', transaction: 'read', authorization: 'anonymous' },
        { path: '/api/site/ai/deliver', method: 'POST', handler: 'deliver', transaction: 'write', authorization: 'anonymous' },
      ],
    },
    formlogicAi: { uses: ['pictures', 'chat'], purpose: 'Plans and draws a logo from your words.', jobs: { table: 'ai_jobs', deliver: '/api/site/ai/deliver' } },
  };
  const project = { home: true, access: 'application', assets: {}, files: {
    'manifest.json': JSON.stringify(manifest), 'ui/main.ui': UI, 'server/main.logic': SERVER,
    'server/migrations/001.sql': 'CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT, requester TEXT, follow INTEGER, status TEXT);\nCREATE TABLE deliveries(job_id TEXT PRIMARY KEY, status TEXT, code TEXT, text TEXT);',
  } };
  const installed = await admin.api.put(`/api/apps/${app.id}/native`, { headers: { 'X-CSRF-Token': admin.csrf }, data: { project, expectedVersion: 0 } });
  expect(installed.ok(), await installed.text()).toBe(true);
  expect((await admin.api.post(`/api/apps/${app.id}/publish`, { headers: { 'X-CSRF-Token': admin.csrf }, data: {} })).ok()).toBe(true);
  const ai = await admin.api.put(`/api/apps/${app.id}/ai`, { headers: { 'X-CSRF-Token': admin.csrf }, data: { mode: 'site', perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500 } });
  expect(ai.ok(), await ai.text()).toBe(true);

  // The visitor: no account, their own browser.
  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  const page = await visitor.newPage();
  await page.goto(`/app/${slug}`);
  const frame = page.frameLocator('iframe[title="Hosted app"]');
  const press = (name: string) => frame.getByRole('button', { name, exact: true }).click();

  // 1. A picture that takes 40 seconds, cancelled once the computer has started on it.
  await press('Draw slowly');
  await expect.poll(said, { timeout: 60_000 }).toContain('image taken');
  await press('Cancel');
  await expect(frame.getByText('Cancelled.', { exact: true })).toBeVisible({ timeout: 30_000 });
  // The computer hears on its next progress frame (one a second here) and stops: long before the 40 are up.
  await expect.poll(said, { timeout: 30_000 }).toMatch(/image cancelled after \d+ frames/);
  expect(Number(/image cancelled after (\d+) frames/.exec(said())![1])).toBeLessThan(30);
  expect(said()).not.toContain('image answered');
  // Its place is free: the next picture is drawn at once.
  await press('Draw');
  await expect(frame.getByText('A picture: A coffee cup logo', { exact: true })).toBeVisible({ timeout: 30_000 });

  // 2. A chat whose model runs on. The request says how long the answer may be; the site reads no
  // more than that of what comes, ends the turn, and the computer is told to stop.
  await press('Ask');
  await expect(frame.getByText('Answer of 128 characters', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(said, { timeout: 30_000 }).toMatch(/chat maxTokens=16 cancelled after \d+ frames/);
  expect(Number(/chat maxTokens=16 cancelled after (\d+) frames/.exec(said())![1])).toBeLessThan(400);

  // 3. A chat whose delivery asks for a picture: drawn for this visitor, with nothing more asked by their page.
  await press('Ask and draw');
  await expect(frame.getByText('A picture: Drawn after the plan', { exact: true })).toBeVisible({ timeout: 90_000 });
  const log = (await (await admin.api.get(`/api/apps/${app.id}/ai`)).json()).data.log as { kind: string; status: string }[];
  expect(log.filter((job) => job.status === 'done').map((job) => job.kind).sort()).toEqual(['chat', 'chat', 'picture', 'picture']);

  await visitor.close();
  expect((await admin.api.delete(`/api/apps/${app.id}`, { headers: { 'X-CSRF-Token': admin.csrf } })).ok()).toBe(true);
});
