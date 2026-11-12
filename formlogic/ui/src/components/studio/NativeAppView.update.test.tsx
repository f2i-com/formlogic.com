// @vitest-environment jsdom
// A newer version of an app while its owner has it open: the page asks for the version now and then
// while it is looked at, fetches a newer one as an opening is fetched, and hands it to the running
// frame where nothing but its files differs. Anything else differing, or a frame that cannot take
// it, opens it in a new frame as before. Nobody else's page asks at all.
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type FrameProps = { client: Record<string, string>; version: number; native?: { assets: Record<string, string>; media?: string; files?: boolean }; engine?: { id: string; revision: string }; update?: { version: number; client: Record<string, string>; assets?: Record<string, string>; media?: string; engine?: { id: string; revision: string } }; onUpdate?: (version: number, outcome: 'taken' | 'reopen') => void };
const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), getNativeVersion: vi.fn(), frame: { props: null as unknown, mounts: 0 } }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getNativeVersion: mocks.getNativeVersion, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: (props: unknown) => { mocks.frame.props = props; return <div data-testid="frame">running</div>; } }));

import { NativeAppView } from './NativeAppView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const one = { 'manifest.json': '{"main":"main.ui"}', 'main.ui': '<Text>one</Text>' };
const two = { 'manifest.json': '{"main":"main.ui"}', 'main.ui': '<Text>two</Text>' };
const engine = { id: 'zipp-web-python', revision: 'r1' };
const media = (sha256: string) => ({ url: `/app/notes/native/media?h=${sha256}`, sha256, size: 4, count: 1 });
const project = (version: number, client: Record<string, string>, more: Record<string, unknown> = {}) => ({
  version, client, assets: { 'logo.png': 'AAAA' }, media: media('a'.repeat(64)), access: 'application', origins: ['https://api.example.com'], storageScope: { access: 'application', appId: 'app-one' }, ...more,
});
const answer = (data: Record<string, unknown>, owner = true) => ({ data: { name: 'Notes', engine, ...(owner ? { updates: 'live' } : {}), ...data } });
let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility = 'visible';
const frame = () => mocks.frame.props as FrameProps;

async function open(first: ReturnType<typeof answer>) {
  mocks.getNativeRuntime.mockResolvedValueOnce(first);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter><NativeAppView slug="notes" /></MemoryRouter>); });
  await act(async () => {});
}
/** The page is come back to (the throttle between two asks has passed). */
async function comeBack() {
  await act(async () => { vi.advanceTimersByTime(3_001); });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getNativeRuntime.mockReset();
  mocks.getNativeVersion.mockReset();
  mocks.frame.props = null;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host?.remove(); host = null;
  vi.useRealTimers();
  localStorage.clear();
});

it('hands a newer version to the frame the app is in, and does not fetch its media again', async () => {
  await open(answer({ project: project(1, one) }));
  const opened = frame();
  expect(opened.update).toBeUndefined();

  // Still the version it runs: nothing more is asked.
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 1 } });
  await comeBack();
  expect(mocks.getNativeVersion).toHaveBeenCalledWith('notes');
  expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(1);

  // A newer one: fetched as an opening is, naming the media this page already holds.
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 2 } });
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(2, two, { assets: {} }) }));
  await comeBack();
  expect(mocks.getNativeRuntime).toHaveBeenLastCalledWith('notes', undefined, { media: 'a'.repeat(64) });
  // Its media are the ones this page holds (the server sent none again), named by their digest: the
  // frame, which knows what it holds, sends them on only where it holds others.
  expect(frame().update).toEqual({ version: 2, client: two, assets: { 'logo.png': 'AAAA' }, media: 'a'.repeat(64), engine });
  expect(frame().client, 'the frame is not given new props: it would open a new frame').toBe(opened.client);
  expect(frame().version).toBe(1);
  expect(frame().native).toBe(opened.native);
  expect(frame().native?.media, 'the frame is told which media it opens with').toBe('a'.repeat(64));

  // Asked again while the frame has not answered: the same version is not fetched twice.
  await comeBack();
  expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(2);

  // The frame took it. It stays the newest, for a frame opened again for these same props, and
  // nothing is fetched for it again.
  await act(async () => { frame().onUpdate!(2, 'taken'); });
  expect(frame().update?.version).toBe(2);
  expect(frame().client).toBe(opened.client);
  await comeBack();
  expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(2);

  // The next one has other media: fetched, and its own.
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 3 } });
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(3, one, { assets: { 'logo.png': 'BBBB' }, media: media('b'.repeat(64)) }) }));
  await comeBack();
  expect(mocks.getNativeRuntime).toHaveBeenLastCalledWith('notes', undefined, { media: 'a'.repeat(64) });
  expect(frame().update).toEqual({ version: 3, client: one, assets: { 'logo.png': 'BBBB' }, media: 'b'.repeat(64), engine });
  // And the one after it, with those same media, names them as the ones this page holds now.
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 4 } });
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(4, two, { assets: {}, media: media('b'.repeat(64)) }) }));
  await comeBack();
  expect(mocks.getNativeRuntime).toHaveBeenLastCalledWith('notes', undefined, { media: 'b'.repeat(64) });
  expect(frame().update).toEqual({ version: 4, client: two, assets: { 'logo.png': 'BBBB' }, media: 'b'.repeat(64), engine });
  // An answer about a version that is no longer the newest changes nothing.
  await act(async () => { frame().onUpdate!(3, 'reopen'); });
  expect(frame().version).toBe(1);
  expect(frame().update?.version).toBe(4);
});

