import { useCallback, useEffect, useState } from 'react';
import { Activity, Boxes, FileText, LogOut, Package, RefreshCw, Users, Workflow, Wrench } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { StatCard } from '../../components/ui/StatCard';
import { api, type AdminOverview as AdminOverviewData } from '../../lib/api';
import { loadUiCache, saveUiCache } from '../../lib/uiCache';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { useAuthStore } from '../../stores/authStore';
import { AdminSpinner } from './adminUi';

/**
 * /admin — instance counters (structure/statistics only, never record data).
 * Hydrates instantly from the last visit's cached stats (SWR), then refreshes.
 */
export function AdminOverview() {
  const meId = useAuthStore((s) => s.user?.id);
  const tz = useAdminTimezone();
  const [data, setData] = useState<AdminOverviewData | null>(() => loadUiCache<AdminOverviewData>('admin-overview', meId)?.data ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.adminOverview().then((r) => {
      if (r.data) {
        setData(r.data);
        setError(null);
        saveUiCache('admin-overview', meId, r.data);
      } else {
        setError(r.error || 'Could not load');
      }
    });
  }, [meId]);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <AdminSpinner label="Loading overview" />;

  const s = data.stats;
  const iconBg = 'bg-primary-100 dark:bg-primary-500/15';
  const iconColor = 'text-primary-700 dark:text-primary-300';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Users} iconBg={iconBg} iconColor={iconColor} value={s.users} label="Users"
          subtext={`${s.signups7d} new this week · ${s.admins} admin${s.admins === 1 ? '' : 's'}`} />
        <StatCard icon={Activity} iconBg={iconBg} iconColor={iconColor} value={s.onlineUsers} label="Online now"
          subtext="seen in the last 5 minutes" />
        <StatCard icon={Boxes} iconBg={iconBg} iconColor={iconColor} value={s.apps} label="Apps" />
        <StatCard icon={FileText} iconBg={iconBg} iconColor={iconColor} value={s.forms} label="Forms"
          subtext={`${s.responses.toLocaleString()} records`} />
        <StatCard icon={Workflow} iconBg={iconBg} iconColor={iconColor} value={s.flows} label="Flows" />
        <StatCard icon={Package} iconBg={iconBg} iconColor={iconColor} value={<span className="text-base sm:text-lg font-semibold leading-snug break-all">{data.version}</span>} label="Version" />
        <StatCard icon={Wrench} iconBg={iconBg} iconColor={iconColor} value={data.maintenance.enabled ? 'ON' : 'off'} label="Maintenance" />
        {/* A full datetime at StatCard's heading size wraps to three lines and
            dwarfs the numeric tiles — downsize the value node (child text size
            wins over the tile's text-2xl/3xl). */}
        <StatCard icon={LogOut} iconBg={iconBg} iconColor={iconColor}
          value={data.sessionEpoch > 0
            ? <span className="text-base sm:text-lg font-semibold leading-snug">{formatDateTimeInZone(new Date(data.sessionEpoch * 1000), tz)}</span>
            : 'never'}
          label="Session boot" subtext="last global sign-out" />
      </div>
      <Button variant="outline" size="sm" onClick={load} leftIcon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>
    </div>
  );
}
