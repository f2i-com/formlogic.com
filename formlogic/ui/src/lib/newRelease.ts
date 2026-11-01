import { useToastStore } from '../stores/toastStore';

// A tab left open across an update goes on running old code against the new server, and the new
// service worker takes it over without reloading it. Two things can tell it so: a reply from another
// release, and the worker changing hands. Either way it only offers: someone may be typing.

/** Replies name their release here (ReleaseHeaderMiddleware). A server before it sends nothing. */
export const RELEASE_HEADER = 'X-FormLogic-Release';

let told = false;

function offerReload(): void {
  if (told) return;
  told = true;
  useToastStore.getState().addToast({
    type: 'info',
    title: 'A new version is ready',
    duration: 0,
    action: { label: 'Reload', onClick: () => window.location.reload() },
  });
}

/**
 * Compared for difference, not age: after a rollback the server is the older one, and a reload is
 * still what this page needs. scripts/package-dist.mjs names the build with what it writes to
 * api/VERSION, so any other build has nothing to compare and says nothing.
 */
export function noteServerRelease(release: string | null | undefined): void {
  const built = import.meta.env.VITE_FORMLOGIC_VERSION as string | undefined;
  if (!release || !built || release === built || told) return;
  offerReload();
  // The worker keeps serving this release until it has looked at sw.js again, and it only looks on a
  // navigation, so Reload on its own could come back to the same page.
  void globalThis.navigator?.serviceWorker?.getRegistration().then((registration) => registration?.update()).catch(() => {});
}

export function watchForNewRelease(): void {
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers) return;
  // clientsClaim: a first visit's worker takes this tab over too, and nothing about that is new.
  let controlled = !!workers.controller;
  workers.addEventListener('controllerchange', () => {
    if (controlled) offerReload();
    controlled = true;
  });
}
