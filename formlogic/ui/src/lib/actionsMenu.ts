import type { CSSProperties } from 'react';

// The kebab actions menus on the forms list cards and the dashboard's "My forms" rows are w-48
// portals fixed against their trigger's viewport rect, and close on a scroll that makes that
// rect stale. They open below the trigger when the tallest variant fits there (≈400px: the forms
// list's ten items and two dividers, the dashboard's phone-width quick actions plus exports),
// otherwise on the roomier side, and are never taller than that side's room (4px gap, 8px from
// the edge): the whole menu is on screen without the page scrolling, which closes it, and a menu
// with less room than it needs scrolls inside itself (overscroll-contain, so it never scrolls on
// into the page).
const MENU_HEIGHT = 400;
export function actionsMenuPosition(rect: DOMRect): CSSProperties {
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const left = Math.max(8, rect.right - 192);
  return below >= MENU_HEIGHT || below >= above
    ? { top: rect.bottom + 4, maxHeight: below, left }
    : { bottom: window.innerHeight - rect.top + 4, maxHeight: above, left };
}

// Only a scroll that can move the trigger (the page or an ancestor) makes the menu's position
// stale. The menu's own overflow scrolling, keyboard focus revealing an item included, must not
// close it under the item being chosen: a capture-phase listener sees both, told apart by target.
// Any [role="menu"] counts, which holds while the open menu is the only one on the page and its
// trigger never sits inside another menu.
export function isMenuScroll(e: Event): boolean {
  return e.target instanceof Element && e.target.closest('[role="menu"]') !== null;
}
