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
