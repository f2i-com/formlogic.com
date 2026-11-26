// @vitest-environment jsdom
// A web app (SoftN's web container frame, `ready` with `webContainer: 1`) is answered the calls
// FormLogic's page answers any native app: its wallet where it takes payments, and listening and an
// app offered where its owner allows them; an app that declared none of them is refused as before.
// Its media reach the frame as they came, the apps its page nests among them. An app it offers from
// a backend of its own (a container backend) is read from that backend in the backend's own shape.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { getBytes } = vi.hoisted(() => ({ getBytes: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({
  getZippWasmBytes: getBytes,
  getEngineBytes: getBytes,
  engineIdentity: (id: string) => (id === 'zipp-web-python' ? { version: '0.0.17', sha256: 'current' } : undefined),
  engineNeedsBytes: () => true,
  hostZippFiles: () => ({ glue: {} }),
}));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: vi.fn(), runNativeRequest: vi.fn(), runNativeContainerRequest: vi.fn(), getHostedRuntime: vi.fn(), getNativeRuntime: vi.fn() } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: vi.fn() }));
import { HostedAppFrame } from './HostedAppFrame';
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';
import { HOSTED_ACTOR_ERROR } from '../../lib/hostedActor';
import type { NativeHost } from '../../lib/nativeHost';
import { api } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
/** A web app's files as the runtime GET sends them: its manifest says `container`. */
const client = { 'manifest.json': JSON.stringify({ name: 'Board', main: 'index.html', container: true }), 'index.html': '<softn-app src="assets/widgets/clock.softn"></softn-app>' };
const clock = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 128, 7]);
const board = (more: { wallet?: boolean; containerBackend?: 'host' } = {}) => ({
  access: 'application' as const, storageScope: { access: 'application' as const, appId: 'board' }, visitor: true,
  assets: { 'assets/widgets/clock.softn': clock, 'assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, ...more,
});
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = { port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
const channels: StubChannel[] = [];
let sentToFrame: ReturnType<typeof vi.fn>;
const page = () => ({
  abilities: vi.fn(() => ({ dictate: true, addApp: true })),
  dictate: vi.fn(async () => ({ state: 'listening' as const })),
  addApp: vi.fn<NativeHost['addApp']>(() => ({ state: 'asking' })),
  gone: vi.fn(),
}) satisfies NativeHost;

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

/** The web frame's shell saying it is ready, as SoftN's web.ts says it. */
async function mount(props: Partial<React.ComponentProps<typeof HostedAppFrame>>) {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="board" client={client} version={1} {...props} />));
  const iframe = container.querySelector('iframe')!;
  expect(iframe.getAttribute('src')).toContain('format=web');
  sentToFrame = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined) as unknown as ReturnType<typeof vi.fn>;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', nativeProtocol: NATIVE_PROTOCOL, webContainer: 1, containerBackend: 1, places: 1, navigate: 1, links: 1, shown: 1, mediaBytes: 1, storageProtocol: 1 } }));
  });
  return channels[channels.length - 1];
}
const call = (channel: StubChannel, id: number, action: string, input: Record<string, unknown>) => act(async () => channel.port1.onmessage?.({ data: { type: 'call', id, action, input } }));
const replies = (channel: StubChannel) => channel.port1.postMessage.mock.calls.map(([message]) => message).filter(message => message.type !== 'formlogic:dispose');

it('hands the frame the app\'s media as they came, the app its page nests among them', async () => {
  await mount({ native: board() });
  const init = sentToFrame.mock.calls.map(([message]) => message).find(message => message?.type === 'formlogic:init');
  expect(init.engine).toBe('web-container');
  expect(init.assets['assets/widgets/clock.softn']).toBe(board().assets['assets/widgets/clock.softn']);
  expect(Object.keys(init.assets).sort()).toEqual(['assets/logo.png', 'assets/widgets/clock.softn']);
});

it('opens the wallet for a web app that takes payments, and refuses one that declared none', async () => {
  const onWallet = vi.fn(async () => ({ closed: true as const, balanceCents: 250 }));
  const paying = await mount({ native: board({ wallet: true }), onWallet });
  await call(paying, 1, 'formlogicWallet', { op: 'open' });
  expect(onWallet).toHaveBeenCalledTimes(1);
  expect(replies(paying)).toEqual([{ id: 1, result: { result: { closed: true, balanceCents: 250 } } }]);
  await act(async () => root!.unmount());
  channels.length = 0;
  const free = await mount({ native: board(), onWallet });
  await call(free, 1, 'formlogicWallet', { op: 'open' });
  expect(onWallet).toHaveBeenCalledTimes(1);
  expect(replies(free)).toEqual([{ id: 1, result: { error: HOSTED_ACTOR_ERROR } }]);
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('answers what the page can do, and listens, for a web app as for any native app', async () => {
  const host = page();
  const channel = await mount({ native: board(), host });
  await call(channel, 1, 'formlogicHost', { op: 'abilities' });
  await call(channel, 2, 'formlogicDictate', { op: 'start' });
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { dictate: true, addApp: true } } }, { id: 2, result: { result: { state: 'listening' } } }]);
});

it('reads an offered app\'s files from a container backend in the shape that backend answers', async () => {
  const files = { 'manifest.json': '{"name":"Tiny","main":"index.html"}', 'index.html': '<p>Tiny</p>' };
  // The server answers a container app's every route as `{status, headers, bodyBase64}`.
  const answer = { data: { result: { status: 200, headers: [['content-type', 'application/json']], bodyBase64: btoa(JSON.stringify({ files, name: 'Tiny' })) } } };
  vi.mocked(api.runNativeContainerRequest).mockResolvedValue(answer as never);
  vi.mocked(api.runNativeRequest).mockResolvedValue(answer as never);
  const host = page();
  const channel = await mount({ native: board({ containerBackend: 'host' }), host });
  await call(channel, 1, 'formlogicAddApp', { op: 'offer', from: '/api/projects/7/export?as=softn', name: 'Tiny' });
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { state: 'asking' } } }]);
  const [, read] = host.addApp.mock.calls[0];
  expect(api.runNativeContainerRequest).not.toHaveBeenCalled();
  expect(await read('/api/projects/7/export?as=softn')).toEqual({ data: { result: { status: 200, body: { files, name: 'Tiny' } } } });
  expect(api.runNativeContainerRequest).toHaveBeenCalledWith('board', { method: 'GET', path: '/api/projects/7/export', query: 'as=softn', headers: {}, bodyBase64: '' }, undefined, undefined, true);
  // A body that is not JSON is no files; a refusal is the refusal.
  vi.mocked(api.runNativeContainerRequest).mockResolvedValueOnce({ data: { result: { status: 200, headers: [], bodyBase64: btoa('<html>') } } } as never);
  expect(await read('/api/projects/7/export')).toEqual({ data: { result: { status: 200, body: undefined } } });
  vi.mocked(api.runNativeContainerRequest).mockResolvedValueOnce({ error: 'Not found', status: 404 } as never);
  expect(await read('/api/projects/8/export')).toEqual({ error: 'Not found', status: 404 });
  await expect(read('https://elsewhere.example/api/projects/7/export')).rejects.toThrow('not part of the app backend');
});
