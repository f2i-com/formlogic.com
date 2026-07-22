// Offline-submit honesty tests (review 2026-07-22, blocker 6): the explicit
// accepted / queued / rejected outcome — never navigator.onLine, and a non-2xx
// is never claimed as accepted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifySubmitOutcome, swBackgroundSyncActive } from './swQueue';

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
