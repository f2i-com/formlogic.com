// Native offline sync-queue plumbing + the unified flush surface.
//
// The FormLogic Native Runtime persists queued submissions across process restarts and exposes them
// over window.FormLogicNative.sync (contract 2). This module drives that queue from the web layer:
//   flush()   -> returns pending items grouped by appSlug (read-only: nothing removed, attempts untouched)
//   POST       /api/app/{slug}/sync/batch { items: [{ idempotencyKey, formId, answers }] }
//   ack(ids)  -> remove the items the server accepted
//   fail(ids) -> record a RETRYABLE failure (burns one attempt; terminal at the native attempt cap).
//                Not called when the batch never reached the server (no status, 408, 429, or a
//                502/503/504: maintenance mode, a gateway with no app server behind it).
//   failTerminal(ids) -> mark 'failed' immediately (a conflict can never succeed on retry);
//                        feature-detected, falls back to fail() on older runtimes
//
// flushAllQueues() runs the browser queue AND the native queue so a single "Sync now" (and the
// reconnect auto-flush) drains everything.
//
// A 'failed' item is never handed out by flush() again. The person sends it again
// (retryNativeSubmission) or discards it (discardNativeSubmission); a sign-out clears the queue
// (purgeNativeQueue). All three use only enqueueSubmission/getQueue/ack, which every installed
// runtime has, so they work without a runtime update.
import { api } from '../lib/api';
import { flushBrowserQueue, isConflict, isUnreachableStatus, type FailedSubmissionSummary, type RetryOutcome } from './offlineQueue';
import type { FormLogicNativeBridge, NativeSyncFlushGroup, NativeSyncQueueItem } from './connectors/connectorTypes';

/** The native bridge, only when present AND its sync surface is available. */
function nativeSync(): NonNullable<FormLogicNativeBridge['sync']> | null {
  const bridge = typeof window !== 'undefined' ? window.FormLogicNative : undefined;
  if (!bridge?.available || !bridge.sync) return null;
  return bridge.sync;
}

/** Pending / terminal-failed counts from the native runtime's persistent queue (0/0 in a browser). */
export async function nativeQueueCounts(): Promise<{ pending: number; failed: number }> {
  const sync = nativeSync();
  if (!sync?.getQueue) return { pending: 0, failed: 0 };
  try {
    const items = await sync.getQueue();
    if (!Array.isArray(items)) return { pending: 0, failed: 0 };
    return {
      pending: items.filter((i) => i.status !== 'failed').length,
      failed: items.filter((i) => i.status === 'failed').length,
    };
  } catch {
    return { pending: 0, failed: 0 };
  }
}

