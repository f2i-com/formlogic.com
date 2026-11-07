// @vitest-environment jsdom
// Whether a hosted SoftN app may use files on this device: the owner's choice, and where the owner
// asks, the person's answer, settled before the app's frame is made.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), frames: [] as Array<{ native?: { files?: boolean } }> }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn() } }));
vi.mock('./HostedAppFrame', () => ({
  HostedAppFrame: (props: { native?: { files?: boolean } }) => { mocks.frames.push(props); return <div data-testid="frame">{props.native?.files ? 'files' : 'no files'}</div>; },
}));

import { NativeAppView } from './NativeAppView';
import { useAuthStore } from '../../stores/authStore';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Files = 'ask' | 'allow' | undefined;
const runtime = (files: Files, access: 'application' | 'members', userId: string) => ({
  data: {
    name: 'Outerstead',
    project: {
      version: 1, client: { 'manifest.json': '{}', 'ui/main.ui': '<Text/>' }, assets: {}, access, origins: [],
      storageScope: access === 'members' ? { access, appId: 'app-one', userId } : { access, appId: 'app-one' },
      ...(files ? { files } : {}),
    },
  },
});

let root: Root | null = null;
let host: HTMLElement | null = null;
async function open(files: Files, access: 'application' | 'members' = 'application', userId = 'member-a') {
  mocks.getNativeRuntime.mockResolvedValue(runtime(files, access, userId));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<NativeAppView slug="outerstead" />); });
  await act(async () => {});
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null; host?.remove(); host = null;
}
const asked = () => [...document.querySelectorAll('[role="dialog"]')].find(node => /would like to use files on this device/.test(node.textContent ?? '')) ?? null;
const frame = () => document.querySelector('[data-testid="frame"]')?.textContent ?? null;
async function choose(label: string) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}
function signIn(id: string) {
  useAuthStore.setState({ user: { id, email: `${id}@example.test` } as never });
  setSessionOwner(id); bumpSessionGeneration();
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); mocks.frames.length = 0; signIn('member-a'); });
afterEach(async () => { await close(); setSessionOwner(null); useAuthStore.setState({ user: null }); });

describe('files on this device', () => {
  it('are not granted, and nobody is asked, unless the owner chose', async () => {
    await open(undefined);
    expect(asked()).toBeNull();
    expect(frame()).toBe('no files');
  });

  it('are granted without asking where the owner allows them', async () => {
    await open('allow');
    expect(asked()).toBeNull();
    expect(frame()).toBe('files');
  });

  it('are asked for before the frame is made, and Allow is remembered on this device', async () => {
    await open('ask');
    expect(asked()).not.toBeNull();
    expect(mocks.frames).toHaveLength(0);
    await choose('Allow');
    expect(frame()).toBe('files');
    expect(mocks.frames.every(props => props.native?.files === true)).toBe(true);
    await close();
    await open('ask');
    expect(asked()).toBeNull();
    expect(frame()).toBe('files');
  });

  it('Not now opens the app without them, for this session only', async () => {
    await open('ask');
    await choose('Not now');
    expect(frame()).toBe('no files');
    await close();
    await open('ask');
    expect(asked()).toBeNull();
    await close();
    sessionStorage.clear();
    await open('ask');
    expect(asked()).not.toBeNull();
  });

  it('a member’s Allow is theirs: another account on this browser is asked for itself', async () => {
    await open('ask', 'members');
    await choose('Allow');
    expect(frame()).toBe('files');
    await close();
    signIn('member-b');
    await open('ask', 'members', 'member-b');
    expect(asked()).not.toBeNull();
  });
});
