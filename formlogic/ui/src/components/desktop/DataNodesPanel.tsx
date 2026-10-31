// Data-node roster + owner approval (docs/FORMLOGIC_DATA_NODES.md §11,
// plan §13.1/§13.4). Renders under Settings → Linked Desktops; hides itself
// entirely while the DATA_NODES flag is off. Approval signs an flnodecert:1
// node-authority certificate with the vault Ed25519 key — the fingerprint is
// shown in the confirm so the user approves a KEY, not just a device name.

import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { VaultUnlockDialog } from '../vault/VaultUnlockDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Button } from '../ui/Button';
import type { DataNodeWire } from '../../types/dataPlacement';
import { deferEffect } from '../../lib/deferredEffect';

/** How often, and how many times, to look for the answer: two minutes. The code itself lasts longer. */
const SETUP_LOOK_MS = 2_000;
const SETUP_LOOKS = 60;

/** A linked computer, as Settings knows it. */
export interface LinkedComputer {
  id: string;
  deviceName: string;
  online: boolean;
}

function displayFingerprint(fp: string): string {
  return (fp.slice(0, 24).match(/.{1,4}/g) ?? []).join(' ');
}

export function DataNodesPanel({ desktops = [] }: { desktops?: LinkedComputer[] }) {
  const user = useAuthStore((s) => s.user);
  const [nodes, setNodes] = useState<DataNodeWire[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [approveTarget, setApproveTarget] = useState<DataNodeWire | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<DataNodeWire | null>(null);
  const [forgetTarget, setForgetTarget] = useState<DataNodeWire | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  // The dialog's onClose runs on every way out, so it can't tell a cancel from an unlock.
  const unlockingFor = useRef<DataNodeWire | null>(null);
  const [setup, setSetup] = useState<{ id: string; text: string; ended: boolean } | null>(null);
  const showing = useRef(true);

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    const res = await api.getDataNodes();
    if (!isCurrent()) return;
    if (res.error) {
      if (res.status === 403) setEnabled(false);
      return;
    }
    setNodes(res.data?.nodes ?? []);
  }, []);

  useEffect(() => deferEffect(() => {
    let current = true;
    void load(() => current);
    return () => { current = false; };
  }), [load]);

  const runApprove = async (node: DataNodeWire) => {
    if (!user) return;
    setBusy(true);
    try {
      const vaultRes = await api.getVault();
      const vault = vaultRes.data?.vault;
      if (!vault) {
        toast.warning('Vault required', 'Set up your encryption vault (in a Private form) before approving data nodes.');
        return;
      }
      const { approveDataNode } = await import('../../lib/dataPlacement');
      await approveDataNode(node, user.id, vault.ed25519Pk);
      toast.success(
        'Data node approved',
        node.kind === 'backup'
          ? `${node.displayName} can now back up and restore your apps and forms.`
          : `${node.displayName} can now be assigned encrypted datasets.`,
      );
      await load();
    } catch (e) {
      toast.error('Approval failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setApproveTarget(null);
    }
  };

  const startApprove = (node: DataNodeWire) => {
    const status = useVaultStore.getState().status;
    if (status === 'none') {
      toast.warning('Vault required', 'Set up your encryption vault under Settings, Security, then approve this computer.');
      return;
    }
    setApproveTarget(node);
    if (status !== 'unlocked') {
      unlockingFor.current = node;
      setShowUnlock(true);
    }
  };

  useEffect(() => {
    showing.current = true;
    return () => { showing.current = false; };
  }, []);

  /**
   * Sends the plugin on that computer a one-time code through its link, then waits while the person
   * answers the plugin's window there, and goes straight on to approving the node it registers.
   */
  const setUpBackups = async (desktop: LinkedComputer) => {
    const ended = (text: string) => setSetup({ id: desktop.id, text, ended: true });
    setSetup({ id: desktop.id, text: `Answer the window on ${desktop.deviceName}.`, ended: false });
    const started = await api.startBackupLink(desktop.id);
    if (!started.ok) {
      ended((started.body as { message?: string } | null)?.message ?? 'That could not be started.');
      return;
    }
    const linkId = (started.body?.data as { id: string }).id;
    let connected = false;
    for (let look = 0; look < SETUP_LOOKS && showing.current; look += 1) {
      await new Promise((done) => setTimeout(done, SETUP_LOOK_MS));
      const { data: link } = await api.getBackupLink(linkId);
      if (link?.state === 'failed' || link?.state === 'expired') {
        ended(link.message ?? 'That did not work.');
        return;
      }
      if (link?.state === 'linked' && link.nodeId) {
        const listed = await api.getDataNodes();
        const node = listed.data?.nodes.find((candidate) => candidate.id === link.nodeId);
        if (listed.data) setNodes(listed.data.nodes);
        setSetup(null);
        if (node) startApprove(node);
        return;
      }
      connected = link?.state === 'linked';
    }
    if (showing.current) {
      ended(connected
        ? 'That computer is connected, but hasn\'t told FormLogic who it is yet. Reload this page in a moment to approve it.'
        : 'Nothing has come back from that computer yet. If you answer its window, reload this page to approve it.');
    }
  };

  const online = desktops.filter((desktop) => desktop.online);
  if (!enabled || nodes === null || (nodes.length === 0 && online.length === 0)) return null;

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-slate-800 pt-4">
      <h4 className="text-sm font-semibold text-gray-800 dark:text-slate-200 flex items-center gap-2">
        <HardDrive className="h-4 w-4" aria-hidden="true" />
        Data nodes
      </h4>
      <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
        Desktops enrolled to host encrypted form data, and computers that only keep backups.
        Approving signs a certificate with your vault key binding this exact device key — a storage
        node never receives decryption keys.
      </p>
      {online.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Keep sealed backups of your apps and forms on a linked computer. Install the FormLogic Backups
            plugin in OAIY there and start it, then:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {online.map((desktop) => (
              <Button key={desktop.id} size="sm" variant="secondary" disabled={setup !== null && !setup.ended} onClick={() => void setUpBackups(desktop)}>
                Set up backups on {desktop.deviceName}
              </Button>
            ))}
          </div>
          {setup && <p className="mt-2 text-xs text-gray-600 dark:text-slate-300" role="status">{setup.text}</p>}
        </div>
      )}
      <ul className="mt-3 space-y-2">
        {nodes.map((node) => (
          <li
            key={node.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-800 p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-slate-200">
                {node.displayName}
                {node.kind === 'backup' && (
                  <span className="rounded bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:text-slate-300">
                    Backups only
                  </span>
                )}
                {node.status === 'approved' && (
                  <span className="inline-flex items-center gap-1 rounded bg-green-50 dark:bg-green-500/10 px-1.5 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-300">
                    <ShieldCheck className="h-3 w-3" />Approved
                  </span>
                )}
                {node.status === 'pending' && (
                  <span className="rounded bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    Awaiting approval
                  </span>
                )}
                {node.status === 'revoked' && (
                  <span className="inline-flex items-center gap-1 rounded bg-red-50 dark:bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                    <ShieldOff className="h-3 w-3" />Revoked
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] font-mono text-gray-500 dark:text-slate-400">
                {displayFingerprint(node.fingerprint)} · key gen {node.signingKeyGeneration}
              </div>
            </div>
            <div className="flex gap-2">
              {node.status === 'pending' && (
                <Button size="sm" onClick={() => startApprove(node)} disabled={busy}>
                  Approve…
                </Button>
              )}
              {node.status !== 'revoked' && (
                <Button size="sm" variant="secondary" onClick={() => setRevokeTarget(node)} disabled={busy}>
                  Revoke
                </Button>
              )}
              {/* Only once it is already revoked: removing the record is a
                  tidy-up, not a way to drop a live node's authority. */}
              {node.status === 'revoked' && (
                <Button size="sm" variant="secondary" onClick={() => setForgetTarget(node)} disabled={busy}>
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <VaultUnlockDialog
        isOpen={showUnlock}
        onUnlocked={() => {
          setShowUnlock(false);
          setApproveTarget(unlockingFor.current);
        }}
        onClose={() => {
          setShowUnlock(false);
          setApproveTarget(null);
        }}
        title="Unlock your vault to approve this data node"
      />
      <ConfirmDialog
        isOpen={approveTarget !== null && !showUnlock}
        title={approveTarget ? `Approve "${approveTarget.displayName}" as a data node?` : ''}
        message={approveTarget
          ? approveTarget.kind === 'backup'
            ? `Verify this fingerprint in the FormLogic Backups plugin before approving:\n\n${displayFingerprint(approveTarget.fingerprint)}\n\nApproval signs a certificate with your vault key. That computer can then take backups of your apps and forms, sealed to its own key, and can restore one here as new copies. Whoever has its twelve words can read those backups.`
            : `Verify this fingerprint on the desktop's Data page before approving:\n\n${displayFingerprint(approveTarget.fingerprint)}\n\nApproval signs a certificate with your vault key. The node can then be assigned encrypted datasets — it never receives decryption keys.`
          : ''}
        confirmLabel="Approve node"
        isLoading={busy}
        onConfirm={() => {
          if (approveTarget) void runApprove(approveTarget);
        }}
        onClose={() => setApproveTarget(null)}
      />
      <ConfirmDialog
        isOpen={revokeTarget !== null}
        title={revokeTarget ? `Revoke "${revokeTarget.displayName}"?` : ''}
        message={revokeTarget?.kind === 'backup'
          ? "That computer can't take or restore backups any more, and its sign-in stops working. Backups it already holds stay on it and cannot be recalled."
          : 'The node loses all data-plane authority. Its local files are NOT deleted (request a wipe separately once that ships), and copies it already exported cannot be recalled.'}
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={() => {
          if (!revokeTarget) return;
          void (async () => {
            const res = await api.revokeDataNode(revokeTarget.id);
            if (res.ok) toast.success('Data node revoked');
            else toast.error('Revoke failed', (res.body as { message?: string })?.message ?? '');
            setRevokeTarget(null);
            await load();
          })();
        }}
        onClose={() => setRevokeTarget(null)}
      />
      <ConfirmDialog
        isOpen={forgetTarget !== null}
        title={forgetTarget ? `Remove "${forgetTarget.displayName}" from the list?` : ''}
        message={forgetTarget?.kind === 'backup'
          ? 'This only clears the record of a computer you already revoked. Linking the plugin again starts a new pending node.'
          : 'This only clears the record of a node you already revoked — it has no authority to lose. If that desktop is still installed and linked, it will enrol again as a new pending node.'}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => {
          if (!forgetTarget) return;
          void (async () => {
            const res = await api.forgetDataNode(forgetTarget.id);
            if (res.ok) toast.success('Data node removed');
            else toast.error('Remove failed', (res.body as { message?: string })?.message ?? '');
            setForgetTarget(null);
            await load();
          })();
        }}
        onClose={() => setForgetTarget(null)}
      />
    </div>
  );
}
