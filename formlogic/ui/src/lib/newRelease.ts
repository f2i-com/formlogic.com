import { useToastStore } from '../stores/toastStore';

// A tab left open across an update goes on running old code against the new server, and the new
// service worker takes it over without reloading it. A reply from another release says so, and all
// this does is offer: someone may be typing.

/** Replies name their release here (ReleaseHeaderMiddleware). A server before it sends nothing. */
export const RELEASE_HEADER = 'X-FormLogic-Release';

/** Long enough for a new worker to take over, short enough that Reload still feels like one. */
const NEW_WORKER_WAIT_MS = 4000;

/** Short timeout for cache-revalidation fetch when falling back from a stuck service worker. */
const REVALIDATE_TIMEOUT_MS = 1500;

let told = false;
let reloading = false;

/**
 * Remove only Workbox precache buckets (which hold the old release's `index.html` and asset manifest).
 * User data in IndexedDB and offline submission queues are never touched.
 */
async function evictWorkboxPrecaches(): Promise<void> {
  const cacheStorage = globalThis.caches;
  if (!cacheStorage || typeof cacheStorage.keys !== 'function') return;
  try {
    const names = await cacheStorage.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('workbox-precache'))
        .map((name) => cacheStorage.delete(name)),
    );
  } catch {
    // Best-effort cache eviction.
  }
}

/**
 * Force the browser's HTTP cache to revalidate the current HTML document before reload so a
 * proxy/CDN or browser cache without `no-cache` cannot re-serve the previous release's index.html.
 */
async function revalidateDocumentCache(): Promise<void> {
  if (typeof globalThis.fetch !== 'function') return;
  if (globalThis.navigator?.onLine === false) return;
  const href = globalThis.location?.href;
  if (!href || !/^https?:\/\//i.test(href)) return;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REVALIDATE_TIMEOUT_MS) : null;
  try {
    await globalThis.fetch(href, {
      cache: 'reload',
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    // Ignore network/abort errors — the reload still proceeds.
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The worker serves this release until it looks at sw.js again, so a plain reload could land on the
 * same page. It looks now and not when the notice appears: a new worker drops the old release's
 * chunks as it takes over, and a tab still running on them would reload itself at the next one.
 *
 * If the new service worker does NOT take over in time (for instance, `sw.js` was cached by a
 * proxy/browser, or precaching hundreds of chunks exceeded the wait window), we proactively evict
 * the stale Workbox precache, unregister the stuck worker, and revalidate the HTML document so
 * clicking Reload ALWAYS lands on the new version without requiring a manual browser cache clear.
 */
export async function reloadOntoNewRelease(): Promise<void> {
  if (reloading) return;
  reloading = true;

  const workers = globalThis.navigator?.serviceWorker;
  let tookOver = false;

  try {
    const registration = await workers?.getRegistration();
    if (workers && registration) {
      const waitForTakeover = new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, NEW_WORKER_WAIT_MS);
        workers.addEventListener(
          'controllerchange',
          () => {
            tookOver = true;
            done();
          },
          { once: true },
        );
      });

      await registration.update();

      const waiting = registration.waiting as { postMessage?: (msg: unknown) => void } | null | undefined;
      if (waiting && typeof waiting.postMessage === 'function') {
        try {
          waiting.postMessage({ type: 'SKIP_WAITING' });
        } catch {
          // Ignore if worker already closed.
        }
      }

      if (registration.installing || registration.waiting) {
        await waitForTakeover;
      }

      if (!tookOver) {
        // The old worker is still controlling `/` (cached sw.js, slow precache, or install error).
        // Evict stale Workbox shell caches and unregister the stuck worker so reload fetches fresh HTML.
        await evictWorkboxPrecaches();
        try {
          await registration.unregister?.();
        } catch {
          // Ignore unregister failure.
        }
        if (typeof workers.getRegistrations === 'function') {
          try {
            const all = await workers.getRegistrations();
            await Promise.all(all.map((reg) => reg.unregister?.()));
          } catch {
            // Ignore.
          }
        }
        if (globalThis.caches) {
          await revalidateDocumentCache();
        }
      }
    } else if (globalThis.caches) {
      // No active SW registration, or browser cached index.html without a worker.
      await evictWorkboxPrecaches();
      await revalidateDocumentCache();
    }
  } catch {
    await evictWorkboxPrecaches();
  }

  window.location.reload();
}

function offerReload(): void {
  // Not in a frame. The person there is a visitor to someone's page, who has no use for this, and
  // the embed code's sandbox has no allow-modals, so nothing would ask before their answers went.
  if (told || globalThis.self !== globalThis.top) return;
  told = true;
  useToastStore.getState().addToast({
    type: 'info',
    title: 'A new version is ready',
    duration: 0,
    action: { label: 'Reload', onClick: () => void reloadOntoNewRelease() },
  });
}

/**
 * Compared for difference, not age: after a rollback the server is the older one, and a reload is
 * still what this page needs. A release before this header, or a proxy that strips it, sends
 * nothing to compare, and the page is not told: it reloads at its next route once that is gone.
 * scripts/package-dist.mjs names the build with what it writes to api/VERSION, so any other build
 * has nothing to compare and says nothing.
 */
export function noteServerRelease(release: string | null | undefined): void {
  const built = import.meta.env.VITE_FORMLOGIC_VERSION as string | undefined;
  if (!release || !built || release === built) return;
  offerReload();
}

/**
 * A worker changing hands is a reason to ask, not news: /form/ comes from the network, so a page
 * there is the new release already, and a first visit's worker claims its tab too. The reply says,
 * through noteServerRelease, as any other does.
 */
export function watchForNewRelease(askTheServer: () => unknown): void {
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers) return;
  let controlled = !!workers.controller;
  workers.addEventListener('controllerchange', () => {
    if (controlled) void askTheServer();
    controlled = true;
  });
}
