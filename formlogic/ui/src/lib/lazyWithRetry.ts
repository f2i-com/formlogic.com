import React from 'react';

// An update deletes the old release's hashed files, so a tab left open across it asks for chunks
// that are gone. Reloading gets it the new release.
//
// One reload per 30 seconds, kept in sessionStorage because it has to outlive the reload. Nothing
// clears it: the window is the whole guard. Clearing it when a chunk loaded let a parent chunk that
// loads clear it for a child that doesn't, and Chromium reloaded for ever without showing an error.
const GUARD_KEY = 'lazy_refresh';
const GUARD_MS = 30_000;

let reloading = false;

/** Every page with something to lose guards it on beforeunload, so one question covers them all. */
function wouldLoseWork(): boolean {
  return !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
}

/**
 * Reload for a chunk that can't be had, when that is safe. False leaves the failure to whoever asked
 * for the chunk: a public form with answers on screen stays as it is, since nothing keeps them across
 * a reload (stores/responseStore.ts), and it says it couldn't send them. Offline, a reload may not
 * bring any page back. Where sessionStorage is refused, as in a third-party frame, nothing could stop
 * a loop.
 */
function reloadForStaleChunk(): boolean {
  if (reloading) return true;
  if (navigator.onLine === false || wouldLoseWork()) return false;
  try {
    if (Date.now() - Number(sessionStorage.getItem(GUARD_KEY) || '0') <= GUARD_MS) return false;
    sessionStorage.setItem(GUARD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reloading = true;
  window.location.reload();
  return true;
}

/** Never settles: what renders in the moment before a reload is the loading state, not an error. */
const untilReloaded = <T,>() => new Promise<T>(() => {});

/**
 * An import, with any failure treated as a stale chunk. The words aren't worth reading: they differ
 * between Chromium, Firefox and WebKit, and again for a chunk's CSS. A module that throws as it loads
 * is reloaded once too, and then shows its error like anything else.
 */
export function loadChunk<T>(factory: () => Promise<T>): Promise<T> {
  return factory().then(
    (mod) => mod ?? untilReloaded<T>(), // Nothing is what the listener below makes of a failure it took.
    (error: unknown) => {
      if (reloadForStaleChunk()) return untilReloaded<T>();
      throw error;
    }
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy requires ComponentType<any> to accept components with arbitrary, mutually-incompatible prop shapes; narrowing to unknown breaks every call site
export function lazyWithRetry(factory: () => Promise<{ default: React.ComponentType<any> }>) {
  return React.lazy(() => loadChunk(factory));
}

/**
 * The build's own report of a failed import, and the only one for imports nobody wrapped, and for a
 * chunk's CSS. Prevented, the import resolves to nothing, so it is prevented only when the page is
 * really going: otherwise the caller gets the rejection it has always got, and a form's submit keeps
 * its own "we couldn't send your answers".
 */
export function listenForStaleChunks(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForStaleChunk()) event.preventDefault();
  });
}
