// @vitest-environment jsdom
// Audit FL-S08: a dirty native draft is kept in this browser for this
// account and app, asked about before the page is left, offered back on
// reopen with a visible conflict when a newer version was published in the
// meantime, and never published by itself.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';

const { getProject, saveProject } = vi.hoisted(() => ({ getProject: vi.fn(), saveProject: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeProject: getProject, saveNativeProject: saveProject, getNativeRecords: vi.fn() } }));
vi.mock('./NativeSourceEditor', () => ({ NativeSourceEditor: ({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) => <textarea aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('./NativeRecordsBrowser', () => ({ NativeRecordsBrowser: () => <p>records</p> }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: () => <p>editor</p> }));
import { NativeEditor } from './NativeAppPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const app = { id: 'app1', slug: 'app', name: 'App' };
const draftKey = (user: string) => `formlogic:native-draft:${user}:app1`;
const project = (version: number, logic = 'original()') => ({ version, files: { 'manifest.json': '{}', 'server/main.logic': logic }, assets: {}, access: 'application' as const });
let root: Root | undefined;
let container: HTMLDivElement;
const onClose = vi.fn();

function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com' }, isLoading: false, isInitialized: true, error: null });
  getProject.mockResolvedValue({ data: { available: true, ready: true, project: project(2) } });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); });

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={['/apps/app1/records']}><Routes><Route path="*" element={<><Location /><NativeEditor app={app} initialTab="backend" onClose={onClose} /></>} /></Routes></MemoryRouter>));
}
const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private backend source"]')!;
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const link = (label: string) => [...document.querySelectorAll('a')].find(node => node.textContent?.replace(/\s+/g, ' ') === label)!;
async function type(value: string) {
  await act(async () => {
    const field = textarea();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('checkpoints a dirty draft for this account and asks before the page is left', async () => {
  await mount();
  await type('edited()');
  const stored = JSON.parse(localStorage.getItem(draftKey('u1'))!);
  expect(stored).toMatchObject({ baseVersion: 2, project: { files: { 'server/main.logic': 'edited()' } } });
  expect(document.body.textContent).toContain('Unpublished draft (kept in this browser)');
  // Reload / tab close: the browser is asked.
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  // The route link out of the modal (on the project tab) goes through the same question.
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(node => node.textContent === 'project')!.click());
  vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => link('Manage users & roles').click());
  expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/apps/app1/records');
  vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
  await act(async () => link('Manage users & roles').click());
  expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/apps/app1/studio/access');
  // Leaving kept the checkpoint: discarding is its own explicit action.
  expect(localStorage.getItem(draftKey('u1'))).not.toBeNull();
});

it('closing without publishing keeps the draft; the footer says what is saved where', async () => {
  await mount();
  await type('edited()');
  // Escape asks the same question the close control does; declining keeps everything.
  vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(onClose).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Installed version 2');
  expect(document.body.textContent).toContain('Unpublished draft (kept in this browser)');
  vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(draftKey('u1'))).not.toBeNull();
});

it('offers the draft back on reopen and recovers it without publishing', async () => {
  localStorage.setItem(draftKey('u1'), JSON.stringify({ baseVersion: 2, savedAt: '2026-09-15T00:00:00.000Z', project: project(2, 'recovered()') }));
  await mount();
  const region = document.querySelector('[role="region"][aria-label="Unpublished draft"]')!;
  expect(region.textContent).toContain('has not been published');
  expect(textarea().value).toBe('original()');
  await act(async () => button('Recover draft')!.click());
  expect(textarea().value).toBe('recovered()');
  expect(document.body.textContent).toContain('Unpublished draft (kept in this browser)');
  expect(saveProject).not.toHaveBeenCalled();
  expect(document.querySelector('[role="region"]')).toBeNull();
});

it('shows a conflict when a newer version was published after the draft was made', async () => {
  localStorage.setItem(draftKey('u1'), JSON.stringify({ baseVersion: 1, savedAt: '2026-09-15T00:00:00.000Z', project: project(1, 'older()') }));
  await mount();
  const region = document.querySelector('[role="region"][aria-label="Unpublished draft"]')!;
  expect(region.textContent).toContain('based on version 1; version 2 has been published since');
  await act(async () => button('Recover draft')!.click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Version 2 was published after it');
  expect(textarea().value).toBe('older()');
  expect(saveProject).not.toHaveBeenCalled();
});

it('discarding is explicit and a successful publish clears the checkpoint', async () => {
  localStorage.setItem(draftKey('u1'), JSON.stringify({ baseVersion: 2, savedAt: '2026-09-15T00:00:00.000Z', project: project(2, 'stale()') }));
  await mount();
  await act(async () => button('Discard draft')!.click());
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  await type('published()');
  expect(localStorage.getItem(draftKey('u1'))).not.toBeNull();
  saveProject.mockResolvedValueOnce({ data: { project: project(3, 'published()') } });
  await act(async () => button('Publish changes')!.click());
  expect(saveProject).toHaveBeenCalledWith('app1', expect.objectContaining({ files: expect.objectContaining({ 'server/main.logic': 'published()' }) }), 2);
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(document.body.textContent).toContain('Installed version 3');
});

it('never shows or writes another account’s draft', async () => {
  localStorage.setItem(draftKey('u1'), JSON.stringify({ baseVersion: 2, savedAt: '2026-09-15T00:00:00.000Z', project: project(2, 'theirs()') }));
  useAuthStore.setState({ user: { id: 'u2', email: 'u2@example.com' }, isLoading: false, isInitialized: true, error: null });
  await mount();
  expect(document.querySelector('[role="region"][aria-label="Unpublished draft"]')).toBeNull();
  await type('mine()');
  expect(JSON.parse(localStorage.getItem(draftKey('u2'))!).project.files['server/main.logic']).toBe('mine()');
  expect(JSON.parse(localStorage.getItem(draftKey('u1'))!).project.files['server/main.logic']).toBe('theirs()');
});
