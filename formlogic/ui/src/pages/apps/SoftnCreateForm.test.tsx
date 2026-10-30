// @vitest-environment jsdom
/**
 * "Create app" → SoftN app: each way to start lands in the new app's workspace — AI Studio
 * opening on the description, the Visual Builder on the starter, or the uploaded file running,
 * whether or not that file brings a backend of its own.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { SoftnCreateForm } from './SoftnCreateForm';
import { useUIStore } from '../../stores/uiStore';

const mocks = vi.hoisted(() => ({ createSoftnApp: vi.fn(), chooseSiteAi: vi.fn(), siteAiEnabled: false, recheck: vi.fn() }));
vi.mock('../../lib/softnApps', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/softnApps')>()), createSoftnApp: mocks.createSoftnApp }));
vi.mock('../../lib/siteAi', () => ({ chooseSiteAi: mocks.chooseSiteAi }));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: mocks.siteAiEnabled } }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const path = { current: '/apps/new' };
function PathProbe() { const location = useLocation(); React.useEffect(() => { path.current = location.pathname; }); return null; }

const app = { id: 'app-1', name: 'Recipes', slug: 'recipes' };

beforeEach(() => {
  mocks.createSoftnApp.mockReset();
  mocks.chooseSiteAi.mockReset();
  mocks.recheck.mockReset();
  mocks.siteAiEnabled = false;
  mocks.createSoftnApp.mockResolvedValue({ app, project: { version: 1, files: {}, assets: {}, access: 'members' } });
  useUIStore.getState().setSoftnOpen(null);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const tree = (aiReady: boolean | null) =>
  <MemoryRouter initialEntries={['/apps/new']}><PathProbe /><Routes>
    <Route path="/apps/new" element={<SoftnCreateForm aiReady={aiReady} aiReason={aiReady === false ? 'No AI service is chosen.' : null} onAiRecheck={mocks.recheck} />} />
    <Route path="/apps/:appId/softn" element={<p>workspace</p>} />
  </Routes></MemoryRouter>;
async function render(aiReady: boolean | null) {
  root = createRoot(container);
  await act(async () => root.render(tree(aiReady)));
}
/** The readiness check answering later, as it does on the page. */
async function answer(aiReady: boolean) { await act(async () => root.render(tree(aiReady))); }
const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
};
const button = (text: RegExp) => [...container.querySelectorAll('button')].find(b => text.test(b.textContent ?? '')) as HTMLButtonElement;
const choose = async (value: string) => { await act(async () => { (container.querySelector(`input[value="${value}"]`) as HTMLInputElement).click(); }); };

