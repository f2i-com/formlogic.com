// Shared hardening for the sandboxed custom-screen runtimes (form + app).

// CSP applied INSIDE the screen's iframe. The SDK talks to the parent via postMessage (not affected by
// CSP), so the screen needs no network of its own: connect-src 'none' blocks fetch/XHR/websocket/beacon
// (no data exfiltration), default-src 'none' blocks plugins/objects, base-uri/form-action 'none' prevent
// base-tag and form hijacking. Inline script/style are allowed (that's the screen's own code); images and
// fonts may load over https/data for visuals.
export const SCREEN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data: https:; font-src data: https:; media-src data: https:; "
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
