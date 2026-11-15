import { useEffect, type RefObject } from 'react';

/**
 * Asks for a field at once, as `autoFocus` does, where the whole of it is already in view, and
 * leaves the page where it is: `autoFocus` takes the page down to a field below the fold as the
 * page opens. Create app's name field is under the choice of what to make on a phone, and the page
 * opened half way down it (and the keyboard over it), where it is meant to open at that choice.
 * On a wide screen the field stands beside the choice, in view, and is asked for as before.
 *
 * Looked at as the field appears and again each time `when` changes (another choice that shows
 * it). After the page is painted, so the workspace has put it at its top first.
 */
export function useFocusIfInView(ref: RefObject<HTMLElement | null>, when?: unknown): void {
  useEffect(() => {
    const field = ref.current;
    if (!field) return;
    const box = field.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) field.focus({ preventScroll: true });
  }, [ref, when]);
}
