// @vitest-environment jsdom
// The records tab of the "Native app hosting" dialog is the data manager (components/data, with
// its own tests of paging, searching, editing and read-only browsing). What is tested here is
// what this file adds: a dialog has no address, so it holds the table, the view and what is being
// looked at in it, and hands the manager what the dialog knows.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DataManagerProps } from '../data';

const shown = vi.hoisted(() => ({ props: null as unknown }));
vi.mock('../data', () => ({
  DataManager: (props: DataManagerProps) => {
    shown.props = props;
    return <p data-testid="manager">{`${props.table ?? '(first table)'} | ${props.view} | ${props.query}`}</p>;
  },
}));

import { NativeRecordsBrowser } from './NativeRecordsBrowser';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const props = () => shown.props as DataManagerProps;
const text = () => container.querySelector('[data-testid="manager"]')?.textContent;

beforeEach(() => { shown.props = null; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('opens the table it was asked for, in Browse, with nothing searched', async () => {
  await act(async () => root.render(<NativeRecordsBrowser appId="app" appSlug="my-app" version={3} initialTable="notes" />));
  expect(text()).toBe('notes | browse | ');
  expect(props()).toMatchObject({ appId: 'app', appSlug: 'my-app', version: 3, readOnly: false });
  expect(container.querySelector('section[aria-label="Database records browser"]')).not.toBeNull();
});

it('leaves the choice of table to the manager when none was asked for', async () => {
  await act(async () => root.render(<NativeRecordsBrowser appId="app" version={1} />));
  expect(text()).toBe('(first table) | browse | ');
});

it('keeps the table, the view and what is looked at, as the page keeps them in its address', async () => {
  await act(async () => root.render(<NativeRecordsBrowser appId="app" version={1} initialTable="notes" />));
  await act(async () => props().onNavigate('users', 'browse', 'q=ann&sort=name&dir=desc'));
  expect(text()).toBe('users | browse | q=ann&sort=name&dir=desc');
  await act(async () => props().onNavigate('users', 'structure', 'q=ann&sort=name&dir=desc'));
  expect(text()).toBe('users | structure | q=ann&sort=name&dir=desc');
  // A table opened from the list: nothing searched, as the manager asks.
  await act(async () => props().onNavigate('notes', 'browse'));
  expect(text()).toBe('notes | browse | ');
});

it('browses read-only in the shared demo', async () => {
  await act(async () => root.render(<NativeRecordsBrowser appId="app" version={1} initialTable="notes" readOnly />));
  expect(props().readOnly).toBe(true);
});
