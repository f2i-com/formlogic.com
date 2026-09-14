// @vitest-environment jsdom
/**
 * Audit SN-04: the hosted editor's "save-requested" must be acknowledged with
 * the real outcome — taken into the draft, refused with a reason, or not yet
 * connected — over the same port, so the editor can never show "saved" for a
 * request this side dropped.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client-runtime/flows/aiDefault', () => ({ resolveDefaultLlm: vi.fn() }));
vi.mock('fflate', () => ({
  unzipSync: () => ({ 'manifest.json': new TextEncoder().encode('{"name":"App","files":{}}') }),
  zipSync: () => new Uint8Array([1, 2, 3]),
  strFromU8: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  strToU8: (text: string) => new TextEncoder().encode(text),
}));
import { AppEditorDialog } from './AppEditorDialog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const channels: Array<{ port1: { postMessage: ReturnType<typeof vi.fn>; close: () => void; start: () => void; onmessage: ((e: { data: unknown }) => void) | null } }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  channels.length = 0;
  vi.stubGlobal('MessageChannel', class {
    port1 = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null as ((e: { data: unknown }) => void) | null };
    port2 = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null };
    constructor() { channels.push(this); }
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(onApply: (bytes: Uint8Array) => Promise<void>) {
  root = createRoot(container);
  const onClose = vi.fn();
  await act(async () => root!.render(<AppEditorDialog kind="builder" name="App" bundle={new Uint8Array([9])} onApply={onApply} onClose={onClose} />));
  const iframe = document.body.querySelector('iframe')!;
  vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  // The editor announces itself; the dialog opens a port and sends `open`.
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { kind: 'formlogic-editor-ready', protocol: 1 }, origin: location.origin, source: iframe.contentWindow }));
  });
  const port = channels[0].port1;
  const sent = () => port.postMessage.mock.calls.map(call => call[0] as { kind?: string; id?: string; method?: string; ok?: boolean; error?: string });
  const editorSays = async (data: unknown) => { await act(async () => { port.onmessage?.({ data }); }); };
  return { port, sent, editorSays, onClose };
}

describe('AppEditorDialog save acknowledgement', () => {
  it('refuses a save requested before the editor opened the app, with a reason', async () => {
    const onApply = vi.fn(async () => {});
    const { sent, editorSays } = await mount(onApply);
    await editorSays({ kind: 'save-requested', id: 'save-early' });
    const result = sent().find(m => m.kind === 'save-result');
    expect(result).toMatchObject({ id: 'save-early', ok: false });
    expect(result?.error).toMatch(/not connected/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('acknowledges success only after the draft was taken, and failure with its message', async () => {
    const onApply = vi.fn(async () => {});
    const { sent, editorSays, onClose } = await mount(onApply);
    // Complete the `open` handshake.
    const open = sent().find(m => m.method === 'open')!;
    await editorSays({ id: open.id, ok: true, value: { opened: true } });

    await editorSays({ kind: 'save-requested', id: 'save-1' });
    // The dialog asks the editor to export; nothing is acknowledged yet.
    const exportRequest = sent().find(m => m.method === 'export')!;
    expect(sent().filter(m => m.kind === 'save-result')).toHaveLength(0);
    await editorSays({ id: exportRequest.id, ok: true, value: new Uint8Array([4, 5]) });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(sent().filter(m => m.kind === 'save-result')).toEqual([{ kind: 'save-result', id: 'save-1', ok: true }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a rejected draft (for example a version conflict) instead of claiming success', async () => {
    const onApply = vi.fn(async () => { throw new Error('The project changed. Reload before importing.'); });
    const { sent, editorSays, onClose } = await mount(onApply);
    const open = sent().find(m => m.method === 'open')!;
    await editorSays({ id: open.id, ok: true, value: { opened: true } });
    await editorSays({ kind: 'save-requested', id: 'save-2' });
    const exportRequest = sent().find(m => m.method === 'export')!;
    await editorSays({ id: exportRequest.id, ok: true, value: new Uint8Array([4, 5]) });
    expect(sent().filter(m => m.kind === 'save-result')).toEqual([{ kind: 'save-result', id: 'save-2', ok: false, error: 'The project changed. Reload before importing.' }]);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('The project changed.');
  });
});
