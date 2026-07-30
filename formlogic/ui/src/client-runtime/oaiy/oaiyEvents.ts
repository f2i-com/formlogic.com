// OAIY Desktop event polling → the FormLogic event hub.
//
// FormLogic Desktop streams events over SSE (`GET /api/events`). OAIY Desktop
// instead exposes a POLLING endpoint, `GET /api/bridge/events?since=<seq>`, which
// returns `{ events: [{ seq, envelope, … }], next }`. Crucially, each `envelope`
// is ALREADY in the FormLogic DesktopEventEnvelope shape (the Bridge Protocol
// adopted it): `{ schemaVersion:1, source, name, correlationId, idempotencyKey,
// occurredAt, data }`. So this module does NO field mapping — it polls, pulls out
// each `envelope`, and hands it to the SAME ingest pipeline the SSE hub uses
// (validate → dedupe → fan-out). An OAIY-hosted plugin (e.g. aokie) can then fire
// a flow trigger exactly as a FormLogic Desktop plugin does.
//
// Starting from the TAIL, not history: OAIY keeps a ring of recent events, so a
// naive `since=0` poll would replay old events and retroactively fire flows. The
// first successful poll therefore only ADOPTS the current cursor (`next`) and
// discards what it returns; subsequent polls ingest genuinely new events. This
// mirrors SSE, which never replays history on connect.
import { getOaiyBaseUrl, getOaiyToken, oaiyRouteAvailable } from './oaiyRuntime';

/** Cadence between polls. Triggers tolerate a couple of seconds of lag; this
 *  keeps the loopback chatter modest when nothing is happening. */
const POLL_INTERVAL_MS = 2000;
const FETCH_TIMEOUT_MS = 8000;
/** OAIY caps a poll at 500 and its ring holds 500, so one poll drains the whole
 *  ring — priming skips ALL history in a single request. */
const EVENT_LIMIT = 500;

type IngestFn = (envelope: unknown) => void;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let ingest: IngestFn | null = null;
/** Last seq consumed; the next poll asks for events strictly after it. */
let cursor = 0;
/** Until the first successful poll adopts the tail, we ingest nothing. */
let primed = false;

/**
 * One poll: fetch events strictly after `since`, returning each event's raw
 * envelope plus the new cursor. Null when OAIY is unreachable (the loop simply
 * retries next tick). Exported for tests.
 */
export async function fetchOaiyEvents(
  since: number,
): Promise<{ envelopes: unknown[]; next: number } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const token = getOaiyToken();
    const resp = await fetch(
      `${getOaiyBaseUrl()}/api/bridge/events?since=${since}&limit=${EVENT_LIMIT}`,
      {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
    );
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => null)) as
      | { events?: Array<{ seq?: number; envelope?: unknown }>; next?: number }
      | null;
    const events = Array.isArray(body?.events) ? body!.events : [];
    const next = typeof body?.next === 'number' ? body!.next : since;
    return { envelopes: events.map((e) => e?.envelope), next };
  } catch {
    return null; // transient — retry next tick
  }
}

/** One poll+ingest cycle. Primes the cursor from the tail on the first success,
 *  then ingests new envelopes. Exported for tests (drive it without timers). */
export async function __tickOaiyEventsForTests(onEnvelope: IngestFn): Promise<void> {
  await tick(onEnvelope);
}

async function tick(onEnvelope: IngestFn): Promise<void> {
  // Only poll a runtime we're actually paired with — otherwise the privileged
  // events route 403s and there's nothing to consume.
  if (!oaiyRouteAvailable()) return;
  const res = await fetchOaiyEvents(cursor);
  if (res === null) return;
  if (!primed) {
    // Adopt the tail without firing anything — history must not trigger flows.
    cursor = res.next;
    primed = true;
    return;
  }
  for (const envelope of res.envelopes) {
    if (envelope !== undefined) onEnvelope(envelope);
  }
  cursor = res.next;
}

function scheduleNext(delay: number): void {
  if (!running || timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    const fn = ingest;
    if (!fn) return;
    void tick(fn).finally(() => scheduleNext(POLL_INTERVAL_MS));
  }, delay);
}

/**
 * Start polling OAIY events into `onEnvelope` (the hub's ingest fn). Idempotent —
 * only one loop runs. The first poll fires immediately (after a 0ms tick) so a
 * fresh subscription doesn't wait a full interval to adopt the cursor.
 */
export function startOaiyEventPolling(onEnvelope: IngestFn): void {
  if (running) return;
  running = true;
  ingest = onEnvelope;
  scheduleNext(0);
}

/** Stop polling. Resets priming so a later restart re-adopts the current tail
 *  (a gap while stopped must not replay as a burst on resume). */
export function stopOaiyEventPolling(): void {
  running = false;
  ingest = null;
  primed = false;
  cursor = 0;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Reset all polling state. Test-only. */
export function __resetOaiyEventsForTests(): void {
  stopOaiyEventPolling();
}
