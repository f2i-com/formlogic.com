// @vitest-environment jsdom
// The owner's hosting panel and the engine it shows: the server decides an app's engine again from
// every bundle published (a `.py` added or removed changes it), so the panel takes the engine from
// the publish answer; and after the owner stores a choice, the panel re-reads its OWN manage GET
// rather than showing the PUT's answer, which is merged over the hosted and native bundles.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';
vi.mock('../../stores/authStore', () => ({ useAuthStore: Object.assign((selector: (state: unknown) => unknown) => selector({ user: { id: 'u1', isCodeTrustVerified: true } }), { setState: () => {}, getState: () => ({ user: { id: 'u1', isCodeTrustVerified: true } }) }) }));
vi.mock('../../hooks/useAiReady', () => ({ useAiReady: () => ({ ready: false }) }));

const { getHosting, publish, putEngine } = vi.hoisted(() => ({ getHosting: vi.fn(), publish: vi.fn(), putEngine: vi.fn() }));
vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
vi.mock('../../lib/api', () => ({ api: { getAppHosting: getHosting, publishAppHosting: publish, putAppEngine: putEngine } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: ({ engine }: { engine?: { id: string } }) => <p data-testid="frame">{engine?.id ?? 'none'}</p> }));
vi.mock('./AppEditorDialog', () => ({ AppEditorDialog: () => null }));
import { HostedAppPanel } from './HostedAppPanel';
import type { AppEngine, OwnerEnginePolicy } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const actor = { version: 1, appId: 'app1', userId: 'u1', roleId: null, isOwner: true, sessionId: 'a'.repeat(64) };
const app = { id: 'app1', slug: 'app', name: 'App' };
const POLICY: OwnerEnginePolicy = { default: 'zipp-web-python', allowed: ['zipp-web-python', 'host-js'], installed: ['zipp-web-python', 'host-js'] };
const HOST_JS: AppEngine = { id: 'host-js', requested: 'host-js', stored: 'host-js', revision: 'r1' };
const PYTHON_REQUIRED: AppEngine = { id: 'zipp-web-python', requested: 'host-js', stored: 'host-js', reason: 'python-required', revision: 'r2' };
const deployment = { version: 1, updatedAt: '2026-09-16T00:00:00Z', client: { 'manifest.json': '{}', 'ui/main.ui': '<Text/>' }, actions: {} };
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  setSessionOwner("u1");
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com', isCodeTrustVerified: true }, isLoading: false, isInitialized: true, error: null });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); });