/** The calling app's items in the native queue (its partition), or [] without the bridge. */
async function nativeItems(): Promise<NativeSyncQueueItem[]> {
  const sync = nativeSync();
  if (!sync?.getQueue) return [];
  try {
    const items = await sync.getQueue();
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** The native queue's failed items, oldest first, as the person is shown them: never their answers. */
export async function listNativeFailedSubmissions(): Promise<FailedSubmissionSummary[]> {
  return (await nativeItems())
    .filter((i) => i.status === 'failed')
    .map((i) => {
      const created = typeof i.createdAt === 'string' ? Date.parse(i.createdAt) : NaN;
      return {
        id: i.id,
        appSlug: i.appSlug,
        formId: i.formId,
        createdAt: Number.isFinite(created) ? created : 0,
        // Unix seconds, from a runtime that records when an item failed; absent on older ones.
        failedAt: typeof i.failedAt === 'number' && i.failedAt > 0 ? i.failedAt * 1000 : null,
        conflict: isConflict(i),
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Send a failed native item again. The runtime has no "retry": the item is queued afresh with its
 * answers, idempotency key and creation time and no attempts used, the failed one is acknowledged
 * away, and the queue is flushed now. The fresh item is given no id, because the runtime keeps an
 * id the page supplies and acknowledging the old one would then remove both. A conflict is never
 * sent again (see retrySubmission).
 */
export async function retryNativeSubmission(id: string): Promise<RetryOutcome> {
  const sync = nativeSync();
  const item = (await nativeItems()).find((i) => i.id === id);
  if (!sync?.enqueueSubmission || !item) return 'missing';
  if (item.status === 'failed' && isConflict(item)) return 'conflict';
  if (!item.answers || typeof item.answers !== 'object') return 'missing';
  let freshId: string;
  try {
    const queued = await sync.enqueueSubmission({
      appSlug: item.appSlug,
      formId: item.formId,
      idempotencyKey: item.idempotencyKey,
      answers: item.answers,
      attempts: 0,
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    });
    freshId = queued.id;
  } catch {
    // The runtime refused it (its queue for this app is full, or it could not write to disk):
    // the failed item stays as it was.
    return 'failed';
  }
  try {
    await sync.ack?.([id]);
  } catch {
    // Left behind, the old item still names the same key: the server answers a second delivery as
    // a replay, and the person can discard it.
  }
  if (nativePass) await nativePass.catch(() => undefined);
  await flushNativeQueue().catch(() => undefined);
  const after = (await nativeItems()).find((i) => i.id === freshId);
  if (!after) return 'sent';
  if (after.status === 'failed') return isConflict(after) ? 'conflict' : 'failed';
  return 'waiting';
}

/** Remove one item from the native queue (its answers are gone for good; the screen asks first). */
export async function discardNativeSubmission(id: string): Promise<boolean> {
  const sync = nativeSync();
  if (!sync?.ack) return false;
  try {
    const r = await sync.ack([id]);
    return (r?.acked ?? 0) > 0;
  } catch {
    return false;
  }
}

/** How many items, pending or failed, purgeNativeQueue would remove (the sign-out warning). */
export async function nativeUnsentCount(): Promise<number> {
  return (await nativeItems()).length;
}

/**
 * Remove every item this app has in the native queue, pending or failed: the sign-out teardown.
 * The runtime's queue is kept per app, not per account, so an item left behind would be sent with
 * whoever signs in next. Only the calling app's items are reachable from its page; a page that is
 * not a verified app reaches none.
 */
export async function purgeNativeQueue(): Promise<void> {
  const sync = nativeSync();
  const ids = (await nativeItems()).map((i) => i.id);
  if (!sync?.ack || ids.length === 0) return;
  try {
    await sync.ack(ids);
  } catch {
    // best-effort: teardown must not block on the runtime
  }
}

/** The pass over the native queue under way, if any (see flushNativeQueue). */
let nativePass: Promise<{ flushed: number; failed: number }> | null = null;

/**
 * Flush the native runtime's persistent queue: ask the runtime for pending items grouped by appSlug,
 * POST each group to /sync/batch, then ack the accepted items and fail the rest. A no-op (0/0) when the
 * native bridge/sync surface is absent. Never throws — transport/bridge failures leave items queued.
 */
export async function flushNativeQueue(): Promise<{ flushed: number; failed: number }> {
  const sync = nativeSync();
  if (!sync?.flush) return { flushed: 0, failed: 0 };
  // One pass at a time, as the browser queue has it. Reconnecting, coming back to the page,
  // opening an app and "Sync now" can all ask at once, and a second pass would read the same
  // items from the runtime and post the same batch again while the first is still in flight.
  if (nativePass) return { flushed: 0, failed: 0 };
  const pass = drainNativeQueue(sync);
  nativePass = pass;
  try {
    return await pass;
  } finally {
    nativePass = null;
  }
}

async function drainNativeQueue(sync: NonNullable<FormLogicNativeBridge['sync']>): Promise<{ flushed: number; failed: number }> {
  let flushResult: { pending: NativeSyncFlushGroup[] };
  try {
    flushResult = await sync.flush();
  } catch {
    return { flushed: 0, failed: 0 };
  }
  const groups = Array.isArray(flushResult?.pending) ? flushResult.pending : [];
  if (groups.length === 0) return { flushed: 0, failed: 0 };

  // flush() SHOULD include answers on each item; if a runtime omits them, resolve from getQueue() once.
  let queueById: Map<string, NativeSyncQueueItem> | null = null;
  // Returns null when answers can't be resolved — the caller must NOT deliver such an item as an empty
  // submission (that would ack it + bind its idempotency key to an empty response, discarding the real
  // answers and 409-conflicting a later correct replay). An item with a real empty-object answers ({})
  // still resolves to {}.
  const resolveAnswers = async (item: NativeSyncQueueItem): Promise<Record<string, unknown> | null> => {
    if (item.answers && typeof item.answers === 'object') return item.answers as Record<string, unknown>;
    if (!queueById && sync.getQueue) {
      try {
        const all = await sync.getQueue();
        queueById = new Map((Array.isArray(all) ? all : []).map((i) => [i.id, i]));
      } catch {
        queueById = new Map();
      }
    }
    const full = queueById?.get(item.id);
    return full?.answers && typeof full.answers === 'object' ? (full.answers as Record<string, unknown>) : null;
  };

  let flushed = 0;
  let failed = 0;
  for (const group of groups) {
    const slug = group?.appSlug;
    const items = Array.isArray(group?.items) ? group.items : [];
    if (!slug || items.length === 0) continue;

    // Build the POST payload. An item whose answers can't be resolved is NOT delivered as an empty
    // submission (that would poison its idempotency key) — it's failed and left queued for a later
    // flush that carries its answers.
    const payload: Array<{ idempotencyKey: string; formId: string; answers: Record<string, unknown> }> = [];
    const payloadItems: NativeSyncQueueItem[] = [];
    const unresolvedIds: string[] = [];
    for (const it of items) {
      const answers = await resolveAnswers(it);
      if (answers === null) {
        unresolvedIds.push(it.id);
        continue;
      }
      payload.push({ idempotencyKey: it.idempotencyKey, formId: it.formId, answers });
      payloadItems.push(it);
    }
    if (unresolvedIds.length) {
      try { await sync.fail?.(unresolvedIds, 'answers unavailable at flush'); } catch { /* ignore */ }
      failed += unresolvedIds.length;
    }
    if (payload.length === 0) continue;

    const res = await api.syncBatch(slug, payload);
    if ((res.error || !res.data) && (res.status === undefined || isUnreachableStatus(res.status))) {
      // The server was not reached (the api layer gives no status then), or asked to be tried
      // later (isUnreachableStatus): nothing was judged, so nothing is failed — sync.fail would use up one of
      // the runtime's attempts, and an outage would turn queued submissions into failed ones.
      // The items stay queued as they are, and the other groups would meet the same outage, so
      // this flush ends here; the next reconnect or "Sync now" tries again.
      break;
    }
    if (res.error || !res.data) {
      // Whole-batch transport failure — keep every delivered item (retryable) with the error recorded.
      const err = typeof res.error === 'string' ? res.error : 'Sync failed';
      try { await sync.fail?.(payloadItems.map((i) => i.id), err); } catch { /* ignore */ }
      failed += payloadItems.length;
      continue;
    }

    // Map the server's per-item results (keyed by idempotencyKey) back to queue-item ids, preserving
    // the idempotency distinctions so ack / fail / keep can be decided precisely (see syncBatch).
    const byKey = new Map<string, { success: boolean; idempotent: boolean; conflict: boolean; processing: boolean; error: string | null }>();
    for (const r of res.data.results ?? []) {
      if (r && typeof r.idempotencyKey === 'string') {
        byKey.set(r.idempotencyKey, {
          success: r.success === true,
          idempotent: r.idempotent === true,
          conflict: r.conflict === true,
          processing: r.processing === true,
          error: r.error ?? null,
        });
      }
    }
    const ackIds: string[] = [];
    const failIds: string[] = [];
    const terminalIds: string[] = [];
    let failError = 'Sync failed';
    let terminalError = 'Idempotency conflict';
    for (const it of payloadItems) {
      const r = byKey.get(it.idempotencyKey);
      // ACK a fresh success OR an idempotent replay — in both cases the server already holds this exact
      // submission, so the item can be removed from the queue.
      if (r?.success || r?.idempotent) {
        ackIds.push(it.id);
        continue;
      }
      // KEEP a `processing` item: an in-flight duplicate is being handled server-side. Leave it queued
      // untouched (no ack, no fail) so the next flush retries it — recording a failure would burn an
      // attempt toward the native terminal-failure cap for something that just needs a retry. This is
      // genuinely attempt-neutral: the native flush() never mutates attempts.
      if (r?.processing) {
        continue;
      }
      // TERMINAL-fail a `conflict` (this key was already used with a DIFFERENT submission): no retry
      // can ever succeed, so burning attempts across flushes would only delay the inevitable while
      // re-POSTing a doomed item. Mark it 'failed' immediately.
      if (r?.conflict) {
        terminalIds.push(it.id);
        if (r.error) terminalError = r.error;
        continue;
      }
      // FAIL everything else (retryable): validation/quota rejections and missing per-item results
      // burn one attempt each and stay queued until the native cap promotes a poison item to 'failed'.
      failIds.push(it.id);
      if (r?.error) failError = r.error;
    }
    if (ackIds.length && sync.ack) {
      try { await sync.ack(ackIds); } catch { /* ignore — items remain for the next flush */ }
    }
    if (terminalIds.length) {
      // Feature-detect failTerminal: an older runtime without it falls back to a plain retryable
      // fail, which still terminals the conflict once the native attempt cap is exhausted.
      try {
        if (sync.failTerminal) await sync.failTerminal(terminalIds, terminalError);
        else if (sync.fail) await sync.fail(terminalIds, terminalError);
      } catch { /* ignore */ }
    }
    if (failIds.length && sync.fail) {
      try { await sync.fail(failIds, failError); } catch { /* ignore */ }
    }
    flushed += ackIds.length;
    failed += failIds.length + terminalIds.length;
  }
  return { flushed, failed };
}

export interface FlushAllResult {
  browser: { flushed: number; failed: number };
  native: { flushed: number; failed: number };
  lastError: string | null;
}

/**
 * Flush the browser IndexedDB queue AND the native persistent queue. Each half is isolated so one
 * failing doesn't abort the other; the first error (if any) is surfaced as `lastError`.
 */
export async function flushAllQueues(): Promise<FlushAllResult> {
  let lastError: string | null = null;
  let browser = { flushed: 0, failed: 0 };
  let native = { flushed: 0, failed: 0 };
  try {
    browser = await flushBrowserQueue();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  try {
    native = await flushNativeQueue();
  } catch (e) {
    if (!lastError) lastError = e instanceof Error ? e.message : String(e);
  }
  return { browser, native, lastError };
}

/** The least time between two flushes nobody asked for (see flushQueuesWhenDue). */
export const AUTO_FLUSH_SPACING_MS = 2 * 60 * 1000;
let lastAutoFlushAt = -Infinity;

/**
 * A flush nobody asked for: an app has just opened, or the person has come back to the page.
 *
 * The `online` event is the queues' own automatic trigger, and it fires only when the browser's
 * idea of the connection changes. It does not fire on a page that loads already online, so a
 * submission made offline, after which the app was closed (as the "saved on this device" screen
 * says it may be), waited for the connection to drop and return; and a Wi-Fi sign-in page,
 * maintenance mode and a rate limit all leave a submission waiting while the browser says
 * "online" throughout.
 *
 * These passes are spaced. A submission has a fixed number of attempts, and an answer of "still
 * being processed" or a server error uses one; the server can hold a submission as being
 * processed for ten minutes. Spaced two minutes apart, the eight attempts of the browser queue
 * cannot all be spent inside that time by someone flipping between tabs. Reconnecting and
 * "Sync now" are not spaced: they are a reason to try now.
 *
 * Not in the demo, whose submissions stay in the browser: delivering there would move a waiting
 * submission into the demo's local records and drop it from the queue.
 */
export async function flushQueuesWhenDue(): Promise<FlushAllResult | null> {
  if (api.isDemoMode()) return null;
  const now = Date.now();
  if (now - lastAutoFlushAt < AUTO_FLUSH_SPACING_MS) return null;
  lastAutoFlushAt = now;
  return flushAllQueues();
}

// Auto-flush the native queue when connectivity returns (the browser queue registers its own listener
// in offlineQueue.ts, so between the two everything drains on reconnect), and both queues when the
// person comes back to the page.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushNativeQueue();
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void flushQueuesWhenDue().catch(() => { /* stays queued */ });
    });
  }
}
