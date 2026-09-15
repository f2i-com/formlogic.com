// @vitest-environment jsdom
// Audit FL-S08: a dirty native draft is kept in this browser for this
// account and app, asked about before the page is left, offered back on
// reopen with a visible conflict when a newer version was published in the
// meantime, and never published by itself. An earlier stored draft is never
// overwritten before the owner recovers or discards it, the footer and leave
// prompt promise only what was actually kept, and checkpoints are written
// once typing pauses or before anything that could lose them.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';

const { getProject, saveProject, importProject } = vi.hoisted(() => ({ getProject: vi.fn(), saveProject: vi.fn(), importProject: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeProject: getProject, saveNativeProject: saveProject, getNativeRecords: vi.fn() } }));
vi.mock('../../lib/nativeHosting', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/nativeHosting')>(), importNativeProject: importProject }));
vi.mock('./NativeSourceEditor', () => ({ NativeSourceEditor: ({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) => <textarea aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('./NativeRecordsBrowser', () => ({ NativeRecordsBrowser: () => <p>records</p> }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: ({ onApply, onClose }: { onApply(bytes: Uint8Array): Promise<void>; onClose(): void }) => <button type="button" onClick={() => void onApply(new Uint8Array()).then(onClose)}>Apply editor changes</button> }));
import { NativeEditor } from './NativeAppPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const app = { id: 'app1', slug: 'app', name: 'App' };
const draftKey = (user: string) => `formlogic:native-draft:${user}:app1`;
const project = (version: number, logic = 'original()', assets: Record<string, string> = {}) => ({ version, files: { 'manifest.json': '{}', 'server/main.logic': logic }, assets, access: 'application' as const });
const stored = (user = 'u1') => JSON.parse(localStorage.getItem(draftKey(user))!);
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
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={['/apps/app1/records']}><Routes><Route path="*" element={<><Location /><NativeEditor app={app} initialTab="backend" onClose={onClose} /></>} /></Routes></MemoryRouter>));
  // Faked only once loaded: checkpoints wait for typing to pause.
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}
async function remount() {
  await act(async () => root!.unmount());
  await mount();
}
const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private backend source"]')!;
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const link = (label: string) => [...document.querySelectorAll('a')].find(node => node.textContent?.replace(/\s+/g, ' ') === label)!;
const region = () => document.querySelector('[role="region"][aria-label="Unpublished draft"]');
const footer = () => document.querySelector('[role="dialog"]')!.lastElementChild!.textContent;
const tab = (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(node => node.textContent === label)!.click());
const escape = () => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
const settle = () => act(async () => { vi.advanceTimersByTime(1000); });
async function type(value: string) {
  await act(async () => {
    const field = textarea();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const saveDraft = (baseVersion: number, logic: string) => localStorage.setItem(draftKey('u1'), JSON.stringify({ baseVersion, savedAt: '2026-09-15T00:00:00.000Z', project: project(baseVersion, logic) }));
async function importFile(logic: string) {
  await tab('project');
  importProject.mockResolvedValueOnce(project(0, logic));
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Import native app"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['zip'], 'app.softn')] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await tab('backend');
}
async function applyFromBuilder(logic: string) {
  await act(async () => button('Open Visual Builder')!.click());
  importProject.mockResolvedValueOnce(project(0, logic));
  await act(async () => button('Apply editor changes')!.click());
}

it('checkpoints a dirty draft for this account and asks before the page is left', async () => {
  await mount();
  await type('edited()');
  await settle();
  expect(stored()).toMatchObject({ baseVersion: 2, project: { files: { 'server/main.logic': 'edited()' } } });
  expect(footer()).toContain('Unpublished draft (kept in this browser)');
  // Reload / tab close: the browser is asked.
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  // The route link out of the modal (on the project tab) goes through the same question.
  await tab('project');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => link('Manage users & roles').click());
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Your draft is kept in this browser and offered again'));
  expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/apps/app1/records');
  confirm.mockReturnValueOnce(true);
  await act(async () => link('Manage users & roles').click());
  expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/apps/app1/studio/access');
  // Leaving kept the checkpoint: discarding is its own explicit action.
  expect(localStorage.getItem(draftKey('u1'))).not.toBeNull();
});

it('closing without publishing keeps the draft; the footer says what is saved where', async () => {
  await mount();
  await type('edited()');
  // No pause yet: closing writes the checkpoint before it says the draft is kept.
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await escape();
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Your draft is kept in this browser'));
  expect(stored().project.files['server/main.logic']).toBe('edited()');
  expect(onClose).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
  expect(footer()).toContain('Installed version 2');
  expect(footer()).toContain('Unpublished draft (kept in this browser)');
  confirm.mockReturnValueOnce(true);
  await escape();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(draftKey('u1'))).not.toBeNull();
});

it('offers the draft back on reopen and recovers it without publishing', async () => {
  saveDraft(2, 'recovered()');
  await mount();
  expect(region()!.textContent).toContain('has not been published');
  expect(textarea().value).toBe('original()');
  await act(async () => button('Recover draft')!.click());
  expect(textarea().value).toBe('recovered()');
  await settle();
  expect(footer()).toContain('Unpublished draft (kept in this browser)');
  expect(saveProject).not.toHaveBeenCalled();
  expect(region()).toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('a recovered draft keeps the version it was based on, across a reopen, and Publish asks before replacing the newer one', async () => {
  saveDraft(1, 'older()');
  await mount();
  expect(region()!.textContent).toContain('based on version 1; version 2 has been published since');
  await act(async () => button('Recover draft')!.click());
  expect(textarea().value).toBe('older()');
  const conflict = () => document.querySelector('[role="alert"]')?.textContent;
  expect(conflict()).toContain('based on version 1; version 2 was published after it');
  await type('older, edited()');
  await settle();
  // Still a v1-based draft: its checkpoint does not take the installed version.
  expect(stored()).toMatchObject({ baseVersion: 1, project: { files: { 'server/main.logic': 'older, edited()' } } });
  expect(conflict()).toContain('based on version 1');
  await remount();
  expect(region()!.textContent).toContain('based on version 1; version 2 has been published since');
  await act(async () => button('Recover draft')!.click());
  await type('older, edited again()');
  await settle();
  expect(conflict()).toContain('publishing replaces version 2');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => button('Publish changes')!.click());
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('based on version 1, so publishing replaces version 2'));
  expect(saveProject).not.toHaveBeenCalled();
  expect(stored().baseVersion).toBe(1);
  saveProject.mockResolvedValueOnce({ data: { project: project(3, 'older, edited again()') } });
  confirm.mockReturnValueOnce(true);
  await act(async () => button('Publish changes')!.click());
  expect(saveProject).toHaveBeenCalledWith('app1', expect.objectContaining({ files: expect.objectContaining({ 'server/main.logic': 'older, edited again()' }) }), 2);
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(conflict()).toBeUndefined();
});

it('discarding is explicit and a successful publish clears the checkpoint', async () => {
  saveDraft(2, 'stale()');
  await mount();
  await act(async () => button('Discard draft')!.click());
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  await type('published()');
  await settle();
  expect(localStorage.getItem(draftKey('u1'))).not.toBeNull();
  const confirm = vi.spyOn(window, 'confirm');
  saveProject.mockResolvedValueOnce({ data: { project: project(3, 'published()') } });
  await act(async () => button('Publish changes')!.click());
  expect(confirm).not.toHaveBeenCalled();
  expect(saveProject).toHaveBeenCalledWith('app1', expect.objectContaining({ files: expect.objectContaining({ 'server/main.logic': 'published()' }) }), 2);
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(footer()).toContain('Installed version 3');
  // Nothing pending is written back after the publish.
  await settle();
  await act(async () => root!.unmount());
  root = undefined;
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
});

it('never shows or writes another account’s draft', async () => {
  localStorage.setItem(draftKey('u1'), JSON.stringify({ baseVersion: 2, savedAt: '2026-09-15T00:00:00.000Z', project: project(2, 'theirs()') }));
  useAuthStore.setState({ user: { id: 'u2', email: 'u2@example.com' }, isLoading: false, isInitialized: true, error: null });
  await mount();
  expect(region()).toBeNull();
  await type('mine()');
  await settle();
  expect(stored('u2').project.files['server/main.logic']).toBe('mine()');
  expect(stored('u1').project.files['server/main.logic']).toBe('theirs()');
});

it('an earlier draft awaiting Recover or Discard is not overwritten by edits, imports, editor changes or a publish', async () => {
  saveDraft(2, 'yesterday()');
  await mount();
  await type('today()');
  await settle();
  expect(stored().project.files['server/main.logic']).toBe('yesterday()');
  expect(region()!.textContent).toContain('your current changes are not kept in this browser');
  expect(button('Recover draft')).toBeDefined();
  expect(footer()).toContain('Unpublished draft (not kept until the earlier draft is recovered or discarded)');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await escape();
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('not kept in this browser until the earlier draft is recovered or discarded, so they will be lost if you leave'));
  // Importing a project, or applying Visual Builder changes, is an edit like any other.
  await importFile('imported()');
  expect(importProject).toHaveBeenCalledTimes(1);
  expect(textarea().value).toBe('imported()');
  await settle();
  expect(stored().project.files['server/main.logic']).toBe('yesterday()');
  expect(region()).not.toBeNull();
  await applyFromBuilder('built()');
  expect(textarea().value).toBe('built()');
  await settle();
  expect(stored().project.files['server/main.logic']).toBe('yesterday()');
  expect(region()).not.toBeNull();
  // Publishing the open draft is not a decision about the earlier one: it stays, now behind version 3.
  saveProject.mockResolvedValueOnce({ data: { project: project(3, 'built()') } });
  await act(async () => button('Publish changes')!.click());
  expect(saveProject).toHaveBeenCalledWith('app1', expect.anything(), 2);
  expect(stored().project.files['server/main.logic']).toBe('yesterday()');
  expect(region()!.textContent).toContain('based on version 2; version 3 has been published since');
});

it('an import or Visual Builder changes into a recovered draft keep the version it was based on', async () => {
  saveDraft(1, 'older()');
  await mount();
  await act(async () => button('Recover draft')!.click());
  const conflict = () => document.querySelector('[role="alert"]')?.textContent;
  // The panel's own round trip: download the draft, edit it elsewhere, import it back.
  await importFile('reimported()');
  expect(textarea().value).toBe('reimported()');
  await settle();
  expect(stored()).toMatchObject({ baseVersion: 1, project: { files: { 'server/main.logic': 'reimported()' } } });
  expect(conflict()).toContain('based on version 1; version 2 was published after it');
  await applyFromBuilder('rebuilt()');
  expect(textarea().value).toBe('rebuilt()');
  await settle();
  expect(stored()).toMatchObject({ baseVersion: 1, project: { files: { 'server/main.logic': 'rebuilt()' } } });
  expect(conflict()).toContain('based on version 1');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => button('Publish changes')!.click());
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('based on version 1, so publishing replaces version 2'));
  expect(saveProject).not.toHaveBeenCalled();
});

