// @vitest-environment jsdom
// A newer version of a running app's files is handed to the frame it runs in (SoftN v0.0.39's
// `formlogic:update`), not opened in a new one: only to a frame that says it takes updates and has
// drawn, once, and answered once. A frame that cannot take it is said so, and the caller opens it
// the way it always did.
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
const native = { access: 'application' as const, storageScope: { access: 'application' as const, appId: 'notes' }, assets: { 'logo.png': 'AAAA' } };
const first = { 'manifest.json': '{"main":"main.ui"}', 'main.ui': '<Text>one</Text>' };
const second = { 'manifest.json': '{"main":"main.ui"}', 'main.ui': '<Text>two</Text>' };
let root: Root | undefined;
let container: HTMLDivElement;
type StubChannel = { port1: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
const channels: StubChannel[] = [];
type Props = Partial<React.ComponentProps<typeof HostedAppFrame>>;

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (props: Props) => act(async () => root!.render(<HostedAppFrame slug="notes" client={first} version={1} native={native} {...props} />));
/** The frame on screen says it is ready; what it was sent to open with. */
async function ready(says: Record<string, unknown> = { shown: 1, update: 1 }) {
  const iframe = container.querySelector('iframe')!;
  const sent = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: identity, nativeProtocol: NATIVE_PROTOCOL, storageProtocol: 1, ...says } }));
  });
  return { iframe, channel: channels[channels.length - 1], init: sent.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message?.type === 'formlogic:init') };
}
async function mount(props: Props, says?: Record<string, unknown>) {
  root = createRoot(container);
  await render(props);
  return ready(says);
}
const says = (channel: StubChannel, data: Record<string, unknown>) => act(async () => channel.port1.onmessage?.({ data }));
const updates = (channel: StubChannel) => channel.port1.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>).filter((message) => message?.type === 'formlogic:update');

it('hands a newer version to the frame on screen, in the frame it is in, and says it was taken', async () => {
  const onUpdate = vi.fn();
  const { iframe, channel } = await mount({ onUpdate });
  await says(channel, { type: 'shown' });
  await render({ onUpdate, update: { version: 2, client: second } });

  expect(container.querySelector('iframe'), 'no new frame').toBe(iframe);
  const sent = updates(channel);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: 'formlogic:update', id: expect.any(String), client: second });
  expect(sent[0], 'its media are left as the frame has them').not.toHaveProperty('assets');
  expect(onUpdate, 'not before the frame answers').not.toHaveBeenCalled();

  await says(channel, { type: 'updated', id: sent[0].id, outcome: 'updated', changed: ['page'] });
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenCalledWith(2, 'taken');
  // Rendered again with the same version: not handed over twice.
  await render({ onUpdate, update: { version: 2, client: second } });
  expect(updates(channel)).toHaveLength(1);
  expect(container.querySelector('iframe')).toBe(iframe);
});

it('waits for the app to be drawn, and sends other media only when it is given them', async () => {
  const onUpdate = vi.fn();
  const { channel } = await mount({ onUpdate, update: { version: 2, client: second, assets: { 'logo.png': 'BBBB' } } });
  expect(updates(channel), 'nothing before `shown`').toEqual([]);
  await says(channel, { type: 'shown' });
  const sent = updates(channel);
  expect(sent).toHaveLength(1);
  expect(sent[0].assets).toEqual({ 'logo.png': 'BBBB' });
});

it.each([['restarted'], ['unchanged'], ['kept']])('takes a frame\'s "%s" as the version being in the frame', async (outcome) => {
  const onUpdate = vi.fn();
  const { channel } = await mount({ onUpdate });
  await says(channel, { type: 'shown' });
  await render({ onUpdate, update: { version: 2, client: second } });
  await says(channel, { type: 'updated', id: updates(channel)[0].id, outcome });
  expect(onUpdate).toHaveBeenCalledWith(2, 'taken');
});

