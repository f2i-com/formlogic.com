import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Pages that keep the window where it is between addresses of their own, and open a part of
 * themselves from its top when they mean to: the SoftN app page opens a section from its top, and
 * a version or a table opened inside one where the list was (SoftnAppWorkspace).
 */
const KEEP_THEIR_OWN_PLACE: readonly RegExp[] = [/^\/apps\/[^/]+\/web(?=\/|$)/];

/** Whether a move from one address to the other is within one of those pages. */
function withinOwnPage(from: string, to: string): boolean {
  return KEEP_THEIR_OWN_PLACE.some((page) => {
    const here = page.exec(from)?.[0];
    return here !== undefined && here === page.exec(to)?.[0];
  });
}

/**
 * A page the person goes to opens at its top, as a page of a site does. The workspace scrolls
 * the window itself, which stayed where it was from one page to the next: the "+" on a phone's
 * bar opened Create app as far down as the list it was pressed under, and an app opened from far
 * down the apps page opened as far down its own.
 *
 * At the top: a press of a link or a button that goes to another page, or to the place already
 * open again (the "+" pressed on Create app itself). Left where it is: Back and Forward (the
 * browser's to put back), an address that names a place in its page (`#panel`, which that page
 * brings into view), a change of the address's query alone (a filter, a search), and a move
 * within a page that keeps its own place (above). At once, not smoothly: the workspace scrolls
 * smoothly within a page (index.css), and arriving is not moving.
 *
 * Before the page is painted, and before any page's own effects, which bring a named place into
 * view once they have drawn it.
 */
export function usePageTopOnNavigation(): void {
  const { key, pathname, search, hash } = useLocation();
  const type = useNavigationType();
  const shown = useRef({ pathname, search });
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { pathname, search };
    if (type !== 'PUSH' || hash !== '') return;
    const stays = before.pathname === pathname ? before.search !== search : withinOwnPage(before.pathname, pathname);
    if (stays) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [key, pathname, search, hash, type]);
}
