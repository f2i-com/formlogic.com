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
    const need = [
      "default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'",
      // Close the remaining egress channels: self-navigation, nested frames, objects, workers.
      "navigate-to 'none'", "frame-src 'none'", "object-src 'none'", "worker-src 'none'",
    ];
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

// ── screen-host.html must carry the SAME policy ─────────────────────────────
// The sandbox host document (public/screen-host.html) exists because srcdoc
// inherits the app shell's CSP; its own meta CSP must stay byte-identical to
// SCREEN_CSP or the two policies drift and one side silently loosens.
{
  const src = readFileSync(resolve(root, 'src/components/custom-screen/sdkRuntime.ts'), 'utf8');
  const m = src.match(/export const SCREEN_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/);
  const host = readFileSync(resolve(root, 'public/screen-host.html'), 'utf8');
  const hostCsp = host.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]*)"/);
  if (!m || !hostCsp) {
    fail('could not compare SCREEN_CSP with public/screen-host.html');
  } else {
    const csp = (m[1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)).join('');
    if (hostCsp[1] !== csp) {
      fail('public/screen-host.html meta CSP differs from SCREEN_CSP (sdkRuntime.ts) — keep them byte-identical');
    }
  }
  // The host boot must accept exactly one parent init, from OUR origin only —
  // a cross-origin init in a non-sandboxed embedding would document.write
  // attacker markup at this origin. (Sandboxing itself is asserted on the
  // embedding side — CustomScreenRuntime.tsx; framing is restricted to 'self'
  // in public/.htaccess.)
  if (!host.includes('e.source !== window.parent')) {
    fail('screen-host.html must only accept init messages from window.parent');
  }
  if (!host.includes("e.origin !== location.protocol + '//' + location.host")) {
    fail('screen-host.html must refuse cross-origin init messages');
  }
  const htaccess = readFileSync(resolve(root, 'public/.htaccess'), 'utf8');
  if (!/screen-host\\?\.html[\s\S]{0,400}frame-ancestors 'self'/.test(htaccess)) {
    fail(".htaccess must scope screen-host.html to frame-ancestors 'self' (never *)");
  }
}

// ── The hosted app frame is the containment for host JavaScript ─────────────
// An owner an administrator verified may run their app's logic as ordinary JavaScript, with no VM
// around it. Nothing inside the frame contains that: the shell's own policy is one token WEAKER
// on the host document, by design. What contains it is the attributes the parent sets on the
// iframe and the framing headers the server sends, and both are asserted here rather than left to
// a reviewer to notice. See docs/HOSTED_APPS.md.
{
  const frame = readFileSync(resolve(root, 'src/components/studio/HostedAppFrame.tsx'), 'utf8');
  // Exactly allow-scripts. allow-same-origin would give the frame this origin's cookies, storage
  // and DOM and undo every other boundary at once; allow-popups / allow-top-navigation /
  // allow-forms / allow-downloads each re-open an egress or phishing path the opaque origin closes.
  const sandbox = frame.match(/sandbox="([^"]*)"/g) || [];
  if (sandbox.length !== 1) fail(`HostedAppFrame.tsx must set the iframe sandbox exactly once (found ${sandbox.length})`);
  if (sandbox[0] !== 'sandbox="allow-scripts"') fail(`HostedAppFrame.tsx iframe sandbox must be exactly "allow-scripts" (found ${sandbox[0]})`);
  if (/allow-same-origin/.test(frame)) fail('HostedAppFrame.tsx must never name allow-same-origin: the frame\'s opaque origin is the boundary');
  if (!/referrerPolicy="no-referrer"/.test(frame)) fail('HostedAppFrame.tsx must set referrerPolicy="no-referrer" on the app frame');
  // The editors are same-origin and UNSANDBOXED, so they must never be handed an engine choice
  // and must never be pointed at the document whose policy carries 'unsafe-eval'.
  const editor = readFileSync(resolve(root, 'src/components/studio/AppEditorDialog.tsx'), 'utf8');
  if (/host\.html/.test(editor)) fail('AppEditorDialog.tsx must never reference the host-js runtime document: it is same-origin and unsandboxed');
  if (/\bengine\s*[=:]/.test(editor)) fail('AppEditorDialog.tsx must never pass or accept an engine: the editors always run on ZIPP');
  // The Aokie workspace pins its engine rather than taking a server decision, so nothing clamps
  // it at read time. It must stay on the ZIPP VM.
  const aokie = readFileSync(resolve(root, 'src/components/app-runtime/AokieWorkspace.tsx'), 'utf8');
  if (!/AOKIE_ENGINE\s*=\s*\{\s*id:\s*'zipp-web-python'/.test(aokie)) fail("AokieWorkspace.tsx must pin AOKIE_ENGINE to 'zipp-web-python'");
  if (/host-js/.test(aokie)) fail('AokieWorkspace.tsx must never name host-js: its engine is pinned, so no read-time clamp applies to it');

  const htaccess = readFileSync(resolve(root, 'public/.htaccess'), 'utf8');
  // Both hosted-runtime entry documents are framed by this origin alone. The document with the
  // weaker script policy must not be the one with the weaker framing rule.
  if (!/host\\\.html/.test(htaccess)) fail(".htaccess IS_APP_FRAME must name host\\.html so the host-js document is framed by 'self' alone");
  const appFrame = htaccess.split('\n').find((line) => line.includes('IS_APP_FRAME') && line.includes('SetEnvIf')) || '';
  for (const document of ['index\\.html', 'host\\.html']) {
    if (!appFrame.includes(document)) fail(`.htaccess IS_APP_FRAME must cover ${document}`);
  }
  // A redirect under either frame tree defeats the shell's connect-src pin: CSP path matching
  // stops at the redirect, so a redirect to /api carries the request (and, in some browsers, the
  // viewer's cookies) out of the frame. Neither tree may contain one.
  for (const line of htaccess.split('\n')) {
    const rule = line.trim();
    if (!/^(Redirect(Match|Permanent|Temp)?|RewriteRule)\s/i.test(rule)) continue;
    if (/\/?(hosted-runtime|app-editors)\//.test(rule)) {
      fail(`ui/public/.htaccess must not redirect or rewrite under the frame trees: ${rule}`);
    }
  }
}

if (process.exitCode) {
  console.error('\nSecurity invariants FAILED. See docs/CUSTOM_SCREEN_DASHBOARD_KIT.md (CSP rule) and docs/HOSTED_APPS.md (frame containment).');
} else {
  console.log('✓ security invariants OK');
}