it('Recover asks before replacing unsaved changes', async () => {
  saveDraft(2, 'earlier()');
  await mount();
  await type('current()');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => button('Recover draft')!.click());
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('replaces your current changes'));
  expect(textarea().value).toBe('current()');
  expect(region()).not.toBeNull();
  confirm.mockReturnValueOnce(true);
  await act(async () => button('Recover draft')!.click());
  expect(textarea().value).toBe('earlier()');
  expect(region()).toBeNull();
});

it('Discard with unsaved changes keeps those changes at once', async () => {
  saveDraft(2, 'earlier()');
  await mount();
  await type('current()');
  await act(async () => button('Discard draft')!.click());
  expect(stored().project.files['server/main.logic']).toBe('current()');
  expect(region()).toBeNull();
  expect(footer()).toContain('Unpublished draft (kept in this browser)');
});

it('a draft too large to keep is not promised, in the footer or when leaving', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, project: project(2, 'original()', { 'media/video.mp4': 'A'.repeat(5 * 1024 * 1024) }) } });
  await mount();
  await type('edited()');
  await settle();
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(footer()).toContain('Unpublished draft (not kept in this browser: too large)');
  expect(footer()).not.toContain('(kept in this browser)');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await escape();
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('too large to keep in this browser, so your latest changes will be lost if you leave'));
  expect(confirm.mock.calls.at(-1)![0]).not.toContain('offered again');
});

