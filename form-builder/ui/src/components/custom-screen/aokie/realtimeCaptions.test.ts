import { describe, expect, it } from 'vitest';
import {
  applyRealtimeFrame,
  emptyCaptionState,
  parseRealtimeFrame,
  tombstoneCurrentTurn,
  type RealtimeFrame,
} from './realtimeCaptions';

function frame(overrides: Partial<RealtimeFrame>): RealtimeFrame {
  return {
    schemaVersion: 1,
    callId: 'call_a',
    callEpoch: 3,
    sessionNonce: 'n1',
    seq: 1,
    kind: 'user.partial',
    turnId: 't1',
    revision: 1,
    data: { providerStableText: 'hello' },
    ...overrides,
  };
}

describe('realtime caption reconciliation (guide §9.2)', () => {
  it('partials replace by revision; older revisions and duplicate seqs are rejected', () => {
    let s = applyRealtimeFrame(emptyCaptionState(), frame({}));
    expect(s.partialText).toBe('hello');
    s = applyRealtimeFrame(s, frame({ seq: 2, revision: 2, data: { providerStableText: 'hello wor' } }));
    expect(s.partialText).toBe('hello wor');
    // Older revision on a later seq: ignored (text unchanged).
    s = applyRealtimeFrame(s, frame({ seq: 3, revision: 1, data: { providerStableText: 'hel' } }));
    expect(s.partialText).toBe('hello wor');
    // Duplicate/out-of-order seq: dropped whole.
    const before = s;
    s = applyRealtimeFrame(s, frame({ seq: 2, revision: 9, data: { providerStableText: 'x' } }));
    expect(s).toBe(before);
  });

  it('a finalized turn tombstones later partials for it, but not the next turn', () => {
    let s = applyRealtimeFrame(emptyCaptionState(), frame({}));
    s = tombstoneCurrentTurn(s);
    expect(s.partialText).toBe('');
    // Late partial for the finalized turn: rejected (final wins).
    s = applyRealtimeFrame(s, frame({ seq: 5, revision: 3, data: { providerStableText: 'ghost' } }));
    expect(s.partialText).toBe('');
    // The NEXT turn's partial shows normally.
    s = applyRealtimeFrame(s, frame({ seq: 6, turnId: 't2', data: { providerStableText: 'next q' } }));
    expect(s.partialText).toBe('next q');
  });

  it('a new call epoch resets state; stale epochs are rejected', () => {
    let s = applyRealtimeFrame(emptyCaptionState(), frame({}));
    s = applyRealtimeFrame(s, frame({ callEpoch: 4, sessionNonce: 'n2', seq: 1, data: { providerStableText: 'new call' } }));
    expect(s.callEpoch).toBe(4);
    expect(s.partialText).toBe('new call');
    // A straggler from the OLD epoch never regresses the view.
    const before = s;
    s = applyRealtimeFrame(s, frame({ callEpoch: 3, sessionNonce: 'n1', seq: 99, data: { providerStableText: 'old' } }));
    expect(s).toBe(before);
  });

  it('phase frames update the phase without touching the partial', () => {
    let s = applyRealtimeFrame(emptyCaptionState(), frame({}));
    s = applyRealtimeFrame(s, frame({ seq: 2, kind: 'session.phase', data: { phase: 'thinking' } }));
    expect(s.phase).toBe('thinking');
    expect(s.partialText).toBe('hello');
  });

  it('parse rejects wrong schema versions and malformed frames', () => {
    expect(parseRealtimeFrame(null)).toBeNull();
    expect(parseRealtimeFrame({ schemaVersion: 2, callId: 'c', kind: 'x', seq: 1, callEpoch: 1 })).toBeNull();
    expect(parseRealtimeFrame(frame({}))).not.toBeNull();
  });
});
