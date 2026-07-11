import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, FileText, ShieldCheck, Workflow } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { api, type AdminUserDetail as AdminUserDetailData } from '../../lib/api';
import { formatDateInZone, formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';

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

  const rowClass = 'w-full text-left rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800 block';

  return (
    <div className="space-y-5">
      <Link to="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" /> All users
      </Link>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : !user ? (
        <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
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
                  <Link key={f.id} to={`/admin/users/${userId}/flows`} className={rowClass}>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{f.name}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                      {f.appName ? `app: ${f.appName}` : 'workspace'} · v{f.version} · {f.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </>
      )}

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
