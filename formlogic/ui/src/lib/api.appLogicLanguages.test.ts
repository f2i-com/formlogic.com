// formlogic-python/1: the app runtime reads its app-logic scripts from GET /api/app/{slug} (app
// level) and GET /api/app/{slug}/forms/{formId} (form level). The server lists only the scripts
// in the languages the client names in ?languages=; a tab on a bundle from before Python names
// none and never receives a Python script, which it would run as JavaScript. This client runs
// both, so it must say so on both reads.
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  const input = fetchMock.mock.calls[0][0] as string | URL | Request;
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(href, 'http://localhost');
}

it('the app runtime config asks for JavaScript and Python scripts', async () => {
  const fetchMock = stubFetch({ app: {}, forms: [], user: {}, permissions: {} });
  await api.getAppRuntime('my-app');
  const url = requestedUrl(fetchMock);
  expect(url.pathname).toMatch(/\/app\/my-app$/);
  expect(url.searchParams.get('languages')).toBe('javascript,python');
});

it('the runtime form read asks for JavaScript and Python scripts', async () => {
  const fetchMock = stubFetch({ form: {} });
  await api.getAppForm('my-app', 'form-1');
  const url = requestedUrl(fetchMock);
  expect(url.pathname).toMatch(/\/app\/my-app\/forms\/form-1$/);
  expect(url.searchParams.get('languages')).toBe('javascript,python');
});
