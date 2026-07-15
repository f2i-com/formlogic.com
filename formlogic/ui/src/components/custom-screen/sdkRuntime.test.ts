import { describe, expect, it } from 'vitest';
import { SCREEN_CSP, isScreenSdkActionAllowed } from './sdkRuntime';

describe('custom-screen SDK trust boundary', () => {
  it('makes untrusted imported code visual-only', () => {
    for (const action of ['submit', 'records', 'currentUser', 'record', 'related', 'navigate', 'openForm', 'openRecords']) {
      expect(isScreenSdkActionAllowed('untrusted', action), action).toBe(false);
    }
    expect(isScreenSdkActionAllowed('untrusted', 'context')).toBe(true);
    expect(isScreenSdkActionAllowed('untrusted', 'toast')).toBe(true);
  });

  it('keeps owner and server-verified screens functional', () => {
    for (const trust of ['owner', 'verified'] as const) {
      expect(isScreenSdkActionAllowed(trust, 'records')).toBe(true);
      expect(isScreenSdkActionAllowed(trust, 'submit')).toBe(true);
    }
  });

  it('fails closed when legacy screen trust metadata is absent', () => {
    expect(isScreenSdkActionAllowed(undefined, 'records')).toBe(false);
    expect(isScreenSdkActionAllowed(undefined, 'currentUser')).toBe(false);
    expect(isScreenSdkActionAllowed(undefined, 'context')).toBe(true);
  });

  it('blocks direct network and frame egress in the iframe CSP', () => {
    expect(SCREEN_CSP).toContain("connect-src 'none'");
    expect(SCREEN_CSP).toContain("frame-src 'none'");
    expect(SCREEN_CSP).toContain("form-action 'none'");
    expect(SCREEN_CSP).toContain("navigate-to 'none'");
  });
});
