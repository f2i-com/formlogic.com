import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  getOaiyToken,
  setOaiyToken,
} from './oaiyRuntime';
import { pairWithOaiy, pollOaiyPairing, requestOaiyPairing } from './oaiyPairing';

const BASE = 'http://127.0.0.1:19998';

function scriptFetch(steps: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  __setOaiyBaseUrlForTests(BASE);
  setOaiyToken(null);
});
afterEach(() => {
  __resetOaiyBaseUrlForTests();
  setOaiyToken(null);
  vi.unstubAllGlobals();
});

describe('requestOaiyPairing', () => {
  it('returns the pairingId + code', async () => {
    scriptFetch([{ status: 201, body: { pairingId: 'pair_1', code: 'ABC234' } }]);
    const h = await requestOaiyPairing('formlogic', 'Acme');
    expect(h).toEqual({ pairingId: 'pair_1', code: 'ABC234' });
  });

  it('throws on a malformed response', async () => {
    scriptFetch([{ status: 201, body: { nope: true } }]);
    await expect(requestOaiyPairing('formlogic')).rejects.toThrow(/malformed/);
  });
});

describe('pollOaiyPairing', () => {
  it('returns pending with no token', async () => {
    scriptFetch([{ status: 200, body: { status: 'pending', token: null } }]);
    expect(await pollOaiyPairing('pair_1')).toEqual({ state: 'pending' });
    expect(getOaiyToken()).toBeNull();
  });

  it('stores + returns the token on approval', async () => {
    scriptFetch([{ status: 200, body: { status: 'approved', token: 'oaiypat_xyz' } }]);
    const res = await pollOaiyPairing('pair_1');
    expect(res).toEqual({ state: 'approved', token: 'oaiypat_xyz' });
    expect(getOaiyToken()).toBe('oaiypat_xyz'); // side effect: stored for later calls
  });

  it('reports expired on a 404', async () => {
    scriptFetch([{ status: 404, body: { error: {} } }]);
    expect(await pollOaiyPairing('gone')).toEqual({ state: 'expired' });
  });

  it('treats a transport blip as still pending, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await pollOaiyPairing('pair_1')).toEqual({ state: 'pending' });
  });
});

describe('pairWithOaiy — the whole flow', () => {
  it('raises, surfaces the code, polls to approval, stores the token', async () => {
    scriptFetch([
      { status: 201, body: { pairingId: 'pair_1', code: 'ZZ9922' } }, // request
      { status: 200, body: { status: 'pending' } }, // poll 1
      { status: 200, body: { status: 'approved', token: 'oaiypat_ok' } }, // poll 2
    ]);
    let shownCode: string | undefined;
    const res = await pairWithOaiy('formlogic', 'Acme', {
      onPending: (h) => { shownCode = h.code; },
    });
    expect(shownCode).toBe('ZZ9922');
    expect(res).toEqual({ state: 'approved', token: 'oaiypat_ok' });
    expect(getOaiyToken()).toBe('oaiypat_ok');
  });

  it('resolves denied when the user declines', async () => {
    scriptFetch([
      { status: 201, body: { pairingId: 'pair_1', code: 'AAAA22' } },
      { status: 200, body: { status: 'denied' } },
    ]);
    const res = await pairWithOaiy('formlogic', undefined);
    expect(res.state).toBe('denied');
    expect(getOaiyToken()).toBeNull();
  });

  it('resolves expired immediately when the signal is already aborted', async () => {
    scriptFetch([{ status: 201, body: { pairingId: 'pair_1', code: 'BBBB22' } }]);
    const ac = new AbortController();
    ac.abort();
    const res = await pairWithOaiy('formlogic', undefined, { signal: ac.signal });
    expect(res.state).toBe('expired');
  });

  describe('how long it waits for the person', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    /** OAIY, answering each poll with what `poll` says the request's state is then. */
    function oaiy(poll: () => { status: number; body: unknown }) {
      vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const { status, body } = init?.method === 'POST' ? { status: 201, body: { pairingId: 'pair_1', code: 'CCCC22' } } : poll();
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      }));
    }

    it('collects an approval given in the fifth minute, while OAIY still keeps the request', async () => {
      // OAIY keeps a request approvable for five minutes. The page stopped polling after three,
      // so OAIY granted a token nobody collected and the page said the pairing had failed.
      const approvedAt = Date.now() + 4.5 * 60_000;
      oaiy(() => ({ status: 200, body: Date.now() >= approvedAt ? { status: 'approved', token: 'oaiypat_late' } : { status: 'pending' } }));
      const pairing = pairWithOaiy('formlogic', undefined);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await pairing).toEqual({ state: 'approved', token: 'oaiypat_late' });
      expect(getOaiyToken()).toBe('oaiypat_late');
    });

    it('stops when OAIY no longer has the request, and a little after five minutes whatever OAIY says', async () => {
      const goneAt = Date.now() + 5 * 60_000;
      oaiy(() => (Date.now() >= goneAt ? { status: 404, body: { error: {} } } : { status: 200, body: { status: 'pending' } }));
      const forgotten = pairWithOaiy('formlogic', undefined);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
      expect(await forgotten).toEqual({ state: 'expired' });

      oaiy(() => ({ status: 200, body: { status: 'pending' } }));
      let settled = false;
      const pending = pairWithOaiy('formlogic', undefined);
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toEqual({ state: 'expired' });
    });
  });
});
