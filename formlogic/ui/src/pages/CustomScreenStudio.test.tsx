// @vitest-environment jsdom
// Opening a screen in the Studio is not adopting it, and neither is typing in it. An imported
// screen previews with the trust the server stored for it, so an untrusted one stays visual-only:
// its records(), submit(), currentUser() and record() are refused, as they are wherever it runs.
// The preview frame can navigate itself, so records() handed to imported code can leave the
// browser, and submit() writes a real record. One keystroke used to give the imported code owner
// trust in the preview. Now the preview takes the trust the server gives the screen when it is
// saved; code the owner starts here from blank or a starter previews as the owner's at once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomScreen } from '../types/form';

const previews: Array<{ screen: CustomScreen; record?: unknown }> = [];
vi.mock('../components/custom-screen/CustomScreenRuntime', () => ({
  CustomScreenRuntime: (props: { screen: CustomScreen; record?: unknown }) => { previews.push(props); return null; },
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
  bundleScreenFiles: vi.fn(async () => ({ html: '<div id="root"></div>', css: '', js: 'void 1;' })),
}));

import { api } from '../lib/api';
import { isScreenSdkActionAllowed } from '../components/custom-screen/sdkRuntime';
import CustomScreenStudio from './CustomScreenStudio';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  previews.length = 0;
  vi.spyOn(api, 'getAIStatus').mockResolvedValue({ data: { available: false } } as Awaited<ReturnType<typeof api.getAIStatus>>);
  vi.spyOn(api, 'getResponses').mockResolvedValue({ data: { responses: [], count: 0 } } as unknown as Awaited<ReturnType<typeof api.getResponses>>);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const settle = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function open(trust: CustomScreen['_trust']) {
  vi.spyOn(api, 'getForm').mockResolvedValue({
    data: {
      form: {
        id: 'f1', title: 'Orders', fields: [],
        customScreen: {
          enabled: true, html: '<div id="root"></div>', js: 'void 0;', _trust: trust,
          recordScreen: { kind: 'code', html: '<div id="root"></div>', js: 'void 0;' },
        },
      },
    },
  } as unknown as Awaited<ReturnType<typeof api.getForm>>);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={['/forms/f1/screen/edit']}>
        <Routes><Route path="/forms/:formId/screen/edit" element={<CustomScreenStudio />} /></Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

const click = async (label: string) => {
  const button = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(label));
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => { button.click(); });
};
const sectionPreview = () => previews.filter((p) => p.record === undefined).at(-1)?.screen;
const recordPreview = () => previews.filter((p) => p.record !== undefined).at(-1)?.screen;

describe('CustomScreenStudio live preview trust', () => {
  it('previews an imported untrusted screen with its stored trust, so the SDK refuses it', async () => {
    await open('untrusted');
    expect(sectionPreview()?._trust).toBe('untrusted');
    expect(isScreenSdkActionAllowed(sectionPreview()?._trust, 'records')).toBe(false);
  });

  it('keeps an imported screen visual-only while it is edited, and says why', async () => {
    await open('untrusted');
    await click('edit');
    await settle(600); // the preview rebuilds after a pause in typing
    expect(sectionPreview()?.js).toBe('void 1;');
    expect(isScreenSdkActionAllowed(sectionPreview()?._trust, 'records')).toBe(false);
    expect(isScreenSdkActionAllowed(sectionPreview()?._trust, 'submit')).toBe(false);
    expect(host!.textContent).toContain('until you save it');
  });

  it('previews with the trust the server gives the screen once it is saved', async () => {
    await open('untrusted');
    await click('edit');
    await settle(600);
    const update = vi.spyOn(api, 'updateForm').mockResolvedValue({
      data: { form: { id: 'f1', customScreen: { enabled: true, _trust: 'owner' } } },
    } as unknown as Awaited<ReturnType<typeof api.updateForm>>);
    await click('Save');
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(isScreenSdkActionAllowed(sectionPreview()?._trust, 'records')).toBe(true);
    expect(host!.textContent).not.toContain('until you save it');
  });

  it('keeps the record widget on its stored trust when the Studio switches to it or it is edited', async () => {
    await open('untrusted');
    await click('Record widget');
    await settle(600);
    expect(recordPreview()?.js).toBe('void 1;');
    expect(isScreenSdkActionAllowed(recordPreview()?._trust, 'record')).toBe(false);
    await click('edit');
    await settle(600);
    expect(isScreenSdkActionAllowed(recordPreview()?._trust, 'record')).toBe(false);
  });

  it('still previews the owner’s own saved screen with owner trust', async () => {
    await open('owner');
    expect(isScreenSdkActionAllowed(sectionPreview()?._trust, 'records')).toBe(true);
  });
});
