// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FormsList } from './FormsList';
import { useFormStore } from '../stores/formStore';
import { DEFAULT_FORM_SETTINGS, DEFAULT_FORM_THEME, type Form } from '../types/form';

vi.mock('../lib/api', () => ({
  api: {
    getInstalledPacks: vi.fn(async () => ({ data: { installations: [] } })),
    isAdminActing: () => false,
    isDemoMode: () => false,
    isAuthenticated: () => true,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const form: Form = { id: 'f-1', title: 'Customer enquiries', fields: [], settings: DEFAULT_FORM_SETTINGS, theme: DEFAULT_FORM_THEME, createdAt: '2026-09-15 00:00:00', updatedAt: '2026-09-15 00:00:00', status: 'draft', responseCount: 0 };
let root: Root;
let container: HTMLDivElement;
const innerHeight = window.innerHeight;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');

beforeEach(() => {
  localStorage.setItem('formsList.viewMode', 'grid');
  useFormStore.setState({ forms: [form], isLoading: false, isInitialized: true, error: null, storageMode: 'local' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  localStorage.removeItem('formsList.viewMode');
});

/** Opens the card's actions menu from a trigger at the given viewport rect. */
async function openMenu(viewportHeight: number, top: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewportHeight });
  await act(async () => { root.render(<MemoryRouter><FormsList /></MemoryRouter>); });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Customer enquiries"]')!;
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 300, y: top, width: 32, height: 32 }));
  await act(async () => trigger.click());
  expect(menu()).not.toBeNull();
  return menu()!;
}

// The menu closes on scroll so it never floats away from its trigger. A scroll of
// the menu's own overflow box does not move the trigger, and closing on it lost the
// item a keyboard user was moving to.
it('closes on a page scroll but not on the menu scrolling itself', async () => {
  const opened = await openMenu(844, 200);
  await act(async () => { opened.dispatchEvent(new Event('scroll')); });
  expect(menu()).toBe(opened);
  await act(async () => { document.dispatchEvent(new Event('scroll')); });
  expect(menu()).toBeNull();
});

it('moves focus with the arrow keys without scrolling the page, revealing the item inside the menu', async () => {
  const opened = await openMenu(844, 200);
  const items = [...opened.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(document.activeElement).toBe(items[0]);
  // A menu with room for two items: the third sits below its scroll box.
  Object.defineProperty(opened, 'clientHeight', { configurable: true, value: 80 });
  items.forEach((item, index) => {
    Object.defineProperty(item, 'offsetTop', { configurable: true, value: 4 + index * 40 });
    Object.defineProperty(item, 'offsetHeight', { configurable: true, value: 40 });
  });
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const arrow = async (key: string) => { await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); }); };
  await arrow('ArrowDown');
  await arrow('ArrowDown');
  expect(document.activeElement).toBe(items[2]);
  expect(focus.mock.calls).toEqual([[{ preventScroll: true }], [{ preventScroll: true }]]);
  expect(opened.scrollTop).toBe(44); // 4 + 2 * 40 + 40 - 80
  await act(async () => { opened.dispatchEvent(new Event('scroll')); });
  await arrow('ArrowUp');
  await arrow('ArrowUp');
  expect(document.activeElement).toBe(items[0]);
  expect(opened.scrollTop).toBe(4);
  expect(menu()).toBe(opened);
});

// The menu fits the viewport on whichever side has room, capped to that room, so
// its first item shows without any page scroll and a long menu scrolls inside.
it('opens on the side with room and never runs past the viewport', async () => {
  let opened = await openMenu(844, 200);
  expect([opened.style.top, opened.style.bottom, opened.style.maxHeight]).toEqual(['236px', '', '600px']);
  // Scrolling past the end of its own box must not chain into a page scroll, which closes it.
  expect(opened.classList.contains('overscroll-contain')).toBe(true);
  await act(async () => document.dispatchEvent(new Event('scroll')));
  // Near the fold of a short viewport: above, with the room above the trigger.
  opened = await openMenu(640, 560);
  expect([opened.style.top, opened.style.bottom, opened.style.maxHeight]).toEqual(['', '84px', '548px']);
  await act(async () => document.dispatchEvent(new Event('scroll')));
  // Little room either side: the roomier side, and the menu scrolls within it.
  opened = await openMenu(420, 150);
  expect([opened.style.top, opened.style.bottom, opened.style.maxHeight]).toEqual(['186px', '', '226px']);
});
