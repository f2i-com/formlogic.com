import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Database, DownloadCloud, History, Package, UploadCloud } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { api, type AdminOfficialRelease, type AdminUpgradeStatus } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';

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
    const r = await api.adminUpgradeApply(staged.packageId, staged.digest);
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
    const r = await api.adminUpgradeRollback(id);
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

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="h-4 w-4" /> Current version: {status.currentVersion}
            </h3>
            <Badge variant={status.layout.supported ? 'success' : 'warning'}>
              layout: {status.layout.mode}
            </Badge>
          </div>
          {!status.layout.supported && (
            <p className="text-sm text-amber-600 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              This installation&apos;s folder layout wasn&apos;t recognized — set FORMLOGIC_WEB_ROOT in the backend .env to the folder holding index.html to enable in-place upgrades.
            </p>
          )}
          {status.layout.mode === 'dev' && (
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Dev checkout detected — applying here overwrites <code>ui/dist</code> and the backend source (both recoverable via git/rebuild).
            </p>
          )}

          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-slate-300">
              Get the latest published release from the official FormLogic GitHub repository. We verify the download,
              then let you review it before installing. Installation automatically backs up your database and code.
              Your settings, uploads and app databases are preserved.
            </p>
            <Button variant="outline" onClick={() => void checkForUpdates()} isLoading={checking}
              disabled={uploading || applying} leftIcon={<DownloadCloud className="h-4 w-4" />}>
              {checking ? 'Checking GitHub…' : 'Check for updates'}
            </Button>
            {releaseError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{releaseError}</p>}
            {release === null && (
              <p className="text-sm text-gray-600 dark:text-slate-300">No installable stable release is published yet. Check again after a release ZIP is published.</p>
            )}
            {release && (
              <div className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-gray-900 dark:text-white">FormLogic {release.version}</p>
                  <a href={release.url} target="_blank" rel="noreferrer" className="text-sm text-primary-600 dark:text-primary-400 underline">Release notes</a>
                </div>
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  {(release.sizeBytes / 1024 / 1024).toFixed(1)} MB · Published {formatDateTimeInZone(release.publishedAt, tz)}
                </p>
                {release.isNewer ? (
                  <Button onClick={() => void downloadRelease()} isLoading={uploading} disabled={applying || checking}>
                    {uploading ? 'Downloading and verifying…' : 'Download and verify'}
                  </Button>
                ) : <p className="text-sm text-gray-600 dark:text-slate-300">Your installation is up to date.</p>}
                <p className="text-xs text-gray-500 dark:text-slate-400">Verified against GitHub’s SHA-256 digest. No signing-key setup required.</p>
              </div>
            )}
            <details className="text-sm text-gray-600 dark:text-slate-300">
              <summary className="cursor-pointer py-2 font-medium">Upload a signed package instead</summary>
              <p className="mb-3">For offline or custom releases, upload a ZIP signed with your configured release key.</p>
              <label className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-slate-600 px-4 py-2 font-semibold cursor-pointer">
                <UploadCloud className="h-4 w-4" />
                {uploading ? 'Validating…' : 'Upload signed ZIP'}
                <input type="file" accept=".zip" className="hidden" disabled={uploading || applying || checking}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
              </label>
            </details>
          </div>

          {status.staged && (
            <div className="rounded-xl border border-primary-200 dark:border-primary-500/30 bg-primary-50/50 dark:bg-primary-500/10 p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                Ready to install: v{status.staged.version}
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">
                  (currently v{status.staged.currentVersion} · {status.staged.integrity === 'github-release' ? 'GitHub verified' : status.staged.integrity}
                  {['signed', 'github-release'].includes(status.staged.integrity) && ` · ${status.staged.verifiedFiles} files checked`})
                </span>
              </p>
              {status.staged.isDowngrade && (
                <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> This package is OLDER than the running version.
                </p>
              )}
              <div className="flex gap-2">
                <Button onClick={() => setConfirmApply(true)} isLoading={applying} disabled={!status.layout.supported || uploading || checking} leftIcon={<Package className="h-4 w-4" />}>
                  {applying ? 'Applying…' : `Install v${status.staged.version}`}
                </Button>
                <Button variant="outline" disabled={uploading || applying} onClick={async () => { const result = await api.adminUpgradeDiscard(); if (result.error) toast.error('Could not discard package', result.error); load(); }}>Discard</Button>
              </div>
            </div>
          )}

          {journal && (
            <div className="rounded-lg bg-gray-900 text-gray-100 p-3 text-xs font-mono space-y-1">
              {journal.map((line, i) => <p key={i}>✓ {line}</p>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Database className="h-4 w-4" /> Backups
            </h3>
            <Button size="sm" variant="outline" leftIcon={<DownloadCloud className="h-4 w-4" />}
              onClick={async () => {
                const r = await api.adminUpgradeExportDb();
                if (r.error) toast.error('Export failed', r.error);
                else toast.success('Database exported', `Backup ${r.data!.backupId} created.`);
                load();
              }}>
              Export database now
            </Button>
          </div>
          {status.backups.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-500">No backups yet — one is created automatically before every upgrade.</p>
          ) : (
            <div className="space-y-1.5">
              {status.backups.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                  <div className="text-sm min-w-0">
                    <p className="font-medium text-gray-900 dark:text-white">{b.id}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      {b.version ? `v${b.version} · ` : ''}{b.at ? formatDateTimeInZone(b.at, tz) : ''} · {(b.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                      {b.hasCode ? ' · code' : ''}{b.hasDatabase ? ' · database' : ''}{b.manual ? ' · manual' : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
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
            <div className="pt-2">
              <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">History</p>
              <div className="text-xs text-gray-500 dark:text-slate-400 space-y-0.5">
                {status.history.slice(0, 8).map((h, i) => (
                  <p key={i}>
                    {formatDateTimeInZone(h.at, tz)} — {h.action}
                    {h.fromVersion ? ` ${h.fromVersion} → ${h.toVersion}` : ''}
                    {h.backupId ? ` (backup ${h.backupId})` : ''}
                  </p>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={confirmApply}
        onClose={() => setConfirmApply(false)}
        onConfirm={apply}
        title={`Install v${status.staged?.version}?`}
        message="The site closes for maintenance, the database is exported and the current code is snapshotted automatically, then the new files are applied and the site reopens. User form data (SQLite databases, uploads) and your .env are never touched. You can roll the code back from the backup afterwards."
        confirmLabel="Install upgrade"
      />
      <ConfirmDialog
        isOpen={rollbackId !== null}
        onClose={() => setRollbackId(null)}
        onConfirm={rollback}
        title="Roll back to this code snapshot?"
        message="The backend and frontend files are restored from the backup. The database is NOT touched (records created since the upgrade stay), and user form data is never affected."
        confirmLabel="Roll back code"
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
    </div>
  );
}
