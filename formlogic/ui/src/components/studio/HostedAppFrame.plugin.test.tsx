// @vitest-environment jsdom
// A plugin's own page (PluginVerifyPage): the frame offers it its actions and no more. pluginContext
// answers with what the host was given; pluginDone hands back to the host and ends the frame;
// pluginCamera opens the site's camera check, for a plugin granted the camera. Any other frame asking
// gets the refusal every unknown action gets.
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
import { HOSTED_ACTOR_ERROR } from '../../lib/hostedActor';
import { api } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
const application = { access: 'application' as const, storageScope: { access: 'application' as const, appId: 'plugin-app' }, assets: {} };
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = { port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
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

async function mount(plugin?: { context: Record<string, unknown>; onDone: () => void; onCamera?: () => void }) {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="plugin-age" client={{ 'manifest.json': '{}' }} version={1} native={application} plugin={plugin} />));
  const iframe = container.querySelector('iframe')!;
  vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1 } }));
  });
  return channels[0];
}
const call = (channel: StubChannel, action: string, id: number) => act(async () => channel.port1.onmessage?.({ data: { type: 'call', id, action, input: { anything: 'the frame says' } } }));
const replies = (channel: StubChannel) => channel.port1.postMessage.mock.calls.map(([message]) => message);

it('answers a plugin page what the host was given, and nothing the frame sent', async () => {
  const context = { app: { name: 'Grown-ups' }, requirement: { kind: 'age', min: 18 } };
  const channel = await mount({ context, onDone: vi.fn() });
  await call(channel, 'pluginContext', 1);
  expect(replies(channel)).toEqual([{ id: 1, result: { result: context } }]);
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('hands back to the host once the plugin is done, and ends the frame', async () => {
  const onDone = vi.fn();
  const channel = await mount({ context: {}, onDone });
  await call(channel, 'pluginDone', 1);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(replies(channel)).toEqual([{ type: 'formlogic:dispose' }]);
  // A frame that keeps talking after it is done is not heard.
  await call(channel, 'pluginDone', 2);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('refuses both to any other app, as it refuses every action it does not know', async () => {
  const channel = await mount();
  await call(channel, 'pluginContext', 1);
  await call(channel, 'pluginDone', 2);
  await call(channel, 'pluginCamera', 3);
  expect(replies(channel)).toEqual([
    { id: 1, result: { error: HOSTED_ACTOR_ERROR } },
    { id: 2, result: { error: HOSTED_ACTOR_ERROR } },
    { id: 3, result: { error: HOSTED_ACTOR_ERROR } },
  ]);
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('opens the site\'s camera check for a plugin granted the camera, and tells the frame only that', async () => {
  const onCamera = vi.fn();
  const channel = await mount({ context: {}, onDone: vi.fn(), onCamera });
  await call(channel, 'pluginCamera', 1);
  expect(onCamera).toHaveBeenCalledTimes(1);
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { opened: true } } }]);
});

it('gives a plugin page no third action either', async () => {
  const channel = await mount({ context: {}, onDone: vi.fn() });
  await call(channel, 'pluginCamera', 1);
  await call(channel, 'workspaceOpenElsewhere', 2);
  expect(replies(channel)).toEqual([
    { id: 1, result: { error: HOSTED_ACTOR_ERROR } },
    { id: 2, result: { error: HOSTED_ACTOR_ERROR } },
  ]);
});
