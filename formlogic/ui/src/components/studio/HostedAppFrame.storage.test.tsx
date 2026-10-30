// @vitest-environment jsdom
// Audit FL-S07: what the hosted frame does with this app's saved browser
// data before the app starts — healthy data goes in, damaged data stops the
// app with export/reset in front of the owner, and never silently as empty.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { getBytes } = vi.hoisted(() => ({ getBytes: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({
  getZippWasmBytes: getBytes,
  getEngineBytes: getBytes,
  engineIdentity: (id: string) => (id === 'zipp-web-python' ? { version: '0.0.17', sha256: 'current' } : undefined),
  engineNeedsBytes: () => true,
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn(), runNativeRequest: vi.fn(), getHostedRuntime: vi.fn(), getNativeRuntime: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';
import { bumpSessionGeneration } from '../../lib/sessionGeneration';
import { api } from '../../lib/api';
import { workspaceBridge } from '../../lib/softn/workspaceBridge';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
// Existing runtime/storage checks use explicitly admitted independent application mode.
const application = { access: 'application' as const, storageScope: { access: 'application' as const, appId: 'notes-app' } };
const storageKey = 'formlogic:native-app-storage:v1:notes-app';
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = {
  port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null };
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

async function mountNative(engine?: { id: string; revision: string }) {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={{ ...application, assets: {} }} engine={engine} />));
  return spyOnFrame();
}
function spyOnFrame() {
  const iframe = container.querySelector('iframe')!;
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  return { iframe, post };
}
function sendReady(iframe: HTMLIFrameElement, storageProtocol?: number) {
  window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL, ...(storageProtocol === undefined ? {} : { storageProtocol }) } }));
}
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label);
const call = (channel: StubChannel, input: unknown, id = 1, action = 'nativeStorage') => channel.port1.onmessage?.({ data: { type: 'call', id, action, input } });
const onlyDisposal = (channel: StubChannel) => expect(channel.port1.postMessage.mock.calls.map(([message]) => message)).toEqual([{ type: 'formlogic:dispose' }]);

it('hands healthy saved data to the app unchanged', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ session: 'kept' }));
  const { iframe, post } = await mountNative();
  await act(async () => sendReady(iframe));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'formlogic:init', native: true, storage: { session: 'kept' } }), '*', [channels[0].port2]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('stops the app on damaged saved data and offers export and reset, leaving the bytes alone', async () => {
  const raw = JSON.stringify({ good: 'preserve', damaged: { original: 'bytes' } });
  localStorage.setItem(storageKey, raw);
  const { iframe, post } = await mountNative();
  await act(async () => sendReady(iframe));
  expect(post).not.toHaveBeenCalled();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain('was not started');
  expect(alert.textContent).toContain('damaged');
  expect(button('Export saved data')).toBeTruthy();
  expect(button('Reset saved data')).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe(raw);
  // The frame is not initialised as if the store were empty.
  await act(async () => sendReady(iframe));
  expect(post).not.toHaveBeenCalled();
});

it('reset is deliberate, clears only this app, and boots a fresh frame with empty storage', async () => {
  localStorage.setItem(storageKey, '{not json');
  localStorage.setItem('formlogic:native-storage:other', JSON.stringify({ keep: 'me' }));
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe));
  vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => button('Reset saved data')!.click());
  expect(localStorage.getItem(storageKey)).toBe('{not json');
  vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
  await act(async () => button('Reset saved data')!.click());
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(localStorage.getItem('formlogic:native-storage:other')).toBe(JSON.stringify({ keep: 'me' }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const next = spyOnFrame();
  expect(next.iframe).not.toBe(iframe);
  await act(async () => sendReady(next.iframe));
  expect(next.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'formlogic:init', storage: {} }), '*', expect.anything());
});

it('negotiates batch acknowledgment only when both native peers advertise protocol 1', async () => {
  const { iframe, post } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'formlogic:init', storageProtocol: 1 }), '*', expect.anything());
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await act(async () => call(channels[0], { operation: 'batch', replacements: [{ key: 'session', value: 'fictional' }, { key: 'looks', value: '[1,2,3]' }] }, 31));
  expect(write).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ session: 'fictional', looks: '[1,2,3]' }));
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 31, result: { result: { saved: true } } });
});

it.each([undefined, 0, 2])('keeps an older or unsupported peer on single-key writes without claiming batch acknowledgment: %s', async (protocol) => {
  const { iframe, post } = await mountNative();
  await act(async () => sendReady(iframe, protocol));
  expect(post.mock.calls[0][0]).not.toHaveProperty('storageProtocol');
  await act(async () => call(channels[0], { operation: 'batch', replacements: [{ key: 'session', value: 'fictional' }] }, 2));
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 2, result: { error: expect.stringContaining('does not support') } });
  await act(async () => call(channels[0], { operation: 'set', key: 'session', value: 'fictional' }, 3));
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 3, result: { result: { saved: true } } });
});

