import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Database, DownloadCloud, History, Package, UploadCloud } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Panel } from '../../components/ui/Panel';
import { api, type AdminOfficialRelease, type AdminUpgradeStatus } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';
import { HELP, ROW_BOX } from '../../components/ui/listLook';

/**
 * /admin/upgrade — in-place release upgrades: upload a release zip →
 * checksum-verified staging → apply (auto DB export + code snapshot +
 * maintenance window) → roll back / restore from the backup.
 */
export function AdminUpgrade() {
  const tz = useAdminTimezone();
  const [status, setStatus] = useState<AdminUpgradeStatus | null>(null);
  const [release, setRelease] = useState<AdminOfficialRelease | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [rollbackId, setRollbackId] = useState<string | null>(null);
  const [restoreDbId, setRestoreDbId] = useState<string | null>(null);
  const [journal, setJournal] = useState<string[] | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.adminUpgradeStatus().then((r) => {
      if (r.data) { setStatus(r.data); setLoadError(null); }
      else { setLoadError(r.error || 'Could not load the upgrade status'); }
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    setJournal(null);
    const r = await api.adminUpgradeUpload(file);
    setUploading(false);
    if (r.error) toast.error('Package rejected', r.error);
    else toast.success(`Package v${r.data!.staged.version} staged`, r.data!.staged.integrity === 'signed' ? 'Release signature and every file checksum verified.' : 'Unsigned development package — allowed only by the local override.');
    load();
  };

  const checkForUpdates = async () => {
    setChecking(true);
    setReleaseError(null);
    const result = await api.adminUpgradeLatest();
    setChecking(false);
    if (result.error) {
      setRelease(undefined);
      setReleaseError(result.error);
    } else {
      setRelease(result.data!.release);
    }
  };

  const downloadRelease = async () => {
    if (!release) return;
    setUploading(true);
    setJournal(null);
    setReleaseError(null);
    const result = await api.adminUpgradeDownload(release);
    setUploading(false);
    if (result.error) setReleaseError(result.error);
    else toast.success(`Version ${result.data!.staged.version} is ready`, 'Official GitHub release and every file checksum verified. Review it below before installing.');
    load();
  };

  const apply = async () => {
    setConfirmApply(false);
    const staged = status?.staged;
    if (!staged) return;
    setApplying(true);
    setJournal(null);
    // Bind the apply to the exact reviewed package (id + digest) so a
    // concurrent re-stage 409s instead of silently applying other bytes.
    const r = await api.adminUpgradeApply(staged.packageId, staged.digest, false, staged.isDowngrade);
    setApplying(false);
    if (r.error) {
      toast.error('Upgrade failed', r.error);
    } else {
      setJournal(r.data!.journal);
      toast.success(`Upgraded to v${r.data!.toVersion}`, 'A database export and code snapshot were saved first.');
    }
    load();
  };

  const rollback = async () => {
    if (!rollbackId) return;
    const id = rollbackId;
    setRollbackId(null);
    // Confirmed only when the dialog said what it would break.
    const r = await api.adminUpgradeRollback(id, !!status?.backups.find((b) => b.id === id)?.rollbackWarning);
    if (r.error) toast.error('Rollback failed', r.error);
    else {
      setJournal(r.data!.journal);
      toast.success(`Rolled back to v${r.data!.restoredVersion}`);
    }
    load();
  };

  const restoreDb = async () => {
    if (!restoreDbId) return;
    const id = restoreDbId;
    setRestoreDbId(null);
    const r = await api.adminUpgradeRestoreDb(id);
    if (r.error) toast.error('Database restore failed', r.error);
    else toast.success('Database restored', `${r.data!.statements.toLocaleString()} statements executed.`);
    load();
  };

  if (!status) {
    return loadError
      ? <AdminError message={loadError} onRetry={load} />
      : <AdminSpinner label="Loading upgrade status" />;
  }
  const rollbackWarning = status.backups.find((b) => b.id === rollbackId)?.rollbackWarning;

  return (
    <>
    {/* Wide: getting an update at the left, the backups to go back to beside it. Narrower: one
        under the other, each the page's whole width. */}
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Panel
        title={`Current version: ${status.currentVersion}`}
        icon={<Package className="h-4 w-4" />}
        actions={<Badge variant={status.layout.supported ? 'success' : 'warning'}>layout: {status.layout.mode}</Badge>}
      >
        <div className="space-y-3">
          {!status.layout.supported && (
            <p className="text-sm text-amber-600 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              This installation&apos;s folder layout wasn&apos;t recognized — set FORMLOGIC_WEB_ROOT in the backend .env to the folder holding index.html to enable in-place upgrades.
            </p>
          )}
          {status.layout.mode === 'dev' && (
            <p className={HELP}>
              Dev checkout detected — applying here overwrites <code className="fl-mono">ui/dist</code> and the backend source (both recoverable via git/rebuild).
            </p>
          )}

          <p className="text-sm text-gray-600 dark:text-slate-300">
            Get the latest published release from the official FormLogic GitHub repository. We verify the download,
            then let you review it before installing. Installation automatically backs up your database and code.
            Your settings, uploads and app databases are preserved.
          </p>
          <Button variant="outline" size="sm" onClick={() => void checkForUpdates()} isLoading={checking}
            disabled={uploading || applying} leftIcon={<DownloadCloud className="h-4 w-4" />}>
            {checking ? 'Checking GitHub…' : 'Check for updates'}
          </Button>
          {releaseError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{releaseError}</p>}
          {release === null && (
            <p className="text-sm text-gray-600 dark:text-slate-300">No installable stable release is published yet. Check again after a release ZIP is published.</p>
          )}
          {release && (
            <div className="space-y-2 rounded-xl border border-gray-200 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">FormLogic {release.version}</p>
                <a href={release.url} target="_blank" rel="noreferrer" className="text-sm text-primary-600 dark:text-primary-400 underline">Release notes</a>
              </div>
              <p className="text-sm tabular-nums text-gray-600 dark:text-slate-300">
                {(release.sizeBytes / 1024 / 1024).toFixed(1)} MB · Published {formatDateTimeInZone(release.publishedAt, tz)}
              </p>
              {release.isNewer ? (
                <Button size="sm" onClick={() => void downloadRelease()} isLoading={uploading} disabled={applying || checking}>
                  {uploading ? 'Downloading and verifying…' : 'Download and verify'}
                </Button>
              ) : <p className="text-sm text-gray-600 dark:text-slate-300">Your installation is up to date.</p>}
              <p className={HELP}>Verified against GitHub’s SHA-256 digest. No signing-key setup required.</p>
            </div>
          )}
          <details className="text-sm text-gray-600 dark:text-slate-300">
            <summary className="cursor-pointer py-1 font-medium max-sm:py-3">Upload a signed package instead</summary>
            <p className="mb-2 mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">For offline or custom releases, upload a ZIP signed with your configured release key.</p>
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 max-sm:min-h-11">
              <UploadCloud className="h-4 w-4" />
              {uploading ? 'Validating…' : 'Upload signed ZIP'}
              <input type="file" accept=".zip" className="hidden" disabled={uploading || applying || checking}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            </label>
          </details>

          {status.staged && (
            <div className="space-y-2 rounded-xl border border-primary-200 bg-primary-50/50 p-3 dark:border-primary-500/30 dark:bg-primary-500/10">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                Ready to install: v{status.staged.version}
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">
                  (currently v{status.staged.currentVersion} · {status.staged.integrity === 'github-release' ? 'GitHub verified' : status.staged.integrity}
                  {['signed', 'github-release'].includes(status.staged.integrity) && ` · ${status.staged.verifiedFiles} files checked`})
                </span>
              </p>
              {status.staged.isDowngrade && (
                <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 flex-none" /> This package is OLDER than the running version.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setConfirmApply(true)} isLoading={applying} disabled={!status.layout.supported || uploading || checking} leftIcon={<Package className="h-4 w-4" />}>
                  {applying ? 'Applying…' : `Install v${status.staged.version}`}
                </Button>
                <Button size="sm" variant="outline" disabled={uploading || applying} onClick={async () => { const result = await api.adminUpgradeDiscard(); if (result.error) toast.error('Could not discard package', result.error); load(); }}>Discard</Button>
              </div>
            </div>
          )}

          {journal && (
            <div className="rounded-lg bg-gray-900 text-gray-100 p-3 text-xs font-mono space-y-1">
              {journal.map((line, i) => <p key={i}>✓ {line}</p>)}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Backups"
        icon={<Database className="h-4 w-4" />}
        actions={
          <Button size="sm" variant="outline" leftIcon={<DownloadCloud className="h-4 w-4" />}
            onClick={async () => {
              const r = await api.adminUpgradeExportDb();
              if (r.error) toast.error('Export failed', r.error);
              else toast.success('Database exported', `Backup ${r.data!.backupId} created.`);
              load();
            }}>
            Export database now
          </Button>
        }
      >
        <div className="space-y-3">
          {status.backups.length === 0 ? (
            <p className={HELP}>No backups yet — one is created automatically before every upgrade.</p>
          ) : (
            <div className={ROW_BOX}>
              {status.backups.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-1.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="break-all font-mono text-xs font-medium text-gray-900 dark:text-white">{b.id}</p>
                    <p className="text-xs tabular-nums text-gray-500 dark:text-slate-400">
                      {b.version ? `v${b.version} · ` : ''}{b.at ? formatDateTimeInZone(b.at, tz) : ''} · {(b.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                      {b.hasCode ? ' · code' : ''}{b.hasDatabase ? ' · database' : ''}{b.manual ? ' · manual' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {b.hasCode && (
                      <Button size="sm" variant="outline" onClick={() => setRollbackId(b.id)} leftIcon={<History className="h-3.5 w-3.5" />}>
                        Roll back code
                      </Button>
                    )}
                    {b.hasDatabase && (
                      <Button size="sm" variant="outline" onClick={() => setRestoreDbId(b.id)}>Restore DB…</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {status.history.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold text-gray-700 dark:text-slate-300">History</h3>
              <div className="space-y-0.5 text-xs leading-5 tabular-nums text-gray-500 dark:text-slate-400">
                {status.history.slice(0, 8).map((h, i) => (
                  <p key={i} className="break-words">
                    {formatDateTimeInZone(h.at, tz)} — {h.action}
                    {h.fromVersion ? ` ${h.fromVersion} → ${h.toVersion}` : ''}
                    {h.backupId ? ` (backup ${h.backupId})` : ''}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>

      <ConfirmDialog
        isOpen={confirmApply}
        onClose={() => setConfirmApply(false)}
        onConfirm={apply}
        title={`Install v${status.staged?.version}?`}
        message={`${status.staged?.isDowngrade ? `This is OLDER than the running v${status.staged.currentVersion}, and can bring back problems a newer release fixed. ` : ''}The site closes for maintenance, the database is exported and the current code is snapshotted automatically, then the new files are applied and the site reopens. User form data (SQLite databases, uploads) and your .env are never touched. You can roll the code back from the backup afterwards.`}
        confirmLabel={status.staged?.isDowngrade ? 'Install older version' : 'Install upgrade'}
      />
      <ConfirmDialog
        isOpen={rollbackId !== null}
        onClose={() => setRollbackId(null)}
        onConfirm={rollback}
        title="Roll back to this code snapshot?"
        message={`${rollbackWarning ? `${rollbackWarning}\n\n` : ''}The backend and frontend files are restored from the backup. The database is NOT touched (records created since the upgrade stay), and user form data is never affected.`}
        confirmLabel={rollbackWarning ? 'Roll back anyway' : 'Roll back code'}
        variant="danger"
      />
      <ConfirmDialog
        isOpen={restoreDbId !== null}
        onClose={() => setRestoreDbId(null)}
        onConfirm={restoreDb}
        title="Restore the database export?"
        message="DESTRUCTIVE: the MySQL database is replaced with this backup's export — anything created after it (accounts, apps, form metadata) is lost. Per-form response databases (SQLite) are not affected. Only do this if an upgrade corrupted the database."
        confirmLabel="Restore database"
        variant="danger"
      />
    </>
  );
}
