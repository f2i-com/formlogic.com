// Live captions consumer for the VOLATILE realtime lane (guide §9.2 v1).
// The desktop's GET /api/plugins/realtime SSE streams droppable frames —
// the caller's in-progress partial transcript and the session phase. This
// module owns (a) the reconciliation reducer (pure, unit-tested): stale
// epochs and older revisions are rejected, a partial REPLACES its
// predecessor, a finalized turn tombstones every later partial for it; and
// (b) a fetch-based SSE reader — fetch, not EventSource, because the
// endpoint needs the pairing auth headers and EventSource cannot send any
// (the guide also forbids tokens in query strings).

import { getDesktopBaseUrl } from '../../../client-runtime/desktop/desktopTypes';
import { desktopAuthHeaders } from '../../../client-runtime/desktop/desktopPairing';

export interface RealtimeFrame {
  schemaVersion: number;
  callId: string;
  callEpoch: number;
  sessionNonce: string;
  seq: number;
  kind: string;
  turnId?: string;
  revision?: number;
  data?: Record<string, unknown>;
}

export interface CaptionState {
  /// Epoch identity of the frames currently being applied.
  callId: string | null;
  callEpoch: number;
  sessionNonce: string;
  seq: number;
  /// The live partial ('' = none visible).
  partialText: string;
  partialTurnId: string | null;
  partialRevision: number;
  /// Turn ids finalized by the DURABLE plane — later partials are rejected.
  tombstoned: string[];
  phase: string | null;
}

export function emptyCaptionState(): CaptionState {
  return {
    callId: null,
    callEpoch: 0,
    sessionNonce: '',
    seq: 0,
    partialText: '',
    partialTurnId: null,
    partialRevision: 0,
    tombstoned: [],
    phase: null,
  };
}

export function parseRealtimeFrame(raw: unknown): RealtimeFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (f.schemaVersion !== 1) return null;
  if (typeof f.callId !== 'string' || typeof f.kind !== 'string') return null;
  if (typeof f.seq !== 'number' || typeof f.callEpoch !== 'number') return null;
  return f as unknown as RealtimeFrame;
}

/** Apply one frame per the guide's reconciliation rules. Pure. */
export function applyRealtimeFrame(state: CaptionState, frame: RealtimeFrame): CaptionState {
  // New call epoch (or first frame): reset to it. Older epochs are stale.
  const sameEpoch =
    state.callId === frame.callId &&
    state.callEpoch === frame.callEpoch &&
    state.sessionNonce === frame.sessionNonce;
  if (!sameEpoch) {
    if (state.callId !== null && frame.callEpoch < state.callEpoch) return state; // stale epoch
    state = {
      ...emptyCaptionState(),
      callId: frame.callId,
      callEpoch: frame.callEpoch,
      sessionNonce: frame.sessionNonce,
    };
  } else if (frame.seq <= state.seq) {
    return state; // duplicate/out-of-order within the epoch
  }
  const next = { ...state, seq: frame.seq };
  if (frame.kind === 'session.phase') {
    const phase = frame.data?.phase;
    if (typeof phase === 'string') next.phase = phase;
    return next;
  }
  if (frame.kind === 'user.partial') {
    const turnId = frame.turnId ?? '';
    const revision = frame.revision ?? 0;
    if (turnId === '' || next.tombstoned.includes(turnId)) return next;
    if (turnId === next.partialTurnId && revision <= next.partialRevision) return next;
    const text = frame.data?.providerStableText;
    next.partialTurnId = turnId;
    next.partialRevision = revision;
    next.partialText = typeof text === 'string' ? text : '';
    return next;
  }
  return next;
}

/** The DURABLE plane finalized the caller's turn: the visible partial is
 *  superseded (final wins) and every later partial for it is rejected. */
export function tombstoneCurrentTurn(state: CaptionState): CaptionState {
  if (state.partialTurnId === null) return state;
  return {
    ...state,
    tombstoned: [...state.tombstoned.slice(-15), state.partialTurnId],
    partialText: '',
    partialTurnId: null,
    partialRevision: 0,
  };
}

export interface RealtimeCaptionsHandle {
  stop: () => void;
  /** The durable plane finalized the caller's turn — tombstone HERE so the
   *  reader's internal state agrees with what the UI shows (a React-side
   *  tombstone alone would be resurrected by the next frame). */
  tombstone: () => void;
}

/**
 * Open the desktop's realtime SSE stream and feed frames through the
 * reducer. Reconnects with backoff while running; silent about failures —
 * captions are best-effort observation, never an error surface.
 */
export function startRealtimeCaptions(onState: (s: CaptionState) => void): RealtimeCaptionsHandle {
  let stopped = false;
  let state = emptyCaptionState();
  let controller: AbortController | null = null;

  const run = async () => {
    let backoffMs = 1000;
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${getDesktopBaseUrl()}/api/plugins/realtime`, {
          headers: desktopAuthHeaders(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`realtime ${res.status}`);
        backoffMs = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          buf += decoder.decode(value, { stream: true });
          // SSE framing: records separated by blank lines; payload in `data:`.
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const record = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = record
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('');
            if (data === '') continue;
            try {
              const frame = parseRealtimeFrame(JSON.parse(data));
              if (frame) {
                const nextState = applyRealtimeFrame(state, frame);
                if (nextState !== state) {
                  state = nextState;
                  onState(state);
                }
              }
            } catch {
              /* malformed frame: droppable by contract */
            }
          }
        }
      } catch {
        /* transport hiccup: retry below */
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  };
  void run();

  return {
    stop: () => {
      stopped = true;
      controller?.abort();
    },
    tombstone: () => {
      const next = tombstoneCurrentTurn(state);
      if (next !== state) {
        state = next;
        onState(state);
      }
    },
  };
}
