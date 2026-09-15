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
  matchesZippRuntime: (value: { version?: string; sha256?: string } | undefined) => value?.version === '0.0.17' && value?.sha256 === 'current',
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn(), runNativeRequest: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
const storageKey = 'formlogic:native-storage:notes';
let root: Root | undefined;
let container: HTMLDivElement;
const channels: Array<{ port1: { close: () => void }; port2: object }> = [];

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

async function mountNative() {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={{ assets: {} }} />));
  return spyOnFrame();
}
function spyOnFrame() {
  const iframe = container.querySelector('iframe')!;
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  return { iframe, post };
}
function sendReady(iframe: HTMLIFrameElement) {
  window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL } }));
}
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label);

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
