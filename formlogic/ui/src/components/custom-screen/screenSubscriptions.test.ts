// The sandbox subscription lane: filter hygiene, per-subscription seq, the
// rolling-minute push budget with its single 'dropped' resync signal, the
// subscription cap, and lifecycle (stop on remove/clear, tombstone routing).
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTIONS_PUSH_BUDGET,
  EVENTS_PUSH_BUDGET,
  MAX_SCREEN_SUBSCRIPTIONS,
  createScreenSubscriptions,
  envelopeMatchesFilter,
  sanitizeEventFilter,
} from './screenSubscriptions';

describe('sanitizeEventFilter', () => {
  it('requires a connectorId and bounds the names list', () => {
    expect(sanitizeEventFilter(undefined)).toBeNull();
    expect(sanitizeEventFilter('aokie')).toBeNull();
    expect(sanitizeEventFilter({})).toBeNull();
    expect(sanitizeEventFilter({ connectorId: '' })).toBeNull();
    expect(sanitizeEventFilter({ connectorId: 'x'.repeat(65) })).toBeNull();
    // Dotted ids would pass the observe gate via grant-prefix overlap —
    // connector ids are dot-free slugs, so the shape is refused outright.
    expect(sanitizeEventFilter({ connectorId: 'aokie.settings' })).toBeNull();
    expect(sanitizeEventFilter({ connectorId: 'local http' })).toBeNull();
    expect(sanitizeEventFilter({ connectorId: 'local-http' })).toEqual({ connectorId: 'local-http' });
    expect(sanitizeEventFilter({ connectorId: ' aokie ' })).toEqual({ connectorId: 'aokie' });
    expect(sanitizeEventFilter({ connectorId: 'aokie', names: 'nope' })).toBeNull();
    expect(
      sanitizeEventFilter({ connectorId: 'aokie', names: ['aokie.call.incoming', '', 7, 'x'.repeat(129)] })
    ).toEqual({ connectorId: 'aokie', names: ['aokie.call.incoming'] });
    // 20 names clamp to 16.
    const many = sanitizeEventFilter({
      connectorId: 'aokie',
      names: Array.from({ length: 20 }, (_, i) => `e${i}`),
    });
    expect(many?.names).toHaveLength(16);
    // An all-junk names list degrades to "every event" rather than none.
    expect(sanitizeEventFilter({ connectorId: 'aokie', names: [''] })).toEqual({ connectorId: 'aokie' });
  });
});

describe('envelopeMatchesFilter', () => {
  const filter = { connectorId: 'aokie', names: ['aokie.call.incoming', 'aokie.call.ended'] };
  it('matches connectorId ?? source (the compiled Live Call rule) and exact names', () => {
    expect(
      envelopeMatchesFilter({ source: 'aokie', name: 'aokie.call.incoming' }, filter)
    ).toBe(true);
    expect(
      envelopeMatchesFilter({ source: 'desktop', connectorId: 'aokie', name: 'aokie.call.ended' }, filter)
    ).toBe(true);
    expect(envelopeMatchesFilter({ source: 'aokie', name: 'aokie.call.turn.final' }, filter)).toBe(false);
    expect(envelopeMatchesFilter({ source: 'flows', name: 'aokie.call.incoming' }, filter)).toBe(false);
    // connectorId (when present) beats source.
    expect(
      envelopeMatchesFilter({ source: 'aokie', connectorId: 'other', name: 'aokie.call.incoming' }, filter)
    ).toBe(false);
    // No names = every event of the connector.
    expect(envelopeMatchesFilter({ source: 'aokie', name: 'anything' }, { connectorId: 'aokie' })).toBe(true);
  });
});

function harness(nowRef: { t: number }) {
  const frames: Array<Record<string, unknown>> = [];
  const subs = createScreenSubscriptions((f) => frames.push(f), { now: () => nowRef.t });
  return { frames, subs };
}

