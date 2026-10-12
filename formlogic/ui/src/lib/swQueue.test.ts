// Offline-submit honesty tests (review 2026-07-22, blocker 6): the explicit
// accepted / queued / rejected outcome — never navigator.onLine, and a non-2xx
// is never claimed as accepted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifySubmitOutcome, submitResultFromApi, swBackgroundSyncActive } from './swQueue';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifySubmitOutcome', () => {
  it('accepted: any 2xx server answer', async () => {
    await expect(classifySubmitOutcome({ ok: true, status: 200 })).resolves.toBe('accepted');
    await expect(classifySubmitOutcome({ ok: true, status: 201 })).resolves.toBe('accepted');
  });

  it('rejected: a definitive server refusal (typed or not)', async () => {
    await expect(classifySubmitOutcome({ ok: false, status: 400 })).resolves.toBe('rejected');
    await expect(classifySubmitOutcome({ ok: false, status: 409 })).resolves.toBe('rejected');
    await expect(classifySubmitOutcome({ ok: false, status: 500 })).resolves.toBe('rejected');
  });

  it('rejected: a network failure with NO service worker to queue the request', async () => {
    // node has no navigator.serviceWorker — nothing could have captured the POST.
    await expect(classifySubmitOutcome({ ok: false, status: 0, networkError: 'Failed to fetch' }))
      .resolves.toBe('rejected');
  });

  it('rejected: a network failure with a service worker present but NOT controlling the page', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: null,
        getRegistration: async () => ({ sync: {} }),
      },
    });
    await expect(classifySubmitOutcome({ ok: false, status: 0, networkError: 'Failed to fetch' }))
      .resolves.toBe('rejected');
  });

  it('rejected: a controlling service worker WITHOUT BackgroundSync support', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {},
        getRegistration: async () => ({}), // no 'sync' — the queue can't exist
      },
    });
    await expect(classifySubmitOutcome({ ok: false, status: 0, networkError: 'Failed to fetch' }))
      .resolves.toBe('rejected');
  });

  it('queued: a network failure with a controlling SW and BackgroundSync registered', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {},
        getRegistration: async () => ({ sync: {} }),
      },
    });
    await expect(classifySubmitOutcome({ ok: false, status: 0, networkError: 'Failed to fetch' }))
      .resolves.toBe('queued');
  });
});

describe('swBackgroundSyncActive', () => {
  it('is false without a service worker and false when getRegistration throws', async () => {
    await expect(swBackgroundSyncActive()).resolves.toBe(false);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {},
        getRegistration: async () => { throw new Error('denied'); },
      },
    });
    await expect(swBackgroundSyncActive()).resolves.toBe(false);
  });
});

// The plain form's submit goes through api.request(), which gives no status for a failed
// connection AND for a 2xx page that is not JSON. Only the first is a request the service worker
// can have queued: a captive portal's 200 page reached the page, so nothing was queued to replay.
describe('submitResultFromApi', () => {
  const syncing = () => vi.stubGlobal('navigator', {
    serviceWorker: { controller: {}, getRegistration: async () => ({ sync: {} }) },
  });

  it('reads a failed connection as a network failure, which a syncing service worker queued', async () => {
    syncing();
    const input = submitResultFromApi({ error: 'Failed to fetch' });
    expect(input).toEqual({ ok: false, status: 0, networkError: 'Failed to fetch' });
    await expect(classifySubmitOutcome(input)).resolves.toBe('queued');
  });

  it('reads a 2xx page that is not JSON as not sent and not queued, so the answers stay', async () => {
    syncing();
    const input = submitResultFromApi({ error: 'Invalid response from server', unreadable: true });
    expect(input.networkError).toBeUndefined();
    await expect(classifySubmitOutcome(input)).resolves.toBe('rejected');
  });

  it('reads a server refusal as rejected and a stored submission as accepted', async () => {
    await expect(classifySubmitOutcome(submitResultFromApi({ error: 'Closed', status: 403 }))).resolves.toBe('rejected');
    await expect(classifySubmitOutcome(submitResultFromApi({}))).resolves.toBe('accepted');
  });
});
