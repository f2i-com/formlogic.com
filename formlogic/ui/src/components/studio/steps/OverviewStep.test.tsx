// @vitest-environment jsdom
// Escape blurs the box, and the blur commits. Clearing the draft takes effect only after the key
// event, so the blur still read the typed text and saved it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../types/app';

vi.mock('../../../lib/api', () => ({ api: { isDemoMode: () => false, isAdminActing: () => false, setAdminActing: () => {} } }));
vi.mock('../../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useAppStore } from '../../../stores/appStore';
import { OverviewStep } from './OverviewStep';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const app = { id: 'a1', name: 'Shop', slug: 'shop', description: 'Sells things', status: 'draft', settings: {} } as unknown as App;

let root: Root | null = null;
let host: HTMLElement | null = null;
let updateApp: ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateApp = vi.fn(async () => app);
  useAppStore.setState({ updateApp: updateApp as never });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <OverviewStep app={app} appForms={[]} formsById={{}} roles={[]} flows={[]} blueprint={null} memberCount={0} onStepChange={() => {}} onReloadApp={async () => {}} />
      </MemoryRouter>
    );
  });
}

function edit(box: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = box instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    box.focus();
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const press = (box: HTMLElement, key: string) => act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
const nameBox = () => document.body.querySelector<HTMLInputElement>('#studio-app-name')!;
const descriptionBox = () => document.body.querySelector<HTMLTextAreaElement>('#studio-app-description')!;

describe('Escape', () => {
  it('cancels a name being edited', async () => {
    await render();
    edit(nameBox(), 'Renamed');
    await press(nameBox(), 'Escape');

    expect(updateApp).not.toHaveBeenCalled();
    expect(nameBox().value).toBe('Shop');
  });

  it('cancels a description being edited', async () => {
    await render();
    edit(descriptionBox(), 'Something else');
    await press(descriptionBox(), 'Escape');

    expect(updateApp).not.toHaveBeenCalled();
    expect(descriptionBox().value).toBe('Sells things');
  });

  it('leaves the next edit to save as usual', async () => {
    await render();
    edit(nameBox(), 'Renamed');
    await press(nameBox(), 'Escape');
    edit(nameBox(), 'Renamed again');
    await act(async () => nameBox().blur());

    expect(updateApp).toHaveBeenCalledWith('a1', { name: 'Renamed again' });
  });
});

it('still saves on Enter and on leaving the box', async () => {
  await render();
  edit(nameBox(), 'Renamed');
  await press(nameBox(), 'Enter');
  expect(updateApp).toHaveBeenCalledWith('a1', { name: 'Renamed' });

  edit(descriptionBox(), 'New words');
  await act(async () => descriptionBox().blur());
  expect(updateApp).toHaveBeenCalledWith('a1', { description: 'New words' });
});