describe('createScreenSubscriptions', () => {
  it('stamps a per-subscription monotonic seq and carries the frame kind/data', () => {
    const now = { t: 1_000_000 };
    const { frames, subs } = harness(now);
    let emitA!: (kind: string, data?: unknown) => void;
    const a = subs.add('events', (emit) => ((emitA = emit), { stop: vi.fn() }), EVENTS_PUSH_BUDGET)!;
    let emitB!: (kind: string, data?: unknown) => void;
    const b = subs.add('captions', (emit) => ((emitB = emit), { stop: vi.fn() }), CAPTIONS_PUSH_BUDGET)!;
    emitA('event', { name: 'aokie.call.incoming' });
    emitB('captions', { partialText: 'hel' });
    emitA('event', { name: 'aokie.call.ended' });
    expect(frames).toEqual([
      { __flPush: true, subId: a, seq: 1, kind: 'event', data: { name: 'aokie.call.incoming' } },
      { __flPush: true, subId: b, seq: 1, kind: 'captions', data: { partialText: 'hel' } },
      { __flPush: true, subId: a, seq: 2, kind: 'event', data: { name: 'aokie.call.ended' } },
    ]);
    expect(subs.hasKind('captions')).toBe(true);
    expect(subs.count()).toBe(2);
  });

  it('sheds pushes over the rolling-minute budget with ONE dropped signal, then resumes', () => {
    const now = { t: 0 };
    const { frames, subs } = harness(now);
    let emit!: (kind: string, data?: unknown) => void;
    subs.add('events', (e) => ((emit = e), { stop: vi.fn() }), 3)!;
    emit('event', 1);
    emit('event', 2);
    emit('event', 3);
    emit('event', 4); // over budget → dropped signal
    emit('event', 5); // still shedding → silent
    expect(frames.map((f) => f.kind)).toEqual(['event', 'event', 'event', 'dropped']);
    // seq covers the dropped signal too (no silent gaps).
    expect(frames[3].seq).toBe(4);
    // A minute later the window frees: pushes resume, and a LATER overflow
    // signals again.
    now.t += 61_000;
    emit('event', 6);
    expect(frames[4]).toMatchObject({ kind: 'event', seq: 5, data: 6 });
    emit('event', 7);
    emit('event', 8);
    emit('event', 9); // over again
    expect(frames.map((f) => f.kind)).toEqual([
      'event', 'event', 'event', 'dropped', 'event', 'event', 'event', 'dropped',
    ]);
  });

  it('caps concurrent subscriptions and reports the cap as null (nothing started)', () => {
    const now = { t: 0 };
    const { subs } = harness(now);
    const started: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < MAX_SCREEN_SUBSCRIPTIONS; i += 1) {
      const stop = vi.fn();
      started.push(stop);
      expect(subs.add('events', () => ({ stop }), 10)).not.toBeNull();
    }
    const start = vi.fn();
    expect(subs.add('events', start, 10)).toBeNull();
    expect(start).not.toHaveBeenCalled();
    // Removing one frees a slot.
    expect(subs.remove(1)).toBe(true);
    expect(started[0]).toHaveBeenCalledTimes(1);
    expect(subs.add('events', () => ({ stop: vi.fn() }), 10)).not.toBeNull();
  });

  it('a removed subscription stops its feed and late emits push nothing', () => {
    const now = { t: 0 };
    const { frames, subs } = harness(now);
    let emit!: (kind: string, data?: unknown) => void;
    const stop = vi.fn();
    const id = subs.add('events', (e) => ((emit = e), { stop }), 10)!;
    emit('event', 'before');
    expect(subs.remove(id)).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    emit('event', 'after'); // the SSE callback firing after teardown
    expect(frames).toHaveLength(1);
    expect(subs.remove(id)).toBe(false);
  });

  it('clear stops everything; tombstone routes only to lanes that support it', () => {
    const now = { t: 0 };
    const { subs } = harness(now);
    const stopA = vi.fn();
    const stopB = vi.fn();
    const tombstone = vi.fn();
    const a = subs.add('events', () => ({ stop: stopA }), 10)!;
    const b = subs.add('captions', () => ({ stop: stopB, tombstone }), 10)!;
    expect(subs.tombstone(a)).toBe(false);
    expect(subs.tombstone(b)).toBe(true);
    expect(tombstone).toHaveBeenCalledTimes(1);
    subs.clear();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(subs.count()).toBe(0);
    expect(subs.tombstone(b)).toBe(false);
  });

  it('a start() that throws leaves no registered subscription behind', () => {
    const now = { t: 0 };
    const { subs } = harness(now);
    expect(() =>
      subs.add('events', () => {
        throw new Error('feed refused');
      }, 10)
    ).toThrow('feed refused');
    expect(subs.count()).toBe(0);
  });
});
