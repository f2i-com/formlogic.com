// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useAiReady', () => ({ useAiReady: () => ({ ready: false }) }));
vi.mock('./NativeRecordsBrowser', () => ({ NativeRecordsBrowser: () => null }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: () => null }));
vi.mock('./AppEngineSelect', () => ({ AppEngineSelect: () => null }));
vi.mock('./AppTorchSwitch', () => ({ AppTorchSwitch: () => null }));
vi.mock('../ui/CodeEditor', () => ({ CodeEditor: ({ language, value }: { language: string; value: string }) => <textarea aria-label={language} value={value} readOnly /> }));
vi.mock('./useNativeProjectDraft', () => ({ DRAFT_KEEPING: {}, useNativeProjectDraft: () => ({
  project: { version: 1, files: { 'manifest.json': '{}', 'ui/main.ui': '<Text/>', 'logic/main.py': 'count = 7\n', 'server/main.logic': 'private', 'backend/helper.logic': 'private', 'Private/helper.py': 'private' }, assets: {}, access: 'members' },
  version: 1, ready: true, available: true, busy: false, dirty: false, edit: vi.fn(), isLocked: () => false,
}) }));
import { NativeEditor } from './NativeAppPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); });

it('offers Python client logic in Screens and opens it in Python mode without listing private files', async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><NativeEditor app={{ id: 'app1', slug: 'app', name: 'App' }} onClose={() => {}} /></MemoryRouter>));
  const screens = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === 'screens')!;
  await act(async () => screens.click());
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Interface file"]')!;
  expect([...select.options].map(option => option.value)).toEqual(['ui/main.ui', 'logic/main.py']);
  await act(async () => { select.value = 'logic/main.py'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="python"]')?.value).toBe('count = 7\n');
  expect(document.body.textContent).toContain('Python');
});
