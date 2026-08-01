// Data-node roster + owner approval (docs/FORMLOGIC_DATA_NODES.md §11,
// plan §13.1/§13.4). Renders under Settings → Linked Desktops; hides itself
// entirely while the DATA_NODES flag is off. Approval signs an flnodecert:1
// node-authority certificate with the vault Ed25519 key — the fingerprint is
// shown in the confirm so the user approves a KEY, not just a device name.

import { useCallback, useEffect, useState } from 'react';
import { HardDrive, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { VaultUnlockDialog } from '../vault/VaultUnlockDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Button } from '../ui/Button';
import type { DataNodeWire } from '../../types/dataPlacement';

function displayFingerprint(fp: string): string {
  return (fp.slice(0, 24).match(/.{1,4}/g) ?? []).join(' ');
}

export function DataNodesPanel() {
  const user = useAuthStore((s) => s.user);
  const [nodes, setNodes] = useState<DataNodeWire[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [approveTarget, setApproveTarget] = useState<DataNodeWire | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<DataNodeWire | null>(null);
  const [forgetTarget, setForgetTarget] = useState<DataNodeWire | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);

  const load = useCallback(async () => {
    const res = await api.getDataNodes();
    if (res.error) {
      if (res.status === 403) setEnabled(false);
      return;
    }
    setNodes(res.data?.nodes ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      toast.success('Data node approved', `${node.displayName} can now be assigned encrypted datasets.`);
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
    if (status === 'unlocked') {
      setApproveTarget(node);
    } else {
      setApproveTarget(node);
      setShowUnlock(true);
    }
  };

  if (!enabled || nodes === null || nodes.length === 0) return null;

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-slate-800 pt-4">
      <h4 className="text-sm font-semibold text-gray-800 dark:text-slate-200 flex items-center gap-2">
        <HardDrive className="h-4 w-4" aria-hidden="true" />
        Data nodes
      </h4>
      <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
        Desktops enrolled to host encrypted form data. Approving signs a certificate with your
        vault key binding this exact device key — a storage node never receives decryption keys.
      </p>
      <ul className="mt-3 space-y-2">
        {nodes.map((node) => (
          <li
            key={node.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-800 p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-slate-200">
                {node.displayName}
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
        onUnlocked={() => setShowUnlock(false)}
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
          ? `Verify this fingerprint on the desktop's Data page before approving:\n\n${displayFingerprint(approveTarget.fingerprint)}\n\nApproval signs a certificate with your vault key. The node can then be assigned encrypted datasets — it never receives decryption keys.`
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
        message="The node loses all data-plane authority. Its local files are NOT deleted (request a wipe separately once that ships), and copies it already exported cannot be recalled."
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
        message="This only clears the record of a node you already revoked — it has no authority to lose. If that desktop is still installed and linked, it will enrol again as a new pending node."
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
