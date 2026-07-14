import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

// Review item #8: the custom-domain discovery manifest lives at the DOMAIN ROOT
// (/.well-known/formlogic-app.json — served by the backend via the deploy's .htaccess rewrite),
// NOT under the /api prefix. api.getWellKnownManifest therefore bypasses the baseUrl-prefixed
// request() helper and issues a raw same-origin root-path fetch. These tests pin:
//   1. the EXACT URL (a regression to `${baseUrl}/...` would 404 or hit the wrong origin), and
//   2. the ApiResponse fallback contract useAppManifest relies on — every failure mode
//      (404 off-domain, SPA index.html fallback, non-manifest JSON, network error) must
//      flatten to { error } (never throw, never return data) so the hook falls back to the
//      platform slug route.

const SIGNED = { payload: { appId: 'a1', domain: 'forms.example.com' }, signature: 'c2ln', alg: 'Ed25519', keyId: 'k1' };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.getWellKnownManifest — URL routing', () => {
  it('GETs the ROOT well-known path, never the /api-prefixed base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SIGNED));
    vi.stubGlobal('fetch', fetchMock);

    await api.getWellKnownManifest();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('/.well-known/formlogic-app.json');
    // The api client's baseUrl defaults to '/api' — the well-known path must NOT go through it.
    expect(url.startsWith('/api')).toBe(false);
  });

  it('sends a same-origin relative path (no absolute origin baked in)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SIGNED));
    vi.stubGlobal('fetch', fetchMock);

    await api.getWellKnownManifest();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('/')).toBe(true);
    expect(url.includes('://')).toBe(false);
  });
});

describe('api.getWellKnownManifest — response contract', () => {
  it('returns the signed envelope as data on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(SIGNED)));

    const res = await api.getWellKnownManifest();

    expect(res.error).toBeUndefined();
    expect(res.data).toEqual(SIGNED);
  });

  it('flattens a 404 (host is not a connected custom domain) to an error result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: true, message: 'Not found' }, 404))
    );

    const res = await api.getWellKnownManifest();

    expect(res.data).toBeUndefined();
    expect(res.error).toBe('Not found');
  });

  it('flattens a non-JSON 200 body (SPA index.html fallback) to an error result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response)
    );

    const res = await api.getWellKnownManifest();

    expect(res.data).toBeUndefined();
    expect(typeof res.error).toBe('string');
  });

  it('rejects a 200 JSON body that is not a signed manifest envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' })));

    const res = await api.getWellKnownManifest();

    expect(res.data).toBeUndefined();
    expect(typeof res.error).toBe('string');
  });

  it('flattens a network failure to an error result (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const res = await api.getWellKnownManifest();

    expect(res.data).toBeUndefined();
    expect(res.error).toBe('Failed to fetch');
  });
});