it('posts the correlated saved acknowledgment only after the parent storage API succeeds', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  const original = Storage.prototype.setItem;
  const order: string[] = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    expect(channels[0].port1.postMessage).not.toHaveBeenCalled();
    order.push('write');
    original.call(this, key, value);
    order.push('accepted');
  });
  channels[0].port1.postMessage.mockImplementation(() => { order.push('ack'); });
  await act(async () => call(channels[0], { operation: 'set', key: 'session', value: 'fictional' }, 17));
  expect(order).toEqual(['write', 'accepted', 'ack']);
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 17, result: { result: { saved: true } } });
});

it('does not acknowledge failed quota writes or replace the last saved bytes', async () => {
  const raw = JSON.stringify({ session: 'original' });
  localStorage.setItem(storageKey, raw);
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota failure'); });
  await act(async () => call(channels[0], { operation: 'batch', replacements: [{ key: 'session', value: 'new' }, { key: 'looks', value: 'new' }] }, 21));
  expect(localStorage.getItem(storageKey)).toBe(raw);
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 21, result: { error: 'Synthetic quota failure' } });
});

it('refuses invalid IDs, malformed batches and oversized escaped/full inputs without any changes', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await act(async () => call(channels[0], { operation: 'set', key: 'x', value: 'new' }, 1.5));
  await act(async () => call(channels[0], { operation: 'batch', replacements: [{ key: 'x', value: 'valid' }, { key: 'bad', value: 1 }] }, 2));
  await act(async () => call(channels[0], { operation: 'set', key: 'x', value: '\n'.repeat(17000) }, 3));
  const input = { operation: 'batch', replacements: [{ key: 'x', value: 'new' }], padding: '' };
  input.padding = 'x'.repeat(32769 - JSON.stringify(input).length);
  await act(async () => call(channels[0], input, 4));
  expect(write).not.toHaveBeenCalled();
  expect(channels[0].port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1.5 }));
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 3, result: { error: 'Invalid action input.' } });
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 4, result: { error: 'Invalid action input.' } });
});

it('accepts the exact wire boundary and ignores child actor/slug claims when selecting the parent map', async () => {
  localStorage.setItem('formlogic:native-storage:other', JSON.stringify({ session: 'other' }));
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  const input = { operation: 'batch', replacements: [{ key: 'session', value: 'fictional' }], slug: 'other', actor: 'not-a-grant', padding: '' };
  input.padding = 'x'.repeat(32768 - JSON.stringify(input).length);
  await act(async () => call(channels[0], input, 32));
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 32, result: { result: { saved: true } } });
  expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ session: 'fictional' }));
  expect(localStorage.getItem('formlogic:native-storage:other')).toBe(JSON.stringify({ session: 'other' }));
});

it('rejects an old auth-generation callback before mutation and suppresses its reply', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  bumpSessionGeneration();
  await act(async () => call(channels[0], { operation: 'set', key: 'session', value: 'old-account', sessionGeneration: 999999, actor: 'new-account' }));
  expect(localStorage.getItem(storageKey)).toBeNull();
  onlyDisposal(channels[0]);
  expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
});

it('invalidates synchronously before reset, rejects a queued callback during reset and remounts from an empty snapshot', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  localStorage.setItem(storageKey, '{damaged after startup');
  await act(async () => call(channels[0], { operation: 'set', key: 'draft', value: 'new' }, 3));
  expect(button('Reset saved data')).toBeTruthy();
  const oldChannel = channels[0];
  oldChannel.port1.postMessage.mockClear();
  const original = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
    void call(oldChannel, { operation: 'set', key: 'resurrect', value: 'old' }, 4);
    original.call(this, key);
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => button('Reset saved data')!.click());
  await act(async () => call(oldChannel, { operation: 'set', key: 'resurrect', value: 'old' }, 5));
  expect(localStorage.getItem(storageKey)).toBeNull();
  onlyDisposal(oldChannel);
  expect(oldChannel.port1.close).toHaveBeenCalledTimes(1);
  const next = spyOnFrame();
  await act(async () => sendReady(next.iframe, 1));
  expect(next.post).toHaveBeenCalledWith(expect.objectContaining({ storage: {}, storageProtocol: 1 }), '*', expect.anything());
  await act(async () => call(channels[1], { operation: 'set', key: 'fresh', value: 'new-mount' }, 4));
  expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ fresh: 'new-mount' }));
});

it('fences a source/app replacement before a delayed old callback can write to either app', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  const oldChannel = channels[0];
  await act(async () => root!.render(<HostedAppFrame slug="other" client={{ 'manifest.json': '{"changed":true}' }} version={2} native={{ ...application, assets: {} }} />));
  await act(async () => call(oldChannel, { operation: 'set', key: 'session', value: 'old-mount' }));
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(localStorage.getItem('formlogic:native-storage:other')).toBeNull();
  onlyDisposal(oldChannel);
  const next = spyOnFrame();
  await act(async () => sendReady(next.iframe, 1));
  expect(next.post).toHaveBeenCalledWith(expect.objectContaining({ appId: 'native-other', storage: {} }), '*', expect.anything());
});

