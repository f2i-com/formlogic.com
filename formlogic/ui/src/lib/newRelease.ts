import { useToastStore } from '../stores/toastStore';

// A tab left open across an update goes on running old code against the new server, and the new
// service worker takes it over without reloading it. A reply from another release says so, and all
// this does is offer: someone may be typing.

/** Replies name their release here (ReleaseHeaderMiddleware). A server before it sends nothing. */
export const RELEASE_HEADER = 'X-FormLogic-Release';

/** Long enough for a new worker to take over, short enough that Reload still feels like one. */
const NEW_WORKER_WAIT_MS = 4000;

let told = false;

/**
 * The worker serves this release until it looks at sw.js again, so a plain reload could land on the
 * same page. It looks now and not when the notice appears: a new worker drops the old release's
 * chunks as it takes over, and a tab still running on them would reload itself at the next one.
 */
async function reloadOntoNewRelease(): Promise<void> {
  const workers = globalThis.navigator?.serviceWorker;
  try {
    const registration = await workers?.getRegistration();
    if (workers && registration) {
      const tookOver = new Promise<void>((resolve) => {
        workers.addEventListener('controllerchange', () => resolve(), { once: true });
        setTimeout(resolve, NEW_WORKER_WAIT_MS);
      });
      await registration.update();
      if (registration.installing || registration.waiting) await tookOver;
    }
  } catch {
    // The reload is still the best there is to offer.
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
 * still what this page needs. scripts/package-dist.mjs names the build with what it writes to
 * api/VERSION, so any other build has nothing to compare and says nothing.
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
