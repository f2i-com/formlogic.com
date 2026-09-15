// @vitest-environment jsdom
// The studio's App database section. The shared demo browses it read-only and
// is told so, a demo app without a native installation is simply not shown
// (never "Could not load database tables"), and a failure the server explained
// (a rate limit, say) says what the server said.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { getRecords } = vi.hoisted(() => ({ getRecords: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeRecords: getRecords } }));
vi.mock('./NativeAppPanel', () => ({ NativeEditor: () => <p>editor</p> }));
import { NativeDatabaseTables } from './NativeDatabaseTables';
import { useNativeTables } from './useNativeTables';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const app = { id: 'app1', slug: 'app', name: 'App' };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { getRecords.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

function Section() { return <NativeDatabaseTables app={app} database={useNativeTables(app.id, 'data')} />; }
async function mount() {
  await act(async () => root.render(<MemoryRouter><Section /></MemoryRouter>));
  // The request starts after the effect flush (deferEffect) and resolves on a later tick.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const alert = () => container.querySelector('[role="alert"]')?.textContent;
const note = () => container.querySelector('[role="note"]')?.textContent;

it('tells the demo its app database is read-only while its tables stay browsable', async () => {
  getRecords.mockResolvedValue({ data: { installed: true, tables: ['notes', 'users'], readOnly: true } });
  await mount();
  expect(note()).toContain('shared demo');
  expect(note()).toContain('read-only');
  expect(alert()).toBeUndefined();
  expect(container.querySelector('button[aria-label="Browse notes records"]')).not.toBeNull();
});

it('a demo app without a native installation shows nothing, not an error', async () => {
  getRecords.mockResolvedValue({ data: { installed: false, tables: [], readOnly: true } });
  await mount();
  expect(container.querySelector('section')).toBeNull();
  expect(container.textContent).toBe('');
});

it('an owner is not shown the demo note', async () => {
  getRecords.mockResolvedValue({ data: { installed: true, tables: ['notes'], readOnly: false } });
  await mount();
  expect(note()).toBeUndefined();
  expect(container.querySelector('button[aria-label="Browse notes records"]')).not.toBeNull();
});

it('says what the server said when it explained a failure, and gives retry advice when it did not', async () => {
  getRecords.mockResolvedValue({ error: 'Too many requests. Please try again later.', status: 429 });
  await mount();
  expect(alert()).toBe('Too many requests. Please try again later.');
  await act(async () => root.unmount());

  for (const failure of [{ error: 'Failed to fetch' }, { error: 'Server error (502)', status: 502 }]) {
    getRecords.mockResolvedValue(failure);
    root = createRoot(container);
    await mount();
    expect(alert()).toBe('Could not load database tables. Reload this section to try again.');
    await act(async () => root.unmount());
  }
  root = createRoot(container);
});
