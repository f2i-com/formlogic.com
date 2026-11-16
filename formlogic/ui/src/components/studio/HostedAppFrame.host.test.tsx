// @vitest-environment jsdom
// What else FormLogic's own page does for a native app that asks: formlogicHost says what it can do
// here, formlogicDictate has the page listen and formlogicAddApp has it offer an app this one made.
// The frame hands each to the page (`host`) and answers with what the page says; a plugin's page, an
// app whose page offers none, and any action the frame does not know get the refusal they always got.
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
import type { NativeHost } from '../../lib/nativeHost';
import { api } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
const narrator = (visitor = false) => ({ access: 'application' as const, storageScope: { access: 'application' as const, appId: 'narrator' }, assets: {}, visitor });
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = { port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
const channels: StubChannel[] = [];
const page = () => ({
  abilities: vi.fn(() => ({ dictate: true, addApp: false })),
  dictate: vi.fn(async (input: Record<string, unknown>) => ({ state: 'idle' as const, heard: input.op })),
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

const element = (props: Partial<React.ComponentProps<typeof HostedAppFrame>>) => <HostedAppFrame slug="narrator" client={{ 'manifest.json': '{}' }} version={1} {...props} />;
/** The frame's shell saying it is ready (`engines`: the ones it serves, for a mount the server decided an engine for). */
async function ready(engines?: Record<string, typeof identity>) {
  const iframe = container.querySelector('iframe')!;
  vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, ...(engines ? { engines } : {}), nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1 } }));
  });
  return channels[channels.length - 1];
}
async function mount(props: Partial<React.ComponentProps<typeof HostedAppFrame>>) {
  root = createRoot(container);
  await act(async () => root!.render(element(props)));
  return ready(props.engine ? { [props.engine.id]: { ...identity } } : undefined);
}
const call = (channel: StubChannel, id: number, action: string, input: Record<string, unknown>) => act(async () => channel.port1.onmessage?.({ data: { type: 'call', id, action, input } }));
const replies = (channel: StubChannel) => channel.port1.postMessage.mock.calls.map(([message]) => message).filter(message => message.type !== 'formlogic:dispose');

it('says what the page can do for the app, as the page says it', async () => {
  const host = page();
  const channel = await mount({ native: narrator(), host });
  await call(channel, 1, 'formlogicHost', { op: 'abilities' });
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { dictate: true, addApp: false } } }]);
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('knows no other host action', async () => {
  const host = page();
  const channel = await mount({ native: narrator(), host });
  await call(channel, 1, 'formlogicHost', { op: 'everything' });
  expect(host.abilities).not.toHaveBeenCalled();
  expect(replies(channel)).toEqual([{ id: 1, result: { error: 'Unknown host action.' } }]);
});

it('hands listening to the page and answers with what it says', async () => {
  const host = page();
  const channel = await mount({ native: narrator(), host });
  for (const [index, op] of ['start', 'status', 'stop', 'cancel'].entries()) await call(channel, index + 1, 'formlogicDictate', { op });
  expect(host.dictate.mock.calls.map(([input]) => input)).toEqual([{ op: 'start' }, { op: 'status' }, { op: 'stop' }, { op: 'cancel' }]);
  expect(replies(channel)).toEqual(['start', 'status', 'stop', 'cancel'].map((op, index) => ({ id: index + 1, result: { result: { state: 'idle', heard: op } } })));
});

it('answers only once the page has, and tells the app an action the page does not know', async () => {
  const host = page();
  let finish: (answer: { text: string; seconds: number }) => void = () => {};
  host.dictate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as never; }) as never);
  host.dictate.mockImplementationOnce(async () => { throw new Error('Unknown dictation action.'); });
  const channel = await mount({ native: narrator(), host });
  const stopping = call(channel, 1, 'formlogicDictate', { op: 'stop' });
  await act(async () => { await Promise.resolve(); });
  expect(replies(channel), 'not answered while the words are fetched').toEqual([]);
  await act(async () => finish({ text: 'hello there', seconds: 1.4 }));
  await stopping;
  await call(channel, 2, 'formlogicDictate', { op: 'record' });
  expect(replies(channel)).toEqual([
    { id: 1, result: { result: { text: 'hello there', seconds: 1.4 } } },
    { id: 2, result: { error: 'Unknown dictation action.' } },
  ]);
});

