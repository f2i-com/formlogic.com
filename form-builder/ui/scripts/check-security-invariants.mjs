/**
 * Fast, deterministic guards for security invariants that a careless edit could silently break.
 * Runs in CI (frontend job). Currently pins the custom-screen CSP (the P0 no-egress exfil boundary).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.error('✗ security-invariant: ' + m); process.exitCode = 1; };

// ── Custom-screen CSP must stay no-egress ────────────────────────────────────
// A sandboxed screen can read records via the FormLogic SDK, so ANY outbound request is an exfil
// channel. img/font/media must be data:/blob: only (no remote http/https), and connect-src 'none'.
{
  const src = readFileSync(resolve(root, 'src/components/custom-screen/sdkRuntime.ts'), 'utf8');
  // Grab the concatenated SCREEN_CSP string literal(s). Match only "..."(+ "...")* so the ';'
  // characters INSIDE the CSP string don't prematurely terminate the capture.
  const m = src.match(/export const SCREEN_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/);
  if (!m) {
    fail('could not find SCREEN_CSP in sdkRuntime.ts');
  } else {
    const csp = (m[1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)).join('');
    const need = ["default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"];
    for (const d of need) {
      if (!csp.includes(d)) fail(`SCREEN_CSP missing "${d}"`);
    }
    // No remote hosts in resource directives.
    for (const dir of ['img-src', 'font-src', 'media-src']) {
      const seg = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(dir + ' '));
      if (seg && /https?:/.test(seg)) {
        fail(`SCREEN_CSP "${dir}" allows remote hosts (${seg.trim()}) — must be data:/blob: only`);
      }
    }
    if (/\bscript-src[^;]*\b(https?:|'unsafe-eval')/.test(csp)) {
      fail('SCREEN_CSP script-src must not allow remote scripts or unsafe-eval');
    }
  }
}

if (process.exitCode) {
  console.error('\nSecurity invariants FAILED. See docs/CUSTOM_SCREEN_DASHBOARD_KIT.md (CSP rule).');
} else {
  console.log('✓ security invariants OK');
}
