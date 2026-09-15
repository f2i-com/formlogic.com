// FormLogic qualification journey against an installed host (lane 2/3/4 building block).
// Usage: node journey.mjs <base-url> <phase> [state.json]
//   phase=fresh   register, login, form + response, create app, install a minimal native project,
//                 run one request, list records; writes state.json
//   phase=verify  log in with state.json, assert the form response, app, records survive; run a write
//   phase=nonode  assert the native preflight reports an actionable error and forms still work
import fs from 'node:fs';
const [base, phase, stateFile = 'state.json'] = process.argv.slice(2);
if (!base || !phase) { console.error('usage: node journey.mjs <base> <phase> [state.json]'); process.exit(2); }
const jar = { cookie: '' };
async function req(url, init = {}) {
  init.headers = { ...(init.headers || {}), Cookie: jar.cookie };
  const res = await fetch(url, { ...init, redirect: 'manual' });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const [name] = pair.split('=');
    const rest = (jar.cookie || '').split('; ').filter((c) => c && !c.startsWith(name + '='));
    jar.cookie = [...rest, pair].join('; ');
  }
  return res;
}
const csrf = () => decodeURIComponent(((jar.cookie || '').match(/(?:^|; )formlogic_csrf=([^;]*)/) || [])[1] || '');
const json = (extra = {}) => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf(), ...extra });
const out = [];
const log = (k, v) => { out.push({ [k]: v }); console.log(k + ':', typeof v === 'string' ? v : JSON.stringify(v)); };
function fail(m) { console.error('FAIL: ' + m); fs.writeFileSync(stateFile + '.fail.json', JSON.stringify(out, null, 2)); process.exit(1); }

const nativeProject = {
  version: 0, access: 'application', assets: {},
  files: {
    'manifest.json': JSON.stringify({ id: 'lab.notes', name: 'Lab notes', version: '1.0.0', main: 'ui/main.ui', server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql', 'time'] },
      database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: [
        { path: '/api/notes', method: 'POST', handler: 'createNote', transaction: 'write', authorization: 'anonymous' },
        { path: '/api/notes', method: 'GET', handler: 'listNotes', transaction: 'read', authorization: 'anonymous' },
      ] } }),
    'ui/main.ui': '<Text>Lab notes</Text>',
    'server/migrations/001.sql': 'CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at TEXT);',
    'server/main.logic': 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title, created_at) VALUES(?, ?)", [req.body.title, softn.time.now()]); return { status: 201, body: { ok: true } }; }\nfunction listNotes(req) { return { status: 200, body: { notes: softn.sql.query("SELECT id, title FROM notes ORDER BY id") } }; }',
  },
};

async function login(email, password) {
  const r = await req(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) fail(`login ${r.status} ${await r.text()}`);
}

