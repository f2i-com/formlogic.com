import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Boxes, FileText, Package, RefreshCw, Users, Workflow, Wrench, Stethoscope } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { StatCard } from '../../components/ui/StatCard';
import { api } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { useAuthStore } from '../../stores/authStore';
import { AdminError, AdminSpinner } from './adminUi';
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
  const iconBg = 'bg-primary-100 dark:bg-primary-500/15';
  const iconColor = 'text-primary-700 dark:text-primary-300';
  return (
    <div className="space-y-6">
      {error && <AdminError message={`Showing the last loaded overview. ${error}`} onRetry={refresh} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500 dark:text-slate-400">{s.onlineUsers} online in the last 5 minutes · {s.signups7d} new users this week</p>
        <Button variant="outline" size="sm" onClick={refresh} isLoading={loading} leftIcon={<RefreshCw className="h-4 w-4" />}>Refresh overview</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy={loading}>
        <StatCard icon={Users} iconBg={iconBg} iconColor={iconColor} value={s.users} label="Users" subtext={`${s.admins} administrator${s.admins === 1 ? '' : 's'}`} />
        <StatCard icon={Boxes} iconBg={iconBg} iconColor={iconColor} value={s.apps} label="Apps" />
        <StatCard icon={FileText} iconBg={iconBg} iconColor={iconColor} value={s.forms} label="Forms" subtext={`${s.responses.toLocaleString()} records`} />
        <StatCard icon={Workflow} iconBg={iconBg} iconColor={iconColor} value={s.flows} label="Automations" />
      </div>
      <section className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Installation status</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${data.maintenance.enabled ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'}`}>
            {data.maintenance.enabled ? 'Closed for maintenance' : 'Open to users'}
          </span>
        </div>
        {data.maintenance.enabled && <p className="mt-3 break-words text-sm text-amber-800 dark:text-amber-300">{data.maintenance.message || 'Maintenance mode is enabled.'} <Link className="font-medium underline" to="/admin/platform#availability">Manage availability</Link></p>}
        <dl className="mt-5 grid gap-5 border-t border-gray-100 pt-5 sm:grid-cols-2 dark:border-slate-800">
          <div><dt className="text-xs text-gray-500 dark:text-slate-400">Installed version</dt><dd className="mt-1 break-all text-sm font-medium text-gray-900 dark:text-white">{data.version}</dd></div>
          <div><dt className="text-xs text-gray-500 dark:text-slate-400">Last sign-out of all users</dt><dd className="mt-1 text-sm font-medium text-gray-900 dark:text-white">{data.sessionEpoch > 0 ? formatDateTimeInZone(new Date(data.sessionEpoch * 1000), tz) : 'No global sign-out recorded'}</dd></div>
        </dl>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold text-gray-900 dark:text-white">Manage your installation</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {shortcuts.map(({ to, icon: Icon, title, detail }) => <Link key={to} to={to} className="group flex items-start gap-3 rounded-2xl border border-gray-200 bg-white p-5 transition-colors hover:border-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-primary-500">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
            <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3><p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">{detail}</p></div>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-gray-400 group-hover:text-primary-600" />
          </Link>)}
        </div>
      </section>
    </div>
  );
}