it('hands an offer to the page with a way to read the app\'s own backend as the person', async () => {
  const host = page();
  vi.mocked(api.runNativeRequest).mockResolvedValue({ data: { result: { status: 200, body: { files: {} } } } });
  const channel = await mount({ native: narrator(true), host, engine: { id: 'zipp-web-python', revision: 'r7' } });
  await call(channel, 1, 'formlogicAddApp', { op: 'offer', from: '/api/made/7?as=softn', name: 'Tiny notes' });
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { state: 'asking' } } }]);
  const [input, read] = host.addApp.mock.calls[0];
  expect(input).toEqual({ op: 'offer', from: '/api/made/7?as=softn', name: 'Tiny notes' });
  // Nothing is fetched until the page asks: the person has not said yes.
  expect(api.runNativeRequest).not.toHaveBeenCalled();
  // Sent as the app's own requests are: its engine and its visitor marker, a GET with nothing in it.
  expect(await read('/api/made/7?as=softn')).toEqual({ data: { result: { status: 200, body: { files: {} } } } });
  expect(api.runNativeRequest).toHaveBeenCalledWith('narrator', { path: '/api/made/7', query: { as: 'softn' }, method: 'GET', headers: {}, body: {} }, undefined, 'zipp-web-python;r7', true);
  // And never another site, whatever it is handed.
  await expect(read('https://elsewhere.example/api/made/7')).rejects.toThrow('not part of the app backend');
  expect(api.runNativeRequest).toHaveBeenCalledTimes(1);
});

it('refuses all three to a plugin\'s page, and to an app whose page offers none', async () => {
  const host = page();
  const names = ['formlogicHost', 'formlogicDictate', 'formlogicAddApp'];
  const plugin = await mount({ native: narrator(), host, plugin: { context: {}, onDone: vi.fn() } });
  for (const [index, name] of names.entries()) await call(plugin, index + 1, name, { op: name === 'formlogicHost' ? 'abilities' : 'status' });
  expect(replies(plugin)).toEqual(names.map((_, index) => ({ id: index + 1, result: { error: HOSTED_ACTOR_ERROR } })));
  expect(host.abilities).not.toHaveBeenCalled();
  expect(host.dictate).not.toHaveBeenCalled();
  expect(host.addApp).not.toHaveBeenCalled();
  await act(async () => root!.unmount());
  channels.length = 0;
  const bare = await mount({ native: narrator() });
  for (const [index, name] of names.entries()) await call(bare, index + 1, name, { op: name === 'formlogicHost' ? 'abilities' : 'status' });
  expect(replies(bare)).toEqual(names.map((_, index) => ({ id: index + 1, result: { error: HOSTED_ACTOR_ERROR } })));
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('still refuses a native app every action it does not know', async () => {
  const host = page();
  const channel = await mount({ native: narrator(), host });
  await call(channel, 1, 'formlogicMicrophone', { op: 'open' });
  await call(channel, 2, 'formlogicDictation', { op: 'start' });
  await call(channel, 3, 'saveEverything', {});
  expect(replies(channel)).toEqual([1, 2, 3].map(id => ({ id, result: { error: HOSTED_ACTOR_ERROR } })));
  expect(host.dictate).not.toHaveBeenCalled();
  expect(api.runHostedAction).not.toHaveBeenCalled();
});

it('tells the page when the frame goes, once for each frame, so the microphone is never left open for one', async () => {
  const host = page();
  await mount({ native: narrator(), host });
  expect(host.gone).not.toHaveBeenCalled();
  // The app opened again in a new frame (new props from a later runtime GET): the old frame is gone.
  await act(async () => root!.render(element({ native: narrator(), host })));
  expect(host.gone).toHaveBeenCalledTimes(1);
  const second = await ready();
  await call(second, 1, 'formlogicDictate', { op: 'status' });
  expect(host.gone, 'the new frame is not ended by the old one').toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount());
  root = undefined;
  expect(host.gone).toHaveBeenCalledTimes(2);
});

it('reads the page\'s answers as they are when the frame asks: a new page object never opens the app again', async () => {
  const first = page();
  // The same app as it was admitted: the same files and the same `native`, so the same mount.
  const same = { client: { 'manifest.json': '{}' }, native: narrator() };
  const channel = await mount({ ...same, host: first });
  const frame = container.querySelector('iframe');
  const next = page();
  next.abilities.mockReturnValue({ dictate: false, addApp: true });
  await act(async () => root!.render(element({ ...same, host: next })));
  expect(container.querySelector('iframe'), 'the same frame').toBe(frame);
  await call(channel, 1, 'formlogicHost', { op: 'abilities' });
  expect(replies(channel)).toEqual([{ id: 1, result: { result: { dictate: false, addApp: true } } }]);
  expect(first.gone).not.toHaveBeenCalled();
});
