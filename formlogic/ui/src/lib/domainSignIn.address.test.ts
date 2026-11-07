// @vitest-environment jsdom
// Whether an app's own-domain page is at an address that is not FormLogic's: only there does the app
// take what the site's earlier SoftN page left (nativeAppStorage).
import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: {} }));

import { isAnotherAddress } from './domainSignIn';

const page = (url: string) => { const { origin, hostname } = new URL(url); return { origin, hostname }; };

describe('isAnotherAddress', () => {
  it('is a customer’s domain away from FormLogic', () => {
    expect(isAnotherAddress('https://formlogic.com', page('https://outerstead.com/'))).toBe(true);
    expect(isAnotherAddress('https://formlogic.com', page('https://www.outerstead.com/app'))).toBe(true);
  });

  it('is not FormLogic’s own address, however its address is written', () => {
    expect(isAnotherAddress('https://formlogic.com', page('https://formlogic.com/'))).toBe(false);
    expect(isAnotherAddress('https://FormLogic.com/', page('https://formlogic.com/'))).toBe(false);
    // A site in a folder: its origin is still this page's.
    expect(isAnotherAddress('https://example.com/formlogic', page('https://example.com/'))).toBe(false);
  });

  it('is never a local test address, whatever FormLogic’s address is', () => {
    expect(isAnotherAddress('http://127.0.0.1:8080', page('http://localhost:8080/?__flhost=outerstead.com'))).toBe(false);
    expect(isAnotherAddress('http://localhost:8080', page('http://127.0.0.1:8080/'))).toBe(false);
    expect(isAnotherAddress('https://formlogic.com', page('http://formlogic.local/'))).toBe(false);
    expect(isAnotherAddress('https://formlogic.com', page('http://[::1]:8080/'))).toBe(false);
  });

  it('is not anywhere when FormLogic’s address is missing or cannot be read', () => {
    expect(isAnotherAddress(null, page('https://outerstead.com/'))).toBe(false);
    expect(isAnotherAddress('not an address', page('https://outerstead.com/'))).toBe(false);
  });
});
