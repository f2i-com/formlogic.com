import { useCallback, useEffect, useState } from 'react';
import { Activity, Archive, LogOut, Megaphone, RefreshCw, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { api, type MaintenanceStatus, type ScheduledBackupRun } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import { AdminPlansCard } from './AdminPlansCard';
import { AdminAllowancesCard } from './AdminAllowancesCard';
import { AdminError, AdminSpinner } from './adminUi';
import { useAdminQuery } from './useAdminQuery';

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
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [confirmMaintenance, setConfirmMaintenance] = useState(false);
  const [bootBusy, setBootBusy] = useState(false);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [retracting, setRetracting] = useState<string | null>(null);
  const fetchNotices = useCallback(() => api.adminListNotices(), []);
  const { data: noticeData, error: noticeError, loading: noticesLoading, refresh: reloadNotices } = useAdminQuery(fetchNotices);
  const notices = noticeData?.notices ?? [];
  const [noticeText, setNoticeText] = useState('');
  const [noticeLevel, setNoticeLevel] = useState<'info' | 'warning' | 'success'>('info');
  const [noticeAudience, setNoticeAudience] = useState<'online' | 'all'>('online');

  // Scheduled nightly backups (bin/backup-accounts.php) — list + run-now.
  const [backupRuns, setBackupRuns] = useState<ScheduledBackupRun[] | null>(null);
  const [backupLastRun, setBackupLastRun] = useState<string | null>(null);
  const [runningBackup, setRunningBackup] = useState(false);
  const [backupReadFailed, setBackupReadFailed] = useState(false);

  const loadBackups = useCallback(() => {
    api.adminListScheduledBackups().then((r) => {
      // A failed read used to leave lastRun null, which renders as "Never run" plus
      // setup instructions — telling an admin their nightly backups have never happened
      // when in fact we just could not ask.
      if (r.error || !r.data) {
        setBackupReadFailed(true);
        return;
      }
      setBackupReadFailed(false);
      setBackupRuns(r.data.runs);
      setBackupLastRun(r.data.lastRun);
    });
  }, []);
  useEffect(() => { loadBackups(); }, [loadBackups]);

  const runBackupNow = async () => {
    setRunningBackup(true);
    try {
      const r = await api.adminRunScheduledBackup();
      if (r.error || !r.data) {
        toast.error('Backup failed', typeof r.error === 'string' ? r.error : undefined);
        return;
      }
      const s = r.data.summary;
      if (s.failed > 0) toast.warning('Backup finished with failures', `${s.ok}/${s.users} accounts backed up — check the manifest for errors.`);
      else toast.success('Backup complete', `${s.ok} account${s.ok === 1 ? '' : 's'} backed up for ${s.date}.`);
      loadBackups();
    } finally {
      setRunningBackup(false);
    }
  };

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
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    setMaintenanceBusy(true);
    try {
      const r = await api.adminSetMaintenance(enabled, message);
      if (r.error || !r.data) toast.error('Could not update maintenance mode', r.error);
      else {
        setStatus(r.data.maintenance);
        setMessage(r.data.maintenance.message);
        setConfirmMaintenance(false);
        toast.success(enabled ? 'Maintenance settings saved' : 'Site reopened');
      }
    } finally { setMaintenanceBusy(false); }
  };

  const boot = async () => {
    setBootBusy(true);
    try {
      const r = await api.adminBootSessions();
      if (r.error || !r.data) toast.error('Could not sign users out', r.error);
      else { setConfirmBoot(false); toast.success('All users signed out', 'Every non-admin session is now invalid.'); }
    } finally { setBootBusy(false); }
  };

  const sendNotice = async () => {
    if (!noticeText.trim()) return;
    setNoticeBusy(true);
    try {
      const r = await api.adminCreateNotice(noticeText.trim(), noticeLevel, noticeAudience);
      if (r.error || !r.data) toast.error('Could not send notice', r.error);
      else {
        toast.success('Notice sent', noticeAudience === 'online' ? 'Signed-in users will see it within a minute.' : 'Every user will see it once, until it expires.');
        setNoticeText('');
        reloadNotices();
      }
    } finally { setNoticeBusy(false); }
  };

  const retractNotice = async (id: string) => {
    setRetracting(id);
    try {
      const r = await api.adminRevokeNotice(id);
      if (r.error || !r.data) toast.error('Could not retract notice', r.error);
      else { toast.success('Notice retracted'); reloadNotices(); }
    } finally { setRetracting(null); }
  };

  // A silent failure must not render the default "maintenance off" state.
  if (status === null) {
    return loadError
      ? <AdminError message={loadError} onRetry={load} />
      : <AdminSpinner label="Loading platform status" />;
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Platform settings" className="flex flex-wrap gap-2">
        {[['plans', 'Plans & AI'], ['availability', 'Site availability'], ['notices', 'Notices'], ['backups', 'Backups'], ['allowances', 'Usage limits']].map(([id, label]) => <a key={id} href={`#${id}`} className="inline-flex min-h-11 items-center rounded-full border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-white focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{label}</a>)}
      </nav>
      <section id="plans" className="scroll-mt-24"><AdminPlansCard /></section>
      <Card id="availability" className="scroll-mt-24">
        <CardContent className="p-5 sm:p-6 space-y-4">
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
            <label htmlFor="maintenance-message" className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Visitor-facing message (shown on dashboards and embedded forms)</label>
            <textarea
              id="maintenance-message"
              disabled={maintenanceBusy}
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
                <Button disabled={maintenanceBusy} onClick={() => toggle(false)} leftIcon={<RefreshCw className="h-4 w-4" />}>Reopen the site</Button>
                <Button variant="outline" isLoading={maintenanceBusy} onClick={() => toggle(true)}>Update message</Button>
              </>
            ) : (
              <Button variant="danger" disabled={maintenanceBusy} onClick={() => setConfirmMaintenance(true)} leftIcon={<Wrench className="h-4 w-4" />}>Close site for maintenance</Button>
            )}
            <Button variant="outline" disabled={bootBusy} onClick={() => setConfirmBoot(true)} leftIcon={<LogOut className="h-4 w-4" />}>
              Sign everyone out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card id="notices" className="scroll-mt-24">
        <CardContent className="p-5 sm:p-6 space-y-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Broadcast a message
          </h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Pops up as a toast on users&apos; dashboards. <strong>Signed-in now</strong> reaches current sessions
            (expires in an hour); <strong>all users</strong> stays live for a week so everyone sees it once.
          </p>
          <label htmlFor="broadcast-message" className="block text-sm font-medium text-gray-700 dark:text-slate-300">Notice message</label>
          <textarea
            id="broadcast-message"
            disabled={noticeBusy}
            value={noticeText}
            onChange={(e) => setNoticeText(e.target.value)}
            rows={2}
            maxLength={500}
            className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-slate-100 p-3"
            placeholder="e.g. Heads up — we're upgrading tonight at 10pm, expect a short outage."
          />
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label="Notice style" disabled={noticeBusy} value={noticeLevel} onChange={(e) => setNoticeLevel(e.target.value as typeof noticeLevel)}
              className="max-w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100">
              <option value="info">Info</option>
              <option value="warning">Warning (stays until dismissed)</option>
              <option value="success">Success</option>
            </select>
            <select aria-label="Notice audience" disabled={noticeBusy} value={noticeAudience} onChange={(e) => setNoticeAudience(e.target.value as typeof noticeAudience)}
              className="max-w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100">
              <option value="online">Users signed in now</option>
              <option value="all">All users</option>
            </select>
            <Button onClick={sendNotice} isLoading={noticeBusy} disabled={!noticeText.trim()} leftIcon={<Megaphone className="h-4 w-4" />}>Send notice</Button>
          </div>
          {noticeError && <AdminError message={noticeError} onRetry={reloadNotices} />}
          {noticesLoading && <p role="status" className="text-sm text-gray-500 dark:text-slate-400">Loading notices…</p>}
          {!noticesLoading && !noticeError && notices.length === 0 && <p className="text-sm text-gray-500 dark:text-slate-400">No notices yet.</p>}
          {notices.length > 0 && (
            <div className="space-y-1.5">
              {notices.slice(0, 8).map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                  <div className="min-w-0 text-sm">
                    <p className="text-gray-900 dark:text-white break-words">{n.message}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      {n.level} · {n.audience === 'online' ? 'signed-in users' : 'all users'} · {formatDateTimeInZone(n.createdAt, tz)}
                      {!n.active && ' · ended'}
                    </p>
                  </div>
                  {n.active && (
                    <Button size="sm" variant="outline" disabled={retracting !== null || noticesLoading} isLoading={retracting === n.id} onClick={() => void retractNotice(n.id)}>Retract</Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="backups" className="scroll-mt-24">
        <CardContent className="p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Archive className="h-4 w-4" /> Scheduled backups
              </h3>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                Nightly site backup: one restorable zip per account + a full database dump, kept for the retention window.
                Restore an account from its page in <strong>Users</strong>.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={runBackupNow} isLoading={runningBackup} leftIcon={<Archive className="h-4 w-4" />}>
              {runningBackup ? 'Backing up…' : 'Run backup now'}
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            {backupReadFailed
              ? <>Couldn&apos;t read the backup history — this says nothing about whether backups ran. <button type="button" onClick={loadBackups} className="cursor-pointer font-medium text-primary-600 hover:underline dark:text-primary-400">Try again</button></>
              : backupRuns === null
                ? <>Loading backup history…</>
              : backupLastRun
                ? <>Last run {formatDateTimeInZone(backupLastRun, tz)}</>
                : <>Never run — schedule <code className="fl-mono">bin/backup-accounts.php</code> daily (cron or Task Scheduler), or run one now.</>}
          </p>
          {backupRuns !== null && backupRuns.length > 0 && (
            <div className="space-y-1.5">
              {backupRuns.map((run) => (
                <div key={run.date} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium text-gray-900 dark:text-white">{run.date}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                      {run.users} account{run.users === 1 ? '' : 's'} · {(run.totalBytes / (1024 * 1024)).toFixed(1)} MB
                      {!run.includeFiles && ' · records only'}
                    </span>
                  </div>
                  {run.failed > 0
                    ? <Badge variant="warning">{run.failed} failed</Badge>
                    : <Badge variant="success">ok</Badge>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <section id="allowances" className="scroll-mt-24"><AdminAllowancesCard /></section>

      <ConfirmDialog
        isOpen={confirmMaintenance}
        onClose={() => { if (!maintenanceBusy) setConfirmMaintenance(false); }}
        onConfirm={() => void toggle(true)}
        title="Close the site for maintenance?"
        message="Users will temporarily lose access to dashboards, APIs, and embedded forms. They will see your maintenance message. Administrators keep access and can reopen the site here."
        confirmLabel="Close site for maintenance"
        variant="danger"
        isLoading={maintenanceBusy}
      />
      <ConfirmDialog
        isOpen={confirmBoot}
        onClose={() => { if (!bootBusy) setConfirmBoot(false); }}
        isLoading={bootBusy}
        onConfirm={boot}
        title="Sign every user out?"
        message="All non-admin sessions become invalid immediately — everyone will have to log in again. Your own admin session survives. Usually combined with maintenance mode."
        confirmLabel="Sign everyone out"
        variant="danger"
      />
    </div>
  );
}
