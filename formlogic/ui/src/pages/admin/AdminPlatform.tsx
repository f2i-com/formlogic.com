import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Activity, Archive, ChevronRight, LogOut, Megaphone, RefreshCw, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Panel } from '../../components/ui/Panel';
import { api, type MaintenanceStatus, type ScheduledBackupRun } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { AdminPlansCard } from './AdminPlansCard';
import { AdminAllowancesCard } from './AdminAllowancesCard';
import { AdminEnginePolicyCard } from './AdminEnginePolicyCard';
import { AdminPluginsCard } from './AdminPluginsCard';
import { AdminSoftnDirectoryCard } from './AdminSoftnDirectoryCard';
import { AdminAppAiCard } from './AdminAppAiCard';
import { AdminAppPaymentsCard } from './AdminAppPaymentsCard';
import { AdminError, AdminSpinner } from './adminUi';
import { HELP, ROW_BOX } from '../../components/ui/listLook';
import { useAdminQuery } from './useAdminQuery';

const GROUPS = [
  { label: 'Plans & billing', parts: [['plans', 'Plans & AI'], ['allowances', 'Usage limits'], ['app-payments', 'App payments']] },
  { label: 'App hosting', parts: [['app-engine', 'App engine'], ['app-ai', 'AI for apps'], ['plugins', 'Plugins'], ['app-directory', 'App directory']] },
  { label: 'Site operations', parts: [['availability', 'Site availability'], ['notices', 'Notices'], ['backups', 'Backups']] },
] as const;

/** Delay mounting a panel until first opened, then retain its form drafts across navigation. */
function PlatformPane({ id, active, children }: { id: string; active: string; children: ReactNode }) {
  const open = id === active;
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  if (!open && !visited) return null;
  return <div hidden={!open} id={id} tabIndex={-1} className="min-w-0 scroll-mt-24 rounded-xl focus-visible:outline-2 focus-visible:outline-primary-500">{children}</div>;
}
const TEXT_FIELD = 'block w-full rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
const SELECT_FIELD = 'min-h-9 max-w-full rounded-lg border border-gray-300 bg-white px-2 text-sm text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 max-sm:min-h-11';

/**
 * /admin/platform — maintenance mode (close the site), global session boot,
 * and broadcast notices. Storage is deliberately unchanged: the maintenance
 * flag is a FILE so the 503 gate works while MySQL is mid-upgrade.
 */
