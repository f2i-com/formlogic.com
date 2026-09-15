// Account backup lane. phase=export <base> <state> <out.zip>: owner export.
// phase=import <base> <state> <zip> <newstate>: register a NEW account on an empty host and import.
import fs from 'node:fs';
const [phase, base, stateFile, zipPath, newStateFile] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const jar = { cookie: '' };
async function req(url, init = {}) {
  init.headers = { ...(init.headers || {}), Cookie: jar.cookie };
  const res = await fetch(url, { ...init, redirect: 'manual' });
  for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'); const [name] = pair.split('='); jar.cookie = [...(jar.cookie || '').split('; ').filter((c) => c && !c.startsWith(name + '=')), pair].join('; '); }
  return res;
}
const csrf = () => decodeURIComponent(((jar.cookie || '').match(/(?:^|; )formlogic_csrf=([^;]*)/) || [])[1] || '');
const H = (extra = {}) => ({ 'X-CSRF-Token': csrf(), ...extra });
async function login(email, password) { const r = await req(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); if (!r.ok) { console.error('login', r.status); process.exit(1); } }
if (phase === 'export') {
  await login(st.email, st.password);
  const r = await req(`${base}/api/account/backup/export`, { headers: H() });
  if (!r.ok) { console.error('export', r.status, (await r.text()).slice(0, 300)); process.exit(1); }
  const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(zipPath, buf);
  console.log('export:', r.status, buf.length, 'bytes', r.headers.get('content-type'));
} else {
  const email = `restore-${Math.random().toString(36).slice(2, 8)}@example.test`, password = 'Lab-Password-123';
  const reg = await req(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, name: 'Restore Owner' }) });
  if (reg.status !== 201) { console.error('register', reg.status, await reg.text()); process.exit(1); }
  await login(email, password);
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }), 'backup.zip');
  const r = await req(`${base}/api/account/backup/import`, { method: 'POST', headers: H(), body: fd });
  const text = await r.text(); console.log('import:', r.status, text.slice(0, 1200));
  if (!r.ok) process.exit(1);
  const forms = await (await req(`${base}/api/forms`, { headers: H() })).json();
  const apps = await (await req(`${base}/api/apps`, { headers: H() })).json();
  const formList = forms.forms ?? forms; const appList = apps.apps ?? apps;
  console.log('forms after restore:', formList.map((f) => `${f.id}:${f.title}`).join(' | '));
  console.log('apps after restore:', appList.map((a) => `${a.id}:${a.slug}`).join(' | '));
  const form = formList.find((f) => f.id === st.formId) ?? formList.find((f) => f.title === 'Lab intake');
  const app = appList.find((a) => a.id === st.appId) ?? appList.find((a) => a.name === 'Lab notes app');
  fs.writeFileSync(newStateFile, JSON.stringify({ ...st, email, password, formId: form?.id, appId: app?.id, slug: app?.slug, idsPreserved: form?.id === st.formId && app?.id === st.appId }, null, 2));
  console.log('ids preserved:', form?.id === st.formId && app?.id === st.appId);
}
