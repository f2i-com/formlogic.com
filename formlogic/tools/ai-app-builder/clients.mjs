// Thin clients the harness depends on. Kept I/O-only so the pure engine (assemble.mjs) stays
// portable to the frontend (ui/src/lib/ai-app-builder/ hosts the in-app port of the same engine).
import { config } from './config.mjs';

// ── AI (OpenAI-compatible chat) — used directly for the multi-form PLAN and the dashboard design.
// (The backend also exposes POST /api/ai/generate-app-plan for the in-app flow; the harness keeps
// its own planner so it can carry extra fields — appKind — the server planner doesn't return.) ──

/** Pull the first balanced JSON object out of a model reply (handles ```json fences + prose). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('no JSON object in the reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON in the reply');
}

/** Turn a low-level fetch failure into an actionable message (who was unreachable + what to set). */
function connectionError(e, target, hint) {
  const code = e?.cause?.code || e?.code || '';
  return new Error(`Cannot reach ${target}${code ? ` (${code})` : ''} — ${hint}`);
}

/** Call the OpenAI-compatible chat endpoint and return the assistant message content. */
export async function aiChat(system, user, { temperature = 0.4, maxTokens = 4096 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.aiKey) headers.Authorization = `Bearer ${config.aiKey}`;
  let res;
  try {
    res = await fetch(`${config.aiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.aiModel,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`AI request timed out after ${Math.round(config.aiTimeoutMs / 1000)}s `
        + `(${config.aiModel} @ ${config.aiBase}). Slow local model? Raise FL_AI_TIMEOUT_MS.`);
    }
    throw connectionError(e, `the AI endpoint at ${config.aiBase}`,
      'is your OpenAI-compatible server running? Set AI_BASE_URL (and AI_API_KEY only if the provider '
      + 'needs one — a keyless local server such as LM Studio at http://localhost:8001/v1 works as-is).');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`AI HTTP ${res.status}: authentication failed — check AI_API_KEY (leave it empty for keyless local servers).`);
  }
  if (res.status === 404) {
    throw new Error(`AI HTTP 404 at ${config.aiBase}/chat/completions — AI_BASE_URL must point at an `
      + 'OpenAI-compatible /v1 root (e.g. http://localhost:8001/v1), not a bare host.');
  }
  if (!res.ok) {
    const err = new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty AI reply');
  return content;
}

/**
 * aiChat + extractJson with a retry-or-explain path: if the first reply isn't parseable JSON, ask
 * once more (JSON only, lower temperature); if that fails too, throw an error that shows how the
 * reply started so the failure is diagnosable instead of a bare parse error.
 */
export async function aiJson(system, user, opts = {}) {
  const first = await aiChat(system, user, opts);
  try {
    return extractJson(first);
  } catch (e1) {
    const retryUser = `${user}\n\nYour previous reply could not be parsed (${e1.message}). `
      + 'Respond again with ONLY the JSON object — no prose, no markdown fences.';
    const second = await aiChat(system, retryUser, { ...opts, temperature: 0.2 });
    try {
      return extractJson(second);
    } catch (e2) {
      throw new Error(`the AI did not return valid JSON after a retry (${e2.message}). `
        + `Reply started with: ${JSON.stringify(second.slice(0, 200))}`);
    }
  }
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
    let res;
    try {
      res = await fetch(`${config.apiBase}${path}`, {
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
