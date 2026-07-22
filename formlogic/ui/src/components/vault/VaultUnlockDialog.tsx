// Vault unlock dialog (docs/E2EE_PRIVATE_FORMS_PLAN.md §10, §16-P2).
// Passphrase unlock with re-derived-pubkey verification (a corrupted bundle fails
// closed in the worker), plus a recovery-kit path (code + NEW passphrase).

import { useState } from 'react';
import { Lock, KeyRound } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { PasswordInput } from '../ui/PasswordInput';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';

interface VaultUnlockDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onUnlocked?: () => void;
  title?: string;
}

export function VaultUnlockDialog({ isOpen, onClose, onUnlocked, title }: VaultUnlockDialogProps) {
  const user = useAuthStore((s) => s.user);
  const unlock = useVaultStore((s) => s.unlock);
  const recoveryUnlock = useVaultStore((s) => s.recoveryUnlock);

  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode('passphrase');
    setPassphrase('');
    setRecoveryCode('');
    setNewPassphrase('');
    setError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const finish = () => {
    reset();
    onClose();
    onUnlocked?.();
  };

  const doUnlock = async () => {
    if (!user || !passphrase) return;
    setBusy(true);
    setError(null);
    const result = await unlock(user.id, passphrase);
    setBusy(false);
    setPassphrase('');
    if (!result.ok) {
      setError(
        result.code === 'vault_corrupt'
          ? 'The stored vault failed integrity verification — do not retry. Use your recovery kit, and contact support.'
          : result.code === 'vault_unlock_failed'
            ? 'Incorrect passphrase.'
            : result.error ?? 'Unlock failed.',
      );
      return;
    }
    finish();
  };

  const doRecovery = async () => {
    if (!user || !recoveryCode.trim() || newPassphrase.length < 12) {
      setError(newPassphrase.length < 12 ? 'The new passphrase must be at least 12 characters.' : 'Enter your recovery kit.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await recoveryUnlock(user.id, recoveryCode.trim(), newPassphrase);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Recovery failed.');
      return;
    }
    finish();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={title ?? 'Unlock your vault'} size="md">
      {mode === 'passphrase' ? (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <div className="flex gap-3 p-3.5 rounded-xl bg-gray-50 dark:bg-slate-800/60 text-sm text-gray-700 dark:text-slate-300 ring-1 ring-gray-200/60 dark:ring-slate-700/50">
            <Lock className="h-5 w-5 flex-shrink-0 mt-0.5 text-primary-500" />
            <p>Private form responses are encrypted end-to-end (beta). Unlock your vault to view or manage them.</p>
          </div>
          <PasswordInput
            label="Vault passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') void doUnlock(); }}
          />
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 ring-1 ring-red-200/70 dark:ring-red-500/20 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-4 border-t border-gray-100 dark:border-slate-800">
            <button
              type="button"
              onClick={() => { setMode('recovery'); setError(null); }}
              className="text-sm text-primary-600 dark:text-primary-400 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded inline-flex items-center gap-1.5"
            >
              <KeyRound className="h-4 w-4" /> Use recovery kit
            </button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={() => void doUnlock()} isLoading={busy} disabled={!passphrase}>Unlock</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <div className="flex gap-3 p-3.5 rounded-xl bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-900 dark:text-amber-200 ring-1 ring-amber-200/70 dark:ring-amber-500/20">
            <KeyRound className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <p>Enter your recovery kit (<span className="font-mono">FLRK1-…</span>) and choose a new vault passphrase. Your data and keys are preserved.</p>
          </div>
          <Input
            label="Recovery kit"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="FLRK1-XXXX-XXXX-…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <PasswordInput
            label="New vault passphrase"
            value={newPassphrase}
            onChange={(e) => setNewPassphrase(e.target.value)}
            placeholder="At least 12 characters"
            autoComplete="new-password"
            onKeyDown={(e) => { if (e.key === 'Enter') void doRecovery(); }}
          />
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 ring-1 ring-red-200/70 dark:ring-red-500/20 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-4 border-t border-gray-100 dark:border-slate-800">
            <button
              type="button"
              onClick={() => { setMode('passphrase'); setError(null); }}
              className="text-sm text-primary-600 dark:text-primary-400 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
            >
              Back to passphrase
            </button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={() => void doRecovery()} isLoading={busy}>Recover &amp; unlock</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
