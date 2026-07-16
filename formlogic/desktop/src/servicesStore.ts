import { useSyncExternalStore } from 'react';
import { services, type RegistrySnapshot } from './api';

/**
 * SRV-002 — shared, request-coalescing services snapshot store.
 *
 * The panels are conditionally mounted (App.tsx mounts only the selected
 * section), so component-local state used to reset on every tab switch and
 * each visit to Services started from a cold "Loading…" line. This module
 * keeps the LAST snapshot at module level:
 *
 *   - a revisit paints instantly from the cached snapshot, then revalidates
 *     in the background (`refreshing` drives a subtle indicator, never a
 *     blank state);
 *   - concurrent callers coalesce onto ONE in-flight request;
 *   - polling runs only while at least one subscriber is mounted AND the
 *     document is visible (the tray-resident discipline every other poll in
 *     this app follows);
 *   - a slow response that lands after a newer one is dropped (monotonic seq);
 *   - other fetchers of the same endpoint (the Overview aggregate poll) can
 *     `primeServicesStore` their result in so navigation between sections
 *     always has fresh data waiting.
 *
 * The backend half (SRV-001) serves this endpoint from a revision-keyed
 * in-memory cache with zero filesystem work, so the 2 s cadence is ~free.
 */

export interface ServicesStoreState {
  snapshot: RegistrySnapshot | null;
  /** Last fetch error (kept alongside a stale snapshot, never replacing it). */
  error: string | null;
  /** A revalidation is in flight (snapshot may still be rendered). */
  refreshing: boolean;
  /** Date.now() of the last successful fetch — drives the "data as of" line. */
  lastFetchedAt: number | null;
}

const POLL_MS = 2000;

let state: ServicesStoreState = {
  snapshot: null,
  error: null,
  refreshing: false,
  lastFetchedAt: null,
};

const listeners = new Set<() => void>();
let pollId: number | undefined;
let inFlight: Promise<void> | null = null;
let seq = 0;
let visListenerInstalled = false;

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<ServicesStoreState>) {
  state = { ...state, ...patch };
  emit();
}

/** One coalesced fetch; concurrent callers share the same promise. */
export function refreshServices(): Promise<void> {
  if (inFlight) return inFlight;
  const mySeq = ++seq;
  setState({ refreshing: true });
  inFlight = services
    .list()
    .then((snap) => {
      if (mySeq !== seq) return; // superseded
      setState({
        snapshot: snap,
        error: null,
        refreshing: false,
        lastFetchedAt: Date.now(),
      });
    })
    .catch((e) => {
      if (mySeq !== seq) return;
      // Keep the stale snapshot renderable; surface the error alongside it.
      setState({
        error: e instanceof Error ? e.message : String(e),
        refreshing: false,
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Feed a snapshot fetched elsewhere (the Overview aggregate poll) into the
 * cache, so switching to the Services section paints with it instantly.
 * Ignored while a direct fetch is in flight (it will land momentarily and
 * is at least as fresh).
 */
export function primeServicesStore(snapshot: RegistrySnapshot) {
  if (inFlight) return;
  setState({ snapshot, error: null, lastFetchedAt: Date.now() });
}

function startPolling() {
  if (pollId !== undefined || listeners.size === 0 || document.hidden) return;
  void refreshServices();
  pollId = window.setInterval(() => void refreshServices(), POLL_MS);
}

function stopPolling() {
  if (pollId !== undefined) {
    window.clearInterval(pollId);
    pollId = undefined;
  }
}

function onVisibility() {
  if (document.hidden) stopPolling();
  else startPolling();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!visListenerInstalled) {
    document.addEventListener('visibilitychange', onVisibility);
    visListenerInstalled = true;
  }
  startPolling();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopPolling();
  };
}

function getSnapshotState(): ServicesStoreState {
  return state;
}

/** React hook: the shared services snapshot, polling while mounted+visible. */
export function useServicesStore(): ServicesStoreState {
  return useSyncExternalStore(subscribe, getSnapshotState);
}
