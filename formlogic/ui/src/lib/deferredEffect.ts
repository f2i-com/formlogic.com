/**
 * Start external work after React finishes the current effect flush. Cancelling
 * before the microtask runs prevents obsolete requests (including StrictMode's
 * discarded setup); cancelling afterwards releases resources from that setup.
 * Keep synchronous derived state in render and return async work's cleanup here.
 */
export function deferEffect(start: () => void | (() => void)): () => void {
  let cancelled = false;
  let cleanup: void | (() => void);
  queueMicrotask(() => {
    if (!cancelled) cleanup = start();
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    cleanup?.();
  };
}
