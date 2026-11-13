// @vitest-environment jsdom
// Where a SoftN app is. A frame that follows the app's own page links (SoftN's `places: 1`) is
// handed the place to start on, and says where the app goes so the page's address can follow. A
// frame from before that is handed none, and nothing it says is taken for a place unless it has
// the shape of one.
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { version: '0.0.17', sha256: 'current' };
const notes = { access: 'application' as const, storageScope: { access: 'application' as const, appId: 'notes' }, assets: {} };
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

/** The frame opened, and the app handed to it: what `formlogic:init` carried, and the app's port. */
async function open(props: Partial<React.ComponentProps<typeof HostedAppFrame>>, says: Record<string, unknown> = { places: 1 }) {
  root = createRoot(container);
  await act(async () => root!.render(<HostedAppFrame slug="notes" client={{ 'manifest.json': '{}' }} version={1} native={notes} {...props} />));
  const iframe = container.querySelector('iframe')!;
  const posted = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1, ...says } }));
  });
  const handed = () => posted.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message?.type === 'formlogic:init');
  await vi.waitFor(() => expect(handed()).toBeTruthy());
  return { init: handed()!, channel: channels[0] };
}
const say = (channel: StubChannel, data: unknown) => act(async () => channel.port1.onmessage?.({ data }));

it('hands a frame that knows its places the place to start on', async () => {
  const { init } = await open({ initialPlace: '/docs/guide.html#team' });
  expect(init.place).toBe('/docs/guide.html#team');
});

it('hands none to a frame from before places, and none when the page names none', async () => {
  expect('place' in (await open({ initialPlace: '/about.html' }, {})).init).toBe(false);
  await act(async () => root?.unmount());
  channels.length = 0;
  expect('place' in (await open({})).init).toBe(false);
});

it('hands on nothing that is not a path of the app\'s own', async () => {
  for (const bad of ['//evil.example/x', 'about.html', '', `/${'a'.repeat(2001)}`]) {
    const { init } = await open({ initialPlace: bad });
    expect('place' in init, bad.slice(0, 20)).toBe(false);
    await act(async () => root?.unmount());
    channels.length = 0;
  }
});

it('tells the page where the app goes, and nothing that has not the shape of a place', async () => {
  const onPlace = vi.fn();
  const { channel } = await open({ onPlace });
  await say(channel, { type: 'place', place: '/about.html' });
  await say(channel, { type: 'place', place: '/#settings' });
  for (const bad of ['//evil.example/', 'about.html', 7, null, `/${'a'.repeat(2001)}`]) await say(channel, { type: 'place', place: bad });
  expect(onPlace.mock.calls).toEqual([['/about.html'], ['/#settings']]);
  // Said to nobody when the page does not follow it: nothing breaks.
  await act(async () => root?.unmount());
  channels.length = 0;
  const quiet = await open({});
  await say(quiet.channel, { type: 'place', place: '/about.html' });
});
