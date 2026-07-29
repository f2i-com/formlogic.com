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
  /**
   * The origin the PARENT page was itself opened from. Carried so a Back chain
   * survives more than one hop: Studio → Settings → Forms → Back → Settings →
   * Back must land on the Studio section the user started from, not on /apps.
   */
  returnToParent?: ReturnToState;
}

/** Build router state for navigate()/Link so the target's Back returns here. */
export function returnToState(path: string, label?: string, parent?: ReturnToState): ReturnToState {
  return {
    returnTo: path,
    ...(label ? { returnToLabel: label } : {}),
    ...(parent?.returnTo ? { returnToParent: parent } : {}),
  };
}

export interface ReturnTo {
  path: string;
  label: string | null;
  fromState: boolean;
  /**
   * State to hand to navigate() when going Back, so the page returned to keeps
   * ITS own origin: `navigate(backTo.path, { state: backTo.state })`.
   */
  state: ReturnToState | undefined;
}

/**
 * Read the origin this page was opened from. `path` is the origin when present
 * (internal paths only) or the given fallback; `label` is set only when an
 * origin label rode along.
 */
export function useReturnTo(fallback: string): ReturnTo {
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
    state: valid ? state?.returnToParent : undefined,
  };
}

/**
 * Router state for opening a CHILD surface from a page that was itself opened
 * from somewhere: the child returns here, and this page keeps its own origin.
 */
export function forwardReturnTo(here: string, hereLabel: string, origin?: ReturnTo): ReturnToState {
  const parent: ReturnToState | undefined = origin?.fromState
    ? {
        returnTo: origin.path,
        ...(origin.label ? { returnToLabel: origin.label } : {}),
        ...(origin.state ? { returnToParent: origin.state } : {}),
      }
    : undefined;
  return returnToState(here, hereLabel, parent);
}
