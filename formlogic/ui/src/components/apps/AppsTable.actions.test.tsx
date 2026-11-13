// @vitest-environment jsdom
// The row actions of the apps table. Not every app has all four (one that is not live cannot be
// opened; a forms app has no database of its own), and a row that simply left one out pulled the
// rest along: the same icon stood at a different place from row to row. Each action has a place
// of its own, and a row without it leaves the place empty.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App } from '../../types/app';
import { AppsTable, type AppsTableProps } from './AppsTable';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const app = (id: string, status: 'draft' | 'published', softn: boolean): App => ({
  id, name: `App ${id}`, slug: `app-${id}`, status, ownerId: 'u1', settings: softn ? { softnApp: true } : {}, theme: {}, navConfig: [],
  createdAt: '2026-07-01 00:00:00', updatedAt: '2026-07-20 10:00:00',
} as unknown as App);
const LIVE_SOFTN = app('live', 'published', true);
const DRAFT_SOFTN = app('draft', 'draft', true);
const FORMS = app('forms', 'draft', false);
const summaries = { live: { tables: 3, bytes: 1000 }, draft: { tables: 1, bytes: 10 } } as unknown as AppsTableProps['summaries'];

async function mount(props: Partial<AppsTableProps> = {}) {
  await act(async () => root.render(<MemoryRouter><AppsTable apps={[LIVE_SOFTN, DRAFT_SOFTN, FORMS]} summaries={summaries} packNames={{}}
    canManage={() => true} managePath={item => `/apps/${item.id}`} onDelete={vi.fn()} {...props} /></MemoryRouter>));
}
/** What stands in each place of a row's actions: the action's title, or '' for a place left empty. */
const places = () => [...container.querySelectorAll('table tbody tr')].map(row =>
  [...row.lastElementChild!.querySelectorAll(':scope > span > *')].map(node => (node.hasAttribute('data-empty-action') ? '' : node.getAttribute('title'))));

it('gives each action its own place, and a row without one leaves the place empty', async () => {
  await mount();
  expect(places()).toEqual([
    ['Open the app', 'Data', 'Settings', 'Remove the app'],
    ['', 'Data', 'Settings', 'Remove the app'],
    ['', '', 'Settings', 'Remove the app'],
  ]);
  // An empty place is nothing to a screen reader or to the keyboard.
  for (const empty of container.querySelectorAll('[data-empty-action]')) {
    expect(empty.getAttribute('aria-hidden')).toBe('true');
    expect(empty.matches('a, button, [tabindex]')).toBe(false);
  }
});

it('keeps no place for an action that no app in the list has', async () => {
  // Nothing can be removed from here, and nothing is live: two places, not four.
  await mount({ apps: [DRAFT_SOFTN, FORMS], onDelete: undefined });
  expect(places()).toEqual([['Data', 'Settings'], ['', 'Settings']]);
  // Apps that are only looked at have nothing but Open.
  await mount({ apps: [LIVE_SOFTN], canManage: () => false, onDelete: undefined });
  expect(places()).toEqual([['Open the app']]);
});

it('makes the column as wide as the places it keeps', async () => {
  const width = () => (container.querySelector('table thead th:last-child') as HTMLElement).style.width;
  await mount();
  expect(width()).toBe('150px');
  await mount({ apps: [DRAFT_SOFTN, FORMS], onDelete: undefined });
  expect(width()).toBe('82px');
});

it('leaves a phone’s card as it was: each card stands alone, so nothing is kept empty in it', async () => {
  await mount();
  const cards = [...container.querySelectorAll('ul > li')];
  expect(cards).toHaveLength(3);
  expect(cards.flatMap(card => [...card.querySelectorAll('[data-empty-action]')])).toEqual([]);
});
