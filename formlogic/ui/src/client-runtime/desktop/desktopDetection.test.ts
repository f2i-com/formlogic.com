import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __getConsecutiveFailuresForTests,
  __resetDesktopDetectionForTests,
  getDesktopInfo,
  refreshDesktopStatus,
  subscribeDesktopStatus,
} from './desktopDetection';
import { DESKTOP_BASE_URL, DESKTOP_BASE_URL_CANDIDATES } from './desktopTypes';

// FormLogic Desktop detection: accepts BOTH companion ids (contract §1), never throws on
// network failure, and backs off from 10s to 30s polling after repeated failures.

type FetchMock = ReturnType<typeof vi.fn>;

function healthResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response);
}

function setFetch(mock: FetchMock): FetchMock {
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

afterEach(() => {
  __resetDesktopDetectionForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('desktop detection', () => {
  it('accepts companion "formlogic-desktop" and captures versions', async () => {
    setFetch(
      vi.fn(() =>
        healthResponse({
          status: 'ok',
          companion: 'formlogic-desktop',
          legacyCompanion: 'formlogic-desktop',
          version: '1.2.3',
          apiVersion: 1,
          pluginApiVersion: 1,
        })
      )
    );

    const info = await refreshDesktopStatus();

    expect(info.available).toBe(true);
    expect(info.companion).toBe('formlogic-desktop');
    expect(info.version).toBe('1.2.3');
    expect(info.apiVersion).toBe(1);
    expect(info.pluginApiVersion).toBe(1);
    expect(info.baseUrl).toBe(DESKTOP_BASE_URL);
  });

  it('rejects the retired legacy companion id "f2i-companion"', async () => {
    setFetch(vi.fn(() => healthResponse({ status: 'ok', companion: 'f2i-companion', version: '0.9.0' })));

    const info = await refreshDesktopStatus();

    expect(info.available).toBe(false);
  });

  it('rejects an unrecognised companion id (some other localhost service)', async () => {
    setFetch(vi.fn(() => healthResponse({ status: 'ok', companion: 'other-tool', version: '3.0.0' })));

    const info = await refreshDesktopStatus();

    expect(info.available).toBe(false);
    expect(info.companion).toBeUndefined();
  });

  it('never throws on network failure — publishes unavailable instead', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const info = await refreshDesktopStatus();

    expect(info.available).toBe(false);
    expect(getDesktopInfo().available).toBe(false);
  });

  it('starts polling on first subscribe, backs off to 30s after 3 consecutive failures, and stops on unsubscribe', async () => {
    vi.useFakeTimers();
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    // A POLL is one pass over the candidate bases, not one request: with no
    // desktop anywhere, each poll tries every supported runtime's port before
    // concluding there is none. Counting requests rather than polls would make
    // this test fail purely because a second runtime became supported.
    const perPoll = DESKTOP_BASE_URL_CANDIDATES.length;

    const unsubscribe = subscribeDesktopStatus(() => {});
    await vi.advanceTimersByTimeAsync(0); // initial immediate probe settles
    expect(fetchMock).toHaveBeenCalledTimes(perPoll);

    // Failures 2 and 3 arrive on the fast 10s cadence.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2 * perPoll);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3 * perPoll);
    // Still THREE failures, not three-times-the-candidates: a poll that found
    // nothing anywhere is one failure, or the backoff would trip early.
    expect(__getConsecutiveFailuresForTests()).toBe(3);

    // Backed off: 10s passes with NO probe; the next one fires at 30s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3 * perPoll);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(4 * perPoll);

    // Last unsubscribe stops the loop entirely.
    unsubscribe();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(4 * perPoll);
  });

  it('finds a desktop on a non-default port and then stops walking the list', async () => {
    // The bug this fixes: OAIY Desktop serves the same loopback contract on its
    // own port, and a fixed base meant a user running it was told there was no
    // desktop at all. Once found, the base is pinned so a settled setup costs
    // one request per poll.
    vi.useFakeTimers();
    const [first, second] = DESKTOP_BASE_URL_CANDIDATES;
    const fetchMock = setFetch(
      vi.fn((url: string) =>
        url.startsWith(second)
          ? Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ status: 'ok', companion: 'oaiy-desktop', version: '0.1.0' }),
            })
          : Promise.reject(new Error('ECONNREFUSED')),
      ),
    );

    let seen: unknown = null;
    const unsubscribe = subscribeDesktopStatus((info) => {
      seen = info;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toMatchObject({ available: true, companion: 'oaiy-desktop', baseUrl: second });
    expect(fetchMock).toHaveBeenCalledTimes(2); // tried the default, then found it
    expect(fetchMock.mock.calls[0][0]).toContain(first);

    // Pinned: the next poll goes straight to the runtime that answered.
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain(second);

    unsubscribe();
  });

  it('recovering resets the failure count (poll returns to the fast cadence)', async () => {
    vi.useFakeTimers();
    let fail = true;
    const fetchMock = setFetch(
      vi.fn(() =>
        fail
          ? Promise.reject(new Error('ECONNREFUSED'))
          : healthResponse({ status: 'ok', companion: 'formlogic-desktop', version: '1.0.0' })
      )
    );

    const unsubscribe = subscribeDesktopStatus(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(__getConsecutiveFailuresForTests()).toBe(3);

    fail = false;
    await vi.advanceTimersByTimeAsync(30_000); // backed-off probe succeeds
    expect(__getConsecutiveFailuresForTests()).toBe(0);
    expect(getDesktopInfo().available).toBe(true);

    // Back on the fast cadence.
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(calls + 1);

    unsubscribe();
  });

  it('notifies subscribers only on state change, with the current status replayed on subscribe', async () => {
    setFetch(vi.fn(() => healthResponse({ status: 'ok', companion: 'formlogic-desktop', version: '1.0.0' })));
    const seen: boolean[] = [];
    const unsubscribe = subscribeDesktopStatus((info) => seen.push(info.available));

    // Initial replay (unavailable), then the flip to available from the first probe.
    await refreshDesktopStatus();
    await refreshDesktopStatus(); // identical result — must NOT re-notify

    expect(seen).toEqual([false, true]);
    unsubscribe();
  });
});
