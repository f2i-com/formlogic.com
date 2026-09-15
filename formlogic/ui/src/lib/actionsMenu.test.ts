// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { actionsMenuPosition, isMenuScroll } from './actionsMenu';

const innerHeight = window.innerHeight;
afterEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  document.body.replaceChildren();
});

const at = (viewportHeight: number, top: number, x = 300) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewportHeight });
  return actionsMenuPosition(DOMRect.fromRect({ x, y: top, width: 32, height: 32 }));
};

it('opens below when the tallest menu fits, else on the roomier side, capped to that room', () => {
  expect(at(844, 200)).toEqual({ top: 236, maxHeight: 600, left: 140 });
  // Low on a tall viewport: the whole menu fits below, so below, though above is roomier.
  expect(at(1400, 900)).toEqual({ top: 936, maxHeight: 456, left: 140 });
  // 340px below is short of the full forms-list menu (≈396px; the old 330px threshold opened
  // it there): above is roomier and shows it whole.
  expect(at(844, 460)).toEqual({ bottom: 388, maxHeight: 448, left: 140 });
  // Near the fold of a short viewport: above, with the room above the trigger.
  expect(at(640, 560)).toEqual({ bottom: 84, maxHeight: 548, left: 140 });
  // Little room either side: below is roomier, and the menu scrolls within it.
  expect(at(420, 150)).toEqual({ top: 186, maxHeight: 226, left: 140 });
  // A trigger at the left edge keeps the w-48 menu 8px inside the viewport.
  expect(at(844, 200, 4).left).toBe(8);
});

// A capture-phase window listener sees the menu's own overflow scroll as well as the page's.
it('tells the menu scrolling itself from a scroll that moves the trigger', () => {
  document.body.innerHTML = '<main><div role="menu"><button role="menuitem"></button></div></main>';
  const scrollOf = (target: EventTarget) => {
    let menuScroll: boolean | undefined;
    const listener = (e: Event) => { menuScroll = isMenuScroll(e); };
    window.addEventListener('scroll', listener, true);
    target.dispatchEvent(new Event('scroll'));
    window.removeEventListener('scroll', listener, true);
    return menuScroll;
  };
  expect(scrollOf(document.querySelector('[role="menu"]')!)).toBe(true);
  expect(scrollOf(document.querySelector('[role="menuitem"]')!)).toBe(true);
  expect(scrollOf(document.querySelector('main')!)).toBe(false);
  expect(scrollOf(document)).toBe(false);
});
