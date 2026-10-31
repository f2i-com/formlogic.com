import { useState } from 'react';
import { deviceFormsOnSignOut, unsentSubmissionsOnSignOut, useAuthStore } from '../../stores/authStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * Sign-out for the account's own "Sign out" buttons (UserMenu, AppUserProfile). Signing out
 * removes the submissions this account still has queued on the device (teardownUserSession), and
 * the forms it keeps there in device-only mode: when there are any, the person is told how many
 * first and can stay signed in. Render `dialog`; `afterSignOut` runs once signed out.
 */
export function useSignOutWithUnsentCheck(afterSignOut: () => void) {
  const logout = useAuthStore((s) => s.logout);
  const [atStake, setAtStake] = useState<{ unsent: number; forms: number } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signOutNow = async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
      setAtStake(null);
    }
    afterSignOut();
  };
  const requestSignOut = async () => {
    const unsent = await unsentSubmissionsOnSignOut();
    const forms = deviceFormsOnSignOut();
    if (unsent > 0 || forms > 0) setAtStake({ unsent, forms });
    else await signOutNow();
  };
  const unsent = atStake?.unsent ?? 0;
  const forms = atStake?.forms ?? 0;
  const unsentWarning = unsent === 1
    ? '1 submission has not been sent yet. Signing out removes it from this device, and its answers will be lost.\n\n' +
      'To keep it, stay signed in until it has been sent.'
    : `${unsent} submissions have not been sent yet. Signing out removes them from this device, and their answers will be lost.\n\n` +
      'To keep them, stay signed in until they have been sent.';
  const formsWarning = forms === 1
    ? '1 form is kept on this device. Signing out removes it, with its responses, and it will be lost if it is not in your account.\n\n' +
      'To keep it, choose “Save my forms to my account” first.'
    : `${forms} forms are kept on this device. Signing out removes them, with their responses, and any not in your account will be lost.\n\n` +
      'To keep them, choose “Save my forms to my account” first.';
  const dialog = (
    <ConfirmDialog
      isOpen={atStake !== null}
      onClose={() => setAtStake(null)}
      onConfirm={() => void signOutNow()}
      title={unsent > 0 ? 'Sign out with unsent submissions?' : 'Sign out and remove your forms from this device?'}
      message={[...(unsent > 0 ? [unsentWarning] : []), ...(forms > 0 ? [formsWarning] : [])].join('\n\n')}
      confirmLabel="Sign out anyway"
      cancelLabel="Stay signed in"
      variant="danger"
      isLoading={signingOut}
    />
  );
  return { requestSignOut, dialog };
}
