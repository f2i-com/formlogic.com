// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DataNodeWire } from '../../types/dataPlacement';

const nodes: DataNodeWire[] = [];

vi.mock('../../lib/api', () => ({
  api: {
    getDataNodes: vi.fn(async () => ({ data: { nodes } })),
    getVault: vi.fn(async () => ({ data: { vault: null } })),
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

import { DataNodesPanel } from './DataNodesPanel';
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

async function show(...listed: DataNodeWire[]) {
  nodes.splice(0, nodes.length, ...listed);
  await act(async () => { root.render(<DataNodesPanel />); });
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
