// Data Storage card for Private forms (plan §20.1 N3a subset;
// docs/FORMLOGIC_DATA_NODES.md §11): shows whether the form still runs as
// legacy_cloud_primary or has its owner-signed epoch-1 placement, and offers
// the one-time "Sign storage baseline" action (vault-gated). Presets,
// migration, and replica management arrive with later N3 slices.

import { useCallback, useEffect, useState } from 'react';
import { Database, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { VaultUnlockDialog } from '../vault/VaultUnlockDialog';
import { Button } from '../ui/Button';
import type { DataPlacementState } from '../../types/dataPlacement';

export function DataPlacementCard({ formId }: { formId: string }) {
  const [state, setState] = useState<DataPlacementState | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [pendingSign, setPendingSign] = useState(false);

  const load = useCallback(async () => {
    const res = await api.getDataPlacement(formId);
    if (res.error) {
      if (res.status === 403) setEnabled(false);
      return;
    }
    setState(res.data ?? null);
  }, [formId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runSign = useCallback(async () => {
    setBusy(true);
    try {
      const vaultRes = await api.getVault();
      const vault = vaultRes.data?.vault;
      if (!vault) throw new Error('No vault found for this account.');
      const { signPlacementBaseline } = await import('../../lib/dataPlacement');
      await signPlacementBaseline(formId, vault.ed25519Pk);
      toast.success('Storage baseline signed', 'Cloud is now this form\'s signed primary (epoch 1).');
      await load();
    } catch (e) {
      toast.error('Baseline signing failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPendingSign(false);
    }
  }, [formId, load]);

  useEffect(() => {
    if (pendingSign && !showUnlock && useVaultStore.getState().status === 'unlocked') {
      void runSign();
    }
  }, [pendingSign, showUnlock, runSign]);

  const startSign = () => {
    if (useVaultStore.getState().status === 'unlocked') {
      setPendingSign(true);
    } else {
      setPendingSign(true);
      setShowUnlock(true);
    }
  };

  if (!enabled || state === null) return null;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 dark:border-slate-800 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-slate-200">
        <Database className="h-4 w-4" aria-hidden="true" />
        Data storage
      </div>
      {state.placement ? (
        <div className="mt-2 flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300">
          <ShieldCheck className="h-4 w-4 mt-0.5 text-green-600 dark:text-green-400 flex-shrink-0" aria-hidden="true" />
          <div>
            <p>
              Cloud primary · signed placement epoch {state.placement.storageEpoch}
              {state.placement.createdAt ? ` · ${state.placement.createdAt}` : ''}
            </p>
            <p className="mt-1 font-mono text-[11px] text-gray-500 dark:text-slate-400">
              manifest {state.placement.manifestHash.slice(0, 16)}…
            </p>
            <p className="mt-1 text-gray-500 dark:text-slate-400">
              Desktop replicas and primary migration unlock in a later update; backups already
              work from FormLogic Desktop → Data.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-2 text-xs text-gray-600 dark:text-slate-300">
          <p>
            This Private form still runs as an unsigned Cloud primary. Signing the storage
            baseline records — under your vault key — that Cloud holds this form's data and
            which service key may sign its checkpoints. It changes nothing about where data
            lives, and is the prerequisite for Desktop replicas and migration.
          </p>
          <div className="mt-2">
            <Button size="sm" onClick={startSign} disabled={busy}>
              {busy ? 'Signing…' : 'Sign storage baseline'}
            </Button>
          </div>
        </div>
      )}
      <VaultUnlockDialog
        isOpen={showUnlock}
        onUnlocked={() => setShowUnlock(false)}
        onClose={() => {
          setShowUnlock(false);
          setPendingSign(false);
        }}
        title="Unlock your vault to sign the storage baseline"
      />
    </div>
  );
}
