import { useCallback, useEffect, useState } from 'react';
import { Activity, LogOut, Megaphone, RefreshCw, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { api, type AdminNotice, type MaintenanceStatus } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';

/**
 * /admin/platform — maintenance mode (close the site), global session boot,
 * and broadcast notices. Storage is deliberately unchanged: the maintenance
 * flag is a FILE so the 503 gate works while MySQL is mid-upgrade.
 */
export function AdminPlatform() {
  const tz = useAdminTimezone();
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [online, setOnline] = useState<number>(0);
  const [message, setMessage] = useState('');
  const [confirmBoot, setConfirmBoot] = useState(false);
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const [noticeText, setNoticeText] = useState('');
  const [noticeLevel, setNoticeLevel] = useState<'info' | 'warning' | 'success'>('info');
  const [noticeAudience, setNoticeAudience] = useState<'online' | 'all'>('online');

  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.adminGetMaintenance().then((r) => {
      if (r.data) {
        setStatus(r.data.maintenance);
        setOnline(r.data.onlineUsers);
        setMessage((m) => m || r.data!.maintenance.message);
        setLoadError(null);
      } else {
        setLoadError(r.error || 'Could not load the maintenance status');
      }
    });
    api.adminListNotices().then((r) => { if (r.data) setNotices(r.data.notices); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    const r = await api.adminSetMaintenance(enabled, message);
    if (r.error) toast.error('Could not update maintenance mode', r.error);
    else {
      setStatus(r.data!.maintenance);
      toast.success(enabled ? 'Site closed for maintenance' : 'Site reopened');
    }
  };

  const boot = async () => {
    setConfirmBoot(false);
    const r = await api.adminBootSessions();
    if (r.error) toast.error('Could not boot sessions', r.error);
    else toast.success('All users signed out', 'Every non-admin session is now invalid.');
  };

  const sendNotice = async () => {
    if (!noticeText.trim()) return;
    const r = await api.adminCreateNotice(noticeText.trim(), noticeLevel, noticeAudience);
    if (r.error) toast.error('Could not send', r.error);
    else {
      toast.success('Notice sent', noticeAudience === 'online' ? 'Signed-in users will see it within a minute.' : 'Every user will see it once, until it expires.');
      setNoticeText('');
      load();
    }
  };

  // A silent failure must not render the default "maintenance off" state.
  if (status === null) {
    return loadError
      ? <AdminError message={loadError} onRetry={load} />
      : <AdminSpinner label="Loading platform status" />;
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Wrench className="h-4 w-4" /> Maintenance mode
                {status?.enabled ? <Badge variant="warning">ON — site closed</Badge> : <Badge variant="default">off</Badge>}
              </h3>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                Closes the whole site (dashboards, APIs and embedded forms show your message). Administrators keep full access.
              </p>
            </div>
            <div className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-500" /> {online} user{online === 1 ? '' : 's'} online now
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Visitor-facing message (shown on dashboards and embedded forms)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              maxLength={500}
              className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-slate-100 p-3"
              placeholder="We are briefly down for maintenance. Please check back in a few minutes."
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {status?.enabled ? (
              <>
                <Button onClick={() => toggle(false)} leftIcon={<RefreshCw className="h-4 w-4" />}>Reopen the site</Button>
                <Button variant="outline" onClick={() => toggle(true)}>Update message</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => toggle(true)} leftIcon={<Wrench className="h-4 w-4" />}>Close site for maintenance</Button>
            )}
            <Button variant="outline" onClick={() => setConfirmBoot(true)} leftIcon={<LogOut className="h-4 w-4" />}>
              Sign everyone out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Broadcast a message
          </h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Pops up as a toast on users&apos; dashboards. <strong>Signed-in now</strong> reaches current sessions
            (expires in an hour); <strong>all users</strong> stays live for a week so everyone sees it once.
          </p>
          <textarea
            value={noticeText}
            onChange={(e) => setNoticeText(e.target.value)}
            rows={2}
            maxLength={500}
            className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-slate-100 p-3"
            placeholder="e.g. Heads up — we're upgrading tonight at 10pm, expect a short outage."
          />
          <div className="flex flex-wrap items-center gap-3">
            <select value={noticeLevel} onChange={(e) => setNoticeLevel(e.target.value as typeof noticeLevel)}
              className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100">
              <option value="info">Info</option>
              <option value="warning">Warning (stays until dismissed)</option>
              <option value="success">Success</option>
            </select>
            <select value={noticeAudience} onChange={(e) => setNoticeAudience(e.target.value as typeof noticeAudience)}
              className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100">
              <option value="online">Users signed in now</option>
              <option value="all">All users</option>
            </select>
            <Button onClick={sendNotice} disabled={!noticeText.trim()} leftIcon={<Megaphone className="h-4 w-4" />}>Send</Button>
          </div>
          {notices.length > 0 && (
            <div className="space-y-1.5">
              {notices.slice(0, 8).map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                  <div className="min-w-0 text-sm">
                    <p className="text-gray-900 dark:text-white truncate">{n.message}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      {n.level} · {n.audience === 'online' ? 'signed-in users' : 'all users'} · {formatDateTimeInZone(n.createdAt, tz)}
                      {!n.active && ' · ended'}
                    </p>
                  </div>
                  {n.active && (
                    <Button size="sm" variant="outline" onClick={async () => { await api.adminRevokeNotice(n.id); load(); }}>Retract</Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={confirmBoot}
        onClose={() => setConfirmBoot(false)}
        onConfirm={boot}
        title="Sign every user out?"
        message="All non-admin sessions become invalid immediately — everyone will have to log in again. Your own admin session survives. Usually combined with maintenance mode."
        confirmLabel="Sign everyone out"
        variant="danger"
      />
    </div>
  );
}
