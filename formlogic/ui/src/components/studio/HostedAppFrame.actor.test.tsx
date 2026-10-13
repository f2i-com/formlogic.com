// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ hosted: vi.fn(), runtime: vi.fn(), bridge: vi.fn() }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({ getEngineBytes: vi.fn(async () => new ArrayBuffer(8)), engineIdentity: () => ({ version: 'test', sha256: 'current' }), engineNeedsBytes: () => true }));
vi.mock('../../lib/api', () => ({ api: { runHostedAction: mocks.hosted, getHostedRuntime: mocks.runtime } }));
vi.mock('../../lib/softn/workspaceBridge', () => ({ workspaceBridge: mocks.bridge }));
import { HostedAppFrame } from './HostedAppFrame';
import { admitHostedActor, captureHostedRequest, type HostedAdmission } from '../../lib/hostedActor';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
type Channel = { port1: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => Promise<void>) | null }; port2: object };
const channels: Channel[] = []; let root: Root; let container: HTMLDivElement; let admission: HostedAdmission;
const actor = { version: 1 as const, appId: 'app-a', userId: 'alice', roleId: 'member', isOwner: false, sessionId: 'a'.repeat(64) };
const client = { 'manifest.json': '{}' }; const engine = { id: 'zipp-web-python', revision: 'r1' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function mount(options: { hostedAdmission?: HostedAdmission; workspaceOnly?: boolean; slug?: string; client?: Record<string, string> } = {}) {
  await act(async () => root.render(<HostedAppFrame slug="app" client={client} version={1} engine={engine} hostedAdmission={admission} {...options} />));
  const iframe = container.querySelector('iframe');
  if (iframe) await act(async () => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow!, data: { type: 'formlogic:ready', zipp: { version: 'test', sha256: 'current' } } })));
}
async function call(channel = channels.at(-1)!, action = 'save', input = { requestId: 'retry-1' }) {
  await act(async () => channel.port1.onmessage?.({ data: { type: 'call', id: 1, action, input } }));
}
beforeEach(() => {
  vi.resetAllMocks(); channels.length = 0; setSessionOwner('alice'); bumpSessionGeneration(); admission = admitHostedActor(actor, captureHostedRequest(), 'app')!;
  mocks.hosted.mockResolvedValue({ data: { actor, result: { ok: true } } }); mocks.bridge.mockResolvedValue({ opened: true });
  vi.stubGlobal('MessageChannel', class { port1 = { postMessage: vi.fn(), close: vi.fn(), onmessage: null }; port2 = {}; constructor() { channels.push(this); } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('captures initiating actor independently of guest actor claims and returns only script result', async () => {
  await mount(); const input = { requestId: 'retry-1', actor: { ...actor, userId: 'bob' } }; await call(undefined, 'save', input);
  expect(mocks.hosted).toHaveBeenCalledWith('app', 'save', input, expect.anything(), 'zipp-web-python;r1', actor);
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ id: 1, result: { result: { ok: true } } });
});
it.each([undefined, null, { ...actor, userId: 'bob' }, { ...actor, appId: 'app-b' }, { ...actor, roleId: 'revoked' }, { ...actor, sessionId: 'b'.repeat(64) }, { ...actor, isOwner: true, roleId: null }])('quarantines missing or changed response authority %#', async identity => {
  mocks.hosted.mockResolvedValue({ data: { actor: identity, result: { secret: 'never render' } } }); await mount(); await call();
  expect(channels[0].port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({ type: 'formlogic:dispose' }); expect(container.querySelector('iframe')).toBeNull();
  expect(container.textContent).not.toContain('never render'); await call(channels[0]); expect(mocks.hosted).toHaveBeenCalledTimes(1);
});
it.each(['actor_changed', 'actor_context_required', 'actor_context_unavailable'])('typed %s retires even a matching stamped frame', async code => {
  mocks.hosted.mockResolvedValue({ error: 'sensitive denial', status: 409, code, actor }); await mount(); await call(); expect(container.querySelector('iframe')).toBeNull(); expect(container.textContent).not.toContain('sensitive denial');
});
it('missing error identity cannot leak another actor failure text', async () => {
  mocks.hosted.mockResolvedValue({ error: 'private failure', status: 403 }); await mount(); await call(); expect(container.querySelector('iframe')).toBeNull(); expect(container.textContent).not.toContain('private failure');
});
it('same-actor failures and retries preserve the initiating request', async () => {
  mocks.hosted.mockResolvedValueOnce({ error: 'Conflict', status: 409, actor }).mockResolvedValueOnce({ data: { actor, result: { saved: true } } });
  await mount(); await call(); await call(); expect(mocks.hosted).toHaveBeenCalledTimes(2);
  expect(mocks.hosted.mock.calls[0][2]).toEqual(mocks.hosted.mock.calls[1][2]); expect(container.querySelector('iframe')).not.toBeNull();
});
it('transport uncertainty permits a same-admission retry without forwarding transport detail', async () => {
  mocks.hosted.mockResolvedValueOnce({ error: 'private network detail', transportFailure: true }); await mount(); await call(); await call();
  expect(mocks.hosted).toHaveBeenCalledTimes(2); expect(container.querySelector('iframe')).not.toBeNull(); expect(JSON.stringify(channels[0].port1.postMessage.mock.calls)).not.toContain('private network detail');
});
it('engine refetch for the same actor remounts without replaying the abandoned write', async () => {
  mocks.hosted.mockResolvedValue({ error: 'changed', status: 409, code: 'engine_changed', actor });
  mocks.runtime.mockResolvedValue({ data: { actor, deployment: { version: 2, client }, engine: { ...engine, revision: 'r2' } } });
  await mount(); await call(); expect(mocks.runtime).toHaveBeenCalledTimes(1); expect(mocks.hosted).toHaveBeenCalledTimes(1); expect(container.querySelector('iframe')).not.toBeNull();
});
it('a changed actor in engine refetch cannot acquire a new mount', async () => {
  mocks.hosted.mockResolvedValue({ error: 'changed', status: 409, code: 'engine_changed', actor });
  mocks.runtime.mockResolvedValue({ data: { actor: { ...actor, roleId: 'other' }, deployment: { version: 2, client }, engine: { ...engine, revision: 'r2' } } });
  await mount(); await call(); expect(container.querySelector('iframe')).toBeNull(); expect(mocks.hosted).toHaveBeenCalledTimes(1);
});
it('drops late action responses and old port calls at an observed account boundary', async () => {
  const late = deferred<unknown>(); mocks.hosted.mockReturnValue(late.promise); await mount();
  await act(async () => { void channels[0].port1.onmessage?.({ data: { type: 'call', id: 1, action: 'read', input: {} } }); });
  await act(async () => setSessionOwner('bob')); await act(async () => late.resolve({ data: { actor, result: 'private A' } })); await call(channels[0]);
  expect(mocks.hosted).toHaveBeenCalledTimes(1); expect(channels[0].port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 })); expect(container.querySelector('iframe')).toBeNull();
});
it('old admission cannot revive via changed client props in a new same-user session', async () => {
  await mount(); await act(async () => { bumpSessionGeneration(); }); await mount({ client: { 'manifest.json': '{"new":true}' } }); expect(container.querySelector('iframe')).toBeNull();
});
it('missing admission fails before initialization', async () => { await mount({ hostedAdmission: undefined }); expect(channels).toHaveLength(0); expect(container.querySelector('iframe')).toBeNull(); });
it('changed source props cannot revive a quarantined admission', async () => {
  mocks.hosted.mockResolvedValue({ data: { result: 'unbound' } }); await mount(); await call();
  await mount({ client: { 'manifest.json': '{"changed":true}' } }); expect(container.querySelector('iframe')).toBeNull(); expect(channels).toHaveLength(1);
  admission = admitHostedActor(actor, captureHostedRequest(), 'app')!; await mount(); expect(container.querySelector('iframe')).not.toBeNull();
});
it('fresh same-actor admission replaces the active iframe even with identical source props', async () => {
  await mount(); const old = container.querySelector('iframe'); const oldChannel = channels[0];
  admission = admitHostedActor(actor, captureHostedRequest(), 'app')!; await mount();
  expect(container.querySelector('iframe')).not.toBe(old); expect(channels).toHaveLength(2);
  await call(oldChannel); expect(mocks.hosted).not.toHaveBeenCalled(); await call(); expect(mocks.hosted).toHaveBeenCalledTimes(1);
});
it('built-in workspace bridge remains functional but cannot invoke private named actions', async () => {
  await mount({ workspaceOnly: true, hostedAdmission: undefined }); await call(undefined, 'workspaceInfo'); expect(mocks.bridge).toHaveBeenCalledTimes(1); await call(); expect(mocks.hosted).not.toHaveBeenCalled(); expect(container.querySelector('iframe')).not.toBeNull();
});
