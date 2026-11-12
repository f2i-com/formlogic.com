import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowUpRight, Boxes, FileText, LayoutGrid, Package, RefreshCw, Users, Workflow, Wrench, Stethoscope } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Panel } from '../../components/ui/Panel';
import { api } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { useAuthStore } from '../../stores/authStore';
import { AdminCount, AdminError, AdminSpinner } from './adminUi';
import { useAdminQuery } from './useAdminQuery';

const shortcuts = [
  { to: '/admin/users', icon: Users, title: 'Manage users', detail: 'Account access, resources, and recovery' },
  { to: '/admin/platform', icon: Wrench, title: 'Configure your platform', detail: 'Plans, AI, notices, and scheduled backups' },
  { to: '/admin/upgrade', icon: Package, title: 'Review updates', detail: 'Official releases and installation backups' },
  { to: '/admin/doctor', icon: Stethoscope, title: 'Check system health', detail: 'Service checks and troubleshooting' },
];

export function AdminOverview() {
  const meId = useAuthStore(s => s.user?.id);
  const tz = useAdminTimezone();
  // Changing accounts also changes the query, so statistics never cross sessions.
  const fetchOverview = useCallback(() => meId ? api.adminOverview() : Promise.resolve({ error: 'Please sign in again.' }), [meId]);
  const { data, error, loading, refresh } = useAdminQuery(fetchOverview);
  if (!data) return error ? <AdminError message={error} onRetry={refresh} /> : <AdminSpinner label="Loading overview" />;
  const s = data.stats;
  return (
    <div className="space-y-4">
      {error && <AdminError message={`Showing the last loaded overview. ${error}`} onRetry={refresh} />}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-sm text-gray-500 dark:text-slate-400">{s.onlineUsers} online in the last 5 minutes · {s.signups7d} new users this week</p>
        <Button variant="outline" size="sm" onClick={refresh} isLoading={loading} leftIcon={<RefreshCw className="h-4 w-4" />}>Refresh overview</Button>
      </div>
      {/* The counts in one compact row: four across with room for them, two on a phone. */}
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy={loading}>
        <AdminCount icon={Users} label="Users" value={s.users.toLocaleString()} note={`${s.admins} administrator${s.admins === 1 ? '' : 's'}`} />
        <AdminCount icon={Boxes} label="Apps" value={s.apps.toLocaleString()} />
        <AdminCount icon={FileText} label="Forms" value={s.forms.toLocaleString()} note={`${s.responses.toLocaleString()} records`} />
        <AdminCount icon={Workflow} label="Automations" value={s.flows.toLocaleString()} />
      </dl>
      {/* The state beside the ways on: one under the other until there is room for both. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel
          title="Installation status"
          icon={<Activity className="h-4 w-4" />}
          actions={
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${data.maintenance.enabled ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'}`}>
              {data.maintenance.enabled ? 'Closed for maintenance' : 'Open to users'}
            </span>
          }
        >
          {data.maintenance.enabled && <p className="mb-3 break-words text-sm text-amber-800 dark:text-amber-300">{data.maintenance.message || 'Maintenance mode is enabled.'} <Link className="font-medium underline" to="/admin/platform#availability">Manage availability</Link></p>}
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div><dt className="text-xs text-gray-500 dark:text-slate-400">Installed version</dt><dd className="mt-0.5 break-all text-sm font-medium text-gray-900 dark:text-white">{data.version}</dd></div>
            <div><dt className="text-xs text-gray-500 dark:text-slate-400">Last sign-out of all users</dt><dd className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{data.sessionEpoch > 0 ? formatDateTimeInZone(new Date(data.sessionEpoch * 1000), tz) : 'No global sign-out recorded'}</dd></div>
          </dl>
        </Panel>
        <Panel title="Manage your installation" icon={<LayoutGrid className="h-4 w-4" />} className="@container">
          <div className="grid gap-2 @lg:grid-cols-2">
            {shortcuts.map(({ to, icon: Icon, title, detail }) => <Link key={to} to={to} className="group flex min-h-11 items-center gap-3 rounded-xl border border-gray-200 px-3 py-2 transition-colors hover:border-primary-300 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:hover:border-primary-500/60 dark:hover:bg-white/[0.03]">
              <Icon className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
              <div className="min-w-0 flex-1"><h3 className="text-sm font-medium text-gray-900 dark:text-white">{title}</h3><p className="text-xs leading-5 text-gray-500 dark:text-slate-400">{detail}</p></div>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-gray-400 group-hover:text-primary-600 dark:group-hover:text-primary-400" aria-hidden="true" />
            </Link>)}
          </div>
        </Panel>
      </div>
    </div>
  );
}
