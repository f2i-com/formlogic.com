// Vault setup wizard (docs/E2EE_PRIVATE_FORMS_PLAN.md §5, §10, §16-P2).
// Steps: passphrase → recovery kit → typed-back confirmation → done. The recovery kit is
// MANDATORY (D5) and is the ONLY way back in if the passphrase is lost; FormLogic cannot
// recover the vault.
//
// Ordering (D5): the vault is only PREPARED when the passphrase is entered — the wrappers
// and the kit are generated locally and nothing is sent. The vault is created on the
// server after the kit has been shown AND typed back (the checksum catches a mistype
// before any KDF work). Closing the tab, cancelling, or losing the session before that
// creates nothing; the user simply starts again.

import { useEffect, useRef, useState } from 'react';
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
  const prepareSetup = useVaultStore((s) => s.prepareSetup);
  const commitSetup = useVaultStore((s) => s.commitSetup);
  const abandonSetup = useVaultStore((s) => s.abandonSetup);

  const [step, setStep] = useState<'passphrase' | 'kit' | 'confirm'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryDisplay, setRecoveryDisplay] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  /** Token of the vault this wizard prepared (null until a kit has been generated). */
  const [setupId, setSetupId] = useState<string | null>(null);

  // The prepared vault belongs to this wizard: whenever the wizard stops holding it (a
  // reset, a parent closing it, unmount) the store is told to drop it — which is a no-op
  // once it was created, and never touches another wizard's setup or an unlocked vault.
  useEffect(() => {
    if (!setupId) return undefined;
    return () => { void abandonSetup(setupId); };
  }, [setupId, abandonSetup]);

  // A prepare that finishes after the wizard is gone must not leave a kit + an unlocked
  // worker behind.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reset = () => {
    setStep('passphrase');
    setPassphrase('');
    setPassphrase2('');
    setError(null);
    setBusy(false);
    setRecoveryDisplay(null);
    setCopied(false);
    setConfirmText('');
    setSetupId(null);
  };

  // A parent that closes the wizard without going through onClose must not leave a kit on
  // screen (or a prepared vault behind) for the next time it opens.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) reset();
  }

  const close = () => {
    reset();
    onClose();
  };

  const startSetup = async () => {
    setError(null);
    if (passphrase.length < 12) {
      setError('Passphrase must be at least 12 characters.');
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
    // Generates the wrappers and the kit locally — NOTHING is sent to the server yet.
    const result = await prepareSetup(user.id, passphrase);
    if (!mountedRef.current) {
      if (result.setupId) void abandonSetup(result.setupId);
      return;
    }
    setBusy(false);
    setPassphrase('');
    setPassphrase2('');
    if (!result.ok || !result.recoveryDisplay || !result.setupId) {
      setError(result.error ?? 'Vault setup failed.');
      return;
    }
    setSetupId(result.setupId);
    setRecoveryDisplay(result.recoveryDisplay);
    setStep('kit');
  };

  const confirmKit = async () => {
    if (!setupId || busy) return;
    setError(null);
    setBusy(true);
    // The store checks the typed-back kit (a wrong one sends nothing) and only then
    // creates the vault on the server. The kit has been shown by now (D5).
    const result = await commitSetup(setupId, confirmText);
    if (!mountedRef.current) return;
    // A second press while the first request is still out: that one will report.
    if (result.code === 'setup_busy') return;
    if (result.ok) {
      reset();
      onClose();
      onComplete?.();
      return;
    }
    if (result.discarded) {
      // The prepared vault is gone (signed out, locked, refused): the kit on screen is void.
      reset();
      setError(result.error ?? 'Vault setup failed — start again.');
      return;
    }
    setBusy(false);
    setError(result.error ?? 'Could not create the vault.');
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
              placeholder="At least 12 characters"
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
            Write it down or store it somewhere safe, then continue. Your vault is <strong>not
            created yet</strong> — that happens only after you confirm this kit on the next step.
          </p>
          <div className="flex justify-end">
            <Button onClick={() => { setStep('confirm'); setError(null); }}>I saved it — continue</Button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Type or paste your recovery kit back to confirm you saved it correctly. Your vault is
            created as soon as it matches.
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
            <Button variant="outline" onClick={() => setStep('kit')} disabled={busy}>Back</Button>
            <Button onClick={() => void confirmKit()} isLoading={busy} disabled={!confirmText.trim()}>
              Confirm &amp; create vault
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
