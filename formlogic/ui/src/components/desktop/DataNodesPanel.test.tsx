// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataNodeWire } from '../../types/dataPlacement';

const nodes: DataNodeWire[] = [];

vi.mock('../../lib/api', () => ({
  api: {
    getDataNodes: vi.fn(async () => ({ data: { nodes } })),
    getVault: vi.fn(async () => ({ data: { vault: null } })),
    startBackupLink: vi.fn(),
    getBackupLink: vi.fn(),
    revokeDataNode: vi.fn(),
    forgetDataNode: vi.fn(),
  },
}));

// As the real dialog does on the way out of an unlock: close first, then say it unlocked.
vi.mock('../vault/VaultUnlockDialog', () => ({
  VaultUnlockDialog: ({ isOpen, onClose, onUnlocked }: { isOpen: boolean; onClose: () => void; onUnlocked?: () => void }) => (isOpen ? (
    <div>
      <button onClick={() => { onClose(); onUnlocked?.(); }}>Unlock</button>
      <button onClick={onClose}>Cancel unlock</button>
    </div>
  ) : null),
}));

vi.mock('../ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message }: { isOpen: boolean; title: string; message: string }) => (isOpen ? <div role="dialog"><h2>{title}</h2><p>{message}</p></div> : null),
}));

import { api } from '../../lib/api';
import { DataNodesPanel, type LinkedComputer } from './DataNodesPanel';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function node(over: Partial<DataNodeWire> = {}): DataNodeWire {
  return {
    id: 'dn_1', connectionId: 'c-1', kind: 'desktop', displayName: 'Office PC', signingPublicKey: 'pk', signingKeyId: 'kid', signingKeyGeneration: 1,
    fingerprint: 'abcd'.repeat(16), transportKeyFingerprint: null, status: 'pending', approved: false, certificateExpiresAt: null, protocolMin: 1, protocolMax: 1,
    capabilities: ['storage'], rosterRevision: 1, lastSeenAt: null, revokedAt: null, createdAt: null, ...over,
  };
}

let root: Root;
let container: HTMLDivElement;

const desk: LinkedComputer = { id: 'dc-1', deviceName: 'Office PC', online: true };

async function show(...listed: DataNodeWire[]) {
  await showWith([], ...listed);
}

async function showWith(desktops: LinkedComputer[], ...listed: DataNodeWire[]) {
  nodes.splice(0, nodes.length, ...listed);
  await act(async () => { root.render(<DataNodesPanel desktops={desktops} />); });
  // The panel defers its first load a tick.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

async function press(name: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  expect(button, name).toBeTruthy();
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'u-1', email: 'owner@example.com', name: 'Owner' } as never });
  useVaultStore.setState({ status: 'locked' } as never);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('asks for the approval once the vault is unlocked, not a second click later', async () => {
  await show(node());
  await press('Approve…');
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await press('Unlock');

  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Approve "Office PC" as a data node?');
});

