// @vitest-environment jsdom
/**
 * The bridge's `agentRuns` capability on FormLogic's side: a Studio that announced it is sent
 * the person's request with the app and connected with agentRuns; its status reports drive the
 * dialog (what the AI is doing, "review" held while it builds, what it did). A Studio from before
 * agentRuns is never sent a brief: the request is shown for the owner to paste instead.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client-runtime/flows/aiDefault', () => ({ resolveDefaultLlm: vi.fn(), resolveDefaultLlmTools: vi.fn(), TOOLS_UNSUPPORTED: 'tools-unsupported' }));
vi.mock('fflate', () => ({
  unzipSync: () => ({ 'manifest.json': new TextEncoder().encode('{"name":"App","files":{}}') }),
  zipSync: () => new Uint8Array([1, 2, 3]),
  strFromU8: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  strToU8: (text: string) => new TextEncoder().encode(text),
}));
import { AppEditorDialog } from './AppEditorDialog';
import { readAgentStatus, type EditorBrief } from './editorAgent';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const channels: Array<{ port1: { postMessage: ReturnType<typeof vi.fn>; close: () => void; start: () => void; onmessage: ((e: { data: unknown }) => void) | null } }> = [];

beforeEach(() => {
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

async function mount({ brief, agentRuns }: { brief?: EditorBrief; agentRuns?: number }) {
  root = createRoot(container);
  await act(async () => root!.render(<AppEditorDialog kind="studio" name="Recipes" bundle={new Uint8Array([9])} brief={brief} applyLabel="Save changes" onApply={async () => {}} onClose={() => {}} />));
  const iframe = document.body.querySelector('iframe')!;
  const toFrame = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  const ready = { kind: 'formlogic-editor-ready', protocol: 1, aiTools: 1, ...(agentRuns !== undefined ? { agentRuns } : {}) };
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: ready, origin: location.origin, source: iframe.contentWindow })); });
  const port = channels[0].port1;
  const sent = () => port.postMessage.mock.calls.map(call => call[0] as Record<string, unknown>);
  const editorSays = async (data: unknown) => { await act(async () => { port.onmessage?.({ data }); }); };
  const open = async () => { const request = sent().find(m => m.method === 'open')!; await editorSays({ id: request.id, ok: true, value: { opened: true } }); return request; };
  const connect = () => toFrame.mock.calls.map(call => call[0] as Record<string, unknown>).find(m => m.kind === 'formlogic-editor-connect');
  const apply = () => [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('Save changes')) as HTMLButtonElement;
  const status = () => document.body.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '';
  return { sent, editorSays, open, connect, apply, status };
}

const BRIEF: EditorBrief = { prompt: 'Build a recipe box with favourites.', kind: 'build' };

describe('a Studio that announced agentRuns', () => {
  it('is connected with agentRuns and sent the request with the app', async () => {
    const { connect, open } = await mount({ brief: BRIEF, agentRuns: 1 });
    expect(connect()).toMatchObject({ kind: 'formlogic-editor-connect', protocol: 1, aiTools: 1, agentRuns: 1 });
    expect((await open()).brief).toEqual(BRIEF);
    expect(document.body.textContent).not.toContain('paste yours');
  });

  it('shows what the AI is doing, holds the save while it builds, and says what it did', async () => {
    const { editorSays, open, apply, status } = await mount({ brief: BRIEF, agentRuns: 1 });
    await open();
    expect(apply().disabled).toBe(false);
    await editorSays({ kind: 'agent-status', state: 'running', step: 'Checking the app…' });
    expect(status()).toContain('AI Studio is building your app: Checking the app…');
    expect(apply().disabled).toBe(true);
    await editorSays({ kind: 'agent-status', state: 'finished', summary: 'Built a recipe box with favourites.' });
    expect(status()).toContain('Done: Built a recipe box with favourites.');
    expect(status()).toContain('Save changes');
    expect(apply().disabled).toBe(false);
  });

  it('ignores a status that is not one', async () => {
    const { editorSays, open, status } = await mount({ agentRuns: 1 });
    await open();
    await editorSays({ kind: 'agent-status', state: 'celebrating' });
    expect(status()).toBe('');
  });
});

describe('a Studio from before agentRuns', () => {
  it('is never sent the request, nor connected with agentRuns, and the owner is shown it to paste', async () => {
    const { connect, open } = await mount({ brief: BRIEF });
    expect(connect()).not.toHaveProperty('agentRuns');
    expect((await open()).brief).toBeUndefined();
    expect(document.body.textContent).toContain('paste yours into its AI chat');
    expect(document.body.textContent).toContain(BRIEF.prompt);
  });

  it('has its status messages ignored', async () => {
    const { editorSays, open, apply } = await mount({});
    await open();
    await editorSays({ kind: 'agent-status', state: 'running' });
    expect(apply().disabled).toBe(false);
  });
});

describe('readAgentStatus', () => {
  it('reads a status, trimming and capping its text, and refuses anything else', () => {
    expect(readAgentStatus({ kind: 'agent-status', state: 'failed', reason: '  The model declined.  ', summary: 7 })).toEqual({ state: 'failed', step: undefined, summary: undefined, reason: 'The model declined.' });
    expect(readAgentStatus({ kind: 'agent-status', state: 'running', step: 's'.repeat(500) })!.step).toHaveLength(200);
    expect(readAgentStatus({ kind: 'ai-response', state: 'running' })).toBeNull();
    expect(readAgentStatus(null)).toBeNull();
    expect(readAgentStatus('agent-status')).toBeNull();
  });
});
