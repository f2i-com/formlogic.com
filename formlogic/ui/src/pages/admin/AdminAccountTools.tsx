import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Copy, CreditCard, KeyRound, Mail, Wallet } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Badge } from '../../components/ui/Badge';
import { api } from '../../lib/api';
import { formatDateTimeInZone, formatDateInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';

/**
 * Support tools on the admin user page: password reset (temp shown once,
 * sessions revoked), email change, the payment ledger with a complimentary-
 * access toggle, and — heavily gated behind a type-the-email confirmation —
 * full account deletion through the same truthful erasure engine as
 * self-service deletion.
 */
export function AdminAccountTools({ userId, email, isAdmin, isSelf, onChanged }: {
  userId: string;
  email: string;
  isAdmin: boolean;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const tz = useAdminTimezone();

  // Password reset — generated temp password is displayed exactly once.
  const [pwOpen, setPwOpen] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const resetPassword = async () => {
    setPwBusy(true);
    const r = await api.adminResetPassword(userId);
    setPwBusy(false);
    setPwOpen(false);
    if (r.error || !r.data?.tempPassword) {
      toast.error('Could not reset the password', r.error);
      return;
    }
    setTempPassword(r.data.tempPassword);
    toast.success('Password reset', 'Every existing session was signed out.');
  };

  // Email change.
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const changeEmail = async () => {
    setEmailBusy(true);
    const r = await api.adminUpdateEmail(userId, newEmail.trim());
    setEmailBusy(false);
    if (r.error) {
      toast.error('Could not change the email', r.error);
      return;
    }
    setEmailOpen(false);
    setNewEmail('');
    toast.success('Email updated', 'Every existing session was signed out.');
    onChanged();
  };

  // Payments + complimentary access.
  const [payments, setPayments] = useState<Awaited<ReturnType<typeof api.adminListPayments>>['data'] | null>(null);
  const [payTick, setPayTick] = useState(0);
  const [paymentsFailed, setPaymentsFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.adminListPayments(userId).then((r) => {
      if (cancelled) return;
      // Without the else branch a failed read left "Loading payments…" up permanently,
      // which reads as "still working" rather than "this did not load".
      if (r.data) setPayments(r.data);
      else setPaymentsFailed(true);
    });
    return () => { cancelled = true; };
  }, [userId, payTick]);
  const [compOpen, setCompOpen] = useState<boolean | null>(null); // the value being confirmed
  const [compBusy, setCompBusy] = useState(false);
  const toggleComplimentary = async () => {
    if (compOpen === null) return;
    setCompBusy(true);
    const r = await api.adminSetComplimentary(userId, compOpen);
    setCompBusy(false);
    setCompOpen(null);
    if (r.error) {
      toast.error('Could not update', r.error);
      return;
    }
    toast.success(compOpen ? 'Complimentary access enabled' : 'Complimentary access removed');
    setPayTick((t) => t + 1);
  };

  // Delete account — type-to-confirm the exact email.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const emailMatches = confirmEmail.trim().toLowerCase() === email.toLowerCase();
  const deleteUser = async () => {
    if (!emailMatches) return;
    setDeleteBusy(true);
    const r = await api.adminDeleteUser(userId, confirmEmail.trim());
    setDeleteBusy(false);
    if (r.error || r.data?.status !== 'completed') {
      toast.error('Deletion did not complete', r.error || r.data?.message || 'The account was left intact — retry to resume.');
      return;
    }
    setDeleteOpen(false);
    toast.success('Account deleted', 'The account and all its data are gone.');
    navigate('/admin/users');
  };

  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);

  return (
    <>
      <section>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-1.5">
          <KeyRound className="h-4 w-4" /> Account tools
        </h3>
        <div className="rounded-lg border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-800">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-gray-900 dark:text-white">Password</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">Generate a temporary password (shown once) and sign the user out everywhere.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setPwOpen(true)}>Reset password</Button>
          </div>
          {tempPassword && (
            <div className="px-3 py-2.5 bg-amber-50/70 dark:bg-amber-500/10">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-1.5">
                Temporary password — hand it to the user securely; it won't be shown again:
              </p>
              <div className="flex items-center gap-2">
                <code className="font-mono text-sm px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900/60 border border-amber-200/80 dark:border-amber-500/20 select-all">{tempPassword}</code>
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard.writeText(tempPassword).then(() => toast.success('Copied')); }}
                  aria-label="Copy temporary password"
                  className="p-1.5 rounded-lg text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20 cursor-pointer"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <Button size="sm" variant="ghost" onClick={() => setTempPassword(null)}>Done</Button>
              </div>
            </div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-gray-900 dark:text-white flex items-center gap-1.5"><Mail className="h-3.5 w-3.5 text-gray-400" /> {email}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">Change the account's sign-in email address.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => { setNewEmail(''); setEmailOpen(true); }}>Change email</Button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-1.5">
          <Wallet className="h-4 w-4" /> Payments
          {payments?.complimentary && <Badge variant="success">complimentary</Badge>}
        </h3>
        <div className="rounded-lg border border-gray-200 dark:border-slate-700">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2.5 border-b border-gray-100 dark:border-slate-800">
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Plan <span className="font-medium text-gray-700 dark:text-slate-300">{payments?.plan ?? '…'}</span>
              {' · '}cloud access {payments?.complimentary
                ? 'complimentary (no payments required)'
                : payments?.cloudUntil
                  ? `until ${formatDateInZone(payments.cloudUntil, tz)}`
                  : 'not active'}
            </p>
            <Button size="sm" variant="outline" onClick={() => setCompOpen(!(payments?.complimentary ?? false))}>
              {payments?.complimentary ? 'Remove complimentary access' : 'Make complimentary (free)'}
            </Button>
          </div>
          {!payments ? (
            paymentsFailed ? (
              <p className="px-3 py-3 text-xs text-amber-700 dark:text-amber-300">
                Couldn&apos;t load payments.{' '}
                <button type="button" onClick={() => { setPaymentsFailed(false); setPayTick((n) => n + 1); }} className="cursor-pointer font-medium underline">Try again</button>
              </p>
            ) : (
              <p className="px-3 py-3 text-xs text-gray-400 dark:text-slate-500">Loading payments…</p>
            )
          ) : payments.payments.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-400 dark:text-slate-500">No payments on record.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-slate-800">
              {payments.payments.map((p) => (
                <li key={p.id} className="px-3 py-2 flex items-center gap-3">
                  <CreditCard className="h-4 w-4 text-gray-400 dark:text-slate-500 flex-none" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 dark:text-white">
                      {money(p.amountCents, p.currency)} · {p.months} month{p.months === 1 ? '' : 's'} · {p.provider}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-slate-500">
                      {formatDateTimeInZone(p.createdAt, tz)} · order {p.orderId}
                    </p>
                  </div>
                  <Badge variant={p.status === 'completed' ? 'success' : p.status === 'failed' ? 'error' : 'default'}>{p.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {!isSelf && (
        <section>
          <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2 flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" /> Danger zone
          </h3>
          <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-gray-900 dark:text-white">Delete this account</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Permanently erases the account and ALL its data — apps, forms, records, files, recycle bin.
                {isAdmin && ' This user is an administrator: remove their admin access first.'}
              </p>
            </div>
            <Button size="sm" variant="danger" disabled={isAdmin} onClick={() => { setConfirmEmail(''); setDeleteOpen(true); }}>
              Delete account…
            </Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        isOpen={pwOpen}
        onClose={() => setPwOpen(false)}
        onConfirm={() => { void resetPassword(); }}
        title="Reset this user's password?"
        message={`A new temporary password is generated for ${email} and shown to you ONCE. Every existing session is signed out. The reset is audited.`}
        confirmLabel="Generate temp password"
        isLoading={pwBusy}
      />

      <ConfirmDialog
        isOpen={emailOpen}
        onClose={() => setEmailOpen(false)}
        onConfirm={() => { void changeEmail(); }}
        title="Change the account email?"
        message={`The account currently signs in as ${email}. It will sign in with the new address immediately, and every existing session is signed out. The change is audited.`}
        confirmLabel="Change email"
        isLoading={emailBusy}
      >
        <Input
          label="New email address"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="new@company.com"
        />
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={compOpen !== null}
        onClose={() => setCompOpen(null)}
        onConfirm={() => { void toggleComplimentary(); }}
        title={compOpen ? 'Make this account complimentary?' : 'Remove complimentary access?'}
        message={compOpen
          ? 'The account stays fully active with no payments required, indefinitely. The payment ledger is untouched.'
          : 'Cloud access ends now unless the user pays again (on self-hosted installs with enforcement off, nothing changes in practice).'}
        confirmLabel={compOpen ? 'Make complimentary' : 'Remove'}
        isLoading={compBusy}
      />

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => { void deleteUser(); }}
        title="Permanently delete this account?"
        message={`This erases ${email} and EVERYTHING it owns — apps, forms, all records, uploaded files and recycle-bin snapshots. There is no undo and no recovery. Type the account's email address exactly to confirm.`}
        confirmLabel={deleteBusy ? 'Deleting…' : 'Delete everything'}
        variant="danger"
        isLoading={deleteBusy}
        confirmDisabled={!emailMatches}
      >
        <Input
          label="Confirm email"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          placeholder={email}
          error={confirmEmail && !emailMatches ? 'Must match the account email exactly' : undefined}
        />
      </ConfirmDialog>
    </>
  );
}
