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

vi.mock('../../client-runtime/flows/aiDefault', () => ({ resolveDefaultLlm: vi.fn(), resolveDefaultLlmTools: vi.fn(), TOOLS_UNSUPPORTED: 'tools-unsupported' }));
vi.mock('fflate', () => ({
  unzipSync: () => ({ 'manifest.json': new TextEncoder().encode('{"name":"App","files":{}}') }),
  zipSync: () => new Uint8Array([1, 2, 3]),
  strFromU8: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  strToU8: (text: string) => new TextEncoder().encode(text),
}));
import { AppEditorDialog, type AppEditorKind } from './AppEditorDialog';
import { resolveDefaultLlm, resolveDefaultLlmTools } from '../../client-runtime/flows/aiDefault';

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

async function mount(onApply: (bytes: Uint8Array) => Promise<void>, kind: AppEditorKind = 'builder', ready: Record<string, unknown> = { kind: 'formlogic-editor-ready', protocol: 1 }) {
  root = createRoot(container);
  const onClose = vi.fn();
  await act(async () => root!.render(<AppEditorDialog kind={kind} name="App" bundle={new Uint8Array([9])} onApply={onApply} onClose={onClose} />));
  const iframe = document.body.querySelector('iframe')!;
  const toFrame = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  // The editor announces itself; the dialog opens a port and sends `open`.
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: location.origin, source: iframe.contentWindow }));
  });
  const port = channels[0].port1;
  const sent = () => port.postMessage.mock.calls.map(call => call[0] as { kind?: string; id?: string; method?: string; ok?: boolean; error?: string; code?: string; value?: unknown });
  const editorSays = async (data: unknown) => { await act(async () => { port.onmessage?.({ data }); }); };
  const connect = () => toFrame.mock.calls.map(call => call[0] as Record<string, unknown>).find(m => m.kind === 'formlogic-editor-connect');
  return { port, sent, editorSays, onClose, connect };
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