it('remounts when native assets change even if the client/version/engine stay identical', async () => {
  const client = { 'manifest.json': '{}' };
  const native = { ...application, assets: { 'logo.png': 'old' } };
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={client} version={1} native={native} />));
  const first = spyOnFrame();
  await act(async () => sendReady(first.iframe, 1));
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={client} version={1} native={{ ...application, assets: { 'logo.png': 'new' } }} />));
  const next = spyOnFrame();
  expect(next.iframe).not.toBe(first.iframe);
  await act(async () => call(channels[0], { operation: 'set', key: 'old', value: 'stale' }));
  expect(localStorage.getItem(storageKey)).toBeNull();
  await act(async () => sendReady(next.iframe, 1));
  expect(next.post).toHaveBeenCalledWith(expect.objectContaining({ assets: { 'logo.png': 'new' }, storage: {} }), '*', expect.anything());
});

it('fences old writes as soon as an engine decision is refused, even while the refetch is delayed', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.getNativeRuntime>>) => void;
  vi.mocked(api.getNativeRuntime).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(api.runNativeRequest).mockResolvedValue({ error: 'changed', status: 409, code: 'engine_changed' });
  const { iframe } = await mountNative({ id: 'zipp-web-python', revision: 'old' });
  await act(async () => sendReady(iframe, 1));
  await act(async () => call(channels[0], { url: '/api/notes', options: { method: 'GET' } }, 1, 'nativeRequest'));
  await act(async () => call(channels[0], { operation: 'set', key: 'resurrect', value: 'old' }, 2));
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
  await act(async () => finish({ data: { name: 'Notes', engine: { id: 'zipp-web-python', revision: 'new' }, project: { ...application, assets: {}, client: { 'manifest.json': '{}' }, version: 2 } } } as Awaited<ReturnType<typeof api.getNativeRuntime>>));
  expect(container.querySelector('iframe')).not.toBe(iframe);
});

it('rejects queued callbacks after navigation or disposal before parent mutation', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  const oldChannel = channels[0];
  await act(async () => { iframe.dispatchEvent(new Event('load')); iframe.dispatchEvent(new Event('load')); });
  await act(async () => call(oldChannel, { operation: 'set', key: 'resurrect', value: 'navigated' }));
  expect(localStorage.getItem(storageKey)).toBeNull();
  onlyDisposal(oldChannel);
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => call(oldChannel, { operation: 'set', key: 'resurrect', value: 'disposed' }));
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(oldChannel.port1.close).toHaveBeenCalledTimes(1);
});

it('invalidates before a trusted workspace navigation and ignores late callbacks from that mount', async () => {
  const previous = window.location.href;
  vi.mocked(workspaceBridge).mockImplementation(async (_slug, _action, _input, navigate) => {
    navigate('#workspace-storage-test');
    return { opened: true };
  });
  try {
    const { iframe } = await mountNative();
    await act(async () => sendReady(iframe, 1));
    await act(async () => call(channels[0], {}, 1, 'workspaceDashboard'));
    expect(window.location.hash).toBe('#workspace-storage-test');
    expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
    await act(async () => call(channels[0], { operation: 'set', key: 'old', value: 'stale' }, 2));
    expect(localStorage.getItem(storageKey)).toBeNull();
    onlyDisposal(channels[0]);
  } finally { history.replaceState(null, '', previous); }
});

it('takes saves apart from the four backend calls, and tells the frame it may send them in a lane of their own', async () => {
  let finish!: () => void;
  vi.mocked(api.runNativeRequest).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ data: { result: { status: 200, body: {} } } } as never); }));
  const { iframe, post } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'formlogic:init', storageLane: true }), '*', expect.anything());
  // Four slow backend calls fill the four slots; a fifth is refused, a save is not.
  await act(async () => { for (const id of [1, 2, 3, 4, 5]) void call(channels[0], { url: '/api/notes', options: {} }, id, 'nativeRequest'); });
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 5, result: { error: 'Please wait for the current request.' } });
  await act(async () => call(channels[0], { operation: 'set', key: 'draft', value: 'kept' }, 1_000_000_000));
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 1_000_000_000, result: { result: { saved: true } } });
  expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ draft: 'kept' }));
  await act(async () => finish());
});

it('sends a method upper-cased, as a browser sends it', async () => {
  vi.mocked(api.runNativeRequest).mockResolvedValue({ data: { result: { status: 201, body: {} } } } as never);
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  await act(async () => call(channels[0], { url: '/api/notes', options: { method: 'post', body: { title: 'A' } } }, 1, 'nativeRequest'));
  expect(api.runNativeRequest).toHaveBeenCalledWith('notes', expect.objectContaining({ method: 'POST' }), expect.anything(), undefined);
});

it('puts "could not load" over an app that did not open, and not over one that is running', async () => {
  const { iframe } = await mountNative();
  await act(async () => sendReady(iframe, 1));
  await act(async () => channels[0].port1.onmessage?.({ data: { type: 'error', reason: 'x is not defined', phase: 'runtime' } }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  // A frame before SoftN v0.0.28 sends no phase, and meant a load failure.
  await act(async () => channels[0].port1.onmessage?.({ data: { type: 'error', reason: 'Unexpected token' } }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The app could not load');
});