// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setSessionOwner } from '../../lib/sessionGeneration';

const mocks = vi.hoisted(() => ({ getHosting: vi.fn(), publish: vi.fn(), returned: new Uint8Array(), editorError: '' }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: Object.assign((select: (state: unknown) => unknown) => select({ user: { id: 'u1' } }), { getState: () => ({ user: { id: 'u1' } }) }) }));
vi.mock('../../hooks/useAiReady', () => ({ useAiReady: () => ({ ready: false }) }));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
vi.mock('../../lib/api', () => ({ api: { getAppHosting: mocks.getHosting, publishAppHosting: mocks.publish } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: () => null }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: ({ onApply, onClose }: { onApply: (bytes: Uint8Array) => Promise<void>; onClose: () => void }) => <button onClick={() => void onApply(mocks.returned).then(onClose).catch(error => { mocks.editorError = error.message; })}>Return project</button> }));
import { HostedAppPanel } from './HostedAppPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const actor = { version: 1, appId: 'app1', userId: 'u1', roleId: null, isOwner: true, sessionId: 'a'.repeat(64) };
const python = 'count = 7\n';
const bundle = (extra: Record<string, string> = {}) => zipSync(Object.fromEntries(Object.entries({
  'manifest.json': JSON.stringify({ name: 'Counter', main: 'ui/main.ui', files: { logic: ['logic/counter.py'] } }),
  'ui/main.ui': '<logic src="../logic/counter.py" /><Text>{count}</Text>',
  'logic/counter.py': python,
  ...extra,
}).map(([path, text]) => [path, strToU8(text)])));
const actions = { info: { source: 'function onRequest() { return "private"; }', access: 'member', mode: 'read' } };
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  setSessionOwner('u1');
  mocks.editorError = '';
  mocks.returned = bundle();
  mocks.getHosting.mockResolvedValue({ data: { actor, deployment: { version: 2, client: { 'manifest.json': '{"main":"ui/main.ui"}', 'ui/main.ui': '<Text>Before</Text>' }, actions } } });
  mocks.publish.mockResolvedValue({ error: 'Fixture stops at the publish boundary', actor });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); });
const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text)!;
async function open() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><HostedAppPanel app={{ id: 'app1', slug: 'counter', name: 'Counter' }} /></MemoryRouter>));
  await act(async () => button('App hosting').click());
}
async function upload(bytes: Uint8Array) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = { name: 'counter.softn', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

it('imports a Python .softn as a draft and publishes the original bytes and existing private actions', async () => {
  await open();
  await upload(bundle());
  expect(document.body.textContent).toContain('Project imported as a draft');
  expect(mocks.publish).not.toHaveBeenCalled();
  await act(async () => button('Publish changes').click());
  expect(mocks.publish).toHaveBeenCalledWith('app1', expect.objectContaining({ client: expect.objectContaining({ 'logic/counter.py': python }), actions }), 2);
});

it('takes Python editor output into the draft while preserving private actions', async () => {
  await open();
  await act(async () => button('Open Visual Builder').click());
  await act(async () => button('Return project').click());
  expect(mocks.editorError).toBe('');
  expect(document.body.textContent).toContain('Editor changes returned to your draft');
  expect(mocks.publish).not.toHaveBeenCalled();
  await act(async () => button('Publish changes').click());
  expect(mocks.publish).toHaveBeenCalledWith('app1', expect.objectContaining({ client: expect.objectContaining({ 'logic/counter.py': python }), actions }), 2);
});

it.each(['private/helper.py', 'logic/helper.PY', 'logic/worker.wasm'])('refuses unsupported editor output %s without publishing', async path => {
  await open();
  mocks.returned = bundle({ [path]: 'not a supported client file' });
  await act(async () => button('Open Visual Builder').click());
  await act(async () => button('Return project').click());
  expect(mocks.editorError).not.toBe('');
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(button('Return project')).toBeTruthy();
});