describe('AppEditorDialog AI requests (the bridge capability aiTools)', () => {
  const TOOLS = [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const NEW_STUDIO = { kind: 'formlogic-editor-ready', protocol: 1, aiTools: 1 };
  const responses = (sent: () => Array<{ kind?: string }>) => sent().filter(m => m.kind === 'ai-response');

  it('offers aiTools back to a Studio that announced it, and answers a scripted tool conversation with the structured reply', async () => {
    const reply = { text: '', toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'ui/app.ui' } }], stopReason: 'tool_calls', usage: { inputTokens: 310, outputTokens: 22 } };
    vi.mocked(resolveDefaultLlmTools).mockResolvedValue({ ok: true, data: { source: 'custom', ...reply } });
    const { sent, editorSays, connect } = await mount(vi.fn(async () => {}), 'studio', NEW_STUDIO);
    expect(connect()).toEqual({ kind: 'formlogic-editor-connect', protocol: 1, aiTools: 1 });

    const messages = [
      { role: 'system', content: 'You edit Softn apps.' },
      { role: 'user', content: 'What is on the main screen?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'ui/main.ui' } }] },
      { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'No such file.', isError: true },
    ];
    await editorSays({ kind: 'ai-request', id: 'ai-1', aiTools: 1, messages, tools: TOOLS, maxOutputTokens: 16384 });
    expect(resolveDefaultLlm).not.toHaveBeenCalled();
    expect(vi.mocked(resolveDefaultLlmTools).mock.calls[0][0]).toMatchObject({ messages, tools: TOOLS, maxOutputTokens: 16384 });
    // The provider's source label stays on this side; the editor gets the bridge reply shape only.
    expect(responses(sent)).toEqual([{ kind: 'ai-response', id: 'ai-1', ok: true, value: reply }]);
  });

  it('answers tools-unsupported with its code, so Studio carries on in text', async () => {
    vi.mocked(resolveDefaultLlmTools).mockResolvedValue({ ok: false, error: { code: 'tools-unsupported', message: 'FormLogic Desktop answers in text.' } });
    const { sent, editorSays } = await mount(vi.fn(async () => {}), 'studio', NEW_STUDIO);
    await editorSays({ kind: 'ai-request', id: 'ai-2', aiTools: 1, messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS });
    expect(responses(sent)).toEqual([{ kind: 'ai-response', id: 'ai-2', ok: false, error: 'FormLogic Desktop answers in text.', code: 'tools-unsupported' }]);
  });

  it('passes other failures on without a code', async () => {
    vi.mocked(resolveDefaultLlmTools).mockResolvedValue({ ok: false, error: { code: 'ai_allowance_exceeded', message: 'Used up.' } });
    const { sent, editorSays } = await mount(vi.fn(async () => {}), 'studio', NEW_STUDIO);
    await editorSays({ kind: 'ai-request', id: 'ai-3', aiTools: 1, messages: [{ role: 'user', content: 'Hi' }] });
    expect(responses(sent)).toEqual([{ kind: 'ai-response', id: 'ai-3', ok: false, error: 'Used up.' }]);
  });

  it('refuses invalid structured shapes before asking any provider', async () => {
    const { sent, editorSays } = await mount(vi.fn(async () => {}), 'studio', NEW_STUDIO);
    const bad = [
      { aiTools: 2, messages: [{ role: 'user', content: 'Hi' }] },
      { aiTools: 1, messages: [{ role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'orphan' }] },
      { aiTools: 1, messages: [{ role: 'user', content: 'Hi' }], tools: [{ name: 'bad name', description: '', inputSchema: { type: 'object' } }] },
      { aiTools: 1, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_file', arguments: '{"path":"a"}' }] }] },
    ];
    for (const [i, request] of bad.entries()) await editorSays({ kind: 'ai-request', id: `bad-${i}`, ...request });
    expect(resolveDefaultLlmTools).not.toHaveBeenCalled();
    const answers = responses(sent) as Array<{ ok: boolean; error: string; code?: string }>;
    expect(answers).toHaveLength(bad.length);
    for (const answer of answers) {
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(/^Invalid AI request/);
      expect(answer.code).toBeUndefined();
    }
  });

  it('keeps an old Studio exactly as before: no aiTools in the handshake, text in, a string out', async () => {
    vi.mocked(resolveDefaultLlm).mockResolvedValue({ ok: true, data: { source: 'site', content: '<tool_call>{}</tool_call>' } });
    const { sent, editorSays, connect } = await mount(vi.fn(async () => {}), 'studio');
    expect(connect()).toEqual({ kind: 'formlogic-editor-connect', protocol: 1 });
    const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }];
    await editorSays({ kind: 'ai-request', id: 'old-1', messages });
    expect(vi.mocked(resolveDefaultLlm).mock.calls[0][0]).toMatchObject({ messages });
    expect(resolveDefaultLlmTools).not.toHaveBeenCalled();
    expect(responses(sent)).toEqual([{ kind: 'ai-response', id: 'old-1', ok: true, value: '<tool_call>{}</tool_call>' }]);

    // Its check is unchanged: a tool role or non-string content is still refused.
    await editorSays({ kind: 'ai-request', id: 'old-2', messages: [{ role: 'tool', content: 'x' }] });
    await editorSays({ kind: 'ai-request', id: 'old-3', messages: [{ role: 'user', content: { text: 'x' } }] });
    expect(responses(sent).slice(1)).toEqual([
      { kind: 'ai-response', id: 'old-2', ok: false, error: 'AI is busy or the request is too large.' },
      { kind: 'ai-response', id: 'old-3', ok: false, error: 'AI is busy or the request is too large.' },
    ]);
  });

  it('refuses a structured request from an editor it did not offer aiTools to, as tools-unsupported', async () => {
    const { sent, editorSays } = await mount(vi.fn(async () => {}), 'studio');
    await editorSays({ kind: 'ai-request', id: 'x-1', aiTools: 1, messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS });
    expect(resolveDefaultLlmTools).not.toHaveBeenCalled();
    expect(responses(sent)).toEqual([{ kind: 'ai-response', id: 'x-1', ok: false, error: 'FormLogic did not offer AI tool calls to this editor.', code: 'tools-unsupported' }]);
  });

  it('never offers aiTools to the Builder, which asks no AI', async () => {
    const { connect } = await mount(vi.fn(async () => {}), 'builder', NEW_STUDIO);
    expect(connect()).toEqual({ kind: 'formlogic-editor-connect', protocol: 1 });
  });
});
