// @vitest-environment jsdom
// The "Export data" menu is wider than the App Studio's rail it is opened from, and the card
// around that rail clips what it holds: drawn inside the card, half the menu was cut off. It is
// drawn over the page instead, so nothing that holds its button can clip it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exportAppData: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { exportAppData: mocks.exportAppData } }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: mocks.success, error: mocks.error } }));
const { ExportDataMenu } = await import('./ExportDataMenu');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let card: HTMLDivElement;
beforeEach(() => {
  mocks.exportAppData.mockReset().mockResolvedValue(undefined); mocks.success.mockReset(); mocks.error.mockReset();
  card = document.createElement('div');
  card.style.overflow = 'hidden';
  document.body.append(card);
  root = createRoot(card);
});
afterEach(async () => { await act(async () => root.unmount()); card.remove(); });

const trigger = () => card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
const open = async () => { await act(async () => root.render(<ExportDataMenu appId="a1" appSlug="repairs" />)); await act(async () => trigger().click()); };

it('draws its menu over the page, outside whatever holds its button', async () => {
  await open();
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(menu()).not.toBeNull();
  // Not inside the card that clips: the card cannot cut it off.
  expect(card.contains(menu())).toBe(false);
  expect(menu()!.closest('[role="dialog"]')!.getAttribute('aria-label')).toBe('Export data');
  expect(menu()!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThanOrEqual(2);
  expect(menu()!.textContent).toContain('Want a spreadsheet?');
});

it('starts the export a choice names, and closes', async () => {
  await open();
  await act(async () => menu()!.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(mocks.exportAppData).toHaveBeenCalledTimes(1);
  expect(mocks.exportAppData.mock.calls[0].slice(0, 1)).toEqual(['a1']);
  expect(mocks.exportAppData.mock.calls[0][2]).toBe('repairs');
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(mocks.success).toHaveBeenCalledWith('Export ready', 'Your download has started.');
});

it('closes on Escape and when the page scrolls under it, wherever the page does its scrolling', async () => {
  await open();
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  await act(async () => trigger().click());
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  // The window scrolls.
  await act(async () => { window.dispatchEvent(new Event('scroll')); });
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  // The page scrolls inside an element of its own: the event does not come back up to the window
  // (a scroll does not bubble), so it is heard on its way down.
  await act(async () => trigger().click());
  const scroller = document.createElement('main');
  document.body.append(scroller);
  try {
    await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  } finally { scroller.remove(); }
  // Scrolling the menu itself is not the page moving: it stays.
  await act(async () => trigger().click());
  await act(async () => { menu()!.closest('[role="dialog"]')!.dispatchEvent(new Event('scroll', { bubbles: false })); });
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
});

it('stays inside a running app, where the app’s colours and font are set, and closes on a press elsewhere', async () => {
  await act(async () => root.render(<ExportDataMenu appId="a1" appSlug="repairs" variant="app" />));
  await act(async () => trigger().click());
  // Inside what holds the button, so it is under the app's own element.
  expect(menu()).not.toBeNull();
  expect(card.contains(menu())).toBe(true);
  expect(menu()!.closest('[role="dialog"]')).toBeNull();
  expect(menu()!.querySelector('[role="menuitem"] svg')!.getAttribute('class')).toContain('app-text-primary');
  // It moves with its button, so the page scrolling does not close it; a press elsewhere does.
  await act(async () => { window.dispatchEvent(new Event('scroll')); });
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
});
