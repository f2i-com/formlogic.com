// @vitest-environment jsdom
// A full-screen app's page links the manifest that installs it only once the app is published: a
// draft's manifest answers its signed-in owner alone, and a browser asks for it signed out.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeLook } from '../../lib/appLook';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: () => <div data-testid="frame" /> }));
vi.mock('../../lib/formlogic/zipp-bytes', () => ({ engineIdentity: () => undefined, engineNeedsBytes: () => false, getEngineBytes: vi.fn() }));

import { NativeAppView } from './NativeAppView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const look = (installable: boolean): NativeLook => ({ background: '#0b1020', spinner: '#e9c46a', themeColor: '#123456', description: 'A colony.', icon: 'raster', version: 'abc123', installable });
let root: Root | null = null;
let host: HTMLElement | null = null;
async function open(installable: boolean) {
  mocks.getNativeRuntime.mockImplementation((_slug: string, onLook?: (look: NativeLook | null) => void) => {
    onLook?.(look(installable));
    return Promise.resolve({ data: { name: 'Outerstead', project: { version: 1, client: { 'manifest.json': '{}' }, assets: {}, access: 'application', origins: [], storageScope: { access: 'application', appId: 'app-one' } } } });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<NativeAppView slug="outerstead" fullScreen />); });
  await act(async () => {});
}
const manifests = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]')].map(link => link.getAttribute('href'));
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null; localStorage.clear(); });

it('links a published app’s manifest', async () => {
  await open(true);
  expect(manifests()).toEqual([expect.stringMatching(/\/app\/outerstead\/manifest\.json$/)]);
});

it('links none for a draft, whose manifest a browser could not fetch', async () => {
  await open(false);
  expect(manifests()).toEqual([]);
});
