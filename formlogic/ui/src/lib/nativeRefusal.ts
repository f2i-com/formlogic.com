/**
 * How a hosted SoftN app learns that FormLogic refused one of its backend requests.
 *
 * An app's own host answers a request over its limit with 429 `rate_limited` and this body
 * (SoftN's request worker, `config.server.requestsPerMinute`). FormLogic's own throttles refuse a
 * request before the app's backend runs: its limit on the native bridge for one member (or one
 * visitor's address), a native host with every worker busy, and more than four calls in flight
 * from one frame. They are answered the same way, so an app backs off for them as it already does
 * for its host's limit. They used to reach the app as a bare error, which SoftN's `net.fetch`
 * turns into a 503 with no code; only the message's wording told a busy moment apart from a real
 * failure.
 *
 * FormLogic's throttles also say how long to wait: `retryAfter`, in whole seconds, in the body.
 * The limit on the bridge is a token bucket, so it is a second or two, never the rest of a minute.
 * The app's own host limit (SoftN's) carries none.
 */
export const NATIVE_TOO_MANY_REQUESTS = { status: 429, body: { error: 'Too many requests.', code: 'rate_limited' } } as const;

/** A fifth call from one frame waits for one of the four in flight: about this long, in seconds. */
export const NATIVE_IN_FLIGHT_RETRY_SECONDS = 1;

type TooManyRequests = { status: 429; body: { error: 'Too many requests.'; code: 'rate_limited'; retryAfter?: number } };

/** FormLogic's 429 as the frame hands it to the app's page, with how long to wait when that is known. */
export function nativeTooManyRequests(retryAfter?: number): TooManyRequests {
  const wait = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter) : undefined;
  return { status: 429, body: { ...NATIVE_TOO_MANY_REQUESTS.body, ...(wait !== undefined ? { retryAfter: wait } : {}) } };
}

/** What the frame is answered for a refused `nativeRequest`: FormLogic's throttles as the host's 429, anything else as the error it was. */
export function nativeRefusal(result: { error?: string; status?: number; retryAfter?: number }): { result: TooManyRequests } | { error: string | undefined } {
  return result.status === 429 ? { result: nativeTooManyRequests(result.retryAfter) } : { error: result.error };
}
