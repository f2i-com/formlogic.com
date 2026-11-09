/**
 * How a hosted SoftN app learns that FormLogic refused one of its backend requests.
 *
 * An app's own host answers a request over its limit with 429 `rate_limited` and this body
 * (SoftN's request worker, `config.server.requestsPerMinute`). FormLogic's own throttles refuse a
 * request before the app's backend runs: its per-member limit on the native bridge, a native host
 * with every worker busy, and more than four calls in flight from one frame. They are answered the
 * same way, so an app backs off for them as it already does for its host's limit. They used to reach
 * the app as a bare error, which SoftN's `net.fetch` turns into a 503 with no code; only the message's
 * wording told a busy moment apart from a real failure.
 */
export const NATIVE_TOO_MANY_REQUESTS = { status: 429, body: { error: 'Too many requests.', code: 'rate_limited' } } as const;

/** What the frame is answered for a refused `nativeRequest`: FormLogic's throttles as the host's 429, anything else as the error it was. */
export function nativeRefusal(result: { error?: string; status?: number }): { result: typeof NATIVE_TOO_MANY_REQUESTS } | { error: string | undefined } {
  return result.status === 429 ? { result: NATIVE_TOO_MANY_REQUESTS } : { error: result.error };
}
