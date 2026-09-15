// @vitest-environment jsdom
// The shared demo browses a native app read-only: the project, its source and
// its records are shown; importing, editing, the app editors and publishing are
// not offered, so nothing is dirty, checkpointed or asked about when leaving.
// The server's `readOnly` decides; the demo account is the fallback.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';

const { getProject, saveProject } = vi.hoisted(() => ({ getProject: vi.fn(), saveProject: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeProject: getProject, saveNativeProject: saveProject, getNativeRecords: vi.fn() } }));
vi.mock('./NativeSourceEditor', () => ({ NativeSourceEditor: ({ value, onChange, label, readOnly }: { value: string; onChange(value: string): void; label: string; readOnly?: boolean }) => <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }));
vi.mock('./NativeRecordsBrowser', () => ({ NativeRecordsBrowser: ({ readOnly }: { readOnly?: boolean }) => <p data-testid="records">{readOnly ? 'read-only records' : 'editable records'}</p> }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: () => <p>editor</p> }));
import { NativeEditor } from './NativeAppPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const app = { id: 'app1', slug: 'app', name: 'App' };
const draftKey = 'formlogic:native-draft:u1:app1';
const project = (version: number) => ({ version, files: { 'manifest.json': '{}', 'server/main.logic': 'original()', 'ui/main.ui': '<Text>Hi</Text>' }, assets: {}, access: 'application' as const });
let root: Root | undefined;
let container: HTMLDivElement;
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com' }, isLoading: false, isInitialized: true, error: null });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); });

async function mount(initialTab: 'project' | 'backend' | 'records' = 'project') {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><NativeEditor app={app} initialTab={initialTab} onClose={onClose} /></MemoryRouter>));
}
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const tab = (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(node => node.textContent === label)!.click());
const note = () => document.querySelector('[role="note"]')?.textContent ?? '';
async function type(label: string, value: string) {
  await act(async () => {
    const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('the server’s readOnly shows the project without import, editors, publishing or editable controls', async () => {
  // A demo project answer: no preflight was run, so the runtime is not "ready", and that is not an alert here.
  getProject.mockResolvedValue({ data: { available: true, ready: false, preflight: null, project: project(2), readOnly: true } });
  localStorage.setItem(draftKey, JSON.stringify({ baseVersion: 2, savedAt: '2026-09-15T00:00:00.000Z', project: project(2) }));
  await mount();
  expect(note()).toContain('shared demo');
  expect(note()).toContain('read-only');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('input[aria-label="Import native app"]')).toBeNull();
  expect(button('Import .softn project')).toBeUndefined();
  expect(button('Open Visual Builder')).toBeUndefined();
  expect(button('Open AI Studio')).toBeUndefined();
  expect(button('Publish changes')).toBeUndefined();
  expect(button('Install app project')).toBeUndefined();
  expect(button('Done')).toBeDefined();
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Visitor access"]')!.disabled).toBe(true);
  // Exporting the source stays; an earlier stored draft is not offered back.
  expect(button('Download editable project')).toBeDefined();
  expect(document.querySelector('[role="region"][aria-label="Unpublished draft"]')).toBeNull();
  // The installed app itself does not run in the shared demo, so it is not linked.
  expect(document.querySelector('a[href="/app/app/native"]')).toBeNull();

  await tab('screens');
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Interface source"]')!.readOnly).toBe(true);
  await tab('backend');
  const source = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private backend source"]')!;
  expect(source.readOnly).toBe(true);
  // Even a change that reaches the editor is not a draft: nothing is kept or asked about.
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  await type('Private backend source', 'changed()');
  expect(source.value).toBe('original()');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(setItem.mock.calls.filter(([name]) => name === draftKey)).toHaveLength(0);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="dialog"]')!.lastElementChild!.textContent).not.toContain('Unpublished draft');
  const confirm = vi.spyOn(window, 'confirm');
  await act(async () => button('Done')!.click());
  expect(confirm).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(saveProject).not.toHaveBeenCalled();
});

it('the records tab browses read-only', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: false, preflight: null, project: project(2), readOnly: true } });
  await mount('records');
  expect(document.querySelector('[data-testid="records"]')?.textContent).toBe('read-only records');
});

it('the demo account is read-only when the server does not say', async () => {
  useAuthStore.setState({ user: { id: 'u1', email: 'demo@formlogic.local', isDemo: true }, isLoading: false, isInitialized: true, error: null });
  getProject.mockResolvedValue({ data: { available: true, ready: true, project: project(2) } });
  await mount('backend');
  expect(note()).toContain('shared demo');
  expect(button('Open Visual Builder')).toBeUndefined();
  expect(button('Publish changes')).toBeUndefined();
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private backend source"]')!.readOnly).toBe(true);
});

it('an owner keeps every control', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, preflight: { ok: true, checks: [] }, project: project(2), readOnly: false } });
  await mount();
  expect(note()).toBe('');
  expect(button('Import .softn project')).toBeDefined();
  expect(button('Open Visual Builder')).toBeDefined();
  expect(button('Publish changes')).toBeDefined();
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
  expect(document.querySelector('a[href="/app/app/native"]')?.textContent).toBe('Open installed app');
  await tab('backend');
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private backend source"]')!.readOnly).toBe(false);
  await tab('records');
  expect(document.querySelector('[data-testid="records"]')?.textContent).toBe('editable records');
});