it('asks for nothing if the unlock is cancelled', async () => {
  await show(node());
  await press('Approve…');
  await press('Cancel unlock');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('asks at once when the vault is already unlocked', async () => {
  useVaultStore.setState({ status: 'unlocked' } as never);
  await show(node());
  await press('Approve…');
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Office PC');
});

it('tells a computer that only keeps backups from one that hosts data', async () => {
  useVaultStore.setState({ status: 'unlocked' } as never);
  await show(node({ kind: 'backup', displayName: 'FormLogic Backups on Office PC' }));
  expect(container.textContent).toContain('Backups only');
  await press('Approve…');
  const asked = container.querySelector('[role="dialog"]')?.textContent ?? '';
  expect(asked).toContain('sealed to its own key');
  expect(asked).toContain('restore');
  expect(asked).not.toContain('assigned encrypted datasets');
});

it('says nothing about backups for a desktop', async () => {
  await show(node());
  expect(container.textContent).not.toContain('Backups only');
});

it('offers backups on a computer that is online, even before any node exists', async () => {
  await showWith([desk, { id: 'dc-2', deviceName: 'Old laptop', online: false }]);
  expect(container.textContent).toContain('Set up backups on Office PC');
  expect(container.textContent).not.toContain('Old laptop');
});

it('stays out of the way with no node and no computer online', async () => {
  await showWith([{ ...desk, online: false }]);
  expect(container.textContent).toBe('');
});

describe('setting a computer up through its link', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function press(name: string) {
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
    expect(button, name).toBeTruthy();
    await act(async () => { button!.click(); });
  }
  const look = () => act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
  const said = () => container.querySelector('[role="status"]')?.textContent ?? '';

  async function loaded(...desktops: LinkedComputer[]) {
    nodes.splice(0, nodes.length);
    await act(async () => { root.render(<DataNodesPanel desktops={desktops} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }

  it('says where to answer, then goes straight on to approving the node', async () => {
    useVaultStore.setState({ status: 'unlocked' } as never);
    vi.mocked(api.startBackupLink).mockResolvedValue({ ok: true, status: 201, body: { data: { id: 'link-1' } } });
    const fresh = node({ id: 'dn_9', kind: 'backup', displayName: 'FormLogic Backups on Office PC' });
    vi.mocked(api.getBackupLink).mockResolvedValueOnce({ data: { state: 'waiting', message: null, nodeId: null } });
    vi.mocked(api.getBackupLink).mockResolvedValue({ data: { state: 'linked', message: null, nodeId: 'dn_9' } });
    await loaded(desk);

    await press('Set up backups on Office PC');
    expect(api.startBackupLink).toHaveBeenCalledWith('dc-1');
    expect(said()).toContain('Answer the window on Office PC');
    await look();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    nodes.splice(0, nodes.length, fresh);
    await look();

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Approve "FormLogic Backups on Office PC" as a data node?');
    expect(said()).toBe('');
  });

  it('says what the computer said when it refuses', async () => {
    vi.mocked(api.startBackupLink).mockResolvedValue({ ok: true, status: 201, body: { data: { id: 'link-1' } } });
    vi.mocked(api.getBackupLink).mockResolvedValue({ data: { state: 'failed', message: 'The connector is not available.', nodeId: null } });
    await loaded(desk);

    await press('Set up backups on Office PC');
    await look();

    expect(said()).toBe('The connector is not available.');
  });

  it('says so when it cannot start', async () => {
    vi.mocked(api.startBackupLink).mockResolvedValue({ ok: false, status: 409, body: { message: 'That computer is not online.' } });
    await loaded(desk);

    await press('Set up backups on Office PC');

    expect(said()).toBe('That computer is not online.');
  });

  it('says what to do when the computer connected but has not registered', async () => {
    vi.mocked(api.startBackupLink).mockResolvedValue({ ok: true, status: 201, body: { data: { id: 'link-1' } } });
    vi.mocked(api.getBackupLink).mockResolvedValue({ data: { state: 'linked', message: null, nodeId: null } });
    await loaded(desk);

    await press('Set up backups on Office PC');
    await act(async () => { await vi.advanceTimersByTimeAsync(125_000); });

    expect(said()).toContain('Reload this page in a moment');
    expect(said()).not.toContain('Nothing has come back');
  });

  it('stops waiting when nobody answers, and says the window still counts', async () => {
    vi.mocked(api.startBackupLink).mockResolvedValue({ ok: true, status: 201, body: { data: { id: 'link-1' } } });
    vi.mocked(api.getBackupLink).mockResolvedValue({ data: { state: 'waiting', message: null, nodeId: null } });
    await loaded(desk);

    await press('Set up backups on Office PC');
    await act(async () => { await vi.advanceTimersByTimeAsync(125_000); });

    expect(said()).toContain('Nothing has come back');
    expect(said()).toContain('If you answer its window');
  });

  it('points to the vault when there is none to approve with', async () => {
    useVaultStore.setState({ status: 'none' } as never);
    vi.mocked(api.startBackupLink).mockResolvedValue({ ok: true, status: 201, body: { data: { id: 'link-1' } } });
    vi.mocked(api.getBackupLink).mockResolvedValue({ data: { state: 'linked', message: null, nodeId: 'dn_9' } });
    await loaded(desk);
    await press('Set up backups on Office PC');

    nodes.splice(0, nodes.length, node({ id: 'dn_9', kind: 'backup' }));
    await look();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Awaiting approval');
  });
});
