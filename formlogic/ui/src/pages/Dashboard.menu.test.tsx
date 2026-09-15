// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';
import { useFormStore } from '../stores/formStore';
import { DEFAULT_FORM_SETTINGS, DEFAULT_FORM_THEME, type Form } from '../types/form';

vi.mock('../lib/api', () => ({
  api: {
    getInstalledPacks: vi.fn(async () => ({ data: { installations: [] } })),
    getAIStatus: vi.fn(async () => ({ data: { available: false } })),
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
});

/** Opens the "My forms" row's actions menu from a trigger at the given viewport rect. */
async function openMenu(viewportHeight: number, top: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewportHeight });
  await act(async () => { root.render(<MemoryRouter><Dashboard /></MemoryRouter>); });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Customer enquiries"]')!;
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 300, y: top, width: 32, height: 32 }));
  await act(async () => trigger.click());
  expect(menu()).not.toBeNull();
  return menu()!;
}

// As on the forms list: the menu closes on scroll so it never floats away from its
// trigger, but its own overflow scroll does not move the trigger, and closing on it
// lost the menu a phone user was scrolling to reach Export or Delete.
it('closes on a page scroll but not on the menu scrolling itself', async () => {
  const opened = await openMenu(844, 200);
  await act(async () => { opened.dispatchEvent(new Event('scroll')); });
  expect(menu()).toBe(opened);
  await act(async () => { opened.querySelector('[role="menuitem"]')!.dispatchEvent(new Event('scroll')); });
  expect(menu()).toBe(opened);
  await act(async () => { document.dispatchEvent(new Event('scroll')); });
  expect(menu()).toBeNull();
});

// The same listener effect closes it on resize (the trigger's rect goes stale) and on Escape,
// which hands focus back to the trigger.
it('closes on resize, and on Escape with focus back on the trigger', async () => {
  await openMenu(844, 200);
  await act(async () => { window.dispatchEvent(new Event('resize')); });
  expect(menu()).toBeNull();
  await openMenu(844, 200);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button[aria-label="Actions for Customer enquiries"]'));
});

// The menu fits the viewport on whichever side has room, capped to that room, so it
// never runs past an edge and a long menu scrolls inside.
it('opens on the side with room and never runs past the viewport', async () => {
  let opened = await openMenu(844, 200);
  expect([opened.style.top, opened.style.bottom, opened.style.maxHeight]).toEqual(['236px', '', '600px']);
  // Scrolling past the end of its own box must not chain into a page scroll, which closes it.
  expect(opened.classList.contains('overscroll-contain')).toBe(true);
  await act(async () => document.dispatchEvent(new Event('scroll')));
  // Near the top of a short viewport it flipped above and ran off the top edge: below is roomier.
  opened = await openMenu(420, 150);
  expect([opened.style.top, opened.style.bottom, opened.style.maxHeight]).toEqual(['186px', '', '226px']);
  await act(async () => document.dispatchEvent(new Event('scroll')));
  // Near the fold: above, with the room above the trigger.
  opened = await openMenu(640, 560);
  expect([opened.style.top, opened.style.bottom, opened.style.maxHeight]).toEqual(['', '84px', '548px']);
});