describe('SoftnCreateForm', () => {
  it('builds with AI: creates the app with the starter and opens AI Studio on the description', async () => {
    await render(true);
    await type(container.querySelector('#softn-app-name') as HTMLInputElement, 'Recipes');
    expect(button(/Create and build with AI/).disabled).toBe(true);
    await type(container.querySelector('#softn-app-request') as HTMLTextAreaElement, 'A recipe box with favourites.');
    await act(async () => button(/Create and build with AI/).click());
    expect(mocks.createSoftnApp).toHaveBeenCalledWith({ name: 'Recipes', description: 'A recipe box with favourites.', start: { kind: 'starter' } });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-1', editor: 'studio', brief: { prompt: 'A recipe box with favourites.', kind: 'build' } });
    expect(path.current).toBe('/apps/app-1/softn');
  });

  it('starts visually without AI: the starter, opened in the Visual Builder', async () => {
    await render(false);
    // With no AI connected, the visual start is chosen and the AI one says what it needs.
    expect((container.querySelector('input[value="builder"]') as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).toContain('Needs an AI connection first.');
    await type(container.querySelector('#softn-app-name') as HTMLInputElement, 'Team Directory');
    await act(async () => button(/Create and start editing/).click());
    expect(mocks.createSoftnApp).toHaveBeenCalledWith({ name: 'Team Directory', description: undefined, start: { kind: 'starter' } });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-1', editor: 'builder' });
  });

  it('waits for the AI check before building with AI: an unknown answer is not a yes', async () => {
    await render(null);
    await type(container.querySelector('#softn-app-name') as HTMLInputElement, 'Recipes');
    await type(container.querySelector('#softn-app-request') as HTMLTextAreaElement, 'A recipe box.');
    expect(button(/Create and build with AI/).disabled).toBe(true);
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('refuses to build with AI while no AI is connected, and says why and how to connect one', async () => {
    await render(false);
    await choose('ai');
    await type(container.querySelector('#softn-app-name') as HTMLInputElement, 'Recipes');
    expect((container.querySelector('#softn-app-request') as HTMLTextAreaElement).disabled).toBe(true);
    expect(button(/Create and build with AI/).disabled).toBe(true);
    expect(container.textContent).toContain('Building with AI needs an AI connection. No AI service is chosen.');
    expect(container.querySelector('a[href="/settings#ai"]')?.textContent).toBe('Connect one');
    // Site AI is offered only where the operator offers it.
    expect(button(/Use FormLogic Site AI/)).toBeUndefined();
    await act(async () => button(/Check again/).click());
    expect(mocks.recheck).toHaveBeenCalledTimes(1);
  });

  it('moves off building with AI once the check says no AI can answer, unless the person chose it', async () => {
    await render(null);
    expect((container.querySelector('input[value="ai"]') as HTMLInputElement).checked).toBe(true);
    await answer(false);
    expect((container.querySelector('input[value="builder"]') as HTMLInputElement).checked).toBe(true);
    await act(async () => root.unmount());
    await render(null);
    // Writing the description before the check answers is choosing to build with AI.
    await type(container.querySelector('#softn-app-request') as HTMLTextAreaElement, 'A recipe box.');
    await answer(false);
    expect((container.querySelector('input[value="ai"]') as HTMLInputElement).checked).toBe(true);
  });

  it('offers Site AI in one click where the operator offers it, then checks again', async () => {
    mocks.siteAiEnabled = true;
    mocks.chooseSiteAi.mockResolvedValue({ ok: true });
    await render(false);
    await choose('ai');
    expect(container.querySelector('a[href="/settings#ai"]')?.textContent).toBe('Or connect your own');
    await act(async () => button(/Use FormLogic Site AI/).click());
    expect(mocks.chooseSiteAi).toHaveBeenCalledTimes(1);
    expect(mocks.recheck).toHaveBeenCalledTimes(1);
  });

  /** A .softn file: a manifest, its page, and any other files given. */
  const softn = (manifest: Record<string, unknown>, extra: Record<string, string> = {}, name = 'coffee.softn') =>
    new File([zipSync(Object.fromEntries(Object.entries({ 'manifest.json': JSON.stringify(manifest), 'ui/main.ui': '<Text>Hi</Text>', ...extra }).map(([path, text]) => [path, strToU8(text)])))], name);
  const pick = async (file: File) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  };

  it('uploads a .softn file as the first version, named after the app it carries unless renamed', async () => {
    await render(true);
    await choose('upload');
    expect(button(/Create from this file/).disabled).toBe(true);
    const file = softn({ name: 'Coffee Corner', main: 'ui/main.ui' });
    await pick(file);
    // An app with no backend is one this host takes: it runs in the member's browser.
    expect(container.textContent).toContain('coffee.softn · Coffee Corner · runs in the browser, no backend');
    expect((container.querySelector('#softn-app-name') as HTMLInputElement).placeholder).toBe('Coffee Corner');
    expect(button(/Create from this file/).disabled).toBe(false);
    mocks.createSoftnApp.mockRejectedValueOnce(new Error('Native project exceeds 16 MB'));
    await act(async () => button(/Create from this file/).click());
    expect(mocks.createSoftnApp).toHaveBeenCalledWith({ name: '', description: undefined, start: { kind: 'upload', file } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('exceeds 16 MB');
    expect(path.current).toBe('/apps/new');
    await act(async () => button(/Create from this file/).click());
    expect(useUIStore.getState().softnOpen).toBeNull();
    expect(path.current).toBe('/apps/app-1/softn');
  });

  it('says what is wrong with a file as soon as it is chosen, and creates nothing from it', async () => {
    await render(true);
    await choose('upload');
    await pick(new File([new Uint8Array([1])], 'broken.softn'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(button(/Create from this file/).disabled).toBe(true);
    await pick(softn({ name: 'Pages', main: 'ui/main.ui' }, { 'assets/page.html': '<script>1</script>' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('assets/page.html cannot be hosted with this app');
    expect(button(/Create from this file/).disabled).toBe(true);
    // A backend written for another SoftN host is refused before any app is made for it...
    await pick(softn({ name: 'Notes', main: 'ui/main.ui', server: { entry: 'server/main.logic', routes: [] } }, { 'server/main.logic': 'function list() {}' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('This app\'s backend is not one FormLogic runs: it was written for another SoftN host.');
    expect(button(/Create from this file/).disabled).toBe(true);
    // ...and one this host runs says so.
    await pick(softn({ name: 'Notes', main: 'ui/main.ui', server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: [] } } }, { 'server/main.logic': 'function list() {}' }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Notes · with its own backend and database');
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('takes a .softn file dropped anywhere on the form as the start', async () => {
    await render(true);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [softn({ name: 'Dropped', main: 'ui/main.ui' })] } });
    await act(async () => { (container.firstElementChild as HTMLElement).dispatchEvent(drop); });
    expect(drop.defaultPrevented).toBe(true);
    expect((container.querySelector('input[value="upload"]') as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).toContain('Dropped · runs in the browser, no backend');
  });
});
