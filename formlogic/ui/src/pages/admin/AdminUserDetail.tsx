import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArrowLeft, Boxes, FileJson, FileText, KeyRound, Recycle, ShieldCheck, Workflow } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Input } from '../../components/ui/Input';
import { api, type AdminUserDetail as AdminUserDetailData, type ScheduledBackupRun } from '../../lib/api';
import { formatDateInZone, formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { AdminSpinner } from './adminUi';
import { AdminAccountTools } from './AdminAccountTools';

/**
 * /admin/users/:userId — one user's page: profile + counters, admin grant/
 * revoke, and drill-ins that open the user's resources in the REAL owner UIs
 * (acting-as routes): apps → the app manager, forms → the form builder,
 * flows → the flows workspace. Counts only here — record data is never shown
 * to platform admins.
 */
export function AdminUserDetail() {
  const { userId = '' } = useParams();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const tz = useAdminTimezone();
  const [user, setUser] = useState<AdminUserDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAdmin, setConfirmAdmin] = useState<boolean | null>(null);

  const load = useCallback(() => {
    api.adminGetUser(userId).then((r) => {
      if (r.data) { setUser(r.data.user); setError(null); } else { setError(r.error || 'Could not load this user'); }
    });
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const toggleAdmin = async (next: boolean) => {
    const r = await api.adminSetAdmin(userId, next);
    if (r.error) toast.error('Could not update', r.error);
    else { toast.success(next ? 'Administrator access granted' : 'Administrator access removed'); load(); }
    setConfirmAdmin(null);
  };

  // Lockout recovery: reset the user's two-factor auth so they can sign in
  // with just their password and re-enroll. Step-up (audit MFA-001): the
  // acting admin confirms with their OWN password.
  const [confirmMfaReset, setConfirmMfaReset] = useState(false);
  const [resettingMfa, setResettingMfa] = useState(false);
  const [mfaResetPassword, setMfaResetPassword] = useState('');
  const resetMfa = async () => {
    setResettingMfa(true);
    const r = await api.adminResetMfa(userId, mfaResetPassword);
    setResettingMfa(false);
    if (r.error) { toast.error('Could not reset two-factor auth', r.error); return; }
    setConfirmMfaReset(false);
    setMfaResetPassword('');
    toast.success('Two-factor authentication reset', 'The user can sign in with their password and set it up again.');
    load();
  };

  // Structure-only backup manifest: the user's schema + per-form sqlite/uploads
  // PATHS and sizes — never record data (matching data up needs server access).
  const downloadManifest = async () => {
    const r = await api.adminGetBackupManifest(userId);
    if (r.error || !r.data) {
      toast.error('Could not build the manifest', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    const blob = new Blob([JSON.stringify(r.data.manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-manifest-${user?.email ?? userId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Scheduled-backup recovery: which retained days hold a zip for THIS account.
  const [backupDays, setBackupDays] = useState<ScheduledBackupRun[] | null>(null);
  const [restoreDate, setRestoreDate] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    api.adminListScheduledBackups().then((r) => {
      if (r.data) {
        setBackupDays(r.data.runs.filter((run) =>
          run.accounts.some((a) => a.id === userId && !a.error)
        ));
      }
    });
  }, [userId]);

  const restoreFromBackup = async () => {
    const date = restoreDate;
    setRestoreDate(null);
    if (!date) return;
    setRestoring(true);
    try {
      const r = await api.adminRestoreScheduledBackup(userId, date);
      if (r.error || !r.data) {
        toast.error('Restore failed', typeof r.error === 'string' ? r.error : undefined);
        return;
      }
      toast.success(
        `Restored from ${date}`,
        `Created ${r.data.apps.length} apps, ${r.data.forms.length} forms and ${r.data.responses.toLocaleString()} records in this account.`
      );
      load(); // refresh the counters
    } finally {
      setRestoring(false);
    }
  };

  const rowClass = 'w-full text-left rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800 block focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50';

  return (
    <div className="space-y-5">
      <Link to="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" /> All users
      </Link>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : !user ? (
        <AdminSpinner label="Loading user" />
      ) : (
        <>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white break-all">{user.email}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-slate-300">
              <span>{user.name || 'No name'}</span>
              <span>· plan {user.plan}</span>
              <span>· joined {user.createdAt ? formatDateInZone(user.createdAt, tz) : '—'}</span>
              {user.online
                ? <Badge variant="success">online</Badge>
                : <span>· last seen {user.lastSeenAt ? formatDateTimeInZone(user.lastSeenAt, tz) : 'never'}</span>}
              {!user.isDemo && user.id !== me?.id && (
                <Button size="sm" variant={user.isAdmin ? 'outline' : 'secondary'} onClick={() => setConfirmAdmin(!user.isAdmin)} leftIcon={<ShieldCheck className="h-3.5 w-3.5" />}>
                  {user.isAdmin ? 'Remove admin' : 'Make admin'}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={downloadManifest} leftIcon={<FileJson className="h-3.5 w-3.5" />}
                title="Schemas + sqlite file paths per form — never record data">
                Backup manifest
              </Button>
              {user.mfaEnabled && (
                <Button size="sm" variant="outline" onClick={() => setConfirmMfaReset(true)} leftIcon={<KeyRound className="h-3.5 w-3.5" />}
                  title="Lockout recovery: turns two-factor off so the user can sign in and re-enroll">
                  Reset 2FA
                </Button>
              )}
            </div>
          </div>

          <section>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-1.5">
              <Boxes className="h-4 w-4" /> Apps ({user.apps.length})
            </h3>
            {user.apps.length === 0 ? <p className="text-xs text-gray-400 dark:text-slate-500">None</p> : (
              <div className="space-y-1.5">
                {user.apps.map((a) => (
                  <Link key={a.id} to={`/admin/apps/${a.id}/settings`} className={rowClass}>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{a.name}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                      {a.status} · {a.formCount} forms · {a.flowCount} flows · {a.memberCount} members
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-1.5">
              <FileText className="h-4 w-4" /> Forms ({user.forms.length})
            </h3>
            {user.forms.length === 0 ? <p className="text-xs text-gray-400 dark:text-slate-500">None</p> : (
              <div className="space-y-1.5">
                {user.forms.map((f) => (
                  <Link key={f.id} to={`/admin/builder/${f.id}`} className={rowClass}>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{f.title}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                      {f.status} · {f.responseCount === null ? '?' : f.responseCount} records{f.apps ? ` · in ${f.apps}` : ''}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-1.5">
                <Workflow className="h-4 w-4" /> Flows ({user.flows.length})
              </h3>
              {user.flows.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => navigate(`/admin/users/${userId}/flows`)}>
                  Open flows workspace
                </Button>
              )}
            </div>
            {user.flows.length === 0 ? <p className="text-xs text-gray-400 dark:text-slate-500">None</p> : (
              <div className="space-y-1.5">
                {user.flows.map((f) => (
                  <Link key={f.id} to={`/admin/users/${userId}/flows?flow=${encodeURIComponent(f.id)}`} className={rowClass}>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{f.name}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                      {f.appName ? `app: ${f.appName}` : 'workspace'} · v{f.version} · {f.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-1.5">
                <Recycle className="h-4 w-4" /> Recycle bin
              </h3>
              <Button size="sm" variant="outline" onClick={() => navigate(`/admin/users/${userId}/trash`)}>
                Open recycle bin
              </Button>
            </div>
            <p className="text-xs text-gray-400 dark:text-slate-500">
              Things this user deleted in the last 30 days — restorable on their behalf (names and counts only; snapshot contents stay private).
            </p>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-1.5">
              <Archive className="h-4 w-4" /> Restore from backup
            </h3>
            {backupDays === null ? (
              <p className="text-xs text-gray-400 dark:text-slate-500">Loading backups…</p>
            ) : backupDays.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-slate-500">
                No scheduled backups contain this account yet — the nightly job (or Platform → Run backup now) creates them.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Restores the chosen day&apos;s backup INTO this account as new copies — nothing existing is overwritten.
                </p>
                {backupDays.map((run) => {
                  const entry = run.accounts.find((a) => a.id === userId);
                  return (
                    <div key={run.date} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                      <div className="min-w-0 text-sm">
                        <span className="font-medium text-gray-900 dark:text-white">{run.date}</span>
                        <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                          {((entry?.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      </div>
                      <Button size="sm" variant="outline" disabled={restoring} onClick={() => setRestoreDate(run.date)}>
                        Restore
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Support tools: password reset, email change, payments/complimentary,
              and the heavily-gated full account deletion. */}
          <AdminAccountTools
            userId={userId}
            email={user.email}
            isAdmin={!!user.isAdmin}
            isSelf={user.id === me?.id}
            onChanged={load}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={restoreDate !== null}
        onClose={() => setRestoreDate(null)}
        onConfirm={restoreFromBackup}
        title={`Restore the ${restoreDate ?? ''} backup?`}
        message={`This creates NEW copies of the apps, forms and records from that backup inside ${user?.email ?? 'this user'}'s account — nothing existing is overwritten or deleted. The restore is audited.`}
        confirmLabel="Restore backup"
      />

      <ConfirmDialog
        isOpen={confirmMfaReset}
        onClose={() => { setConfirmMfaReset(false); setMfaResetPassword(''); }}
        onConfirm={() => { void resetMfa(); }}
        title="Reset two-factor authentication?"
        message={`Two-factor auth is switched OFF for ${user?.email ?? 'this user'}: their authenticator secret, recovery codes and remembered browsers are wiped, their sessions are signed out, and their password alone signs them in until they re-enroll. Use this when they're locked out. The reset is audited and the user is notified. Confirm with YOUR password.`}
        confirmLabel="Reset 2FA"
        variant="danger"
        isLoading={resettingMfa}
        confirmDisabled={mfaResetPassword === ''}
      >
        <Input
          label="Your password"
          type="password"
          value={mfaResetPassword}
          onChange={(e) => setMfaResetPassword(e.target.value)}
          autoComplete="current-password"
        />
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={confirmAdmin !== null}
        onClose={() => setConfirmAdmin(null)}
        onConfirm={() => confirmAdmin !== null && toggleAdmin(confirmAdmin)}
        title={confirmAdmin ? 'Grant administrator access?' : 'Remove administrator access?'}
        message={confirmAdmin
          ? 'This user will be able to manage every account, close the site and apply upgrades.'
          : 'This user will lose access to the admin panel.'}
        confirmLabel={confirmAdmin ? 'Grant admin' : 'Remove admin'}
        variant={confirmAdmin ? 'default' : 'danger'}
      />
    </div>
  );
}
