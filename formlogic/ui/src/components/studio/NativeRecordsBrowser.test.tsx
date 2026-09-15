// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeRecordsBrowser } from './NativeRecordsBrowser';
const { getRecords } = vi.hoisted(() => ({ getRecords: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeRecords: getRecords } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const data = (title: string, more = false) => ({ data: { tables: ['notes', 'users'], columns: ['id', 'title'], rows: [{ id: 1, title }], hasMore: more } });
beforeEach(() => { getRecords.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const mount = async () => { await act(async () => root.render(<NativeRecordsBrowser appId="app" version={1} initialTable="notes" />)); };
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!;

it('paginates real requests and hides old records when a page fails to load', async () => {
  getRecords.mockResolvedValueOnce(data('First page', true)).mockResolvedValueOnce(data('Second page')).mockResolvedValueOnce({ error: 'Database temporarily unavailable' });
  await mount();
  await act(async () => button('Next').click());
  expect(getRecords).toHaveBeenLastCalledWith('app', 'notes', 50);
  expect(container.textContent).toContain('Second page');
  expect(container.textContent).not.toContain('First page');
  expect(button('Next').disabled).toBe(true);
  await act(async () => button('Refresh records').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Database temporarily unavailable');
  expect(container.textContent).not.toContain('Second page');
  expect(button('Try again')).toBeTruthy();
});

it('ignores a late response after the user switches tables', async () => {
  let resolveOld!: (value: ReturnType<typeof data>) => void;
  getRecords.mockResolvedValueOnce(data('Original note'))
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce(data('Current note'));
  await mount();
  const select = container.querySelector('select')!;
  await act(async () => { select.value = 'users'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { select.value = 'notes'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => resolveOld(data('Stale user')));
  expect(container.textContent).toContain('Current note');
  expect(container.textContent).not.toContain('Stale user');
  expect(select.value).toBe('notes');
});

// Audit FL-S06: the server clamps offsets to its browsing window. The pager
// must show the page the server answered with and stop there, rather than
// counting its own pages up while the same rows come back under new labels.
it('follows the server’s effective offset and stops at the browsing window', async () => {
  const page = (offset: number, end: 'more' | 'end' | 'limit', first: number) => ({ data: { tables: ['notes'], columns: ['id'], rows: Array.from({ length: 50 }, (_, i) => ({ id: first + i })), hasMore: end === 'more', offset, end, limit: 100000 } });
  getRecords.mockResolvedValueOnce(page(0, 'more', 1)).mockResolvedValueOnce(page(50, 'more', 51)).mockResolvedValueOnce(page(100, 'limit', 100001));
  await mount();
  expect(container.textContent).toContain('Page 1 · Rows 1–50');
  await act(async () => button('Next').click());
  expect(getRecords).toHaveBeenLastCalledWith('app', 'notes', 50);
  expect(container.textContent).toContain('Page 2 · Rows 51–100');
  await act(async () => button('Next').click());
  // The third answer is the clamped window page: labels follow it, Next stops.
  expect(container.textContent).toContain('Page 3 · Rows 101–150');
  expect(button('Next').disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('first 100,000 records');
  expect(getRecords).toHaveBeenCalledTimes(3);
});

it('shows the clamped page under its real position when a request lands past the window', async () => {
  // A request for offset 100050 answered as offset 100000 (end=limit): the
  // labels say 100 001–100 050, page 2001, and Next is disabled.
  getRecords.mockResolvedValue({ data: { tables: ['notes'], columns: ['id'], rows: Array.from({ length: 50 }, (_, i) => ({ id: 100001 + i })), hasMore: false, offset: 100000, end: 'limit', limit: 100000 } });
  await mount();
  expect(container.textContent).toContain('Page 2001 · Rows 100001–100050');
  expect(button('Next').disabled).toBe(true);
  expect(button('Previous').disabled).toBe(false);
  await act(async () => button('Previous').click());
  expect(getRecords).toHaveBeenLastCalledWith('app', 'notes', 99950);
});

it('keeps working with an older server that only sends hasMore', async () => {
  getRecords.mockResolvedValueOnce(data('Old server', true)).mockResolvedValueOnce(data('Last page'));
  await mount();
  expect(button('Next').disabled).toBe(false);
  await act(async () => button('Next').click());
  expect(getRecords).toHaveBeenLastCalledWith('app', 'notes', 50);
  expect(container.textContent).toContain('Page 2');
  expect(button('Next').disabled).toBe(true);
});