it('says so when the frame answers that it cannot take the version, or answers anything else', async () => {
  for (const outcome of ['reopen', 'made-up', undefined]) {
    const onUpdate = vi.fn();
    const { channel } = await mount({ onUpdate });
    await says(channel, { type: 'shown' });
    await render({ onUpdate, update: { version: 2, client: second } });
    await says(channel, { type: 'updated', id: updates(channel)[0].id, outcome, reason: 'the manifest names another main' });
    expect(onUpdate, String(outcome)).toHaveBeenCalledWith(2, 'reopen');
    await act(async () => root?.unmount());
  }
});

it('hands nothing to a frame from before updates, or one that never drew, and says so at once', async () => {
  // A frame from before SoftN v0.0.39: `ready` without `update`.
  let onUpdate = vi.fn();
  let opened = await mount({ onUpdate }, { shown: 1 });
  await says(opened.channel, { type: 'shown' });
  await render({ onUpdate, update: { version: 2, client: second } });
  expect(updates(opened.channel)).toEqual([]);
  expect(onUpdate).toHaveBeenCalledWith(2, 'reopen');
  await act(async () => root?.unmount());

  // A frame that never said `shown`: uncovered after 45 seconds whatever happened, and not one to update.
  vi.useFakeTimers();
  onUpdate = vi.fn();
  opened = await mount({ onUpdate, update: { version: 2, client: second } });
  expect(onUpdate).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(45_000); });
  expect(updates(opened.channel)).toEqual([]);
  expect(onUpdate).toHaveBeenCalledWith(2, 'reopen');
});

it('reads only an answer to a version it handed over, and gives up on a frame that never answers', async () => {
  vi.useFakeTimers();
  const onUpdate = vi.fn();
  const { channel } = await mount({ onUpdate });
  await says(channel, { type: 'shown' });
  await render({ onUpdate, update: { version: 2, client: second } });
  for (const id of ['update-99', 1, null, undefined, { toString: () => 'update-1' }]) await says(channel, { type: 'updated', id, outcome: 'updated' });
  expect(onUpdate, 'an answer to nothing it sent').not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(onUpdate).toHaveBeenCalledWith(2, 'reopen');
  // Answered late, after it was given up on: not taken twice.
  await says(channel, { type: 'updated', id: updates(channel)[0].id, outcome: 'updated' });
  expect(onUpdate).toHaveBeenCalledTimes(1);
});

it('opens a later frame of the same app with the version that was taken, not the one it first opened with', async () => {
  const onUpdate = vi.fn();
  const opened = await mount({ onUpdate });
  expect(opened.init?.client).toEqual(first);
  await says(opened.channel, { type: 'shown' });
  await render({ onUpdate, update: { version: 2, client: second, assets: { 'logo.png': 'BBBB' } } });
  await says(opened.channel, { type: 'updated', id: updates(opened.channel)[0].id, outcome: 'updated' });
  expect(onUpdate).toHaveBeenCalledWith(2, 'taken');

  // Another tab saved this app's data: the frame is opened again when the page is come back to.
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(container.querySelector('iframe'), 'a new frame').not.toBe(opened.iframe);
  const again = await ready();
  expect(again.init?.client, 'the version on screen before').toEqual(second);
  expect(again.init?.assets).toEqual({ 'logo.png': 'BBBB' });
  // The same version is not handed to it a second time.
  await says(again.channel, { type: 'shown' });
  expect(updates(again.channel)).toEqual([]);

  // A version the frame kept back (it has a problem) is not what a later frame opens with.
  await render({ onUpdate, update: { version: 3, client: { 'manifest.json': 'not json' } } });
  await says(again.channel, { type: 'updated', id: updates(again.channel)[0].id, outcome: 'kept', problem: 'the manifest is not JSON' });
  expect(onUpdate).toHaveBeenCalledWith(3, 'taken');
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect((await ready()).init?.client).toEqual(second);
});

