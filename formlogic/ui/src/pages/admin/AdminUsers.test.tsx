// @vitest-environment jsdom
// The user directory draws its own table (one set of rows: a table when wide, cards when narrow),
// so what the shared table used to give it is held here: a row opens the user, the search and the
// pager ask the server, and nothing is listed twice.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { adminListUsers: mocks.list } }));
vi.mock('../../lib/timezone', () => ({ useAdminTimezone: () => 'UTC', formatDateTimeInZone: (date: string) => date }));
import { AdminUsers } from './AdminUsers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u-1', email: 'lance@example.test', name: 'Lance', plan: 'personal', isAdmin: false, isDemo: false,
  online: false, lastSeenAt: null, appsCount: 3, formsCount: 12, flowsCount: 1, responsesCount: 12600, ...over,
});
function Where() { return <output data-testid="where">{useLocation().pathname}</output>; }
async function mount() {
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/admin/users']}>
      <Routes>
        <Route path="/admin/users" element={<AdminUsers />} />
        <Route path="/admin/users/:userId" element={<p>One user</p>} />
      </Routes>
      <Where />
    </MemoryRouter>
  ));
}
const where = () => container.querySelector('[data-testid="where"]')!.textContent;
const rows = () => [...container.querySelectorAll('tbody tr')];
const type = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search users"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ data: { users: [user()], total: 1, page: 1, pages: 1 } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('lists each user once: the name over the address, and every count in a cell of its own', async () => {
  mocks.list.mockResolvedValue({ data: { users: [user({ isAdmin: true, codeTrustVerified: true, online: true })], total: 1, page: 1, pages: 1 } });
  await mount();
  expect(mocks.list).toHaveBeenCalledWith('', 1, 25);
  expect(rows()).toHaveLength(1);
  const [row] = rows();
  const link = row.querySelector('a')!;
  expect(link.textContent).toBe('Lance');
  expect(link.getAttribute('href')).toBe('/admin/users/u-1');
  // (once in the page: the cards a phone shows are these same rows, not a second copy)
  expect(container.textContent!.split('lance@example.test')).toHaveLength(2);
  expect(row.textContent).toContain('admin');
  expect(row.textContent).toContain('verified for host JavaScript');
  expect(row.textContent).toContain('online');
  // Each cell carries its column's name for the card, then the value.
  expect([...row.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['Presenceonline', 'Apps3', 'Forms12', 'Flows1', 'Records12,600', 'Planpersonal']);
  expect(container.textContent).toContain('1 user');
});

it('names a user with no name by the address alone', async () => {
  mocks.list.mockResolvedValue({ data: { users: [user({ name: null })], total: 1, page: 1, pages: 1 } });
  await mount();
  expect(rows()[0].querySelector('a')!.textContent).toBe('lance@example.test');
  expect(container.textContent!.split('lance@example.test')).toHaveLength(2);
  expect(rows()[0].textContent).toContain('never seen');
});

it('opens the user from anywhere on the row, and once from the name', async () => {
  await mount();
  await act(async () => rows()[0].querySelectorAll('td')[2].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(where()).toBe('/admin/users/u-1');
});

it('asks the server for the search, from its first page', async () => {
  mocks.list.mockResolvedValue({ data: { users: Array.from({ length: 25 }, (_, i) => user({ id: `u-${i}`, email: `user${i}@example.test` })), total: 60, page: 1, pages: 3 } });
  await mount();
  expect(container.textContent).toContain('Showing 1–25 of 60');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
  expect(mocks.list).toHaveBeenLastCalledWith('', 2, 25);
  expect(container.textContent).toContain('Page 2 of 3');
  await type('lance');
  expect(mocks.list).toHaveBeenLastCalledWith('lance', 1, 25);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')!.disabled).toBe(true);
});

it('says in the list\'s place when nobody matches, and when the list could not be read', async () => {
  mocks.list.mockResolvedValue({ data: { users: [], total: 0, page: 1, pages: 1 } });
  await mount();
  expect(container.textContent).toContain('No users yet');
  await type('nobody');
  expect(container.textContent).toContain('No users match your search');
  mocks.list.mockResolvedValue({ error: 'Directory unavailable' });
  await type('');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Directory unavailable');
  expect(container.textContent).toContain('User list unavailable');
});
