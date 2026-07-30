import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  __resetOaiyDetectionForTests,
} from './oaiyRuntime';
import {
  __resetOaiyDetectionLoopForTests,
  getOaiyStatus,
  refreshOaiyStatus,
  subscribeOaiyStatus,
} from './oaiyDetection';

const BASE = 'http://127.0.0.1:19997';
const healthy = { status: 'ok', product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: '0.1.0' };

function mockHealth(resolver: () => { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const { status, body } = resolver();
      return new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

beforeEach(() => {
  __setOaiyBaseUrlForTests(BASE);
  __resetOaiyDetectionForTests();
  __resetOaiyDetectionLoopForTests();
});
afterEach(async () => {
  // Let any un-awaited immediate probe (started by subscribe) settle before reset,
  // so it cannot leak its result into the next test.
  await new Promise((r) => setTimeout(r, 0));
  __resetOaiyDetectionLoopForTests();
  __resetOaiyDetectionForTests();
  __resetOaiyBaseUrlForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('subscribeOaiyStatus', () => {
  it('calls the listener immediately with the current (pre-probe) status', () => {
    mockHealth(() => ({ status: 200, body: healthy }));
    const seen: boolean[] = [];
    const unsub = subscribeOaiyStatus((i) => seen.push(i.available));
    expect(seen[0]).toBe(false); // the cache is empty until a probe resolves
    unsub();
  });

  it('notifies when availability changes, and updates the shared status cache', async () => {
    mockHealth(() => ({ status: 200, body: healthy }));
    const seen: boolean[] = [];
    const unsub = subscribeOaiyStatus((i) => seen.push(i.available));
    await refreshOaiyStatus();
    expect(seen).toContain(true);
    expect(getOaiyStatus().available).toBe(true);
    unsub();
  });

  it('notifies only on a change, not on every probe', async () => {
    mockHealth(() => ({ status: 200, body: healthy }));
    const seen: boolean[] = [];
    const unsub = subscribeOaiyStatus((i) => seen.push(i.available));
    await refreshOaiyStatus(); // false → true : one notification
    await refreshOaiyStatus(); // true → true : silent
    expect(seen.filter((v) => v === true).length).toBe(1);
    unsub();
  });

  it('stops notifying a listener after it unsubscribes', async () => {
    mockHealth(() => ({ status: 200, body: healthy }));
    const seen: boolean[] = [];
    const unsub = subscribeOaiyStatus((i) => seen.push(i.available));
    unsub();
    seen.length = 0;
    await refreshOaiyStatus();
    expect(seen).toEqual([]);
  });
});
