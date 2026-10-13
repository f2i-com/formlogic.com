// @vitest-environment jsdom
// Exercise real storage and React controls after a transient browser removal failure.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getBytes } = vi.hoisted(() => ({ getBytes: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({
  getEngineBytes: getBytes,
  engineIdentity: () => ({ version: '0.0.17', sha256: 'current' }),
  engineNeedsBytes: () => true,
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn(), runNativeRequest: vi.fn(), getNativeRuntime: vi.fn(), getHostedRuntime: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';
import { api } from '../../lib/api';
import { workspaceBridge } from '../../lib/softn/workspaceBridge';
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
type Channel = {
  port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null };
  port2: object;
};
const channels: Channel[] = [];
const corrupt = '{damaged saved bytes';
let root: Root | undefined;
let container: HTMLDivElement;
const createObjectURL = vi.fn(() => 'blob:recovery-test');
const revokeObjectURL = vi.fn();
const BrowserURL = URL;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  setSessionOwner('A');
  bumpSessionGeneration();
  channels.length = 0;
  getBytes.mockResolvedValue(new ArrayBuffer(8));
  createObjectURL.mockReturnValue('blob:recovery-test');
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  vi.stubGlobal('MessageChannel', class {
    port1 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    port2 = {};
    constructor() { channels.push(this); }
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!;
const call = (channel: Channel, action = 'nativeStorage', input: unknown = { operation: 'set', key: 'stale', value: 'forbidden' }) => channel.port1.onmessage?.({ data: { type: 'call', id: 19, action, input } });
function spyOnFrame() {
  const iframe = container.querySelector('iframe')!;
  return { iframe, post: vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined) };
}
async function ready(iframe: HTMLIFrameElement) {
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: iframe.contentWindow!,
    data: { type: 'formlogic:ready', zipp: { version: '0.0.17', sha256: 'current' }, nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1 },
  })));
}

