// Session API client with explicit configuration and injectable transport for offline tests.
import { sessionJsonHeaders } from '../../../scripts/session-request.mjs';

function connectionError(e, target, hint) {
  const code = e?.cause?.code || e?.code || '';
  return new Error(`Cannot reach ${target}${code ? ` (${code})` : ''} — ${hint}`);
}

export function createApiClient(config, transport = fetch) {
  let cookies = {};       // name -> value
  let csrf = '';

  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  function captureCookies(res) {
    // Node fetch exposes combined Set-Cookie via getSetCookie() (Node 18.14+) or the raw header.
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const line of raw) {
      const m = line.match(/^([^=]+)=([^;]*)/);
      if (m) cookies[m[1].trim()] = m[2];
    }
    if (cookies.formlogic_csrf) csrf = cookies.formlogic_csrf;
  }

  async function request(method, path, body, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    let res;
    try {
      res = await transport(`${config.apiBase}${path}`, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw connectionError(e, `the FormLogic API at ${config.apiBase}`,
        'is the backend up? Set FL_API_BASE to the API host (dev default http://api.formlogic.local).');
    }
    captureCookies(res);
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      let msg = json?.message || json?.error || text.slice(0, 300);
      if (json?.code === 'unverified_package') {
        msg += ' (this workspace has REQUIRE_VERIFIED_PACKAGES=true, which blocks flat JSON pack '
          + 'imports — unset it in the backend .env for dev, or import a signed .formlogic package)';
      }
      const err = new Error(`${method} ${path} → HTTP ${res.status}: ${msg}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }

  return {
    async login() { await request('POST', '/api/auth/login', { email: config.email, password: config.password }, sessionJsonHeaders(config.frontendBase)); },
    aiStatus: () => request('GET', '/api/ai/status'),
    generateForm: (prompt) => request('POST', '/api/ai/generate-form', { prompt }),
    generateScript: (prompt, fields) => request('POST', '/api/ai/generate-script', { prompt, fields }),
    // SAFE-001: the import API requires the reviewed grant array. Builder-generated packs carry
    // no connector grants, so an explicit empty approval is exact (and fails closed if that changes).
    importPack: (pack) => request('POST', '/api/packs/import', { pack, approvedConnectorGrants: [] }),
    publishForm: (id) => request('PUT', `/api/forms/${id}`, { status: 'published' }),
    publishApp: (id) => request('PUT', `/api/apps/${id}`, { status: 'published' }),
    request,
  };
}
