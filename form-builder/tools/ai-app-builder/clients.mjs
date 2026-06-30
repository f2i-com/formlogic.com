// Thin clients the harness depends on. Kept I/O-only so the pure engine (assemble.mjs) stays
// portable to the frontend later (where these would be the app's api client + the AI endpoints).
import { config } from './config.mjs';

// ── AI (OpenAI-compatible chat) — used for the PLAN (the app has no multi-form planning endpoint) ──

/** Pull the first balanced JSON object out of a model reply (handles ```json fences + prose). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('No JSON object in AI reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('Unbalanced JSON in AI reply');
}

/** Call the OpenAI-compatible chat endpoint and return the assistant message content. */
export async function aiChat(system, user, { temperature = 0.4, maxTokens = 4096 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.aiKey) headers.Authorization = `Bearer ${config.aiKey}`;
  const res = await fetch(`${config.aiBase}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.aiModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty AI reply');
  return content;
}

// ── FormLogic API (cookie-jar session + double-submit CSRF) ──

export function createApiClient() {
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

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(`${config.apiBase}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    captureCookies(res);
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = json?.message || json?.error || text.slice(0, 300);
      const err = new Error(`${method} ${path} → HTTP ${res.status}: ${msg}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }

  return {
    async login() { await request('POST', '/api/auth/login', { email: config.email, password: config.password }); },
    aiStatus: () => request('GET', '/api/ai/status'),
    generateForm: (prompt) => request('POST', '/api/ai/generate-form', { prompt }),
    generateScript: (prompt, fields) => request('POST', '/api/ai/generate-script', { prompt, fields }),
    importPack: (pack) => request('POST', '/api/packs/import', { pack }),
    publishForm: (id) => request('PUT', `/api/forms/${id}`, { status: 'published' }),
    publishApp: (id) => request('PUT', `/api/apps/${id}`, { status: 'published' }),
    request,
  };
}
