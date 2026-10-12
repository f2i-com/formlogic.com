/**
 * How the service worker sends the submissions it queued while offline (vite.config.ts,
 * the two background-sync queues).
 *
 * Workbox's own replay removes an entry as soon as `fetch` resolves, whatever the status: a
 * public form's answers queued offline and replayed while the server was in maintenance (503 on
 * every API route) or behind a gateway with no app server (502, 504) were dropped, though the
 * server never looked at them. This one puts such an entry back and stops, so the browser tries
 * again later, until the queue's 24-hour retention runs out. An entry the server did answer,
 * accepted or refused, is removed as before. The statuses are the ones the in-app queues treat as
 * "not reached" (isUnreachableStatus in client-runtime/offlineQueue.ts). A 2xx counts as accepted
 * only when it is what the submit endpoints answer for one, a `response` with an `id` (as
 * isAcceptedSubmission there): a Wi-Fi sign-in page or a proxy answering 200 stored nothing.
 *
 * The function is written into the service worker as its source text (vite-plugin-pwa serialises
 * `backgroundSync.options`), so it must not use anything from outside its own body.
 */

/** The part of a Workbox Queue this uses. */
export interface ReplayQueue {
  shiftRequest(): Promise<{ request: Request } | undefined>
  unshiftRequest(entry: { request: Request }): Promise<void>
}

export async function replayKeepingUnanswered({ queue }: { queue: ReplayQueue }): Promise<void> {
  for (let entry = await queue.shiftRequest(); entry; entry = await queue.shiftRequest()) {
    let keep: boolean
    try {
      const answer = await fetch(entry.request.clone())
      const status = answer.status
      if (status >= 200 && status < 300) {
        const body = (await answer.json().catch(() => null)) as { response?: { id?: unknown } } | null
        const id = body && typeof body === 'object' ? body.response?.id : undefined
        keep = !(typeof id === 'string' && id !== '')
      } else {
        keep = status === 408 || status === 429 || status === 502 || status === 503 || status === 504
      }
    } catch {
      keep = true
    }
    if (keep) {
      // Back where it was, ahead of the rest: they wait their turn behind it, in order.
      await queue.unshiftRequest(entry)
      throw new Error('A queued submission did not reach the server; it is kept for the next try.')
    }
  }
}