it('a draft the browser refuses to store is not promised either', async () => {
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
    if (name.startsWith('formlogic:native-draft:')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    setItem.call(this, name, value);
  });
  await mount();
  await type('edited()');
  await tab('project');
  // No pause yet: the leave question reflects the write it just attempted.
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => link('Manage users & roles').click());
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('refused to store the draft, so your latest changes will be lost if you leave'));
  expect(footer()).toContain('Unpublished draft (not kept in this browser: storage refused it)');
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
});

it('when other drafts fill the room kept for drafts, leaving says so and how to make room', async () => {
  const others = ['formlogic:native-draft:u2:app8', 'formlogic:native-draft:u1:app9'];
  for (const name of others) localStorage.setItem(name, 'x'.repeat(1024 * 1024));
  await mount();
  await type('edited()');
  await settle();
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(footer()).toContain('Unpublished draft (not kept in this browser: no room left for drafts)');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await escape();
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('drafts for other apps or accounts already fill the room this browser keeps for drafts, so your latest changes will be lost if you leave. Publishing or discarding those drafts makes room.'));
  for (const name of others) expect(localStorage.getItem(name)).toHaveLength(1024 * 1024);
});

it('typing writes one checkpoint once it pauses, and a pending one is written when the editor closes', async () => {
  await mount();
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const draftWrites = () => setItem.mock.calls.filter(([name]) => name === draftKey('u1'));
  for (const value of ['e()', 'ed()', 'edi()', 'edit()', 'edited()']) {
    await type(value);
    await act(async () => { vi.advanceTimersByTime(100); });
  }
  expect(draftWrites()).toHaveLength(0);
  await settle();
  expect(draftWrites()).toHaveLength(1);
  expect(stored().project.files['server/main.logic']).toBe('edited()');
  await type('edited again()');
  await act(async () => root!.unmount());
  root = undefined;
  expect(draftWrites()).toHaveLength(2);
  expect(stored().project.files['server/main.logic']).toBe('edited again()');
});

it('a reload or closed tab writes the pending checkpoint before the page goes', async () => {
  await mount();
  await type('edited()');
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  const unload = new Event('beforeunload', { cancelable: true });
  await act(async () => { window.dispatchEvent(unload); });
  expect(unload.defaultPrevented).toBe(true);
  expect(stored().project.files['server/main.logic']).toBe('edited()');
  // Mobile browsers may skip beforeunload; pagehide still writes it.
  await type('edited again()');
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  expect(stored().project.files['server/main.logic']).toBe('edited again()');
});

it('the leave question reads the last write even before the footer has rendered it', async () => {
  await mount();
  await type('edited()');
  await settle();
  expect(footer()).toContain('Unpublished draft (kept in this browser)');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  await type('edited again()');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  // The paused-typing write is refused and Escape follows in the same turn, before React renders the refusal.
  const environment = globalThis as Record<string, unknown>;
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    vi.advanceTimersByTime(1000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(footer()).toContain('Unpublished draft (kept in this browser)');
  } finally { environment.IS_REACT_ACT_ENVIRONMENT = true; }
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('refused to store the draft, so your latest changes will be lost if you leave'));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  expect(footer()).toContain('Unpublished draft (not kept in this browser: storage refused it)');
});
