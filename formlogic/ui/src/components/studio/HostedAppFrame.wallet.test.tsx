// @vitest-environment jsdom
// An app that takes payments may open FormLogic's wallet (formlogicWallet): the page opens it over the
// frame and answers when it closes, with the balance then. An app that takes none, or a plugin's page,
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
const shop = (wallet: boolean) => ({ access: 'application' as const, storageScope: { access: 'application' as const, appId: 'shop' }, assets: {}, visitor: true, wallet });
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

async function mount(props: Partial<React.ComponentProps<typeof HostedAppFrame>>) {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="shop" client={{ 'manifest.json': '{}' }} version={1} {...props} />));
  const iframe = container.querySelector('iframe')!;
  vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1 } }));
  });
  return channels[0];
}
const call = (channel: StubChannel, id: number, input: Record<string, unknown>) => act(async () => channel.port1.onmessage?.({ data: { type: 'call', id, action: 'formlogicWallet', input } }));
const replies = (channel: StubChannel) => channel.port1.postMessage.mock.calls.map(([message]) => message);

it('opens the wallet for an app that takes payments, and answers when it closes with the balance', async () => {
  let close: (value: { closed: true; balanceCents: number }) => void = () => {};
  const onWallet = vi.fn(() => new Promise<{ closed: true; balanceCents: number }>((resolve) => { close = resolve; }));
  const channel = await mount({ native: shop(true), onWallet });
  const asked = call(channel, 1, { op: 'open' });
  await act(async () => { await Promise.resolve(); });
  expect(onWallet).toHaveBeenCalledTimes(1);
  expect(replies(channel)).toEqual([], 'not answered while the sheet is open');
  await act(async () => close({ closed: true, balanceCents: 195 }));
  await asked;
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { closed: true, balanceCents: 195 } } }]);
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('knows no other wallet action', async () => {
  const onWallet = vi.fn();
  const channel = await mount({ native: shop(true), onWallet });
  await call(channel, 1, { op: 'charge', cents: 500 });
  expect(onWallet).not.toHaveBeenCalled();
  expect(replies(channel)).toEqual([{ id: 1, result: { error: 'Unknown wallet action.' } }]);
});

it('refuses an app that takes no payments, as every action it does not know', async () => {
  const onWallet = vi.fn();
  const channel = await mount({ native: shop(false), onWallet });
  await call(channel, 1, { op: 'open' });
  expect(onWallet).not.toHaveBeenCalled();
  expect(replies(channel)).toEqual([{ id: 1, result: { error: HOSTED_ACTOR_ERROR } }]);
});

it('never opens it for a plugin\'s page', async () => {
  const onWallet = vi.fn();
  const channel = await mount({ native: shop(true), onWallet, plugin: { context: {}, onDone: vi.fn() } });
  await call(channel, 1, { op: 'open' });
  expect(onWallet).not.toHaveBeenCalled();
  expect(replies(channel)).toEqual([{ id: 1, result: { error: HOSTED_ACTOR_ERROR } }]);
});
