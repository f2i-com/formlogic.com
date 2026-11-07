// @vitest-environment jsdom
// While a hosted SoftN app downloads, the page shows its loading screen: the app's background and a
// wheel in its colour, no words; and before the server has said, what this browser saw last time.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({ HostedAppFrame: () => <div data-testid="frame" /> }));

import { NativeAppView } from './NativeAppView';
import { rememberLook, type NativeLook } from '../../lib/appLook';
import { useAuthStore } from '../../stores/authStore';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const look: NativeLook = { background: '#0b1020', spinner: '#e9c46a', themeColor: null, description: '', icon: null, version: 'abc', installable: true };

let root: Root | null = null;
let host: HTMLElement | null = null;
async function open(sendLook: NativeLook | null | undefined) {
  // The runtime answered (its look), and its media are still downloading.
  mocks.getNativeRuntime.mockImplementation((_slug: string, onLook?: (look: NativeLook | null) => void) => { if (sendLook !== undefined) onLook?.(sendLook); return new Promise(() => {}); });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<NativeAppView slug="outerstead" fullScreen />); });
  await act(async () => {});
}
const splash = () => document.querySelector<HTMLElement>('[data-testid="app-splash"]');

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: { id: 'member-a', email: 'a@example.test' } as never });
  setSessionOwner('member-a'); bumpSessionGeneration();
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; setSessionOwner(null); useAuthStore.setState({ user: null }); });

describe('opening a hosted SoftN app', () => {
  it('shows the app’s loading screen, a wheel and no words', async () => {
    await open(look);
    expect(splash()?.getAttribute('role')).toBe('status');
    expect(splash()?.style.background).toBe('rgb(11, 16, 32)');
    expect((splash()?.firstElementChild as HTMLElement).style.borderColor).toContain('rgb(233, 196, 106)');
    expect(document.body.textContent).toBe('');
    expect(document.body.textContent).not.toContain('Opening your app');
  });
  it('opens on the colours this browser saw last time, before the server says', async () => {
    rememberLook('outerstead', look);
    await open(undefined);
    expect(splash()?.style.background).toBe('rgb(11, 16, 32)');
  });
  it('with no look of its own, the site’s', async () => {
    await open(null);
    expect(splash()?.style.background).toBe('');
    expect(splash()?.className).toContain('bg-white');
  });
});
