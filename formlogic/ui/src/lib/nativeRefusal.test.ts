import { describe, expect, it } from 'vitest';
import { NATIVE_TOO_MANY_REQUESTS, nativeRefusal } from './nativeRefusal';

describe('nativeRefusal', () => {
  it('answers FormLogic throttling (HTTP 429) as the app host answers its own limit', () => {
    expect(nativeRefusal({ error: 'Too many requests. Please try again later.', status: 429 })).toEqual({ result: NATIVE_TOO_MANY_REQUESTS });
    expect(nativeRefusal({ error: 'The native host is busy. Try again shortly.', status: 429 })).toEqual({
      result: { status: 429, body: { error: 'Too many requests.', code: 'rate_limited' } },
    });
  });

  it('keeps every other refusal the error it was', () => {
    expect(nativeRefusal({ error: 'The app is busy. Try again shortly.', status: 409 })).toEqual({ error: 'The app is busy. Try again shortly.' });
    expect(nativeRefusal({ error: 'Not a member of this app', status: 403 })).toEqual({ error: 'Not a member of this app' });
    expect(nativeRefusal({ error: 'Network error' })).toEqual({ error: 'Network error' });
  });

  it('has the exact body of SoftN request-worker 429s, which apps match on', () => {
    expect(NATIVE_TOO_MANY_REQUESTS.body).toEqual({ error: 'Too many requests.', code: 'rate_limited' });
  });
});
