// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCustomScreenRuntime } from './AppCustomScreenRuntime';
import { CustomScreenRuntime } from './CustomScreenRuntime';
import { useUIStore } from '../../stores/uiStore';

const h = vi.hoisted(() => ({ getAppResponses: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getAppResponses: h.getAppResponses, isDemoMode: () => false } }));
vi.mock('../../lib/screenCompile', () => ({
  resolveScreenAssets: async (screen: { html?: string; css?: string; js?: string }) => ({
    html: screen.html || '', css: screen.css || '', js: screen.js || '',
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ theme: 'light' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe.each(['app', 'form'] as const)('%s custom-screen document lifecycle', (kind) => {
  async function render(html: string) {
    const screen = { html, css: '.content { padding: 12px; }', js: '', _trust: 'owner' as const };
    await act(async () => {
      root.render(<StrictMode>{kind === 'app'
        ? <AppCustomScreenRuntime screen={screen} appSlug="demo" appName="Demo" forms={[{ formId: 'notes', displayName: 'Notes', fields: [], settings: {} }]} />
        : <CustomScreenRuntime screen={screen} appSlug="demo" formId="notes" formTitle="Notes" />}</StrictMode>);
    });
    return container.querySelector('iframe')!;
  }

  it('retains the live document for theme and identical-content updates, replacing it for changed content', async () => {
    const original = await render('<main>First document</main>');
    const sent = vi.spyOn(original.contentWindow!, 'postMessage');
    await act(async () => original.dispatchEvent(new Event('load')));
    const firstDocument = sent.mock.calls.find(([message]) => message.__flScreenDoc)?.[0].__flScreenDoc as string;
    const firstGeneration = Number(firstDocument.match(/var __flGen=(\d+)/)?.[1]);
    expect(firstDocument).toContain('First document');

    await act(async () => useUIStore.setState({ theme: 'dark' }));
    expect(container.querySelector('iframe')).toBe(original);
    expect(sent).toHaveBeenCalledWith({ __flTheme: 'dark' }, '*');
    expect(await render('<main>First document</main>')).toBe(original);

    const replacement = await render('<main>Second document</main>');
    expect(replacement).not.toBe(original);
    const replacementSent = vi.spyOn(replacement.contentWindow!, 'postMessage');
    await act(async () => replacement.dispatchEvent(new Event('load')));
    const secondDocument = replacementSent.mock.calls.find(([message]) => message.__flScreenDoc)?.[0].__flScreenDoc as string;
    expect(secondDocument).toContain('Second document');
    expect(secondDocument).toContain('<html class="fl-dark">');
    expect(secondDocument).toContain(`var __flGen=${firstGeneration + 1};`);

    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      source: replacement.contentWindow,
      data: { __fl: true, action: 'context', id: 'previous-document', gen: firstGeneration },
    })));
    expect(replacementSent).toHaveBeenCalledWith({
      __flReply: true, id: 'previous-document', error: 'This screen was reloaded — request ignored.',
    }, '*');
  });

  it('keeps a pending API reply from reaching a replacement document', async () => {
    let finish!: (result: unknown) => void;
    h.getAppResponses.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const original = await render('<main>First document</main>');
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      source: original.contentWindow,
      data: { __fl: true, action: 'records', id: 'pending', gen: 0, payload: { formId: 'notes' } },
    })));
    expect(h.getAppResponses).toHaveBeenCalledOnce();
    const replacement = await render('<main>Second document</main>');
    const sent = vi.spyOn(replacement.contentWindow!, 'postMessage');
    await act(async () => finish({ data: { responses: [{ id: 'old-record', answers: { name: 'Previous screen' } }] } }));
    expect(sent.mock.calls.some(([message]) => message.__flReply && message.id === 'pending')).toBe(false);
  });
});
