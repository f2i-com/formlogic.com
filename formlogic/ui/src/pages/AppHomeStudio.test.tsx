// @vitest-environment jsdom
// The live preview runs the code being edited. Code the owner starts here runs with the trust a
// save gives it ('owner'): otherwise records(), submit(), currentUser() and navigate() are refused
// in the preview as if the owner's own code were an imported, unverified screen. An imported home
// stays on its stored trust while it is edited (one keystroke used to make it the owner's in the
// preview, with real records and real writes), and takes the server's trust once saved.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomScreen } from '../types/form';

const previews: CustomScreen[] = [];
vi.mock('../components/custom-screen/AppCustomScreenRuntime', () => ({
  AppCustomScreenRuntime: ({ screen }: { screen: CustomScreen }) => { previews.push(screen); return null; },
}));
// The editor, reduced to one edit: a key typed into the first file.
vi.mock('../components/custom-screen/ScreenFilesEditor', () => ({
  ScreenFilesEditor: ({ files, onChange }: { files: Array<{ path: string; content: string }>; onChange: (files: Array<{ path: string; content: string }>) => void }) => (
    <button type="button" onClick={() => onChange(files.map((f, i) => (i === 0 ? { ...f, content: f.content + ' ' } : f)))}>edit</button>
  ),
}));
vi.mock('../components/chat/SiteChatWidget', () => ({ SiteChatWidget: () => null }));
vi.mock('../client-runtime/flows/aiDefault', () => ({ getAiPreferences: () => Promise.resolve({ ok: false }) }));
vi.mock('../lib/screenCompile', () => ({
  bundleScreenFiles: vi.fn(async () => ({ html: '<div id="app"></div>', css: '', js: 'void 0;' })),
}));

import { api } from '../lib/api';
import { isScreenSdkActionAllowed } from '../components/custom-screen/sdkRuntime';
import AppHomeStudio from './AppHomeStudio';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  previews.length = 0;
  vi.spyOn(api, 'getAIStatus').mockResolvedValue({ data: { available: false } } as Awaited<ReturnType<typeof api.getAIStatus>>);
  vi.spyOn(api, 'getAppForms').mockResolvedValue({ data: { forms: [{ formId: 'f1', displayName: 'Orders' }] } } as unknown as Awaited<ReturnType<typeof api.getAppForms>>);
  vi.spyOn(api, 'getForm').mockResolvedValue({ data: { form: { fields: [] } } } as unknown as Awaited<ReturnType<typeof api.getForm>>);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

async function open(customScreen?: CustomScreen) {
  vi.spyOn(api, 'getApp').mockResolvedValue({ data: { app: { name: 'Shop', slug: 'shop', customScreen } } } as Awaited<ReturnType<typeof api.getApp>>);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={['/apps/a1/home/edit']}>
        <Routes><Route path="/apps/:appId/home/edit" element={<AppHomeStudio />} /></Routes>
      </MemoryRouter>,
    );
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('AppHomeStudio live preview', () => {
  it('runs code the owner starts here with the trust a save gives it', async () => {
    await open();
    const starter = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes('HTML + TypeScript'));
    expect(starter).toBeTruthy();
    await act(async () => { starter!.click(); });
    // The preview rebuilds after a short pause in typing.
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));

    const preview = previews.at(-1);
    expect(preview?.js).toBe('void 0;');
    expect(isScreenSdkActionAllowed(preview?._trust, 'records')).toBe(true);
  });

  it('keeps the stored trust of a home it has not edited yet', async () => {
    // Opening the editor is not adopting the code: an imported screen stays visual-only.
    await open({ enabled: true, html: '<p>hi</p>', js: 'void 0;', _trust: 'untrusted' });
    expect(previews.at(-1)?._trust).toBe('untrusted');
  });

  const click = async (label: string) => {
    const button = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no button ${label}`);
    await act(async () => { button.click(); });
  };

  it('keeps an imported home visual-only while it is edited, until it is saved', async () => {
    await open({ enabled: true, html: '<p>hi</p>', js: 'void 0;', _trust: 'untrusted' });
    await click('edit');
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(previews.at(-1)?.js).toBe('void 0;');
    expect(isScreenSdkActionAllowed(previews.at(-1)?._trust, 'records')).toBe(false);
    expect(isScreenSdkActionAllowed(previews.at(-1)?._trust, 'submit')).toBe(false);
    expect(host!.textContent).toContain('until you save it');

    vi.spyOn(api, 'updateApp').mockResolvedValue({ data: { app: { customScreen: { enabled: true, _trust: 'owner' } } } } as Awaited<ReturnType<typeof api.updateApp>>);
    await click('Save');
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(isScreenSdkActionAllowed(previews.at(-1)?._trust, 'records')).toBe(true);
  });
});
