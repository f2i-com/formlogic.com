// @vitest-environment jsdom
// An app that asks for FormLogic's visitors (its manifest's formlogicAi or formlogicPayments): this
// page marks its requests, so the browser's HttpOnly visitor cookie counts, and every other app's
// requests are sent exactly as before. And what such an app asks, said before it is installed.
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { formlogicAsks } from './nativeHosting';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { status: 200, body: {} } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const headersOf = (fetchMock: ReturnType<typeof vi.fn>): Record<string, string> =>
  ((fetchMock.mock.calls[0][1] as { headers?: Record<string, string> }).headers) ?? {};

it('marks a request from an app that asks for visitors, beside the engine it claims', async () => {
  const fetchMock = stubFetch();
  await api.runNativeRequest('logos', { path: '/api/jobs' }, undefined, 'zipp-web-python;r1', true);
  expect(headersOf(fetchMock)['X-FormLogic-Visitor']).toBe('1');
  expect(headersOf(fetchMock)['X-FormLogic-Client-Engine']).toBe('zipp-web-python;r1');
  expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
});

it('sends every other app\'s request exactly as before, with no marker', async () => {
  const fetchMock = stubFetch();
  await api.runNativeRequest('cafe', { path: '/api/me' });
  expect(Object.keys(headersOf(fetchMock))).not.toContain('X-FormLogic-Visitor');
  const second = stubFetch();
  await api.runNativeRequest('cafe', { path: '/api/me' }, undefined, 'zipp-web-python;r1', false);
  expect(Object.keys(headersOf(second))).not.toContain('X-FormLogic-Visitor');
});

const project = (manifest: Record<string, unknown>) => ({ files: { 'manifest.json': JSON.stringify(manifest) } });

it('says what an app asks of FormLogic before it is installed', () => {
  const asks = formlogicAsks(project({
    name: 'Logos',
    formlogicAi: { uses: ['pictures', 'picture-edits', 'chat'], purpose: 'Draws logos from a short brief.', jobs: { table: 'ai_jobs', deliver: '/api/site/ai/deliver' } },
    formlogicPayments: { purpose: 'Pay 5¢ to download a logo.', items: [{ id: 'download', label: 'Download a logo', priceCents: 5 }], routes: ['/api/download'] },
  }));
  expect(asks).toEqual([
    'Uses AI for pictures, picture edits and chat, once you choose where its AI comes from: Draws logos from a short brief.',
    'Takes payments from its visitors\' prepaid balance: Download a logo (5¢). Pay 5¢ to download a logo.',
  ]);
});

it('says nothing for an app that asks nothing of FormLogic, or whose manifest cannot be read', () => {
  expect(formlogicAsks(project({ name: 'Cafe' }))).toEqual([]);
  expect(formlogicAsks({ files: { 'manifest.json': '{not json' } })).toEqual([]);
});
