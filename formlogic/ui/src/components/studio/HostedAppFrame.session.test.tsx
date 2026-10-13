// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ bytes: vi.fn(), read: vi.fn(), mutate: vi.fn(), raw: vi.fn(), reset: vi.fn(), storage: vi.fn(), native: vi.fn(), hosted: vi.fn(), getNative: vi.fn(), getHosted: vi.fn(), bridge: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({ getEngineBytes: mocks.bytes, engineIdentity: () => ({ version: 'test', sha256: 'current' }), engineNeedsBytes: () => true }));
vi.mock('../../lib/api', () => ({ api: { runNativeRequest: mocks.native, runHostedAction: mocks.hosted, getNativeRuntime: mocks.getNative, getHostedRuntime: mocks.getHosted } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: mocks.bridge }));
vi.mock('../../lib/nativeAppStorage', () => ({
  NativeStorageError: class extends Error { code = 'corrupt'; },
  isNativeStorageScope: (scope: unknown) => { const value = scope as { access?: string; appId?: string; userId?: string } | null; return !!value && typeof value.appId === 'string' && value.appId.length > 0 && (value.access === 'application' || value.access === 'members' && typeof value.userId === 'string' && value.userId.length > 0); },
  nativeAppStorage: (...args: unknown[]) => { mocks.storage(...args); return { read: mocks.read, mutate: mocks.mutate, exportRaw: mocks.raw, reset: mocks.reset }; },
}));
import { HostedAppFrame } from './HostedAppFrame';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';
import { admitHostedActor, captureHostedRequest } from '../../lib/hostedActor';
const actor = { version: 1 as const, appId: 'app-a', userId: 'alice', roleId: 'member', isOwner: false, sessionId: 'a'.repeat(64) };
import { NATIVE_PROTOCOL } from '../../lib/softn/protocol';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
type Channel = { port1: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
const channels: Channel[] = [];
let root: Root;
let container: HTMLDivElement;
const scope = { access: 'members' as const, appId: 'app-123', userId: 'alice' };
const client = { 'manifest.json': '{}' };
const native = { assets: {}, access: 'members' as const, storageScope: scope };
const engine = { id: 'zipp-web-python', revision: 'r1' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function mount(config: { native?: typeof native; engine?: typeof engine } = { native, engine }) {
  await act(async () => root.render(<HostedAppFrame slug="notes" client={client} version={1} hostedAdmission={config.native ? undefined : admitHostedActor(actor, captureHostedRequest(), "notes")!} {...config} />));
  const iframe = container.querySelector('iframe');
  const post = iframe ? vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined) : vi.fn();
  return { iframe, post };
}
async function ready(iframe: HTMLIFrameElement | null) { if (iframe) await act(async () => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', nativeProtocol: NATIVE_PROTOCOL, zipp: { version: 'test', sha256: 'current' } } }))); }
async function call(action = 'nativeRequest', input: object = { url: '/coffee/me', options: {} }, channel = channels[0]) { await act(async () => channel.port1.onmessage?.({ data: { type: 'call', id: 1, action, input } })); }
const button = (label: string) => [...container.querySelectorAll('button')].find(value => value.textContent === label);
beforeEach(() => {
  vi.resetAllMocks(); channels.length = 0; setSessionOwner('alice'); bumpSessionGeneration();
  mocks.bytes.mockResolvedValue(new ArrayBuffer(8)); mocks.read.mockReturnValue({ token: 'alice-synthetic' }); mocks.raw.mockReturnValue('{damaged'); mocks.mutate.mockReturnValue({ saved: true });
  mocks.native.mockResolvedValue({ data: { ok: true } }); mocks.hosted.mockResolvedValue({ data: { actor, result: { ok: true } } });
  vi.stubGlobal('MessageChannel', class { port1 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null }; port2 = {}; constructor() { channels.push(this); } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('selects storage only with admitted access and server principal/app scope', async () => {
  const frame = await mount(); await ready(frame.iframe);
  expect(mocks.storage).toHaveBeenCalledWith('notes', scope);
  expect(frame.post).toHaveBeenCalledWith(expect.objectContaining({ storage: { token: 'alice-synthetic' } }), '*', expect.anything());
});
it.each([undefined, null, {}, { access: 'members', appId: 'app-123', userId: 'bob' }, { access: 'application', appId: 'app-123' }])('denies invalid or mismatched scope %j before any storage access or init', async bad => {
  const invalid = { ...native, storageScope: bad } as typeof native;
  const frame = await mount({ native: invalid }); await ready(frame.iframe);
  expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.raw).not.toHaveBeenCalled(); expect(frame.post).not.toHaveBeenCalled(); expect(button('Reset saved data')).toBeUndefined();
});
it('keeps ordinary hosted frames independent of native storage metadata', async () => {
  const frame = await mount({ engine }); await ready(frame.iframe);
  expect(mocks.storage).not.toHaveBeenCalled(); expect(frame.post).toHaveBeenCalled(); await call('save', {}); expect(mocks.hosted).toHaveBeenCalledTimes(1);
});
it('does not hydrate after a session changes while engine bytes load', async () => {
  const late = deferred<ArrayBuffer>(); mocks.bytes.mockReturnValue(late.promise); const frame = await mount(); await ready(frame.iframe);
  await act(async () => { bumpSessionGeneration(); setSessionOwner('bob'); }); await act(async () => late.resolve(new ArrayBuffer(8)));
  expect(mocks.read).not.toHaveBeenCalled(); expect(frame.post).not.toHaveBeenCalled();
});
it.each(['nativeStorage', 'nativeRequest', 'save', 'workspaceInfo'])('refuses stale %s callbacks synchronously after session teardown', async action => {
  const frame = await mount(); await ready(frame.iframe); const channel = channels[0];
  await act(async () => { bumpSessionGeneration(); void channel.port1.onmessage?.({ data: { type: 'call', id: 1, action, input: action === 'nativeStorage' ? { operation: 'set', key: 'token', value: 'late' } : { url: '/coffee/me', options: {} } } }); });
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.hosted).not.toHaveBeenCalled(); expect(mocks.bridge).not.toHaveBeenCalled(); expect(channel.port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
});
it('discards late native replies and does not refetch under the next session', async () => {
  const pending = deferred<unknown>(); mocks.native.mockReturnValue(pending.promise); const frame = await mount(); await ready(frame.iframe); const old = channels[0];
  await act(async () => { void old.port1.onmessage?.({ data: { type: 'call', id: 1, action: 'nativeRequest', input: { url: '/coffee/me', options: {} } } }); });
  await act(async () => { bumpSessionGeneration(); setSessionOwner('bob'); pending.resolve({ status: 409, code: 'engine_changed' }); });
  expect(old.port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 })); expect(mocks.getNative).not.toHaveBeenCalled();
});
it('ignores late runtime errors after session teardown', async () => {
  const frame = await mount(); await ready(frame.iframe); const old = channels[0];
  await act(async () => { bumpSessionGeneration(); void old.port1.onmessage?.({ data: { type: 'error' } }); });
  expect(container.textContent).not.toContain('Check its interface');
});
it('fences recovery buttons before export/reset when the same account has a new session', async () => {
  mocks.read.mockImplementation(() => { throw new Error('damaged'); }); const frame = await mount(); await ready(frame.iframe);
  const reset = button('Reset saved data'); const exp = button('Export saved data'); expect(reset).toBeTruthy(); expect(exp).toBeTruthy(); mocks.raw.mockClear();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => { bumpSessionGeneration(); reset!.click(); exp!.click(); });
  expect(mocks.reset).not.toHaveBeenCalled(); expect(mocks.raw).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});
it('rejects a refetched project whose member scope changes before rebuilding the frame', async () => {
  mocks.native.mockResolvedValue({ status: 409, code: 'engine_changed' });
  mocks.getNative.mockResolvedValue({ data: { engine: { ...engine, revision: 'r2' }, project: { version: 2, client: { 'manifest.json': '{"changed":true}' }, assets: {}, access: 'members', storageScope: { ...scope, userId: 'bob' } } } });
  const frame = await mount(); await ready(frame.iframe); mocks.storage.mockClear(); await call();
  expect(mocks.storage).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it('does not adopt a late engine refetch from an ended session', async () => {
  const late = deferred<unknown>(); mocks.native.mockResolvedValue({ status: 409, code: 'engine_changed' }); mocks.getNative.mockReturnValue(late.promise);
  const frame = await mount(); await ready(frame.iframe); await call(); mocks.storage.mockClear();
  await act(async () => { bumpSessionGeneration(); setSessionOwner('bob'); late.resolve({ data: { engine: { ...engine, revision: 'r2' }, project: { version: 2, client, ...native } } }); });
  expect(mocks.storage).not.toHaveBeenCalled();
});
it('passes a matching fresh scope through an engine remount', async () => {
  mocks.native.mockResolvedValue({ status: 409, code: 'engine_changed' });
  mocks.getNative.mockResolvedValue({ data: { engine: { ...engine, revision: 'r2' }, project: { version: 2, client, ...native } } });
  const frame = await mount(); await ready(frame.iframe); mocks.storage.mockClear(); await call();
  expect(mocks.storage).toHaveBeenLastCalledWith('notes', scope); expect(container.querySelector('iframe')).not.toBe(frame.iframe);
});
it('fences workspace navigation callbacks after teardown', async () => {
  const late = deferred<unknown>(); let navigate: ((path: string) => void) | undefined;
  mocks.bridge.mockImplementation((_slug, _action, _input, callback) => { navigate = callback; return late.promise; });
  const frame = await mount(); await ready(frame.iframe); const old = channels[0];
  await act(async () => { void old.port1.onmessage?.({ data: { type: 'call', id: 1, action: 'workspaceDashboard', input: {} } }); });
  await act(async () => { bumpSessionGeneration(); navigate?.('/never-navigate-after-logout'); late.resolve({ opened: true }); });
  expect(old.port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 })); expect(mocks.bridge.mock.calls[0][4]).toEqual(expect.any(Function));
});
it('does not carry an engine override across newer native props with the same parent engine', async () => {
  mocks.native.mockResolvedValue({ status: 409, code: 'engine_changed' });
  const overrideClient = { 'manifest.json': '{"override":true}' };
  mocks.getNative.mockResolvedValue({ data: { engine: { ...engine, revision: 'r2' }, project: { version: 2, client: overrideClient, ...native } } });
  const original = await mount(); await ready(original.iframe); await call();
  const newer = { ...native, storageScope: { ...scope, appId: 'new-app' } };
  mocks.storage.mockClear(); const next = await mount({ native: newer, engine }); await ready(next.iframe);
  expect(mocks.storage).toHaveBeenLastCalledWith('notes', newer.storageScope);
  expect(next.post).toHaveBeenCalledWith(expect.objectContaining({ client }), '*', expect.anything());
});
it('replaces a member namespace on admitted app-id change with no stale-port mutation', async () => {
  const original = await mount(); await ready(original.iframe); const old = channels[0];
  const newer = { ...native, storageScope: { ...scope, appId: 'new-app' } };
  const next = await mount({ native: newer, engine }); await ready(next.iframe); mocks.mutate.mockClear();
  await call('nativeStorage', { operation: 'set', key: 'token', value: 'late' }, old);
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.storage).toHaveBeenLastCalledWith('notes', newer.storageScope); expect(next.iframe).not.toBe(original.iframe);
});
