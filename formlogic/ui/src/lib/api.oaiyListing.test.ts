// @vitest-environment jsdom
// A computer's listings (OaiyComputerController): asked once, answered 202 with a handle, then read
// back with it until the list comes. No request waits on the computer, so none holds the server's
// one PHP worker while it answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, LISTING_POLL_MS, LISTING_WAIT_MS } from './api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const HANDLE = '0f1e2d3c-4b5a-4968-8776-655443322110.00112233445566778899aabbccddeeff';
const MODELS = { models: [{ id: 'model-a', name: 'Model A', type: 'image' }] };
const asked = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));

describe('a computer\'s listing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is asked once, then read with its handle every 750 ms until the list comes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ listing: HANDLE }, 202))
      .mockResolvedValueOnce(json({ listing: HANDLE }, 202))
      .mockResolvedValueOnce(json(MODELS));
    vi.stubGlobal('fetch', fetchMock);

    const result = api.getAppAiModels('app-1', 'dc-1', 'oaiy-engine');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LISTING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LISTING_POLL_MS);

    expect(await result).toEqual({ data: MODELS });
    const urls = asked(fetchMock);
    expect(urls.map((url) => url.pathname)).toEqual(Array(3).fill('/api/apps/app-1/ai/models'));
    expect(urls[0].searchParams.get('listing')).toBeNull();
    expect(urls.slice(1).map((url) => url.searchParams.get('listing'))).toEqual([HANDLE, HANDLE]);
    expect(urls.every((url) => url.searchParams.get('connectionId') === 'dc-1' && url.searchParams.get('providerId') === 'oaiy-engine')).toBe(true);
  });

  it('takes the list at once from a server that answers it at once', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ providers: [], engineProvider: 'oaiy-engine' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.adminOaiyProviders('dc-1')).toEqual({ data: { providers: [], engineProvider: 'oaiy-engine' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(asked(fetchMock)[0].pathname).toBe('/api/admin/oaiy/providers');
  });

  it('says what the server says when the computer fails, and asks no more', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ listing: HANDLE }, 202))
      .mockResolvedValueOnce(json({ error: true, message: 'That computer did not answer: That computer took too long to answer.' }, 502));
    vi.stubGlobal('fetch', fetchMock);
    const result = api.adminOaiyModels('dc-1', 'oaiy-engine');
    await vi.advanceTimersByTimeAsync(LISTING_POLL_MS);
    expect(await result).toMatchObject({ status: 502, error: 'That computer did not answer: That computer took too long to answer.' });
    await vi.advanceTimersByTimeAsync(5 * LISTING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /** The one request after a listing is given up: its handle with `letGo=1`, sent with keepalive (it goes as the page closes too). */
  const lettingGo = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => new URL(String(url), 'http://localhost').searchParams.get('letGo') === '1');

  it('stops after about 22 seconds whatever the server says, and lets the listing go', async () => {
    const fetchMock = vi.fn(async () => json({ listing: HANDLE }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const result = api.getAppAiProviders('app-1', 'dc-1');
    await vi.advanceTimersByTimeAsync(LISTING_WAIT_MS + LISTING_POLL_MS);
    expect(await result).toEqual({ error: 'The computer did not send the list in time. Try again.' });
    const letGo = lettingGo(fetchMock);
    expect(letGo).toHaveLength(1);
    expect(new URL(String(letGo[0][0]), 'http://localhost').searchParams.get('listing')).toBe(HANDLE);
    expect((letGo[0][1] as RequestInit).keepalive).toBe(true);
    expect(fetchMock.mock.calls.length - 1).toBeLessThanOrEqual(Math.ceil(LISTING_WAIT_MS / LISTING_POLL_MS) + 1);
  });

  it('stops reading at once when nobody waits for the list any more, and lets the listing go', async () => {
    const fetchMock = vi.fn(async () => json({ listing: HANDLE }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const unwanted = new AbortController();
    const result = api.adminOaiyModels('dc-1', 'oaiy-engine', unwanted.signal);
    await vi.advanceTimersByTimeAsync(LISTING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unwanted.abort();
    expect(await result).toEqual({ error: 'The list was not asked for any more.' });
    await vi.advanceTimersByTimeAsync(10 * LISTING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const letGo = lettingGo(fetchMock);
    expect(letGo).toHaveLength(1);
    expect(new URL(String(letGo[0][0]), 'http://localhost').pathname).toBe('/api/admin/oaiy/models');
    expect((letGo[0][1] as RequestInit).keepalive).toBe(true);
  });

  it('lets nothing go when the list was never asked for', async () => {
    const fetchMock = vi.fn(async () => json({ listing: HANDLE }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const unwanted = new AbortController();
    unwanted.abort();
    expect(await api.adminOaiyModels('dc-1', 'oaiy-engine', unwanted.signal)).toEqual({ error: 'The list was not asked for any more.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a turn with keepalive, so it is sent as the page closes', async () => {
    const fetchMock = vi.fn(async () => json({ cancelled: true }));
    vi.stubGlobal('fetch', fetchMock);
    await api.cancelDesktopAiRequest('req-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url, 'http://localhost').pathname).toBe('/api/desktop/ai/requests/req-1/cancel');
    expect([init.method, init.keepalive]).toEqual(['POST', true]);
  });
});
