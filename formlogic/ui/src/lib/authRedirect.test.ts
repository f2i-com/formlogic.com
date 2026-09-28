import { describe, expect, it } from 'vitest';
import { signInDestination } from './authRedirect';

describe('signInDestination', () => {
  it('keeps a same-origin path, query and all', () => {
    const consent = '/oauth/authorize?response_type=code&client_id=oaiy-desktop&state=xyz';
    expect(signInDestination(consent)).toBe(consent);
    expect(signInDestination('/accept-invite?token=abc')).toBe('/accept-invite?token=abc');
    expect(signInDestination('/forms')).toBe('/forms');
  });

  it('goes home when there is nowhere to go', () => {
    expect(signInDestination(null)).toBe('/');
    expect(signInDestination(undefined)).toBe('/');
    expect(signInDestination('')).toBe('/');
  });

  it('never leaves the origin', () => {
    expect(signInDestination('//evil.example/phish')).toBe('/');
    expect(signInDestination('/\\evil.example')).toBe('/');
    expect(signInDestination('https://evil.example/')).toBe('/');
    expect(signInDestination('javascript:alert(1)')).toBe('/');
  });

  it('refuses a sign-in page, which only sends a signed-in visitor on', () => {
    expect(signInDestination('/login?redirect=%2Foauth%2Fauthorize%3Fclient_id%3Dx')).toBe('/');
    expect(signInDestination('/login')).toBe('/');
    expect(signInDestination('/login/')).toBe('/');
    expect(signInDestination('/LOGIN?x=1')).toBe('/');
    expect(signInDestination('/signup?redirect=%2Fforms')).toBe('/');
    expect(signInDestination('/login-help')).toBe('/login-help');
  });
});
