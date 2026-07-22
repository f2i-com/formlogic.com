// One-way "Encrypt this form" section for Form Settings → Access (E2EE plan §3 D8,
// §9.1). Private mode is IRREVERSIBLE in v1 — this surface offers Unencrypted →
// Encrypted ONLY; a private form gets read-only status text, never a decrypt-back
// toggle.
//
// Flow: the action needs an UNLOCKED vault — none → VaultSetupWizard, locked →
// VaultUnlockDialog, then a danger ConfirmDialog with the permanence warning, then
// the SAME client enable path the creation flow uses (formCrypto.enableFormEncryption
// → worker keygen + POST /api/forms/{id}/encryption). A 409 private_enable_blocked
// renders the server's details.reasons[] in human-readable form (the §9.1 preflight
// is strict BY DESIGN — e.g. pre-feature published forms can never be private).

import { useState } from 'react';
import { Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';
import { useVaultStore } from '../../stores/vaultStore';
import { VaultSetupWizard } from '../vault/VaultSetupWizard';
import { VaultUnlockDialog } from '../vault/VaultUnlockDialog';
import { describeEnableBlockReasons } from '../../lib/crypto/enableBlockReasons';

interface EncryptionSettingsProps {
  formId: string;
  isPrivate: boolean;
  /** Called after a successful enable so the builder badge/state refresh without a reload. */
  onEnabled: () => void;
}

export function EncryptionSettings({ formId, isPrivate, onEnabled }: EncryptionSettingsProps) {
  const [showSetup, setShowSetup] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blockedReasons, setBlockedReasons] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (isPrivate) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 p-4">
        <Lock className="h-4 w-4 mt-0.5 text-green-600 dark:text-green-400 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-green-800 dark:text-green-300">End-to-end encrypted — permanent</p>
          <p className="mt-1 text-xs text-green-700 dark:text-green-400">
            Responses are sealed in the submitter's browser; the server cannot read them.
            Private mode cannot be turned off.
          </p>
        </div>
      </div>
    );
  }

  const startEnable = async () => {
    setBlockedReasons(null);
    setError(null);
    let status = useVaultStore.getState().status;
    if (status === 'unknown') {
      const { ensureVaultLoaded } = await import('../../lib/crypto/formCrypto');
      await ensureVaultLoaded().catch(() => undefined);
      status = useVaultStore.getState().status;
    }
    if (status === 'none') {
      setShowSetup(true);
    } else if (status === 'unlocked') {
      setShowConfirm(true);
    } else {
      setShowUnlock(true);
    }
  };

  const confirmEnable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { enableFormEncryption, markFormPrivate } = await import('../../lib/crypto/formCrypto');
      const fields = useFormStore.getState().getForm(formId)?.fields ?? [];
      await enableFormEncryption(formId, JSON.stringify(fields));
      markFormPrivate(formId);
      setShowConfirm(false);
      toast.success('Private form enabled', 'Responses are now end-to-end encrypted — permanently.');
      onEnabled();
    } catch (e) {
      const err = e as { code?: string; message?: string; reasons?: string[] };
      setShowConfirm(false);
      if (err.code === 'private_enable_blocked' && Array.isArray(err.reasons) && err.reasons.length > 0) {
        const described = describeEnableBlockReasons(err.reasons);
        setBlockedReasons(described);
        // The reasons box renders below the button inside the modal's scroll area and
        // is easy to miss — also toast so the failure (and why) is unmistakable.
        toast.warning('This form can\'t be made private', described[0] ?? 'See the reasons in form settings.');
      } else {
        const message = err.message ?? 'Could not enable encryption on this form.';
        setError(message);
        toast.error('Encryption not enabled', message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-start gap-3">
        <ShieldCheck className="h-4 w-4 mt-0.5 text-gray-500 dark:text-slate-400 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white">End-to-end encryption (beta)</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            Responses submitted after encryption is on are sealed in the submitter's browser — the server
            stores only ciphertext and cannot read the answers. You decrypt them with your vault passphrase.
          </p>
          <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            This is permanent and cannot be undone. If you lose your vault passphrase and recovery kit,
            the data cannot be recovered — not even by FormLogic.
          </p>
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={startEnable} leftIcon={<Lock className="h-4 w-4" />}>
              Encrypt this form permanently
            </Button>
          </div>

          {blockedReasons && (
            <div className="mt-3 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3" role="alert">
              <div className="flex items-start gap-2">
                <TriangleAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" aria-hidden="true" />
                <div>
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300">This form can't be made private:</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5 text-xs text-amber-800 dark:text-amber-300">
                    {blockedReasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
              </div>
            </div>
          )}
          {error && (
            <p className="mt-3 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      {/* Vault sequencing: set up when missing, unlock when locked, then confirm. */}
      <VaultSetupWizard
        isOpen={showSetup}
        onClose={() => setShowSetup(false)}
        onComplete={() => setShowConfirm(true)}
      />
      <VaultUnlockDialog
        isOpen={showUnlock}
        onClose={() => setShowUnlock(false)}
        onUnlocked={() => setShowConfirm(true)}
      />
      <ConfirmDialog
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={() => { void confirmEnable(); }}
        title="Encrypt this form permanently?"
        message={'Responses from now on are sealed in the submitter\'s browser — the server cannot read them.\n\nThis cannot be undone. If you lose your vault passphrase and recovery kit, the data cannot be recovered — not even by FormLogic.'}
        confirmLabel="Encrypt permanently"
        variant="danger"
        isLoading={busy}
      />
    </div>
  );
}