it('leaves the engine to the frame, which knows the one it runs on', async () => {
  await open(answer({ project: project(1, one) }));
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 2 } });
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(2, two, { assets: {} }), engine: { id: 'zipp-web-python', revision: 'r2' } }));
  await comeBack();
  // Handed with the engine the server runs it on; the frame answers `reopen` where it runs another.
  expect(frame().update?.engine).toEqual({ id: 'zipp-web-python', revision: 'r2' });
  expect(frame().version).toBe(1);
  await act(async () => { frame().onUpdate!(2, 'reopen'); });
  expect(frame().version).toBe(2);
  expect(frame().engine).toEqual({ id: 'zipp-web-python', revision: 'r2' });
  expect(frame().update).toBeUndefined();
});

it('opens the version in a new frame when the running one cannot take it', async () => {
  await open(answer({ project: project(1, one) }));
  const opened = frame();
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 2 } });
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(2, two, { assets: {} }) }));
  await comeBack();
  await act(async () => { frame().onUpdate!(2, 'reopen'); });
  expect(frame().update).toBeUndefined();
  expect(frame().client).toEqual(two);
  expect(frame().version).toBe(2);
  expect(frame().native?.assets, 'with the media it already had, which were not sent again').toEqual({ 'logo.png': 'AAAA' });
  expect(frame().native).not.toBe(opened.native);
});

it.each([
  ['its storage is another app\'s', { storageScope: { access: 'application', appId: 'app-two' } }, {}],
  ['it is for members now', { access: 'members', storageScope: { access: 'members', appId: 'app-one', userId: 'user-1' } }, {}],
  ['it may use files now', { files: 'allow' }, {}],
  ['it may call other origins', { origins: ['https://other.example.com'] }, {}],
  ['it asks FormLogic for visitors now', { formlogic: { visitors: true, ai: false, payments: false } }, {}],
])('never hands over a version where %s: it is opened as an opening', async (_what, differs, top) => {
  await open(answer({ project: project(1, one) }));
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 2 } });
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(2, two, differs), ...top }));
  await comeBack();
  // (a members' app is held to the signed-in person, and nobody is signed in here: it is not even opened)
  if (_what === 'it is for members now') { expect(frame().update).toBeUndefined(); expect(frame().version).toBe(1); return; }
  expect(frame().update, 'not an update in place').toBeUndefined();
  expect(frame().version).toBe(2);
  expect(frame().client).toEqual(two);
});

it('leaves the app as it is when the newer version cannot be fetched, and asks again later', async () => {
  await open(answer({ project: project(1, one) }));
  const opened = frame();
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 2 } });
  mocks.getNativeRuntime.mockResolvedValueOnce({ error: 'The app was updated while it was opening.', status: 409 });
  await comeBack();
  expect(frame().update).toBeUndefined();
  expect(frame().client).toBe(opened.client);
  expect(host?.textContent).toContain('running');
  mocks.getNativeVersion.mockRejectedValueOnce(new Error('offline'));
  await comeBack();
  expect(host?.textContent).toContain('running');
  // The version the server would not serve is not fetched again each time the page asks (the server
  // names it by number alone, and may refuse the whole of it for as long as it stands)...
  mocks.getNativeRuntime.mockResolvedValueOnce(answer({ project: project(2, two, { assets: {} }) }));
  for (let i = 0; i < 3; i++) await comeBack();
  expect(mocks.getNativeVersion.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(2);
  expect(frame().update).toBeUndefined();
  // ...but again two minutes on.
  await act(async () => { vi.advanceTimersByTime(121_000); });
  await act(async () => {});
  expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(3);
  expect(frame().update?.version).toBe(2);
  expect(frame().update?.client).toEqual(two);
});

it('asks while the page is looked at, every twenty seconds, and not while it is hidden', async () => {
  await open(answer({ project: project(1, one) }));
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 1 } });
  await act(async () => { vi.advanceTimersByTime(20_000); });
  await act(async () => {});
  expect(mocks.getNativeVersion).toHaveBeenCalledTimes(1);
  visibility = 'hidden';
  await act(async () => { vi.advanceTimersByTime(60_000); });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(mocks.getNativeVersion).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => {});
  expect(mocks.getNativeVersion).toHaveBeenCalledTimes(2);
});

it('asks as far apart as the server says: a visitor’s page every minute, and at once on coming back', async () => {
  await open(answer({ project: project(1, one), updatesEvery: 60 }));
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 1 } });
  await act(async () => { vi.advanceTimersByTime(59_000); });
  await act(async () => {});
  expect(mocks.getNativeVersion).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1_000); });
  await act(async () => {});
  expect(mocks.getNativeVersion).toHaveBeenCalledTimes(1);
  await comeBack();
  expect(mocks.getNativeVersion).toHaveBeenCalledTimes(2);
});

it('is never talked into asking more often than every ten seconds', async () => {
  await open(answer({ project: project(1, one), updatesEvery: 0.001 }));
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 1 } });
  await act(async () => { vi.advanceTimersByTime(9_000); });
  await act(async () => {});
  expect(mocks.getNativeVersion).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1_000); });
  await act(async () => {});
  expect(mocks.getNativeVersion).toHaveBeenCalledTimes(1);
});

it('asks nothing for someone the server does not show newer versions to', async () => {
  await open(answer({ project: project(1, one) }, false));
  mocks.getNativeVersion.mockResolvedValue({ data: { version: 2 } });
  await comeBack();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(mocks.getNativeVersion).not.toHaveBeenCalled();
  expect(frame().onUpdate).toBeUndefined();
  expect(frame().update).toBeUndefined();
});
