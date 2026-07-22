// Vault setup wizard (docs/E2EE_PRIVATE_FORMS_PLAN.md §5, §10, §16-P2).
// Steps: passphrase → recovery kit (MANDATORY — confirmed by typing it back; the
// checksum catches a mistype before any KDF work) → done. The recovery kit is the
// ONLY way back in if the passphrase is lost; FormLogic cannot recover the vault.

import { useState } from 'react';
import { ShieldCheck, Copy, Check, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { PasswordInput } from '../ui/PasswordInput';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { copyToClipboard } from '../../lib/utils';

interface VaultSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the vault exists + is unlocked and the kit was confirmed. */
  onComplete?: () => void;
}

export function VaultSetupWizard({ isOpen, onClose, onComplete }: VaultSetupWizardProps) {
  const user = useAuthStore((s) => s.user);
  const setup = useVaultStore((s) => s.setup);

  const [step, setStep] = useState<'passphrase' | 'kit' | 'confirm'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryDisplay, setRecoveryDisplay] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const reset = () => {
    setStep('passphrase');
    setPassphrase('');
    setPassphrase2('');
    setError(null);
    setBusy(false);
    setRecoveryDisplay(null);
    setCopied(false);
    setConfirmText('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const startSetup = async () => {
    setError(null);
    if (passphrase.length < 8) {
      setError('Passphrase must be at least 8 characters.');
      return;
    }
    if (passphrase !== passphrase2) {
      setError('The passphrases do not match.');
      return;
    }
    if (!user) {
      setError('You must be signed in.');
      return;
    }
    setBusy(true);
    const result = await setup(user.id, passphrase);
    setBusy(false);
    setPassphrase('');
    setPassphrase2('');
    if (!result.ok || !result.recoveryDisplay) {
      setError(result.error ?? 'Vault setup failed.');
      return;
    }
    setRecoveryDisplay(result.recoveryDisplay);
    setStep('kit');
  };

  const confirmKit = () => {
    setError(null);
    // Mandatory confirmation (D5): the kit must be typed back. decodeRecoveryKey on
    // the worker side already verified the checksum at creation; here a mistyped
    // re-entry is caught by exact comparison — a wrong character means the user did
    // NOT copy it correctly, which is exactly what this step exists to catch.
    const normalize = (s: string) => s.trim().toUpperCase().replace(/[\s-]+/g, '');
    if (!recoveryDisplay || normalize(confirmText) !== normalize(recoveryDisplay)) {
      setError("That doesn't match the recovery kit above — check each group carefully.");
      return;
    }
    reset();
    onClose();
    onComplete?.();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={step === 'passphrase' ? 'Create your encryption vault' : 'Save your recovery kit'}
      size="md"
    >
      {step === 'passphrase' && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <div className="flex gap-3 p-3 rounded-lg bg-primary-50 dark:bg-primary-500/10 text-sm text-primary-900 dark:text-primary-200">
            <ShieldCheck className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <p>
              Your vault passphrase encrypts Private form responses end-to-end (beta) in your browser.
              FormLogic stores only ciphertext and <strong>cannot recover this passphrase</strong>.
            </p>
          </div>
          <div className="space-y-3">
            <PasswordInput
              label="Vault passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              autoFocus
            />
            <PasswordInput
              label="Confirm passphrase"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
              placeholder="Repeat the passphrase"
              autoComplete="new-password"
              onKeyDown={(e) => { if (e.key === 'Enter') void startSetup(); }}
            />
          </div>
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 ring-1 ring-red-200/70 dark:ring-red-500/20 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
            <Button onClick={() => void startSetup()} isLoading={busy}>Create vault</Button>
          </div>
        </div>
      )}

      {step === 'kit' && recoveryDisplay && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <div className="flex gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlert className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <p>
              This is your <strong>only</strong> backup. If you lose your passphrase and this kit,
              your encrypted responses are gone forever — FormLogic cannot recover them.
            </p>
          </div>
          <div className="p-3 rounded-lg bg-gray-100 dark:bg-slate-800 font-mono text-sm break-all select-all text-gray-900 dark:text-slate-100">
            {recoveryDisplay}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void copyToClipboard(recoveryDisplay).then((ok) => { if (ok) setCopied(true); });
            }}
            leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </Button>
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Write it down or store it somewhere safe, then continue.
          </p>
          <div className="flex justify-end">
            <Button onClick={() => { setStep('confirm'); setError(null); }}>I saved it — continue</Button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Type or paste your recovery kit back to confirm you saved it correctly.
          </p>
          <Input
            label="Recovery kit"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="FLRK1-XXXX-XXXX-…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 ring-1 ring-red-200/70 dark:ring-red-500/20 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setStep('kit')}>Back</Button>
            <Button onClick={confirmKit} disabled={!confirmText.trim()}>Confirm &amp; finish</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
