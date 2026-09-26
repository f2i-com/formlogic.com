// @vitest-environment jsdom
/**
 * "Create app" → SoftN app: each way to start lands in the new app's workspace — AI Studio
 * opening on the description, the Visual Builder on the starter, or the uploaded file running.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoftnCreateForm } from './SoftnCreateForm';
import { useUIStore } from '../../stores/uiStore';

const mocks = vi.hoisted(() => ({ createSoftnApp: vi.fn() }));
vi.mock('../../lib/softnApps', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/softnApps')>()), createSoftnApp: mocks.createSoftnApp }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const path = { current: '/apps/new' };
function PathProbe() { const location = useLocation(); React.useEffect(() => { path.current = location.pathname; }); return null; }

const app = { id: 'app-1', name: 'Recipes', slug: 'recipes' };

beforeEach(() => {
  mocks.createSoftnApp.mockReset();
  mocks.createSoftnApp.mockResolvedValue({ app, project: { version: 1, files: {}, assets: {}, access: 'members' } });
  useUIStore.getState().setSoftnOpen(null);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render(aiReady: boolean | null) {
  root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/apps/new']}><PathProbe /><Routes>
      <Route path="/apps/new" element={<SoftnCreateForm aiReady={aiReady} />} />
      <Route path="/apps/:appId/softn" element={<p>workspace</p>} />
    </Routes></MemoryRouter>,
  ));
}
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
    expect(container.textContent).toContain('Connect an AI first');
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

  it('refuses to build with AI while no AI is connected', async () => {
    await render(false);
    await choose('ai');
    await type(container.querySelector('#softn-app-name') as HTMLInputElement, 'Recipes');
    expect((container.querySelector('#softn-app-request') as HTMLTextAreaElement).disabled).toBe(true);
    expect(button(/Create and build with AI/).disabled).toBe(true);
  });

  it('uploads a .softn file as the first version, and shows why a file was refused', async () => {
    await render(true);
    await choose('upload');
    await type(container.querySelector('#softn-app-name') as HTMLInputElement, 'Coffee');
    expect(button(/Create from this file/).disabled).toBe(true);
    const file = new File([new Uint8Array([1])], 'coffee.softn');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('coffee.softn');
    mocks.createSoftnApp.mockRejectedValueOnce(new Error('This app has no native server entry.'));
    await act(async () => button(/Create from this file/).click());
    expect(mocks.createSoftnApp).toHaveBeenCalledWith({ name: 'Coffee', description: undefined, start: { kind: 'upload', file } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no native server entry');
    expect(path.current).toBe('/apps/new');
    await act(async () => button(/Create from this file/).click());
    expect(useUIStore.getState().softnOpen).toBeNull();
    expect(path.current).toBe('/apps/app-1/softn');
  });
});