const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
const runsOn = () => document.body.textContent?.match(/This app runs on ([^.]+)\./)?.[1];
async function open() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><HostedAppPanel app={app} /></MemoryRouter>));
  await act(async () => button('App hosting')!.click());
}
async function choose(value: string) {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="App engine"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('shows the engine the server decided from the bundle just published', async () => {
  // A verified owner on host-js publishes a bundle that adds main.py: the server now says
  // zipp-web-python (python-required). A panel still saying host-js would mount its preview on the
  // host document, which the shell refuses by name.
  getHosting.mockResolvedValue({ data: { actor, deployment: null, engine: HOST_JS, enginePolicy: POLICY } });
  publish.mockResolvedValue({ data: { actor, deployment, engine: PYTHON_REQUIRED, enginePolicy: POLICY } });
  await open();
  expect(runsOn()).toBe('None (host JavaScript, verified accounts)');
  await act(async () => button('Publish app project')!.click());
  expect(publish).toHaveBeenCalledTimes(1);
  expect(runsOn()).toBe('ZIPP (JavaScript and Python)');
  expect(document.body.textContent).toContain('This app needs Python');
  expect(getHosting).toHaveBeenCalledTimes(1);
});

it('keeps the engine it had when a publish answer carries none', async () => {
  getHosting.mockResolvedValue({ data: { actor, deployment: null, engine: HOST_JS, enginePolicy: POLICY } });
  publish.mockResolvedValue({ data: { actor, deployment } });
  await open();
  await act(async () => button('Publish app project')!.click());
  expect(document.body.textContent).toContain('Version 1 live');
  expect(runsOn()).toBe('None (host JavaScript, verified accounts)');
});

it('re-reads its own manage GET after a choice is stored, rather than showing the merged PUT answer', async () => {
  // The PUT /engine answer covers the whole column — hosted AND native bundles merged — so an app
  // with Python only in its native project is told zipp-web-python there, while this panel's
  // hosted bundle, and the preview it mounts, run host-js.
  getHosting.mockResolvedValueOnce({ data: { actor, deployment, engine: { ...HOST_JS, stored: null, requested: 'zipp-web-python', id: 'zipp-web-python' }, enginePolicy: POLICY } });
  putEngine.mockResolvedValue({ data: { engine: PYTHON_REQUIRED, policy: POLICY } });
  getHosting.mockResolvedValueOnce({ data: { actor, deployment, engine: HOST_JS, enginePolicy: POLICY } });
  await open();
  expect(runsOn()).toBe('ZIPP (JavaScript and Python)');
  await choose('host-js');
  expect(putEngine).toHaveBeenCalledWith('app1', 'host-js');
  expect(getHosting).toHaveBeenCalledTimes(2);
  expect(runsOn()).toBe('None (host JavaScript, verified accounts)');
  expect(document.body.textContent).not.toContain('This app needs Python');
});

it.each([undefined, null, { ...actor, userId: 'u2' }, { ...actor, appId: 'other' }, { ...actor, roleId: 'member', isOwner: false }])('refuses missing or mismatched management actor %# before exposing private scripts', async identity => {
  getHosting.mockResolvedValue({ data: { actor: identity, deployment: { ...deployment, actions: { secret: { source: 'PRIVATE_SCRIPT', access: 'owner', mode: 'read' } } } } });
  await open(); expect(document.body.textContent).toContain('could not verify'); expect(document.body.textContent).not.toContain('PRIVATE_SCRIPT');
  await act(async () => button('Publish app project')?.click()); expect(publish).not.toHaveBeenCalled();
});
it('does not display unverified management failure text', async () => {
  getHosting.mockResolvedValue({ error: 'PRIVATE_OTHER_ACCOUNT', status: 403, actor: { ...actor, userId: 'u2' } });
  await open(); expect(document.body.textContent).toContain('could not verify'); expect(document.body.textContent).not.toContain('PRIVATE_OTHER_ACCOUNT');
});
it('quarantines private editor state when a publish error has changed identity', async () => {
  getHosting.mockResolvedValue({ data: { actor, deployment, engine: HOST_JS, enginePolicy: POLICY } });
  publish.mockResolvedValue({ error: 'PRIVATE_OTHER_ACCOUNT', status: 403, actor: { ...actor, userId: 'u2' } });
  await open();
  const editor = document.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '<Text>Edited</Text>');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Publish changes')!.disabled).toBe(false);
  await act(async () => button('Publish changes')!.click());
  expect(publish).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('could not verify'); expect(document.body.textContent).not.toContain('PRIVATE_OTHER_ACCOUNT'); expect(document.body.textContent).not.toContain('Version 1 live');
});
it('same-actor publish failure retains a retryable draft', async () => {
  getHosting.mockResolvedValue({ data: { actor, deployment: null, engine: HOST_JS, enginePolicy: POLICY } });
  publish.mockResolvedValueOnce({ error: 'Temporary conflict', status: 409, actor }).mockResolvedValueOnce({ data: { actor, deployment } });
  await open(); await act(async () => button('Publish app project')!.click()); expect(document.body.textContent).toContain('Temporary conflict');
  await act(async () => button('Publish app project')!.click()); expect(publish).toHaveBeenCalledTimes(2); expect(document.body.textContent).toContain('Version 1 live');
});
it('clears the private editor immediately on a same-user session boundary', async () => {
  getHosting.mockResolvedValueOnce({ data: { actor, deployment } }).mockReturnValue(new Promise(() => {}));
  await open(); expect(document.body.textContent).toContain('Version 1 live');
  await act(async () => { bumpSessionGeneration(); }); expect(document.body.textContent).not.toContain('Version 1 live'); expect(getHosting).toHaveBeenCalledTimes(2);
});
