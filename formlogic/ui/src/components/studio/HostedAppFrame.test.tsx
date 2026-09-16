// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getBytes } = vi.hoisted(() => ({ getBytes: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({
  getZippWasmBytes: getBytes,
  matchesZippRuntime: (value: { version?: string; sha256?: string } | undefined) => value?.version === '0.0.17' && value?.sha256 === 'current',
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
let root: Root | undefined;
let container: HTMLDivElement;
const channels: Array<{ port1: { close: () => void }; port2: object }> = [];

beforeEach(() => {
  vi.clearAllMocks();
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

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} />));
  const iframe = container.querySelector('iframe')!;
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  return { iframe, post };
}
function sendReady(iframe: HTMLIFrameElement, zipp: unknown = identity, source: Window = iframe.contentWindow!) {
  window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'formlogic:ready', zipp } }));
}

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

  it('runs every engine id on the ZIPP path until the seam lands: same init keys, same src', async () => {
    // E0 threads the server's engine decision into this frame but changes nothing about how it
    // boots — the installed runtime serves zipp-web-python only. The seam that acts on the id is
    // E1-FL, so an engine the frame cannot serve must not alter the handshake here.
    const baseline = await mount();
    await act(async () => sendReady(baseline.iframe));
    const withoutEngine = baseline.post.mock.calls[0][0] as Record<string, unknown>;
    await act(async () => root!.unmount());
    root = undefined;
    container.remove();

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} engine={{ id: 'host-js', revision: 'abcdef0123456789' }} />
    ));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toBe('/hosted-runtime/index.html');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await act(async () => sendReady(iframe));
    const withEngine = post.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(withEngine).sort()).toEqual(Object.keys(withoutEngine).sort());
    expect(withEngine.zippWasm).toBeInstanceOf(ArrayBuffer);
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
