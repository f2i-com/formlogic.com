// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getBytes } = vi.hoisted(() => ({ getBytes: vi.fn() }));
// The installed table, stubbed: this page holds one engine, and only its identity matches.
vi.mock('../../lib/formlogic/zipp-bytes', () => ({
  getZippWasmBytes: getBytes,
  getEngineBytes: getBytes,
  engineIdentity: (id: string) => (id === 'zipp-web-python' ? { version: '0.0.17', sha256: 'current' } : undefined),
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn(), runNativeRequest: vi.fn(), getHostedRuntime: vi.fn(), getNativeRuntime: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';
import { chooseFrameEngine } from '../../lib/formlogic/frameEngine';
import { api } from '../../lib/api';
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = {
  port1: { close: () => void; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null };
  port2: object;
};
const channels: StubChannel[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  channels.length = 0;
  getBytes.mockResolvedValue(new ArrayBuffer(8));
  vi.stubGlobal('MessageChannel', class {
    port1 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    port2 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    constructor() { channels.push(this); }
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(engine?: { id: string; revision: string }) {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} engine={engine} />));
  return spyOnFrame();
}
function spyOnFrame() {
  const iframe = container.querySelector('iframe')!;
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  return { iframe, post };
}
function sendReady(iframe: HTMLIFrameElement, zipp: unknown = identity, source: Window = iframe.contentWindow!, engines?: unknown) {
  window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'formlogic:ready', zipp, ...(engines === undefined ? {} : { engines }) } }));
}
/** Drive one action through the private port the frame handed the shell. */
async function callAction(channel: StubChannel, id = 1) {
  await act(async () => channel.port1.onmessage?.({ data: { type: 'call', id, action: 'save', input: {} } }));
}
const initOf = (post: ReturnType<typeof vi.spyOn>) => post.mock.calls[0][0] as Record<string, unknown>;

