// @vitest-environment jsdom
// The native hosting editor and the engine it shows: the server decides an app's engine again from
// every project installed (a `.py` added or removed changes it), so the editor takes the engine
// from the install answer; and after the owner stores a choice, the editor re-reads its OWN GET
// rather than showing the PUT's answer, which is merged over the hosted and native bundles.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';

const { getProject, saveProject, putEngine } = vi.hoisted(() => ({ getProject: vi.fn(), saveProject: vi.fn(), putEngine: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeProject: getProject, saveNativeProject: saveProject, putAppEngine: putEngine, getNativeRecords: vi.fn() } }));
vi.mock('./NativeSourceEditor', () => ({ NativeSourceEditor: () => <textarea /> }));
vi.mock('./NativeRecordsBrowser', () => ({ NativeRecordsBrowser: () => <p>records</p> }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: () => null }));
import { NativeEditor } from './NativeAppPanel';
import type { AppEngine, OwnerEnginePolicy } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const app = { id: 'app1', slug: 'app', name: 'App' };
const POLICY: OwnerEnginePolicy = { default: 'zipp-web-python', allowed: ['zipp-web-python', 'host-js'], installed: ['zipp-web-python', 'host-js'] };
const HOST_JS: AppEngine = { id: 'host-js', requested: 'host-js', stored: 'host-js', revision: 'r1' };
const PYTHON_REQUIRED: AppEngine = { id: 'zipp-web-python', requested: 'host-js', stored: 'host-js', reason: 'python-required', revision: 'r2' };
const project = (version: number) => ({ version, files: { 'manifest.json': '{}', 'ui/main.ui': '<Text/>' }, assets: {}, access: 'application' as const });
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com', isCodeTrustVerified: true }, isLoading: false, isInitialized: true, error: null });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); });

const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
const runsOn = () => document.body.textContent?.match(/This app runs on ([^.]+)\./)?.[1];
async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><NativeEditor app={app} onClose={() => {}} /></MemoryRouter>));
}
async function choose(value: string) {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="App engine"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
/** A change to the draft that needs no editor: the home toggle. */
async function dirty() {
  const home = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => home.click());
}

it('shows the engine the server decided from the project just installed', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, project: project(2), engine: HOST_JS, enginePolicy: POLICY } });
  saveProject.mockResolvedValue({ data: { project: project(3), engine: PYTHON_REQUIRED, enginePolicy: POLICY } });
  await mount();
  expect(runsOn()).toBe('None (host JavaScript, verified accounts)');
  await dirty();
  await act(async () => button('Publish changes')!.click());
  expect(saveProject).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('Installed version 3');
  expect(runsOn()).toBe('ZIPP (JavaScript and Python)');
  expect(document.body.textContent).toContain('This app needs Python');
  expect(getProject).toHaveBeenCalledTimes(1);
});

it('keeps the engine it had when an install answer carries none', async () => {
  getProject.mockResolvedValue({ data: { available: true, ready: true, project: project(2), engine: HOST_JS, enginePolicy: POLICY } });
  saveProject.mockResolvedValue({ data: { project: project(3) } });
  await mount();
  await dirty();
  await act(async () => button('Publish changes')!.click());
  expect(document.body.textContent).toContain('Installed version 3');
  expect(runsOn()).toBe('None (host JavaScript, verified accounts)');
});

it('re-reads its own GET after a choice is stored, rather than showing the merged PUT answer', async () => {
  // The PUT /engine answer covers the whole column — hosted AND native bundles merged — so an app
  // with Python only in its hosted deployment is told zipp-web-python there, while this native
  // project runs host-js.
  getProject.mockResolvedValueOnce({ data: { available: true, ready: true, project: project(2), engine: { ...HOST_JS, stored: null, requested: 'zipp-web-python', id: 'zipp-web-python' }, enginePolicy: POLICY } });
  putEngine.mockResolvedValue({ data: { engine: PYTHON_REQUIRED, policy: POLICY } });
  getProject.mockResolvedValueOnce({ data: { available: true, ready: true, project: project(2), engine: HOST_JS, enginePolicy: POLICY } });
  await mount();
  expect(runsOn()).toBe('ZIPP (JavaScript and Python)');
  await choose('host-js');
  expect(putEngine).toHaveBeenCalledWith('app1', 'host-js');
  expect(getProject).toHaveBeenCalledTimes(2);
  expect(runsOn()).toBe('None (host JavaScript, verified accounts)');
  expect(document.body.textContent).not.toContain('This app needs Python');
});
