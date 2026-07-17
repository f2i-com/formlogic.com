// Bridge v1 subscription lane for pack-owned sandboxed code screens
// (plan §8.3 items 4-5: events.subscribe / captions.subscribe).
//
// The host window owns the real feeds — the durable desktop event hub
// (client-runtime/desktop/desktopEvents.ts: idempotency-deduped, NO replay
// cursor) and the volatile captions reader (aokie/realtimeCaptions.ts:
// epoch/seq/revision reconciled, droppable by design). A sandboxed iframe
// has neither the pairing token nor cross-origin fetch rights to the
// desktop, so the host RELAYS into the iframe as one-way push frames:
//
//   { __flPush: true, subId, seq, kind, data? }
//
// with a per-subscription monotonic `seq`, a rolling-minute push budget, and
// a single 'dropped' signal frame when the budget sheds pushes — the
// sandbox contract is LIVE-ONLY and lossy-honest: after 'dropped' (or a
// reconnect gap, which the underlying hub cannot replay either) pack code
// re-reads records; the durable plane stays the source of truth.
//
// Pure and React-free — unit-tested in screenSubscriptions.test.ts; the
// CustomScreenRuntime handler wires it to postMessage.

/** Most live subscriptions one screen may hold (events + captions + slack). */
export const MAX_SCREEN_SUBSCRIPTIONS = 4;

/** Rolling-minute push budgets. Events are call-lifecycle scale; captions
 *  stream partial updates at 2-4Hz mid-call and need real headroom. */
export const EVENTS_PUSH_BUDGET = 120;
export const CAPTIONS_PUSH_BUDGET = 600;

export interface ScreenEventFilter {
  /** Which connector's events to observe (matched against
   *  envelope.connectorId ?? envelope.source — the same rule the compiled
   *  Live Call screen uses). */
  connectorId: string;
  /** Optional exact event names (e.g. 'aokie.call.turn.final'); omitted =
   *  every event of the connector. */
  names?: string[];
}

/** Defensive parse of the sandbox's filter payload. Null = unusable. */
export function sanitizeEventFilter(raw: unknown): ScreenEventFilter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const connectorId = typeof rec.connectorId === 'string' ? rec.connectorId.trim() : '';
  // Connector ids are dot-free slugs; a dotted id (e.g. 'aokie.settings')
  // would pass the observe gate via grant-PREFIX overlap while matching no
  // envelope — refuse the shape outright.
  if (!connectorId || connectorId.length > 64 || !/^[a-z0-9_-]+$/i.test(connectorId)) return null;
  let names: string[] | undefined;
  if (rec.names !== undefined) {
    if (!Array.isArray(rec.names)) return null;
    names = rec.names
      .filter((n): n is string => typeof n === 'string' && n !== '' && n.length <= 128)
      .slice(0, 16);
    if (names.length === 0) names = undefined;
  }
  return { connectorId, ...(names ? { names } : {}) };
}

/** Structural slice of a DesktopEventEnvelope the filter needs. */
export interface EnvelopeLike {
  source: string;
  name: string;
  connectorId?: string;
}

export function envelopeMatchesFilter(envelope: EnvelopeLike, filter: ScreenEventFilter): boolean {
  if ((envelope.connectorId ?? envelope.source) !== filter.connectorId) return false;
  if (filter.names && !filter.names.includes(envelope.name)) return false;
  return true;
}

/** What a subscription's start() hands back: stop always; tombstone only for
 *  the captions lane (final-wins when a durable caller turn lands). */
export interface ScreenSubHandle {
  stop: () => void;
  tombstone?: () => void;
}

export interface ScreenSubscriptions {
  count: () => number;
  hasKind: (kind: string) => boolean;
  /** Register + start a subscription. Returns its subId, or null at the cap
   *  (the caller surfaces the error; nothing was started). */
  add: (
    kind: string,
    start: (emit: (frameKind: string, data?: unknown) => void) => ScreenSubHandle,
    pushBudgetPerMinute: number
  ) => number | null;
  /** Forward a tombstone to the subscription (captions). False = unknown sub
   *  or a lane without tombstones. */
  tombstone: (subId: number) => boolean;
  remove: (subId: number) => boolean;
  clear: () => void;
}

interface SubEntry {
  kind: string;
  handle: ScreenSubHandle;
  seq: number;
  pushTimes: number[];
  budget: number;
  droppedSignalled: boolean;
}

/**
 * The per-iframe subscription registry. `push` receives ready-to-post frames
 * (the CustomScreenRuntime posts them into the iframe); `now` is injectable
 * for tests.
 */
export function createScreenSubscriptions(
  push: (frame: Record<string, unknown>) => void,
  options: { now?: () => number; maxSubscriptions?: number } = {}
): ScreenSubscriptions {
  const now = options.now ?? (() => Date.now());
  const max = options.maxSubscriptions ?? MAX_SCREEN_SUBSCRIPTIONS;
  const subs = new Map<number, SubEntry>();
  let nextId = 1;

  const emitFor = (id: number) => (frameKind: string, data?: unknown) => {
    const entry = subs.get(id);
    if (!entry) return; // stopped — a late feed callback must never push
    const t = now();
    entry.pushTimes = entry.pushTimes.filter((p) => t - p < 60_000);
    if (entry.pushTimes.length >= entry.budget) {
      // Budget exhausted: shed this push, but tell the screen ONCE per shed
      // window so it can fall back to re-reading records (there is no replay
      // cursor to catch it up later).
      if (!entry.droppedSignalled) {
        entry.droppedSignalled = true;
        entry.seq += 1;
        push({ __flPush: true, subId: id, seq: entry.seq, kind: 'dropped' });
      }
      return;
    }
    entry.droppedSignalled = false;
    entry.pushTimes.push(t);
    entry.seq += 1;
    push({ __flPush: true, subId: id, seq: entry.seq, kind: frameKind, data });
  };

  return {
    count: () => subs.size,
    hasKind: (kind) => [...subs.values()].some((s) => s.kind === kind),
    add: (kind, start, pushBudgetPerMinute) => {
      if (subs.size >= max) return null;
      const id = nextId++;
      // Register BEFORE start so a feed that emits synchronously still lands.
      const entry: SubEntry = {
        kind,
        handle: { stop: () => {} },
        seq: 0,
        pushTimes: [],
        budget: pushBudgetPerMinute,
        droppedSignalled: false,
      };
      subs.set(id, entry);
      try {
        entry.handle = start(emitFor(id));
      } catch (err) {
        subs.delete(id);
        throw err;
      }
      return id;
    },
    tombstone: (subId) => {
      const entry = subs.get(subId);
      if (!entry?.handle.tombstone) return false;
      entry.handle.tombstone();
      return true;
    },
    remove: (subId) => {
      const entry = subs.get(subId);
      if (!entry) return false;
      subs.delete(subId);
      entry.handle.stop();
      return true;
    },
    clear: () => {
      const all = [...subs.values()];
      subs.clear();
      for (const entry of all) entry.handle.stop();
    },
  };
}
