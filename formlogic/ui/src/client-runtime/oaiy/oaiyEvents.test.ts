import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __resetOaiyDetectionForTests,
  __setOaiyBaseUrlForTests,
  probeOaiy,
  setOaiyToken,
} from './oaiyRuntime';
import {
  __resetOaiyEventsForTests,
  __tickOaiyEventsForTests,
  fetchOaiyEvents,
} from './oaiyEvents';
import { isValidDesktopEvent } from '../desktop/desktopEvents';

const BASE = 'http://127.0.0.1:19994';
const healthy = { status: 'ok', product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: '0.1.0' };

/** A DesktopEventEnvelope-shaped OAIY plugin event (the Bridge Protocol uses the
 *  same envelope, so no mapping is needed). */
function envelope(idempotencyKey: string, name = 'aokie.call.incoming') {
  return {
    schemaVersion: 1,
    source: 'aokie',
    name,
    correlationId: idempotencyKey.split(':')[1] ?? 'c',
    idempotencyKey,
    occurredAt: '2026-07-30T04:12:09Z',
    data: { from: '+61491570156' },
  };
}

/** Route /api/health → identity; /api/bridge/events → the next queued page. */
function mockOaiy(eventPages: Array<{ events: Array<{ seq: number; envelope: unknown }>; next: number }>) {
  let page = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify(healthy), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = eventPages[Math.min(page, eventPages.length - 1)] ?? { events: [], next: 0 };
      page += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
}

beforeEach(() => {
  __setOaiyBaseUrlForTests(BASE);
  __resetOaiyDetectionForTests();
  __resetOaiyEventsForTests();
  setOaiyToken(null);
});
afterEach(() => {
  __resetOaiyEventsForTests();
  __resetOaiyDetectionForTests();
  __resetOaiyBaseUrlForTests();
  setOaiyToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchOaiyEvents', () => {
  it('pulls each event\'s raw envelope and the next cursor', async () => {
    mockOaiy([{ events: [{ seq: 7, envelope: envelope('aokie:c1:v1') }], next: 7 }]);
    setOaiyToken('tok');
    const res = await fetchOaiyEvents(0);
    expect(res?.next).toBe(7);
    expect(res?.envelopes).toHaveLength(1);
    expect((res!.envelopes[0] as { idempotencyKey: string }).idempotencyKey).toBe('aokie:c1:v1');
  });

  it('returns null when OAIY is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await fetchOaiyEvents(0)).toBeNull();
  });
});

describe('event polling primes from the tail, then ingests', () => {
  beforeEach(async () => {
    mockOaiy([
      // First poll (priming): returns ring history — must be DISCARDED.
      { events: [{ seq: 3, envelope: envelope('aokie:old:v1') }], next: 3 },
      // Second poll: a genuinely new event — must be INGESTED.
      { events: [{ seq: 4, envelope: envelope('aokie:new:v1') }], next: 4 },
    ]);
    await probeOaiy(true); // detect OAIY
    setOaiyToken('tok'); // + token → oaiyRouteAvailable() true
  });

  it('does not replay history, then delivers new events', async () => {
    const seen: string[] = [];
    const ingest = (e: unknown) => seen.push((e as { idempotencyKey: string }).idempotencyKey);

    await __tickOaiyEventsForTests(ingest); // priming poll — adopts cursor, ingests nothing
    expect(seen).toEqual([]);

    await __tickOaiyEventsForTests(ingest); // second poll — new event delivered
    expect(seen).toEqual(['aokie:new:v1']);
  });

  it('polls nothing while not paired (privileged route would 403)', async () => {
    setOaiyToken(null); // detected but no token → oaiyRouteAvailable() false
    const seen: string[] = [];
    await __tickOaiyEventsForTests((e) => seen.push(String(e)));
    await __tickOaiyEventsForTests((e) => seen.push(String(e)));
    expect(seen).toEqual([]);
  });
});

describe('no field mapping needed', () => {
  it('an OAIY plugin envelope passes FormLogic\'s validator as-is', () => {
    // This is why the bridge is a passthrough: OAIY plugin events already ARE
    // FormLogic DesktopEventEnvelopes.
    expect(isValidDesktopEvent(envelope('aokie:c1:v1'))).toBe(true);
  });
});
