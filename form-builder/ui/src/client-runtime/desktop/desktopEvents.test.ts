import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDesktopEventsForTests,
  emitLocalDesktopEvent,
  ingestDesktopEvent,
  isValidDesktopEvent,
  subscribeDesktopEvents,
} from './desktopEvents';
import { __resetDesktopDetectionForTests } from './desktopDetection';
import type { DesktopEventEnvelope } from './desktopTypes';

// Event hub: minimal envelope validation, central dedupe on idempotencyKey (LRU 512),
// and fan-out to every subscriber. Local (mock) emission uses the same pipeline as SSE.

function envelope(overrides: Partial<DesktopEventEnvelope> = {}): DesktopEventEnvelope {
  return {
    schemaVersion: 1,
    source: 'aokie',
    name: 'aokie.call.incoming',
    correlationId: 'call_1',
    idempotencyKey: 'aokie:call_1:incoming:v1',
    occurredAt: '2026-07-07T00:00:00Z',
    data: { from: '+61400000000' },
    connectorId: 'aokie',
    ...overrides,
  };
}

afterEach(() => {
  __resetDesktopEventsForTests();
  __resetDesktopDetectionForTests();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('isValidDesktopEvent', () => {
  it('accepts a schema-shaped envelope and rejects missing required fields', () => {
    expect(isValidDesktopEvent(envelope())).toBe(true);
    expect(isValidDesktopEvent(null)).toBe(false);
    expect(isValidDesktopEvent({})).toBe(false);
    expect(isValidDesktopEvent({ ...envelope(), schemaVersion: 2 })).toBe(false);
    expect(isValidDesktopEvent({ ...envelope(), idempotencyKey: '' })).toBe(false);
    const missingData = { ...envelope() } as Record<string, unknown>;
    delete missingData.data;
    expect(isValidDesktopEvent(missingData)).toBe(false);
  });
});

describe('desktop event hub', () => {
  it('dispatches a valid envelope to every subscriber', () => {
    // No desktop is detected in tests, so subscribing must not open any connection —
    // guard by making any (unexpected) fetch fail loudly-but-quietly.
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeDesktopEvents((e) => a.push(e.name));
    const unsubB = subscribeDesktopEvents((e) => b.push(e.name));

    expect(emitLocalDesktopEvent(envelope())).toBe(true);

    expect(a).toEqual(['aokie.call.incoming']);
    expect(b).toEqual(['aokie.call.incoming']);
    unsubA();
    unsubB();
  });

  it('dedupes on idempotencyKey — a duplicate never reaches listeners', () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const seen: string[] = [];
    const unsub = subscribeDesktopEvents((e) => seen.push(e.idempotencyKey));

    expect(emitLocalDesktopEvent(envelope())).toBe(true);
    expect(emitLocalDesktopEvent(envelope())).toBe(false); // same key, even with new object identity
    expect(emitLocalDesktopEvent(envelope({ correlationId: 'call_other' }))).toBe(false); // key still wins

    expect(seen).toEqual(['aokie:call_1:incoming:v1']);
    unsub();
  });

  it('drops invalid envelopes without dispatching', () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const seen: unknown[] = [];
    const unsub = subscribeDesktopEvents((e) => seen.push(e));

    expect(ingestDesktopEvent({ name: 'aokie.call.incoming' })).toBe(false);
    expect(ingestDesktopEvent('not-an-object')).toBe(false);

    expect(seen).toEqual([]);
    unsub();
  });

  it('LRU-evicts old keys after 512 fresh ones (a very old duplicate can re-dispatch)', () => {
    expect(ingestDesktopEvent(envelope({ idempotencyKey: 'k:first' }))).toBe(true);
    expect(ingestDesktopEvent(envelope({ idempotencyKey: 'k:first' }))).toBe(false); // deduped while fresh

    for (let i = 0; i < 512; i++) {
      expect(ingestDesktopEvent(envelope({ idempotencyKey: `k:${i}` }))).toBe(true);
    }

    // 'k:first' is now the 513th-oldest key — evicted, so it dispatches again.
    expect(ingestDesktopEvent(envelope({ idempotencyKey: 'k:first' }))).toBe(true);
  });

  it('a throwing listener does not break fan-out to the others', () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    const unsubBad = subscribeDesktopEvents(() => {
      throw new Error('boom');
    });
    const unsubGood = subscribeDesktopEvents((e) => seen.push(e.name));

    expect(emitLocalDesktopEvent(envelope())).toBe(true);

    expect(seen).toEqual(['aokie.call.incoming']);
    unsubBad();
    unsubGood();
  });
});
