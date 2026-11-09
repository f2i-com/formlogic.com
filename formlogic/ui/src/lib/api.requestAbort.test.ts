import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

// A hosted app's frame aborts the requests it has out when it is torn down (a reload or a
// navigation). The request helpers report that as a transport failure, as before, but it is
// not an error, so it must not land in the console as one: a reload during a hosted app's
// periodic refresh printed "API request failed: AbortError: signal is aborted without reason".

type Helpers = {
  request: (endpoint: string, options?: RequestInit) => Promise<{ error?: string; transportFailure?: true }>;
  requestWithMeta: (endpoint: string, options?: RequestInit) => Promise<{ ok: boolean; networkError?: string }>;
};
const helpers = api as unknown as Helpers;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api request helpers — a request that throws', () => {
  it('reports an aborted request without logging an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('signal is aborted without reason', 'AbortError')));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await helpers.request('/apps');
    expect(result.transportFailure).toBe(true);
    expect(result.error).toBe('signal is aborted without reason');
    const meta = await helpers.requestWithMeta('/apps');
    expect(meta.ok).toBe(false);
    expect(meta.networkError).toBe('signal is aborted without reason');

    expect(errors).not.toHaveBeenCalled();
  });

  it('still logs a request that failed for any other reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await helpers.request('/apps');
    expect(result).toMatchObject({ error: 'Failed to fetch', transportFailure: true });
    expect(errors).toHaveBeenCalledWith('API request failed:', expect.any(TypeError));
  });
});
