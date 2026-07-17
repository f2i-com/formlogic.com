// Shared hardening for the sandboxed custom-screen runtimes (form + app).

// CSP applied inside the opaque-origin iframe. It remains useful defense in
// depth, but self-navigation is deliberately not a security invariant because
// supported browsers do not consistently implement a navigation directive.
// Sensitive SDK methods are instead denied by server-derived provenance for
// every unverified imported screen.
//
// The iframe needs no network of its own: SDK calls use postMessage. Remote
// fetch/XHR/WebSocket, images, media, fonts, forms, objects, workers and nested
// frames are all blocked. If screens need remote assets, add a controlled
// FormLogic asset capability rather than widening this policy to https:.
export const SCREEN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data: blob:; font-src data:; media-src data: blob:; "
  + "connect-src 'none'; base-uri 'none'; form-action 'none'; "
  + "navigate-to 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'";

export type ScreenTrust = 'owner' | 'verified' | 'untrusted' | undefined;

const TRUSTED_ONLY_ACTIONS = new Set([
  'submit',
  'records',
  'currentUser',
  'record',
  'related',
  'navigate',
  'openForm',
  'openRecords',
  // Bridge v1 (plan §8.3): connector commands, record writes/deletes and the
  // desktop-presence snapshot are all data/hardware surface — imported
  // community code stays visual-only.
  'connector',
  'updateRecord',
  'deleteRecords',
  'queryRecords',
  'presence',
  // Subscription lane: live event/caption feeds carry call data.
  'eventsSubscribe',
  'captionsSubscribe',
  'eventsUnsubscribe',
  'captionsTombstone',
  // Third slice (plan §8.3): typed service.invoke reaches owner infrastructure;
  // host.openScreen drives the surrounding app shell.
  'service',
  'openScreen',
  // Fourth slice: named host ceremonies (desktop pairing, whole-app reset) and
  // grant introspection — `can` merely REVEALS the app's declared grant config,
  // but imported code has no business reading even that.
  'ceremony',
  'can',
]);

/** Imported community code remains visual-only even if its iframe executes. */
export function isScreenSdkActionAllowed(trust: ScreenTrust, action: string): boolean {
  return trust === 'owner' || trust === 'verified' || !TRUSTED_ONLY_ACTIONS.has(action);
}

/**
 * Per-runtime SDK rate limiter. The iframe can loop arbitrarily; even though it can't reach the network
 * directly, it could spam the parent's SDK bridge. This caps calls per action over a rolling minute.
 * Returns true if the call is allowed.
 */
export function createSdkRateLimiter() {
  const calls: Record<string, number[]> = {};
  const caps: Record<string, number> = {
    submit: 30,
    records: 60,
    toast: 20,
    // Bridge v1: connector commands can reach real hardware and the relay
    // (which polls up to ~65s per command); updates hit the write API.
    connector: 30,
    updateRecord: 30,
    // Each call is itself batch-bounded (25 ids) — 10/min keeps a bounded
    // clear usable without opening a delete firehose.
    deleteRecords: 10,
    // Cross-form reads hit the app API; a live screen re-queries sibling forms
    // on a poll, so keep the same generous read budget as records().
    queryRecords: 60,
    presence: 30,
    // Subscription lifecycle is churn-bounded; the PUSH volume is budgeted
    // separately per subscription (screenSubscriptions.ts).
    eventsSubscribe: 20,
    captionsSubscribe: 10,
    eventsUnsubscribe: 40,
    captionsTombstone: 120,
    // service.invoke hits the app API (the server registry re-gates each op);
    // openScreen is user-visible navigation — spamming it would fight the user.
    service: 30,
    openScreen: 10,
    // Ceremonies open host consent surfaces (pairing prompt, reset dialog) —
    // a screen has no legitimate reason to raise them often.
    ceremony: 5,
    can: 120,
  };
  return (action: string): boolean => {
    const cap = caps[action] ?? 120;
    const now = Date.now();
    const arr = (calls[action] = (calls[action] || []).filter((t) => now - t < 60000));
    if (arr.length >= cap) return false;
    arr.push(now);
    return true;
  };
}
