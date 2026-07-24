import { useLocation } from 'react-router-dom';

/**
 * Origin-relative "Back" buttons: a page opened from another surface (e.g. the
 * App Studio opening the form builder) receives `returnTo` in router state so
 * its Back control returns WHERE THE USER CAME FROM instead of the page's
 * hardcoded default. Refreshing or deep-linking loses the state → callers keep
 * their existing fallback target.
 */
export interface ReturnToState {
  returnTo?: string;
  /** Optional short label for the origin (e.g. "App Studio") for button text. */
  returnToLabel?: string;
}

/** Build router state for navigate()/Link so the target's Back returns here. */
export function returnToState(path: string, label?: string): ReturnToState {
  return label ? { returnTo: path, returnToLabel: label } : { returnTo: path };
}

/**
 * Read the origin this page was opened from. `path` is the origin when present
 * (internal paths only) or the given fallback; `label` is set only when an
 * origin label rode along.
 */
export function useReturnTo(fallback: string): { path: string; label: string | null; fromState: boolean } {
  const location = useLocation();
  const state = location.state as ReturnToState | null;
  const returnTo = state?.returnTo;
  // Internal app paths only — router state is page-controlled, but never let a
  // crafted history entry send "Back" to an external URL.
  const valid = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//');
  return {
    path: valid ? returnTo : fallback,
    label: valid && typeof state?.returnToLabel === 'string' ? state.returnToLabel : null,
    fromState: valid,
  };
}