describe('hosted app engine handoff', () => {
  it('waits for the trusted matching frame before loading or sending bytes', async () => {
    const { iframe, post } = await mount();
    expect(getBytes).not.toHaveBeenCalled();
    await act(async () => sendReady(iframe, identity, window));
    expect(getBytes).not.toHaveBeenCalled();
    await act(async () => sendReady(iframe, { version: '0.0.15', sha256: 'old' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('out of date');
    expect(getBytes).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('requests a runtime update when native hosting support is missing', async () => {
    root = createRoot(container);
    await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={{ assets: {} }} />));
    const iframe = container.querySelector('iframe')!;
    await act(async () => sendReady(iframe));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not support native apps yet');
    expect(getBytes).not.toHaveBeenCalled();
  });

  it('clones cached bytes once and transfers only the private message port', async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    getBytes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { iframe, post } = await mount();
    await act(async () => { sendReady(iframe); sendReady(iframe); });
    expect(getBytes).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    const bytes = new ArrayBuffer(8);
    await act(async () => finish(bytes));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'formlogic:init', zippWasm: bytes }), '*', [channels[0].port2]);
    expect(bytes.byteLength).toBe(8);
    await act(async () => sendReady(iframe));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not hydrate a frame after the user has left it', async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    getBytes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { iframe, post } = await mount();
    await act(async () => sendReady(iframe));
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => finish(new ArrayBuffer(8)));
    expect(post).not.toHaveBeenCalled();
    expect(channels).toHaveLength(0);
  });

  it('shows download failures instead of sending an incomplete initialization', async () => {
    getBytes.mockRejectedValue(new Error('The app engine could not be downloaded.'));
    const { iframe, post } = await mount();
    await act(async () => sendReady(iframe));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be downloaded');
    expect(post).not.toHaveBeenCalled();
  });

  it('falls back to the engine every shell serves when the one decided is not announced', async () => {
    // A shell from before the handshake announces no `engines` at all; a decision it cannot serve
    // is not sent to it, because it would be refused by name and the app would not start.
    const { iframe, post } = await mount({ id: 'host-js', revision: 'abcdef0123456789' });
    expect(iframe.getAttribute('src')).toBe('/hosted-runtime/index.html');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    await act(async () => sendReady(iframe));
    expect(initOf(post).engine).toBe('zipp-web-python');
    expect(getBytes).toHaveBeenCalledWith('zipp-web-python');
    expect(initOf(post).zippWasm).toBeInstanceOf(ArrayBuffer);
  });

  it('passes an announced engine through, matching its identity by value', async () => {
    const { iframe, post } = await mount({ id: 'zipp-web-python', revision: 'r1' });
    // The shell's `engines` entry and its `zipp` are one object cloned twice: never this page's.
    await act(async () => sendReady(iframe, identity, iframe.contentWindow!, { 'zipp-web-python': { ...identity } }));
    expect(initOf(post).engine).toBe('zipp-web-python');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('refuses a shell whose announced engine is not the one this page holds', async () => {
    const { iframe, post } = await mount({ id: 'zipp-web-python', revision: 'r1' });
    await act(async () => sendReady(iframe, { version: '0.0.17', sha256: 'old' }, iframe.contentWindow!, { 'zipp-web-python': { version: '0.0.17', sha256: 'old' } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('out of date');
    expect(post).not.toHaveBeenCalled();
  });

  it('boots a new frame when source changes at the same slug and version', async () => {
    const first = await mount();
    await act(async () => sendReady(first.iframe));
    expect(first.post).toHaveBeenCalledTimes(1);
    const oldChannel = channels[0];
    await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}', 'main.ui': '<div>Updated</div>' }} version={1} />));
    const nextFrame = container.querySelector('iframe')!;
    expect(nextFrame).not.toBe(first.iframe);
    expect(oldChannel.port1.close).toHaveBeenCalledTimes(1);
    const nextPost = vi.spyOn(nextFrame.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await act(async () => sendReady(nextFrame));
    expect(nextPost).toHaveBeenCalledWith(expect.objectContaining({
      type: 'formlogic:init', client: { 'manifest.json': '{}', 'main.ui': '<div>Updated</div>' },
    }), '*', [channels[1].port2]);
  });
});

describe('chooseFrameEngine', () => {
  const installed = (id: string) =>
    ({ 'zipp-web-python': { version: '1', sha256: 'python' }, 'zipp-web': { version: '1', sha256: 'web' } } as Record<string, { version: string; sha256: string }>)[id];

  it('passes an announced engine through, matching its identity by value and not by reference', () => {
    // The announcement crosses a structured clone, so it is never this page's own object.
    expect(chooseFrameEngine({ id: 'zipp-web' }, { 'zipp-web': { version: '1', sha256: 'web' } }, installed)).toBe('zipp-web');
  });

  it('falls back when the shell announces no engines at all, as every older shell does', () => {
    expect(chooseFrameEngine({ id: 'zipp-web' }, undefined, installed)).toBe('zipp-web-python');
    expect(chooseFrameEngine({ id: 'zipp-web' }, {}, installed)).toBe('zipp-web-python');
  });

  it('falls back when the announced identity is not the one this page holds', () => {
    expect(chooseFrameEngine({ id: 'zipp-web' }, { 'zipp-web': { version: '1', sha256: 'other' } }, installed)).toBe('zipp-web-python');
  });

  it('falls back for an engine this page cannot boot, however loudly the shell announces it', () => {
    expect(chooseFrameEngine({ id: 'host-js' }, { 'host-js': true }, installed)).toBe('zipp-web-python');
  });

  it('reads only the shell’s own announcement, never a prototype', () => {
    expect(chooseFrameEngine({ id: 'constructor' }, {}, installed)).toBe('zipp-web-python');
  });

  it('needs no announcement for the engine every shell has always run', () => {
    expect(chooseFrameEngine(undefined, undefined, installed)).toBe('zipp-web-python');
    expect(chooseFrameEngine({ id: 'zipp-web-python' }, undefined, installed)).toBe('zipp-web-python');
  });
});

describe('the engine an action claims', () => {
  const answer = (engine: { id: string; revision: string }) =>
    ({ data: { engine } }) as unknown as Awaited<ReturnType<typeof api.getHostedRuntime>>;

  it('claims the decision the SERVER made, not the engine this frame fell back to', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ data: { result: 1 } });
    const { iframe } = await mount({ id: 'host-js', revision: 'r7' });
    await act(async () => sendReady(iframe));
    await callAction(channels[0]);
    expect(api.runHostedAction).toHaveBeenCalledWith('notes', 'save', {}, expect.anything(), 'host-js;r7');
  });

  it('claims nothing when no server decision was given, so an older page is answered as before', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ data: { result: 1 } });
    const { iframe } = await mount();
    await act(async () => sendReady(iframe));
    await callAction(channels[0]);
    expect(api.runHostedAction).toHaveBeenCalledWith('notes', 'save', {}, expect.anything(), undefined);
  });

  it('claims nothing for a pinned id that carries no revision (AokieWorkspace)', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ data: { result: 1 } });
    const { iframe } = await mount({ id: 'zipp-web-python', revision: '' });
    await act(async () => sendReady(iframe));
    await callAction(channels[0]);
    expect(api.runHostedAction).toHaveBeenCalledWith('notes', 'save', {}, expect.anything(), undefined);
  });

  it('remounts on the server’s new decision when an action is refused as engine_changed', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ error: 'This app is now set to run on a different engine. Reload to continue.', status: 409, code: 'engine_changed' });
    vi.mocked(api.getHostedRuntime).mockResolvedValue(answer({ id: 'zipp-web-python', revision: 'r2' }));
    const { iframe } = await mount({ id: 'zipp-web-python', revision: 'r1' });
    await act(async () => sendReady(iframe));
    await callAction(channels[0]);
    const next = container.querySelector('iframe')!;
    expect(next).not.toBe(iframe);
    expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
    // A remount, not a message: the person is not told about an engine.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    vi.mocked(api.runHostedAction).mockResolvedValue({ data: { result: 1 } });
    vi.spyOn(next.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await act(async () => sendReady(next));
    await callAction(channels[1], 2);
    expect(api.runHostedAction).toHaveBeenLastCalledWith('notes', 'save', {}, expect.anything(), 'zipp-web-python;r2');
  });

  it('refetches once however many actions are refused at the same time', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ error: 'changed', status: 409, code: 'engine_changed' });
    vi.mocked(api.getHostedRuntime).mockResolvedValue(answer({ id: 'zipp-web-python', revision: 'r2' }));
    const { iframe } = await mount({ id: 'zipp-web-python', revision: 'r1' });
    await act(async () => sendReady(iframe));
    await act(async () => {
      channels[0].port1.onmessage?.({ data: { type: 'call', id: 1, action: 'save', input: {} } });
      channels[0].port1.onmessage?.({ data: { type: 'call', id: 2, action: 'save', input: {} } });
    });
    expect(api.getHostedRuntime).toHaveBeenCalledTimes(1);
  });

  it('says so rather than remounting onto the decision that was just refused', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ error: 'changed', status: 409, code: 'engine_changed' });
    vi.mocked(api.getHostedRuntime).mockResolvedValue(answer({ id: 'zipp-web-python', revision: 'r1' }));
    const { iframe } = await mount({ id: 'zipp-web-python', revision: 'r1' });
    await act(async () => sendReady(iframe));
    await callAction(channels[0]);
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('different engine');
  });

  it('leaves a 409 that is not engine_changed to the app, and the frame alone', async () => {
    vi.mocked(api.runHostedAction).mockResolvedValue({ error: 'Someone else saved first', status: 409 });
    const { iframe } = await mount({ id: 'zipp-web-python', revision: 'r1' });
    await act(async () => sendReady(iframe));
    await callAction(channels[0]);
    expect(api.getHostedRuntime).not.toHaveBeenCalled();
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 1, result: { error: 'Someone else saved first' } });
  });
});

describe('a frame that navigates itself', () => {
  it('is taken away on its second load, with its port closed', async () => {
    const { iframe } = await mount();
    await act(async () => sendReady(iframe));
    expect(channels).toHaveLength(1);
    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('tried to navigate away');
    expect(channels[0].port1.close).toHaveBeenCalled();
  });

  it('is not what a remount looks like: each frame counts its own loads', async () => {
    localStorage.setItem('formlogic:native-storage:notes', '{not json');
    root = createRoot(container);
    await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={{ assets: {} }} />));
    const first = spyOnFrame();
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      source: first.iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL },
    })));
    await act(async () => { first.iframe.dispatchEvent(new Event('load')); });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    const reset = [...container.querySelectorAll('button')].find(node => node.textContent === 'Reset saved data')!;
    await act(async () => reset.click());
    const next = container.querySelector('iframe')!;
    expect(next).not.toBe(first.iframe);
    await act(async () => { next.dispatchEvent(new Event('load')); });
    expect(container.querySelector('iframe')).toBe(next);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
