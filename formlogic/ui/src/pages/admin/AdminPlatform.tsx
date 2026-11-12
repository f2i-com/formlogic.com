import { useCallback, useEffect, useState } from 'react';
import { Activity, Archive, LogOut, Megaphone, RefreshCw, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Panel, PANEL_COLUMNS } from '../../components/ui/Panel';
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

// The page's parts, in the order they stand on it: the id a link lands on, and its name in the
// line of links at the top.
const PARTS = [
  ['plans', 'Plans & AI'], ['app-engine', 'App engine'], ['plugins', 'Plugins'], ['softn-directory', 'SoftN directory'],
  ['availability', 'Site availability'], ['notices', 'Notices'], ['backups', 'Backups'], ['allowances', 'Usage limits'],
  ['app-ai', 'AI for apps'], ['app-payments', 'App payments'],
] as const;
/** Around a part drawn by its own card: where a link lands, clear of the sticky header. */
const PART = 'min-w-0 scroll-mt-24';
const TEXT_FIELD = 'block w-full rounded-lg border border-gray-300 bg-white p-2.5 text-sm text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
const SELECT_FIELD = 'min-h-9 max-w-full rounded-lg border border-gray-300 bg-white px-2 text-sm text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 max-sm:min-h-11';

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

  // A link to one card (/admin/platform#app-ai, from an app's AI settings): the cards are drawn after
  // the page loads, so the browser's own jump to the fragment finds nothing. Go to the card once the
  // page has its cards, and again as the cards above it fill in, until the person scrolls themselves.
  const loaded = status !== null;
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (!loaded || target === '') return;
    let stopped = false;
    const stop = () => { stopped = true; };
    const go = () => { if (!stopped) document.getElementById(target)?.scrollIntoView?.({ block: 'start' }); };
    const timers = [0, 300, 900, 1800].map((after) => window.setTimeout(go, after));
    const inputs = ['wheel', 'touchmove', 'keydown', 'mousedown'] as const;
    inputs.forEach((name) => window.addEventListener(name, stop, { passive: true }));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      inputs.forEach((name) => window.removeEventListener(name, stop));
    };
  }, [loaded]);

  // A silent failure must not render the default "maintenance off" state.
  if (status === null) {
    return loadError
      ? <AdminError message={loadError} onRetry={load} />
      : <AdminSpinner label="Loading platform status" />;
  }

  return (
    <div>
      {/* The page is long: one line of links to its parts, each an address a link elsewhere can use
          (/admin/platform#app-ai). Plain anchors: the browser goes to the part named. On a phone
          the line stays one line and scrolls sideways, to the screen's edges, as the sections'
          row above it does: wrapped, ten finger-tall links would be three rows before the page. */}
      <nav aria-label="Platform settings" className="scrollbar-hide flex gap-x-4 gap-y-1 text-xs max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 sm:flex-wrap">
        {PARTS.map(([id, label]) => <a key={id} href={`#${id}`} className="inline-flex flex-none items-center whitespace-nowrap font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-300 max-sm:min-h-11">{label}</a>)}
      </nav>

      {/* The parts fill the page's width in as many columns as fit, each as tall as what it holds:
          one column on a phone, two on a laptop, three on a wide screen. The two that end in a
          table (AI for apps, App payments) come last and take every column. */}
      <div className={cn('mt-3', PANEL_COLUMNS)}>
        <div id="plans" className={PART}><AdminPlansCard /></div>
        <div id="app-engine" className={PART}><AdminEnginePolicyCard /></div>
        <div id="plugins" className={PART}><AdminPluginsCard /></div>
        <div id="softn-directory" className={PART}><AdminSoftnDirectoryCard /></div>

        <Panel
          id="availability"
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
        </Panel>

        <Panel
          id="notices"
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

        <Panel
          id="backups"
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

        <div id="allowances" className={PART}><AdminAllowancesCard /></div>
        <div id="app-ai" className={cn(PART, '[column-span:all]')}><AdminAppAiCard /></div>
        <div id="app-payments" className={cn(PART, '[column-span:all]')}><AdminAppPaymentsCard /></div>
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
