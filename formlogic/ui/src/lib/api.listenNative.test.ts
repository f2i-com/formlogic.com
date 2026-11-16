// @vitest-environment jsdom
// What a person said to a native app, sent to the site's speech server for its words (POST
// /api/app/{slug}/native/listen): the recording in base64 and nothing else, marked as the app's
// requests are, and the server's answer or refusal as the page that listened reads it.
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200, headers: Record<string, string> = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];

it('posts the recording to the app\'s listen route and answers with the words', async () => {
  const fetchMock = stubFetch({ data: { text: 'hello there', seconds: 1.4 } });
  const controller = new AbortController();
  expect(await api.listenNative('narrator', 'UklGRg==', controller.signal)).toEqual({ data: { text: 'hello there', seconds: 1.4 } });
  const [url, options] = sent(fetchMock);
  expect(url.endsWith('/app/narrator/native/listen')).toBe(true);
  expect(options.method).toBe('POST');
  expect(options.body).toBe(JSON.stringify({ audio: 'UklGRg==' }));
  expect(options.signal).toBe(controller.signal);
  expect(options.credentials).toBe('include');
  expect(Object.keys(options.headers)).not.toContain('X-FormLogic-Visitor');
});

it('marks it for an app that asks for visitors, as that app\'s requests are marked', async () => {
  const fetchMock = stubFetch({ data: { text: 'hi', seconds: 1 } });
  await api.listenNative('logos', 'UklGRg==', undefined, true);
  expect(sent(fetchMock)[1].headers['X-FormLogic-Visitor']).toBe('1');
  const unmarked = stubFetch({ data: { text: 'hi', seconds: 1 } });
  await api.listenNative('cafe', 'UklGRg==', undefined, false);
  expect(Object.keys(sent(unmarked)[1].headers)).not.toContain('X-FormLogic-Visitor');
});

it('keeps a slug in its own part of the address', async () => {
  const fetchMock = stubFetch({ data: { text: 'hi', seconds: 1 } });
  await api.listenNative('a/b?c', 'UklGRg==');
  expect(sent(fetchMock)[0].endsWith('/app/a%2Fb%3Fc/native/listen')).toBe(true);
});

it('answers a refusal with its status and code, and too many with how long to wait', async () => {
  stubFetch({ error: true, code: 'listen_off', message: 'Listening is not turned on for this app.' }, 403);
  expect(await api.listenNative('narrator', 'UklGRg==')).toMatchObject({ error: 'Listening is not turned on for this app.', status: 403, code: 'listen_off' });
  stubFetch({ error: true, code: 'too_long', message: 'That recording is too long.' }, 413);
  expect(await api.listenNative('narrator', 'UklGRg==')).toMatchObject({ status: 413, code: 'too_long' });
  stubFetch({ error: true, message: 'Too many requests. Please try again later.' }, 429, { 'Retry-After': '3' });
  const limited = await api.listenNative('narrator', 'UklGRg==');
  expect(limited).toMatchObject({ status: 429, retryAfter: 3 });
  expect(limited.data).toBeUndefined();
});

it('reads an answer that is not the words as no answer', async () => {
  stubFetch({ text: 'hello there', seconds: 1 });
  const result = await api.listenNative('narrator', 'UklGRg==');
  expect(result.data).toBeUndefined();
  expect(result.error).toBeTruthy();
});
