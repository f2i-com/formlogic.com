// App-shell vault lock-state chip (plan SS10 unlock UX): visible only when the
// signed-in user actually HAS a vault. Locked -> amber lock, click to unlock;
// unlocked -> green open lock, click to lock everywhere (all tabs).
import { useEffect, useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { ensureVaultLoaded } from '../../lib/crypto/formCrypto';
import { VaultUnlockDialog } from './VaultUnlockDialog';

export function VaultChip() {
  const user = useAuthStore((s) => s.user);
  const status = useVaultStore((s) => s.status);
  const lock = useVaultStore((s) => s.lock);
  const [showUnlock, setShowUnlock] = useState(false);

  useEffect(() => {
    if (user && !user.isDemo && status === 'unknown') {
      void ensureVaultLoaded().catch(() => undefined);
    }
  }, [user, status]);

  if (!user || user.isDemo || (status !== 'locked' && status !== 'unlocked')) return null;

  const locked = status === 'locked';
  return (
    <>
      <button
        type="button"
        onClick={() => (locked ? setShowUnlock(true) : lock())}
        title={locked ? 'Vault locked - private form data is hidden. Click to unlock.' : 'Vault unlocked - click to lock everywhere.'}
        aria-label={locked ? 'Unlock vault' : 'Lock vault'}
        className={
          locked
            ? 'inline-flex items-center gap-1.5 rounded-full border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500'
            : 'inline-flex items-center gap-1.5 rounded-full border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-2.5 py-1.5 text-xs font-medium text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-500/20 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500'
        }
      >
        {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{locked ? 'Vault locked' : 'Vault unlocked'}</span>
      </button>
      <VaultUnlockDialog isOpen={showUnlock} onClose={() => setShowUnlock(false)} />
    </>
  );
}
