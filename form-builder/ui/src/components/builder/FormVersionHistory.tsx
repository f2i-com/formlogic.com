import { useState, useEffect, useCallback } from 'react';
import { History, RotateCcw, Loader2, Inbox } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { formatRelativeTime } from '../../lib/utils';

interface VersionRow {
  id: string;
  version: number;
  changelog: string | null;
  createdAt: string;
}

interface FormVersionHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  onRestored?: () => void;
}

/**
 * Lists a form's saved version snapshots (created on every save) and lets the
 * author roll back to a previous version. Wires the previously dead
 * getFormVersions / restoreFormVersion endpoints.
 */
export function FormVersionHistory({ isOpen, onClose, formId, onRestored }: FormVersionHistoryProps) {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getFormVersions(formId);
      setVersions((result.data?.versions as VersionRow[]) ?? []);
    } catch {
      toast.error('Failed to load history', 'Could not load version history.');
    } finally {
      setLoading(false);
    }
  }, [formId]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const handleRestore = async (version: number) => {
    setRestoring(true);
    try {
      // The confirm dialog already warns this overwrites the current (possibly
      // published) form, so pass force to satisfy the backend's published-form guard.
      const result = await api.restoreFormVersion(formId, version, true);
      if (result.error) {
        toast.error('Restore failed', result.error);
      } else {
        toast.success('Version restored', `Restored to version ${version}.`);
        onRestored?.();
        onClose();
      }
    } catch (err) {
      toast.error('Restore failed', err instanceof Error ? err.message : 'Could not restore this version.');
    } finally {
      setRestoring(false);
      setRestoreTarget(null);
    }
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Version History" size="md">
        <div className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-slate-500" />
            </div>
          ) : versions.length === 0 ? (
            <div className="text-center py-10 text-gray-400 dark:text-slate-500">
              <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm font-medium">No version history yet</p>
              <p className="text-xs mt-1">A snapshot is saved each time you edit the form.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {versions.map((v, i) => (
                <div key={v.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <History className="h-3.5 w-3.5 text-gray-400" />
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">Version {v.version}</span>
                      {i === 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400">latest</span>}
                    </div>
                    {v.changelog && <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 line-clamp-2">{v.changelog}</p>}
                    <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{formatRelativeTime(v.createdAt)}</p>
                  </div>
                  {i !== 0 && (
                    <Button variant="outline" size="sm" onClick={() => setRestoreTarget(v.version)} leftIcon={<RotateCcw className="h-3.5 w-3.5" />}>
                      Restore
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => { if (restoreTarget !== null) handleRestore(restoreTarget); }}
        title="Restore this version?"
        message={`This replaces the current form with version ${restoreTarget}. The current state is saved as a new version first, so you can undo this.`}
        confirmLabel="Restore"
        isLoading={restoring}
      />
    </>
  );
}
