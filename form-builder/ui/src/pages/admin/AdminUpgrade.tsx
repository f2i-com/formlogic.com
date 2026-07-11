import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Database, DownloadCloud, History, Package, UploadCloud } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { api, type AdminUpgradeStatus } from '../../lib/api';
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
    else toast.success(`Package v${r.data!.staged.version} staged`, r.data!.staged.integrity === 'verified' ? 'All file checksums verified.' : 'No integrity manifest — an older package. Proceed only if you trust the source.');
    load();
  };

  const apply = async () => {
    setConfirmApply(false);
    setApplying(true);
    setJournal(null);
    const r = await api.adminUpgradeApply();
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

          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-slate-300">
              <strong>How it works:</strong> upload the release zip from GitHub (the same <code>formlogic-vX.Y.Z.zip</code> the CI attaches to
              each release) → the wizard verifies its checksums → applying closes the site, <strong>exports the database and snapshots the
              current code automatically</strong>, swaps the files and reopens. Your users&apos; form databases, uploads and .env are never touched.
            </p>
            <label className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-primary-foreground cursor-pointer hover:bg-primary-700">
              <UploadCloud className="h-4 w-4" />
              {uploading ? 'Validating…' : 'Upload release zip'}
              <input type="file" accept=".zip" className="hidden" disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            </label>
          </div>

          {status.staged && (
            <div className="rounded-xl border border-primary-200 dark:border-primary-500/30 bg-primary-50/50 dark:bg-primary-500/10 p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                Ready to install: v{status.staged.version}
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">
                  (currently v{status.staged.currentVersion} · integrity {status.staged.integrity}
                  {status.staged.integrity === 'verified' && ` · ${status.staged.verifiedFiles} files checked`})
                </span>
              </p>
              {status.staged.isDowngrade && (
                <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> This package is OLDER than the running version.
                </p>
              )}
              <div className="flex gap-2">
                <Button onClick={() => setConfirmApply(true)} isLoading={applying} disabled={!status.layout.supported} leftIcon={<Package className="h-4 w-4" />}>
                  {applying ? 'Applying…' : `Install v${status.staged.version}`}
                </Button>
                <Button variant="outline" onClick={async () => { await api.adminUpgradeDiscard(); load(); }}>Discard</Button>
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