export function AdminPlatform() {
  const tz = useAdminTimezone();
  const location = useLocation();
  const navigate = useNavigate();
  const requested = location.hash.slice(1);
  const part = requested === 'softn-directory' ? 'app-directory' : requested;
  const active = GROUPS.some(group => group.parts.some(([id]) => id === part)) ? part : 'plans';
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

  useEffect(() => {
    if (!requested) return;
    if (document.activeElement?.matches('nav[aria-label="Platform settings"] select')) return;
    const target = document.getElementById(active);
    target?.focus({ preventScroll: true });
    const top = target?.getBoundingClientRect().top;
    if (top !== undefined && (top < 0 || top >= window.innerHeight)) target?.scrollIntoView?.({ block: 'start' });
  }, [active, requested, location.key]);

  return (
    <div className="@container/platform">
      <div className="grid items-start gap-4 @3xl/platform:grid-cols-[13rem_minmax(0,1fr)] @5xl/platform:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Platform settings" className="min-w-0 @3xl/platform:sticky @3xl/platform:top-[calc(var(--fl-workspace-header-h,4rem)+var(--fl-nav-top,0px)+var(--fl-system-top,0px)+.75rem)]">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 @3xl/platform:hidden">
            Platform setting
            <select value={active} onChange={event => navigate({ hash: '#' + event.target.value })}
              className="mt-1 block min-h-11 w-full cursor-pointer rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
              {GROUPS.map(group => <optgroup key={group.label} label={group.label}>{group.parts.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</optgroup>)}
            </select>
          </label>
          <div className="hidden max-h-[calc(100dvh-var(--fl-workspace-header-h,4rem)-var(--fl-nav-top,0px)-var(--fl-nav-bottom,0px)-var(--fl-system-top,0px)-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900 @3xl/platform:block">
            {GROUPS.map(group => <div key={group.label} className="border-b border-slate-200 py-2 first:pt-0 last:border-0 last:pb-0 dark:border-slate-700">
              <p className="px-2.5 py-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{group.label}</p>
              {group.parts.map(([id,label]) => <Link key={id} to={{ hash: '#' + id }} aria-current={id === active ? 'page' : undefined}
                className={cn('flex min-h-9 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-primary-500',
                  id === active ? 'bg-primary-50 font-semibold text-primary-800 dark:bg-primary-950/60 dark:text-primary-200' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
                {label}{id === active && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
              </Link>)}
            </div>)}
          </div>
        </nav>
        <div className="min-w-0">
        <PlatformPane id="plans" active={active}><AdminPlansCard /></PlatformPane>
        <PlatformPane id="app-engine" active={active}><AdminEnginePolicyCard /></PlatformPane>
        <PlatformPane id="plugins" active={active}><AdminPluginsCard /></PlatformPane>
        <PlatformPane id="app-directory" active={active}><span id="softn-directory" /><AdminSoftnDirectoryCard /></PlatformPane>

        <PlatformPane id="availability" active={active}>
        {status === null ? (loadError ? <AdminError message={loadError} onRetry={load} /> : <AdminSpinner label="Loading platform status" />) : <Panel
          title="Maintenance mode"
          icon={<Wrench className="h-4 w-4" />}
          description="Closes the whole site (dashboards, APIs and embedded forms show your message). Administrators keep full access."
          actions={status?.enabled ? <Badge variant="warning">ON — site closed</Badge> : <Badge variant="default">off</Badge>}
        >
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300">
              <Activity className="h-4 w-4 flex-none text-emerald-500" aria-hidden="true" /> {online} user{online === 1 ? '' : 's'} online now
            </p>
            <div>
              <label htmlFor="maintenance-message" className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">Visitor-facing message (shown on dashboards and embedded forms)</label>
              <textarea
                id="maintenance-message"
                disabled={maintenanceBusy}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                maxLength={500}
                className={TEXT_FIELD}
                placeholder="We are briefly down for maintenance. Please check back in a few minutes."
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {status?.enabled ? (
                <>
                  <Button size="sm" disabled={maintenanceBusy} onClick={() => toggle(false)} leftIcon={<RefreshCw className="h-4 w-4" />}>Reopen the site</Button>
                  <Button size="sm" variant="outline" isLoading={maintenanceBusy} onClick={() => toggle(true)}>Update message</Button>
                </>
              ) : (
                <Button size="sm" variant="danger" disabled={maintenanceBusy} onClick={() => setConfirmMaintenance(true)} leftIcon={<Wrench className="h-4 w-4" />}>Close site for maintenance</Button>
              )}
              <Button size="sm" variant="outline" disabled={bootBusy} onClick={() => setConfirmBoot(true)} leftIcon={<LogOut className="h-4 w-4" />}>
                Sign everyone out
              </Button>
            </div>
          </div>
        </Panel>}
        </PlatformPane>

        <PlatformPane id="notices" active={active}>
        <Panel
          title="Broadcast a message"
          icon={<Megaphone className="h-4 w-4" />}
          description={<>Pops up as a toast on users&apos; dashboards. <strong>Signed-in now</strong> reaches current sessions (expires in an hour); <strong>all users</strong> stays live for a week so everyone sees it once.</>}
        >
          <div className="space-y-3">
            <div>
              <label htmlFor="broadcast-message" className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">Notice message</label>
              <textarea
                id="broadcast-message"
                disabled={noticeBusy}
                value={noticeText}
                onChange={(e) => setNoticeText(e.target.value)}
                rows={2}
                maxLength={500}
                className={TEXT_FIELD}
                placeholder="e.g. Heads up — we're upgrading tonight at 10pm, expect a short outage."
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Notice style" disabled={noticeBusy} value={noticeLevel} onChange={(e) => setNoticeLevel(e.target.value as typeof noticeLevel)} className={SELECT_FIELD}>
                <option value="info">Info</option>
                <option value="warning">Warning (stays until dismissed)</option>
                <option value="success">Success</option>
              </select>
              <select aria-label="Notice audience" disabled={noticeBusy} value={noticeAudience} onChange={(e) => setNoticeAudience(e.target.value as typeof noticeAudience)} className={SELECT_FIELD}>
                <option value="online">Users signed in now</option>
                <option value="all">All users</option>
              </select>
              <Button size="sm" onClick={sendNotice} isLoading={noticeBusy} disabled={!noticeText.trim()} leftIcon={<Megaphone className="h-4 w-4" />}>Send notice</Button>
            </div>
            {noticeError && <AdminError message={noticeError} onRetry={reloadNotices} />}
            {noticesLoading && <p role="status" className={HELP}>Loading notices…</p>}
            {!noticesLoading && !noticeError && notices.length === 0 && <p className={HELP}>No notices yet.</p>}
            {notices.length > 0 && (
              <div className={ROW_BOX}>
                {notices.slice(0, 8).map((n) => (
                  <div key={n.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
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
          </div>
        </Panel>
        </PlatformPane>

        <PlatformPane id="backups" active={active}>
        <Panel
          title="Scheduled backups"
          icon={<Archive className="h-4 w-4" />}
          description={<>Nightly site backup: one restorable zip per account + a full database dump, kept for the retention window. Restore an account from its page in <strong>Users</strong>.</>}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p className="min-w-0 flex-1 basis-48 text-xs leading-5 text-gray-500 dark:text-slate-400">
                {backupReadFailed
                  ? <>Couldn&apos;t read the backup history — this says nothing about whether backups ran. <button type="button" onClick={loadBackups} className="cursor-pointer font-medium text-primary-600 hover:underline dark:text-primary-400">Try again</button></>
                  : backupRuns === null
                    ? <>Loading backup history…</>
                  : backupLastRun
                    ? <>Last run {formatDateTimeInZone(backupLastRun, tz)}</>
                    : <>Never run — schedule <code className="fl-mono">bin/backup-accounts.php</code> daily (cron or Task Scheduler), or run one now.</>}
              </p>
              <Button variant="outline" size="sm" onClick={runBackupNow} isLoading={runningBackup} leftIcon={<Archive className="h-4 w-4" />}>
                {runningBackup ? 'Backing up…' : 'Run backup now'}
              </Button>
            </div>
            {backupRuns !== null && backupRuns.length > 0 && (
              <div className={ROW_BOX}>
                {backupRuns.map((run) => (
                  <div key={run.date} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium tabular-nums text-gray-900 dark:text-white">{run.date}</span>
                      <span className="ml-2 text-xs tabular-nums text-gray-500 dark:text-slate-400">
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
          </div>
        </Panel>

        </PlatformPane>
        <PlatformPane id="allowances" active={active}><AdminAllowancesCard /></PlatformPane>
        <PlatformPane id="app-ai" active={active}><AdminAppAiCard /></PlatformPane>
        <PlatformPane id="app-payments" active={active}><AdminAppPaymentsCard /></PlatformPane>
        </div>
      </div>

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
