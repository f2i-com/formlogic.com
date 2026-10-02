// @vitest-environment jsdom
// The runtime preflight's verdict decides whether the owner may publish; its warnings do not. A host
// without the sqlite3 PHP extension runs native apps (first installs and serving need none), so the
// panel says what is limited and keeps Publish and Install; a check that genuinely fails still
// lists itself and disables them.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';

const { getProject, saveProject } = vi.hoisted(() => ({ getProject: vi.fn(), saveProject: vi.fn() }));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
vi.mock('../../lib/api', () => ({ api: { getNativeProject: getProject, saveNativeProject: saveProject, getNativeRecords: vi.fn() } }));
vi.mock('./NativeSourceEditor', () => ({ NativeSourceEditor: ({ value, onChange, label, readOnly }: { value: string; onChange(value: string): void; label: string; readOnly?: boolean }) => <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }));
vi.mock('./NativeRecordsBrowser', () => ({ NativeRecordsBrowser: () => <p>records</p> }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: () => <p>editor</p> }));
import { NativeEditor } from './NativeAppPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const app = { id: 'app1', slug: 'app', name: 'App' };
const project = (version: number) => ({ version, files: { 'manifest.json': '{}', 'server/main.logic': 'original()', 'ui/main.ui': '<Text>Hi</Text>' }, assets: {}, access: 'application' as const });
const SQLITE3 = 'The sqlite3 PHP extension is not loaded. Apps can be installed for the first time and served without it, but updating an app that already has a database needs it to restore that database if the update fails. Enable it (the php-sqlite3 package, or extension=sqlite3 in php.ini).';
const FILES = 'Native runtime is not prepared; missing runner.mjs (run scripts/prepare-native-runtime.mjs)';
const preflight = (checks: Array<{ id: string; ok: boolean; warning?: boolean; message: string }>, warnings: string[]) => ({
  ok: !checks.some(check => !check.ok && !check.warning), cached: false, checkedAt: '2026-10-02T00:00:00+00:00', checks, warnings, runtime: {},
});
const sqlite3Warning = { id: 'php.sqlite3', ok: false, warning: true, message: SQLITE3 };
const filesFailure = { id: 'runtime.files', ok: false, message: FILES };
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com' }, isLoading: false, isInitialized: true, error: null });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); });

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><NativeEditor app={app} initialTab="project" onClose={vi.fn()} /></MemoryRouter>));
}
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const tab = (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(node => node.textContent === label)!.click());
const warnings = () => document.querySelector('[role="note"][aria-label="Native runtime warnings"]');
const failures = () => document.querySelector('[role="alert"]');
async function edit() {
  await tab('backend');
  await act(async () => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private backend source"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'changed()');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('a missing sqlite3 is a warning: the panel says what is limited and keeps Publish', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, preflight: preflight([{ id: 'php.proc_open', ok: true, message: 'ok' }, sqlite3Warning, { id: 'worker.startup', ok: true, message: 'ok' }], [SQLITE3]), project: project(2), readOnly: false } });
  await mount();
  expect(warnings()?.textContent).toContain('The native runtime works here, with a limit.');
  expect(warnings()?.textContent).toContain('updating an app that already has a database needs it');
  expect(warnings()?.textContent).toContain('php-sqlite3');
  // Nothing is reported as failing or as unable to start.
  expect(failures()).toBeNull();
  expect(document.body.textContent).not.toContain('cannot start on this server yet');
  expect(button('Import .softn project')!.hasAttribute('disabled')).toBe(false);
  await edit();
  expect(button('Publish changes')!.hasAttribute('disabled')).toBe(false);
});

it('the same warning leaves a first install possible too', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, preflight: preflight([sqlite3Warning], [SQLITE3]), project: project(0), readOnly: false } });
  await mount();
  expect(warnings()).not.toBeNull();
  await edit();
  expect(button('Publish changes')).toBeUndefined();
  expect(button('Install app project')!.hasAttribute('disabled')).toBe(false);
});

it('a failed check still lists itself and disables Publish', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: false, preflight: preflight([filesFailure], []), project: project(2), readOnly: false } });
  await mount();
  expect(failures()?.textContent).toContain('cannot start on this server yet');
  expect(failures()?.textContent).toContain('runtime.files');
  expect(failures()?.textContent).toContain(FILES);
  expect(warnings()).toBeNull();
  await edit();
  expect(button('Publish changes')!.hasAttribute('disabled')).toBe(true);
});

it('with a failed check and the warning, the warning is not listed as a failure and Publish stays disabled', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: false, preflight: preflight([sqlite3Warning, filesFailure], [SQLITE3]), project: project(2), readOnly: false } });
  await mount();
  expect(failures()?.textContent).toContain('runtime.files');
  expect(failures()?.textContent).not.toContain('php.sqlite3');
  expect(warnings()?.textContent).toContain('php-sqlite3');
  await edit();
  expect(button('Publish changes')!.hasAttribute('disabled')).toBe(true);
});

it('an older answer without warnings shows none', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, preflight: { ok: true, cached: true, checkedAt: '2026-10-02T00:00:00+00:00', checks: [], runtime: {} }, project: project(2), readOnly: false } });
  await mount();
  expect(warnings()).toBeNull();
  expect(failures()).toBeNull();
});

it('the shared demo is not shown warnings: it runs no preflight', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: false, preflight: null, project: project(2), readOnly: true } });
  await mount();
  expect(warnings()).toBeNull();
});
