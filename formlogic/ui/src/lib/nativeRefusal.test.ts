import { describe, expect, it } from 'vitest';
import { NATIVE_IN_FLIGHT_RETRY_SECONDS, NATIVE_TOO_MANY_REQUESTS, nativeRefusal, nativeTooManyRequests } from './nativeRefusal';

describe('nativeRefusal', () => {
  it('answers FormLogic throttling (HTTP 429) as the app host answers its own limit', () => {
    expect(nativeRefusal({ error: 'Too many requests. Please try again later.', status: 429 })).toEqual({ result: NATIVE_TOO_MANY_REQUESTS });
    expect(nativeRefusal({ error: 'The native host is busy. Try again shortly.', status: 429 })).toEqual({
      result: { status: 429, body: { error: 'Too many requests.', code: 'rate_limited' } },
    });
  });

  it('hands the app\'s page how long to wait, in whole seconds, when FormLogic said', () => {
    // The limit on the bridge is a token bucket: the wait is for the next token.
    expect(nativeRefusal({ error: 'Too many requests. Please try again later.', status: 429, retryAfter: 1 })).toEqual({
      result: { status: 429, body: { error: 'Too many requests.', code: 'rate_limited', retryAfter: 1 } },
    });
    // Every worker busy.
    expect(nativeRefusal({ error: 'The native host is busy. Try again shortly.', status: 429, retryAfter: 2 })).toMatchObject({ result: { body: { retryAfter: 2 } } });
    expect(nativeTooManyRequests(1.2).body.retryAfter).toBe(2);
    expect(nativeTooManyRequests(0).body.retryAfter).toBe(0);
    // Nothing made up when it was not said, or was not a time.
    for (const none of [undefined, NaN, -1, Infinity]) expect(nativeTooManyRequests(none).body).toEqual(NATIVE_TOO_MANY_REQUESTS.body);
    // A fifth call from one frame, refused in the page itself.
    expect(nativeTooManyRequests(NATIVE_IN_FLIGHT_RETRY_SECONDS).body).toEqual({ error: 'Too many requests.', code: 'rate_limited', retryAfter: 1 });
  });

  it('keeps every other refusal the error it was', () => {
    expect(nativeRefusal({ error: 'The app is busy. Try again shortly.', status: 409 })).toEqual({ error: 'The app is busy. Try again shortly.' });
    expect(nativeRefusal({ error: 'Not a member of this app', status: 403 })).toEqual({ error: 'Not a member of this app' });
    expect(nativeRefusal({ error: 'Network error' })).toEqual({ error: 'Network error' });
    // A wait said with anything but a 429 is not a throttle.
    expect(nativeRefusal({ error: 'The app is busy. Try again shortly.', status: 409, retryAfter: 3 })).toEqual({ error: 'The app is busy. Try again shortly.' });
  });

  it('has the exact body of SoftN request-worker 429s, which apps match on', () => {
    expect(NATIVE_TOO_MANY_REQUESTS.body).toEqual({ error: 'Too many requests.', code: 'rate_limited' });
  });
});
