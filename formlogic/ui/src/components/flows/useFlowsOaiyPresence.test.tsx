// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ ready: false, paired: () => {}, status: () => {}, legacy: false, legacyPaired: () => {}, legacyProbes: [] as boolean[], oaiyProbes: [] as boolean[] }));
vi.mock('../../client-runtime/oaiy/oaiyRuntime', () => ({ isOaiyPaired: () => state.ready, oaiyRouteAvailable: () => state.ready, subscribeOaiyPaired: (fn: () => void) => { state.paired = fn; return () => {}; } }));
vi.mock('../../client-runtime/oaiy/oaiyDetection', () => ({ subscribeOaiyStatus: (fn: () => void, options?: { probe?: boolean }) => { state.status = fn; state.oaiyProbes.push(options?.probe !== false); return () => {}; } }));
vi.mock('../../client-runtime/desktop/desktopDetection', () => ({ getDesktopInfo: () => ({ available: state.legacy }), subscribeDesktopStatus: (_fn: () => void, options?: { probe?: boolean }) => { state.legacyProbes.push(options?.probe !== false); return () => {}; } }));
vi.mock('../../client-runtime/desktop/desktopPairing', () => ({ isDesktopPaired: () => state.legacy, subscribeDesktopPaired: (fn: () => void) => { state.legacyPaired = fn; return () => {}; } }));
vi.mock('../../lib/api', () => ({ api: { getDesktopConnections: async () => ({ data: { connections: [] } }) } }));
import { localFlowRuntime, useFlowsDesktopPresence } from './useFlowsDesktopPresence';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
function Probe() { const presence = useFlowsDesktopPresence(true); return <p>{presence.kind === 'local' ? presence.runtime ?? 'legacy' : presence.kind}</p>; }
beforeEach(() => { state.ready = false; state.legacy = false; state.legacyProbes = []; state.oaiyProbes = []; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('recognises OAIY without changing legacy popover transport selection', () => {
  state.ready = true;
  expect(localFlowRuntime(true)).toEqual({ kind: 'local', runtime: 'oaiy', label: 'OAIY' });
  expect(localFlowRuntime()).toEqual({ kind: 'none' });
  state.legacy = true;
  expect(localFlowRuntime()).toEqual({ kind: 'local' });
  expect(localFlowRuntime(true)).toHaveProperty('runtime', 'oaiy');
});
it('updates immediately on pairing and disconnecting while the editor stays open', async () => {
  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe('none');
  await act(async () => { state.ready = true; state.paired(); });
  expect(container.textContent).toBe('oaiy');
  await act(async () => { state.ready = false; state.paired(); });
  expect(container.textContent).toBe('none');
});
it('updates when the paired runtime disappears or reappears', async () => {
  state.ready = true;
  await act(async () => root.render(<Probe />));
  await act(async () => { state.ready = false; state.status(); });
  expect(container.textContent).toBe('none');
  await act(async () => { state.ready = true; state.status(); });
  expect(container.textContent).toBe('oaiy');
});

it('the passive shell resumes monitoring when pairing changes and stops when disconnected', async () => {
  function PassiveProbe() { useFlowsDesktopPresence(false, false); return null; }
  await act(async () => root.render(<PassiveProbe />));
  expect(state.legacyProbes.at(-1)).toBe(false);
  expect(state.oaiyProbes.at(-1)).toBe(false);
  await act(async () => { state.legacy = true; state.legacyPaired(); });
  expect(state.legacyProbes.at(-1)).toBe(true);
  await act(async () => { state.legacy = false; state.legacyPaired(); });
  expect(state.legacyProbes.at(-1)).toBe(false);
  await act(async () => { state.ready = true; state.paired(); });
  expect(state.oaiyProbes.at(-1)).toBe(true);
  await act(async () => { state.ready = false; state.paired(); });
  expect(state.oaiyProbes.at(-1)).toBe(false);
});

it('account-only mode does not probe localhost even with an existing browser pairing', async () => {
  state.ready = true;
  state.legacy = true;
  function RemoteProbe() { const presence = useFlowsDesktopPresence(true, false, true); return <p>{presence.kind}</p>; }
  await act(async () => root.render(<RemoteProbe />));
  expect(state.oaiyProbes.at(-1)).toBe(false);
  expect(state.legacyProbes.at(-1)).toBe(false);
  expect(container.textContent).toBe('none');
});