describe.each(['members', 'application'] as const)('%s recovery', access => {
  const key = access === 'members' ? 'formlogic:native-member-storage:v1:A:app-one' : 'formlogic:native-storage:notes';
  const scope = access === 'members' ? { access, appId: 'app-one', userId: 'A' } : { access, appId: 'app-one' };
  const props = { slug: 'notes', client: { 'manifest.json': '{}' }, version: 1, native: { access, storageScope: scope, assets: {} } };
  const untouched = ['formlogic:native-member-storage:v1:B:app-one', 'formlogic:native-member-storage:v1:A:other', 'formlogic:native-storage:other', ...(access === 'members' ? ['formlogic:native-storage:notes'] : [])];
  async function mount(live = false) {
    for (const other of untouched) localStorage.setItem(other, 'preserved');
    localStorage.setItem(key, live ? '{}' : corrupt);
    root = createRoot(container);
    await act(async () => root!.render(<HostedAppFrame {...props} />));
    const frame = spyOnFrame();
    await ready(frame.iframe);
    if (live) {
      localStorage.setItem(key, corrupt);
      await act(async () => call(channels[0]));
      channels[0].port1.postMessage.mockClear();
    }
    expect(button('Reset saved data')).toBeTruthy();
    return frame;
  }
  function failRemoval(times = 1, during?: () => void) {
    const original = Storage.prototype.removeItem;
    let remaining = times;
    return vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, selected) {
      expect(selected).toBe(key);
      during?.();
      if (remaining-- > 0) throw new Error('Transient removal failure');
      original.call(this, selected);
    });
  }
  async function reset() { await act(async () => button('Reset saved data').click()); }
  function preserved() { for (const other of untouched) expect(localStorage.getItem(other)).toBe('preserved'); }
  async function exportRaw() {
    const reads = vi.spyOn(Storage.prototype, 'getItem');
    reads.mockClear();
    await act(async () => button('Export saved data').click());
    expect(reads.mock.calls).toEqual([[key]]);
    expect(createObjectURL).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'application/json', size: corrupt.length }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-test');
    reads.mockRestore();
  }

  it('exports after failed removal, permits cancellation and retries without touching another map', async () => {
    const first = await mount();
    const remove = failRemoval();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reset();
    expect(container.textContent).toContain('Browser storage is not available');
    expect(localStorage.getItem(key)).toBe(corrupt);
    expect(container.querySelector('iframe')).toBe(first.iframe);
    await exportRaw();
    confirm.mockReturnValueOnce(false);
    await reset();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(corrupt);
    await reset();
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(key)).toBeNull();
    preserved();
    const next = spyOnFrame();
    expect(next.iframe).not.toBe(first.iframe);
    await ready(next.iframe);
    expect(channels).toHaveLength(1);
    expect(next.post).toHaveBeenCalledWith(expect.objectContaining({ storage: {} }), '*', [channels[0].port2]);
  });

  it('keeps recovery alive through repeated failures and queued retired-guest calls', async () => {
    await mount(true);
    const old = channels[0];
    const remove = failRemoval(2, () => { void call(old); });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reset();
    await act(async () => {
      await call(old);
      await call(old, 'nativeRequest', { url: '/api/notes', options: {} });
      await call(old, 'workspaceDashboard', {});
      await old.port1.onmessage?.({ data: { type: 'error' } });
    });
    expect(api.runNativeRequest).not.toHaveBeenCalled();
    expect(workspaceBridge).not.toHaveBeenCalled();
    await exportRaw();
    await reset();
    expect(localStorage.getItem(key)).toBe(corrupt);
    await reset();
    expect(remove).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(key)).toBeNull();
    expect(old.port1.close).toHaveBeenCalledTimes(1);
    expect(old.port1.postMessage.mock.calls).toEqual([[{ type: 'formlogic:dispose' }]]);
    preserved();
  });

  it('suppresses pending native responses and workspace navigation while recovery remains usable', async () => {
    await mount(true);
    const old = channels[0];
    let finishNative!: (value: Awaited<ReturnType<typeof api.runNativeRequest>>) => void;
    let finishWorkspace!: (value: object) => void;
    vi.mocked(api.runNativeRequest).mockImplementation(() => new Promise(resolve => { finishNative = resolve; }));
    vi.mocked(workspaceBridge).mockImplementation(async (_slug, _action, _input, navigate, isCurrent) => {
      await new Promise<object>(resolve => { finishWorkspace = resolve; });
      expect(isCurrent?.()).toBe(false);
      navigate('#forbidden-recovery-navigation');
      return { opened: true };
    });
    const nativeCall = call(old, 'nativeRequest', { url: '/api/notes', options: {} });
    const workspaceCall = call(old, 'workspaceDashboard', {});
    failRemoval();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reset();
    expect(vi.mocked(api.runNativeRequest).mock.calls[0][2]?.aborted).toBe(true);
    const location = window.location.href;
    await act(async () => {
      finishNative({ error: 'changed', status: 409, code: 'engine_changed' });
      finishWorkspace({});
      await Promise.all([nativeCall, workspaceCall]);
    });
    expect(window.location.href).toBe(location);
    expect(api.getNativeRuntime).not.toHaveBeenCalled();
    expect(old.port1.postMessage.mock.calls).toEqual([[{ type: 'formlogic:dispose' }]]);
    await exportRaw();
    await reset();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each(['same-owner', 'different-owner'] as const)('refuses reset when %s session changes inside retry confirmation', async change => {
    await mount(true);
    const remove = failRemoval();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reset();
    confirm.mockImplementation(() => {
      if (change === 'different-owner') setSessionOwner('B'); else bumpSessionGeneration();
      return true;
    });
    await reset();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(corrupt);
    expect(button('Export saved data')).toBeUndefined();
    preserved();
  });

  it.each(['navigation', 'source', 'engine', 'unmount'] as const)('revokes recovery at a subsequent %s boundary', async boundary => {
    const first = await mount(true);
    const remove = failRemoval();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reset();
    await act(async () => {
      if (boundary === 'navigation') {
        first.iframe.dispatchEvent(new Event('load'));
        first.iframe.dispatchEvent(new Event('load'));
      } else if (boundary === 'unmount') {
        root!.unmount(); root = undefined;
      } else root!.render(<HostedAppFrame {...props} {...(boundary === 'source' ? { client: { 'manifest.json': '{"new":true}' } } : { engine: { id: 'zipp-web-python', revision: 'new' } })} />);
    });
    // Navigation leaves the old alert visible; even those attached controls must be fenced.
    await act(async () => {
      button('Export saved data')?.click();
      button('Reset saved data')?.click();
      await call(channels[0]);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(corrupt);
    expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
    preserved();
  });
});