it('hands each media file\'s bytes as they are to a frame that takes bytes, and base64 to one before it', async () => {
  // As the media pack gives them: views into one buffer.
  const pack = Uint8Array.from([0, 1, 2, 3, 250, 251, 252]);
  const media = { 'logo.png': pack.subarray(1, 4), 'sound.mp3': pack.subarray(4) };
  const later = { 'logo.png': Uint8Array.from([9, 9]) };
  const opened = { ...native, assets: media };

  const takes = await mount({ native: opened }, { shown: 1, update: 1, mediaBytes: 1 });
  expect(takes.init?.assets).toEqual(media);
  expect((takes.init?.assets as Record<string, unknown>)['logo.png'], 'the same bytes, not a copy made here').toBe(media['logo.png']);
  await says(takes.channel, { type: 'shown' });
  await render({ native: opened, update: { version: 2, client: second, assets: later } });
  expect(updates(takes.channel)[0].assets).toEqual(later);
  await act(async () => root?.unmount());

  root = createRoot(container);
  await render({ native: opened });
  const before = await ready({ shown: 1, update: 1 });
  expect(before.init?.assets, 'a frame from before SoftN v0.0.41').toEqual({ 'logo.png': 'AQID', 'sound.mp3': '+vv8' });
  await says(before.channel, { type: 'shown' });
  await render({ native: opened, update: { version: 2, client: second, assets: later } });
  expect(updates(before.channel)[0].assets).toEqual({ 'logo.png': 'CQk=' });
  await act(async () => root?.unmount());
  // Text, as a server before the media pack sends it, goes as it came.
  expect((await mount({}, { shown: 1, update: 1, mediaBytes: 1 }).then(opened => opened.init))?.assets).toEqual({ 'logo.png': 'AAAA' });
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const withMedia = { ...native, media: A };

it('sends a version\'s media only to a frame that holds other media, by their digest', async () => {
  const onUpdate = vi.fn();
  const { channel } = await mount({ onUpdate, native: withMedia });
  await says(channel, { type: 'shown' });
  const take = async (version: number, more: Record<string, unknown>) => {
    await render({ onUpdate, native: withMedia, update: { version, client: { ...second, 'main.ui': `<Text>${version}</Text>` }, ...more } });
    const sent = updates(channel).at(-1)!;
    await says(channel, { type: 'updated', id: sent.id, outcome: 'updated' });
    return sent;
  };
  expect(await take(2, { assets: { 'logo.png': 'AAAA' }, media: A }), 'the media it opened with').not.toHaveProperty('assets');
  expect((await take(3, { assets: { 'logo.png': 'BBBB' }, media: B })).assets).toEqual({ 'logo.png': 'BBBB' });
  expect(await take(4, { assets: { 'logo.png': 'BBBB' }, media: B }), 'the media it was sent last').not.toHaveProperty('assets');
  expect((await take(5, { assets: { 'logo.png': 'AAAA' }, media: A })).assets, 'and back').toEqual({ 'logo.png': 'AAAA' });
});

it('sends the media again to a frame opened since, which holds only what it opened with', async () => {
  const onUpdate = vi.fn();
  const opened = await mount({ onUpdate, native: withMedia });
  await says(opened.channel, { type: 'shown' });
  // Version 2 has other media and a problem: the frame keeps it back (and keeps its media for the next).
  const broken = { version: 2, client: { 'manifest.json': 'not json' }, assets: { 'logo.png': 'BBBB' }, media: B };
  await render({ onUpdate, native: withMedia, update: broken });
  expect(updates(opened.channel)[0].assets).toEqual({ 'logo.png': 'BBBB' });
  await says(opened.channel, { type: 'updated', id: updates(opened.channel)[0].id, outcome: 'kept' });
  // The same frame, the mended version with those same media: it has them.
  const mended = { version: 3, client: second, assets: { 'logo.png': 'BBBB' }, media: B };
  await render({ onUpdate, native: withMedia, update: mended });
  expect(updates(opened.channel)[1]).not.toHaveProperty('assets');
  await says(opened.channel, { type: 'updated', id: updates(opened.channel)[1].id, outcome: 'updated' });

  // Again from the start, but a new frame is opened between the two (another tab saved).
  await act(async () => root?.unmount());
  channels.length = 0;
  const first2 = await mount({ onUpdate, native: withMedia });
  await says(first2.channel, { type: 'shown' });
  await render({ onUpdate, native: withMedia, update: broken });
  await says(first2.channel, { type: 'updated', id: updates(first2.channel)[0].id, outcome: 'kept' });
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  const again = await ready();
  expect(again.init?.client, 'the kept-back version is not what it opens with').toEqual(first);
  expect(again.init?.assets).toEqual({ 'logo.png': 'AAAA' });
  await says(again.channel, { type: 'shown' });
  // (the kept-back version is handed to the new frame too, which keeps it back as the first did)
  await says(again.channel, { type: 'updated', id: updates(again.channel)[0].id, outcome: 'kept' });
  expect(updates(again.channel)[0].assets, 'a frame that opened with the first media is sent the others').toEqual({ 'logo.png': 'BBBB' });
  await render({ onUpdate, native: withMedia, update: mended });
  expect(updates(again.channel).at(-1)).not.toHaveProperty('assets');
});

it('keeps each waiting version\'s own files and media when two are handed at once', async () => {
  const onUpdate = vi.fn();
  const opened = await mount({ onUpdate, native: withMedia });
  await says(opened.channel, { type: 'shown' });
  await render({ onUpdate, native: withMedia, update: { version: 2, client: second, assets: { 'logo.png': 'AAAA' }, media: A } });
  await render({ onUpdate, native: withMedia, update: { version: 3, client: { 'manifest.json': 'not json' }, assets: { 'logo.png': 'BBBB' }, media: B } });
  const [two, three] = updates(opened.channel);
  await says(opened.channel, { type: 'updated', id: two.id, outcome: 'updated' });
  await says(opened.channel, { type: 'updated', id: three.id, outcome: 'kept' });
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  const again = await ready();
  expect(again.init?.client).toEqual(second);
  expect(again.init?.assets, 'version 2 with its own media, not version 3\'s').toEqual({ 'logo.png': 'AAAA' });
});

it('never hands a version to a frame on another engine, and knows the version a frame opened with', async () => {
  const engine = { id: 'zipp-web-python', revision: 'r1' };
  let onUpdate = vi.fn();
  let opened = await mount({ onUpdate, engine });
  await says(opened.channel, { type: 'shown' });
  await render({ onUpdate, engine, update: { version: 2, client: second, engine: { id: 'zipp-web-python', revision: 'r2' } } });
  expect(updates(opened.channel)).toEqual([]);
  expect(onUpdate).toHaveBeenCalledWith(2, 'reopen');
  // The same engine: handed.
  await render({ onUpdate, engine, update: { version: 3, client: second, engine } });
  expect(updates(opened.channel)).toHaveLength(1);
  await act(async () => root?.unmount());

  // The frame opened with that very version (the page was handed it as its props meanwhile): nothing to hand.
  channels.length = 0;
  onUpdate = vi.fn();
  opened = await mount({ onUpdate, engine, client: second, version: 2, update: { version: 2, client: second, engine } });
  await says(opened.channel, { type: 'shown' });
  expect(updates(opened.channel)).toEqual([]);
  expect(onUpdate).toHaveBeenCalledWith(2, 'taken');
});

it('drops a taken version when the page hands it a newer opening of its own', async () => {
  const onUpdate = vi.fn();
  const opened = await mount({ onUpdate });
  await says(opened.channel, { type: 'shown' });
  await render({ onUpdate, update: { version: 2, client: second } });
  await says(opened.channel, { type: 'updated', id: updates(opened.channel)[0].id, outcome: 'updated' });
  const third = { 'manifest.json': '{"main":"main.ui"}', 'main.ui': '<Text>three</Text>' };
  await render({ onUpdate, client: third, version: 3 });
  expect(container.querySelector('iframe')).not.toBe(opened.iframe);
  expect((await ready()).init?.client).toEqual(third);
});
