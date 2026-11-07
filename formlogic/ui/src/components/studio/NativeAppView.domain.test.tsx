// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://outerstead.example/"}
// The app's frame is told it is on the app's own domain (where it takes the saves the site's earlier
// SoftN page left: nativeAppStorage) only on a domain at an address that is not FormLogic's own.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), frames: [] as Array<{ domain?: boolean }> }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({
  HostedAppFrame: (props: { domain?: boolean }) => { mocks.frames.push(props); return <div data-testid="frame" />; },
}));

import { NativeAppView } from './NativeAppView';
import { DomainSignInContext } from '../../lib/domainSignIn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
async function open(onDomain: boolean, platform: string | null) {
  mocks.frames.length = 0;
  mocks.getNativeRuntime.mockResolvedValue({ data: { name: 'Outerstead', project: { version: 1, client: { 'manifest.json': '{}' }, assets: {}, access: 'application', origins: [], storageScope: { access: 'application', appId: 'app-one' } } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<DomainSignInContext.Provider value={platform}><NativeAppView slug="outerstead" fullScreen onDomain={onDomain} /></DomainSignInContext.Provider>); });
  await act(async () => {});
  return mocks.frames.at(-1)?.domain;
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null; });

it('on the app’s own domain, away from FormLogic’s address', async () => {
  expect(await open(true, 'https://formlogic.example')).toBe(true);
});

it('not on a domain page at FormLogic’s own address (a local ?__flhost= preview has no platform address)', async () => {
  expect(await open(true, null)).toBe(false);
  expect(await open(true, 'https://outerstead.example/formlogic')).toBe(false);
});

it('not on FormLogic’s own app page', async () => {
  expect(await open(false, null)).toBe(false);
});
