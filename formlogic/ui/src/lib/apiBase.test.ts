import { describe, expect, it } from 'vitest';
import { joinBackendApiUrl, resolveBackendApiUrl } from './apiBase';

describe('resolveBackendApiUrl', () => {
  it('supports a split-domain API base', () => {
    expect(joinBackendApiUrl('http://api.formlogic.local/api/', '/app/aokie/connector-capability')).toBe(
      'http://api.formlogic.local/api/app/aokie/connector-capability'
    );
  });

  it('normalizes a missing endpoint slash', () => {
    expect(resolveBackendApiUrl('health')).toBe(
      `${(import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '')}/health`
    );
  });
});
