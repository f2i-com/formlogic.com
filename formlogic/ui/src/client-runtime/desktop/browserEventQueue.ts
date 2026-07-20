// Browser fallback ordering for desktop connector events.
//
// The Desktop runtime has a durable per-correlation FIFO. When it is absent,
// two browser subscribers take over: app-logic persists raw records while the
// flow dispatcher launches bindings. Both must enter this SAME queue so an
// earlier `aokie.call.turn.corrected` write finishes before the later
// `aokie.call.transcript.settled` analysis reads that call's transcript.

import type { DesktopEventEnvelope } from './desktopTypes';

type EventWork = () => Promise<void>;

const MAX_ACTIVE_CORRELATIONS = 256;
const UNCORRELATED_KEY = '__uncorrelated__';
const OVERFLOW_KEY = '__overflow__';

interface QueueEntry {
  tail: Promise<void>;
}

const queues = new Map<string, QueueEntry>();
let generation = 0;

function queueKey(event: Pick<DesktopEventEnvelope, 'correlationId' | 'idempotencyKey'>): string {
  const correlation = event.correlationId?.trim();
  if (correlation) {
    // Reserve one slot for overflow so the map itself never exceeds the cap.
    if (queues.has(correlation) || queues.size < MAX_ACTIVE_CORRELATIONS - 1) return correlation;
    // Never drop work merely because many independent calls/devices are
    // active. A single overflow FIFO keeps ordering safe with bounded map
    // cardinality; ordinary deployments never approach this guard.
    return OVERFLOW_KEY;
  }
  return event.idempotencyKey?.trim() || UNCORRELATED_KEY;
}

/**
 * Append browser-side event work to the call/device FIFO. The returned
 * promise reflects this task's own failure, while the internal tail absorbs
 * it so one bad hook cannot poison every later event for that correlation.
 */
export function enqueueBrowserConnectorEvent(
  event: Pick<DesktopEventEnvelope, 'correlationId' | 'idempotencyKey'>,
  work: EventWork
): Promise<void> {
  const key = queueKey(event);
  const prior = queues.get(key)?.tail ?? Promise.resolve();
  const run = prior.then(work, work);
  const tail = run.catch(() => undefined);
  const entry: QueueEntry = { tail };
  const queuedGeneration = generation;
  queues.set(key, entry);
  void tail.finally(() => {
    if (queuedGeneration === generation && queues.get(key) === entry) queues.delete(key);
  });
  return run;
}

/** Clear queue ownership when the app runtime is stopped/switched or a test resets. */
export function resetBrowserConnectorEventQueues(): void {
  generation += 1;
  queues.clear();
}

export function browserConnectorEventQueueSizeForTests(): number {
  return queues.size;
}
