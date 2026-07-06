// Configuration for the AI App Builder harness. Reads the AI provider from the backend .env so it
// uses the same model the app does; the API base + credentials come from env (with dev defaults).
// Precedence: process.env > form-builder/backend/.env > built-in default.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const backendEnv = join(here, '..', '..', 'backend', '.env');

function parseEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — rely on process.env */ }
  return out;
}

const env = parseEnv(backendEnv);
const pick = (k, d) => process.env[k] || env[k] || d;
const pickInt = (k, d, lo, hi) => {
  const n = Number(pick(k, String(d)));
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.trunc(n), hi)) : d;
};

export const config = {
  // FormLogic API (authed endpoints: generate-form, generate-script, packs/import, forms/apps).
  apiBase: pick('FL_API_BASE', 'http://api.formlogic.local'),
  email: pick('FL_EMAIL', 'test@example.com'),
  password: pick('FL_PASSWORD', 'password123'),
  // AI provider (OpenAI-compatible) — used directly for the multi-form PLAN and the dashboard
  // design (per the project's AI_BASE_URL convention; keyless local servers work).
  aiBase: pick('AI_BASE_URL', 'http://localhost:8001/v1').replace(/\/+$/, ''),
  aiKey: pick('AI_API_KEY', ''),
  aiModel: pick('AI_MODEL', 'gpt-4o'),
  // Keep generated apps modest by default; large apps = many slow AI calls.
  maxForms: pickInt('FL_MAX_FORMS', 6, 1, 12),
  // Per-AI-call timeout. Local models can be slow — default 5 minutes.
  aiTimeoutMs: pickInt('FL_AI_TIMEOUT_MS', 300000, 5000, 3600000),
};
