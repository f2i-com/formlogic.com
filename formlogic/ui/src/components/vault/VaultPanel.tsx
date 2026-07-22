// Settings > Security vault card (plan SS10): create when none, unlock/lock,
// change passphrase, auto-lock info. Hidden for the shared demo account.
import { useEffect, useState } from 'react';
import { KeyRound, Lock, LockKeyhole, LockOpen, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { PasswordInput } from '../ui/PasswordInput';
import { Spinner } from '../ui/Spinner';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { ensureVaultLoaded } from '../../lib/crypto/formCrypto';
import { toast } from '../../stores/toastStore';
import { VaultSetupWizard } from './VaultSetupWizard';
import { VaultUnlockDialog } from './VaultUnlockDialog';

export function VaultPanel() {
  const user = useAuthStore((s) => s.user);
  const status = useVaultStore((s) => s.status);
  const lock = useVaultStore((s) => s.lock);
  const changePassphrase = useVaultStore((s) => s.changePassphrase);
  const [showSetup, setShowSetup] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [showChange, setShowChange] = useState(false);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.isDemo && status === 'unknown') {
      void ensureVaultLoaded().catch(() => undefined);
    }
  }, [user, status]);

  if (!user || user.isDemo) return null;

  const handleChangePassphrase = async () => {
    if (changing || !user) return;
    setChangeError(null);
    if (newPass.length < 10) {
      setChangeError('Use at least 10 characters for the new passphrase.');
      return;
    }
    if (newPass !== confirmPass) {
      setChangeError('The new passphrases do not match.');
      return;
    }
    setChanging(true);
    try {
      const result = await changePassphrase(user.id, currentPass, newPass);
      if (!result.ok) {
        setChangeError(
          result.code === 'vault_unlock_failed'
            ? 'Your current passphrase is wrong.'
            : result.code === 'vault_version_conflict'
              ? 'Your vault changed in another tab or device. Reload the page and try again.'
              : result.error ?? 'Could not change the passphrase.',
        );
        return;
      }
      setCurrentPass('');
      setNewPass('');
      setConfirmPass('');
      setShowChange(false);
      toast.success('Passphrase changed', 'Only the passphrase wrapper changed - your keys and data are untouched.');
    } finally {
      setChanging(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <LockKeyhole className="h-4 w-4 text-gray-500 dark:text-slate-400" />
        <h3 className="font-medium text-gray-900 dark:text-white">Encryption vault</h3>
      </div>
      <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">
        Private forms are end-to-end encrypted (beta): responses are sealed in the submitter's browser and
        only your vault can open them. FormLogic stores ciphertext and cannot read the answers. If you lose
        your passphrase and recovery kit, the data cannot be recovered.
      </p>

      {status === 'unknown' && (
        <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-slate-500">
          <Spinner size="sm" /> Checking your vault...
        </div>
      )}

      {status === 'none' && (
        <Button onClick={() => setShowSetup(true)} leftIcon={<ShieldCheck className="h-4 w-4" />}>
          Set up vault
        </Button>
      )}

      {(status === 'locked' || status === 'unlocked') && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {status === 'locked' ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                <Lock className="h-3.5 w-3.5" /> Locked
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-700 dark:text-green-300">
                <LockOpen className="h-3.5 w-3.5" /> Unlocked
              </span>
            )}
            {status === 'locked' ? (
              <Button size="sm" onClick={() => setShowUnlock(true)}>Unlock</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => lock()} leftIcon={<Lock className="h-4 w-4" />}>
                Lock now
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => { setShowChange((v) => !v); setChangeError(null); }} leftIcon={<KeyRound className="h-4 w-4" />}>
              Change passphrase
            </Button>
          </div>
          <p className="text-xs text-gray-400 dark:text-slate-500">
            The vault locks automatically after 30 minutes of inactivity, when you sign out, and in every
            open tab at once when you lock it anywhere.
          </p>

          {showChange && (
            <div className="space-y-3 rounded-lg border border-gray-200 dark:border-slate-800 p-4">
              <PasswordInput
                label="Current passphrase"
                placeholder="Your current vault passphrase"
                value={currentPass}
                onChange={(e) => setCurrentPass(e.target.value)}
                autoComplete="current-password"
                disabled={changing}
              />
              <PasswordInput
                label="New passphrase"
                placeholder="At least 10 characters"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                autoComplete="new-password"
                disabled={changing}
              />
              <PasswordInput
                label="Confirm new passphrase"
                placeholder="Type it again"
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                autoComplete="new-password"
                error={confirmPass && newPass !== confirmPass ? 'Passphrases do not match' : undefined}
                disabled={changing}
              />
              {changeError && (
                <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2.5 text-sm text-red-700 dark:text-red-300" role="alert">
                  {changeError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setShowChange(false)} disabled={changing}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={handleChangePassphrase}
                  isLoading={changing}
                  disabled={!currentPass || !newPass || !confirmPass}
                >
                  Change passphrase
                </Button>
              </div>
              <p className="text-xs text-gray-400 dark:text-slate-500">
                Changing the passphrase re-wraps your master key only - no form keys or data are touched.
              </p>
            </div>
          )}
        </div>
      )}

      <VaultSetupWizard isOpen={showSetup} onClose={() => setShowSetup(false)} />
      <VaultUnlockDialog isOpen={showUnlock} onClose={() => setShowUnlock(false)} />
    </div>
  );
}
