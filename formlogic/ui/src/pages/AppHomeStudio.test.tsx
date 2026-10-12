// @vitest-environment jsdom
// The live preview runs the code being edited. Saving it stamps 'owner' trust on the server, so the
// preview runs with that trust too: otherwise records(), submit(), currentUser() and navigate() are
// refused in the preview as if the owner's own code were an imported, unverified screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomScreen } from '../types/form';

const previews: CustomScreen[] = [];
vi.mock('../components/custom-screen/AppCustomScreenRuntime', () => ({
  AppCustomScreenRuntime: ({ screen }: { screen: CustomScreen }) => { previews.push(screen); return null; },
}));
vi.mock('../components/custom-screen/ScreenFilesEditor', () => ({ ScreenFilesEditor: () => null }));
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
    // Opening the editor is not adopting the code: an imported screen stays visual-only until edited.
    await open({ enabled: true, html: '<p>hi</p>', js: 'void 0;', _trust: 'untrusted' });
    expect(previews.at(-1)?._trust).toBe('untrusted');
  });
});
