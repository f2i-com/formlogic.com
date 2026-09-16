// @vitest-environment jsdom
// The engine a hosted frame claims on an action, and the one refusal it must be able to tell apart.
//
// The server re-decides the engine for every action and answers 409 engine_changed when its answer
// has moved on since the page was mounted. That is a remount, not a failure the person should read,
// so the client has to see the typed code — a status alone cannot tell it from any other conflict.
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const headersOf = (fetchMock: ReturnType<typeof vi.fn>): Record<string, string> =>
  (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;

it('a hosted action carries the engine decision its frame was mounted with', async () => {
  const fetchMock = stubFetch({ result: 1 });
  await api.runHostedAction('notes', 'save', {}, undefined, 'zipp-web-python;r1');
  expect(headersOf(fetchMock)['X-FormLogic-Client-Engine']).toBe('zipp-web-python;r1');
});

it('a native request carries it too', async () => {
  const fetchMock = stubFetch({ result: { status: 200, body: {} } });
  await api.runNativeRequest('notes', { path: '/x' }, undefined, 'zipp-web-python;r1');
  expect(headersOf(fetchMock)['X-FormLogic-Client-Engine']).toBe('zipp-web-python;r1');
});

it('a frame with no decision claims none, exactly as every page did before', async () => {
  const fetchMock = stubFetch({ result: 1 });
  await api.runHostedAction('notes', 'save', {});
  expect(Object.keys(headersOf(fetchMock))).not.toContain('X-FormLogic-Client-Engine');
});

it('surfaces the typed code of a refusal, so engine_changed is not read as a lost edit', async () => {
  stubFetch({ error: true, code: 'engine_changed', message: 'This app is now set to run on a different engine. Reload to continue.' }, 409);
  const result = await api.runHostedAction('notes', 'save', {}, undefined, 'host-js;r1');
  expect(result.status).toBe(409);
  expect(result.code).toBe('engine_changed');
  expect(result.error).toContain('different engine');
});

it('leaves an untyped failure untyped', async () => {
  stubFetch({ error: true, message: 'Someone else saved first' }, 409);
  const result = await api.runHostedAction('notes', 'save', {});
  expect(result.status).toBe(409);
  expect(result.code).toBeUndefined();
});