if (phase === 'fresh') {
  const email = `lab-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'Lab-Password-123';
  const reg = await req(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, name: 'Lab Owner' }) });
  if (reg.status !== 201) fail(`register ${reg.status} ${await reg.text()}`);
  log('register', 201);
  await login(email, password); log('login', 'ok');
  const formRes = await req(`${base}/api/forms`, { method: 'POST', headers: json(), body: JSON.stringify({ title: 'Lab intake', status: 'published', fields: [
    { id: 'note', type: 'short_text', label: 'Note', required: false, order: 0, properties: {} },
    { id: 'calc', type: 'calculated', label: 'Calc', required: false, order: 1, properties: { calculationExpression: '40 + 2' } },
  ] }) });
  if (!formRes.ok) fail(`form ${formRes.status} ${await formRes.text()}`);
  const form = (await formRes.json()).form; const noteId = form.fields.find((f) => f.type === 'short_text').id; const calcId = form.fields.find((f) => f.type === 'calculated').id;
  log('form', form.id);
  const sub = await req(`${base}/api/forms/${form.id}/responses`, { method: 'POST', headers: json(), body: JSON.stringify({ answers: { [noteId]: 'first record' } }) });
  if (!sub.ok) fail(`response ${sub.status} ${await sub.text()}`);
  const list = await (await req(`${base}/api/forms/${form.id}/responses`, { headers: json() })).json();
  const calc = list.responses?.[0]?.answers?.[calcId]; log('calculated field via sandbox runtime', calc);
  if (calc !== 42) fail('calculated field did not evaluate (sandbox runtime absent?)');
  const appRes = await req(`${base}/api/apps`, { method: 'POST', headers: json(), body: JSON.stringify({ name: 'Lab notes app' }) });
  if (!appRes.ok) fail(`app ${appRes.status} ${await appRes.text()}`);
  const appBody = await appRes.json(); const app = appBody.app ?? appBody; log('app', { id: app.id, slug: app.slug });
  const pre = await (await req(`${base}/api/apps/${app.id}/native`, { headers: json() })).json(); log('native preflight', { available: pre.available, ready: pre.ready, preflight: pre.preflight });
  const inst = await req(`${base}/api/apps/${app.id}/native`, { method: 'PUT', headers: json(), body: JSON.stringify({ project: nativeProject, expectedVersion: 0 }) });
  if (!inst.ok) fail(`native install ${inst.status} ${await inst.text()}`);
  const installed = await inst.json(); log('native install version', installed.project?.version);
  const run = await req(`${base}/api/app/${app.slug}/native/request`, { method: 'POST', headers: json(), body: JSON.stringify({ method: 'POST', path: '/api/notes', body: { title: 'hosted note one' } }) });
  const runBody = await run.json(); log('native request', { http: run.status, result: runBody.result });
  if (runBody.result?.status !== 201) fail('native request did not create a note');
  const recs = await (await req(`${base}/api/apps/${app.id}/native/records?table=notes&offset=0`, { headers: json() })).json(); log('records', { rows: recs.rows?.length, hasMore: recs.hasMore, tables: recs.tables });
  fs.writeFileSync(stateFile, JSON.stringify({ email, password, formId: form.id, noteId, calcId, appId: app.id, slug: app.slug, nativeVersion: installed.project?.version }, null, 2));
  log('state written', stateFile);
} else if (phase === 'verify') {
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await login(st.email, st.password); log('login (existing account)', 'ok');
  const list = await (await req(`${base}/api/forms/${st.formId}/responses`, { headers: json() })).json();
  log('responses kept', list.responses?.length); if (!list.responses?.length) fail('form responses missing after upgrade');
  const sub = await req(`${base}/api/forms/${st.formId}/responses`, { method: 'POST', headers: json(), body: JSON.stringify({ answers: { [st.noteId]: 'after upgrade' } }) });
  if (!sub.ok) fail(`post-upgrade response ${sub.status} ${await sub.text()}`); log('new response after upgrade', 'ok');
  const pre = await (await req(`${base}/api/apps/${st.appId}/native`, { headers: json() })).json(); log('native state', { available: pre.available, ready: pre.ready, version: pre.project?.version, files: Object.keys(pre.project?.files ?? {}).length });
  const run = await req(`${base}/api/app/${st.slug}/native/request`, { method: 'POST', headers: json(), body: JSON.stringify({ method: 'GET', path: '/api/notes' }) });
  const body = await run.json(); log('native read', { http: run.status, result: body.result });
  if (body.result?.status !== 200 || !body.result?.body?.notes?.length) fail('hosted app records not readable after upgrade');
  const w = await req(`${base}/api/app/${st.slug}/native/request`, { method: 'POST', headers: json(), body: JSON.stringify({ method: 'POST', path: '/api/notes', body: { title: 'written after upgrade' } }) });
  const wb = await w.json(); log('native write', wb.result?.status); if (wb.result?.status !== 201) fail('hosted app write failed after upgrade');
} else if (phase === 'nonode') {
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await login(st.email, st.password);
  const pre = await (await req(`${base}/api/apps/${st.appId}/native`, { headers: json() })).json(); log('native preflight without Node', { available: pre.available, ready: pre.ready, preflight: pre.preflight });
  const run = await req(`${base}/api/app/${st.slug}/native/request`, { method: 'POST', headers: json(), body: JSON.stringify({ method: 'GET', path: '/api/notes' }) });
  log('native request without Node', { http: run.status, body: (await run.text()).slice(0, 300) });
  const sub = await req(`${base}/api/forms/${st.formId}/responses`, { method: 'POST', headers: json(), body: JSON.stringify({ answers: { [st.noteId]: 'forms still work' } }) });
  log('form submission without Node', sub.status); if (!sub.ok) fail('forms broke when Node is absent');
}
fs.writeFileSync(stateFile + '.' + phase + '.log.json', JSON.stringify(out, null, 2));
