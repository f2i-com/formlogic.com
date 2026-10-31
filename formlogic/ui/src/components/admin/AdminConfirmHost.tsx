import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { rememberAdminConfirmation, setAdminConfirmationPrompt } from '../../lib/adminConfirmation';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { PasswordInput } from '../ui/PasswordInput';

/** The dialog behind askForAdminConfirmation, mounted once for anyone who is an administrator. */
export function AdminConfirmHost() {
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);
  const mfaEnabled = useAuthStore((s) => !!s.user?.mfaEnabled);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    setAdminConfirmationPrompt(() => new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setPassword('');
      setCode('');
      setError('');
      setOpen(true);
    }));
    return () => setAdminConfirmationPrompt(null);
  }, [isAdmin]);

  const finish = (confirmed: boolean) => {
    setOpen(false);
    answer.current?.(confirmed);
    answer.current = null;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const result = await api.adminConfirm(password, code.trim());
    setBusy(false);
    if (result.data?.confirmation) {
      rememberAdminConfirmation(result.data.confirmation, result.data.expiresInSeconds);
      finish(true);
    } else {
      setError(result.error || 'That could not be confirmed. Please try again.');
    }
  };

  return (
    <Modal isOpen={open} onClose={() => finish(false)} title="Confirm it's you">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-slate-400">This opens someone else's account, so we check first. It lasts 15 minutes.</p>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <PasswordInput label="Your password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy} required />
        {mfaEnabled && <Input label="Authenticator code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" disabled={busy} required />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => finish(false)} disabled={busy}>Cancel</Button>
          <Button type="submit" isLoading={busy}>Confirm</Button>
        </div>
      </form>
    </Modal>
  );
}
