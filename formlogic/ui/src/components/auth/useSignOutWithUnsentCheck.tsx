import { useState } from 'react';
import { unsentSubmissionsOnSignOut, useAuthStore } from '../../stores/authStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * Sign-out for the account's own "Sign out" buttons (UserMenu, AppUserProfile). Signing out
 * removes the submissions this account still has queued on the device (teardownUserSession):
 * when there are any, the person is told how many first and can stay signed in. Render `dialog`;
 * `afterSignOut` runs once signed out.
 */
export function useSignOutWithUnsentCheck(afterSignOut: () => void) {
  const logout = useAuthStore((s) => s.logout);
  const [unsent, setUnsent] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signOutNow = async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
      setUnsent(null);
    }
    afterSignOut();
  };
  const requestSignOut = async () => {
    const waiting = await unsentSubmissionsOnSignOut();
    if (waiting > 0) setUnsent(waiting);
    else await signOutNow();
  };
  const dialog = (
    <ConfirmDialog
      isOpen={unsent !== null}
      onClose={() => setUnsent(null)}
      onConfirm={() => void signOutNow()}
      title="Sign out with unsent submissions?"
      message={
        unsent === 1
          ? '1 submission has not been sent yet. Signing out removes it from this device, and its answers will be lost.\n\n' +
            'To keep it, stay signed in until it has been sent.'
          : `${unsent} submissions have not been sent yet. Signing out removes them from this device, and their answers will be lost.\n\n` +
            'To keep them, stay signed in until they have been sent.'
      }
      confirmLabel="Sign out anyway"
      cancelLabel="Stay signed in"
      variant="danger"
      isLoading={signingOut}
    />
  );
  return { requestSignOut, dialog };
}
