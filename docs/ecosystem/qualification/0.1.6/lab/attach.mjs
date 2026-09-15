// Attachment lane: create a form with a file field and upload a file (phase=upload), or
// re-download the recorded attachment and assert its bytes (phase=verify).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const [base, phase, stateFile] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const jar = { cookie: '' };
async function req(url, init = {}) {
  init.headers = { ...(init.headers || {}), Cookie: jar.cookie };
  const res = await fetch(url, { ...init, redirect: 'manual' });
  for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'); const [name] = pair.split('='); jar.cookie = [...(jar.cookie || '').split('; ').filter((c) => c && !c.startsWith(name + '=')), pair].join('; '); }
  return res;
}
const csrf = () => decodeURIComponent(((jar.cookie || '').match(/(?:^|; )formlogic_csrf=([^;]*)/) || [])[1] || '');
const r = await req(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: st.email, password: st.password }) });
if (!r.ok) { console.error('login failed', r.status); process.exit(1); }
// A real 1x1 PNG followed by padding inside a PNG chunk-free tail is not valid; use a genuine tiny PNG.
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const digest = createHash('sha256').update(bytes).digest('hex');
if (phase === 'upload') {
  const formRes = await req(`${base}/api/forms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ title: 'Lab attachments', status: 'published', fields: [{ id: 'doc', type: 'file_upload', label: 'Document', required: false, order: 0, properties: {} }] }) });
  if (!formRes.ok) { console.error('form', formRes.status, await formRes.text()); process.exit(1); }
  const form = (await formRes.json()).form; const fieldId = form.fields[0].id;
  const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'image/png' }), 'lab.png'); fd.append('fieldId', fieldId);
  const up = await req(`${base}/api/forms/${form.id}/upload`, { method: 'POST', headers: { 'X-CSRF-Token': csrf() }, body: fd });
  const text = await up.text();
  if (!up.ok) { console.error('upload', up.status, text.slice(0, 300)); process.exit(1); }
  const body = JSON.parse(text);
  console.log('upload response keys:', Object.keys(body));
  const file = body.file ?? body;
  const sub = await req(`${base}/api/forms/${form.id}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ answers: { [fieldId]: [{ ...file }] } }) });
  console.log('response with attachment:', sub.status);
  Object.assign(st, { attachForm: form.id, attachField: fieldId, attach: file, attachDigest: digest });
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  console.log('attachment recorded:', JSON.stringify(file).slice(0, 200));
} else {
  const url = st.attach.url ?? st.attach.downloadUrl ?? `/api/files/${st.attach.id}`;
  const dl = await req(url.startsWith('http') ? url : base + url, { headers: { 'X-CSRF-Token': csrf() } });
  const buf = Buffer.from(await dl.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  console.log('attachment download:', dl.status, 'bytes', buf.length, 'digest matches:', got === st.attachDigest);
  const list = await (await req(`${base}/api/forms/${st.attachForm}/responses`, { headers: { 'X-CSRF-Token': csrf() } })).json();
  console.log('attachment form responses:', list.responses?.length);
  if (dl.status !== 200 || got !== st.attachDigest) process.exit(1);
}
