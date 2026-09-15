// Two editor sessions racing on one native draft version, at the API the editors use
// (PUT /api/apps/{id}/native with expectedVersion), plus the portable-export boundary check.
import fs from 'node:fs';
const [base, stateFile] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
function session() {
  const jar = { cookie: '' };
  async function req(url, init = {}) {
    init.headers = { ...(init.headers || {}), Cookie: jar.cookie };
    const res = await fetch(url, { ...init, redirect: 'manual' });
    for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'); const [name] = pair.split('='); jar.cookie = [...(jar.cookie || '').split('; ').filter((c) => c && !c.startsWith(name + '=')), pair].join('; '); }
    return res;
  }
  const csrf = () => decodeURIComponent(((jar.cookie || '').match(/(?:^|; )formlogic_csrf=([^;]*)/) || [])[1] || '');
  const json = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() });
  return { req, json };
}
const A = session(), B = session();
for (const s of [A, B]) {
  const r = await s.req(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: st.email, password: st.password }) });
  if (!r.ok) { console.error('login failed', r.status); process.exit(1); }
}
const current = await (await A.req(`${base}/api/apps/${st.appId}/native`, { headers: A.json() })).json();
const project = current.project; const v = project.version;
console.log('base version seen by both editors:', v, 'top-level project keys:', Object.keys(project).join(','));
// Portable export boundary: the owner project document carries source and media only.
const leak = Object.keys(project).filter((k) => /record|secret|key|token|password|config|database/i.test(k));
console.log('portable project keys that look private:', leak.length ? leak : 'none');
console.log('private source files stay in the owner draft (expected):', Object.keys(project.files).filter((p) => /^server\//.test(p)).join(','));
const edit = (label) => ({ ...project, files: { ...project.files, 'ui/main.ui': `<Text>Lab notes (edited by ${label})</Text>` } });
const a = await A.req(`${base}/api/apps/${st.appId}/native`, { method: 'PUT', headers: A.json(), body: JSON.stringify({ project: edit('A'), expectedVersion: v }) });
const aBody = await a.json(); console.log('editor A save:', a.status, 'new version', aBody.project?.version);
const b = await B.req(`${base}/api/apps/${st.appId}/native`, { method: 'PUT', headers: B.json(), body: JSON.stringify({ project: edit('B'), expectedVersion: v }) });
const bText = await b.text(); console.log('editor B save with the same base version:', b.status, bText.slice(0, 200));
const after = await (await A.req(`${base}/api/apps/${st.appId}/native`, { headers: A.json() })).json();
console.log('stored version:', after.project.version, 'ui/main.ui:', after.project.files['ui/main.ui']);
const ok = a.status === 200 && b.status === 409 && after.project.version === v + 1 && /edited by A/.test(after.project.files['ui/main.ui']);
console.log(ok ? 'RESULT: explicit conflict, A kept, B not applied' : 'RESULT: UNEXPECTED');
// B retries after reloading the version.
const b2 = await B.req(`${base}/api/apps/${st.appId}/native`, { method: 'PUT', headers: B.json(), body: JSON.stringify({ project: edit('B after reload'), expectedVersion: after.project.version }) });
console.log('editor B retry with the reloaded version:', b2.status, (await b2.json()).project?.version);
process.exit(ok ? 0 : 1);
